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
-- Rodada v2: fecha os gaps da auditoria independente do SPIKE-DESKCOMM-07
-- (`05-EVENTOS-IDEMPOTENCIA-ATOMICIDADE.md`) — produtor canônico não forjável,
-- `service_origin.event` amarrada ao contato real do evento, helpers fora da
-- API de `authenticated` e supressor restrito ao gêmeo da mutação canonizada.
--
-- ── Transporte ──────────────────────────────────────────────────────────────
-- O contexto viaja no header `x-green-mutation-context` (JSON UTF-8 em Base64)
-- da própria request PostgREST que executa o UPDATE, lido por
-- `current_setting('request.headers', true)` — o mesmo lugar que a 0250 já lê
-- em produção. Conexão `pg` direta (sem PostgREST, sem papel de request) usa o
-- GUC transacional `green.mutation_context` (JSON), definido com
-- `set_config(..., true)`.
--
-- ── Confiança ───────────────────────────────────────────────────────────────
-- O contexto NUNCA concede autorização (RLS/roles continuam mandando):
--   * `auth.uid()` presente  → actor = user/auth.uid(); actor e service_origin
--                              do header são IGNORADOS; o resto é advisory;
--   * service_role / direta  → contexto validado por schema; `source` e
--                              `actor.kind` (nunca `user`) obrigatórios;
--                              ausente ou inválido em lead Green ⇒ fail-closed;
--   * anon / sem identidade  → nunca confiável; lead Green ⇒ fail-closed.
--
-- ── Privilégios (v2) ────────────────────────────────────────────────────────
-- O schema `green` NÃO é API de `authenticated`/`anon`: sem USAGE, sem EXECUTE,
-- sem tabela. Quem precisa dos helpers são os TRIGGERS, que rodam como dono
-- (`security definer`, `search_path=''`). Função de trigger não pode ser chamada
-- fora de trigger ("trigger functions can only be called as triggers"), então o
-- definer só é exercido por uma escrita real em `crm_leads`/`event_log` que a
-- RLS já autorizou — não é porta de escalada. Dentro do definer, `current_user`
-- é o dono; por isso o chamador é classificado pelo claim do JWT e pelo GUC
-- `role` da request (que o definer não troca), nunca por `current_user`.
-- `service_role` mantém EXECUTE nos helpers (backend legítimo).
--
-- ── Hooks (core patch explícito do fork; módulo nativo não instala trigger em
--    tabela core) ─────────────────────────────────────────────────────────────
--   * BEFORE INSERT/UPDATE em crm_leads: só pipeline Green (binding) — confere
--     etapa do funil, exige contexto em writer privilegiado, valida
--     `service_origin` contra org/contato/fronteira vigente e, para
--     `kind=event`, contra o contato REAL do evento (mesma regra de
--     `public.fn_service_event_origin`);
--   * AFTER UPDATE em crm_leads: OLD.stage_id IS DISTINCT FROM NEW.stage_id em
--     pipeline Green ⇒ linha no livro-razão `green.stage_event_ledger` + prova de
--     produtor (GUC transacional de uso único apontando para ela) +
--     `public.emit_event('lead.stage_changed', ...)`. Erro NÃO é capturado:
--     evento falha ⇒ UPDATE falha;
--   * BEFORE INSERT/UPDATE em event_log: (a) a marca canônica
--     (`green_canonical`/`green_context_version`) só nasce com a prova do
--     produtor e é imutável depois; (b) `lead.stage_changed` legado sem marca é
--     suprimido SÓ quando é o gêmeo de uma mutação já canonizada (mesmo lead,
--     mesma transição, janela curta, gêmeo ainda não visto). O resto passa
--     intacto — inclusive lead não-Green, que nunca tem linha no livro-razão.
--
-- Sem o binding físico (`to_regclass`) os hooks são no-op: Deskcomm puro.

create schema if not exists green;
-- v2: o schema deixa de ser alcançável por authenticated/anon (oracle fechado).
revoke all on schema green from public, anon, authenticated;
grant usage on schema green to service_role;

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

