-- 0501 (SPIKE Green — DESCARTÁVEL; não é produto, não vai para produção).
--
-- Green Mutation Boundary sobre `crm_leads`: prova que uma Opportunity Green
-- hospedada em `crm_leads` pode ter (1) validação Green centralizada no banco,
-- (2) `stage mutation + lead.stage_changed` na MESMA transação, (3) actor
-- confiável, (4) request/correlation/causation, (5) `service_origin`
-- preservada, (6) anti-loop de automação e (7) zero mudança para lead não-Green
-- — SEM patchar os oito writers de `crm_leads.stage_id`.
--
-- Desenho: Conector Green, `docs/audits/deskcomm-fit/05A-SPIKE-MUTATION-CONTEXT.md`.
--
-- ── Transporte ──────────────────────────────────────────────────────────────
-- O contexto viaja no header `x-green-mutation-context` (JSON UTF-8 em Base64)
-- da própria request PostgREST que executa o UPDATE, lido por
-- `current_setting('request.headers', true)` — o mesmo lugar que a 0250 já lê
-- em produção. Conexão `pg` direta (sem PostgREST) usa o GUC transacional
-- `green.mutation_context` (JSON), definido com `set_config(..., true)`.
--
-- ── Confiança ───────────────────────────────────────────────────────────────
-- O contexto NUNCA concede autorização (RLS/roles continuam mandando):
--   * `auth.uid()` presente  → actor = user/auth.uid(); actor e service_origin
--                              do header são IGNORADOS; o resto é advisory;
--   * service_role / direta  → contexto validado por schema; `source` e
--                              `actor.kind` (nunca `user`) obrigatórios;
--                              ausente ou inválido em lead Green ⇒ fail-closed.
--
-- ── Hooks (core patch explícito do fork; módulo nativo não instala trigger em
--    tabela core) ─────────────────────────────────────────────────────────────
--   * BEFORE INSERT/UPDATE em crm_leads: só pipeline Green (binding) — confere
--     etapa do funil, exige contexto em writer privilegiado, valida
--     `service_origin` contra org/contato/fronteira vigente;
--   * AFTER UPDATE em crm_leads: OLD.stage_id IS DISTINCT FROM NEW.stage_id em
--     pipeline Green ⇒ `public.emit_event('lead.stage_changed', ...)` com
--     `metadata.green_canonical=true`. Erro NÃO é capturado: evento falha ⇒
--     UPDATE falha;
--   * BEFORE INSERT em event_log: `lead.stage_changed`/`crm_lead` de lead Green
--     sem `green_canonical` ⇒ no-op (os emitters legados continuam chamando
--     `emit_event`; para Green a segunda linha não nasce; non-Green intacto).
--
-- Sem o binding físico (`to_regclass`) os hooks são no-op: Deskcomm puro.

create schema if not exists green;
grant usage on schema green to authenticated, service_role;

-- ── binding mínimo de pipeline gerenciado (não é catálogo iGreen) ────────────
create table if not exists green.product_pipeline_binding (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id     uuid not null references public.crm_pipelines(id) on delete cascade,
  product_key     text not null,
  created_at      timestamptz not null default now(),
  primary key (organization_id, pipeline_id)
);
comment on table green.product_pipeline_binding is
  'SPIKE Green: pipeline gerenciado (organização + funil → produto). Existe antes do lead; é a âncora dos hooks de INSERT/UPDATE.';
alter table green.product_pipeline_binding enable row level security;
revoke all on green.product_pipeline_binding from public, anon, authenticated;
grant select on green.product_pipeline_binding to service_role;

