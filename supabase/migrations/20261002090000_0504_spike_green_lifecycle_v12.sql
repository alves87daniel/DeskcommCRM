-- 0504 (SPIKE Green lifecycle v1.2 — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-01.2: correções da AUDIT-GREEN-01.1. Delta experimental SOBRE a 0503
-- (lifecycle v1), que fica intacta junto com a 0501 e a 0502.
--
-- ── 1. LIFE-ADV-02: o x-request-id do cliente nunca é confiável ─────────────────
-- O banco confia no contexto que o BACKEND manda (writer privilegiado). O defeito
-- estava no backend, que copiava o header do cliente para `request_id` /
-- `correlation_id`; o conserto de origem é do TS (o gate gera o id). Aqui o banco
-- ganha o lugar do que o cliente mandou: a chave `client_request_id` do contexto,
-- que o envelope põe SEMPRE em `advisory` (qualquer caller) e nunca em `trusted`.
-- `fn_mutation_context` e `fn_mutation_envelope` são REDEFINIDAS (cópias das da
-- 0501/0502 com só esse delta); o `advisory_request_id` do livro-razão passa a
-- preferir o id do cliente.
--
-- ── 2. LIFE-ADV-03: o UUID de um lead Green NÃO é reciclável ─────────────────────
-- Decisão arquitetural: um UUID identifica UMA existência lógica de lead. Depois de
-- participar do lifecycle Green ele não representa outro lead; DELETE não o libera.
-- `green.lead_identity (lead_id, state, first_seen_at, retired_at)` é o registro
-- mínimo: SEM FK para o lead (sobrevive ao DELETE) e SEM FK para organização (a
-- cascata do tenant não devolve o UUID), sem org/ator/origem/PII — o histórico
-- vive no `event_log`, no livro-razão e na proveniência. `live` enquanto o lead
-- existe, `retired` para sempre depois do DELETE (qualquer DELETE de um lead com
-- identidade, Green ou não, inclusive pela cascata). A fronteira reivindica a
-- identidade em toda ENTRADA no domínio (INSERT Green ou lead que vem de fora) e
-- recusa um UUID aposentado com `green_lead_id_reuse_forbidden`, a mesma resposta
-- para qualquer organização. Trocar o id de um lead com identidade é recusado
-- (`green_lead_id_immutable`): trocar o id libertaria o antigo.
-- `lead_birth_provenance` continua uma linha por lead: o reuso é recusado ANTES do
-- insert, então a PK deixa de ser a barreira acidental.
-- Backfill: leads que hoje tocam o domínio entram `live`; todo id com rastro Green
-- (proveniência, livro-razão, lápide) cujo lead não existe mais entra `retired`.
-- Limite honesto: UUIDs de leads cuja organização foi apagada ANTES da 0504 não
-- deixaram rastro (a proveniência e o livro-razão cascateiam com o tenant) e não
-- podem ser aposentados retroativamente.

-- ── 1 · contexto e envelope: `client_request_id` é sempre advisory ────────────
create or replace function green.fn_mutation_context()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_jwt_role  text;
  v_role      text;
  v_caller    text;
  v_header    text;
  v_raw       jsonb;
  v_reason    text := null;
  v_actor     jsonb := null;
  v_origin    jsonb := null;
  v_boundary  jsonb;
  v_kind      text;
  v_advisory  jsonb := '{}'::jsonb;
begin
  begin
    v_jwt_role := coalesce(auth.jwt() ->> 'role', '');
  exception when others then
    v_jwt_role := '';
  end;
  -- Papel da REQUEST, não `current_user`: chamado de trigger definer,
  -- `current_user` é o dono; o claim e o GUC `role` (SET ROLE do PostgREST)
  -- continuam sendo os de quem fez a request.
  v_role := coalesce(nullif(v_jwt_role, ''), nullif(current_setting('role', true), 'none'), '');
  v_caller := case
    when v_uid is not null then 'user'
    when v_role = 'service_role' then 'service_role'
    when v_role in ('anon', 'authenticated') then 'anonymous'
    else 'direct'
  end;

  -- transporte 1: header da request PostgREST
  begin
    v_header := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-green-mutation-context';
  exception when others then
    v_header := null;
  end;
  if v_header is not null then
    begin
      v_raw := convert_from(decode(v_header, 'base64'), 'UTF8')::jsonb;
    exception when others then
      v_raw := null; v_reason := 'undecodable_header';
    end;
  elsif v_caller = 'direct' then
    -- transporte 2: GUC transacional — só conexão pg direta (sem papel de request)
    begin
      v_raw := nullif(current_setting('green.mutation_context', true), '')::jsonb;
    exception when others then
      v_raw := null; v_reason := 'undecodable_guc';
    end;
  end if;

  -- ── validação de forma (vale para todo chamador; humano só a usa como advisory)
  if v_raw is not null and jsonb_typeof(v_raw) <> 'object' then
    v_raw := null; v_reason := coalesce(v_reason, 'not_object');
  end if;
  if v_raw is not null and octet_length(v_raw::text) > 4096 then
    v_raw := null; v_reason := 'too_large';
  end if;
  if v_raw is not null and exists (
       select 1 from jsonb_object_keys(v_raw) k
        where k not in ('v','source','request_id','correlation_id','causation_event_id',
                        'source_job_id','idempotency_key','client_request_id','actor','service_origin')) then
    -- contrato fechado por chave: PII não tem por onde entrar
    v_raw := null; v_reason := 'unknown_key';
  end if;
  if v_raw is not null then
    if v_raw ->> 'v' is distinct from '1' then v_reason := 'version';
    elsif not (coalesce(v_raw ->> 'source', '') ~ '^[a-z][a-z0-9_.:-]{0,63}$') then v_reason := 'source';
    elsif not green.fn_ctx_id_ok(v_raw ->> 'request_id') then v_reason := 'request_id';
    elsif not green.fn_ctx_id_ok(v_raw ->> 'correlation_id') then v_reason := 'correlation_id';
    elsif not green.fn_ctx_uuid_ok(v_raw ->> 'causation_event_id') then v_reason := 'causation_event_id';
    elsif not green.fn_ctx_id_ok(v_raw ->> 'source_job_id') then v_reason := 'source_job_id';
    elsif not green.fn_ctx_id_ok(v_raw ->> 'idempotency_key') then v_reason := 'idempotency_key';
    elsif not green.fn_ctx_id_ok(v_raw ->> 'client_request_id') then v_reason := 'client_request_id';
    end if;
  end if;
  if v_raw is not null and v_reason is null then
    v_advisory := jsonb_strip_nulls(jsonb_build_object(
      'source',             v_raw ->> 'source',
      'request_id',         v_raw ->> 'request_id',
      'correlation_id',     v_raw ->> 'correlation_id',
      'causation_event_id', v_raw ->> 'causation_event_id',
      'idempotency_key',    v_raw ->> 'idempotency_key',
      'source_job_id',      v_raw ->> 'source_job_id',
      'client_request_id',  v_raw ->> 'client_request_id'));
  end if;

  -- ── sessão humana: actor é auth.uid(); actor/service_origin do header são ignorados
  if v_caller = 'user' then
    return jsonb_build_object(
      'caller', 'user', 'valid', true, 'reason', null,
      'actor', jsonb_build_object('kind', 'user', 'id', v_uid),
      'service_origin', null) || v_advisory;
  end if;

  -- ── request sem identidade: nunca confiável, qualquer que seja o header
  if v_caller = 'anonymous' then
    return jsonb_build_object(
      'caller', 'anonymous', 'valid', false, 'reason', 'anonymous',
      'actor', null, 'service_origin', null);
  end if;

  -- ── writer privilegiado: actor explícito e service_origin validados por schema
  if v_raw is not null and v_reason is null then
    v_actor := v_raw -> 'actor';
    if v_actor is null then v_reason := 'actor_required';
    elsif jsonb_typeof(v_actor) <> 'object' then v_reason := 'actor';
    elsif exists (select 1 from jsonb_object_keys(v_actor) k where k not in ('kind','id','agent_id','api_token_id')) then v_reason := 'actor_key';
    elsif coalesce(v_actor ->> 'kind', '') not in ('ai_agent','api_token','webhook_source','system') then v_reason := 'actor_kind';
    elsif not green.fn_ctx_id_ok(v_actor ->> 'id') or not green.fn_ctx_id_ok(v_actor ->> 'agent_id')
       or not green.fn_ctx_id_ok(v_actor ->> 'api_token_id') then v_reason := 'actor_id';
    end if;
  end if;
  if v_raw is not null and v_reason is null and v_raw ? 'service_origin' then
    v_origin := v_raw -> 'service_origin';
    v_kind := case when jsonb_typeof(v_origin) = 'object' then v_origin ->> 'kind' end;
    if v_kind = 'event' then
      if exists (select 1 from jsonb_object_keys(v_origin) k where k not in ('kind','event_id','organization_id','contact_id'))
         or v_origin ->> 'event_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'event_id')
         or v_origin ->> 'organization_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'organization_id')
         or v_origin ->> 'contact_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'contact_id') then
        v_reason := 'service_origin_event';
      end if;
    elsif v_kind = 'continuation' then
      v_boundary := v_origin -> 'boundary';
      if exists (select 1 from jsonb_object_keys(v_origin) k where k not in ('kind','boundary'))
         or v_boundary is null or jsonb_typeof(v_boundary) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_boundary) k
                     where k not in ('organization_id','contact_id','conversation_id','service_revision','demanda_id','demanda_revision'))
         or v_boundary ->> 'organization_id' is null or not green.fn_ctx_uuid_ok(v_boundary ->> 'organization_id')
         or v_boundary ->> 'contact_id' is null or not green.fn_ctx_uuid_ok(v_boundary ->> 'contact_id')
         or v_boundary ->> 'conversation_id' is null or not green.fn_ctx_uuid_ok(v_boundary ->> 'conversation_id')
         or jsonb_typeof(v_boundary -> 'service_revision') <> 'number'
         or not (jsonb_typeof(v_boundary -> 'demanda_id') = 'null' or green.fn_ctx_uuid_ok(v_boundary ->> 'demanda_id'))
         or jsonb_typeof(v_boundary -> 'demanda_revision') not in ('null','number') then
        v_reason := 'service_origin_continuation';
      end if;
    else
      -- `command` nunca viaja (o banco deriva); `unavailable` não é origem.
      v_reason := 'service_origin_kind';
    end if;
  end if;

  if v_raw is null or v_reason is not null then
    return jsonb_build_object(
      'caller', v_caller, 'valid', false, 'reason', coalesce(v_reason, 'missing'),
      'actor', null, 'service_origin', null);
  end if;
  return jsonb_build_object(
    'caller', v_caller, 'valid', true, 'reason', null,
    'actor', v_actor, 'service_origin', v_origin) || v_advisory;
