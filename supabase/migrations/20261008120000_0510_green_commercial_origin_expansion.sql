-- Item: CG-COM-01
-- 0510 (CG-COM-01): expansão pós-ganho - nova oportunidade a partir de uma oportunidade ganha.
--
-- Modelo (docs/green/product/GREEN-CRM-01-PRODUCT-FOUNDATION.md, D-15 e seções 16.7/16.8):
-- ganhar NÃO move a oportunidade. A expansão é uma oportunidade NOVA (`crm_leads`), do MESMO
-- contato, ligada à de origem por `crm_lead_links (lead_id = B, target_kind = 'lead',
-- target_id = A, link_kind = 'commercial_origin')`. A oportunidade de origem continua `won`, com
-- `closed_at` e o histórico intactos. Nenhuma tabela nova; `retomado_de_lead_id` (nova tentativa
-- depois de perda) e `source_metadata.clonado_de` (troca de funil) NÃO representam esta relação.
--
-- ── 1. Guarda do vínculo de origem comercial (trigger em crm_lead_links, só `commercial_origin`)
--   `target_id` de `crm_lead_links` é polimórfico e não tem FK: o tenant do alvo é provado aqui,
--   para TODO papel (inclusive service_role). Alvo e lead da mesma organização do vínculo (a mesma
--   recusa para alvo inexistente e de outra organização: sem oracle), alvo `lead`, alvo `won`,
--   origem diferente do destino, usuário de sessão com papel >= agent, e o vínculo é imutável.
--   Os outros `link_kind` (agenda: `scheduled`) não passam por nenhuma regra nova.
--
-- ── 2. fn_green_pipeline_ids(org): os funis Green (com binding) da organização, só para membro.
--   É a lista de destinos possíveis da expansão. Não expõe a chave de processo do binding.
--
-- ── 3. fn_crm_open_expansion_of(origem, produto): a expansão ABERTA dessa origem com esse
--   produto, se houver. `security definer` porque a duplicidade precisa enxergar a organização
--   inteira, não só o que a RLS mostra ao chamador; por isso a resposta só traz o id quando o
--   chamador enxerga a expansão (`visible`), e não responde nada por origem que ele não enxerga.
--
-- ── 4. fn_crm_create_expansion_opportunity(...): a escrita, numa transação só.
--   `security invoker`: roda com a RLS e o papel do chamador, exatamente como o INSERT do
--   PostgREST que o `createLeadHandler` faz (inclusive as travas de suporte e a fronteira Green,
--   que deriva o ator de `auth.uid()`). Passos:
--     a. lock transacional por origem (advisory) - serializa a checagem de duplicidade e a criação;
--     b. origem visível, da organização pedida, `won` e com contato;
--     c. destino é funil Green e a etapa é aberta (não ganho, não perda, não arquivada); sem etapa
--        informada, a primeira aberta do funil;
--     d. idempotência: já existe expansão aberta da origem com o mesmo produto -> devolve ela
--        (`created = false`) sem escrever; se o chamador não a enxerga -> `expansion_already_open`;
--     e. cria B (`source = expansao`, contato de A, sem responsável, aberta), o contexto Green com o
--        produto (as regras da 0509 valem: produto ativo e da organização) e o vínculo B -> A.
--   Qualquer recusa desfaz tudo: não sobra oportunidade sem vínculo nem vínculo sem produto.
--   O `lead.created` e a auditoria continuam do servidor (o mesmo emissor do `createLeadHandler`);
--   o banco emite só o `lead.green_context_changed` da B (trigger da 0509). Nenhum tipo de evento
--   novo. A oportunidade de origem não recebe UPDATE, atividade nem evento.
--
-- Idempotente: `create or replace`, `drop trigger if exists`.

-- ── 1 · guarda do vínculo de origem comercial ───────────────────────────────
create or replace function green.fn_commercial_origin_link_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead_org    uuid;
  v_alvo_org    uuid;
  v_alvo_status text;
