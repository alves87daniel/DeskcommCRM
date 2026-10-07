-- 0509 (GREEN-CRM-02): catálogo de produtos Green + produto principal da oportunidade.
--
-- Primeira evolução de PRODUTO depois da GREEN-BASELINE-1.0 (0501-0508 ficam intactas).
-- Decisões canônicas (docs/green/product/GREEN-CRM-01-PRODUCT-FOUNDATION.md, seção 17):
-- FUNIL != PRODUTO, PRODUTO != TAG, CONTATO != OPORTUNIDADE. `crm_leads` é a oportunidade;
-- o funil é o processo; o produto é um item estruturado do catálogo.
--
-- ── 1. public.green_products: catálogo aberto, por organização
--   `code` estável (único por organização, imutável), `family` aberta (só a FORMA é conferida:
--   nenhuma lista `energy`/`license` no banco), `is_active` (inativar preserva o histórico). O
--   catálogo NÃO é semeado aqui e NÃO tem relação com funil: nenhuma coluna/tabela liga produto a
--   pipeline, e `green.product_pipeline_binding.product_key` (chave histórica de PROCESSO) não
--   ganha FK para cá, em nenhum sentido.
--
-- ── 2. public.green_lead_context: extensão 1:1 da oportunidade
--   `product_id` é o produto principal (obrigatório). Nada de tag, origem, UTM, campanha, lista de
--   produtos adicionais, região ou vínculo de expansão: cada um tem (ou terá) fronteira própria.
--   Evoluível para "principal + adicionais" sem migrar linha existente (tabela filha aditiva).
--
-- ── 3. Tenant provado pela ESTRUTURA (nem service_role fabrica incoerência)
--   (lead_id, organization_id)    -> crm_leads     (id, organization_id)  ON DELETE CASCADE
--   (product_id, organization_id) -> green_products (id, organization_id) NO ACTION
--   NO ACTION (e não RESTRICT) para a exclusão da organização cascatear contexto e produto no
--   mesmo comando; fora disso, produto usado não é apagado (23503). Mesma recusa para lead/produto
--   de outra organização e para lead/produto inexistente (sem oracle de existência).
--
-- ── 4. Regras no banco (trigger BEFORE em green_lead_context, vale para todo papel)
--   * elegibilidade: só lead de funil com binding Green (reuso de green.fn_is_green_pipeline;
--     nenhuma flag `is_green` nova)                                 -> green_context_outside_binding
--   * produto inativo não entra em nova associação                  -> green_product_inactive
--   * oportunidade won/lost não recebe nem troca de produto (a dimensão de métrica não é
--     reescrita retroativamente; reaberta, volta a ser editável. Correção administrativa
--     explícita fica para uma operação futura)                      -> green_context_lead_closed
--   * lead_id/organization_id do contexto e code/organization do produto são imutáveis
--   A leitura de oportunidade histórica com produto inativo não passa por nenhuma regra acima:
--   as regras olham a MUDANÇA de product_id, nunca o estado do produto já associado.
--
-- ── 5. Evento canônico (um produtor: o banco, na transação)
--   `lead.green_context_changed` via fn_log_event, só quando o produto muda:
--   `change = product_assigned` (primeira atribuição) | `product_changed` (troca, com
--   `previous_product_id`). Sem PII. É fato (registro): nasce `done` (fn_event_log_e_registro).
--   A API NÃO emite evento; ela só audita (api_audit_log).
--
-- ── 6. RLS
--   produtos: leitura por membro da organização; escrita manager+; sem DELETE para authenticated.
--   contexto: leitura/escrita seguem o lead (a subconsulta em crm_leads passa pela RLS do
--   chamador, logo a visibilidade do lead vale); escrita exige papel >= agent; sem DELETE.
--
-- ── 7. fn_green_lead_eligible(lead) -> boolean
--   Leitura para a API/UI saberem se a seção Green se aplica. Só devolve true para lead que o
--   chamador enxerga; lead inexistente, de outra organização ou invisível = false.

create unique index if not exists uniq_crm_leads_id_org
  on public.crm_leads (id, organization_id);