end $$;
revoke all on function green.fn_mutation_context() from public, anon, authenticated;
grant execute on function green.fn_mutation_context() to service_role;

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
  -- o que o CLIENTE mandou como x-request-id: advisory em QUALQUER caller, nunca trusted
  v_cliente  jsonb := jsonb_strip_nulls(jsonb_build_object('client_request_id', v_ctx ->> 'client_request_id'));
begin
  if v_caller = 'user' then
    -- Sessão humana: confiável é SÓ o que o banco deriva do canal real. O
    -- header inteiro é advisory — inclusive `source`, que o cliente escolhe.
    v_trusted := jsonb_build_object(
      'caller', 'user', 'actor', v_ctx -> 'actor', 'source', 'user_session');
    v_advisory := v_campos || v_cliente;
  elsif v_valid then
    -- Writer privilegiado: o contexto validado veio do backend (dono da chave).
    v_trusted := jsonb_build_object('caller', v_caller, 'actor', v_ctx -> 'actor') || v_campos;
    v_advisory := v_cliente;
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

-- ── 2 · registro de identidade ──────────────────────────────────────────────
create table if not exists green.lead_identity (
  lead_id       uuid primary key,
  state         text not null default 'live' check (state in ('live', 'retired')),
  first_seen_at timestamptz not null default now(),
  retired_at    timestamptz,
  constraint lead_identity_retirada_coerente check ((state = 'retired') = (retired_at is not null))
);
comment on table green.lead_identity is
  'SPIKE Green lifecycle v1.2: identidade mínima de um lead que participou do domínio Green. Sem FK (sobrevive ao DELETE do lead e à cascata do tenant), sem org/ator/origem/PII. live = o lead existe; retired = a existência lógica acabou e o UUID não pode representar outro lead.';
