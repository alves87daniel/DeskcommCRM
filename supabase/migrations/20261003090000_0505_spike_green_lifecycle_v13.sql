-- 0505 (SPIKE Green lifecycle v1.3 — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-01.3: fecha o V12-ADV-01 da AUDIT-GREEN-01.2.1. Delta experimental SOBRE a
-- 0504, que fica intacta junto com 0501, 0502 e 0503.
--
-- Contrato (definitivo): todo lead que EFETIVAMENTE tocar o domínio Green deixa uma
-- identidade histórica não reciclável. Não protege o UUID de um lead que NUNCA tocou Green.
-- (O relatório da v1.2 dizia que "o UUID de crm_leads não é reciclável": a política
-- implementada sempre foi a de quem tocou o domínio; a v1.3 corrige o texto, não amplia o escopo.)
--
-- ── 1. Binding: o pipeline que vira Green registra a identidade dos leads que já estão nele
-- Na 0504 a identidade só era reivindicada na ENTRADA do lead (INSERT já em Green, UPDATE
-- comum → Green). Um pipeline que passa a ser gerenciado DEPOIS de ter leads os põe no domínio
-- sem mutação nenhuma deles: sem linha em `green.lead_identity`, o DELETE não aposentava nada
-- e o UUID voltava (AUDIT-GREEN-01.2.1, V12-ADV-01). Agora um trigger em
-- `green.product_pipeline_binding` (AFTER INSERT e UPDATE de organization_id/pipeline_id)
-- reivindica, na MESMA transação do binding, a identidade de todo lead da organização que está
-- no pipeline ou numa etapa dele. `on conflict do nothing`: idempotente e sem duplicidade; um
-- lead vivo cujo UUID já está `retired` (lead comum que reaproveitou um UUID Green) recusa o
-- binding inteiro com o mesmo erro de domínio de sempre.
--
-- Corrida binding × escrita de lead: o trigger toma `SHARE ROW EXCLUSIVE` em `public.crm_leads`
-- antes de ler. Ele espera as escritas em voo (que têm `ROW EXCLUSIVE`) terminarem, e as
-- escritas seguintes esperam o binding terminar; depois do lock, o `select` do binding (READ
-- COMMITTED) enxerga tudo que foi comitado, e a fronteira de quem esperou enxerga o binding.
-- Custo: o binding é operação rara de administração e segura a escrita de leads só pelo tempo
-- da própria transação. Sem lock haveria o buraco: lead em voo que o binding não vê e que a
-- fronteira, sem enxergar o binding, não reivindica.
--
-- ── 2. DELETE defensivo
-- Se um lead que TOCA o domínio é apagado sem linha de identidade (estado histórico inesperado),
-- a fronteira grava a identidade já `retired`. O DELETE de lead que nunca tocou o domínio
-- continua sem deixar identidade. Quando a organização inteira vai embora e a cascata já levou o
-- binding, não há como avaliar o toque: a identidade criada pelo binding (item 1) é o que cobre.
--
-- ── 3. Backfill (reaplicável)
-- Leads vivos que hoje tocam o domínio sem identidade entram `live` (inclui os que a 0504 deixou
-- escapar por binding); todo id com rastro Green cujo lead não existe mais entra `retired`.

-- ── 1 · binding → identidade dos leads existentes ────────────────────────────
create or replace function green.fn_claim_binding_identities()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- serializa com as escritas de lead em voo (ver o cabeçalho)
  lock table public.crm_leads in share row exclusive mode;

  insert into green.lead_identity (lead_id)
  select l.id
    from public.crm_leads l
   where l.organization_id = new.organization_id
     and (l.pipeline_id = new.pipeline_id
          or l.stage_id in (select s.id
                              from public.crm_stages s
                             where s.organization_id = new.organization_id
                               and s.pipeline_id = new.pipeline_id))
  on conflict (lead_id) do nothing;

  -- lead vivo com UUID já aposentado entrando no domínio: o mesmo erro de domínio, igual para
  -- qualquer organização; a transação do binding desfaz inclusive as identidades acima
  if exists (
       select 1
         from public.crm_leads l
         join green.lead_identity i on i.lead_id = l.id
        where i.state = 'retired'
          and l.organization_id = new.organization_id
          and (l.pipeline_id = new.pipeline_id
               or l.stage_id in (select s.id
                                   from public.crm_stages s
                                  where s.organization_id = new.organization_id
                                    and s.pipeline_id = new.pipeline_id))) then
    raise exception 'green_lead_id_reuse_forbidden' using errcode = 'P0001';
  end if;
  return null;
end $$;
revoke all on function green.fn_claim_binding_identities() from public, anon, authenticated, service_role;

drop trigger if exists trg_green_binding_claims_identities on green.product_pipeline_binding;
create trigger trg_green_binding_claims_identities
  after insert or update of organization_id, pipeline_id on green.product_pipeline_binding
  for each row execute function green.fn_claim_binding_identities();

-- ── 2 · fronteira: DELETE defensivo ──────────────────────────────────────────
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
      perform green.fn_assert_service_origin(v_env -> 'service_origin', new.organization_id, new.contact_id);
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
     request_id, advisory_request_id)
  values
    (old.organization_id, old.id, v_kind, old.stage_id,
     case when tg_op = 'DELETE' then null else new.stage_id end,
     old.pipeline_id,
     case when tg_op = 'DELETE' then null else new.pipeline_id end,
     v_trusted ->> 'request_id',
     coalesce(v_env -> 'advisory' ->> 'client_request_id', v_env -> 'advisory' ->> 'request_id'))
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

-- ── 3 · backfill (reaplicável) ───────────────────────────────────────────────
insert into green.lead_identity (lead_id)
select l.id
  from public.crm_leads l
 where exists (select 1 from green.product_pipeline_binding b
                where b.organization_id = l.organization_id and b.pipeline_id = l.pipeline_id)
    or exists (select 1
                 from public.crm_stages s
                 join green.product_pipeline_binding b
                   on b.organization_id = s.organization_id and b.pipeline_id = s.pipeline_id
                where s.id = l.stage_id and s.organization_id = l.organization_id)
on conflict (lead_id) do nothing;

insert into green.lead_identity (lead_id, state, retired_at)
select h.lead_id,
       case when exists (select 1 from public.crm_leads l where l.id = h.lead_id) then 'live' else 'retired' end,
       case when exists (select 1 from public.crm_leads l where l.id = h.lead_id) then null else now() end
  from (select p.lead_id from green.lead_birth_provenance p
        union
        select g.lead_id from green.stage_event_ledger g
        union
        select e.entity_id from public.event_log e
         where e.entity_kind = 'crm_lead' and e.event_type = 'lead.deleted'
           and e.metadata -> 'green_canonical' = 'true'::jsonb
           and e.entity_id is not null) h
on conflict (lead_id) do nothing;

notify pgrst, 'reload schema';