-- ── 1 · catálogo ─────────────────────────────────────────────────────────────
create table if not exists public.green_products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code            text not null,
  name            text not null,
  description     text,
  family          text not null default 'generic',
  is_active       boolean not null default true,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint green_products_org_code_key unique (organization_id, code),
  constraint green_products_id_org_key unique (id, organization_id),
  constraint green_products_code_format check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint green_products_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint green_products_description_length check (description is null or char_length(description) <= 1000),
  constraint green_products_family_format check (family ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint green_products_metadata_object check (jsonb_typeof(metadata) = 'object')
);
comment on table public.green_products is
  'GREEN-CRM-02: catálogo aberto de produtos Green, por organização. Independente de funil e de tag.';
comment on column public.green_products.code is
  'Identificador estável (único por organização, imutável). Referência de semente, relatório e expansão.';
comment on column public.green_products.family is
  'Seletor aberto do schema de atributos futuro. NÃO limita quantos produtos existem e NÃO é tipo de funil.';
comment on column public.green_products.is_active is
  'Inativo continua existindo (histórico) mas não é atribuível a nova associação.';

-- ── 2 · contexto 1:1 da oportunidade ─────────────────────────────────────────
create table if not exists public.green_lead_context (
  lead_id         uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id      uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint green_lead_context_lead_fkey
    foreign key (lead_id, organization_id)
    references public.crm_leads (id, organization_id) on delete cascade,
  constraint green_lead_context_product_fkey
    foreign key (product_id, organization_id)
    references public.green_products (id, organization_id)
);
comment on table public.green_lead_context is
  'GREEN-CRM-02: extensão 1:1 da oportunidade (crm_leads) Green. Hoje só o produto principal.';
comment on column public.green_lead_context.product_id is
  'Produto principal da oportunidade. Muda só com a oportunidade aberta; evento lead.green_context_changed.';
create index if not exists idx_green_lead_context_product
  on public.green_lead_context (organization_id, product_id);

-- ── 3 · regras (funções no schema green: não são RPC, não entram em public) ──
create or replace function green.fn_green_products_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.code is distinct from old.code
     or new.organization_id is distinct from old.organization_id then
    raise exception 'green_product_identity_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function green.fn_green_products_guard() from public, anon, authenticated;
grant execute on function green.fn_green_products_guard() to service_role;

drop trigger if exists trg_green_products_guard on public.green_products;
create trigger trg_green_products_guard
  before update on public.green_products
  for each row execute function green.fn_green_products_guard();

create or replace function green.fn_green_lead_context_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pipeline uuid;
  v_status   text;
  v_active   boolean;
begin
  if tg_op = 'UPDATE'
     and (new.lead_id is distinct from old.lead_id
          or new.organization_id is distinct from old.organization_id) then
    raise exception 'green_context_identity_immutable' using errcode = '23514';
  end if;

  -- só a MUDANÇA de produto passa pelas regras: tocar o contexto de uma oportunidade
  -- histórica (produto inativo, oportunidade fechada) não é nova associação
  if tg_op = 'INSERT' or new.product_id is distinct from old.product_id then
    -- SHARE no lead: um fechamento concorrente espera este commit (e vice-versa)
    select l.pipeline_id, l.status into v_pipeline, v_status
      from public.crm_leads l
     where l.id = new.lead_id and l.organization_id = new.organization_id
       for share;
    if not found then
      return new; -- a FK composta responde (mesma recusa para ausente e para outra organização)
    end if;

    if not green.fn_is_green_pipeline(new.organization_id, v_pipeline) then
      raise exception 'green_context_outside_binding' using errcode = '23514';
    end if;
    if v_status in ('won', 'lost') then
      raise exception 'green_context_lead_closed' using errcode = '23514';
    end if;

    select p.is_active into v_active
      from public.green_products p
     where p.id = new.product_id and p.organization_id = new.organization_id
       for share;
    if found and not v_active then
      raise exception 'green_product_inactive' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function green.fn_green_lead_context_guard() from public, anon, authenticated;
grant execute on function green.fn_green_lead_context_guard() to service_role;

drop trigger if exists trg_green_lead_context_guard on public.green_lead_context;
create trigger trg_green_lead_context_guard
  before insert or update on public.green_lead_context
  for each row execute function green.fn_green_lead_context_guard();