alter table green.lead_identity enable row level security;
revoke all on green.lead_identity from public, anon, authenticated, service_role;
grant select on green.lead_identity to service_role;

-- backfill (reaplicável): quem toca o domínio hoje está vivo; todo id com rastro Green
-- cujo lead não existe mais está aposentado.
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

-- reivindica a identidade de um lead que entra no domínio; recusa a de um UUID aposentado.
-- Só a fronteira (definer, dono) a executa: nenhum papel de API a alcança.
create or replace function green.fn_claim_lead_identity(p_lead uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  insert into green.lead_identity (lead_id) values (p_lead) on conflict (lead_id) do nothing;
  select i.state into v_state from green.lead_identity i where i.lead_id = p_lead;
  if v_state = 'retired' then
    -- mesma mensagem para qualquer organização; nada do histórico vai no erro
    raise exception 'green_lead_id_reuse_forbidden' using errcode = 'P0001';
  end if;
end $$;
revoke all on function green.fn_claim_lead_identity(uuid) from public, anon, authenticated, service_role;

-- ── 3 · fronteira: identidade não reciclável + advisory_request_id ────────────
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
    return null;
  end if;

  if tg_op <> 'INSERT' then
    v_old_p := green.fn_is_green_pipeline(old.organization_id, old.pipeline_id);
    v_toca := v_old_p or green.fn_lead_touches_green(old.organization_id, old.pipeline_id, old.stage_id);
    v_old_toca := v_toca;
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

notify pgrst, 'reload schema';
