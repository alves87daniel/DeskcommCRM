-- 0507 (SPIKE Green structural boundary — DESCARTÁVEL; não é produto, não vai para produção).
--
-- SPIKE-GREEN-02: a fronteira de `crm_leads` (0502-0506) protege a mutação que entra, fica,
-- sai ou apaga um lead Green. Mas "o que é Green" também é decidido pela ESTRUTURA ao redor
-- do lead: funil, etapa, binding e organização. Na 0506, uma escrita estrutural mudava a
-- classificação de dezenas/milhares de leads sem tocar `crm_leads` (medido em
-- `tests/invariants/green-structural-boundary.test.ts`, 41 de 73 casos vermelhos na base).
-- Delta experimental SOBRE a 0506, que fica intacta junto com 0501-0505.
--
-- Contrato: nenhuma mutação estrutural faz um lead entrar, sair ou ficar em estado
-- estruturalmente inválido no domínio Green sem passar por uma regra explícita, atômica e
-- auditável. A proteção fica na estrutura, não nos writers (nenhum writer foi tocado).
--
-- ── 0. Estrutura impossível herdada: recusa explícita
-- Antes de qualquer mudança, a migration conta o que a base deixava gravar (etapa/binding/lead
-- apontando para estrutura de outra organização; lead Green com etapa fora do funil). Se
-- houver qualquer linha, ela PARA com `green_structural_legacy_violation` e as contagens (sem
-- PII) no detail. A transação desfaz tudo: o dono corrige os dados e reaplica.
--
-- ── 1. Tenant da estrutura por FK composta (constraint fortalecida, sem trigger)
-- As FKs simples de upstream deixavam etapa, binding e lead apontarem para funil/etapa de
-- OUTRA organização (a checagem de FK passa por cima da RLS). Elas são TROCADAS por FKs
-- compostas com `organization_id`, com o MESMO nome e a mesma ação de DELETE:
--   crm_stages (pipeline_id, organization_id)  → crm_pipelines (id, organization_id)  cascade
--   crm_leads  (pipeline_id, organization_id)  → crm_pipelines (id, organization_id)  restrict
--   crm_leads  (stage_id, organization_id)     → crm_stages    (id, organization_id)  restrict
--   green.product_pipeline_binding (pipeline_id, organization_id) → crm_pipelines     cascade
-- Mesmo nome porque o PostgREST embeda por nome de FK (`crm_stages!crm_leads_stage_id_fkey`,
-- `etapas:crm_stages!crm_stages_pipeline_id_fkey`) e trocar, em vez de acrescentar, mantém UMA
-- relação entre cada par de tabelas (acrescentar deixaria os embeds sem dica ambíguos). FK
-- única também fecha o oracle de existência: estrutura de outra org e estrutura inexistente
-- dão a MESMA recusa (mesma constraint, mesmo detail).
--
-- ── 2. Funil e etapa não trocam de organização
-- Nenhum writer do produto altera `crm_pipelines.organization_id` ou `crm_stages.organization_id`
-- (censo da spike: só o INSERT os define). Trocar o tenant de estrutura com histórico levaria
-- binding, etapas, leads e rastro Green junto. BEFORE UPDATE OF organization_id recusa com
-- `green_structure_tenant_immutable`; a decisão não lê dado de ninguém (não é oracle).
--
-- ── 3. Etapa não entra nem sai de funil Green por UPDATE
-- `crm_stages.pipeline_id` também só é definido no INSERT pelo produto. Trocá-lo arrasta todo
-- lead que aponta para a etapa: entra no Green sem identidade, ou fica com etapa de outro
-- funil. Quando o funil de origem OU o de destino é Green, a troca é recusada
-- (`green_stage_relocation_forbidden`), com ou sem leads. Entre funis comuns segue o upstream.
-- Corrida com binding em voo: a guarda toma SHARE em `green.product_pipeline_binding` antes de
-- ler (espera o binding em voo; o binding seguinte espera a realocação comitar e enxerga a
-- etapa já no lugar novo, item 4).
--
-- ── 4. Binding só nasce sobre estrutura coerente
-- O lifecycle v1.3 (0505) reivindica a identidade dos leads do funil que vira Green, mas não
-- conferia se eles eram coerentes (o lote do produto pode deixar lead comum com etapa de outro
-- funil). Um trigger NOVO no binding (o da 0505 fica intacto) toma o mesmo lock da 0505 e recusa
-- o binding inteiro com `green_binding_structure_invalid` se algum lead que passaria a tocar o
-- domínio tem etapa fora do próprio funil.
--
-- ── 5. Remoção / re-apontamento de binding: migração administrativa auditada
-- Só o dono escreve no binding (nenhum papel de API tem DML). Remover ou re-apontar continua
-- permitido (o lifecycle depende disso), mas deixa de ser silencioso: a auditoria da 0503
-- passa a dizer QUANTOS leads saíram do domínio (`released_leads`, contados sob o mesmo lock
-- da 0505) e cobre também o UPDATE que re-aponta o binding (antes só o DELETE era auditado).
-- As identidades dos leads soltos continuam `live` (UUID não reciclável) e o histórico fica.
-- Cascata de organização: `released_leads` nulo (os leads vão junto com o tenant).
--
-- Sem coluna nova, sem PII nova, sem evento novo (saída/entrada estrutural sem evento canônico
-- é classificada para GREEN-03).