-- ── 4 · evento canônico (único produtor: o banco, na transação) ─────────────
create or replace function green.fn_green_lead_context_emit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.fn_log_event(
      new.organization_id, 'lead.green_context_changed',
      jsonb_build_object('lead_id', new.lead_id, 'change', 'product_assigned',
                         'product_id', new.product_id, 'previous_product_id', null,
                         'changed_by', auth.uid()));
  elsif new.product_id is distinct from old.product_id then
    perform public.fn_log_event(
      new.organization_id, 'lead.green_context_changed',
      jsonb_build_object('lead_id', new.lead_id, 'change', 'product_changed',
                         'product_id', new.product_id, 'previous_product_id', old.product_id,
                         'changed_by', auth.uid()));
  end if;
  return new;
end $$;
revoke all on function green.fn_green_lead_context_emit() from public, anon, authenticated;
grant execute on function green.fn_green_lead_context_emit() to service_role;

drop trigger if exists trg_green_lead_context_emit on public.green_lead_context;
create trigger trg_green_lead_context_emit
  after insert or update on public.green_lead_context
  for each row execute function green.fn_green_lead_context_emit();

-- O fato nasce `done` (registro): mesma lista da 0503 + o tipo novo.
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
    -- GREEN-CRM-02: produto principal atribuído/alterado
    'lead.green_context_changed',
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

-- ── 5 · updated_at ───────────────────────────────────────────────────────────
drop trigger if exists trg_green_products_updated_at on public.green_products;
create trigger trg_green_products_updated_at
  before update on public.green_products
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_green_lead_context_updated_at on public.green_lead_context;
create trigger trg_green_lead_context_updated_at
  before update on public.green_lead_context
  for each row execute function public.fn_set_updated_at();

-- ── 6 · RLS e privilégios ────────────────────────────────────────────────────
alter table public.green_products enable row level security;
alter table public.green_lead_context enable row level security;

revoke all on public.green_products from anon, authenticated;
revoke all on public.green_lead_context from anon, authenticated;
grant select, insert, update on public.green_products to authenticated;
grant select, insert, update on public.green_lead_context to authenticated;

drop policy if exists green_products_select on public.green_products;
create policy green_products_select on public.green_products
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists green_products_insert on public.green_products;
create policy green_products_insert on public.green_products
  for insert to authenticated
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

drop policy if exists green_products_update on public.green_products;
create policy green_products_update on public.green_products
  for update to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- A subconsulta em crm_leads roda com a RLS do CHAMADOR: o contexto é visível/editável
-- exatamente quando o lead é visível (fn_can_view_lead); a escrita soma o piso `agent`.
drop policy if exists green_lead_context_select on public.green_lead_context;
create policy green_lead_context_select on public.green_lead_context
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.crm_leads l
       where l.id = green_lead_context.lead_id
         and l.organization_id = green_lead_context.organization_id)
  );

drop policy if exists green_lead_context_insert on public.green_lead_context;
create policy green_lead_context_insert on public.green_lead_context
  for insert to authenticated
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.crm_leads l
       where l.id = green_lead_context.lead_id
         and l.organization_id = green_lead_context.organization_id)
  );

drop policy if exists green_lead_context_update on public.green_lead_context;
create policy green_lead_context_update on public.green_lead_context
  for update to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.crm_leads l
       where l.id = green_lead_context.lead_id
         and l.organization_id = green_lead_context.organization_id)
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1 from public.crm_leads l
       where l.id = green_lead_context.lead_id
         and l.organization_id = green_lead_context.organization_id)
  );

-- ── 7 · elegibilidade para a API/UI ──────────────────────────────────────────
create or replace function public.fn_green_lead_eligible(p_lead uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.crm_leads l
     where l.id = p_lead
       and l.organization_id in (select public.fn_user_org_ids())
       and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
       and green.fn_is_green_pipeline(l.organization_id, l.pipeline_id)
  );
$$;
revoke execute on function public.fn_green_lead_eligible(uuid) from public, anon;
grant execute on function public.fn_green_lead_eligible(uuid) to authenticated, service_role;

-- as travas de suporte (somente leitura) cobrem toda tabela da organização (0274)
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
