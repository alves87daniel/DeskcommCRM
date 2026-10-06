-- 0506 (SPIKE Green automation origin v1 — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-AUTO-01: fecha o LIFE-ADV-01. Delta experimental SOBRE a 0505, que fica
-- intacta junto com 0501, 0502, 0503 e 0504.
--
-- ── O defeito (medido) ────────────────────────────────────────────────────────────
-- O motor de automação declarava `service_origin.kind=event` com o evento disparador, e
-- `green.fn_assert_event_origin_contact` (projeção da régua de ATENDIMENTO,
-- `fn_service_event_origin`) só ancora 6 tipos. Dos 16 gatilhos do produto, 11 eram
-- recusados com `green_service_origin_unsupported` (os 4 de relógio, `message.failed` e os
-- 6 `appointment.*`): a execução ficava `failed` e o lead não se movia. A régua de
-- atendimento responde "de que atendimento é este evento"; a pergunta da automação é
-- outra: "esta regra, desta organização, está executando por causa desta ocorrência".
--
-- ── O contrato: origem `automation` ───────────────────────────────────────────────
-- service_origin = { kind:'automation', rule_id, event_id, organization_id }, declarada SÓ
-- pelo motor (`lib/automation/engine.ts`) em toda execução de regra. Todo gatilho chega ao
-- motor como uma linha de `event_log` (o motor é consumidor do event_log); o que muda
-- entre as famílias é QUEM pode ter produzido a linha:
--   * família `event` (12 gatilhos): a linha registra uma ocorrência de domínio, e há
--     produtores legítimos com sessão humana (agenda pela tela, mover pela rota, falha de
--     envio pelo cookie, trigger de cliente pela agenda) — qualquer emissor é aceito;
--   * família `scheduler` (4 gatilhos de relógio): a linha é a materialização de uma
--     decisão do relógio (cron com o client de serviço). Uma sessão que emite o mesmo
--     tipo não é o relógio: a raiz é recusada.
-- A família é DERIVADA pelo banco a partir do tipo, nunca declarada: não existe
-- "origem de relógio declarada à mão".
--
-- A fronteira só aceita a escrita privilegiada com origem `automation` se provar, contra o
-- banco e na transação da escrita:
--   1. organização da origem = organização do lead;
--   2. os marcadores confiáveis são os da regra: source=automation,
--      request_id=rule:<rule_id>, causation_event_id=<event_id>,
--      actor={webhook_source, rule_id} e correlation_id (quando houver) = a correlação
--      confiável do evento raiz ou o próprio evento (a mesma que o dispatcher herda);
--   3. a regra existe NESTA organização, está ativa e tem ação que escreve em Opportunity
--      (`create_or_move_lead`);
--   4. o evento existe NESTA organização (regra/evento de outra org ≡ inexistente: mesma
--      resposta, sem oracle);
--   5. o tipo do evento é o gatilho da regra, é um gatilho do produto, traz a entidade
--      esperada e, se for dirigido (`payload.rule_id`), é dirigido a ESTA regra;
--   6. família `scheduler`: o carimbo do relógio diz que o servidor emitiu o evento;
--   7. o evento está vivo (`pending`/`processing`): replay de execução já drenada é
--      recusado;
--   8. o alvo é o sujeito do evento: o próprio lead (entidade `crm_lead`) ou um lead do
--      contato do evento (contato, mensagem, compromisso), contato ativo.
-- Nenhum event_log é inventado: a raiz é sempre a linha real que o motor consumiu.
--
-- ── Carimbo do relógio ────────────────────────────────────────────────────────────
-- `green.scheduler_trigger_emission`: uma linha por evento de relógio, gravada pelo
-- trigger AFTER INSERT de `event_log` com QUEM emitiu (mesma classificação de caller do
-- `fn_mutation_context`: user + uid, service_role, direct, anonymous). Ninguém da API
-- escreve nela (nem service_role); só o produtor. O `emit_event` continua aceitando o tipo
-- de qualquer membro (comportamento upstream intacto para lead comum); o carimbo só decide
-- a fronteira Green.
--
-- ── O que muda nas funções da cadeia ──────────────────────────────────────────────
-- `fn_mutation_context` (cópia da 0504 + o ramo `automation`), `fn_crm_lead_boundary`
-- (cópia da 0505; UMA linha: a chamada da prova passa também o id do lead e o trusted),
-- overload `fn_assert_service_origin(jsonb, uuid, uuid, uuid, jsonb)` que despacha
-- `automation` e delega `event`/`continuation` à de 3 argumentos (intacta).

-- ── 1 · régua dos gatilhos de automação (espelho de lib/schemas/webhooks.ts) ──────
-- A catraca `tests/invariants/green-automation-origin.test.ts` (K1/K2) cobra que estas
-- funções e o WHEN do carimbo concordem com `ENTIDADE_ESPERADA_POR_GATILHO`.
create or replace function green.fn_automation_trigger_entity(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case p_type
    when 'lead.created'            then 'crm_lead'
    when 'lead.stage_changed'      then 'crm_lead'
    when 'lead.tag_added'          then 'crm_lead'
    when 'lead.date_field_due'     then 'crm_lead'
    when 'lead.silent_for'         then 'crm_lead'
    when 'lead.stage_stale'        then 'crm_lead'
    when 'message.received'        then 'message'
    when 'message.failed'          then 'message'
    when 'contact.tag_added'       then 'contact'
    when 'contact.birthday'        then 'contact'
    when 'appointment.created'     then 'calendar_appointment'
    when 'appointment.confirmed'   then 'calendar_appointment'
    when 'appointment.rescheduled' then 'calendar_appointment'
    when 'appointment.cancelled'   then 'calendar_appointment'
    when 'appointment.completed'   then 'calendar_appointment'
    when 'appointment.no_show'     then 'calendar_appointment'
  end
$$;
create or replace function green.fn_automation_trigger_family(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_type in ('contact.birthday','lead.date_field_due','lead.silent_for','lead.stage_stale') then 'scheduler'
    when green.fn_automation_trigger_entity(p_type) is not null then 'event'
  end
$$;
revoke all on function green.fn_automation_trigger_entity(text) from public, anon, authenticated;
revoke all on function green.fn_automation_trigger_family(text) from public, anon, authenticated;
grant execute on function green.fn_automation_trigger_entity(text) to service_role;
grant execute on function green.fn_automation_trigger_family(text) to service_role;

-- ── 2 · carimbo do relógio ───────────────────────────────────────────────────────
create table if not exists green.scheduler_trigger_emission (
  event_id        uuid primary key references public.event_log(id) on delete cascade,
  organization_id uuid not null,
  event_type      text not null,
  caller          text not null check (caller in ('user','service_role','direct','anonymous')),
  user_id         uuid,
  created_at      timestamptz not null default now(),
  constraint scheduler_trigger_emission_usuario_coerente check ((caller = 'user') = (user_id is not null))
);
comment on table green.scheduler_trigger_emission is
  'SPIKE Green automation origin v1: quem emitiu cada evento de gatilho de relógio (contact.birthday, lead.date_field_due, lead.silent_for, lead.stage_stale). Gravada só pelo trigger AFTER INSERT de event_log. A fronteira Green só aceita a raiz de relógio emitida pelo servidor (service_role/direct).';
alter table green.scheduler_trigger_emission enable row level security;
revoke all on green.scheduler_trigger_emission from public, anon, authenticated, service_role;
grant select on green.scheduler_trigger_emission to service_role;

create or replace function green.fn_stamp_scheduler_trigger()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid;
  v_jwt_role text;
  v_role     text;
  v_caller   text;
begin
  -- Mesma classificação do `fn_mutation_context`: o papel da REQUEST (claim/GUC `role`),
  -- não `current_user` — dentro de `emit_event` (definer) o current_user é o dono.
  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null;
  end;
  begin
    v_jwt_role := coalesce(auth.jwt() ->> 'role', '');
  exception when others then
    v_jwt_role := '';
  end;
  v_role := coalesce(nullif(v_jwt_role, ''), nullif(current_setting('role', true), 'none'), '');
  v_caller := case
    when v_uid is not null then 'user'
    when v_role = 'service_role' then 'service_role'
    when v_role in ('anon', 'authenticated') then 'anonymous'
    else 'direct'
  end;
  insert into green.scheduler_trigger_emission (event_id, organization_id, event_type, caller, user_id)
  values (new.id, new.organization_id, new.event_type, v_caller, v_uid);
  return null;
end $$;
revoke all on function green.fn_stamp_scheduler_trigger() from public, anon, authenticated, service_role;

drop trigger if exists trg_green_stamp_scheduler_trigger on public.event_log;
create trigger trg_green_stamp_scheduler_trigger
  after insert on public.event_log
  for each row
  when (new.event_type in ('contact.birthday','lead.date_field_due','lead.silent_for','lead.stage_stale'))
  execute function green.fn_stamp_scheduler_trigger();

-- ── 3 · contexto: o kind `automation` (cópia da 0504 com um ramo a mais) ──────────
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
    elsif v_kind = 'automation' then
      -- SPIKE-GREEN-AUTO-01: origem do motor de automação (regra + evento). Aqui só a forma;
      -- a prova contra o banco é da fronteira (`green.fn_assert_automation_origin`).
      if exists (select 1 from jsonb_object_keys(v_origin) k where k not in ('kind','rule_id','event_id','organization_id'))
         or v_origin ->> 'rule_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'rule_id')
         or v_origin ->> 'event_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'event_id')
         or v_origin ->> 'organization_id' is null or not green.fn_ctx_uuid_ok(v_origin ->> 'organization_id') then
        v_reason := 'service_origin_automation';
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

-- ── 4 · a prova da origem de automação ───────────────────────────────────────────
-- Ordem fixa das verificações (cada recusa tem UMA causa); todas as leituras filtram a
-- organização do lead, então nada de outra organização é consultado como existente.
create or replace function green.fn_assert_automation_origin(
  p_origin jsonb, p_trusted jsonb, p_org uuid, p_lead uuid, p_contact uuid)
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  v_rule    uuid := (p_origin ->> 'rule_id')::uuid;
  v_event   uuid := (p_origin ->> 'event_id')::uuid;
  r         record;
  e         record;
  s         record;
  v_family  text;
  v_entity  text;
  v_raiz    jsonb;
  v_subject uuid;
begin
  -- 1. escopo
  if (p_origin ->> 'organization_id')::uuid is distinct from p_org then
    raise exception 'green_service_origin_scope_mismatch' using errcode = '23503';
  end if;

  -- 2. os marcadores confiáveis são os da regra (anti-loop e causa provados pela origem)
  if p_trusted ->> 'source' is distinct from 'automation'
     or p_trusted ->> 'request_id' is distinct from 'rule:' || v_rule::text
     or p_trusted ->> 'causation_event_id' is distinct from v_event::text
     or p_trusted -> 'actor' is distinct from jsonb_build_object('kind', 'webhook_source', 'id', v_rule::text) then
    raise exception 'green_automation_origin_incoherent' using errcode = '23503';
  end if;

  -- 3. a regra: desta organização, ativa, com ação que escreve em Opportunity
  select ar.trigger_event, ar.is_active, ar.actions into r
    from public.automation_rules ar
   where ar.organization_id = p_org and ar.id = v_rule;
  if not found or not r.is_active or not exists (
       select 1
         from jsonb_array_elements(case when jsonb_typeof(r.actions) = 'array' then r.actions else '[]'::jsonb end) a
        where a ->> 'type' = 'create_or_move_lead') then
    raise exception 'green_automation_rule_invalid' using errcode = '23503';
  end if;

  -- 4. o evento: desta organização
  select ev.event_type, ev.entity_kind, ev.entity_id, ev.payload, ev.metadata, ev.status into e
    from public.event_log ev
   where ev.organization_id = p_org and ev.id = v_event;
  if not found then
    raise exception 'green_automation_event_invalid' using errcode = '23503';
  end if;

  -- correlação: a confiável do evento raiz (canônico Green) ou o próprio evento — é o que
  -- o dispatcher herda (`provenienciaConfiavel(row.metadata)?.correlation_id ?? row.id`)
  if p_trusted ? 'correlation_id' then
    if e.metadata -> 'green_canonical' = 'true'::jsonb then
      v_raiz := case
        when jsonb_typeof(e.metadata -> 'green' -> 'trusted') = 'object' then e.metadata -> 'green' -> 'trusted'
        when e.metadata ->> 'caller' is distinct from 'user' then e.metadata
      end;
    end if;
    if p_trusted ->> 'correlation_id' is distinct from coalesce(v_raiz ->> 'correlation_id', v_event::text) then
      raise exception 'green_automation_origin_incoherent' using errcode = '23503';
    end if;
  end if;

  -- 5. o gatilho: o da regra, do produto, com a entidade esperada, dirigido a esta regra
  v_family := green.fn_automation_trigger_family(e.event_type);
  v_entity := green.fn_automation_trigger_entity(e.event_type);
  if e.event_type is distinct from r.trigger_event
     or v_family is null
     or e.entity_kind is distinct from v_entity
     or (e.payload ? 'rule_id' and e.payload ->> 'rule_id' is distinct from v_rule::text)
     or (e.event_type in ('lead.date_field_due','lead.silent_for','lead.stage_stale')
         and not (e.payload ? 'rule_id')) then
    raise exception 'green_automation_trigger_mismatch' using errcode = '23503';
  end if;

  -- 6. raiz de relógio: só o servidor é o relógio
  if v_family = 'scheduler' then
    select se.caller, se.event_type into s
      from green.scheduler_trigger_emission se
     where se.event_id = v_event and se.organization_id = p_org;
    if not found or s.caller not in ('service_role', 'direct') or s.event_type is distinct from e.event_type then
      raise exception 'green_automation_trigger_untrusted' using errcode = '23503';
    end if;
  end if;

  -- 7. execução viva: o evento ainda está na fila do motor
  if e.status not in ('pending', 'processing') then
    raise exception 'green_automation_event_stale' using errcode = '23503';
  end if;

  -- 8. o alvo é o sujeito do evento
  if v_entity = 'crm_lead' then
    if e.entity_id is distinct from p_lead then
      raise exception 'green_automation_subject_mismatch' using errcode = '23503';
    end if;
    return;
  end if;
  if v_entity = 'contact' then
    select c.id into v_subject from public.contacts c
     where c.organization_id = p_org and c.id = e.entity_id;
  elsif v_entity = 'message' then
    select m.contact_id into v_subject from public.messages m
     where m.organization_id = p_org and m.id = e.entity_id;
  elsif v_entity = 'calendar_appointment' then
    select a.contact_id into v_subject from public.calendar_appointments a
     where a.organization_id = p_org and a.id = e.entity_id;
  end if;
  if v_subject is null or v_subject is distinct from p_contact or not exists (
       select 1 from public.contacts c
        where c.organization_id = p_org and c.id = v_subject
          and not c.is_anonymized and c.is_merged_into is null) then
    raise exception 'green_automation_subject_mismatch' using errcode = '23503';
  end if;
end $$;
revoke all on function green.fn_assert_automation_origin(jsonb, jsonb, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function green.fn_assert_automation_origin(jsonb, jsonb, uuid, uuid, uuid) to service_role;

-- Overload da prova: `automation` aqui; `event`/`continuation`/null seguem na de 3
-- argumentos (0501, intacta).
create or replace function green.fn_assert_service_origin(
  p_origin jsonb, p_org uuid, p_contact uuid, p_lead uuid, p_trusted jsonb)
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_origin) = 'object' and p_origin ->> 'kind' = 'automation' then
    perform green.fn_assert_automation_origin(p_origin, coalesce(p_trusted, '{}'::jsonb), p_org, p_lead, p_contact);
    return;
  end if;
  perform green.fn_assert_service_origin(p_origin, p_org, p_contact);
end $$;
revoke all on function green.fn_assert_service_origin(jsonb, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function green.fn_assert_service_origin(jsonb, uuid, uuid, uuid, jsonb) to service_role;

-- ── 5 · fronteira: a prova recebe o lead e o trusted (cópia da 0505, uma linha) ────
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
