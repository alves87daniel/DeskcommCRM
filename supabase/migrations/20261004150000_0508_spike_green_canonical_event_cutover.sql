-- 0508 (SPIKE Green canonical event cutover — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-03: o barramento Green tinha dois produtores do MESMO fato. A fronteira de
-- `crm_leads` (0502-0506) emite o `lead.stage_changed` canônico na transação da mutação; os
-- writers do Deskcomm continuam emitindo o seu `lead.stage_changed` legado depois do commit, em
-- outra request. Até a 0507 um supressor casava o legado com a mutação por (lead, transição,
-- janela de 5 min, "o mais recente ainda sem gêmeo"). Medido na suíte
-- `tests/invariants/green-canonical-event-cutover.test.ts` contra a 0507: gêmeo atrasado vira
-- segundo fato, replay grava de novo (4 de 4), dois writers concorrentes com leitura velha da
-- origem duplicam, uma linha sem gêmeo engole o fato verdadeiro de outro movimento, e uma regra
-- de automação roda 3 vezes por um movimento.
-- Delta experimental SOBRE a 0507, que fica intacta junto com 0501-0506.
--
-- Contrato (definitivo):
--
--   * Dono do fato "lead Green mudou de etapa": o BANCO (fronteira, mesma transação). O writer
--     não é fonte de um segundo fato.
--   * O gêmeo é reconhecido por CHAVE FORTE: o servidor manda, em toda request de um escopo de
--     execução (requisição, tool, regra, job), o header `x-green-scope-id` (o mesmo id na
--     mutação e na emissão legada). A fronteira grava esse id no livro-razão; o porteiro de
--     `event_log` recusa em silêncio (a linha não nasce, `emit_event` devolve null) o
--     `lead.stage_changed` legado do MESMO escopo, MESMO lead e MESMA etapa de destino de uma
--     mutação canonizada. Sem janela, sem "mais recente", sem estado: atrasado, repetido,
--     concorrente ou fora de ordem dá o mesmo veredito.
--   * Fora do gêmeo, nada é engolido por casamento. Para um lead que toca o domínio Green:
--       - sem escopo do servidor → não nasce (no-op, como o gêmeo): não é relato de uma
--         mutação do servidor, e só o canônico fala pela mudança de etapa Green;
--       - reordenação na mesma etapa (`from_stage_id = to_stage_id`) → não é fato de etapa;
--       - escopo que não canonizou a transição (o movimento foi COMUM, e o funil virou Green
--         depois) → passa: é o fato daquele movimento. O porteiro confia no escopo do servidor
--         (o writer só relata a mutação que ele fez); forja de escopo é o AUTO-GAP-01.
--   * Lead comum: intocado (nunca tem linha no livro-razão, nunca toca o domínio).
--   * Binding: nenhum evento por lead (a etapa não mudou; nenhum consumidor precisa de
--     "entrou/saiu do Green"). O registro é estrutural e atômico: entrada = a linha do binding +
--     `green.lead_identity.first_seen_at` por lead (0505); saída = `green.binding_removed` com
--     `released_leads` (0503/0507). Nada muda aqui.
--
-- ── Legado
--   NECESSÁRIO     a marca reservada ao produtor (prova por livro-razão + GUC de uso único), a
--                  imutabilidade do canônico, o livro-razão (prova + chave do gêmeo), a emissão
--                  dos writers para lead comum.
--   SÓ HISTÓRICO   `stage_event_ledger.legacy_suppressed_at` / `legacy_request_id` e o índice
--                  `stage_event_ledger_twin_idx`: o que o supressor gravou até a 0507. Ninguém
--                  escreve mais; o índice fica (o baseline o recria a cada update e a cerca de
--                  índices proíbe criar-e-derrubar).
--   MORTO (sai)    `green.fn_suppress_legacy_stage_changed` + `trg_green_suppress_legacy_stage_changed`;
--                  `green.fn_guard_crm_lead_stage` e `green.fn_emit_crm_lead_stage_changed`
--                  (órfãs de trigger desde a 0502).
--
-- ── Rollout
-- Banco ANTES do servidor. Entre os dois, o servidor antigo não manda o escopo: o gêmeo dele para
-- lead Green não nasce (no-op), nunca é gravado em dobro; lead comum segue igual.

-- ── 1 · livro-razão: o escopo que fez a mutação ──────────────────────────────
alter table green.stage_event_ledger add column if not exists scope_id uuid;
comment on column green.stage_event_ledger.scope_id is
  'SPIKE Green 0508: escopo de execução do servidor (header x-green-scope-id) da mutação canonizada. Chave do gêmeo legado.';
comment on column green.stage_event_ledger.legacy_suppressed_at is
  'HISTÓRICO (até a 0507): quando o supressor temporal casou um gêmeo. Não é mais escrita.';
comment on column green.stage_event_ledger.legacy_request_id is
  'HISTÓRICO (até a 0507): request_id do gêmeo que o supressor casou. Não é mais escrita.';
comment on index green.stage_event_ledger_twin_idx is
  'HISTÓRICO (até a 0507): índice do supressor temporal. Mantido: o baseline o recria a cada update.';
create index if not exists stage_event_ledger_scope_idx
  on green.stage_event_ledger (organization_id, lead_id, scope_id)
  where scope_id is not null;

-- ── 2 · o escopo da request (header do servidor; ausente/ inválido = null) ────
create or replace function green.fn_request_scope()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v text;
begin
  begin
    v := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-green-scope-id';
  exception when others then
    return null;
  end;
  if v is null or not green.fn_ctx_uuid_ok(v) then return null; end if;
  return v::uuid;
end $$;
revoke all on function green.fn_request_scope() from public, anon, authenticated;
grant execute on function green.fn_request_scope() to service_role;

-- ── 3 · fronteira: grava o escopo no livro-razão (cópia da 0506, uma coluna) ──
create or replace function green.fn_crm_lead_boundary()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_p   boolean := false;  -- funil de OLD é gerenciado
  v_old_toca boolean := false; -- OLD toca o domínio (funil OU etapa gerenciados)
  v_new_p   boolean := false;  -- funil de NEW é gerenciado
  v_toca    boolean := false;
  v_env     jsonb;
  v_caller  text;
  v_trusted jsonb;
  v_meta    jsonb;
  v_payload jsonb;
  v_kind    text;
  v_ledger  uuid;
  v_event   uuid;
begin
  -- lifecycle v1.2: a identidade do lead acaba em QUALQUER exclusão (Green ou não, organização
  -- viva ou indo embora), antes de qualquer retorno antecipado. É o que impede o UUID de voltar.
  if tg_op = 'DELETE' then
    update green.lead_identity
       set state = 'retired', retired_at = now()
     where lead_id = old.id and state = 'live';
  end if;

  if tg_op = 'UPDATE'
     and new.id is not distinct from old.id
     and new.stage_id is not distinct from old.stage_id
     and new.pipeline_id is not distinct from old.pipeline_id
     and new.organization_id is not distinct from old.organization_id then
    return null;
  end if;

  -- A organização inteira indo embora (cascata): sem lápide possível.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    -- lifecycle v1.3 (defesa em profundidade): se o lead ainda toca o domínio e a identidade
    -- se perdeu, o UUID não pode ficar reutilizável
    if green.fn_lead_touches_green(old.organization_id, old.pipeline_id, old.stage_id) then
      insert into green.lead_identity (lead_id, state, retired_at)
      values (old.id, 'retired', now())
      on conflict (lead_id) do nothing;
    end if;
    return null;
  end if;

  if tg_op <> 'INSERT' then
    v_old_p := green.fn_is_green_pipeline(old.organization_id, old.pipeline_id);
    v_toca := v_old_p or green.fn_lead_touches_green(old.organization_id, old.pipeline_id, old.stage_id);
    v_old_toca := v_toca;
  end if;
  -- lifecycle v1.3 (defesa em profundidade): lead que toca o domínio e é apagado deixa a
  -- identidade aposentada mesmo que nunca tenha sido registrada (o `on conflict` preserva a linha
  -- já aposentada pelo `update` do topo)
  if tg_op = 'DELETE' and v_toca then
    insert into green.lead_identity (lead_id, state, retired_at)
    values (old.id, 'retired', now())
    on conflict (lead_id) do nothing;
  end if;
  if tg_op <> 'DELETE' then
    v_new_p := green.fn_is_green_pipeline(new.organization_id, new.pipeline_id);
    v_toca := v_toca or v_new_p
              or green.fn_lead_touches_green(new.organization_id, new.pipeline_id, new.stage_id);
  end if;
  -- o id de um lead com identidade Green não muda: trocar o id libertaria o antigo
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    if v_toca or exists (select 1 from green.lead_identity i where i.lead_id = old.id) then
      raise exception 'green_lead_id_immutable' using errcode = '23514';
    end if;
  end if;
  if not v_toca then return null; end if;

  if tg_op <> 'DELETE' and not exists (
       select 1 from public.crm_stages s
        where s.id = new.stage_id
          and s.organization_id = new.organization_id
          and s.pipeline_id = new.pipeline_id) then
    raise exception 'green_stage_not_bound' using errcode = '23503';
  end if;

  v_env := green.fn_mutation_envelope();
  v_caller := v_env ->> 'caller';
  v_trusted := v_env -> 'trusted';
  if v_caller <> 'user' then
    if not coalesce((v_env ->> 'valid')::boolean, false) then
      raise exception 'green_mutation_context_required'
        using errcode = '42501', detail = coalesce(v_env ->> 'reason', 'missing');
    end if;
    if tg_op <> 'DELETE' then
      perform green.fn_assert_service_origin(v_env -> 'service_origin', new.organization_id, new.contact_id, new.id, v_trusted);
    end if;
  end if;

  -- lifecycle v1.2: toda ENTRADA no domínio (nascimento ou lead que vem de fora) reivindica a
  -- identidade; um UUID já aposentado é recusado com erro de domínio, igual para qualquer org.
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or not v_old_toca) then
    perform green.fn_claim_lead_identity(new.id);
  end if;

  -- lifecycle: o nascimento Green deixa a proveniência na MESMA transação.
  -- Falha aqui não é capturada: sem registro, sem nascimento.
  if tg_op = 'INSERT' then
    insert into green.lead_birth_provenance
      (lead_id, organization_id, pipeline_id, stage_id, caller, trusted, advisory, service_origin)
    values
      (new.id, new.organization_id, new.pipeline_id, new.stage_id, v_caller, v_trusted,
       coalesce(v_env -> 'advisory', '{}'::jsonb),
       case when jsonb_typeof(v_env -> 'service_origin') = 'object' then v_env -> 'service_origin' end);
    return null;
  end if;

  if tg_op = 'DELETE' then
    v_kind := 'deleted';
    v_payload := jsonb_build_object(
      'pipeline_id',      old.pipeline_id,
      'from_stage_id',    old.stage_id,
      'status',           old.status,
      'green_transition', 'delete');
  else
    v_kind := 'stage_changed';
    v_payload := jsonb_build_object(
      'pipeline_id',      new.pipeline_id,
      'from_stage_id',    old.stage_id,
      'to_stage_id',      new.stage_id,
      'status',           new.status,
      'green_transition', case when v_new_p then case when v_old_p then 'stay' else 'enter' end
                               else 'exit' end);
    if new.pipeline_id is distinct from old.pipeline_id then
      v_payload := v_payload || jsonb_build_object('from_pipeline_id', old.pipeline_id);
    end if;
    if jsonb_typeof(v_env -> 'service_origin') = 'object' then
      v_payload := v_payload || jsonb_build_object('service_origin', v_env -> 'service_origin');
    end if;
  end if;

  v_meta := jsonb_build_object('green_canonical', true, 'green_context_version', 1)
    || v_trusted
    || jsonb_strip_nulls(jsonb_build_object(
         'actor_user_id', case when v_caller = 'user' then v_trusted -> 'actor' ->> 'id' end,
         'actor_kind',    v_trusted -> 'actor' ->> 'kind'))
    || jsonb_build_object('green', jsonb_build_object(
         'v', 2, 'trusted', v_trusted, 'advisory', v_env -> 'advisory'));

  insert into green.stage_event_ledger
    (organization_id, lead_id, kind, from_stage_id, to_stage_id, from_pipeline_id, to_pipeline_id,
     request_id, advisory_request_id, scope_id)
  values
    (old.organization_id, old.id, v_kind, old.stage_id,
     case when tg_op = 'DELETE' then null else new.stage_id end,
     old.pipeline_id,
     case when tg_op = 'DELETE' then null else new.pipeline_id end,
     v_trusted ->> 'request_id',
     coalesce(v_env -> 'advisory' ->> 'client_request_id', v_env -> 'advisory' ->> 'request_id'),
     green.fn_request_scope())
  returning id into v_ledger;
  perform set_config('green.canonical_proof', v_ledger::text, true);
  -- Tipo LITERAL em cada ramo: é o que a cerca de evento-fato enxerga.
  if tg_op = 'DELETE' then
    v_event := public.emit_event('lead.deleted', 'crm_lead', old.id, v_payload, v_meta, old.organization_id);
  else
    v_event := public.emit_event('lead.stage_changed', 'crm_lead', old.id, v_payload, v_meta, new.organization_id);
  end if;
  perform set_config('green.canonical_proof', '', true);
  if not exists (select 1 from green.stage_event_ledger l
                  where l.id = v_ledger and l.canonical_event_id = v_event) then
    raise exception 'green_canonical_not_recorded' using errcode = 'P0001';
  end if;
  return null;