begin
  if tg_op = 'UPDATE' then
    if old.link_kind = 'commercial_origin' or new.link_kind = 'commercial_origin' then
      raise exception 'commercial_origin_immutable' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.link_kind is distinct from 'commercial_origin' then
    return new;
  end if;
  if new.target_kind is distinct from 'lead' then
    raise exception 'commercial_origin_target_not_lead' using errcode = '23514';
  end if;
  if new.target_id = new.lead_id then
    raise exception 'commercial_origin_self_reference' using errcode = '23514';
  end if;
  -- sessão humana: papel mínimo de quem cria oportunidade; service_role e dono seguem
  if auth.uid() is not null and not public.fn_role_at_least(new.organization_id, 'agent') then
    raise exception 'commercial_origin_forbidden' using errcode = '42501';
  end if;

  select l.organization_id into v_lead_org
    from public.crm_leads l
   where l.id = new.lead_id;
  -- SHARE na origem: reabrir/encerrar a origem em paralelo espera este commit
  select l.organization_id, l.status into v_alvo_org, v_alvo_status
    from public.crm_leads l
   where l.id = new.target_id
     for share;
  if v_lead_org is distinct from new.organization_id
     or v_alvo_org is distinct from new.organization_id then
    raise exception 'commercial_origin_tenant_mismatch' using errcode = '23503';
  end if;
  if v_alvo_status is distinct from 'won' then
    raise exception 'commercial_origin_origin_not_won' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function green.fn_commercial_origin_link_guard() from public, anon, authenticated;
grant execute on function green.fn_commercial_origin_link_guard() to service_role;

drop trigger if exists trg_commercial_origin_link_guard on public.crm_lead_links;
create trigger trg_commercial_origin_link_guard
  before insert or update on public.crm_lead_links
  for each row execute function green.fn_commercial_origin_link_guard();

-- ── 2 · funis Green da organização (destinos da expansão) ───────────────────
create or replace function public.fn_green_pipeline_ids(p_org uuid)
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select b.pipeline_id
    from green.product_pipeline_binding b
   where b.organization_id = p_org
     and p_org in (select public.fn_user_org_ids());
$$;
revoke all on function public.fn_green_pipeline_ids(uuid) from public, anon;
grant execute on function public.fn_green_pipeline_ids(uuid) to authenticated, service_role;

-- ── 3 · expansão aberta existente para (origem, produto) ────────────────────
create or replace function public.fn_crm_open_expansion_of(p_origin_lead_id uuid, p_product_id uuid)
returns table (lead_id uuid, visible boolean)
language sql stable security definer
set search_path = ''
as $$
  select case when x.visivel then x.id end, x.visivel
    from (
      select b.id,
             public.fn_can_view_lead(b.organization_id, b.owner_user_id) as visivel
        from public.crm_leads a
        join public.crm_lead_links l
          on l.organization_id = a.organization_id
         and l.target_kind = 'lead'
         and l.target_id = a.id
         and l.link_kind = 'commercial_origin'
        join public.crm_leads b
          on b.id = l.lead_id
         and b.organization_id = a.organization_id
        join public.green_lead_context c
          on c.lead_id = b.id
         and c.organization_id = b.organization_id
       where a.id = p_origin_lead_id
         and a.organization_id in (select public.fn_user_org_ids())
         and public.fn_can_view_lead(a.organization_id, a.owner_user_id)
         and b.status = 'open'
         and c.product_id = p_product_id
       order by b.created_at, b.id
       limit 1
    ) x;
$$;
revoke all on function public.fn_crm_open_expansion_of(uuid, uuid) from public, anon;
grant execute on function public.fn_crm_open_expansion_of(uuid, uuid) to authenticated, service_role;

-- ── 4 · a escrita da expansão (uma transação, RLS do chamador) ──────────────
create or replace function public.fn_crm_create_expansion_opportunity(
  p_organization_id uuid,
  p_origin_lead_id  uuid,
  p_pipeline_id     uuid,
  p_stage_id        uuid,
  p_product_id      uuid,
  p_title           text,
  p_value_cents     bigint,
  p_currency        text
)
returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_titulo     text := btrim(coalesce(p_title, ''));
  v_org        uuid;
  v_status     text;
  v_contato    uuid;
  v_etapa      uuid;
  v_existente  uuid;
  v_visivel    boolean;
  v_posicao    numeric;
  v_lead       uuid;
  v_link       uuid;