-- ── 0 · estrutura impossível herdada ─────────────────────────────────────────
do $$
declare
  v_contagens jsonb;
begin
  select jsonb_build_object(
    'etapa_em_funil_alheio', (
      select count(*) from public.crm_stages s
        join public.crm_pipelines p on p.id = s.pipeline_id
       where p.organization_id <> s.organization_id),
    'binding_em_funil_alheio', (
      select count(*) from green.product_pipeline_binding b
        join public.crm_pipelines p on p.id = b.pipeline_id
       where p.organization_id <> b.organization_id),
    'lead_em_funil_alheio', (
      select count(*) from public.crm_leads l
        join public.crm_pipelines p on p.id = l.pipeline_id
       where p.organization_id <> l.organization_id),
    'lead_em_etapa_alheia', (
      select count(*) from public.crm_leads l
        join public.crm_stages s on s.id = l.stage_id
       where s.organization_id <> l.organization_id),
    'green_incoerente', (
      select count(*) from public.crm_leads l
       where (exists (select 1 from green.product_pipeline_binding b
                       where b.organization_id = l.organization_id and b.pipeline_id = l.pipeline_id)
              or exists (select 1 from public.crm_stages s
                           join green.product_pipeline_binding b
                             on b.organization_id = s.organization_id and b.pipeline_id = s.pipeline_id
                          where s.id = l.stage_id and s.organization_id = l.organization_id))
         and not exists (select 1 from public.crm_stages s
                          where s.id = l.stage_id
                            and s.pipeline_id = l.pipeline_id
                            and s.organization_id = l.organization_id)))
    into v_contagens;
  if exists (select 1 from jsonb_each_text(v_contagens) where value::bigint > 0) then
    raise exception 'green_structural_legacy_violation'
      using errcode = '23514',
            detail = v_contagens::text,
            hint = 'Corrija a estrutura (etapa/binding/lead na própria organização; lead Green com etapa do próprio funil) e reaplique.';
  end if;
end $$;

-- ── 1 · tenant da estrutura por FK composta ─────────────────────────────────
create unique index if not exists uniq_crm_pipelines_id_org
  on public.crm_pipelines (id, organization_id);
create unique index if not exists uniq_crm_stages_id_org
  on public.crm_stages (id, organization_id);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'crm_stages_pipeline_id_fkey'
                    and conrelid = 'public.crm_stages'::regclass
                    and cardinality(conkey) = 2) then
    alter table public.crm_stages drop constraint if exists crm_stages_pipeline_id_fkey;
    alter table public.crm_stages
      add constraint crm_stages_pipeline_id_fkey
      foreign key (pipeline_id, organization_id)
      references public.crm_pipelines (id, organization_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'crm_leads_pipeline_id_fkey'
                    and conrelid = 'public.crm_leads'::regclass
                    and cardinality(conkey) = 2) then
    alter table public.crm_leads drop constraint if exists crm_leads_pipeline_id_fkey;
    alter table public.crm_leads
      add constraint crm_leads_pipeline_id_fkey
      foreign key (pipeline_id, organization_id)
      references public.crm_pipelines (id, organization_id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'crm_leads_stage_id_fkey'
                    and conrelid = 'public.crm_leads'::regclass
                    and cardinality(conkey) = 2) then
    alter table public.crm_leads drop constraint if exists crm_leads_stage_id_fkey;
    alter table public.crm_leads
      add constraint crm_leads_stage_id_fkey
      foreign key (stage_id, organization_id)
      references public.crm_stages (id, organization_id) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'product_pipeline_binding_pipeline_id_fkey'
                    and conrelid = 'green.product_pipeline_binding'::regclass
                    and cardinality(conkey) = 2) then
    alter table green.product_pipeline_binding drop constraint if exists product_pipeline_binding_pipeline_id_fkey;
    alter table green.product_pipeline_binding
      add constraint product_pipeline_binding_pipeline_id_fkey
      foreign key (pipeline_id, organization_id)
      references public.crm_pipelines (id, organization_id) on delete cascade;
  end if;
end $$;

-- ── 2 · funil não troca de organização ──────────────────────────────────────
create or replace function green.fn_structure_pipeline_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  raise exception 'green_structure_tenant_immutable' using errcode = '23514';
end $$;
revoke all on function green.fn_structure_pipeline_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_green_structure_pipeline on public.crm_pipelines;
create trigger trg_green_structure_pipeline
  before update of organization_id on public.crm_pipelines
  for each row
  when (old.organization_id is distinct from new.organization_id)
  execute function green.fn_structure_pipeline_guard();

