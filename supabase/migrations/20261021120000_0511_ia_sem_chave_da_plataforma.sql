-- 0511 — IA sem chave da plataforma (ADR-0005, issue #33)
--
-- A plataforma não custeia IA: a única chave de todo ponto de IA é a credencial
-- da organização, ativa e validada (ai_provider_credentials). Esta migration
-- fecha os dois pontos em que o BANCO ainda aceitava o contrário:
--
--   1. fn_publish_ai_agent_version aceitava versão sem credential_id quando o
--      servidor afirmava p_platform_credential_verified = true ("a instalação
--      tem a chave no .env"). A flag deixa de liberar: versão sem credencial da
--      organização é recusada com credential_missing. A assinatura não muda
--      (os três overloads continuam existindo) para nenhum clone quebrar na
--      chamada; só o efeito da flag some.
--   2. passagens_de_atendimento ganha o motivo/origem 'ia_sem_chave': o turno
--      da organização sem chave passa a conversa para a equipe na hora, sem
--      tentativa nova, e a linha da passagem diz por quê.
--
-- Idempotente (create or replace / drop if exists + add). Sem BEGIN/COMMIT:
-- o runner envolve em transação. Espelho no apêndice do baseline.sql com o
-- rótulo "(migration 0511)".

create or replace function public.fn_publish_ai_agent_version(
  p_org_id uuid,
  p_agent_id uuid,
  p_version_id uuid,
  p_platform_credential_verified boolean,
  p_expected_provenance text
)
returns table (
  agent_id uuid,
  version_id uuid,
  previous_version_id uuid,
  published_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_agent record;
  v_version record;
  v_credential record;
  v_session record;
  v_model_count integer;
  v_previous_version_id uuid;
  v_published_at timestamptz := now();
begin
  select a.id, a.organization_id, a.published_version_id, a.archived_at
    into v_agent
  from public.ai_agents a
  where a.id = p_agent_id
  for update;

  if not found then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.organization_id <> p_org_id then
    raise exception 'agent_not_found' using errcode = 'P0001';
  end if;
  if v_agent.archived_at is not null then
    raise exception 'agent_archived' using errcode = 'P0001';
  end if;

  select v.id, v.organization_id, v.agent_id, v.status, v.provider, v.model,
         v.credential_id, v.channel_session_id, v.provisioning_origin
    into v_version
  from public.ai_agent_versions v
  where v.id = p_version_id
  for update;

  if not found then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if v_version.agent_id <> p_agent_id or v_version.organization_id <> p_org_id then
    raise exception 'version_not_found' using errcode = 'P0001';
  end if;
  if p_expected_provenance is not null and (
    p_expected_provenance not in('onboarding','legacy_reconciliation') or
    v_version.provisioning_origin is distinct from p_expected_provenance or
    (select count(*) from public.ai_agent_versions own_version where own_version.organization_id=p_org_id and own_version.agent_id=p_agent_id)<>1
  ) then raise exception 'existing_version_requires_review' using errcode='P0001';end if;
  if v_version.status not in ('draft', 'superseded') then
    raise exception 'version_invalid_state' using errcode = 'P0001';
  end if;

  -- ADR-0005 (migration 0511): não existe chave da instalação. A flag
  -- p_platform_credential_verified segue na assinatura por compatibilidade de
  -- overload e NÃO libera nada — versão sem credencial da organização é
  -- recusada sempre, venha de onde vier a chamada.
  if v_version.credential_id is null then
    raise exception 'credential_missing' using errcode = 'P0001';
  end if;

  if v_version.credential_id is not null then
  select c.id, c.organization_id, c.provider, c.is_active, c.validated_at,
         c.models_available
    into v_credential
  from public.ai_provider_credentials c
  where c.id = v_version.credential_id;

  if not found or v_credential.organization_id <> p_org_id then
    raise exception 'credential_not_found' using errcode = 'P0001';
  end if;
  if not v_credential.is_active then
    raise exception 'credential_inactive' using errcode = 'P0001';
  end if;
  if v_credential.validated_at is null then
    raise exception 'credential_not_validated' using errcode = 'P0001';
  end if;
  if v_credential.provider <> v_version.provider then
    raise exception 'credential_provider_mismatch' using errcode = 'P0001';
  end if;

  end if;

  select s.id, s.organization_id, s.status
    into v_session
  from public.channel_sessions s
  where s.id = v_version.channel_session_id;

  if not found or v_session.organization_id <> p_org_id then
    raise exception 'channel_session_not_found' using errcode = 'P0001';
  end if;
  if v_session.status <> 'WORKING' then
    raise exception 'channel_session_offline' using errcode = 'P0001';
  end if;

  -- Provedor personalizado (0418): o endpoint é da empresa, e quem diz que o
  -- modelo existe é a lista que ELE devolveu, gravada na credencial já
  -- conferida acima. Sem credencial própria não há lista — recusado.
  if v_version.provider = 'custom' then
    if v_version.credential_id is null then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
    if not (v_version.model = any(coalesce(v_credential.models_available, '{}'::text[]))) then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  else
    select count(*)
      into v_model_count
    from public.ai_models m
    where m.provider = v_version.provider
      and m.model_id = v_version.model
      and m.deprecated_at is null;

    if v_model_count = 0 then
      raise exception 'model_not_found' using errcode = 'P0001';
    end if;
  end if;

  v_previous_version_id := v_agent.published_version_id;

  if v_previous_version_id is not null and v_previous_version_id <> p_version_id then
    update public.ai_agent_versions
       set status = 'superseded', superseded_at = v_published_at
     where id = v_previous_version_id;
  end if;

  update public.ai_agent_versions
     set status = 'published',
         published_at = v_published_at,
         superseded_at = null
   where id = p_version_id;

  update public.ai_agents
     set published_version_id = p_version_id,
         updated_at = v_published_at
   where id = p_agent_id;

  return query
    select p_agent_id, p_version_id, v_previous_version_id, v_published_at;
end;
$$;

revoke execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text) to service_role;

-- O vocabulário da passagem ganha o motivo "IA desligada por falta de chave"
-- (ADR-0005, D3): o turno sem chave passa a conversa para a equipe na hora, e a
-- linha de passagens_de_atendimento precisa poder dizer por quê. Mesmo desenho
-- da 0291: drop + add, para a segunda aplicação substituir em vez de duplicar
-- (tests/invariants/vocabulario-banco-x-typescript.test.ts mede UMA constraint).
alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_origem_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_origem_check
  check (origem in (
    'pedido_explicito','opt_out_provavel','ferramenta_do_modelo',
    'teto_de_gasto','ia_sem_chave','caso_escalado','sentimento','legado_pedido',
    'legado_juridico','legado_etapa','legado_confianca','legado_teto',
    'mcp_externo','runtime_nativo'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_motivo_codigo_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_motivo_codigo_check
  check (motivo_codigo in (
    'requested_human','suspected_optout','orcamento_de_ia','ia_sem_chave','low_sentiment',
    'low_confidence','critical_stage','legal_mention','refund_mention',
    'caso_escalado'));