end $$;
revoke all on function green.fn_crm_lead_boundary() from public, anon, authenticated;
grant execute on function green.fn_crm_lead_boundary() to service_role;

-- ── 4 · porteiro de INSERT em event_log (substitui o supressor temporal) ─────
create or replace function green.fn_event_log_gate()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_proof    uuid;
  v_hit      uuid;
  v_escopo   uuid;
  v_de       uuid;
  v_para     uuid;
  v_pipeline uuid;
  v_etapa    uuid;
begin
  -- (a) marca e envelope reservados ao produtor: só passam com a prova da MESMA transação, de
  --     uso único, amarrada a este lead e a esta transição (idêntico à 0502).
  if new.metadata ?| array['green_canonical', 'green_context_version', 'green'] then
    begin
      v_proof := nullif(current_setting('green.canonical_proof', true), '')::uuid;
    exception when others then
      v_proof := null;
    end;
    if v_proof is not null and new.entity_kind = 'crm_lead'
       and new.event_type in ('lead.stage_changed', 'lead.deleted') then
      update green.stage_event_ledger l
         set canonical_event_id = new.id
       where l.id = v_proof
         and l.txid = txid_current()
         and l.canonical_event_id is null
         and l.organization_id = new.organization_id
         and l.lead_id = new.entity_id
         and l.kind = case new.event_type when 'lead.deleted' then 'deleted' else 'stage_changed' end
         and l.to_stage_id::text is not distinct from new.payload ->> 'to_stage_id'
         and l.from_stage_id::text is not distinct from new.payload ->> 'from_stage_id'
      returning l.id into v_hit;
    end if;
    if v_hit is null then
      raise exception 'green_canonical_reserved' using errcode = '42501',
        detail = 'a marca canônica só nasce do trigger de crm_leads, na transação da mutação';
    end if;
    perform set_config('green.canonical_proof', '', true);
    return new;
  end if;

  -- (b) só `lead.stage_changed` de `crm_lead` com sujeito; o resto segue o upstream.
  if new.event_type <> 'lead.stage_changed' or new.entity_kind is distinct from 'crm_lead'
     or new.entity_id is null then
    return new;
  end if;

  v_escopo := green.fn_request_scope();
  if green.fn_ctx_uuid_ok(new.payload ->> 'to_stage_id') then
    v_para := (new.payload ->> 'to_stage_id')::uuid;
  end if;
  if green.fn_ctx_uuid_ok(new.payload ->> 'from_stage_id') then
    v_de := (new.payload ->> 'from_stage_id')::uuid;
  end if;

  -- (c) o gêmeo: o MESMO escopo canonizou a mutação deste lead para esta etapa. O fato já existe
  --     (é o canônico); o relato do writer não vira segundo fato. Vale mesmo que o lead já não
  --     toque o domínio (binding removido entre a mutação e o relato).
  if v_escopo is not null and exists (
       select 1
         from green.stage_event_ledger l
        where l.organization_id = new.organization_id
          and l.lead_id = new.entity_id
          and l.scope_id = v_escopo
          and l.kind = 'stage_changed'
          and l.canonical_event_id is not null
          and l.to_stage_id is not distinct from v_para) then
    return null;
  end if;

  -- (d) fora do domínio Green: upstream intacto.
  select l.pipeline_id, l.stage_id into v_pipeline, v_etapa
    from public.crm_leads l
   where l.id = new.entity_id and l.organization_id = new.organization_id;
  if not (green.fn_lead_touches_green(new.organization_id, v_pipeline, v_etapa)
          or (v_para is not null and green.fn_lead_touches_green(new.organization_id, null, v_para))
          or (v_de is not null and green.fn_lead_touches_green(new.organization_id, null, v_de))) then
    return new;
  end if;

  -- (e) domínio Green: só o canônico fala pela mudança de etapa.
  if v_escopo is null then
    return null; -- relato sem escopo do servidor: não descreve uma mutação dele
  end if;
  if v_para is not null and v_de is not distinct from v_para then
    return null; -- reordenação na mesma etapa: não é mudança de etapa
  end if;
  return new; -- escopo que não canonizou esta transição: o movimento foi comum (fato dele)
end $$;
revoke all on function green.fn_event_log_gate() from public, anon, authenticated;
grant execute on function green.fn_event_log_gate() to service_role;

drop trigger if exists trg_green_suppress_legacy_stage_changed on public.event_log;
drop trigger if exists trg_green_event_log_gate on public.event_log;
create trigger trg_green_event_log_gate
  before insert on public.event_log
  for each row execute function green.fn_event_log_gate();

-- ── 5 · código morto ─────────────────────────────────────────────────────────
drop function if exists green.fn_suppress_legacy_stage_changed();
drop function if exists green.fn_guard_crm_lead_stage();
drop function if exists green.fn_emit_crm_lead_stage_changed();

notify pgrst, 'reload schema';