-- ── 2 + 3 · etapa não troca de organização nem entra/sai de funil Green ─────
create or replace function green.fn_structure_stage_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'green_structure_tenant_immutable' using errcode = '23514';
  end if;
  if new.pipeline_id is distinct from old.pipeline_id then
    -- serializa com binding em voo (ver o cabeçalho, item 3)
    lock table green.product_pipeline_binding in share mode;
    -- só a própria organização é consultada: funil de outra org nunca é lido como Green aqui
    -- (a FK composta é quem recusa o destino estrangeiro, com a mesma resposta do inexistente)
    if green.fn_is_green_pipeline(old.organization_id, old.pipeline_id)
       or green.fn_is_green_pipeline(new.organization_id, new.pipeline_id) then
      raise exception 'green_stage_relocation_forbidden' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function green.fn_structure_stage_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_green_structure_stage on public.crm_stages;
create trigger trg_green_structure_stage
  before update of organization_id, pipeline_id on public.crm_stages
  for each row
  when (old.organization_id is distinct from new.organization_id
        or old.pipeline_id is distinct from new.pipeline_id)
  execute function green.fn_structure_stage_guard();

-- ── 4 · binding só sobre estrutura coerente ─────────────────────────────────
create or replace function green.fn_binding_structure_check()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- o mesmo lock da 0505: espera as escritas de lead em voo e segura as seguintes
  lock table public.crm_leads in share row exclusive mode;

  -- lead do funil com etapa de outro funil, ou lead de outro funil com etapa deste: os dois
  -- passariam a tocar o domínio com etapa e funil discordando
  if exists (select 1
               from public.crm_leads l
               join public.crm_stages s on s.id = l.stage_id
              where l.organization_id = new.organization_id
                and l.pipeline_id = new.pipeline_id
                and (s.pipeline_id <> l.pipeline_id or s.organization_id <> l.organization_id))
     or exists (select 1
                  from public.crm_stages s
                  join public.crm_leads l on l.stage_id = s.id and l.organization_id = s.organization_id
                 where s.organization_id = new.organization_id
                   and s.pipeline_id = new.pipeline_id
                   and l.pipeline_id <> s.pipeline_id) then
    raise exception 'green_binding_structure_invalid' using errcode = '23514';
  end if;
  return null;
end $$;
revoke all on function green.fn_binding_structure_check() from public, anon, authenticated, service_role;

drop trigger if exists trg_green_binding_structure on green.product_pipeline_binding;
create trigger trg_green_binding_structure
  after insert or update of organization_id, pipeline_id on green.product_pipeline_binding
  for each row execute function green.fn_binding_structure_check();

-- ── 5 · remoção e re-apontamento de binding auditados com o que soltam ─────
-- Cópia da 0503 + `operation`, `released_leads`, `new_pipeline_id` e o ramo de UPDATE.
create or replace function green.fn_binding_removed_audit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_env         jsonb := green.fn_mutation_envelope();
  v_org_deleted boolean := not exists (select 1 from public.organizations o where o.id = old.organization_id);
  v_soltos      bigint;
begin
  if tg_op = 'UPDATE'
     and new.organization_id is not distinct from old.organization_id
     and new.pipeline_id is not distinct from old.pipeline_id then
    return null;
  end if;

  -- Quantos leads saem do domínio: os da organização no funil ou numa etapa dele, contados
  -- sob o lock da 0505 (exato no commit). Na cascata do tenant os leads vão junto: nulo.
  if not v_org_deleted then
    lock table public.crm_leads in share row exclusive mode;
    select count(*) into v_soltos
      from public.crm_leads l
     where l.organization_id = old.organization_id
       and (l.pipeline_id = old.pipeline_id
            or l.stage_id in (select s.id
                                from public.crm_stages s
                               where s.organization_id = old.organization_id
                                 and s.pipeline_id = old.pipeline_id));
  end if;

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
       'trusted',         v_env -> 'trusted',
       'operation',       lower(tg_op),
       'released_leads',  v_soltos)
     || case when tg_op = 'UPDATE'
             then jsonb_build_object('new_pipeline_id', new.pipeline_id)
             else '{}'::jsonb end);
  return null;
end $$;
revoke all on function green.fn_binding_removed_audit() from public, anon, authenticated;
grant execute on function green.fn_binding_removed_audit() to service_role;

drop trigger if exists trg_green_binding_repointed_audit on green.product_pipeline_binding;
create trigger trg_green_binding_repointed_audit
  after update of organization_id, pipeline_id on green.product_pipeline_binding
  for each row execute function green.fn_binding_removed_audit();

notify pgrst, 'reload schema';