-- ── pipeline é Green? (definer: a sessão humana não lê a tabela diretamente) ─
create or replace function green.fn_is_green_pipeline(p_org uuid, p_pipeline uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or p_pipeline is null then return false; end if;
  -- módulo ausente ⇒ Deskcomm puro (fail-open só quanto à ausência FÍSICA)
  if to_regclass('green.product_pipeline_binding') is null then return false; end if;
  return exists (
    select 1 from green.product_pipeline_binding b
     where b.organization_id = p_org and b.pipeline_id = p_pipeline
  );
end $$;
revoke all on function green.fn_is_green_pipeline(uuid, uuid) from public, anon;
grant execute on function green.fn_is_green_pipeline(uuid, uuid) to authenticated, service_role;

-- ── validadores de forma (imutáveis, sem I/O) ──────────────────────────────
create or replace function green.fn_ctx_id_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or p ~ '^[A-Za-z0-9_.:-]{1,128}$'
$$;
create or replace function green.fn_ctx_uuid_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
revoke all on function green.fn_ctx_id_ok(text) from public, anon;
revoke all on function green.fn_ctx_uuid_ok(text) from public, anon;
grant execute on function green.fn_ctx_id_ok(text) to authenticated, service_role;
grant execute on function green.fn_ctx_uuid_ok(text) to authenticated, service_role;

-- ── resolver do MutationContext ─────────────────────────────────────────────
-- Devolve: { caller: user|service_role|direct, valid, reason, actor,
--            service_origin, source, request_id, correlation_id,
--            causation_event_id, idempotency_key, source_job_id }
create or replace function green.fn_mutation_context()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_jwt_role  text;
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
  else
    -- transporte 2: GUC transacional (conexão pg direta, sem PostgREST)
    begin
      v_raw := nullif(current_setting('green.mutation_context', true), '')::jsonb;
    exception when others then
      v_raw := null; v_reason := 'undecodable_guc';
    end;
  end if;

  v_caller := case
    when v_uid is not null then 'user'
    when current_user = 'service_role' or v_jwt_role = 'service_role' then 'service_role'
    else 'direct'
  end;

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
                        'source_job_id','idempotency_key','actor','service_origin')) then
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
    end if;
  end if;
  if v_raw is not null and v_reason is null then
    v_advisory := jsonb_strip_nulls(jsonb_build_object(
      'source',             v_raw ->> 'source',
      'request_id',         v_raw ->> 'request_id',
      'correlation_id',     v_raw ->> 'correlation_id',
      'causation_event_id', v_raw ->> 'causation_event_id',
      'idempotency_key',    v_raw ->> 'idempotency_key',
      'source_job_id',      v_raw ->> 'source_job_id'));
  end if;

  -- ── sessão humana: actor é auth.uid(); actor/service_origin do header são ignorados
  if v_caller = 'user' then
    return jsonb_build_object(
      'caller', 'user', 'valid', true, 'reason', null,
      'actor', jsonb_build_object('kind', 'user', 'id', v_uid),
      'service_origin', null) || v_advisory;
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
revoke all on function green.fn_mutation_context() from public, anon;
grant execute on function green.fn_mutation_context() to authenticated, service_role;