begin
  if p_product_id is null then
    raise exception 'expansion_product_required' using errcode = '23514';
  end if;
  if char_length(v_titulo) not between 2 and 200 then
    raise exception 'expansion_title_invalid' using errcode = '23514';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'expansion_currency_invalid' using errcode = '23514';
  end if;
  if p_value_cents is not null and p_value_cents < 0 then
    raise exception 'expansion_value_invalid' using errcode = '23514';
  end if;

  -- a. uma expansão por origem de cada vez
  perform pg_advisory_xact_lock(hashtextextended('crm_commercial_origin:' || p_origin_lead_id::text, 510));

  -- b. origem: visível ao chamador (RLS), da organização pedida, ganha e com contato
  select a.organization_id, a.status, a.contact_id
    into v_org, v_status, v_contato
    from public.crm_leads a
   where a.id = p_origin_lead_id
     and a.organization_id = p_organization_id;
  if v_org is null then
    raise exception 'expansion_origin_not_found' using errcode = 'P0002';
  end if;
  if v_status is distinct from 'won' then
    raise exception 'expansion_origin_not_won' using errcode = '23514';
  end if;
  if v_contato is null then
    raise exception 'expansion_origin_without_contact' using errcode = '23514';
  end if;

  -- c. destino Green e etapa aberta
  if not exists (
       select 1 from public.fn_green_pipeline_ids(p_organization_id) g(id)
        where g.id = p_pipeline_id) then
    raise exception 'expansion_destination_not_green' using errcode = '23514';
  end if;
  select s.id into v_etapa
    from public.crm_stages s
   where s.organization_id = p_organization_id
     and s.pipeline_id = p_pipeline_id
     and (p_stage_id is null or s.id = p_stage_id)
     and s.is_won is not true
     and s.is_lost is not true
     and s.is_archived is not true
   order by s.position, s.id
   limit 1;
  if v_etapa is null then
    raise exception 'expansion_stage_unavailable' using errcode = '23514';
  end if;

  -- d. idempotência: uma expansão aberta por (origem, produto)
  select e.lead_id, e.visible into v_existente, v_visivel
    from public.fn_crm_open_expansion_of(p_origin_lead_id, p_product_id) e;
  if found then
    if not v_visivel then
      raise exception 'expansion_already_open' using errcode = '23505';
    end if;
    select l.id into v_link
      from public.crm_lead_links l
     where l.lead_id = v_existente
       and l.target_kind = 'lead'
       and l.target_id = p_origin_lead_id
       and l.link_kind = 'commercial_origin';
    return jsonb_build_object('created', false, 'lead_id', v_existente, 'link_id', v_link);
  end if;

  -- e. a oportunidade nova, o produto e o vínculo
  select coalesce(max(l.position_in_stage), 0) + 1000 into v_posicao
    from public.crm_leads l
   where l.stage_id = v_etapa;

  insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, title, contact_id, value_cents, currency,
     source, status, position_in_stage, created_by_user_id)
  values
    (p_organization_id, p_pipeline_id, v_etapa, v_titulo, v_contato, p_value_cents, p_currency,
     'expansao', 'open', v_posicao, auth.uid())
  returning id into v_lead;

  insert into public.green_lead_context (lead_id, organization_id, product_id)
  values (v_lead, p_organization_id, p_product_id);

  insert into public.crm_lead_links
    (organization_id, lead_id, target_kind, target_id, link_kind, metadata, created_by_user_id)
  values
    (p_organization_id, v_lead, 'lead', p_origin_lead_id, 'commercial_origin',
     jsonb_build_object('reason', 'expansion', 'created_via', 'manual', 'product_id', p_product_id),
     auth.uid())
  returning id into v_link;

  return jsonb_build_object('created', true, 'lead_id', v_lead, 'link_id', v_link);
end $$;
revoke all on function public.fn_crm_create_expansion_opportunity(uuid, uuid, uuid, uuid, uuid, text, bigint, text) from public, anon;
grant execute on function public.fn_crm_create_expansion_opportunity(uuid, uuid, uuid, uuid, uuid, text, bigint, text) to authenticated, service_role;

notify pgrst, 'reload schema';
