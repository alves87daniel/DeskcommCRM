-- 0503 (SPIKE Green lifecycle — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-01: ciclo de vida da Opportunity Green — INSERT, DELETE e
-- lápide. Delta experimental SOBRE a 0502 (v3), que fica intacta.
--
-- ── 1. Nascimento Green deixa proveniência (EV-01B) ────────────────────────
-- A v3 já exigia contexto válido de writer privilegiado no INSERT, mas o
-- contexto era conferido e DESCARTADO: nada sobrava dizendo quem fez nascer a
-- Opportunity, com que origem. `green.lead_birth_provenance` guarda, na MESMA
-- transação do INSERT, o envelope trusted × advisory que a fronteira já monta.
-- NÃO é evento: um `lead.created` canônico seria gêmeo do `lead.created` que o
-- código já emite depois do insert (consumido por automação e follow-up), e
-- resolver gêmeo é o supressor — fora desta spike. Tabela própria, e não o
-- livro-razão de etapa, porque o livro-razão é a prova de produtor do evento
-- canônico; nascimento não tem evento.
--
-- ── 2. A lápide `lead.deleted` é REGISTRO (L3) ──────────────────────────────
-- Derivado do desenho do `event_log` (migration 0239, issue #753): `pending` é
-- fila — o drain reivindica `pending` ∩ tipos com handler —, e tipo-fato sem
-- consumidor nasce `done`. A lápide é fato consumado (o DELETE já aconteceu na
-- mesma transação), não tem consumidor e não pode ter reprocessamento pela
-- fila. Ela entra na lista do banco (`fn_event_log_e_registro`), que é o
-- mecanismo que o upstream construiu para isto — não um status escolhido pelo
-- produtor Green. A emissão passa a usar o tipo LITERAL para a cerca
-- `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` enxergá-la (com o tipo
-- numa variável, a cerca era cega para a lápide). O estoque `pending` da v3 é
-- fechado pelo backfill, como na 0239.
--
-- ── 3. Resíduo e rastro da cascata de organização ──────────────────────────
-- O livro-razão é tenant-aware e nasceu sem FK: apagar a organização deixava
-- linhas órfãs (contrário à doutrina do repo: `organization_id ... on delete
-- cascade` em toda tabela tenant-aware). Ganha a FK. E a remoção de um funil
-- gerenciado (cascata da organização, ou do funil) passa a deixar UMA linha em
-- `api_audit_log` (append-only, sobrevive ao tenant com `organization_id`
-- nulo), sem PII: organização, funil, produto, quem e por qual papel.
--
-- ── 4. Zona de perigo em UMA transação (L2) ─────────────────────────────────
-- `fn_apagar_dados_operacionais_da_org` faz os sete DELETE da rotina numa
-- transação só: com lead Green e sem contexto, a recusa da fronteira desfaz
-- TUDO (antes: mensagens, conversas, agenda, pedidos e propostas já tinham
-- ido). Precedente do próprio upstream para a mesma classe:
-- `fn_apagar_contato_com_historico` (0488, #752). SECURITY INVOKER e EXECUTE
-- só para `service_role` — não é porta nova (quem a executa já podia cada
-- DELETE), é atomicidade. O header Green da request RPC chega à fronteira.

-- ── 1 · livro-razão: FK de tenant ───────────────────────────────────────────
delete from green.stage_event_ledger l
 where not exists (select 1 from public.organizations o where o.id = l.organization_id);
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'stage_event_ledger_organization_id_fkey'
       and conrelid = 'green.stage_event_ledger'::regclass
  ) then
    alter table green.stage_event_ledger
      add constraint stage_event_ledger_organization_id_fkey
      foreign key (organization_id) references public.organizations(id) on delete cascade;
  end if;
end $$;

-- ── 1 · registro de nascimento ──────────────────────────────────────────────
create table if not exists green.lead_birth_provenance (
  lead_id         uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id     uuid not null,
  stage_id        uuid not null,
  caller          text not null,
  trusted         jsonb not null,
  advisory        jsonb not null default '{}'::jsonb,
  service_origin  jsonb,
  txid            bigint not null default txid_current(),
  created_at      timestamptz not null default now()
);
comment on table green.lead_birth_provenance is
  'SPIKE Green lifecycle: proveniência do nascimento de uma Opportunity Green (envelope trusted × advisory da fronteira), gravada pelo trigger na transação do INSERT. Sem FK para o lead: sobrevive à exclusão como histórico; morre com a organização.';
alter table green.lead_birth_provenance enable row level security;
revoke all on green.lead_birth_provenance from public, anon, authenticated, service_role;
grant select on green.lead_birth_provenance to service_role;

-- ── a fronteira (v3) com nascimento registrado e tipos literais ────────────
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
  v_kind    text;
  v_ledger  uuid;
  v_event   uuid;
begin
  if tg_op = 'UPDATE'
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
  end if;
  if tg_op <> 'DELETE' then
    v_new_p := green.fn_is_green_pipeline(new.organization_id, new.pipeline_id);
    v_toca := v_toca or v_new_p
              or green.fn_lead_touches_green(new.organization_id, new.pipeline_id, new.stage_id);
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
     v_trusted ->> 'request_id', v_env -> 'advisory' ->> 'request_id')
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

-- ── 2 · a lápide é registro (mesma lista da 0417 + `lead.deleted`) ──────────
create or replace function public.fn_event_log_e_registro(p_event_type text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_event_type = any (array[
    -- IA e agente
    'ai.responded',
    'ai_agent.created',
    'ai_agent.published',
    'ai_agent.run_completed',
    'ai_agent.run_failed',
    'ai_agent.run_started',
    -- agente (harness) — o motor registra quando não há negócio para pendurar
    'agent.activity_unrouted',
    -- canal e conversa
    'channel_session.status_changed',
    'conversation.claimed',
    'conversation.transferred',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed',
    -- contato, lead, organização e plataforma
    'contact.anonymized',
    'contact.created',
    'contact.deleted',
    'contact.updated',
    'crm.activity_write_failed',
    'incident.resolved',
    'lead.bulk_assigned',
    'lead.bulk_deleted',
    'lead.bulk_tagged',
    -- SPIKE Green lifecycle: a lápide canônica da Opportunity Green
    'lead.deleted',
    'lead.reopened',
    'lead.risk_backlog_seeded',
    'lead.updated',
    'org.updated',
    'tenant.onboarded',
    'tenant.reactivated',
    'tenant.suspended',
    'user.profile_updated',
    -- mensagem ('message.failed' saiu aqui na 0417: ele ganhou consumidor)
    'message.outbound',
    'message.sending',
    'message.sent',
    -- LGPD
    'lgpd.export_delivered',
    'lgpd.export_generated',
    'lgpd.redact_applied',
    'lgpd.redact_failed'
  ]::text[]);
$$;
revoke all on function public.fn_event_log_e_registro(text) from public, anon;
grant execute on function public.fn_event_log_e_registro(text) to authenticated, service_role;

-- O estoque: lápides que a v3 deixou `pending`. Só o status (o guard do
-- canônico deixa os campos do consumer mudarem); conteúdo intocado.
update public.event_log
   set status = 'done', updated_at = now()
 where status = 'pending'
   and event_type = 'lead.deleted';

-- ── 3 · funil gerenciado removido deixa rastro auditável ────────────────────
create or replace function green.fn_binding_removed_audit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_env         jsonb := green.fn_mutation_envelope();
  v_org_deleted boolean := not exists (select 1 from public.organizations o where o.id = old.organization_id);
begin
  -- `organization_id` nulo quando o tenant está indo embora: a FK de
  -- `api_audit_log` não aceitaria uma org que já não existe, e é justamente
  -- esta linha que tem de sobreviver a ela. O id fica no metadata.
  insert into public.api_audit_log
    (organization_id, actor_user_id, acting_as_platform_admin, action, resource_type, resource_id,
     bypassed_rls, metadata)
  values
    (case when v_org_deleted then null else old.organization_id end,
     auth.uid(),
     coalesce(public.fn_is_platform_admin(), false),
     'green.binding_removed', 'crm_pipeline', old.pipeline_id,
     coalesce(v_env ->> 'caller', '') <> 'user',
     jsonb_build_object(
       'organization_id', old.organization_id,
       'pipeline_id',     old.pipeline_id,
       'product_key',     old.product_key,
       'org_deleted',     v_org_deleted,
       'caller',          v_env ->> 'caller',
       'trusted',         v_env -> 'trusted'));
  return null;
end $$;
revoke all on function green.fn_binding_removed_audit() from public, anon, authenticated;
grant execute on function green.fn_binding_removed_audit() to service_role;

drop trigger if exists trg_green_binding_removed_audit on green.product_pipeline_binding;
create trigger trg_green_binding_removed_audit
  after delete on green.product_pipeline_binding
  for each row execute function green.fn_binding_removed_audit();

-- ── 4 · zona de perigo numa transação só ────────────────────────────────────
-- Mesma ordem de `RAIZES_DO_APAGAMENTO` (lib/settings/apagar-dados-operacionais.ts):
-- quem tem FK RESTRICT para `contacts` sai antes dele. Todo DELETE filtra a
-- organização recebida — quem chama a resolve da sessão, nunca do corpo.
create or replace function public.fn_apagar_dados_operacionais_da_org(p_org uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_contagens jsonb := '{}'::jsonb;
  v_n bigint;
begin
  if p_org is null then
    raise exception 'organization_required' using errcode = '22023';
  end if;

  delete from public.messages where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('messages', v_n);

  delete from public.conversations where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('conversations', v_n);

  delete from public.calendar_appointments where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('calendar_appointments', v_n);

  delete from public.orders where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('orders', v_n);

  delete from public.crm_proposals where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('crm_proposals', v_n);

  -- Opportunity Green: a fronteira exige o contexto da request e deixa a
  -- lápide; sem contexto, a recusa desfaz os cinco DELETE acima também.
  delete from public.crm_leads where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('crm_leads', v_n);

  delete from public.contacts where organization_id = p_org;
  get diagnostics v_n = row_count;
  v_contagens := v_contagens || jsonb_build_object('contacts', v_n);

  return v_contagens;
end $$;
revoke all on function public.fn_apagar_dados_operacionais_da_org(uuid) from public, anon, authenticated;
grant execute on function public.fn_apagar_dados_operacionais_da_org(uuid) to service_role;

notify pgrst, 'reload schema';