-- ── service_origin transportada tem de bater com o lead e com a fronteira vigente
create or replace function green.fn_assert_service_origin(p_origin jsonb, p_org uuid, p_contact uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_b    jsonb;
  v_conv record;
begin
  if p_origin is null or jsonb_typeof(p_origin) <> 'object' then return; end if;
  v_kind := p_origin ->> 'kind';

  if v_kind = 'event' then
    if (p_origin ->> 'organization_id')::uuid is distinct from p_org
       or (p_origin ->> 'contact_id')::uuid is distinct from p_contact then
      raise exception 'green_service_origin_scope_mismatch' using errcode = '23503';
    end if;
    if not exists (select 1 from public.event_log e
                    where e.id = (p_origin ->> 'event_id')::uuid and e.organization_id = p_org) then
      raise exception 'green_service_origin_event_not_found' using errcode = '23503';
    end if;
    return;
  end if;

  if v_kind = 'continuation' then
    v_b := p_origin -> 'boundary';
    if (v_b ->> 'organization_id')::uuid is distinct from p_org
       or (v_b ->> 'contact_id')::uuid is distinct from p_contact then
      raise exception 'green_service_origin_scope_mismatch' using errcode = '23503';
    end if;
    select c.service_revision, c.current_demanda_id, c.status,
           d.revision as demanda_revision, d.fechada_em
      into v_conv
      from public.conversations c
      left join public.demandas d
        on d.id = c.current_demanda_id and d.organization_id = c.organization_id
     where c.organization_id = p_org and c.contact_id = p_contact
       and c.id = (v_b ->> 'conversation_id')::uuid;
    -- Mesma régua de `assertCurrentServiceBoundary` (lib/atendimento/fronteira.ts):
    -- conversa terminal, demanda fechada, revisão diferente ou demanda trocada
    -- (quando a fronteira tinha demanda) ⇒ stale.
    if not found
       or v_conv.status in ('closed','resolved','archived')
       or v_conv.fechada_em is not null
       or v_conv.service_revision is distinct from (v_b ->> 'service_revision')::bigint
       or (nullif(v_b ->> 'demanda_id', '') is not null and (
             v_conv.current_demanda_id is distinct from (v_b ->> 'demanda_id')::uuid
          or v_conv.demanda_revision is distinct from (v_b ->> 'demanda_revision')::bigint)) then
      raise exception 'service_boundary_stale' using errcode = '40001';
    end if;
    return;
  end if;

  raise exception 'green_service_origin_kind' using errcode = '22023';
end $$;
revoke all on function green.fn_assert_service_origin(jsonb, uuid, uuid) from public, anon;
grant execute on function green.fn_assert_service_origin(jsonb, uuid, uuid) to authenticated, service_role;

-- ── hook BEFORE: guarda Green de crm_leads ──────────────────────────────────
create or replace function green.fn_guard_crm_lead_stage()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ctx jsonb;
begin
  -- anon nunca passa pela RLS de crm_leads; não há o que guardar
  if current_user = 'anon' then return new; end if;
  -- só mutação de etapa/funil (ou nascimento) entra na guarda
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.pipeline_id is not distinct from old.pipeline_id then
    return new;
  end if;
  if not green.fn_is_green_pipeline(new.organization_id, new.pipeline_id) then return new; end if;

  -- binding da etapa: a etapa tem de ser deste funil e desta organização
  if not exists (select 1 from public.crm_stages s
                  where s.id = new.stage_id
                    and s.organization_id = new.organization_id
                    and s.pipeline_id = new.pipeline_id) then
    raise exception 'green_stage_not_bound' using errcode = '23503';
  end if;

  v_ctx := green.fn_mutation_context();
  if v_ctx ->> 'caller' <> 'user' then
    if not coalesce((v_ctx ->> 'valid')::boolean, false) then
      raise exception 'green_mutation_context_required'
        using errcode = '42501', detail = coalesce(v_ctx ->> 'reason', 'missing');
    end if;
    perform green.fn_assert_service_origin(v_ctx -> 'service_origin', new.organization_id, new.contact_id);
  end if;
  return new;
end $$;

-- ── hook AFTER: evento canônico na MESMA transação ──────────────────────────
create or replace function green.fn_emit_crm_lead_stage_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ctx     jsonb;
  v_meta    jsonb;
  v_payload jsonb;
begin
  if old.stage_id is not distinct from new.stage_id then return null; end if;
  if not green.fn_is_green_pipeline(new.organization_id, new.pipeline_id) then return null; end if;

  v_ctx := green.fn_mutation_context();
  v_meta := jsonb_build_object(
      'green_canonical', true,
      'green_context_version', 1,
      'caller', v_ctx ->> 'caller',
      'actor', v_ctx -> 'actor')
    || jsonb_strip_nulls(jsonb_build_object(
      'source',             v_ctx ->> 'source',
      'request_id',         v_ctx ->> 'request_id',
      'correlation_id',     v_ctx ->> 'correlation_id',
      'causation_event_id', v_ctx ->> 'causation_event_id',
      'idempotency_key',    v_ctx ->> 'idempotency_key',
      'source_job_id',      v_ctx ->> 'source_job_id',
      -- compat com o metadata legado: rotas humanas gravam `actor_user_id`,
      -- writers privilegiados gravam `actor_kind`
      'actor_user_id', case when v_ctx ->> 'caller' = 'user' then v_ctx -> 'actor' ->> 'id' end,
      'actor_kind',    v_ctx -> 'actor' ->> 'kind'));
  v_payload := jsonb_build_object(
      'pipeline_id',   new.pipeline_id,
      'from_stage_id', old.stage_id,
      'to_stage_id',   new.stage_id,
      -- `fn_crm_lead_close_on_stage` é BEFORE: o status aqui já é o derivado
      'status',        new.status);
  -- `command` nunca é transportada: sem service_origin, `emit_event` deriva o
  -- retrato no banco. Humano nunca transporta origem (emit_event recusaria).
  if v_ctx ->> 'caller' <> 'user' and jsonb_typeof(v_ctx -> 'service_origin') = 'object' then
    v_payload := v_payload || jsonb_build_object('service_origin', v_ctx -> 'service_origin');
  end if;

  -- Erro aqui NÃO é capturado: evento falha ⇒ UPDATE inteiro faz rollback.
  perform public.emit_event('lead.stage_changed', 'crm_lead', new.id, v_payload, v_meta, new.organization_id);
  return null;
end $$;

-- ── hook em event_log: suprime a emissão legada duplicada (só Green) ────────
create or replace function green.fn_suppress_legacy_stage_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pipeline uuid;
begin
  if new.event_type <> 'lead.stage_changed' or new.entity_kind is distinct from 'crm_lead' then return new; end if;
  if coalesce(new.metadata ->> 'green_canonical', '') = 'true' then return new; end if;
  select l.pipeline_id into v_pipeline
    from public.crm_leads l
   where l.id = new.entity_id and l.organization_id = new.organization_id;
  if v_pipeline is null or not green.fn_is_green_pipeline(new.organization_id, v_pipeline) then return new; end if;
  -- lead Green: o stage change commitado já tem o evento canônico do trigger
  return null;
end $$;

-- Funções de trigger não passam por EXECUTE na hora de disparar (o Postgres só
-- confere no CREATE TRIGGER); os grants abaixo são declarativos. NUNCA a anon:
-- ela não alcança crm_leads/event_log (RLS) e a varredura de anon do baseline
-- exige que nenhum bloco a devolva.
revoke all on function green.fn_guard_crm_lead_stage() from public;
revoke all on function green.fn_emit_crm_lead_stage_changed() from public;
revoke all on function green.fn_suppress_legacy_stage_changed() from public;
grant execute on function green.fn_guard_crm_lead_stage() to authenticated, service_role;
grant execute on function green.fn_emit_crm_lead_stage_changed() to authenticated, service_role;
grant execute on function green.fn_suppress_legacy_stage_changed() to authenticated, service_role;

drop trigger if exists trg_green_guard_crm_lead_stage on public.crm_leads;
create trigger trg_green_guard_crm_lead_stage
  before insert or update on public.crm_leads
  for each row execute function green.fn_guard_crm_lead_stage();

drop trigger if exists trg_green_emit_crm_lead_stage_changed on public.crm_leads;
create trigger trg_green_emit_crm_lead_stage_changed
  after update on public.crm_leads
  for each row execute function green.fn_emit_crm_lead_stage_changed();

drop trigger if exists trg_green_suppress_legacy_stage_changed on public.event_log;
create trigger trg_green_suppress_legacy_stage_changed
  before insert on public.event_log
  for each row execute function green.fn_suppress_legacy_stage_changed();

notify pgrst, 'reload schema';
