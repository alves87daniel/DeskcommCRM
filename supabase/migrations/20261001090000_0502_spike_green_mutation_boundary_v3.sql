-- 0502 (SPIKE Green v3 — DESCARTÁVEL; não é produto, não vai para produção).
--
-- Green Mutation Boundary v3: delta experimental SOBRE a 0501 (v2), que fica
-- intacta. Fecha os cinco pontos que a AUDIT-DESKCOMM-08.2 falsificou:
--
--   ADV-01  a fronteira vale na entrada, na permanência, na SAÍDA e no DELETE
--           (a v2 decidia tudo por `NEW.pipeline_id`);
--   ADV-02  o guard deixa de ser oracle cross-tenant: nenhuma leitura Green
--           acontece antes de a RLS autorizar a escrita;
--   ADV-03  o evento canônico emitido é write-once (allowlist do consumer) e
--           não é apagável;
--   ADV-04  o que o caller controla nunca ocupa o lugar do que o sistema
--           deriva: envelope `metadata.green.{trusted,advisory}`;
--   ADV-09  etapa e funil efetivo têm de concordar sempre que a mutação toca o
--           domínio Green — decidido na fronteira, sem tocar nenhum writer.
--
-- ── Por que AFTER, e não BEFORE (ADV-02) ────────────────────────────────────
-- Na v2 a guarda era um trigger BEFORE `security definer`. BEFORE ROW roda
-- ANTES do `WITH CHECK` da RLS: num INSERT/UPDATE com `organization_id` de
-- outra org, a guarda lia o binding daquela org e respondia
-- `green_stage_not_bound`, enquanto um funil comum caía no erro de RLS — um
-- oracle. A v3 não acrescenta uma checagem de membro por cima (seria uma
-- segunda cópia da regra de acesso, que diverge da RLS: platform admin,
-- suporte, dono do lead): ela MUDA O MOMENTO. Trigger AFTER ROW só é enfileirado
-- para a linha que a RLS (USING + WITH CHECK) já aceitou e que foi de fato
-- escrita. Quem não pode escrever na org nunca executa uma linha de código
-- Green — indistinguível por construção. A recusa continua atômica: exceção em
-- AFTER ROW aborta o comando inteiro.
--
-- ── Pertencimento ao domínio Green (ADV-01 + ADV-09) ────────────────────────
-- Uma linha TOCA o domínio quando o funil dela é gerenciado OU a etapa dela
-- pertence a um funil gerenciado DA MESMA organização. A mutação entra na
-- fronteira se OLD ou NEW tocam o domínio. Etapa de outra organização nunca é
-- consultada como Green (não vira oracle pelo lado da etapa).
--
-- ── Contratos decididos (V3-R01 / V3-R02) ───────────────────────────────────
--   * saída Green → não-Green: é mutação Green. Writer privilegiado sem
--     contexto ⇒ 42501; com contexto, ou humano ⇒ `lead.stage_changed` canônico
--     com `from_pipeline_id` e `green_transition=exit`;
--   * DELETE de Opportunity Green: writer privilegiado sem contexto ⇒ 42501;
--     senão lápide canônica `lead.deleted` (`green_transition=delete`) na MESMA
--     transação. Exceção única: a organização inteira sendo apagada (a própria
--     `event_log` vai junto na cascata; não há onde gravar a lápide).
--
-- ── Confiança (ADV-04) ──────────────────────────────────────────────────────
--   metadata.green.trusted   derivado pelo banco (caller, actor de `auth.uid()`,
--                            `source=user_session`) ou, em writer privilegiado,
--                            o contexto validado que o BACKEND enviou;
--   metadata.green.advisory  tudo o que uma sessão humana mandou no header.
-- No topo da metadata do canônico só aparece o que é trusted. Um
-- `request_id=rule:*` enviado por humano fica em `advisory` e não é lido por
-- nenhum consumidor de controle.

-- ── livro-razão: lápide, funis da transição e request_id advisory separado ──
alter table green.stage_event_ledger add column if not exists kind text not null default 'stage_changed';
alter table green.stage_event_ledger add column if not exists from_pipeline_id uuid;
alter table green.stage_event_ledger add column if not exists to_pipeline_id uuid;
alter table green.stage_event_ledger add column if not exists advisory_request_id text;
-- a lápide de DELETE não tem etapa de destino
alter table green.stage_event_ledger alter column to_stage_id drop not null;
comment on column green.stage_event_ledger.request_id is
  'SPIKE Green v3: request_id CONFIÁVEL (contexto de writer privilegiado). Sessão humana nunca escreve aqui.';