-- ── livro-razão do produtor canônico (v2) ───────────────────────────────────
-- Uma linha por mutação Green canonizada. É a PROVA de proveniência do evento
-- canônico (só o trigger de crm_leads, como dono, escreve aqui) e a chave do
-- supressor: o gêmeo legado é casado com a linha da SUA mutação, não com o lead.
create table if not exists green.stage_event_ledger (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  lead_id              uuid not null,
  from_stage_id        uuid,
  to_stage_id          uuid not null,
  request_id           text,
  txid                 bigint not null default txid_current(),
  canonical_event_id   uuid unique,
  legacy_suppressed_at timestamptz,
  legacy_request_id    text,
  created_at           timestamptz not null default now()
);
comment on table green.stage_event_ledger is
  'SPIKE Green: prova de produtor do lead.stage_changed canônico e chave do supressor do gêmeo legado. Escrita só pelos triggers (dono).';
create index if not exists stage_event_ledger_twin_idx
  on green.stage_event_ledger (organization_id, lead_id, created_at desc)
  where legacy_suppressed_at is null;
alter table green.stage_event_ledger enable row level security;
revoke all on green.stage_event_ledger from public, anon, authenticated;
grant select on green.stage_event_ledger to service_role;

-- ── pipeline é Green? (invoker: dono pelos triggers, service_role direto) ────
create or replace function green.fn_is_green_pipeline(p_org uuid, p_pipeline uuid)
returns boolean
language plpgsql stable
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
revoke all on function green.fn_is_green_pipeline(uuid, uuid) from public, anon, authenticated;
grant execute on function green.fn_is_green_pipeline(uuid, uuid) to service_role;

-- ── validadores de forma (imutáveis, sem I/O) ──────────────────────────────
create or replace function green.fn_ctx_id_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or p ~ '^[A-Za-z0-9_.:-]{1,128}$'
$$;
create or replace function green.fn_ctx_uuid_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
revoke all on function green.fn_ctx_id_ok(text) from public, anon, authenticated;
revoke all on function green.fn_ctx_uuid_ok(text) from public, anon, authenticated;
grant execute on function green.fn_ctx_id_ok(text) to service_role;
grant execute on function green.fn_ctx_uuid_ok(text) to service_role;

