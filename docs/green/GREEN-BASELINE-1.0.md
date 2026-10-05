# GREEN-BASELINE-1.0 - Fundação do ConectorGreen

Fonte de verdade da fundação do ConectorGreen. O que este documento afirma foi provado pelas cinco frentes Green e
pela regressão da baseline ([`VALIDATION-CLOSURE.md`](VALIDATION-CLOSURE.md)); o que falta para produção está em
[`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md); a política de upstream está na
[ADR-GREEN-001](../adr/GREEN-001-deskcomm-fundacao-congelada.md).

## 1. Identidade

| Item                      | Valor                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Produto                   | ConectorGreen                                                                                            |
| Baseline                  | GREEN-BASELINE-1.0                                                                                       |
| Ancestral                 | Deskcomm (`melgarafael/DeskcommCRM`, MIT) v1.69.0                                                        |
| Commit upstream congelado | `e8e2912178031d321caf0912b270ee06bd2c36c7` (merge do PR #2025, `release/1.69.0`)                         |
| Commit Green candidato    | `38e2f16cd987ff3b627dbb266ed9631a142cf486` (topo da cadeia Green; fonte de `release/green-baseline-1.0`) |
| Repositório               | `alves87daniel/DeskcommCRM`                                                                              |
| Cadeia Green              | migrations 0501-0508, 50 commits sobre a v1.69.0                                                         |
| Data                      | 2026-10-04                                                                                               |
| Tag                       | `GREEN-BASELINE-1.0`, no merge commit da adoção na `main`                                                |

## 2. Decisão

> O Deskcomm v1.69.0 foi validado como fundação histórica do ConectorGreen.
> A fase de avaliação de compatibilidade está encerrada.

O ConectorGreen não segue o upstream do Deskcomm: observa as releases e porta seletivamente o que tiver benefício
concreto ([ADR-GREEN-001](../adr/GREEN-001-deskcomm-fundacao-congelada.md)). Esta baseline é **arquitetural**: ela
libera a construção do produto, e não é uma promessa de produção GA.

## 3. O que foi validado

Cada linha foi provada com a mesma suíte rodando na base e na spike (vermelha antes, verde depois) e, onde o caminho
existe, pelo PostgREST real e pelo servidor Next real. As seções citadas são dos relatórios em `docs/spike/`.

| Garantia            | O que está provado                                                                                                                                                                                                              | Onde                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mutation context    | Toda escrita privilegiada em lead Green declara contexto no ponto de entrada; sem contexto, o banco recusa (`42501 green_mutation_context_required`): fail-open no seam, fail-closed no banco                                   | MC1 §9; MC2 §2; MC3 §3                                                                |
| Trusted × advisory  | Ator humano vem de `auth.uid()`, nunca do header; `request_id` confiável nasce no servidor (`randomUUID`), o do cliente vira `client_request_id` advisory; campos advisory não controlam o motor                                | MC2; MC3 (ADV-04); LC12 (LIFE-ADV-02)                                                 |
| Mutation boundary   | Um hook AFTER INSERT/UPDATE/DELETE em `crm_leads` (`green.fn_crm_lead_boundary`), pertencimento por OLD **ou** NEW, transições `enter`/`stay`/`exit`/`delete`; sem oracle cross-tenant (o hook só vê a linha que a RLS aceitou) | MC3 §3, ADV-01/02/09                                                                  |
| Canonical events    | `lead.stage_changed` de lead Green tem um dono, o banco, na transação da mutação; o canônico é write-once; o relato do writer é reconhecido pelo escopo da execução (`x-green-scope-id`) e não vira segundo fato                | MC3 (ADV-03); CUT §2, §6                                                              |
| Lifecycle           | Nascimento privilegiado com proveniência na mesma transação (`green.lead_birth_provenance`); zona de perigo atômica e isolada por organização                                                                                   | LC1 §3-§6; LC12 (LIFE-ADV-04); LC13 (cerca Z)                                         |
| UUID identity       | O UUID de um lead que tocou o domínio Green não é reciclável nem mutável (`green.lead_identity`, `live`/`retired`), inclusive para lead que entra por binding                                                                   | LC12 §6; LC13 §1-§4                                                                   |
| Delete / tombstone  | DELETE de lead Green gera lápide `lead.deleted` canônica (registro, nasce `done`); exclusão da organização deixa rastro `green.binding_removed`                                                                                 | MC3 (ADV-01); LC1 §5, §12; CUT §11                                                    |
| Automation origin   | Toda regra declara `service_origin.kind=automation`; o banco prova regra, evento, gatilho, vivacidade e sujeito; a família de relógio é derivada e carimbada pelo banco (`green.scheduler_trigger_emission`)                    | AUTO §5, §7                                                                           |
| Structural boundary | Etapa de funil Green não é realocada; funil/etapa não troca de organização; binding exige estrutura coerente; etapa/lead/binding só apontam para estrutura da própria organização (FKs compostas)                               | STRUCT §2, §13                                                                        |
| Multi-tenant        | Todas as provas usam duas ou mais organizações; nenhuma escrita nem erro atravessa tenant; `test:db` inteira (isolamento RLS herdado) verde                                                                                     | MC3 (ADV-02); LC12 R4; LC13 Z; STRUCT (B2/B3); CUT                                    |
| Concorrência        | Corridas binding × lead, estrutura × binding, writers concorrentes e replays: um fato por mutação comitada, zero por mutação desfeita, nenhum estado impossível (no máximo um `40P01`)                                          | LC13 (C, 9 cenários); STRUCT §12 (C1-C7); CUT §13 (CON-1..3, S5, S8, C9)              |
| PostgREST           | Kong + PostgREST + GoTrue reais: papéis, claims, headers e embeds por nome de FK                                                                                                                                                | `tests/green-e2e/postgrest-real.e2e.ts`; STRUCT P1-P7                                 |
| Next real           | Rotas reais no build de produção (`next build` + `next start`) com sessão GoTrue real, tick e cron reais                                                                                                                        | `next-real-v3`, `automation-origin-real`, `structural-real`, `canonical-cutover-real` |
| Node 22             | O contexto (AsyncLocalStorage `run` explícito, sem `enterWith`) provado em Node 22.23.3 (produção/CI), Node 24 e `--no-async-context-frame`                                                                                     | MC3 (ADV-06); CUT §14; regressão desta baseline                                       |

Lead comum (fora do domínio Green) é controle em todas as frentes: comportamento do upstream preservado.

## 4. Contratos selados

Resumo de uma linha por contrato; o desenho, as provas e os gaps estão nos relatórios.

| Contrato                | Regra                                                                                                                                                                                                                                                 | Migration(s) | Relatório                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| MUTATION BOUNDARY       | Mudança de etapa/funil/existência de lead Green passa por uma fronteira no banco que exige contexto confiável para escrita privilegiada, separa trusted de advisory e emite o fato canônico na mesma transação                                        | 0501, 0502   | [`GREEN-MUTATION-CONTEXT-V3.md`](../spike/GREEN-MUTATION-CONTEXT-V3.md) (e V1, V2)    |
| LEAD LIFECYCLE          | Nascimento com proveniência atômica, morte com lápide, identidade de UUID não reciclável para todo lead que tocou o domínio (inclusive por binding), zona de perigo atômica e isolada                                                                 | 0503-0505    | [`GREEN-LEAD-LIFECYCLE-V1.3.md`](../spike/GREEN-LEAD-LIFECYCLE-V1.3.md) (e V1, V1.2)  |
| GREEN AUTOMATION ORIGIN | Automação em Opportunity Green escreve com origem `automation` provada pelo banco; marcadores de regra coerentes; relógio só aceito quando o banco carimbou o emissor                                                                                 | 0506         | [`GREEN-AUTOMATION-ORIGIN-V1.md`](../spike/GREEN-AUTOMATION-ORIGIN-V1.md)             |
| STRUCTURAL BOUNDARY     | A estrutura que decide o que é Green (funil, etapa, binding, organização) não muda a classificação de leads sem regra; FKs compostas mantêm os nomes antigos (embeds do PostgREST)                                                                    | 0507         | [`GREEN-STRUCTURAL-BOUNDARY-V1.md`](../spike/GREEN-STRUCTURAL-BOUNDARY-V1.md)         |
| CANONICAL EVENT CUTOVER | Um produtor por fato Green: o canônico é o fato; o relato do writer é reconhecido pela chave da execução que fez a mutação (porteiro `green.fn_event_log_gate`); binding sem evento por lead; `lead.created` continua do writer (exceção documentada) | 0508         | [`GREEN-CANONICAL-EVENT-CUTOVER-V1.md`](../spike/GREEN-CANONICAL-EVENT-CUTOVER-V1.md) |

Mudar qualquer um desses contratos exige decisão explícita registrada como ADR `GREEN-NNN`; as suítes seladas (seção
5.5) são a régua.

## 5. Inventário da adoção

Cadeia: upstream v1.69.0 → Mutation Context (0501) → Mutation Boundary v3 (0502) → Lifecycle (0503-0505) → Automation
Origin (0506) → Structural Boundary (0507) → Canonical Event Cutover (0508). Diferença total sobre a v1.69.0: 73
arquivos, 45 novos e 28 alterados (`git diff --stat e8e29121 38e2f16c`).

### 5.1 Migrations

| Migration                                                     | O quê                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260930180000_0501_spike_green_mutation_context.sql`        | schema `green`, `green.product_pipeline_binding`, resolver do contexto (`x-green-mutation-context`), livro-razão `green.stage_event_ledger`      |
| `20261001090000_0502_spike_green_mutation_boundary_v3.sql`    | hook único `green.fn_crm_lead_boundary`, envelope trusted/advisory, canônico write-once, lápide                                                  |
| `20261001120000_0503_spike_green_lead_lifecycle.sql`          | `green.lead_birth_provenance`, zona de perigo atômica, `lead.deleted` como registro, auditoria `green.binding_removed`                           |
| `20261002090000_0504_spike_green_lifecycle_v12.sql`           | `client_request_id` advisory, `green.lead_identity` (UUID não reciclável)                                                                        |
| `20261003090000_0505_spike_green_lifecycle_v13.sql`           | identidade reivindicada pelo binding (`green.fn_claim_binding_identities`), DELETE defensivo                                                     |
| `20261003200000_0506_spike_green_automation_origin.sql`       | origem `automation` provada (`green.fn_assert_automation_origin`), família de gatilho derivada, `green.scheduler_trigger_emission`               |
| `20261004090000_0507_spike_green_structural_boundary.sql`     | bloco 0 de recusa de legado impossível, guardas de etapa/funil, checagem do binding, FKs compostas com o mesmo nome, auditoria do re-apontamento |
| `20261004150000_0508_spike_green_canonical_event_cutover.sql` | `stage_event_ledger.scope_id`, `green.fn_request_scope()`, porteiro `green.fn_event_log_gate`; remove o supressor temporal e duas funções mortas |

Cada uma tem apêndice idempotente no `supabase/baseline.sql` (um bloco único de 3497 linhas acrescentado antes da
varredura de anon; nenhuma linha do upstream alterada) e linha no `supabase/migrations/MANIFEST.md`. Os nomes `spike_*`
ficam (seção 8).

### 5.2 Objetos de banco

Schema `green`, sem `USAGE` para `anon` e `authenticated`; `service_role` só lê (`SELECT`). Escrita apenas por
triggers `security definer` e pelo dono.

| Tipo               | Objetos                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabelas (5)        | `product_pipeline_binding`, `stage_event_ledger`, `lead_birth_provenance`, `lead_identity`, `scheduler_trigger_emission` (todas com RLS)                                                                                                                                                                                                                    |
| Funções de trigger | `fn_crm_lead_boundary`, `fn_event_log_gate`, `fn_event_log_canonical_guard`, `fn_stamp_scheduler_trigger`, `fn_structure_pipeline_guard`, `fn_structure_stage_guard`, `fn_binding_structure_check`, `fn_claim_binding_identities`, `fn_binding_removed_audit`                                                                                               |
| Funções de apoio   | `fn_mutation_context`, `fn_mutation_envelope`, `fn_request_scope`, `fn_ctx_id_ok`, `fn_ctx_uuid_ok`, `fn_is_green_pipeline`, `fn_lead_touches_green`, `fn_claim_lead_identity`, `fn_assert_service_origin` (2 assinaturas), `fn_assert_event_origin_contact`, `fn_assert_automation_origin`, `fn_automation_trigger_family`, `fn_automation_trigger_entity` |

| Tabela do upstream               | Trigger Green                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public.crm_leads`               | `trg_green_crm_lead_boundary` (AFTER)                                                                                                                  |
| `public.event_log`               | `trg_green_event_log_gate` (BEFORE INSERT), `trg_green_canonical_immutable` (BEFORE UPDATE/DELETE), `trg_green_stamp_scheduler_trigger` (AFTER INSERT) |
| `public.crm_pipelines`           | `trg_green_structure_pipeline` (BEFORE)                                                                                                                |
| `public.crm_stages`              | `trg_green_structure_stage` (BEFORE)                                                                                                                   |
| `green.product_pipeline_binding` | `trg_green_binding_claims_identities`, `trg_green_binding_structure`, `trg_green_binding_removed_audit`, `trg_green_binding_repointed_audit` (AFTER)   |

FKs trocadas pela 0507, com o mesmo nome (o PostgREST embeda por nome): `crm_stages_pipeline_id_fkey`,
`crm_leads_pipeline_id_fkey`, `crm_leads_stage_id_fkey` e `product_pipeline_binding_pipeline_id_fkey` passaram de uma
coluna para `(…, organization_id)`. Em `public`, a 0503 ainda redefine `public.fn_event_log_e_registro` (a lápide
`lead.deleted` nasce como registro) e cria a RPC `public.fn_apagar_dados_operacionais_da_org` (zona de perigo
atômica, só `service_role`).

### 5.3 Seams TypeScript

Arquivos novos: `lib/green/mutation-context.ts` (escopos ALS `runGreenRequestBoundary`, `withGreenMutationContext`,
`withGreenSystemRoot`, `withoutGreenMutationContext`; transporte `initComContextoGreen` com `x-green-mutation-context` e
`x-green-scope-id`) e `lib/green/proveniencia.ts` (leitura de trusted × advisory, `causadoPorRegra`).

Arquivos do upstream alterados (25 de código): as rotas de lead `leads/[id]/{move,win,lose,clone}`, `leads/bulk`,
`pipelines/[id]/stages/[stageId]` e `agenda/agendamentos` (boundary de requisição), `webhooks/in/[token]` (raiz de
sistema), a ação da zona de perigo e `lib/settings/apagar-dados-operacionais.ts`; os gates `lib/auth/require-role.ts`
e `lib/api/auth-dual.ts` (abrem o contexto); o transporte `lib/supabase/fetch-do-servidor.ts` e o client
`lib/agent-engine/edge/crm/mcp-client.ts`; `lib/automation/engine.ts` (origem `automation`),
`lib/event-log/dispatcher.ts` e `lib/atendimento/fronteira-server.ts` (raiz de sistema por handler/job),
`lib/ai/runtime/{tools,handoff}.ts`, `lib/mcp/server.ts`, `lib/relogio/executar.ts`, `lib/leads/nascimento-do-lead.ts`,
`lib/channels/pos-entrada.ts`, `lib/prospecting/store.ts` e `workers/voice-agent/index.ts`. Nenhum writer ganhou
`if (isGreen)`: a regra de pertencimento mora só no banco.

### 5.4 Arquivos de configuração e teste alterados

`vitest.green-e2e.config.ts` (novo) e `tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts` (alterado por
contrato no LC1 §9.1).

### 5.5 Suítes seladas (a régua)

| Camada                   | Arquivos                                                                                                                                                                                                                                                                                                     | Casos                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Banco (`test:db`)        | `tests/invariants/green-mutation-context.test.ts` (23), `-v2` (14), `-v3` (44), `green-lead-lifecycle` (23), `green-lifecycle-v12` (28), `green-lifecycle-v13` (31), `green-automation-origin` (59), `green-structural-boundary` (73), `green-canonical-event-cutover` (47); dublê `green-postgrest-shim.ts` | 342                                                       |
| Unidade                  | `lib/green/*.test.ts` (9 arquivos)                                                                                                                                                                                                                                                                           | 97                                                        |
| E2E (`vitest.green-e2e`) | `tests/green-e2e/postgrest-real`, `lifecycle-real`, `next-real-v3`, `automation-origin-real`, `structural-real`, `canonical-cutover-real`                                                                                                                                                                    | 44 (2 marcadores "sem stack" pulam quando o stack existe) |

As suítes de `tests/invariants/**` são congeladas pela governança (`loop/hooks/freeze-invariants.sh`); a válvula
`DESKCOMM_GOV_INVARIANTS_EDIT=1` só para mudança de contrato declarada.

### 5.6 Relatórios históricos

`docs/spike/GREEN-MUTATION-CONTEXT-V1.md`, `-V2.md`, `-V3.md`, `GREEN-LEAD-LIFECYCLE-V1.md`, `-V1.2.md`, `-V1.3.md`,
`GREEN-AUTOMATION-ORIGIN-V1.md`, `GREEN-STRUCTURAL-BOUNDARY-V1.md`, `GREEN-CANONICAL-EVENT-CUTOVER-V1.md`. Eles dizem
"SPIKE DESCARTÁVEL ... não vai para a `main`" porque descreviam o estado da época; continuam válidos como registro de
como cada decisão foi alcançada e não são reescritos. Três inconsistências de redação entre eles ficam resolvidas aqui,
sem editar os originais:

- STRUCT §17 diz que as contagens do bloco 0 "deram zero" no stack local; §16 registra que a primeira aplicação recusou
  4 leads legados, corrigidos pela fronteira antes de a 0507 aplicar. O zero é o de depois da correção.
- CUT §16 lista STRUCT-GAP-03 como "intocado", mas o próprio CUT §9 o decidiu (binding sem evento) como INFO-07.
- O "DÉBITO-02" do CUT §10 é o CUT-GAP-04 (`lead.created` não atômico).

## 6. Instalação e upgrade

- **Banco novo:** `supabase/baseline.sql` (o que o kit self-host aplica), como no upstream.
- **Origem de upgrade suportada:** uma instalação Deskcomm **v1.69.0**. O caminho do kit reaplica o `baseline.sql`; o
  caminho Supabase CLI aplica 0501-0508 em ordem. Os dois chegam ao mesmo catálogo do banco novo (provado na
  regressão desta baseline). Instalação Deskcomm v1.70.0 ou posterior não é origem suportada (ADR-GREEN-001).
- **Ordem de rollout:** banco antes do servidor, com o preflight da 0507 e a fila de relógio drenada antes; o
  checklist completo é o P0 de [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md).

## 7. O que esta baseline não é

Baseline arquitetural ≠ Production GA. Não impedem a GREEN-BASELINE-1.0, e não foram tratados nela:

- performance e escala ainda não otimizadas (zona de perigo e binding em organização grande);
- débitos de observabilidade (recusa visível só em log);
- resíduos INFO documentados;
- comportamento não-Green herdado do upstream (lead comum segue o Deskcomm v1.69.0, com os defeitos dele);
- divergência em relação ao upstream (fork drift);
- ausência de features específicas da iGreen.

Tudo o que é conhecido e ainda pertinente está classificado em [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md);
nenhum item ali é BLOCKER da baseline.

## 8. Nomenclatura

- O produto é **ConectorGreen**; a fundação é a **GREEN-BASELINE-1.0**. Documentação nova não o trata como
  experimento sobre o Deskcomm.
- Migrations 0501-0508, commits e relatórios mantêm os nomes `spike_*` / `SPIKE-*`: registram como a decisão foi
  alcançada. Nenhuma migration antiga é editada e nenhum commit histórico é reescrito.
- Branches `spike/green-*` no `origin` ficam como estão; a linha oficial passa a ser a `main`, a partir do merge de
  `release/green-baseline-1.0`.
- A próxima migration do ConectorGreen é a 0509, na sequência própria (ADR-GREEN-001, D4).
