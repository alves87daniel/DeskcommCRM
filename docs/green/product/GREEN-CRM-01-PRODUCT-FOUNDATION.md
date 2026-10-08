# GREEN-CRM-01 - Fundação de Produto do ConectorGreen

| Item           | Valor                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status         | PROPOSTO ao dono do produto (modelagem; nenhum código, schema, endpoint, UI ou workflow alterado)                                                                  |
| Data           | 2026-10-06; revisão GREEN-CRM-01.1 em 2026-10-07 (seção 16)                                                                                                        |
| Baseline       | `GREEN-BASELINE-1.0`, tag anotada sobre `b5962666100d1c6939c9d62194681c4da375654a` (= `origin/main`)                                                               |
| Fundação       | Deskcomm v1.69.0 + cadeia Green 0501-0508 ([`GREEN-BASELINE-1.0.md`](../GREEN-BASELINE-1.0.md))                                                                    |
| Política       | "Não seguimos o upstream do Deskcomm. Observamos o upstream." ([ADR-GREEN-001](../../adr/GREEN-001-deskcomm-fundacao-congelada.md))                                |
| Próxima tarefa | GREEN-CRM-02 - Catálogo de Produtos Green e Contexto Comercial da Oportunidade (seção 14, escopo alterado pela revisão 01.1)                                       |
| Fontes         | inventário do código desta baseline (seção 2 e anexo A), as decisões já tomadas do Conector Green v0 (anexo B) e as decisões de produto que a revisão 01.1 recebeu |