comment on column green.stage_event_ledger.advisory_request_id is
  'SPIKE Green v3: request_id enviado por sessão humana — diagnóstico, nunca chave de decisão.';

-- ── a linha toca o domínio Green? (funil gerenciado OU etapa de funil gerenciado da MESMA org)
create or replace function green.fn_lead_touches_green(p_org uuid, p_pipeline uuid, p_stage uuid)
returns boolean
language plpgsql stable
set search_path = ''
as $$
begin
  if p_org is null then return false; end if;
  if to_regclass('green.product_pipeline_binding') is null then return false; end if;
  if green.fn_is_green_pipeline(p_org, p_pipeline) then return true; end if;
  return exists (
    select 1
      from public.crm_stages s
      join green.product_pipeline_binding b
        on b.organization_id = s.organization_id and b.pipeline_id = s.pipeline_id
     where s.id = p_stage and s.organization_id = p_org
  );
end $$;
revoke all on function green.fn_lead_touches_green(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function green.fn_lead_touches_green(uuid, uuid, uuid) to service_role;

-- ── envelope trusted × advisory sobre o resolver da v2 (que fica intacto) ────
-- Devolve: { caller, valid, reason, service_origin, trusted, advisory }.
create or replace function green.fn_mutation_envelope()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_ctx    jsonb := green.fn_mutation_context();
  v_caller text := v_ctx ->> 'caller';
  v_valid  boolean := coalesce((v_ctx ->> 'valid')::boolean, false);
  v_campos jsonb := jsonb_strip_nulls(jsonb_build_object(
      'source',             v_ctx ->> 'source',
      'request_id',         v_ctx ->> 'request_id',
      'correlation_id',     v_ctx ->> 'correlation_id',
      'causation_event_id', v_ctx ->> 'causation_event_id',
      'idempotency_key',    v_ctx ->> 'idempotency_key',
      'source_job_id',      v_ctx ->> 'source_job_id'));
  v_trusted  jsonb;
  v_advisory jsonb := '{}'::jsonb;
begin
  if v_caller = 'user' then
    -- Sessão humana: confiável é SÓ o que o banco deriva do canal real. O
    -- header inteiro é advisory — inclusive `source`, que o cliente escolhe.
    v_trusted := jsonb_build_object(
      'caller', 'user', 'actor', v_ctx -> 'actor', 'source', 'user_session');
    v_advisory := v_campos;
  elsif v_valid then
    -- Writer privilegiado: o contexto validado veio do backend (dono da chave).
    v_trusted := jsonb_build_object('caller', v_caller, 'actor', v_ctx -> 'actor') || v_campos;
  else
    v_trusted := jsonb_build_object('caller', v_caller);
  end if;
  return jsonb_build_object(
    'caller', v_caller, 'valid', v_valid, 'reason', v_ctx -> 'reason',
    'service_origin', case when v_caller <> 'user' and v_valid then v_ctx -> 'service_origin' end,
    'trusted', v_trusted, 'advisory', v_advisory);
end $$;
revoke all on function green.fn_mutation_envelope() from public, anon, authenticated;
grant execute on function green.fn_mutation_envelope() to service_role;

-- ── a fronteira: UM hook AFTER para INSERT, UPDATE e DELETE ──────────────────
create or replace function green.fn_crm_lead_boundary()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_p   boolean := false;  -- funil de OLD é gerenciado
  v_new_p   boolean := false;  -- funil de NEW é gerenciado
  v_toca    boolean := false;
  v_env     jsonb;
  v_caller  text;
  v_trusted jsonb;
  v_meta    jsonb;
  v_payload jsonb;
  v_tipo    text;
  v_kind    text;
  v_ledger  uuid;
  v_event   uuid;
begin
  -- só nascimento, exclusão e mudança de etapa/funil/organização entram
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.pipeline_id is not distinct from old.pipeline_id
     and new.organization_id is not distinct from old.organization_id then
    return null;
  end if;

  -- A organização inteira indo embora (cascata): `event_log` e o binding vão
  -- junto; não há lápide possível nem domínio a proteger.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return null;
  end if;

  if tg_op <> 'INSERT' then
    v_old_p := green.fn_is_green_pipeline(old.organization_id, old.pipeline_id);
    v_toca := v_old_p or green.fn_lead_touches_green(old.organization_id, old.pipeline_id, old.stage_id);
  end if;
  if tg_op <> 'DELETE' then
    v_new_p := green.fn_is_green_pipeline(new.organization_id, new.pipeline_id);
    v_toca := v_toca or v_new_p
              or green.fn_lead_touches_green(new.organization_id, new.pipeline_id, new.stage_id);
  end if;
  if not v_toca then return null; end if;

  -- binding: a etapa de NEW tem de ser do funil e da organização de NEW
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
      perform green.fn_assert_service_origin(v_env -> 'service_origin', new.organization_id, new.contact_id);
    end if;
  end if;

  -- nascimento não tem evento canônico (EV-01B, fora desta spike)
  if tg_op = 'INSERT' then return null; end if;

  if tg_op = 'DELETE' then
    v_tipo := 'lead.deleted';
    v_kind := 'deleted';
    v_payload := jsonb_build_object(
      'pipeline_id',      old.pipeline_id,
      'from_stage_id',    old.stage_id,
      'status',           old.status,
      'green_transition', 'delete');
  else
    v_tipo := 'lead.stage_changed';
    v_kind := 'stage_changed';
    v_payload := jsonb_build_object(
      'pipeline_id',      new.pipeline_id,
      'from_stage_id',    old.stage_id,
      'to_stage_id',      new.stage_id,
      -- `fn_crm_lead_close_on_stage` é BEFORE: o status aqui já é o derivado
      'status',           new.status,
      'green_transition', case when v_new_p then case when v_old_p then 'stay' else 'enter' end
                               else 'exit' end);
    if new.pipeline_id is distinct from old.pipeline_id then
      v_payload := v_payload || jsonb_build_object('from_pipeline_id', old.pipeline_id);
    end if;
    -- `command` nunca é transportada (emit_event deriva); humano nunca transporta origem.
    if jsonb_typeof(v_env -> 'service_origin') = 'object' then
      v_payload := v_payload || jsonb_build_object('service_origin', v_env -> 'service_origin');
    end if;
  end if;

  -- No TOPO só entra o que é trusted. O que a sessão humana mandou fica em
  -- `green.advisory` e nenhum consumidor de controle lê de lá.
  v_meta := jsonb_build_object('green_canonical', true, 'green_context_version', 1)
    || v_trusted
    || jsonb_strip_nulls(jsonb_build_object(
         -- compat com o metadata legado
         'actor_user_id', case when v_caller = 'user' then v_trusted -> 'actor' ->> 'id' end,
         'actor_kind',    v_trusted -> 'actor' ->> 'kind'))
    || jsonb_build_object('green', jsonb_build_object(
         'v', 2, 'trusted', v_trusted, 'advisory', v_env -> 'advisory'));

  -- Prova de produtor (v2, mantida): linha do livro-razão + GUC de uso único.
  insert into green.stage_event_ledger
    (organization_id, lead_id, kind, from_stage_id, to_stage_id, from_pipeline_id, to_pipeline_id,
     request_id, advisory_request_id)
  values
    (old.organization_id, old.id, v_kind, old.stage_id,
     case when tg_op = 'DELETE' then null else new.stage_id end,
     old.pipeline_id,
     case when tg_op = 'DELETE' then null else new.pipeline_id end,
     v_trusted ->> 'request_id', v_env -> 'advisory' ->> 'request_id')
  returning id into v_ledger;
  perform set_config('green.canonical_proof', v_ledger::text, true);
  -- Erro aqui NÃO é capturado: evento falha ⇒ a mutação inteira faz rollback.
  v_event := public.emit_event(v_tipo, 'crm_lead', old.id, v_payload, v_meta,
                               case when tg_op = 'DELETE' then old.organization_id else new.organization_id end);
  perform set_config('green.canonical_proof', '', true);
  if not exists (select 1 from green.stage_event_ledger l
                  where l.id = v_ledger and l.canonical_event_id = v_event) then
    raise exception 'green_canonical_not_recorded' using errcode = 'P0001';
  end if;
  return null;
end $$;

-- ── porteiro da marca + supressor do gêmeo (INSERT em event_log) ────────────
-- v3: a lápide `lead.deleted` também nasce só do produtor; o envelope `green` é
-- reservado junto com a marca; o desempate do supressor usa SÓ o request_id
-- confiável do livro-razão (o de sessão humana deixou de ser elegível).
create or replace function green.fn_suppress_legacy_stage_changed()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_proof uuid;
  v_hit   uuid;
begin
  -- A imutabilidade do canônico é de `green.fn_event_log_canonical_guard` (v3).
  if tg_op <> 'INSERT' then return new; end if;

  -- (a) marca e envelope reservados ao produtor: só passam com a prova da
  --     MESMA transação, de uso único, amarrada a este lead e a esta transição.
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

  -- (b) gêmeo legado: suprimido SÓ quando corresponde a uma mutação de etapa já
  --     canonizada — mesmo lead, mesma transição, gêmeo ainda não visto, janela
  --     curta. Lápide de DELETE nunca é gêmeo.
  if new.event_type <> 'lead.stage_changed' or new.entity_kind is distinct from 'crm_lead'
     or new.entity_id is null then
    return new;
  end if;
  update green.stage_event_ledger l
     set legacy_suppressed_at = clock_timestamp(),
         legacy_request_id = left(new.metadata ->> 'request_id', 128)
   where l.id = (
     select c.id from green.stage_event_ledger c
      where c.organization_id = new.organization_id
        and c.lead_id = new.entity_id
        and c.kind = 'stage_changed'
        and c.canonical_event_id is not null
        and c.legacy_suppressed_at is null
        and c.to_stage_id::text = new.payload ->> 'to_stage_id'
        and (not (new.payload ? 'from_stage_id')
             or c.from_stage_id::text is not distinct from new.payload ->> 'from_stage_id')
        and c.created_at > clock_timestamp() - interval '5 minutes'
      -- o MESMO request CONFIÁVEL (quando os dois o têm) primeiro; depois o mais recente
      order by (c.request_id is not null and c.request_id = new.metadata ->> 'request_id') desc,
               c.created_at desc
      limit 1
      for update skip locked)
  returning l.id into v_hit;
  if v_hit is not null then return null; end if;
  return new;
end $$;

-- ── o canônico emitido é registro histórico: write-once + allowlist (ADV-03) ─
-- Colunas que o consumer (drain) continua mexendo: status, consumed_by,
-- attempts, last_error, next_attempt_at, updated_at. TODO o resto — metadata
-- inteira, payload, entity_id, organization_id, event_type, entity_kind,
-- created_at — é imutável, para qualquer papel. DELETE do canônico é recusado;
-- a única exceção é a organização inteira sendo apagada (cascata). Manutenção
-- administrativa (retenção) fica FORA da API e fora do modelo desta spike: é o
-- dono desligando o trigger numa janela explícita.
create or replace function green.fn_event_log_canonical_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  c_reservadas constant text[] := array['green_canonical', 'green_context_version', 'green'];
  c_mutaveis   constant text[] := array['status', 'consumed_by', 'attempts', 'last_error',
                                        'next_attempt_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.metadata ?| c_reservadas
       and exists (select 1 from public.organizations o where o.id = old.organization_id) then
      raise exception 'green_canonical_immutable' using errcode = '42501',
        detail = 'evento canônico Green não é apagável';
    end if;
    return old;
  end if;

  if (old.metadata ?| c_reservadas or new.metadata ?| c_reservadas)
     and (to_jsonb(old) - c_mutaveis) is distinct from (to_jsonb(new) - c_mutaveis) then
    raise exception 'green_canonical_immutable' using errcode = '42501',
      detail = 'evento canônico Green é write-once; só os campos do consumer mudam';
  end if;
  return new;
end $$;

revoke all on function green.fn_crm_lead_boundary() from public, anon, authenticated;
revoke all on function green.fn_suppress_legacy_stage_changed() from public, anon, authenticated;
revoke all on function green.fn_event_log_canonical_guard() from public, anon, authenticated;
grant execute on function green.fn_crm_lead_boundary() to service_role;
grant execute on function green.fn_suppress_legacy_stage_changed() to service_role;
grant execute on function green.fn_event_log_canonical_guard() to service_role;

-- ── triggers: os dois hooks da v2 em crm_leads dão lugar a UM hook AFTER ─────
drop trigger if exists trg_green_guard_crm_lead_stage on public.crm_leads;
drop trigger if exists trg_green_emit_crm_lead_stage_changed on public.crm_leads;
drop trigger if exists trg_green_crm_lead_boundary on public.crm_leads;
create trigger trg_green_crm_lead_boundary
  after insert or update or delete on public.crm_leads
  for each row execute function green.fn_crm_lead_boundary();

drop trigger if exists trg_green_canonical_mark_immutable on public.event_log;
drop trigger if exists trg_green_canonical_immutable on public.event_log;
create trigger trg_green_canonical_immutable
  before update or delete on public.event_log
  for each row execute function green.fn_event_log_canonical_guard();

notify pgrst, 'reload schema';