-- ── resolver do MutationContext ─────────────────────────────────────────────
-- Devolve: { caller: user|service_role|direct|anonymous, valid, reason, actor,
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

-- ── contato REAL de um evento de origem (v2) ────────────────────────────────
-- Projeção SEM EFEITO COLATERAL da regra canônica de
-- `public.fn_service_event_origin` (última definição da cadeia): o contato de um
-- evento é o da sua ENTIDADE, pela mesma tabela tipo → entidade → contato, e a
-- cadeia `payload.service_origin.kind=event` é seguida até a raiz com o mesmo
-- teto de ciclo. A função canônica não pode ser chamada aqui: ela trava o
-- contato (advisory), pode abrir atendimento (`fn_service_begin`) e grava o
-- memo `event_service_origins` — efeitos de CONSUMIR o evento, não de conferir
-- uma referência. A paridade (mesmo conjunto de tipos, mesmo veredito de escopo)
-- é cobrada em `tests/invariants/green-mutation-context.test.ts` (S16), contra a
-- própria função canônica: se o upstream mudar a regra, o teste fica vermelho.
create or replace function green.fn_assert_event_origin_contact(p_org uuid, p_event uuid, p_contact uuid)
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  e        record;
  v_root   uuid := p_event;
  v_seen   uuid[] := array[]::uuid[];
  v_entity uuid;
  v_origin jsonb;
begin
  loop
    if v_root = any(v_seen) or cardinality(v_seen) >= 32 then
      raise exception 'green_service_origin_cycle' using errcode = '23503';
    end if;
    v_seen := array_append(v_seen, v_root);
    v_entity := null;
    select ev.event_type, ev.entity_kind, ev.entity_id, ev.payload into e
      from public.event_log ev where ev.organization_id = p_org and ev.id = v_root;
    if not found then
      raise exception 'green_service_origin_event_not_found' using errcode = '23503';
    end if;
    if e.event_type in ('lead.created','lead.stage_changed','lead.tag_added') and e.entity_kind = 'crm_lead' then
      select contact_id into v_entity from public.crm_leads where organization_id = p_org and id = e.entity_id;
    elsif e.event_type = 'contact.tag_added' and e.entity_kind = 'contact' then
      select id into v_entity from public.contacts where organization_id = p_org and id = e.entity_id;
    elsif e.event_type = 'appointment.outcome_confirmed' and e.entity_kind = 'appointment' then
      select contact_id into v_entity from public.calendar_appointments
       where organization_id = p_org and id = e.entity_id
         and revision = (e.payload ->> 'appointment_revision')::bigint
         and status = 'no_show' and outcome_recorded_at is not null;
    elsif e.event_type = 'message.received' and e.entity_kind = 'message' then
      select contact_id into v_entity from public.messages
       where organization_id = p_org and id = e.entity_id and direction = 'inbound';
    else
      -- a regra canônica também não ancora este tipo (`service_event_origin_unsupported`)
      raise exception 'green_service_origin_unsupported' using errcode = '23503';
    end if;
    if v_entity is distinct from p_contact or not exists (
         select 1 from public.contacts
          where organization_id = p_org and id = p_contact
            and not is_anonymized and is_merged_into is null) then
      raise exception 'green_service_origin_contact_mismatch' using errcode = '23503';
    end if;
    v_origin := e.payload -> 'service_origin';
    if v_origin ->> 'kind' = 'event' then
      if v_origin ->> 'organization_id' is distinct from p_org::text
         or v_origin ->> 'contact_id' is distinct from p_contact::text then
        raise exception 'green_service_origin_contact_mismatch' using errcode = '23503';
      end if;
      v_root := (v_origin ->> 'event_id')::uuid;
      if v_root is null then
        raise exception 'green_service_origin_event_not_found' using errcode = '23503';
      end if;
      continue;
    end if;
    exit;
  end loop;
end $$;
revoke all on function green.fn_assert_event_origin_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function green.fn_assert_event_origin_contact(uuid, uuid, uuid) to service_role;

-- ── service_origin transportada tem de bater com o lead e com a fronteira vigente
create or replace function green.fn_assert_service_origin(p_origin jsonb, p_org uuid, p_contact uuid)
returns void
language plpgsql stable
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
    -- v2: o evento tem de ser DO contato declarado (não basta existir na org)
    perform green.fn_assert_event_origin_contact(p_org, (p_origin ->> 'event_id')::uuid, p_contact);
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
revoke all on function green.fn_assert_service_origin(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function green.fn_assert_service_origin(jsonb, uuid, uuid) to service_role;

-- ── hook BEFORE: guarda Green de crm_leads ──────────────────────────────────
create or replace function green.fn_guard_crm_lead_stage()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ctx jsonb;
begin
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
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ctx     jsonb;
  v_meta    jsonb;
  v_payload jsonb;
  v_ledger  uuid;
  v_event   uuid;
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

  -- Prova de produtor (v2): a linha do livro-razão só pode ser escrita aqui
  -- (dono); o GUC de uso único aponta para ELA, na MESMA transação. O porteiro
  -- de event_log só aceita a marca canônica se os dois baterem e carimba
  -- `canonical_event_id` — um `emit_event` chamado por fora não tem linha.
  insert into green.stage_event_ledger (organization_id, lead_id, from_stage_id, to_stage_id, request_id)
  values (new.organization_id, new.id, old.stage_id, new.stage_id, v_ctx ->> 'request_id')
  returning id into v_ledger;
  perform set_config('green.canonical_proof', v_ledger::text, true);
  -- Erro aqui NÃO é capturado: evento falha ⇒ UPDATE inteiro faz rollback.
  v_event := public.emit_event('lead.stage_changed', 'crm_lead', new.id, v_payload, v_meta, new.organization_id);
  perform set_config('green.canonical_proof', '', true);
  if not exists (select 1 from green.stage_event_ledger l
                  where l.id = v_ledger and l.canonical_event_id = v_event) then
    raise exception 'green_canonical_not_recorded' using errcode = 'P0001';
  end if;
  return null;
end $$;

-- ── hook em event_log: porteiro da marca canônica + supressor do gêmeo legado ─
create or replace function green.fn_suppress_legacy_stage_changed()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_proof uuid;
  v_hit   uuid;
begin
  -- (0) a marca canônica é imutável depois de nascer — nem service_role a
  --     acrescenta a um evento existente, nem a retira de um canônico.
  if tg_op = 'UPDATE' then
    if (old.metadata -> 'green_canonical') is distinct from (new.metadata -> 'green_canonical')
       or (old.metadata -> 'green_context_version') is distinct from (new.metadata -> 'green_context_version') then
      raise exception 'green_canonical_immutable' using errcode = '42501';
    end if;
    return new;
  end if;

  -- (a) marca reservada ao produtor: só passa com a prova da MESMA transação,
  --     de uso único, amarrada a este lead e a esta transição.
  if new.metadata ?| array['green_canonical', 'green_context_version'] then
    begin
      v_proof := nullif(current_setting('green.canonical_proof', true), '')::uuid;
    exception when others then
      v_proof := null;
    end;
    if v_proof is not null and new.event_type = 'lead.stage_changed' and new.entity_kind = 'crm_lead' then
      update green.stage_event_ledger l
         set canonical_event_id = new.id
       where l.id = v_proof
         and l.txid = txid_current()
         and l.canonical_event_id is null
         and l.organization_id = new.organization_id
         and l.lead_id = new.entity_id
         and l.to_stage_id::text = new.payload ->> 'to_stage_id'
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

  -- (b) gêmeo legado: suprimido SÓ quando corresponde a uma mutação já
  --     canonizada — mesmo lead, mesma transição, gêmeo ainda não visto, janela
  --     curta. Lead não-Green nunca tem linha no livro-razão ⇒ passa intacto.
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
        and c.canonical_event_id is not null
        and c.legacy_suppressed_at is null
        and c.to_stage_id::text = new.payload ->> 'to_stage_id'
        and (not (new.payload ? 'from_stage_id')
             or c.from_stage_id::text is not distinct from new.payload ->> 'from_stage_id')
        and c.created_at > clock_timestamp() - interval '5 minutes'
      -- o MESMO request (quando os dois o têm) primeiro; depois o mais recente
      order by (c.request_id is not null and c.request_id = new.metadata ->> 'request_id') desc,
               c.created_at desc
      limit 1
      for update skip locked)
  returning l.id into v_hit;
  if v_hit is not null then return null; end if;
  return new;
end $$;

-- Funções de trigger não passam por EXECUTE na hora de disparar (o Postgres só
-- confere no CREATE TRIGGER) e não podem ser chamadas fora de trigger. Nenhum
-- grant a authenticated/anon (v2): ninguém além do dono precisa delas.
revoke all on function green.fn_guard_crm_lead_stage() from public, anon, authenticated;
revoke all on function green.fn_emit_crm_lead_stage_changed() from public, anon, authenticated;
revoke all on function green.fn_suppress_legacy_stage_changed() from public, anon, authenticated;
grant execute on function green.fn_guard_crm_lead_stage() to service_role;
grant execute on function green.fn_emit_crm_lead_stage_changed() to service_role;
grant execute on function green.fn_suppress_legacy_stage_changed() to service_role;

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

drop trigger if exists trg_green_canonical_mark_immutable on public.event_log;
create trigger trg_green_canonical_mark_immutable
  before update on public.event_log
  for each row when (old.metadata is distinct from new.metadata)
  execute function green.fn_suppress_legacy_stage_changed();

notify pgrst, 'reload schema';