Este documento define a fundação **funcional** do ConectorGreen como produto comercial da iGreen sobre a
GREEN-BASELINE-1.0 e escolhe a primeira fatia vertical. Ele não reabre a validação da fundação, não audita spikes,
não compara com o upstream e não trata production readiness (isso é
[`PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md)).

Regra que governou a modelagem: antes de propor tabela, coluna ou módulo, verificar se o conceito já existe na
base, se pode ser estendido, se pertence ao CRM genérico ou ao domínio Green, e justificar qualquer estrutura nova.
Toda estrutura proposta aqui passa pela doutrina DIRC do `CLAUDE.md` (Duplicar, Integrar, Referenciar, Calcular).

A revisão GREEN-CRM-01.1 (seção 16) removeu a premissa "produto = funil" da primeira versão e separou **funil**
(processo comercial), **produto** (o que está sendo vendido) e **tag** (segmentação livre). As seções antigas foram
reescritas para ficarem consistentes com ela; a seção 17 lista as decisões canônicas que o documento inteiro
obedece.

---

## 1. Objetivo do ConectorGreen

O ConectorGreen é o CRM comercial da operação iGreen: a ferramenta com que a rede comercial capta, qualifica,
analisa, converte e acompanha oportunidades de **um catálogo aberto de produtos e ofertas** da iGreen, a partir do
mesmo tipo de contato. A operação pode comercializar vários produtos, e o número de produtos pode crescer sem que a
operação fique mais complexa: o processo comercial é dado por **poucos funis**, e o produto é um **dado da
oportunidade**, não um funil.

Os dois produtos conhecidos hoje (economia / Conexão Green na conta de energia e licença de negócio iGreen) são
exemplos do catálogo, não o catálogo. Os dois funis iniciais (ConexãoGreen e Expansão, seção 6) são processos
comerciais, não produtos.

O produto nasce sobre um CRM genérico já validado (contatos, funis, etapas, timeline, tarefas, agenda, automações,
follow-up, campanhas, eventos, auditoria, multi-tenant com RLS) e acrescenta **só** o que é específico da operação
iGreen. Ele precisa evoluir, sem beco sem saída, para as frentes já identificadas:

| Frente | Capacidade                                                              | Onde este documento a encaixa |
| ------ | ----------------------------------------------------------------------- | ----------------------------- |
| A      | operação comercial / oportunidade                                       | seções 3, 4, 5, 10, 14        |
| B      | catálogo de produtos e ofertas (energia, licença e os próximos)         | seções 4.1, 4.2, 6            |
| C      | captação e desenvolvimento de licenciados                               | seções 4.8, 6                 |
| D      | inteligência regional (DDD x região x distribuidora x oferta/desconto)  | seção 7                       |
| E      | prioridade / scoring de leads                                           | seções 2.10, 4, 10            |
| F      | tarefas e follow-ups                                                    | seção 8                       |
| G      | WhatsApp e extensão ConectorZap                                         | seção 9                       |
| H      | automações comerciais específicas da iGreen (inclui expansão pós-ganho) | seções 8, 10, 16.7            |
| I      | dashboards e acompanhamento operacional                                 | seções 2.11, 8, 16.6          |
| J      | origem, fontes e bases de leads                                         | seções 2.6, 2.9, 16.9-16.12   |
| K      | permissões por organização / usuário / equipe                           | seções 2.4, 11, 12            |
| L      | expansão / upsell / cross-sell na base já convertida                    | seções 6, 16.7, 16.8          |

Nenhuma dessas frentes é implementada por esta tarefa. Elas servem para impedir que a primeira modelagem feche
portas.

---

## 2. Inventário relevante do CRM existente

Somente o necessário para produto comercial, medido no código da baseline (`supabase/baseline.sql` consolida até a
0508; `lib/database.types.ts` está um pouco defasado, ver P2-03). Cada linha diz o que o ConectorGreen reutiliza e
o que é claramente genérico do CRM.

### 2.1 Lead (negócio) - `public.crm_leads`

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modelo                 | `id`, `organization_id`, `pipeline_id`, `stage_id`, `contact_id` (anulável, 1:N), `title`, `description`, `status` (`open`/`won`/`lost`, CHECK), `lost_reason` (obrigatório em `lost`), `won_reason`, `position_in_stage numeric`, `value_cents` + `currency`, `owner_user_id`/`owner_kind`/`owner_agent_id`, `assigned_at`, `last_activity_at`, `expected_close_date`, `closed_at`, `source text` (vocabulário aberto), `source_metadata jsonb`, `external_id` (único por org+source), `custom_fields jsonb`, `tags text[]`, `stage_changed_at`, `retomado_de_lead_id`, `lost_from_stage_id` |
| Não existe             | coluna de tipo/kind, coluna de produto, `metadata`/`provider_data`, qualquer coluna Green, `company_id`, campo de região/UF/cidade/DDD                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Regras de banco        | `fn_crm_lead_close_on_stage` deriva `status`/`closed_at` das flags `is_won`/`is_lost` da etapa (P-02); `fn_validate_lost_reason_required` (P-03); `fn_emit_event_on_lead_change` emite `lead.won`/`lost`/`reopened`/`assigned`; lead vive em UM funil, trocar de funil é `clone` + `lost` com `moved_to_another_pipeline` (P-01); N leads por contato são permitidos (P-08)                                                                                                                                                                                                                   |
| Service                | `app/api/v1/leads/_handler.ts` (`createLeadHandler`, `updateLeadHandler`, `moveLeadHandler`, `retomarLeadHandler`); `lib/leads/*` (`nascimento-do-lead.ts`, `encerramento.ts`, `campos-exigidos.ts`, `motivo-da-perda.ts`, `reabertura.ts`, `previsao.ts`, `clonar-para-funil.ts`)                                                                                                                                                                                                                                                                                                            |
| API                    | `POST /api/v1/leads`, `PATCH /api/v1/leads/[id]`, `[id]/move`, `win`, `lose`, `clone`, `retomar`, `timeline`, `bulk`, `import`, `at-risk`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| UI                     | quadro `app/app/pipelines/[id]/_client.tsx`; `components/kanban/` (`KanbanBoard`, `LeadDossier`, `EditLeadDialog`, `NewLeadDialog`, `LeadFieldsForm`); `components/inbox/CRMSidePanel.tsx`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Quem insere            | `createLeadHandler` (UI, import CSV, clone, retomar, webhook de captura, MCP, automação, prospecção) e a RPC `fn_nascer_lead_da_conversa` (WhatsApp inbound e voz), ambos com advisory lock contra duplicata                                                                                                                                                                                                                                                                                                                                                                                  |
| Reutilizado pelo Green | **o lead É a Oportunidade** (seção 3). Reutiliza-se tudo: desfecho, dono, valor, origem, campos, tags, timeline, eventos                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Genérico do CRM        | tudo acima; nada aqui é iGreen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 2.2 Contato, pessoa e empresa

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contacts`             | `name`, `display_name`, `email`, `phone_number` (CHECK E.164 `^\+\d{8,15}$`, sem coluna de DDD), `cpf_encrypted`/`cpf_hash`, `birthdate`, `is_blocked`, `consent jsonb` (LGPD), `tags`, `source` (`manual` por padrão), `source_metadata jsonb`, `custom_fields jsonb`, `kind` (`person`/`whatsapp_group`), `person_id` -> `people`, `wa_identity`/`wa_lid`, `ai_authorized_at`, anonimização e merge |
| B2B (0448)             | `companies` (`cnpj`, endereço com `city`/`state`/`zip_code`, enriquecimento BrasilAPI), `people`, `company_people` (`is_decision_maker`); cadeia `contacts.person_id -> people <- company_people -> companies`; **nenhum** `company_id` em `crm_leads`                                                                                                                                                |
| Relação com lead       | `crm_leads.contact_id` anulável, 1:N; lead pode existir sem contato; o inbox liga conversa a lead **pelo contato** (`/contacts/{id}/crm-summary`)                                                                                                                                                                                                                                                     |
| API / UI               | `app/api/v1/contacts/*`, `companies/*`, `people/*`, `imports/*`; `app/app/contacts`, `companies`, `people`, `imports`                                                                                                                                                                                                                                                                                 |
| Reutilizado pelo Green | contato como pessoa; `companies` como pessoa jurídica (titular PJ de conta de energia, seção 4); `custom_fields` e `source_metadata` como transição até existir estrutura Green                                                                                                                                                                                                                       |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                                                                                  |

### 2.3 Funil e etapas - `crm_pipelines`, `crm_stages`

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_pipelines`        | `name`, `slug`, `is_default` (um por org; é o funil de entrada do WhatsApp), `is_client_pipeline`, `is_archived`, `vocabulary jsonb` (renomeia lead/deal/won/lost/stage na UI, P-07), `settings jsonb` (`fields` = até 50 campos customizados tipados com `obrigatorio_em {etapas, ao_ganhar, ao_perder}`; `lost_reasons`, `won_reasons`, `won_reason_required`, `reabertura`, `canonical_tags`, `identity_resolution`)                                                     |
| `crm_stages`           | `name`, `slug`, `position`, `color`, `is_won`/`is_lost` (no máximo uma de cada por funil), `is_archived`, `expected_duration_hours`, `requires_human`, `agent_stage_hint` (CHECK: mapeia a etapa para o estado do agente de IA), `win_probability`, `avisar_na_central`                                                                                                                                                                                                     |
| Semântica de etapa     | **não há tipo de etapa além de won/lost**; o significado de "Qualificação" ou "Proposta" é só o nome, configurável por organização. O único precedente de semântica estável por etapa é `agent_stage_hint` + `pipelines/[id]/agent-mapping`                                                                                                                                                                                                                                 |
| Pacotes de funil       | `lib/onboarding/pacotes-de-funil.ts` (clinica, imobiliaria, servicos, curso, loja, generico) e `trg_seed_default_pipeline_for_org`: precedente para funis de fábrica                                                                                                                                                                                                                                                                                                        |
| Green hoje             | `green.product_pipeline_binding (organization_id, pipeline_id) -> product_key text`: define **pertencimento** (o funil é Green). O `product_key` é texto livre sem catálogo (os testes usam `energia`); **nenhum código lê o valor** fora de guardá-lo na lápide de `lead.deleted` (0503/0507). Escrito só pelo dono do banco, sem API nem UI; nenhum papel do PostgREST tem DML nele. A revisão 01.1 reinterpreta o valor como **chave do processo** do funil (seção 16.3) |
| Reutilizado pelo Green | funil + etapas + vocabulário + campos como estrutura; o binding como "este funil é Green e corresponde ao processo X"                                                                                                                                                                                                                                                                                                                                                       |
| Genérico do CRM        | tudo, exceto o binding                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 2.4 Usuários, organização, papéis e visibilidade

| Aspecto                | O que existe                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant                 | `organizations` (`settings jsonb` com `routing`, `visibility_mode`, `branding`, `plan`, etc.; `currency`, `country`, `interface_settings`); sem coluna de nicho/vertical                                                                                                 |
| Membership             | `user_organizations` (`role` `viewer` < `agent` < `manager` < `admin`, revogação lógica); um usuário em N organizações; organização ativa por cookie `active_org`                                                                                                        |
| Visibilidade           | `organizations.settings.visibility_mode` (`all` / `own_and_unassigned` / `own`) restringe **só o papel `agent`** via `fn_can_view_lead` / `fn_can_view_conversation` (0035, 0036, 0042); é por organização, não por membro; não se aplica a contatos, empresas e pessoas |
| Equipes / hierarquia   | **não existem** `teams`, `user_pipeline_access`, `manager_id`; a "equipe" é o conjunto de membros; roteamento round-robin existe só para conversas (`lib/routing/*`)                                                                                                     |
| Plataforma             | `platform_admins` (`fn_is_platform_admin`), sessões de suporte limitadas (0220), UI `app/admin/`                                                                                                                                                                         |
| Auditoria              | `api_audit_log` append-only, `lib/audit/index.ts` fire-and-forget, vocabulário `AUDIT_ACTIONS` em `lib/audit/actions.ts`                                                                                                                                                 |
| Licenciado / parceiro  | **não existe** como conceito; `commission_rules`/`commissions` (0351) são comissão de atendente, não de parceiro; "revendedor" (ADR-0004, white-label) é o dono da instalação cobrando organizações, outro eixo                                                          |
| Reutilizado pelo Green | organização como tenant; papéis; `visibility_mode = own` como primeiro recorte "licenciado vê só a própria carteira"; auditoria                                                                                                                                          |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                     |

### 2.5 Timeline e vínculos - `crm_lead_activities`, `crm_lead_links`

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline               | polimórfica (`source_module`, `source_id`, `type` sem CHECK, `payload`, `metadata`, `actor_kind` `user`/`ai`/`system`/`rule`/`contact`, `reason`, `evidence`); vocabulário de 55 tipos em `lib/leads/activity-vocabulary.ts`; emissor `lib/leads/activity-emitter.ts`; UI `components/kanban/LeadTimeline.tsx`                                                                                                                                  |
| Vínculos               | `crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind, metadata, created_by_user_id)`; `target_kind` CHECK em (`order`, `conversation`, `message`, `appointment`, `contact`, `lead`, `external`); `link_kind` texto livre; único por `(lead_id, target_kind, target_id, link_kind)`; RLS; único escritor hoje é a agenda (`appointment`/`scheduled`); o vínculo `conversation` é lido por dois módulos mas nunca escrito |
| Outros vínculos        | `crm_leads.retomado_de_lead_id` (0425): nova **tentativa** de um negócio encerrado (`lib/leads/reabertura.ts`); `source_metadata.clonado_de {lead_id, pipeline_id}`: clone na **troca de funil** (`clonar-para-funil.ts`), origem encerrada com `moved_to_another_pipeline`                                                                                                                                                                     |
| Reutilizado pelo Green | timeline como histórico de toda mudança Green (tipo novo no vocabulário TS, sem CHECK); `crm_lead_links (lead -> lead, link_kind = commercial_origin)` como **origem comercial** de uma oportunidade de expansão (seção 16.8)                                                                                                                                                                                                                   |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 2.6 Origem do lead, captura e fontes

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colunas                | `crm_leads.source` (`manual`, `whatsapp`, `voip`, `meta_ads`, `google_ads`, `site`, `campanha`, `webhook`, `ai_agent`, `automation`, `prospecting`, `importacao_planilha`, `retomada`), `source_metadata`, `external_id`; UTMs vivem em `contacts.source_metadata` e em `webhook_lead_captures.utm`                                                                                                                                                                                                                                                 |
| Fontes de webhook      | `webhook_sources` (`name`, `path_token` único, `secret`, `kind = lead_capture`, `default_pipeline_id`, `default_stage_id`, `field_map jsonb`, `redirect_to`, `is_active`, `last_received_at`); rota pública `app/api/v1/webhooks/in/[token]` (`lib/webhooks/inbound.ts`, `captacao.ts`); reconhece payload **RD Station** (`lib/webhooks/rdstation.ts`) e **Respondi** (`lib/webhooks/respondi.ts`); dedup por telefone com desfecho `duplicado`; histórico em `webhook_lead_captures` (`fields`, `utm`, `outcome` `criado`/`duplicado`/`recusado`) |
| Atribuição de anúncio  | `lib/leads/atribuicao-de-anuncio.ts` (0164): `meta_ads` via `referral`/`ctwa_clid` do WhatsApp, primeiro toque gravado no contato; `lib/plataformas-de-anuncio/*` (`meta_ads`, `google_ads`): landing de captura (`meta_ads_landing_pages`), `meta_ads_click_refs` (UTM do clique), relatório de conversões (CAPI / Google) e leitura de campanhas. **Não há** ingestão nativa de Meta Lead Ads (formulário leadgen): `leadgen_grouped` é só rótulo de métrica em `tabela-de-campanhas.ts`                                                          |
| Outras entradas        | `leads/import` e `contacts/import` (CSV), `imports/*` (B2B), prospecção Google Maps (`lib/prospecting/*`), campanhas de WhatsApp (`campaigns`, `campaign_recipients`, audiência por filtro dinâmico, sem listas estáticas), WhatsApp inbound (`fn_nascer_lead_da_conversa`), voz, MCP, automação                                                                                                                                                                                                                                                    |
| Não existe             | tabela `lead_sources` de vocabulário, filtro por origem no quadro, mapeamento de colunas na importação CSV                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reutilizado pelo Green | tudo; "fontes de leads" (frente J, seção 16.9) é a camada já existente, sem mecanismo paralelo                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 2.7 Tarefas, agenda e follow-up

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tarefas                | `crm_tasks` (`title`, `due_date` anulável, `priority` `low`..`urgent`, `status` `pending`/`in_progress`/`done`/`cancelled`, `lead_id`, `contact_id`, `assigned_to`, `source_kind` aberto); criação única por `lib/tarefas/criar-tarefa.ts` (audita, grava `task_created` na timeline, push ao responsável quando automática); UI `app/app/tasks/` |
| Agenda                 | `calendar_appointments` com lembretes, desfecho e eventos `appointment.*`; crons de lembrete                                                                                                                                                                                                                                                      |
| Follow-up              | fluxos em grafo (`followup_flow_pointers`/`_versions`/`_enrollments`, gatilhos `lead_created`, `stage_change`, `silence`, `appointment_no_show`...; nó `internal_task`), worker por minuto; "retorno prometido" do agente em `cron_jobs`                                                                                                          |
| Não existe             | lembrete/aviso de tarefa vencida, visão "pendências do dia", catch-up de `contact.birthday`/`lead.date_field_due` quando o relógio está parado na hora 9                                                                                                                                                                                          |
| Reutilizado pelo Green | tudo (seção 8)                                                                                                                                                                                                                                                                                                                                    |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                              |

### 2.8 Automações e eventos

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regras                 | `automation_rules` (`trigger_event`, `trigger_config`, `conditions` até 10, `actions`, `is_active`) + `automation_rule_runs`; 16 gatilhos (12 de evento: `lead.created`, `lead.stage_changed`, `lead.tag_added`, `contact.tag_added`, `message.received`, `message.failed`, `appointment.*`; 4 de relógio: `contact.birthday`, `lead.date_field_due`, `lead.silent_for`, `lead.stage_stale`); ações `create_or_move_lead`, `send_whatsapp_message`, `add_tag`, `assign_owner`, `send_ai_message`, `call_webhook`, `start_message_flow`, `create_task` |
| Barramento             | `event_log` (`event_type`, `entity_kind`, `entity_id`, `payload`, `metadata`, `status` `pending`/`processing`/`done`/`dead`); `emit_event` executável por `authenticated` (membro, viewer+) e `service_role`; sem catálogo TS central de tipos; consumidores em `lib/event-log/register-handlers.ts`; `lead.won` já é emitido por `fn_emit_event_on_lead_change`                                                                                                                                                                                      |
| Green hoje             | `lead.stage_changed` e `lead.deleted` de lead Green são do banco (canônicos, write-once); `lead.created` fica do writer; origem `automation` provada pelo banco; família de relógio carimbada                                                                                                                                                                                                                                                                                                                                                         |
| Central                | `agent_inbox_items` (`kind` em CHECK **fechado**, `severity`, `status`), UI `app/app/ai/inbox`, push via `central.aviso_criado`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Reutilizado pelo Green | tudo; automações iGreen (frente H, inclusive a expansão pós-ganho da seção 16.7) são regras com gatilhos novos (seção 10), não um motor novo                                                                                                                                                                                                                                                                                                                                                                                                          |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 2.9 WhatsApp e canais

| Aspecto                | O que existe                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabelas                | `conversations` (1 por contato x sessão de canal, `assigned_to_user_id`, status), `messages` (`external_id` único, `direction`, `status`, `sent_via` com `external_device`), `channel_sessions` (`provider` `waha`/`meta_cloud`/`zernio`/`datafy`/`wacalls`), `channel_knobs` (anti-banimento), `message_templates` (respostas rápidas) |
| Fluxo                  | inbound cria contato e conversa, **cria lead automaticamente** no funil de entrada (`garantirLeadDaConversa` -> `fn_nascer_lead_da_conversa`, pula contato bloqueado ou lead aberto); mensagem digitada no celular/WhatsApp Web do próprio número conectado chega como `fromMe` e vira outbound `external_device`                       |
| Camada de canal        | `lib/channels/*` (`getAdapter`, `capabilitiesOf`); `scripts/lint-channels.ts` proíbe nome de provedor fora de `lib/channels/`                                                                                                                                                                                                           |
| Extensão de navegador  | **não existe** nenhum código ou documento (nem `manifest.json`, nem `web.whatsapp.com`). Atenção ao choque de nome: `lib/extensions/`, `app/api/v1/extensions/*` e `docs/doctrine/extensoes.md` são o sistema de **extensões declarativas internas do CRM**, não extensão de navegador                                                  |
| Superfície externa     | `api_tokens` (`dsk_...`, escopos `mcp:read`/`mcp:write`/...), `lib/api/auth-dual.ts` rota a rota (+ `lib/auth/public-paths.ts`), MCP em `app/api/mcp/` com tools de lead/contato/conversa/mensagem                                                                                                                                      |
| Reutilizado pelo Green | contatos, conversas e inbox quando a organização conectar um número ao servidor; tokens e padrão auth-dual como ponto de partida da superfície do ConectorZap (seção 9)                                                                                                                                                                 |
| Genérico do CRM        | tudo                                                                                                                                                                                                                                                                                                                                    |

### 2.10 Prioridade, score e risco

| Aspecto                | O que existe                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score                  | `crm_lead_scores` (1:1, `ai_probability` 0-100 por fórmula `lib/leads/score-formula.ts`, faixa `frio`/`morno`/`quente` com histerese); UI `components/kanban/ScoreSlot.tsx` |
| Risco                  | `crm_lead_risk_states` (`em_dia`/`em_voo`/`em_risco`/`critico`), radar em `app/app/radar`                                                                                   |
| Estado do agente       | `lead_state` (BANT por contato), `lead_checkpoints`                                                                                                                         |
| Não existe             | `priority`/`prioridade` em `crm_leads` (só em `crm_tasks`)                                                                                                                  |
| Reutilizado pelo Green | score e risco como insumos genéricos; a **prioridade Green** é derivada (seção 4) e não duplica nenhum deles                                                                |

### 2.11 Dashboards, relatórios e métricas de ganho

Não há rota de dashboard; `app/app/page.tsx` redireciona para a home da interface. KPIs existentes são funções SQL
agregadas: funil por etapa, ganhos/perdas, tempo de primeira resposta por atendente (`fn_attendant_metrics(p_org,
p_from, p_to, p_owner)`, que conta `won`/`lost` por `owner_user_id` com `closed_at` dentro de `[from, to)` e exclui
`moved_to_another_pipeline` da perda), Índice de Atrito (`fn_atrito_metrics`), perdas por motivo, forecast por
`value_cents` x `win_probability` (`lib/leads/previsao.ts`), relatórios de atividades/tags/financeiro
(`fn_relatorio_financeiro`), métricas de campanha e de links rastreáveis, radar de risco.

Isso é a **base de métricas**: ganhos, perdas, por atendente, por período `from/to`, previsão e `closed_at` como
referência temporal. O **Dashboard Green** (seção 16.6) ainda não existe e será construído sobre esse padrão (função
SQL agregada + tela), com as dimensões funil, produto, responsável, origem e campanha.

### 2.12 Catálogo de produtos de venda já existente - `catalog_products`

| Aspecto               | O que existe                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modelo                | por organização: `codigo` (SKU, único por org), `nome`, `descricao`, `marca`, `categoria`, `preco_cents` **obrigatório**, `moeda`, `custo_cents`, `controla_estoque`, `quantidade`, `ativo`, `origem` (`manual`/`planilha`/`nuvemshop`), `imagem_url`; índice de busca fuzzy para o agente de IA                 |
| Quem usa              | propostas comerciais (`crm_proposals` 1:N `crm_proposal_items.product_id`), agente de IA (busca "o cliente escreveu ifone 15"), importação de planilha de loja, Nuvemshop                                                                                                                                        |
| Avaliado para o Green | é o catálogo de **mercadoria de loja** (preço e estoque obrigatórios, sincronizado com e-commerce, pesquisado pelo agente). Reutilizá-lo para ofertas Green forçaria preço fictício, poluiria a busca do agente e o item de proposta. Recusado como catálogo Green (seção 16.4); fica como ponte opcional futura |
| Genérico do CRM       | tudo                                                                                                                                                                                                                                                                                                             |

### 2.13 O que já é Green na base

Resumo do que a cadeia 0501-0508 deixou e que o produto respeita sem rediscutir (detalhe em
[`GREEN-BASELINE-1.0.md`](../GREEN-BASELINE-1.0.md), seção 4):

- **pertencimento** mora só no banco: um lead é Green quando o funil dele (ou o funil da etapa, na mesma organização)
  está em `green.product_pipeline_binding`; nenhum writer tem `if (isGreen)`; não há coluna em `crm_leads`;
- **a Oportunidade Green é a linha de `crm_leads`**; não existe segunda tabela de lead;
- fronteira única `green.fn_crm_lead_boundary`; escrita privilegiada exige contexto (`x-green-mutation-context`),
  humano vem de `auth.uid()`; decisões de controle só leem `metadata.green.trusted`;
- `lead.stage_changed`/`lead.deleted` canônicos do banco; `lead.created` do writer; relato do writer reconhecido por
  `x-green-scope-id`;
- identidade de UUID não reciclável (`green.lead_identity`), proveniência de nascimento, origem `automation`
  provada, estrutura travada (FKs compostas com os nomes antigos);
- o schema `green` não tem `USAGE` para `anon`/`authenticated`; `service_role` só lê; só triggers `security definer`
  e o dono escrevem. **Não há UI nem API Green**; a única "estrutura Green" visível ao operador é o comportamento
  dos funis vinculados.

---

## 3. Fronteira CRM x Green

### 3.1 Vocabulário (fixado por este documento)

| Termo                   | Significado no ConectorGreen                                                                                                                                                                                                                                                 | Na base                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Contato                 | uma pessoa ou empresa. Um contato pode ter **várias oportunidades** ao longo do tempo e simultaneamente                                                                                                                                                                      | `contacts` (+ `companies`, `people`)               |
| Oportunidade            | um negócio comercial para um contato: a linha de `crm_leads`. "Lead" e "Oportunidade" são a mesma linha; "lead" é o nome do CRM genérico. É Green quando o funil dela tem binding. Toda oportunidade Green declara **qual produto** está sendo trabalhado (seção 16.5)       | `crm_leads` em funil com binding                   |
| Funil                   | uma **jornada / processo comercial** (Novo -> Contato -> Qualificação -> Proposta -> Negociação -> Ganho / Perda). Não é produto: o mesmo funil hospeda oportunidades de produtos diferentes. Funil Green = `crm_pipelines` com binding                                      | `crm_pipelines` + `crm_stages` + binding           |
| Produto                 | um item / oferta **estruturado** do catálogo Green: o que está sendo comercializado. Catálogo aberto (seção 16.4); `energy` e `license` são dois exemplos, não o catálogo                                                                                                    | `green_product` (proposto)                         |
| Tag                     | metadado de **segmentação livre** (alta prioridade, indicação, base outubro, cliente ativo, campanha específica, reativação). Não substitui produto nem funil                                                                                                                | `crm_leads.tags`, `contacts.tags`                  |
| Origem                  | por onde a oportunidade entrou (`meta_ads`, `google_ads`, `site`, `whatsapp`, `importacao_planilha`, `referral`...). Não é tag                                                                                                                                               | `crm_leads.source`, `contacts.source`              |
| Campanha / UTM          | a campanha específica e os parâmetros de rastreio de uma origem                                                                                                                                                                                                              | `source_metadata`, `webhook_lead_captures.utm`     |
| Captura                 | o fato de a pessoa ter entrado (formulário, WhatsApp, importação, campanha, indicação). **Não é entidade**: vive em `source`/`source_metadata`/`external_id` do lead e do contato e nos registros de captura (`webhook_lead_captures`, `campaign_recipients`, `import_rows`) | colunas e tabelas existentes                       |
| Processo do funil Green | a chave estável do processo que um funil Green implementa (`conexao_green`, `expansao`); é o valor hoje guardado em `product_pipeline_binding.product_key` (nome legado da coluna, seção 16.3)                                                                               | `green.product_pipeline_binding.product_key`       |
| Estado de CRM           | `(pipeline_id, stage_id, status)` do lead                                                                                                                                                                                                                                    | `crm_leads`                                        |
| Estado do negócio Green | situação da análise, elegibilidade, estágio de cadastro/ativação (seção 5)                                                                                                                                                                                                   | proposto (seção 4)                                 |
| Expansão                | uma **nova oportunidade** aberta para um contato já convertido, no funil Expansão, com o produto que está sendo trabalhado; ligada à oportunidade de origem por vínculo de origem comercial (seção 16.8). Nunca é a oportunidade ganha movida de funil                       | `crm_leads` + `crm_lead_links (commercial_origin)` |
| Licenciado              | um usuário (membro da organização) que vende; **não é entidade**. Dado comercial do licenciado, quando existir, é outra entidade (seção 4, `green_licensee`)                                                                                                                 | `user_organizations`                               |
| Parceiro de indicação   | quem indicou um contato e não é usuário; futuro                                                                                                                                                                                                                              | proposto (futuro)                                  |

Esse vocabulário é o mesmo do Conector Green v0 (anexo B), com uma diferença que precisa ficar explícita: lá
`lead` era a captura e `opportunity` o negócio; na base Deskcomm `crm_leads` é o negócio e a captura é atributo.
Documentação nova usa **Oportunidade** para a linha e **captura** para a origem, nunca "lead Green" como entidade.

### 3.2 O que continua no CRM genérico (confirmado pelo código)

Contato, empresa/pessoa, lead/negócio, funil, etapa, vocabulário e campos customizados do funil, timeline, vínculos,
tarefa, agenda, follow-up em grafo, automações e seus gatilhos/ações, campanhas, prospecção, importação, eventos,
Central, auditoria, score/risco, propostas e catálogo de produtos de loja, conversas/mensagens/canais, tokens de
API/MCP, organização, membros, papéis, visibilidade, plataforma e suporte.

Critério usado: a doutrina de extensões do `CLAUDE.md` ("se nenhuma organização ativar isto, a operação comum
continua inteira?"). Tudo acima é núcleo que o Deskcomm já opera para qualquer nicho; nada precisa de iGreen para
fazer sentido.

### 3.3 O que pertence ao domínio Green

Só conceitos que **não existem** no CRM genérico e **só fazem sentido** para a operação iGreen:

| Conceito                              | Veredito                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oportunidade Green                    | **não é entidade nova**: é `crm_leads` em funil vinculado. O que é Green nela é o **produto** que ela trabalha e o **contexto comercial** (abaixo)                                                                   |
| Catálogo de produtos Green            | Green. Tabela própria `green_product` (seção 16.4): catálogo aberto, sem enum; `catalog_products` da base é mercadoria de loja e foi recusado                                                                        |
| Produto da oportunidade               | Green. `green_lead_context.product_id` (1 produto principal por oportunidade, seção 16.5); nunca tag, nunca derivado do funil                                                                                        |
| Modalidade comercial e tipo de oferta | Green. São atributos da **oferta** (frente B/D), não do lead; a oportunidade guarda um **snapshot** do que foi aplicado na análise                                                                                   |
| Distribuidora e região comercial      | Green. Dado de referência da inteligência regional (seção 7); até existir, a oportunidade guarda o que o cliente declarou                                                                                            |
| Desconto aplicável                    | Green. Snapshot na oportunidade, com origem (`manual` agora, `engine` depois)                                                                                                                                        |
| Situação da análise                   | Green. Estado do negócio, não etapa                                                                                                                                                                                  |
| Elegibilidade                         | Green. Estado do negócio com origem e motivo                                                                                                                                                                         |
| Origem comercial de uma expansão      | Green como **uso**, não como estrutura: `crm_lead_links (lead -> lead, link_kind = commercial_origin)` já existe (seção 16.8)                                                                                        |
| Vínculo com licenciados               | três coisas: dono da oportunidade (CRM, `owner_user_id`); parceiro que indicou (Green, futuro); o licenciado como resultado de uma oportunidade de produto da família licença ganha (Green, futuro, ciclo pós-venda) |
| Prioridade Green                      | Green, **calculada** a partir de contexto + regional + score; não é coluna editável; materializada só quando houver leitura quente                                                                                   |
| Dados de conta / fatura               | Green, com minimização de PII: conta de energia como entidade própria (futuro), só médias declaradas no V1                                                                                                           |
| Estágio de cadastro / ativação        | Green. Estado do negócio no lado iGreen, separado da etapa do funil                                                                                                                                                  |
| Fase Green de uma etapa               | Green. Mapeamento etapa -> fase canônica, porque a etapa é configurável por organização e a lógica Green precisa de identidade estável                                                                               |
| Regra de expansão pós-ganho           | Green. Configuração por organização de "ao ganhar X, criar/sugerir/nada em Expansão com produto Y" (seção 16.7); nunca hardcoded                                                                                     |

---

## 4. Mapa do domínio Green

Para cada conceito: definição, motivo de existir, relação com `crm_leads`, cardinalidade, proprietário do dado e se
é obrigatório agora (GREEN-CRM-02) ou futuro. "Dono" é quem escreve: operador (UI/API), banco (trigger), motor
(job/automação) ou plataforma (dado de referência).

### 4.1 `green_product` - catálogo de produtos Green (AGORA)

- **Definição:** o catálogo aberto do que a iGreen comercializa: `id`, `organization_id` (V1, ver escopo abaixo),
  `code` (chave estável, única por organização, ex.: `energia_conexao`, `licenca_negocio`), `name`, `description`
  opcional, `family` (seletor do schema de atributos e da análise aplicável: `energy`, `license`, `generic`; aberto,
  texto + registro TS), `is_active`, `metadata jsonb` só se um atributo real aparecer, `created_at`/`updated_at`.
- **Motivo:** a oportunidade precisa dizer o que está sendo vendido de forma estruturada (relatório por produto,
  expansão, regra de upsell, filtro). Tag e enum fechado foram recusados (seção 16.2). `catalog_products` foi
  avaliado e recusado (seção 2.12).
- **Escopo (A global / B por organização / C global + configuração):** **decisão adiada (DP-11)**. Não há
  evidência suficiente: depende da topologia de tenancy (DP-02) e de saber se cada organização poderá ter produtos
  próprios. O V1 nasce **por organização** (`organization_id`, RLS tenant como toda tabela `green_`), semeado pelo
  mesmo caminho que semeia o funil de fábrica, com `code` estável. Esse formato é compatível com as três alternativas:
  um catálogo global futuro entra como tabela de referência e uma coluna aditiva `global_product_id` na linha da
  organização, casando por `code`.
- **Relação com `crm_leads`:** indireta, via `green_lead_context.product_id`.
- **Cardinalidade:** organização 1:N produtos; produto 1:N oportunidades.
- **Dono:** administrador da organização (UI/API, GREEN-CRM-02) e provisionamento de fábrica.
- **Agora:** sim, é pré-requisito da GREEN-CRM-02 (seção 14).

### 4.2 `green_lead_context` - contexto comercial Green da oportunidade (AGORA)

- **Definição:** a extensão 1:1 de uma Oportunidade Green com o que é específico iGreen: **produto principal**
  (`product_id`, FK para `green_product`, obrigatório), situação da análise, elegibilidade (com origem e motivo),
  estágio de cadastro/ativação, atributos declarados do produto (jsonb com schema central por `family` do produto)
  e snapshots da análise (distribuidora declarada, desconto aplicado).
- **O que NÃO entra aqui** (seção 16.13): origem/campanha/UTM (ficam em `source`/`source_metadata` do lead e do
  contato e em `webhook_lead_captures`), tags (`crm_leads.tags`), produtos adicionais (tabela própria quando houver
  bundle), dados regionais de referência (catálogos globais, só FK opcional), o catálogo de produtos em si.
- **Motivo:** o lead genérico não tem onde guardar isso de forma tipada, consultável por automação e protegida por
  RLS. `custom_fields` foi avaliado e recusado como lar definitivo (seção 11, D-04): não tem validação de valor por
  campo no servidor, não é FK para catálogo, não emite evento próprio e seu schema é por funil.
- **Relação com `crm_leads`:** `lead_id` PK e FK para `crm_leads` com `organization_id` (composta, no padrão da
  0507), `ON DELETE CASCADE` (a lápide `lead.deleted` e `green.lead_identity` já preservam o fato da existência).
- **Cardinalidade:** 0..1 por lead; existe só para lead em funil vinculado (trigger recusa fora do binding).
  **Não** há mais exigência de produto igual ao binding: o funil não determina o produto.
- **Dono:** operador (UI/API) e, no futuro, motor regional/integração iGreen para campos com origem `engine`.
- **Agora:** sim, é a entidade da GREEN-CRM-02 (seção 14), com o subconjunto mínimo de colunas.

### 4.3 Fase Green da etapa - `green_stage_phase` (FUTURO)

- **Definição:** mapeamento `(organization_id, pipeline_id, stage_id) -> phase_key` com vocabulário fechado de fases
  do ciclo comercial (seção 5).
- **Motivo:** etapas são por organização e renomeáveis; automações iGreen, relatórios comparáveis entre organizações
  e a inteligência regional precisam saber "esta etapa é a análise da oferta" sem depender do nome. Precedente na
  base: `agent_stage_hint` e o `agent-mapping`.
- **Relação com `crm_leads`:** indireta, via `stage_id`.
- **Cardinalidade:** 0..1 fase por etapa; várias etapas podem ter a mesma fase.
- **Dono:** administrador da organização (UI de configuração do funil); pré-preenchido pelos funis Green de fábrica.
- **Agora:** não. Entra com os funis Green de fábrica (GREEN-CRM-03 candidato). Nenhuma coluna em `crm_stages`: a
  tabela é do upstream e a 0507 a vigia.

### 4.4 Funis Green de fábrica (FUTURO, provisionamento, não tabela)

- **Definição:** função provisionadora que cria, para uma organização, os funis **ConexãoGreen** e **Expansão**
  (seção 6) com etapas, vocabulário, campos, fases e o binding (chave de processo `conexao_green` / `expansao`), e
  semeia o catálogo inicial de produtos, no padrão de `pacotes-de-funil.ts` e da ADR-0002.
- **Motivo:** hoje o binding só nasce por SQL do dono; sem provisionamento o produto não é self-service.
- **Agora:** não. Exige ADR `GREEN-NNN` porque abre escrita de binding fora do dono (contrato selado, seção 12,
  DP-01). Para a GREEN-CRM-02 o binding é semeado pelo dono (seção 14).

### 4.5 Conta de energia - `green_energy_account` (FUTURO)

- **Definição:** uma unidade consumidora: titular PF (`contact_id`) **ou** PJ (`company_id`), rótulo ("Casa", "Loja
  1"), distribuidora (FK ao catálogo quando existir), município, médias de fatura e consumo. Sem número de UC, sem
  documento e sem arquivo de fatura até decisão LGPD própria.
- **Motivo:** uma pessoa pode ter várias contas, e a oportunidade de produto de energia é **de uma conta**; o
  titular da conta pode não ser quem negocia (cônjuge). Decisão herdada do v0 (ADR-005 §4) e confirmada aqui.
- **Relação com `crm_leads`:** `green_lead_context.energy_account_id` opcional (FK composta com org).
- **Cardinalidade:** contato/empresa 1:N contas; conta 1:N oportunidades ao longo do tempo.
- **Dono:** operador.
- **Agora:** não. No V1 o contexto guarda só médias declaradas em `attributes` (insumo de qualificação, não
  faturamento). Trigger de migração: primeira tela que precise listar contas de um contato ou primeira análise
  automática por conta.

### 4.6 Inteligência regional - `green_distributor`, `green_municipality_coverage`, `green_ddd_coverage`, `green_offer` (FUTURO)

- **Definição:** dado de referência **da plataforma** (sem `organization_id`, só leitura para organizações):
  distribuidoras; cobertura distribuidora x município (código IBGE); cobertura DDD x município; ofertas (produto x
  distribuidora x modalidade x vigência -> percentual/condição/disponibilidade).
- **Motivo:** frente D. É global porque a verdade regulatória/comercial é a mesma para toda organização; override
  por organização, se surgir, é tabela separada e aditiva (mesma forma do v0, RAD-009).
- **Relação com `crm_leads`:** via `green_lead_context.distributor_id` / `offer_id` (confirmados) e via resolução a
  partir do telefone do contato (candidatos, nunca decisão automática; seção 7).
- **Dono:** plataforma (admin de plataforma / semente por migration de dados).
- **Agora:** não. Os dados reais virão depois; este documento só fixa onde encaixam e a regra "DDD não identifica
  distribuidora".

### 4.7 Regra de expansão pós-ganho - `green_expansion_rule` (FUTURO, configuração)

- **Definição:** por organização: "quando uma oportunidade com produto X (ou qualquer produto) for ganha no funil
  Y, então `create` / `suggest` / `none` uma nova oportunidade no funil Expansão com produto Z" (seção 16.7).
- **Motivo:** o upsell não pode ser hardcoded ("ganhou X -> sempre Y"); precisa ser configurável e auditável.
- **Forma:** candidata a `automation_rules` com gatilho `lead.won` + condição por produto + ação nova
  `create_expansion_opportunity`; tabela própria só se a configuração não couber em regra. Decisão na tarefa que a
  implementar.
- **Agora:** não.

### 4.8 Licenciado como resultado - `green_licensee` e ciclo pós-venda (FUTURO)

- **Definição:** o estado pós-venda de uma oportunidade **cujo produto é da família licença** ganha: onboarding,
  primeiro cliente, PRO, ativação/inatividade/cancelamento com motivo; ligado à oportunidade ganha e, opcionalmente,
  ao usuário que o licenciado passa a ter no CRM.
- **Motivo:** frente C. O ciclo comercial termina em "licença adquirida" (won); o que vem depois é adoção, não
  negociação, e não pode virar etapas `won` extras do funil (decisão herdada PD-012/RAD-027 do v0, reafirmada em
  D-08). Métricas de ativação do licenciado nascem daqui, não do funil.
- **Relação com `crm_leads`:** 1:1 com a oportunidade ganha (`source_lead_id`), sem alterar o desfecho histórico
  dela.
- **Dono:** operador/gestor; futuramente integração iGreen.
- **Agora:** não. Trigger: primeira tela de acompanhamento de licenciado ou primeira métrica de ativação.

### 4.9 Parceiro de indicação e rede comercial - `green_partner`, `green_network_relation` (FUTURO)

- **Definição:** quem indicou um contato (pode ser um licenciado-usuário ou um terceiro) e a relação de
  patrocínio/estrutura entre licenciados.
- **Motivo:** atribuição comercial e comissão futura; **nunca** é ACL (D-07: hierarquia comercial não implica acesso
  a dados pessoais).
- **Relação com `crm_leads`:** `green_lead_context.referrer_partner_id` opcional.
- **Agora:** não. Trigger: primeiro fluxo real de indicação ou necessidade de registrar patrocínio (v0 RAD-008).

### 4.10 Prioridade Green (FUTURO, calculada)

- **Definição:** classificação derivada (`alta`/`média`/`baixa` + motivo) de contexto + regional + score genérico.
- **Motivo:** frente E; DIRC "Calcular": não é coluna editável; materializa-se em tabela 1:1 (no padrão de
  `crm_lead_scores`) só quando virar leitura quente do quadro.
- **Agora:** não.

### 4.11 Fila operacional e avisos Green (FUTURO, sem entidade nova)

- "Pendências do dia", follow-up vencido e "não executou porque a máquina estava desligada" são **read models** sobre
  `crm_tasks`, `followup_enrollments`, `agent_inbox_items` e o livro de abordagens do ConectorZap (seção 9), mais
  novos `kind` na Central (CHECK fechado: exige migration). Nenhuma tabela Green nova (seção 8).

### 4.12 Instalação do ConectorZap e abordagem (FUTURO)

- `green_extension_installation` (user-scoped, **não** tenant-scoped, token só em hash) e o livro de abordagens
  (claim + desfecho, idempotente, com limite auditável). Seção 9. Reutilizar `api_tokens` foi avaliado e recusado:
  o token do Deskcomm é da organização e carrega escopos de MCP; a instalação é da pessoa e atravessa organizações.

---

## 5. Ciclo comercial

### 5.1 Fases canônicas (independentes de produto e de funil)

```text
entrada -> qualificação -> identificação da oportunidade -> análise da oferta -> conversão / cadastro
        -> acompanhamento -> ganho | perda
```

| Fase (`phase_key`) | O que acontece                                            | ConexãoGreen (exemplo de etapas)                | Expansão (exemplo de etapas)                |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `intake`           | a pessoa entrou (captura); lead nasce na etapa de entrada | Nova                                            | Nova (vinda de ganho, importação ou manual) |
| `qualification`    | contato feito, interesse e dados mínimos                  | Contato feito, Respondeu                        | Contato feito                               |
| `opportunity`      | ficou claro qual produto e para quem/qual conta           | Produto identificado                            | Oferta apresentada                          |
| `offer_analysis`   | análise: fatura, distribuidora, elegibilidade, desconto   | Dados recebidos, Qualificada                    | Em análise                                  |
| `conversion`       | cadastro / adesão no lado iGreen                          | Cadastro iGreen, Aguardando validação, Validada | Cadastro / adesão                           |
| `follow_through`   | acompanhamento até o desfecho                             | (entre Validada e Ativa)                        | Acompanhamento                              |
| `won`              | desfecho positivo (etapa `is_won`)                        | Ativa                                           | Ganha                                       |
| `lost`             | desfecho negativo (etapa `is_lost`) com motivo            | Reprovada / Desistiu (motivo)                   | Perdida (motivo)                            |

As etapas são exemplos e entram como **funis de fábrica**, não como schema: a organização pode renomear, juntar ou
dividir etapas; o que precisa ser estável é a fase, dada pelo mapeamento da seção 4.3. A ordem não restringe
transições (pular e voltar etapa é o dia a dia do CRM; P-05 e o quadro já permitem). As etapas herdadas do v0
(PD-011/PD-012/PD-013, anexo B) eram por produto; aqui elas viram exemplos por **processo**, e o que é específico de
um produto (fatura, licença) vive no contexto e no schema de atributos da família do produto, não na etapa.

### 5.2 Estado de CRM x estado do negócio Green

| Dimensão   | Estado de CRM (`crm_leads`)                                                   | Estado do negócio Green (`green_lead_context`)                                                                     |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| O que é    | posição operacional no funil + desfecho universal                             | o que a iGreen sabe sobre aquele negócio, independente de como a organização desenhou o funil                      |
| Campos     | `pipeline_id`, `stage_id`, `status`, `closed_at`, `lost_reason`, `won_reason` | `product_id`, `analysis_status`, `eligibility` (+ `eligibility_source`, `eligibility_reason`), `enrollment_status` |
| Quem muda  | operador no quadro, automação, agente, agenda (8 writers)                     | operador no contexto Green; depois motor regional e integração iGreen                                              |
| Evento     | `lead.stage_changed` (canônico, banco), `lead.won`/`lost`                     | `lead.green_context_changed` (banco, mesma transação; seção 10.4)                                                  |
| Visível em | quadro, dossiê, inbox                                                         | dossiê (seção "Contexto Green"), depois card e relatórios                                                          |

**Onde devem coincidir**

- o **desfecho** (`won`/`lost`) mora **só** no CRM (seção 16.6): etapas `is_won`/`is_lost`, `status`, `closed_at`,
  `won_reason`, `lost_reason`, eventos `lead.won`/`lead.lost` e a timeline. O Green não repete "ganho"; a fase
  `won`/`lost` é lida da flag da etapa. `enrollment_status = active` não fecha o negócio sozinho no V1; quando houver
  automação iGreen (seção 10.5), ela move para a etapa `is_won`, e o desfecho continua sendo o do CRM;
- a fase da etapa e o estado Green devem ser **consistentes por regra, não por acoplamento**: um lead em fase
  `conversion` com `eligibility = ineligible` é um alerta na Central (futuro), não um erro de banco.

**Onde não devem coincidir**

- a análise e a elegibilidade mudam **sem** mover etapa (o operador recebe a fatura e conclui a análise na mesma
  etapa), e a etapa muda sem alterar a análise (reorganização do quadro);
- o cadastro/ativação pode avançar **depois** do `won` do CRM? Para produto de energia, não: pela decisão herdada
  (PD-011) o `won` é a ativação. Para produto de licença o pós-venda é outro ciclo (4.8). O ponto de `won` é por
  **família de produto** (DP-04), não por funil;
- o estado Green não conhece nomes de etapa; a fase (4.3) é a única ponte. Enquanto a fase não existir
  (GREEN-CRM-02), nenhuma automação ou relatório Green depende de etapa.

### 5.3 Vocabulários propostos (chaves estáveis em inglês, rótulos em português na UI)

| Campo                  | Valores                                                                           | Observação                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `analysis_status`      | `not_started`, `waiting_input`, `in_review`, `completed`                          | `waiting_input` = aguardando fatura/dados ou perfil, conforme a família do produto                               |
| `eligibility`          | `unknown`, `eligible`, `eligible_with_conditions`, `ineligible`                   | sempre com `eligibility_source` (`manual`, `engine`) e `eligibility_reason` (texto curto)                        |
| `enrollment_status`    | `not_started`, `submitted`, `under_validation`, `validated`, `active`, `rejected` | estado no lado iGreen; `manual` no V1, integração depois                                                         |
| `green_product.family` | `energy`, `license`, `generic` (aberto: texto + registro TS, sem CHECK fechado)   | seleciona o schema de `attributes` e a análise aplicável; **não é o catálogo** e não limita o número de produtos |
| `link_kind` (expansão) | `commercial_origin`                                                               | em `crm_lead_links`, `target_kind = lead`; `metadata.reason` em `expansion`, `cross_sell`, `upsell`              |

Os vocabulários fechados são CHECK no banco (doutrina: `text` + CHECK, não enum) **e** constante TypeScript
compartilhada (o invariante `vocabulario-banco-x-typescript` cobre colunas com CHECK). `family` e `link_kind` são
abertos de propósito: `family` desconhecida cai no schema `generic`.

---

## 6. Funis: ConexãoGreen e Expansão

### 6.1 Pergunta

Produtos, funis e jornadas: o que determina o quê?

### 6.2 O que o modelo existente diz

- o pertencimento Green é **por funil** (`product_pipeline_binding`); o valor de `product_key` não é lido por nada
  além da lápide (seção 2.3), então a base não obriga "um funil por produto": ela só obriga "o funil é Green";
- um lead vive em um único funil (P-01); mudar de funil é clonar e perder a origem com motivo administrativo;
- campos customizados, motivos de perda, vocabulário, gatilhos de relógio e fluxos de follow-up são **por funil**:
  eles descrevem o **processo**, não o produto;
- a mesma pessoa pode ter N leads (P-08); nada impede uma oportunidade em ConexãoGreen e outra em Expansão para o
  mesmo contato, nem duas em Expansão com produtos diferentes.

### 6.3 Avaliação das formas

| Forma                                                               | Avaliação                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Um funil por produto (primeira versão deste documento)              | **recusado**: multiplica funis conforme o catálogo cresce, duplica configuração de processo idêntica, fragmenta relatório e quadro, e força "trocar de produto" a virar troca de funil (clone + perda administrativa). O processo comercial não muda por produto |
| Tipo de oportunidade (coluna no lead)                               | recusado como coluna em `crm_leads` (tabela do upstream); o produto vive no contexto 1:1 (`product_id`)                                                                                                                                                          |
| Produto como tag                                                    | recusado: tag é texto livre sem FK, sem validação, sem histórico de catálogo; relatório por produto viraria contagem de string                                                                                                                                   |
| Só funis                                                            | funil é configurável e renomeável; sem a chave de produto, automação e relatório não sabem o que está sendo vendido. Insuficiente sozinho                                                                                                                        |
| Só produtos                                                         | o produto sem funil não tem onde a oportunidade andar; o CRM é o funil. Insuficiente sozinho                                                                                                                                                                     |
| **Poucos funis por processo + produto na oportunidade** (escolhida) | **funil** = processo (chave estável no binding); **produto** = dado estruturado da oportunidade (`green_lead_context.product_id`); **contexto por família de produto** (schema de `attributes`); **jornadas por funil** (fluxos, automações)                     |

### 6.4 Decisão (D-03, revisada)

A operação inicia com **dois funis**, definidos por processo, que **não representam o catálogo**:

- **ConexãoGreen**: processo inicial de aquisição/conversão relacionado à entrada principal da operação. Recebe as
  oportunidades novas (tráfego pago, orgânico, planilha, WhatsApp, indicação, manual). A oportunidade declara o
  produto que está sendo trabalhado (seção 16.5); o funil não o determina;
- **Expansão**: processo comercial usado para desenvolver novas oportunidades na base já captada/convertida. Cada
  oportunidade em Expansão declara qual produto/oferta está sendo trabalhado; o funil **não** está amarrado a um
  produto. Nasce de ganho (automático ou sugerido, seção 16.7), de importação de ganhos por período (seção 16.8) ou
  manualmente.

Consequências:

- uma oportunidade ganha em ConexãoGreen **não é movida** para Expansão: a expansão é uma **oportunidade nova**
  (D-15), ligada à original por `crm_lead_links (commercial_origin)`; a original continua `won`, imutável em seu
  significado histórico;
- uma organização pode ter **mais de um funil** do mesmo processo (por região ou equipe); o binding permite, e a
  fase (4.3) mantém os relatórios comparáveis;
- um produto novo **não exige funil novo** (seção 6.5); entra no catálogo e passa a ser selecionável nos funis
  existentes;
- o contrato é o mesmo para um terceiro processo no futuro: nova chave de processo, novo funil de fábrica, zero DDL
  no núcleo.

### 6.5 Critério para criar novos funis (D-16)

**Novo produto NÃO implica novo funil.** Um novo funil só deve ser considerado quando houver diferença material no
**processo**, por exemplo:

- etapas completamente diferentes (o caminho até o ganho não é o mesmo);
- atores/responsáveis diferentes (outra equipe ou papel conduz);
- SLA distinto por etapa;
- regras de fechamento diferentes (motivos, campos obrigatórios ao ganhar/perder, ponto de `won`);
- processo regulatório ou operacional próprio.

Diferença apenas no **item vendido** não é suficiente. Antes de propor um funil novo, a pergunta é: "o que muda nas
etapas, nos responsáveis, no SLA ou no fechamento?" Se a resposta for "só o produto", a resposta é catálogo, não
funil.

---

## 7. Inteligência regional futura

### 7.1 Cadeia

```text
telefone (E.164) -> DDD -> município(s) candidatos -> distribuidora(s) candidatas -> disponibilidade iGreen
                                                  -> modalidade / oferta -> percentual / condição comercial
```

Regras que o modelo precisa respeitar:

- **DDD não identifica distribuidora** (DDD 48 cobre áreas de distribuidoras diferentes). DDD -> município é 1:N;
  município -> distribuidora é 1:1 na maior parte, mas pode ser 1:N (cooperativas); por isso **DDD -> desconto nunca
  é relação direta**, e qualquer resolução a partir do telefone devolve **candidatos**, nunca decisão;
- a confirmação vem de dado do cliente (fatura, endereço, município) e é registrada com origem: `distributor_id`
  confirmado no contexto, `engine` ou `manual`;
- oferta é **temporal** (vigência) e **por produto x distribuidora x modalidade**: o contexto guarda o snapshot
  aplicado, porque a oferta pode mudar depois da análise. "Produto" aqui é a linha de `green_product`.

### 7.2 Onde encaixa

| Peça                            | Onde                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| DDD do contato                  | **calculado** de `contacts.phone_number` (os dois primeiros dígitos após `+55`); não vira coluna até ser filtro quente           |
| Município / endereço do cliente | `green_energy_account` (4.5) quando existir; `companies.city/state` para PJ já existe                                            |
| Catálogos                       | `green_distributor`, `green_municipality_coverage`, `green_ddd_coverage`, `green_offer` (4.6), dado de referência da plataforma  |
| Resultado da resolução          | `green_lead_context.distributor_id`, `offer_id`, `applied_discount_pct`, `eligibility` com `eligibility_source = engine`         |
| Candidatos                      | read model (função SQL), não persistidos; apresentados ao operador para confirmar                                                |
| Fontes de dados (depois)        | ANEEL (distribuidoras e áreas de concessão), ANATEL (DDD), IBGE (municípios); carga por migration de dados / admin de plataforma |

Nada disso é implementado agora. O V1 do contexto guarda `declared_distributor` (texto) e as médias declaradas em
`attributes`, e `eligibility_source = manual`; quando o catálogo existir, as colunas FK entram de forma aditiva e o
texto declarado vira apenas evidência.

---

## 8. Follow-up e operação

### 8.1 O que será reutilizado

| Necessidade futura             | Reuso                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tarefa com prazo e responsável | `crm_tasks` (`due_date`, `priority`, `assigned_to`, `lead_id`), criação por `criar-tarefa.ts`, ação de automação `create_task`, nó `internal_task` do follow-up                                                   |
| lembrete                       | web push ao responsável (já existe para tarefa automática; **não** para tarefa manual, nem para vencimento) e Central (`agent_inbox_items`)                                                                       |
| follow-up automático           | fluxos em grafo (`stage_change`, `silence`, `lead_created`, `appointment_no_show`), retorno prometido do agente (`cron_jobs`), gatilhos de relógio `lead.silent_for` / `lead.stage_stale` / `lead.date_field_due` |
| timeline                       | `crm_lead_activities` (tipos `task_created`, `task_completed`, `followup_*`, `stage_changed`...) + os tipos Green novos                                                                                           |
| dashboard operacional          | padrão "função SQL agregada + tela" dos relatórios e do radar                                                                                                                                                     |

### 8.2 Lacunas medidas (para a frente F/I, não para agora)

- **pendências do dia**: não existe; é um read model sobre `crm_tasks` (vencidas/hoje), `followup_enrollments`
  (`next_eval_at` vencido), avisos abertos da Central e abordagens sem desfecho do ConectorZap;
- **follow-up vencido**: tarefa vencida só é calculada em TS (`lib/tarefas/tipos.ts`); não há cron nem aviso.
  Candidatos: `kind` novos na Central (`task_overdue`, `followup_overdue`) via migration (CHECK fechado) e um cron de
  varredura no padrão de `lead-time-triggers`;
- **não executou porque a máquina estava desligada**: no servidor, enrollments vencidos rodam atrasados no próximo
  tick (nada se perde); `contact.birthday` e `lead.date_field_due` **se perdem** se o relógio estiver parado na hora
  9 (sem catch-up); no ConectorZap, a regra herdada (ADR-017 H) é "PC desligado = etapa não executada, run entra em
  `paused_overdue` e pede decisão humana". O que o servidor precisa guardar para isso é a **abordagem** (claim e
  desfecho), não o funil local; a pendência "retomar ou encerrar" aparece no CRM como aviso (seção 9);
- **recusa Green invisível** (P1-01): a recusa de contexto/estrutura/origem só vai para log; vira `kind` na Central
  (`green_write_refused`) na mesma migration dos avisos acima.

---

## 9. Fronteira WhatsApp e ConectorZap

### 9.1 Princípios (reafirmados do v0, ADR-016/ADR-017, adaptados à base)

- **o CRM não depende da extensão para existir**: tudo que a extensão faz é operar, pelo WhatsApp Web da pessoa,
  sobre objetos que vivem no servidor;
- **dois canais, nunca misturados**: transporte de comandos/presença (A) e sincronização CRM (B), ambos autenticados
  por **token de instalação** user-scoped, nunca por sessão humana nem `service_role`; cada request do canal B é
  reautorizado no servidor como se o usuário tivesse feito no CRM (membership, papel, `visibility_mode`, RLS);
- **a extensão conhece contexto como seletor, nunca como autoridade**; identificadores que ela envia são
  seletores não confiáveis;
- **funis locais são da extensão**; não são etapa, não são follow-up do servidor, não são automação. O servidor
  conhece a **abordagem** e as mudanças de etapa pedidas;
- **conversa não é importada**: nenhum `messages`/`conversations` nasce da extensão (o inbox do Deskcomm é do número
  conectado ao servidor, outro canal);
- **o Green não origina o fluxo principal de WhatsApp** para a operação do licenciado no V1: não há "Enviar WhatsApp"
  do dossiê pela extensão até existir decisão própria;
- **nome**: a superfície chama-se ConectorZap. Pela restrição de canal (`lint-channels`) e pelo choque com
  `lib/extensions/` (extensões declarativas internas), a família de rotas e o módulo precisam de nome próprio
  (`zap`), decidido na tarefa que a implementar (DP-06).

### 9.2 Objetos do CRM que a extensão consumirá (somente leitura, mínimo por feature)

| Objeto                       | Campos mínimos                                                                      | Fonte na base                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| organizações do usuário      | id, nome (só as ativas em que é membro; seleção explícita)                          | `user_organizations`, `organizations`                                         |
| contato por telefone         | id, nome, (lista limitada quando houver mais de um)                                 | `contacts.phone_number` com variantes BR (`lib/channels/phone-variants.ts`)   |
| oportunidades do contato     | id, produto, funil, etapa atual (nome), fase, status, `crmPath` (deep link)         | `crm_leads` + `green_lead_context.product_id` + binding + `green_stage_phase` |
| contexto Green mínimo        | elegibilidade, prioridade (quando existir), hints booleanos autorizativos opcionais | `green_lead_context`                                                          |
| destinos de etapa            | etapas ativas do funil da oportunidade                                              | `crm_stages`                                                                  |
| modelos de mensagem (futuro) | `message_templates` da organização                                                  | `message_templates`                                                           |

Nunca vai à extensão: dono, papel, lista de permissões, outros usuários, dados de outros contatos, histórico
completo, telefone/e-mail além do que a página já mostra.

### 9.3 Eventos que a extensão produzirá (comandos reautorizados no servidor)

| Comando                         | Efeito no servidor                                                                                                                | Fato registrado                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| claim de abordagem              | verifica membership/papel/visibilidade/limite; devolve `approachId` idempotente                                                   | `whatsapp.approach_requested` (evento + timeline) |
| desfecho da primeira mensagem   | `submitted` ou `failed` com motivo; primeiro desfecho vence                                                                       | `whatsapp.approach_submitted` / `_failed`         |
| mover etapa                     | o mesmo caminho dos writers existentes (`moveLeadHandler`) sob `runGreenRequestBoundary`, com ator humano = usuário da instalação | `lead.stage_changed` canônico do banco            |
| registrar nota / atividade      | `crm_lead_activities` (tipo próprio)                                                                                              | timeline                                          |
| atualizar contexto Green mínimo | o mesmo comando da GREEN-CRM-02                                                                                                   | `lead.green_context_changed`                      |
| presença / heartbeat            | lease do transporte                                                                                                               | nenhum evento de negócio                          |

Fora do V1 da extensão: criar contato ou lead pela extensão, criar follow-up do servidor a partir do funil local,
registrar cada etapa do funil local, mídia.

### 9.4 Estados que precisam viver no servidor (nunca só no browser)

- identidade da instalação e pareamento (token só em hash; uma instalação ativa por usuário; revogação);
- autorização, limites auditáveis de novas abordagens e o livro de abordagens (claim + desfecho), porque são a única
  evidência de que uma abordagem assistida pelo produto aconteceu e porque "PC desligado" não pode apagar o fato;
- estado da oportunidade, contexto Green, fase, tarefas e follow-ups do servidor;
- reconciliação: abordagem sem desfecho depois de um prazo e runs `paused_overdue` viram **aviso na Central** para o
  dono da oportunidade, não ficam só no IndexedDB.

Fica **só** na extensão: definição e texto dos funis locais, estado de execução (`stepIndex`, `nextDueAt`),
cadência técnica (intervalos, jitter, pausa), DOM e detecção. Nunca sincronizado ao servidor, nunca em evento.

### 9.5 Risco de duplicidade com o inbox do servidor

Se uma organização conectar ao servidor (WAHA/Meta) o **mesmo** número que o licenciado opera pela extensão, a
mensagem digitada no WhatsApp Web chega ao servidor como `fromMe` (`external_device`) e a abordagem também é
registrada pela extensão. O desenho acima evita duplicar **fatos de negócio** (a abordagem é um claim, não uma
mensagem), mas a regra "um número conectado ao servidor não é operado pela extensão" precisa estar escrita quando a
extensão nascer (DP-06).

---

## 10. Entidades e relações propostas (modelo de produto V1)

### 10.1 Entidades reutilizadas do CRM

`organizations`, `user_organizations`, `contacts`, `companies`/`people`/`company_people`, `crm_pipelines`,
`crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, `crm_tasks`, `calendar_appointments`,
`followup_*`, `automation_rules`/`_runs`, `campaigns`/`campaign_recipients`, `webhook_sources`,
`webhook_lead_captures`, `event_log`, `agent_inbox_items`, `api_audit_log`, `crm_lead_scores`,
`crm_lead_risk_states`, `message_templates`, `conversations`/`messages`/`channel_sessions` (quando houver número no
servidor), `api_tokens`.

### 10.2 Entidades e extensões Green propostas

| Entidade                                                                                       | Schema / lugar              | Quando                   |
| ---------------------------------------------------------------------------------------------- | --------------------------- | ------------------------ |
| `green.product_pipeline_binding` (existe; valor = chave de processo)                           | `green` (fundação)          | existe                   |
| `public.green_product` (catálogo aberto)                                                       | `public`, `green_`          | GREEN-CRM-02             |
| `public.green_lead_context` (com `product_id`)                                                 | `public`, `green_`          | GREEN-CRM-02             |
| `crm_lead_links (lead -> lead, commercial_origin)` (uso de tabela existente)                   | `public` (existe)           | com a expansão (CRM-04)  |
| `public.green_lead_product_item` (produtos adicionais / bundle)                                | `public`, `green_`          | futuro, se houver bundle |
| regra de expansão pós-ganho (`automation_rules` ou `green_expansion_rule`)                     | `public`                    | futuro (frente H/L)      |
| `public.green_stage_phase`                                                                     | `public`, `green_`          | futuro (fábrica)         |
| provisionamento dos funis Green de fábrica (função)                                            | `public` (RPC)              | futuro, com ADR          |
| `public.green_energy_account`                                                                  | `public`, `green_`          | futuro                   |
| `public.green_distributor`, `green_municipality_coverage`, `green_ddd_coverage`, `green_offer` | `public`, referência global | futuro                   |
| `public.green_licensee` (ciclo pós-venda)                                                      | `public`, `green_`          | futuro                   |
| `public.green_partner`, `green_network_relation`                                               | `public`, `green_`          | futuro                   |
| `public.green_extension_installation`, livro de abordagens                                     | `public`, user-scoped       | futuro                   |
| prioridade Green materializada                                                                 | `public`, 1:1               | futuro                   |

Regra de lugar (D-05): tabelas de **produto** Green ficam em `public` com prefixo `green_`, com RLS por
`organization_id` como qualquer tabela tenant (ou sem `organization_id` quando forem referência global, com só
leitura), porque o schema `green` é a fundação: sem `USAGE` para os papéis da API e escrito só por trigger. Abrir o
schema `green` à API seria mudar contrato selado.

### 10.3 Relações

```text
organizations 1--N crm_pipelines 1--0..1 green.product_pipeline_binding (chave de processo)
organizations 1--N green_product (catálogo aberto)                                        [GREEN-CRM-02]
crm_pipelines 1--N crm_stages 1--0..1 green_stage_phase (phase_key)                      [futuro]
contacts 1--N crm_leads (Oportunidade; Green quando o funil tem binding)
crm_leads 1--0..1 green_lead_context (lead_id PK; product_id -> green_product)           [GREEN-CRM-02]
green_product 1--N green_lead_context (produto principal)                                 [GREEN-CRM-02]
green_lead_context 1--N green_lead_product_item (produtos adicionais)                     [futuro, bundle]
green_lead_context N--0..1 green_energy_account (PF: contacts | PJ: companies)            [futuro]
green_lead_context N--0..1 green_distributor / green_offer                                 [futuro]
green_lead_context N--0..1 green_partner (indicação)                                       [futuro]
crm_leads (família license, won) 1--0..1 green_licensee                                   [futuro]
crm_leads (B, Expansão) --crm_lead_links(commercial_origin)--> crm_leads (A, won)          [uso existente]
user_organizations (licenciado = membro)  --  green_network_relation (nunca ACL)           [futuro]
```

### 10.4 Estados e eventos importantes

| Fato                                | Produtor                                         | Evento (`event_log`)                                                                            | Timeline (`crm_lead_activities.type`)        | Auditoria                    |
| ----------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- |
| produto do catálogo criado/alterado | writer (UI/API)                                  | `green.product_changed` (entity `green_product`)                                                | nenhum                                       | `green.product.updated`      |
| contexto Green criado/alterado      | banco (trigger AFTER na tabela, mesma transação) | `lead.green_context_changed` (entity `crm_lead`, payload com `changed` e `product_id`, sem PII) | `green_context_changed`                      | `green.lead_context.updated` |
| produto da oportunidade alterado    | idem (campo `changed` lista `product_id`)        | o mesmo evento                                                                                  | o mesmo                                      | o mesmo                      |
| elegibilidade mudou                 | idem (campo `changed` lista `eligibility`)       | o mesmo evento                                                                                  | o mesmo                                      | o mesmo                      |
| cadastro/ativação mudou             | idem                                             | o mesmo evento                                                                                  | o mesmo                                      | o mesmo                      |
| oportunidade de expansão criada     | writer (`createLeadHandler`) + link              | `lead.created` (já existe)                                                                      | `lead_created` + vínculo `commercial_origin` | existente                    |
| abordagem pedida / desfecho         | servidor (canal B)                               | `whatsapp.approach_*`                                                                           | tipo próprio                                 | ação própria                 |
| recusa Green                        | banco (já recusa) -> aviso                       | `central.aviso_criado`                                                                          | nenhum                                       | existente                    |

Regras de emissão que respeitam a fundação:

- o evento Green novo **não** usa as marcas reservadas `green_canonical`/`green_context_version`/`green` em
  `metadata` (reservadas ao produtor canônico da fronteira de `crm_leads`); é um evento comum, de banco, na mesma
  transação, com `entity_kind = crm_lead` e `entity_id = lead_id`, consumível por automação no futuro;
- o payload nunca carrega PII (nem médias declaradas); carrega chaves de estado, `product_id` e a lista de campos
  alterados;
- até existir consumidor, o tipo é registro (`fn_event_log_e_registro` nasce `done`), como `lead.deleted`.

### 10.5 Automações futuras (frente H, sobre o motor existente)

| Gatilho                                                            | Entidade | Família        | Exemplo de regra iGreen                                                                      |
| ------------------------------------------------------------------ | -------- | -------------- | -------------------------------------------------------------------------------------------- |
| `lead.won` (existe)                                                | lead     | evento         | expansão pós-ganho: condição por produto/funil -> ação `create_expansion_opportunity` (16.7) |
| `lead.green_context_changed` (novo)                                | lead     | evento         | elegibilidade `eligible` -> mover para etapa de fase `conversion` + tarefa                   |
| `lead.green_enrollment_stale` (novo)                               | lead     | relógio        | `submitted` há N dias sem `validated` -> aviso na Central + tarefa                           |
| (existentes) `lead.silent_for`, `lead.stage_stale`, `lead.created` | lead     | relógio/evento | follow-up de fatura não enviada; boas-vindas ao licenciado                                   |

Cada gatilho novo precisa do espelho SQL/TS da família (`fn_automation_trigger_family`/`_entity`, AUTO-GAP-06):
é custo conhecido, não bloqueio. Ações novas candidatas: `set_green_context` (definir elegibilidade/estágio por
regra, com origem `automation` provada como hoje) e `create_expansion_opportunity` (seção 16.7).

### 10.6 Fronteiras

- **WhatsApp / ConectorZap:** seção 9. A extensão lê `green_lead_context` e pede mudanças pelos mesmos comandos do
  CRM; nunca escreve em tabela.
- **Inteligência regional:** seção 7. O catálogo é global e só leitura; o resultado entra no contexto com origem
  `engine`; a decisão final é sempre confirmada pelo operador até decisão contrária.
- **Fontes de leads:** seção 16.9. Toda entrada converge para contato + oportunidade pelos writers existentes; o
  Green não cria mecanismo paralelo de ingestão.

---

## 11. Decisões tomadas

| ID   | Decisão                                                                                                                                                                                                                                            | Alternativas recusadas                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | **`crm_leads` é a Oportunidade.** Não existe segunda entidade de lead/negócio Green. Atributos iGreen vivem em extensão 1:1 (`green_lead_context`)                                                                                                 | tabela `green_opportunity` própria (duplicaria desfecho, dono, timeline, eventos e toda a fundação 0501-0508)                                                                 |
| D-02 | **Produto é catálogo aberto** (`green_product`, seção 16.4), com `code` estável e `is_active`; **nenhum enum fechado** `energy`/`license` como arquitetura. (Revisado em 01.1: a primeira versão fixava vocabulário fechado `energy` \| `license`) | enum/CHECK `energy`/`license`; produto como tag; reutilizar `catalog_products` (mercadoria de loja, preço/estoque obrigatórios); texto livre sem catálogo                     |
| D-03 | **Funil = processo, produto = dado da oportunidade** (seção 6). Dois funis iniciais por processo (ConexãoGreen, Expansão), nenhum deles amarrado a produto. (Revisado em 01.1: a primeira versão dizia "um funil por produto por organização")     | um funil por produto; tipo de lead; só funis; só jornadas; um funil único com ramificação                                                                                     |
| D-04 | **Contexto Green em tabela tipada, não em `custom_fields`.** `attributes jsonb` só para o longo-tail por família de produto, com schema central (Zod por `family`) e nunca lido por caminho direto na UI                                           | `custom_fields` do funil (sem validação por campo, sem FK, sem evento, schema por organização); colunas por produto na tabela (NULLs cruzados)                                |
| D-05 | **Tabelas de produto Green em `public` com prefixo `green_`**, RLS por `organization_id` (ou referência global só leitura); o schema `green` continua fundação, sem API                                                                            | abrir `USAGE` do schema `green` à API (contrato selado; exigiria ADR e mudança de config do PostgREST no kit)                                                                 |
| D-06 | **Desfecho mora só no CRM** (`status`/etapa `is_won`/`is_lost`, `closed_at`, `won_reason`, `lost_reason`, `lead.won`/`lost`); o Green não repete "ganho"; estado do negócio Green é separado e ligado por regra (seções 5.2, 16.6)                 | estado Green com `won` próprio; derivar status de `enrollment_status` por trigger; segundo sistema de status Green                                                            |
| D-07 | **Hierarquia comercial nunca é ACL.** Rede/patrocínio, quando existir, é entidade de domínio sem efeito em RLS; acesso é papel + `visibility_mode` + membership                                                                                    | derivar visibilidade da rede                                                                                                                                                  |
| D-08 | **Pós-venda do licenciado é ciclo próprio** (`green_licensee`), fora do funil comercial; a oportunidade de produto da família licença termina em "licença adquirida" (won) ou perda                                                                | etapas `won` extras (onboarding, primeiro cliente, PRO) no funil                                                                                                              |
| D-09 | **DDD -> desconto nunca é relação direta.** Resolução por telefone devolve candidatos; distribuidora confirmada e oferta aplicada são snapshots no contexto com origem                                                                             | coluna `ddd -> distribuidora`                                                                                                                                                 |
| D-10 | **Fase Green é mapeamento por etapa** (`green_stage_phase`), nunca coluna em `crm_stages` nem nome de etapa interpretado                                                                                                                           | `CHECK` de slug de etapa; coluna nova em `crm_stages` (tabela do upstream vigiada pela 0507)                                                                                  |
| D-11 | **Eventos Green de produto são do banco, na mesma transação, sem as marcas canônicas reservadas**, com `entity_kind = crm_lead`, payload sem PII                                                                                                   | emitir do writer depois do commit (não atômico, como `lead.created`)                                                                                                          |
| D-12 | **A extensão não é dona de nenhum estado de negócio**; abordagem, autorização, limites e reconciliação vivem no servidor; funis locais e texto ficam na extensão (seção 9)                                                                         | sincronizar funis/conversas ao servidor; executor cloud agora                                                                                                                 |
| D-13 | **Licenciado é membro** (`user_organizations`, papel `agent` com `visibility_mode = own` como primeiro recorte); não há entidade "usuário licenciado"                                                                                              | tipo de conta próprio                                                                                                                                                         |
| D-14 | **Primeira fatia = GREEN-CRM-02 - Catálogo de Produtos Green e Contexto Comercial da Oportunidade** (seção 14; escopo alterado em 01.1)                                                                                                            | contexto sem produto (versão anterior); binding administrável; pendências do dia; funil de fábrica; extensão (seção 14.3)                                                     |
| D-15 | **Ganho não move a oportunidade; expansão é oportunidade nova** (seção 16.7), ligada à de origem por `crm_lead_links (lead -> lead, link_kind = commercial_origin)`; a original continua `won`                                                     | mover a oportunidade ganha para Expansão; clone (`clonado_de`, encerra a origem com `moved_to_another_pipeline`); `retomado_de_lead_id` (significa nova tentativa após perda) |
| D-16 | **Novo produto não exige funil novo** (seção 6.5); novo funil só com diferença material de processo                                                                                                                                                | funil por produto, funil por campanha, funil por origem                                                                                                                       |
| D-17 | **1 oportunidade -> 1 produto principal obrigatório** (`green_lead_context.product_id`), evoluível para "principal + adicionais" por tabela aditiva quando houver bundle real (seção 16.5)                                                         | N:N desde já (sem evidência de bundle; relatório ambíguo); produto opcional; produto em `crm_leads`                                                                           |
| D-18 | **Origem, campanha, UTM e tag são conceitos separados** (seção 16.12): `source` é vocabulário próprio, campanha/UTM vivem em metadados de captura, tag é segmentação livre                                                                         | origem como tag; campanha como funil; UTM em `custom_fields`                                                                                                                  |
| D-19 | **Fontes de leads convergem para o mesmo modelo** (contato + oportunidade pelos writers existentes: `createLeadHandler`, `fn_nascer_lead_da_conversa`, `webhook_sources`, importação); sem mecanismo paralelo Green de ingestão (seção 16.9)       | tabela Green de "lead bruto"; segundo importador; segundo webhook                                                                                                             |
| D-20 | **`closed_at` é a referência temporal de ganho/perda** em todo relatório, importação por período e automação Green                                                                                                                                 | `stage_changed_at`; `updated_at`; data de cadastro iGreen                                                                                                                     |

---

## 12. Decisões adiadas

| ID    | Decisão pendente                                                                                                                                                                                                                                                                                                                             | Prazo / gatilho                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| DP-01 | **Escrita de binding fora do dono do banco** (RPC `security definer` + UI de administração ou provisionamento dos funis de fábrica). Toca contrato selado ("binding só pelo dono"): exige ADR `GREEN-002`. Inclui a decisão de **renomear ou documentar** a coluna `product_key` como chave de processo (seção 16.3)                         | antes da GREEN-CRM-03 (funis de fábrica)                                     |
| DP-02 | **Topologia de tenancy**: uma organização por licenciado, por equipe/escritório ou uma única com `visibility_mode = own`? Afeta frente K, dado de referência, catálogo (DP-11) e cobrança. Recomendação provisória: organização = unidade comercial (equipe/escritório), licenciados como `agent` com `own`; iGreen como admin de plataforma | antes do primeiro uso com mais de um licenciado real                         |
| DP-03 | **Visibilidade por membro e equipes** (`own` hoje é por organização e só para `agent`; não há `team`). Estender o núcleo (`scope` por membro, `teams`) ou aceitar o recorte por organização                                                                                                                                                  | junto com DP-02                                                              |
| DP-04 | **Ponto de `won` por família de produto** (energia: ativação; licença: licença adquirida) e motivos de perda de fábrica (`rejected`, `withdrawn` / `lost`). Leitura herdada do v0 é a proposta padrão; agora é por família, não por funil                                                                                                    | antes dos funis de fábrica                                                   |
| DP-05 | **Dados de conta / fatura e LGPD**: UC, arquivo da fatura, titularidade, retenção; hoje só médias declaradas                                                                                                                                                                                                                                 | antes de `green_energy_account`                                              |
| DP-06 | **Nome e lugar do módulo ConectorZap** no código (família `zap`), relação com `lib/channels` e com `lib/extensions`, regra "número conectado ao servidor não é operado pela extensão"                                                                                                                                                        | na tarefa que iniciar a integração                                           |
| DP-07 | **Catálogo regional: fonte, carga e governança** (quem mantém, override por organização ou não)                                                                                                                                                                                                                                              | antes da frente D                                                            |
| DP-08 | **Integração com o backoffice iGreen** para `enrollment_status` (manual no V1)                                                                                                                                                                                                                                                               | quando existir contrato da iGreen                                            |
| DP-09 | **Cálculo da prioridade Green** (insumos, pesos, materialização)                                                                                                                                                                                                                                                                             | quando contexto + regional existirem                                         |
| DP-10 | **Visibilidade da recusa Green e dos vencimentos na Central** (`kind` novos: `green_write_refused`, `task_overdue`, `followup_overdue`) - decisão de produto P1-01                                                                                                                                                                           | primeira entrega da frente F/I                                               |
| DP-11 | **Escopo do catálogo de produtos**: A global iGreen / B por organização / C global + configuração por organização (seção 16.4). V1 por organização com `code` estável, compatível com as três                                                                                                                                                | junto com DP-02, antes do primeiro catálogo compartilhado entre organizações |
| DP-12 | **Chave de idempotência da expansão** (importação por período e automação pós-ganho, seção 16.8): candidatas `external_id` de `crm_leads` (`source = expansao`, `external_id = <A.id>:<product.code>`) ou consulta ao vínculo `commercial_origin` + produto + status aberto                                                                  | na tarefa que implementar a expansão (GREEN-CRM-04 candidato)                |
| DP-13 | **Produtos adicionais / bundle** (`green_lead_product_item`): só quando houver um combo real vendido numa mesma oportunidade                                                                                                                                                                                                                 | primeira oferta combinada                                                    |
| DP-14 | **Meta Lead Ads nativo** (formulário leadgen da plataforma): integração específica, sem evidência na base (seção 16.10)                                                                                                                                                                                                                      | quando a operação rodar Lead Ads nativo                                      |
| DP-15 | **Mapeamento de colunas na importação CSV** (seção 16.11): formato do mapa, destinos (`contact.*`, `custom field`, campo Green, origem), persistência de modelos de importação                                                                                                                                                               | primeira planilha real que não caiba no modelo fixo                          |

Nenhuma dessas pendências bloqueia a GREEN-CRM-02.

---

## 13. Riscos

| ID   | Risco                                                                                                        | Mitigação                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Operador confunde "lead" (CRM) com "Oportunidade"/"captura"                                                  | vocabulário da seção 3.1 em toda documentação nova; `vocabulary` dos funis de fábrica rotula `lead` como "Oportunidade"                                                                      |
| R-02 | Contexto Green escrito para lead fora de funil vinculado                                                     | trigger BEFORE INSERT/UPDATE que lê o binding do funil do lead (leitura de `green.*` por função `security definer` da fundação); teste de invariante. **Sem** exigência de produto = binding |
| R-03 | Leitura do binding pela UI: `authenticated` não tem `USAGE` em `green`                                       | função `public` só leitura (`security definer`, revogada de `public`/`anon`, concedida a `authenticated`) que devolve se o funil é Green e sua chave de processo; checklist de definer       |
| R-04 | Regra nova de writer (P1-03): toda rota/job novo que escreva lead em funil Green precisa declarar o boundary | a GREEN-CRM-02 não escreve em `crm_leads`; a cerca estrutural de P1-03 entra antes do primeiro writer novo (a expansão, GREEN-CRM-04, será o primeiro)                                       |
| R-05 | `custom_fields` dos funis Green de fábrica e `green_lead_context` guardarem a mesma verdade                  | funil de fábrica não cria campo customizado para nada que esteja no contexto (regra de aceite da GREEN-CRM-03)                                                                               |
| R-06 | Duplicidade de abordagem entre inbox do servidor e extensão                                                  | seção 9.5; regra escrita em DP-06                                                                                                                                                            |
| R-07 | Catálogo regional desatualizado gera elegibilidade errada                                                    | snapshot com origem e vigência; confirmação humana; `eligibility_source` visível                                                                                                             |
| R-08 | Etapas renomeadas quebram automação/relatório                                                                | fase por mapeamento (D-10); nenhuma regra Green lê nome/slug de etapa                                                                                                                        |
| R-09 | Central com CHECK fechado: cada aviso novo exige migration                                                   | agrupar os `kind` Green numa migration (DP-10)                                                                                                                                               |
| R-10 | Volume: gatilho AFTER por linha de contexto + evento por mudança                                             | um evento por transação com lista `changed`; sem fan-out por campo                                                                                                                           |
| R-11 | Leitor futuro interpreta `product_pipeline_binding.product_key` como produto da oportunidade                 | seção 16.3 e vocabulário 3.1: o valor é chave de processo; o produto só existe em `green_lead_context.product_id`; renomear/documentar a coluna entra em DP-01                               |
| R-12 | Expansão duplicada (importação repetida ou automação + manual para o mesmo ganho)                            | requisito de idempotência (seção 16.8, DP-12) obrigatório na tarefa da expansão; teste de "executar duas vezes cria uma"                                                                     |
| R-13 | Catálogo cresce e o quadro/relatório viram lista de produtos inativos                                        | `is_active` no catálogo; seleção na UI só de ativos; relatório agrupa por `code`                                                                                                             |
| R-14 | Produto desativado com oportunidades abertas                                                                 | desativar nunca apaga nem reatribui; a oportunidade mantém o `product_id`; aviso na UI                                                                                                       |

---

## 14. Primeira fatia vertical recomendada

### 14.1 GREEN-CRM-02 - Catálogo de Produtos Green e Contexto Comercial da Oportunidade (escopo alterado em 01.1)

> Um administrador cadastra os produtos Green da organização (catálogo aberto); um usuário abre uma oportunidade
> existente num funil Green e consegue **ver e editar o produto que está sendo trabalhado e o contexto comercial
> Green** (situação da análise, elegibilidade com origem e motivo, estágio de cadastro/ativação, distribuidora
> declarada e médias declaradas), persistido no servidor com RLS, com **evento de banco na mesma transação, entrada
> na timeline e auditoria**, e com o produto/fase visíveis no dossiê.

Escopo (banco -> backend -> UI):

1. **Banco (migration 0509, idempotente, com apêndice no `baseline.sql` e linha no MANIFEST):**
   - `public.green_product`: `id`, `organization_id`, `code` (único por organização), `name`, `description`,
     `family` (texto, padrão `generic`), `is_active`, `metadata jsonb NOT NULL DEFAULT '{}'`, `created_at`,
     `updated_at`; RLS tenant (`fn_user_org_ids()`), escrita exige papel >= `manager`; policies restritivas de
     suporte (padrão 0220);
   - `public.green_lead_context`: `lead_id` (PK), `organization_id`, FK composta `(lead_id, organization_id)` ->
     `crm_leads` no padrão da 0507 (criando o índice único correspondente se não existir), `ON DELETE CASCADE`;
     `product_id` NOT NULL, FK composta `(product_id, organization_id)` -> `green_product`; `analysis_status`,
     `eligibility`, `eligibility_source`, `eligibility_reason`, `enrollment_status` (CHECKs da seção 5.3);
     `attributes jsonb NOT NULL DEFAULT '{}'` (`declared_distributor`, `average_bill_cents`,
     `average_consumption_kwh` para família `energy`; perfil mínimo para `license`; vazio para `generic`; schema
     central em TS por `family`); `updated_by_user_id`, `created_at`, `updated_at`;
   - RLS: `tenant_isolation_green_lead_context_all` por `fn_user_org_ids()` **e** `fn_can_view_lead` (mesma
     visibilidade dos filhos do lead, como `crm_lead_activities` na 0042); escrita exige papel >= `agent`;
     policies restritivas de suporte (padrão 0220);
   - trigger BEFORE INSERT/UPDATE: lead da mesma organização e funil do lead vinculado (erro nomeado
     `green_context_outside_binding`); **nenhuma** comparação de produto com o binding;
   - trigger AFTER INSERT/UPDATE: `lead.green_context_changed` via `fn_log_event` (`entity_kind = crm_lead`,
     payload `{product_id, changed[], analysis_status, eligibility, enrollment_status}`), registrado como registro
     (`fn_event_log_e_registro`) até ter consumidor;
   - função `public.fn_green_pipeline_process(org, pipeline) returns text` só leitura (`security definer`, revogada
     de `public`/`anon`, concedida a `authenticated` e `service_role`) para a UI/API saberem se um funil é Green e
     qual processo ele implementa; segue o checklist de function `definer` (hardening, grants, pins);
   - **nenhuma** alteração em `crm_leads`, `crm_pipelines`, `crm_stages`, no schema `green`, nas migrations
     0501-0508 nem nas suítes seladas.
2. **Backend:**
   - `GET/POST /api/v1/green/products`, `PATCH /api/v1/green/products/[id]` (`requireRole("manager")`,
     `requireSupportWrite`, Zod, auditoria `green.product.updated`);
   - `GET /api/v1/leads/[id]/green-context` e `PATCH /api/v1/leads/[id]/green-context` (cria se não existir;
     `product_id` obrigatório na criação); `requireRole("agent")`, `requireSupportWrite` antes do efeito, Zod por
     `family` do produto (`lib/green/contexto/*`), `ok()`/`fail()`, erros canônicos
     (`green_context_outside_binding` -> 422, `green_product_inactive` -> 422);
   - timeline: tipo `green_context_changed` em `activity-vocabulary.ts` (constante, sem CHECK) emitido pelo handler
     com `actor_kind = user`; auditoria `green.lead_context.updated` em `AUDIT_ACTIONS`;
   - leitura do processo do funil pela função `fn_green_pipeline_process` (nunca `service_role` no handler sem
     filtro de organização);
   - sem MCP tool, sem automação, sem extensão, sem expansão, sem importação nesta fatia.
3. **UI:**
   - tela de catálogo em configurações (lista, criar, editar, ativar/desativar);
   - seção "Contexto Green" no `LeadDossier` (visível só quando o funil é Green), com seletor de produto (ativos),
     formulário por família, rótulos em português, e a chip de produto/elegibilidade no cabeçalho do dossiê; ajuda
     contextual na seção, no padrão de ajuda do repositório;
   - nenhuma mudança no card do quadro nesta fatia (chip de produto no card entra com a prioridade Green ou com o
     filtro por produto).
4. **Pré-requisito operacional:** binding semeado pelo dono do banco (SQL) para o funil de teste, com chave de
   processo (`conexao_green`); a UI de binding é DP-01. A fatia deve rodar com binding ausente (seção "Contexto
   Green" não aparece) sem erro, e com catálogo vazio (seção pede para cadastrar produto) sem erro.
5. **Documentação:** help do produto para o catálogo e a seção, atualização deste documento (estado), e
   `docs/green/product/` como lar dos documentos de produto Green.

### 14.2 Por que esta fatia vem primeiro

| Critério                                | Como atende                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| valor real para a operação              | hoje nada no CRM diz **o que** está sendo vendido numa oportunidade nem se ela é elegível ou em que ponto está a análise; o operador anota em texto livre ou tag                                                                               |
| atravessa banco -> backend -> UI        | duas tabelas + RLS + trigger + evento; rotas + Zod + auditoria; catálogo e seção no dossiê                                                                                                                                                     |
| pequena e controlável                   | duas tabelas, uma função de leitura, quatro rotas, uma tela de catálogo e uma seção de UI; nenhuma tabela do upstream alterada                                                                                                                 |
| valida a arquitetura de produto         | prova o padrão que todas as entidades Green seguintes usam: `public.green_*` 1:1 sobre `crm_leads`, pertencimento pelo binding, produto independente do funil, evento de banco, timeline, RLS com visibilidade do lead, vocabulário CHECK + TS |
| desbloqueia o resto                     | expansão (precisa saber o produto de A e de B), dashboard por produto, regra de upsell por produto e importação por produto dependem de `product_id` existir                                                                                   |
| sem integração externa                  | nenhuma                                                                                                                                                                                                                                        |
| sem dados regionais                     | elegibilidade e distribuidora são declaradas (`eligibility_source = manual`); as FKs regionais entram depois, aditivas                                                                                                                         |
| prepara as próximas sem overengineering | frentes B, D, E, H, I, L e G leem/escrevem este contexto; a fase (4.3), a conta (4.5) e os itens adicionais (DP-13) entram como FKs/tabelas aditivas                                                                                           |
| termina em algo utilizável              | o gestor cadastra os produtos; o operador abre a oportunidade, escolhe o produto e registra a análise; o gestor vê na timeline quem mudou o quê e quando                                                                                       |

### 14.3 Alternativas consideradas para a primeira fatia

| Fatia                                                             | Por que não agora                                                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contexto Green **sem** catálogo (versão anterior da GREEN-CRM-02) | nasceria com `product_key` CHECK `energy`/`license` e trigger "produto = binding", as duas premissas que a revisão 01.1 removeu; teria de ser refeita na fatia seguinte |
| Binding administrável (UI + RPC)                                  | utilizável por administrador, não por operador; abre escrita num objeto cujo contrato selado diz "só o dono escreve" (ADR primeiro, DP-01)                              |
| Funis Green de fábrica                                            | semente + configuração; não persiste nada novo da oportunidade, então não valida o padrão de extensão; depende de DP-01 e DP-04                                         |
| Expansão pós-ganho / importação por período                       | depende de o produto existir na oportunidade (A e B); é a candidata natural a GREEN-CRM-04, depois do catálogo e da fase                                                |
| Pendências do dia / follow-up vencido                             | valor alto, mas é CRM genérico: não valida nada do domínio Green; fica como primeira entrega da frente F/I                                                              |
| Integração ConectorZap                                            | integração externa (critério 5) e exige identidade de instalação, livro de abordagens e módulo com nome próprio (DP-06)                                                 |
| Inteligência regional mínima                                      | depende de dados que ainda não temos (critério 6)                                                                                                                       |

---

## 15. Critérios de aceite da futura GREEN-CRM-02

Definição de pronto do produto (`CLAUDE.md`): implementação, testes, autorização/tenancy verificadas, activity/event,
documentação, permissões descritas, migration versionada, nenhum segredo, gates verdes.

**Banco e tenancy (TDD obrigatório)**

1. `tests/invariants/green-product.test.ts` e `green-lead-context.test.ts`: duas organizações; membro da org A não
   lê nem escreve produto ou contexto da org B (RLS); `agent` com `visibility_mode = own` não lê contexto de lead
   que não é dele; `manager` lê; `agent` não cria produto, `manager` cria.
2. INSERT/UPDATE de contexto em lead de funil **sem** binding falha com `green_context_outside_binding`; com
   `product_id` de outra organização falha pela FK composta; com lead de outra organização falha pela FK composta;
   lead em funil com qualquer chave de processo aceita qualquer produto ativo da organização.
3. Cada INSERT/UPDATE comitado gera **um** `lead.green_context_changed` na mesma transação (rollback gera zero), com
   `entity_kind = crm_lead`, payload sem PII e `changed[]` correto (inclui `product_id` quando muda); o evento nasce
   `done` (registro) e não carrega marcas canônicas reservadas.
4. CHECKs de vocabulário batem com a constante TS (`vocabulario-banco-x-typescript`); `family` desconhecida é aceita
   pelo banco e cai no schema `generic` no TS.
5. `fn_green_pipeline_process` não é alcançável por `anon`; passa em `hardening-definer-varredura`.
6. `test:db` inteira verde; suítes Green seladas (`green-*`) e E2Es Green inalterados e verdes; `baseline.sql`
   fresh install e update aplicam a 0509 sem erro.

**Backend**

7. `PATCH` do contexto por `viewer` -> 403; por `agent` do lead -> 200; `requireSupportWrite` presente (cerca de
   cobertura de efeitos); Zod rejeita chave desconhecida em `attributes` e valor fora do vocabulário (422);
   idempotente para o mesmo corpo; produto inativo -> 422 `green_product_inactive`.
8. Uma linha em `api_audit_log` (`green.lead_context.updated` / `green.product.updated`) e uma atividade
   `green_context_changed` por mutação bem-sucedida do contexto, com `actor_kind = user`.
9. `GET` em lead de funil não Green responde 404 nomeado (`green_context_not_applicable`), não 500.

**UI e E2E**

10. Playwright: cadastrar produto -> abrir oportunidade de funil Green -> seção "Contexto Green" visível ->
    escolher produto, editar elegibilidade e situação -> recarregar -> valores persistidos -> timeline mostra a
    entrada com autor. Em funil comum a seção não existe. Produto desativado não aparece no seletor, mas a
    oportunidade que já o tinha continua mostrando o nome.
11. Ajuda contextual na seção e no catálogo, no padrão de ajuda do repositório (esta base não tem HelpHint nem help
    key; a convenção vem do v0 e fica a critério da GREEN-CRM-02).

**Governança**

12. Nenhuma alteração em `crm_leads`, `crm_pipelines`, `crm_stages`, schema `green`, migrations 0501-0508,
    `tests/invariants/green-*` existentes; `pnpm gov:verify` e `lint:channels` verdes; migration 0509 com timestamp
    novo na sequência do ConectorGreen e sem colisão.
13. Este documento atualizado com o estado da GREEN-CRM-02 e as decisões que ela fechar.

---

## 16. Revisão GREEN-CRM-01.1 - Produto, Funil e Expansão

Revisão de 2026-10-07. Entrada: as decisões de produto já tomadas (funil = processo; produto = dado estruturado;
tag = segmentação; nenhum "um funil por produto"; o catálogo cresce sem novos funis). Nenhum código, schema,
endpoint, UI ou workflow foi alterado por esta revisão.

### 16.1 Premissas removidas da primeira versão

| #   | Onde estava               | Premissa errada                                                                                                                                                                                                  | O que ficou no lugar                                                                    |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | seção 1 (objetivo)        | "duas frentes de negócio" (energia, licença) como o universo do produto                                                                                                                                          | catálogo aberto de produtos; dois funis por processo (seção 1, 6)                       |
| 2   | seção 2.3 (binding)       | binding = "funil Green de produto X"; "um funil tem no máximo um produto"                                                                                                                                        | binding = pertencimento + chave de processo; o produto está na oportunidade (16.3)      |
| 3   | seção 3.1 (vocabulário)   | "Oportunidade (Green) = um negócio de um produto Green... num funil vinculado a um produto"; "Produto Green = `energy` ou `license`, é o `product_key` do binding"; "Funil Green = funil com binding de produto" | oportunidade declara o produto; produto = linha do catálogo; funil = processo (3.1)     |
| 4   | seção 3.3                 | "Produto Green (`energy`, `license`)... vira vocabulário fechado (D-02). Catálogo em tabela só quando houver terceiro produto"                                                                                   | catálogo em tabela desde a primeira fatia; sem enum (3.3, 4.1, D-02)                    |
| 5   | seção 4.1 (contexto)      | "trigger... exige `product_key` igual ao do binding do funil do lead"                                                                                                                                            | trigger só exige funil vinculado; `product_id` livre dentro da organização (4.2)        |
| 6   | seção 4.3 (fábrica)       | "cria... o funil de `energy` e o de `license`"                                                                                                                                                                   | cria os funis ConexãoGreen e Expansão e semeia o catálogo (4.4)                         |
| 7   | seção 4.6                 | "oportunidade `license` ganha"                                                                                                                                                                                   | oportunidade cujo produto é da família licença (4.8)                                    |
| 8   | seção 5.1 (fases)         | colunas de exemplo "Energy" / "License" (etapas por produto)                                                                                                                                                     | colunas "ConexãoGreen" / "Expansão" (etapas por processo) (5.1)                         |
| 9   | seção 5.2                 | "Não para `energy`... Para `license`..." (ponto de `won` por funil-produto)                                                                                                                                      | ponto de `won` por família de produto (5.2, DP-04)                                      |
| 10  | seção 5.3                 | `product_key` com valores `energy`, `license` e CHECK                                                                                                                                                            | `green_product.family` aberto; `product_id` FK (5.3)                                    |
| 11  | seção 6 inteira           | "Economia e Licenciado = dois produtos, um funil por produto por organização"; "a base já decidiu que produto é o que torna um funil Green"; "terceiro produto = novo funil de fábrica"                          | funil = processo; produto na oportunidade; novo produto não exige funil (6, D-03, D-16) |
| 12  | seção 6.4                 | ConexãoGreen e licença tratados como os produtos                                                                                                                                                                 | ConexãoGreen e Expansão são funis (processos); nenhum deles é produto (6.4)             |
| 13  | seção 9.2                 | "produto" da oportunidade lido do binding                                                                                                                                                                        | lido de `green_lead_context.product_id` (9.2)                                           |
| 14  | seção 10.3                | `green_lead_context (product_key = binding do funil)`                                                                                                                                                            | `product_id -> green_product` (10.3)                                                    |
| 15  | seção 11, D-02            | "Produto Green é vocabulário fechado `energy` \| `license`"                                                                                                                                                      | D-02 revisado: catálogo aberto                                                          |
| 16  | seção 11, D-03            | "um funil por produto por organização"                                                                                                                                                                           | D-03 revisado: funil = processo                                                         |
| 17  | seção 13, R-02            | "com produto diferente do binding"                                                                                                                                                                               | R-02 revisado: só pertencimento                                                         |
| 18  | seção 14.1 (GREEN-CRM-02) | `product_key CHECK (energy, license)`; erro `green_context_product_mismatch`; `fn_green_pipeline_product`                                                                                                        | catálogo + `product_id`; `fn_green_pipeline_process`; sem mismatch (14.1)               |
| 19  | seção 15, critério 2      | "com `product_key` diferente do binding falha"                                                                                                                                                                   | qualquer produto ativo da organização é aceito (15.2)                                   |
| 20  | anexo B                   | "catálogo global de produtos `energy`/`license`/..." lido como fechado                                                                                                                                           | lido como intenção de catálogo aberto (anexo B)                                         |

Nenhuma dessas ocorrências permanece com o texto antigo; as seções foram reescritas.

### 16.2 Conceitos canônicos

| Conceito     | Definição final                                                                                                                                                                                                    | Na base                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Contato      | pessoa ou empresa. Pode possuir várias oportunidades ao longo do tempo e ao mesmo tempo                                                                                                                            | `contacts`, `companies`           |
| Oportunidade | `crm_leads` continua sendo a identidade da oportunidade comercial. Não existe segundo "Green Lead". Uma mesma pessoa pode possuir simultaneamente oportunidades diferentes (funis diferentes, produtos diferentes) | `crm_leads`                       |
| Funil        | jornada / processo operacional: Novo -> Contato -> Qualificação -> Proposta -> Negociação -> Ganho / Perda. O produto **não** determina esse processo                                                              | `crm_pipelines` + `crm_stages`    |
| Produto      | item / oferta estruturada do catálogo Green. Catálogo com quantidade aberta de produtos; sem enum fechado `energy`/`license` como arquitetura. Exemplos reais não precisam ser inventados agora                    | `green_product` (proposto)        |
| Tag          | metadado de segmentação (alta prioridade, indicação, base outubro, cliente ativo, campanha específica, reativação). **Não** substitui produto. **Não** substitui funil                                             | `crm_leads.tags`, `contacts.tags` |

### 16.3 O binding como chave de processo

`green.product_pipeline_binding.product_key` é texto livre e **nenhum código interpreta o valor** (seções 2.3 e
6.2): a fundação só o usa para dizer "este funil é Green" e o copia para a lápide de `lead.deleted`. Esta revisão
fixa a leitura do valor como **chave do processo** que o funil implementa (`conexao_green`, `expansao`), e não como
produto. O nome da coluna é legado de uma fase em que se supunha "um funil por produto"; renomeá-la é alteração de
migration selada e entra junto com a escrita administrável do binding (DP-01, ADR `GREEN-002`). Até lá, toda
documentação e todo código novo chamam esse valor de **processo** (`fn_green_pipeline_process`), nunca de produto.

### 16.4 Catálogo de produtos: modelo recomendado

- **Tabela:** `public.green_product` (seção 4.1), por organização no V1, com `code` estável e único por
  organização, `name`, `description` opcional, `family` (seletor de schema de atributos, aberto), `is_active`,
  `metadata jsonb` só se um atributo real aparecer.
- **Escopo A/B/C:** decisão adiada (DP-11) por falta de evidência; o V1 por organização com `code` estável é
  compatível com as três (catálogo global futuro = tabela de referência + `global_product_id` aditivo).
- **`catalog_products` recusado** (seção 2.12): é mercadoria de loja com preço e estoque obrigatórios, sincronizada
  com e-commerce e pesquisada pelo agente de IA; reutilizá-lo contaminaria propostas e busca. Uma ponte opcional
  (`green_product.catalog_product_id`) pode entrar depois se uma oferta Green virar item de proposta.
- **Família x catálogo:** `family` existe só para escolher o schema de `attributes` e a análise aplicável; não limita
  quantos produtos existem e não é lida como "tipo de funil". Produto de família desconhecida funciona com schema
  `generic`.

### 16.5 Oportunidade x produto: cardinalidade recomendada

| Alternativa                               | Avaliação pelos critérios (simplicidade, relatório, bundle, upsell, cross-sell, histórico, reversibilidade, complexidade)                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 1 oportunidade -> exatamente 1 produto | mais simples de operar e de reportar ("ganhos por produto" sem ambiguidade); upsell e cross-sell já são **oportunidades novas** (D-15), então não precisam de N produtos na mesma linha; `value_cents` do lead continua único; sem bundle hoje |
| B. 1 oportunidade -> N produtos (N:N)     | resolve bundle, mas sem evidência de bundle; relatório de ganho por produto vira rateio; a UI precisa de "qual é o principal"; reversível só com migração de dados                                                                             |
| C. 1 principal + adicionais               | é A com uma tabela aditiva; o principal fica na linha 1:1 (`product_id`) e os adicionais numa tabela filha; relatório continua pelo principal; bundle vira possível sem mexer no que já existe                                                 |

**Recomendação (D-17): A agora, evoluível para C.** `green_lead_context.product_id` é o produto principal,
obrigatório numa oportunidade Green. Quando houver um combo real, entra `green_lead_product_item (lead_id,
product_id, quantity, note)` de forma aditiva (DP-13); o **produto principal continua sendo o da linha 1:1**, e é por
ele que relatório, regra de expansão e importação por produto agrupam. Nenhuma linha existente precisa migrar. N:N
desde já foi recusado por não haver evidência e por tornar o relatório ambíguo sem necessidade.

### 16.6 Ganho, perda e métricas

**O que já existe e é reutilizado (D-06, D-20):** etapas `is_won`/`is_lost` (no máximo uma de cada por funil);
`fn_crm_lead_close_on_stage` deriva `status = won`/`lost` e grava `closed_at`; `won_reason` (0420, opt-in por funil)
e `lost_reason` (obrigatório em `lost`); `fn_emit_event_on_lead_change` emite `lead.won`/`lead.lost`; timeline de
fechamento; `fn_attendant_metrics(p_org, p_from, p_to, p_owner)` conta ganhos e perdas por atendente com `closed_at`
no período e exclui a transferência administrativa; forecast por `value_cents` x `win_probability`. O ConectorGreen
**não cria** segundo sistema de status para representar ganho.

**Dashboard Green (futuro, não implementado):** read models (função SQL + tela) sobre `crm_leads` +
`green_lead_context` + binding + `crm_lead_links`, com filtro/agrupamento por: período personalizado (`closed_at` ou
`created_at`), funil, produto, responsável, origem (`source`), campanha (`source_metadata`/UTM), ganho/perda e,
eventualmente, região (quando existir `green_energy_account`/catálogo regional). Indicadores candidatos:
oportunidades criadas; ganhos; perdas; taxa de conversão; ganhos por produto; ganhos por vendedor; ganhos por origem;
ganhos por campanha; tempo médio até ganho (`closed_at - created_at`); conversão ConexãoGreen -> Expansão (ganhos em
ConexãoGreen que têm pelo menos uma oportunidade com `commercial_origin` apontando para eles, e quantas dessas
ganharam).

### 16.7 Pós-ganho e expansão (D-15)

```text
OPORTUNIDADE A                      OPORTUNIDADE B
Contato João                        mesmo contato João
Funil ConexãoGreen       pode       Funil Expansão
Produto X               gerar  ->   Produto Y (pode ser diferente de X)
status = won                        status = open
closed_at = t0                      crm_lead_links: B -> A, link_kind = commercial_origin
```

- A **não é movida**. B é uma oportunidade nova (`createLeadHandler`, `source` próprio, mesmo `contact_id`). A
  continua `won`, com `closed_at` e `won_reason` imutáveis em seu significado histórico.
- **Upsell automático (requisito futuro, frente H/L):** ao ganhar uma oportunidade, regras poderão `create`
  (criar B automaticamente no funil Expansão), `suggest` (aviso na Central / tarefa "criar expansão") ou `none`,
  por configuração da organização. O produto de B pode ser diferente do de A. **Nunca** hardcoded "ganhou X ->
  sempre Y": a relação X -> Y é dado de configuração (seção 4.7), candidata a `automation_rules` com gatilho `lead.won`
  (já emitido) + condição por produto/funil + ação nova `create_expansion_opportunity`.
- Quem cria B é um writer de lead em funil Green: precisa do boundary (R-04) e da idempotência (16.8).

### 16.8 Relação entre oportunidades e importação de ganhos por período

**Mecanismo escolhido para "B nasceu comercialmente de A":** `crm_lead_links` com `lead_id = B`, `target_kind =
lead`, `target_id = A`, `link_kind = commercial_origin`, `metadata.reason` em `expansion` / `cross_sell` / `upsell`
e `metadata.created_via` em `automation` / `period_import` / `manual`. Avaliação dos mecanismos existentes:

| Mecanismo                       | Significado real                                                                                                                                        | Serve?                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `crm_leads.retomado_de_lead_id` | nova **tentativa** de um negócio **encerrado** (`reabertura.ts`, "quantas tentativas até fechar")                                                       | **não**: A está ganha, B não é tentativa de A; usar aqui corromperia a métrica de retomada |
| `source_metadata.clonado_de`    | **troca de funil**: a origem é encerrada com `moved_to_another_pipeline` (`clonar-para-funil.ts`)                                                       | **não**: A não é encerrada nem transferida                                                 |
| `crm_lead_links (lead -> lead)` | vínculo polimórfico entre lead e outra entidade, `target_kind = lead` já no CHECK, `link_kind` aberto, `metadata`, único por quádrupla, RLS, org-scoped | **sim**: representa exatamente "B tem origem comercial em A" sem nova estrutura            |

Nenhuma relação nova é criada; o `link_kind` é vocabulário TS (constante, como `VINCULO_DE_AGENDAMENTO =
"scheduled"`).

**Importação de ganhos por período (caso de uso, não implementado):** o usuário escolhe data inicial, data final,
funil de origem e, opcionalmente, produto, responsável e origem/campanha. O sistema lista oportunidades com `status
= won` e `closed_at` dentro do período (mesma janela de `fn_attendant_metrics`). O usuário escolhe "Adicionar à
Expansão" com um produto-alvo (ou mantém o de origem) e, opcionalmente, etapa inicial, tags e responsável; o sistema
cria uma oportunidade B por contato, no funil Expansão, com vínculo `commercial_origin` e `source =
expansao` (vocabulário aberto de `source`), e registra a operação em auditoria.

**Requisito de idempotência (obrigatório):** executar a mesma operação duas vezes (mesmo período, mesmo funil, mesmo
produto-alvo) **não cria duplicatas**: para cada A já com uma B viva (aberta) ligada por `commercial_origin` com o
mesmo produto-alvo, a execução pula e relata "já existe". A chave exata fica para a tarefa (DP-12); candidatas:
`crm_leads.external_id` único por `(organization_id, source, external_id)` com `source = expansao` e `external_id =
<A.id>:<product.code>`, que a base já garante por índice; ou verificação pelo vínculo + produto + status antes do
insert, sob o mesmo advisory lock do `createLeadHandler`. O mesmo requisito vale para a automação pós-ganho (16.7) e
para a convivência automação + importação + manual (R-12).

### 16.9 Fontes de leads / entradas automáticas

Camada conceitual, inteiramente sobre o que existe (D-19): `webhook_sources` (token de caminho, `default_pipeline_id`,
`default_stage_id`, `field_map`, segredo), webhook inbound `app/api/v1/webhooks/in/[token]` com reconhecimento de RD
Station e Respondi, histórico `webhook_lead_captures` (campos, `utm`, desfecho, dedup por telefone), `custom_fields`
do lead e do contato, UTM em `source_metadata`, importação CSV, WhatsApp inbound (`fn_nascer_lead_da_conversa`),
voz, prospecção, campanhas, MCP, automação e criação manual. **Nenhum mecanismo paralelo Green** de ingestão: toda
fonte converge para **contato + oportunidade** pelos writers existentes, que o boundary Green já cobre quando o
funil é Green. O que o Green acrescenta é só a declaração de produto na oportunidade (pode vir de `field_map` /
coluna da planilha / regra da fonte no futuro) e o funil/etapa de destino configurados por fonte, que já existem.

```text
PLANILHA ──────────────┐
META / GOOGLE ─────────┤
LANDING / SITE ────────┤
RD STATION / RESPONDI ─┤
ORGÂNICO ──────────────┤
WHATSAPP ──────────────┤
INDICAÇÃO ─────────────┘
          │
          ▼
       CONTATO          (contacts: reaproveitado por telefone/identidade)
          │
          ▼
     OPORTUNIDADE       (crm_leads: source, source_metadata, external_id, tags)
          │
          ▼
        FUNIL           (pipeline/stage configurados na fonte, no import ou manualmente)
          │
          ▼
       PRODUTO          (green_lead_context.product_id)
```

### 16.10 Tráfego pago

```text
META / GOOGLE / OUTRAS FONTES
  -> landing / formulário / provider (RD Station, Respondi, site próprio)
  -> entrada automática (webhook_sources + /webhooks/in/[token]) ou clique-para-WhatsApp (referral / ctwa_clid)
  -> contato (atribuição de anúncio no primeiro toque; UTM em source_metadata / webhook_lead_captures.utm)
  -> oportunidade (source = meta_ads / google_ads / site / webhook; source_metadata com campanha)
  -> funil / etapa configurados na fonte
```

- **A. Tráfego que chega a uma landing/formulário nosso:** a fundação já existe em grande parte: `webhook_sources`
  com `field_map`, dedup, histórico com UTM, `meta_ads_landing_pages` e `meta_ads_click_refs` (clique com UTM que
  vira mensagem de WhatsApp), atribuição `meta_ads` pelo `referral` do WhatsApp, relatório de conversão de volta
  para Meta (CAPI) e Google. Falta só o produto na oportunidade (GREEN-CRM-02) e, se desejado, um campo de produto
  no `field_map`.
- **B. Lead Ads nativo de plataforma (formulário dentro do Meta/Google):** **não há evidência** de ingestão na base
  (`leadgen_grouped` em `tabela-de-campanhas.ts` é rótulo de métrica de campanha, não um receptor). Integração
  específica poderá ser necessária (DP-14); quando entrar, desemboca no mesmo caminho de `webhook_sources` ou num
  adapter de `lib/plataformas-de-anuncio/`, nunca num writer Green próprio.

### 16.11 Tráfego orgânico e importação por planilha

**Entradas orgânicas:** formulário do site, landing, RD Station, Respondi, WhatsApp (número conectado ao servidor),
Instagram/DM (futuro, canal), criação manual. Todas convergem para contato + oportunidade sem duplicar identidade
(reaproveitamento por telefone/identidade do contato; advisory lock do writer).

**Importação CSV (já existe, `POST /api/v1/leads/import`):** CSV com colunas fixas `nome, nome do contato, telefone,
email, valor, origem, tags, observacao`; escolha do funil (`pipeline_id`) e etapa opcional (`stage_id`; sem ela,
entra na primeira etapa aberta); reaproveita contato por telefone (variantes BR) e cria quando não existe; `source`
por linha com padrão `importacao_planilha`; erros por linha sem derrubar o lote; modelo de planilha para download.
Não se redesenha isso.

**Evolução proposta (futuro, DP-15): mapeamento de colunas.** O usuário aponta cada coluna da planilha para um
destino: `contact.name` ("Nome Cliente"), `contact.phone` ("Whats"), `custom_field:cidade` ("Cidade"), campo Green
correspondente ("Valor Fatura" -> `attributes.average_bill_cents` do contexto), `source` ("Origem da Lista"),
`custom_field:segmento` ("Segmento"), `product` (código do catálogo). Para o lote inteiro o usuário define funil,
etapa inicial, origem padrão, tags e campos padrão (inclusive produto padrão). A rota atual é a base; o mapa é um
parâmetro novo do mesmo importador, não um importador novo.

### 16.12 Origem, campanha, UTM e tags (D-18)

| Conceito | O que é                                                                                                                              | Onde vive                                                                                                                       | Não é                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Origem   | por onde entrou: `meta_ads`, `google_ads`, `organic`/`site`, `referral`, `spreadsheet`/`importacao_planilha`, `whatsapp`, `expansao` | `crm_leads.source` (vocabulário aberto, com constantes TS), `contacts.source`                                                   | tag                    |
| Campanha | a campanha específica dentro da origem                                                                                               | `source_metadata` do lead/contato (atribuição de anúncio: `adId`, campanha), `webhook_lead_captures.utm`, `meta_ads_click_refs` | funil, tag             |
| UTM      | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`                                                                | `webhook_lead_captures.utm`, `contacts.source_metadata`, `meta_ads_click_refs.utm`                                              | custom field           |
| Tag      | segmentação livre                                                                                                                    | `crm_leads.tags`, `contacts.tags`                                                                                               | origem, produto, funil |

Isso permite as métricas por origem e por campanha do Dashboard Green (16.6) sem depender de tag.

### 16.13 Impacto em `green_lead_context`

A proposta continua válida como extensão 1:1 da oportunidade, com a separação explícita:

| Letra | Pertence a                         | Onde                                                                                                             |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A     | contexto comercial da oportunidade | `green_lead_context` (análise, elegibilidade, cadastro/ativação, snapshots da análise, `attributes` por família) |
| B     | produto                            | `green_product` (catálogo)                                                                                       |
| C     | relação oportunidade-produto       | `green_lead_context.product_id` (principal); `green_lead_product_item` (adicionais, futuro)                      |
| D     | origem / atribuição                | `crm_leads.source`, `source_metadata`, `external_id`; `contacts.source_metadata`; `webhook_lead_captures`        |
| E     | dados regionais                    | catálogos globais (4.6) e `green_energy_account` (4.5); no contexto só FKs opcionais e snapshots aplicados       |
| F     | tags                               | `crm_leads.tags`, `contacts.tags`                                                                                |

`green_lead_context` **não** guarda origem, campanha, UTM, tag, o catálogo nem a lista de produtos adicionais.

### 16.14 Diagrama canônico

```text
                        CONTACT (João)
                            │
             ┌──────────────┴──────────────┐
             │                             │
       OPPORTUNITY A                 OPPORTUNITY B
       (crm_leads)                   (crm_leads)
             │                             │
     FUNIL CONEXÃOGREEN              FUNIL EXPANSÃO
     (pipeline, processo)            (pipeline, processo)
             │                             │
         PRODUTO X                     PRODUTO Y
   (green_lead_context.product_id)  (green_lead_context.product_id)
             │                             │
            WON                          OPEN
   (status, closed_at, won_reason)         │
             │                             │
             └──── origem comercial ───────┘
        crm_lead_links: B -> A, link_kind = commercial_origin
```

### 16.15 GREEN-CRM-02: manter ou alterar

**ALTERAR GREEN-CRM-02.** A versão anterior ("Contexto Comercial Green da Oportunidade") nasceria com `product_key`
CHECK `energy`/`license` e com o trigger "produto = binding", exatamente as duas premissas removidas; implementá-la e
depois refazê-la custaria uma migration a mais sobre uma tabela que já teria dados. À luz do catálogo, da
oportunidade x produto, do funil independente do produto, da expansão futura, das fontes de leads e do ganho, a
menor fatia que entrega valor e não precisa ser desfeita é **"Catálogo de Produtos Green e Contexto Comercial da
Oportunidade"** (seção 14.1): o catálogo é pequeno (uma tabela, quatro rotas, uma tela), o contexto já estava no
escopo, e `product_id` é o que a expansão, o dashboard por produto, a regra de upsell e a importação por produto
precisam encontrar pronto. Sequência prevista depois dela: GREEN-CRM-03 (fase por etapa + funis de fábrica, com
ADR de binding) e GREEN-CRM-04 (expansão: regra pós-ganho + importação por período + idempotência).

---

## 17. Decisões canônicas

- **FUNIL != PRODUTO.** Funil é processo comercial; produto é o que está sendo vendido. O produto não determina o
  funil e o funil não determina o produto.
- **PRODUTO != TAG.** Produto é dado estruturado do catálogo (`green_product`), referenciado por FK; tag é
  segmentação livre.
- **CONTATO != OPORTUNIDADE.** Contato é a pessoa/empresa; oportunidade é `crm_leads`. Um contato tem N
  oportunidades.
- **GANHO NÃO MOVE A OPORTUNIDADE PARA EXPANSÃO.** A oportunidade ganha continua `won`, no funil onde ganhou.
- **EXPANSÃO CRIA NOVA OPORTUNIDADE.** Ligada à de origem por `crm_lead_links (commercial_origin)`, com o produto que
  está sendo trabalhado, que pode ser diferente do original.
- **A MESMA PESSOA PODE TER MÚLTIPLAS OPORTUNIDADES**, simultâneas, em funis e produtos diferentes.
- **UM PRODUTO NOVO NÃO EXIGE FUNIL NOVO.** Novo funil só com diferença material de processo (seção 6.5).
- **CLOSED_AT É A REFERÊNCIA TEMPORAL DE GANHO/PERDA** em relatório, importação por período e automação.
- **FONTES DE LEADS DEVEM CONVERGIR PARA O MESMO MODELO DE OPORTUNIDADE**: contato + `crm_leads` pelos writers
  existentes, sem mecanismo paralelo.

---

## Anexo A - O que foi lido nesta baseline

Schema: `supabase/baseline.sql` (tabelas `crm_leads`, `crm_pipelines`, `crm_stages`, `crm_lead_activities`,
`crm_lead_links`, `contacts`, `companies`, `people`, `organizations`, `user_organizations`, `crm_tasks`,
`calendar_appointments`, `followup_*`, `automation_rules`, `event_log`, `agent_inbox_items`, `campaigns`,
`conversations`, `messages`, `channel_sessions`, `crm_lead_scores`, `crm_lead_risk_states`, `crm_proposals`,
`crm_proposal_items`, `catalog_products`, `webhook_sources`, `webhook_lead_captures`, `meta_ads_landing_pages`,
`meta_ads_click_refs`; funções `fn_attendant_metrics`, `fn_atrito_metrics`, `fn_relatorio_financeiro`), migrations
0501-0508 e MANIFEST.

Código: `app/api/v1/leads/_handler.ts`, `app/api/v1/leads/import/route.ts`, `app/api/v1/webhooks/in/[token]/route.ts`,
`lib/leads/*` (inclusive `reabertura.ts`, `clonar-para-funil.ts`, `atribuicao-de-anuncio.ts`, `planilha.ts`),
`lib/webhooks/*` (`inbound.ts`, `captacao.ts`, `rdstation.ts`, `respondi.ts`), `lib/plataformas-de-anuncio/*`,
`lib/pipelines/pipeline-editing.ts`, `lib/onboarding/pacotes-de-funil.ts`, `lib/schemas/{leads,settings,webhooks}.ts`,
`lib/tarefas/*`, `lib/followup/*`, `lib/automation/*`, `lib/event-log/*`, `lib/audit/*`,
`lib/auth/{require-role,server}.ts`, `lib/api/auth-dual.ts`, `lib/channels/*`, `lib/waha/ingest.ts`,
`lib/channels/pos-entrada.ts`, `lib/leads/nascimento-do-lead.ts`, `lib/agenda/tipos.ts`, `lib/green/*`,
`components/kanban/*`, `app/app/{pipelines,tasks,ai/inbox,webhooks}/*`.

Documentação: `CLAUDE.md`, `AGENTS.md`, `docs/green/*`, `docs/adr/GREEN-001-*`, `docs/spike/GREEN-*`,
`docs/business-rules/00-business-rules-catalog.md` (P-01..P-08), `docs/specs/17-spec-conversa-vira-lead.md`,
`docs/prd/04-prd-pipeline-attendance.md`.

## Anexo B - Decisões herdadas do Conector Green v0 (repositório `conector-green`, antes `growth-os`)

Reaproveitadas como **intenção de produto**, não como schema: ADR-004 (workspace = tenant; role, permission e scope;
hierarquia comercial não é ACL), ADR-005 (contato, empresa, conta de energia, captura, oportunidade de um produto;
catálogo de produtos com `energy`/`license` como primeiros itens de uma lista **aberta**; PF/PJ sem documento;
cross-sell = oportunidade nova), ADR-012 e PD-011/PD-012/PD-013 (etapas de exemplo, ponto de `won`, perdas), RAD-027
(pós-venda do licenciado fora do funil), RAD-008 (parceiro e rede), ADR-016 e ADR-017 e o contrato Conector Green x
ConectorZap (dois canais, token de instalação, abordagem com claim e desfecho, funis locais, PC desligado).

O que **não** se transfere: o schema (`workspace_*`, `opportunity`, `product_stage` global por produto), porque na
base Deskcomm o funil é por organização e a oportunidade é `crm_leads`; e a leitura "funil por produto" que o v0
sugeria com `product_stage`: aqui o funil é processo, o produto é dado da oportunidade (seção 16), a fase por etapa
dá a identidade estável e o contexto 1:1 guarda o que é iGreen.
