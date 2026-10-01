# SPIKE Green — Mutation Context v2 (rodada corretiva, relatório para auditoria)

Status: SPIKE DESCARTÁVEL. Não é produto, não vai para produção, não vai para a `main`.

Branch: `spike/green-mutation-context-v2` (fork `alves87daniel/DeskcommCRM`), criada a partir de
`spike/green-mutation-context-v1` sem alterá-la.
Escopo: SOMENTE os gaps da seção "Auditoria independente do SPIKE-DESKCOMM-07"
(`docs/audits/deskcomm-fit/05-EVENTOS-IDEMPOTENCIA-ATOMICIDADE.md`, Conector Green). O desenho do v1
(`05A-SPIKE-MUTATION-CONTEXT.md` e `docs/spike/GREEN-MUTATION-CONTEXT-V1.md`) não foi reaberto.

## 1. Base

| Item | Valor |
|---|---|
| SHA base confirmado (v1) | `69bf48cc459abbcf0a9ce1f086baf313f34d221c` (`spike/green-mutation-context-v1`) |
| Base upstream do v1 | `e8e2912178031d321caf0912b270ee06bd2c36c7` (v1.69.0) |
| Commits v2 | `git log 69bf48cc4..spike/green-mutation-context-v2` (5 commits; o último é este relatório) |

## 2. O que mudou, por gap

### GAP 1 — contexto humano real

Não existe wrapper compartilhado de rota no Deskcomm: cada rota é um `export async function POST`
cru. O ponto comum de TODAS as rotas humanas que alcançam um writer de etapa é o gate de auth
`requireRole(min, { requestId, resource })` — Kanban (`leads/[id]/move`), lote (`leads/bulk`),
`win`/`lose`/`clone`, arquivamento de etapa (`pipelines/[id]/stages/[stageId]` DELETE) e a agenda
pela sessão (via `resolveAuthDual` → `requireRole`).

- Seam: `requireRole` abre o contexto da requisição na ENTRADA, síncrono, antes do primeiro
  `await`: `{ v:1, source:"http_session", request_id: requestId, correlation_id: requestId }`.
  Nenhum ator vai no header — o banco continua derivando `actor = auth.uid()`.
- Mecanismo: `abrirContextoGreenDaRequisicao` (`lib/green/mutation-context.ts`) usa
  `AsyncLocalStorage.enterWith`. Chamado síncrono pelo gate, vale para o RESTO da rota (a
  continuação depois do `await requireRole(...)` herda) e não vaza para outra requisição. Todas
  as rotas medidas fazem um `await` antes do gate (`requireSupportWrite()`/`createClient()`),
  então o contexto fica restrito à rota. Se o gate fosse chamado antes do primeiro `await` da
  rota, o contexto cobriria também o resto da MESMA requisição no framework — nunca a vizinha
  (os dois casos testados em `lib/green/seams-v2.test.ts`). Não sobrescreve contexto existente.
- `request_id` do evento canônico = `requestId` da rota = `request_id` do audit e da emissão
  legada (provado no E2E S19, com o livro-razão casando o gêmeo pelo mesmo id).
- Caminhos tocados: 1 arquivo (`lib/auth/require-role.ts`, +7 linhas). Nenhuma rota.

### GAP 2 — service-role real sem contexto

Censo completo dos call sites dos 8 primitives do EV-01 (seção 9). Quatro caminhos privilegiados
reais não tinham contexto que chegasse ao banco — três foram corrigidos na origem, sem tocar writer:

| Caminho | Defeito no v1 | Correção v2 (central) |
|---|---|---|
| `POST/PATCH /api/v1/agenda/agendamentos` por Bearer `dsk_` → `moverLeadParaEtapaDeAgendamento` | compromisso confirmado; espelho de etapa recusado `42501` e engolido como `warn` (reproduzido no E2E com o seam desligado) | `resolveAuthDual`, ramo token: abre `source:"http_token"` + `request_id` na entrada e vincula o ator técnico do token (`greenActorFromActor`) depois de validá-lo — vale para as 8 rotas duais |
| agent-worker (`update_lead_state` → `sincronizaEstagioDoAgente`; tools MCP nos turnos do engine) | o client `crmEdgeConfigFromEnv` era `createClient` cru, SEM `fetchDoServidor`: o contexto de `withServiceJob`/`wrapMcpTool` nunca saía do processo (achado novo do censo; o v1 supunha que saía) | `global.fetch: fetchDoServidor(url, url)` no client do engine — mesmo transporte, só com o header |
| `POST /api/internal/agents/run` → `runAgent` → `finalizeHandoff` → `triggerHandoff` (runtime legado, fora do wrapper das tools) | sem contexto | `finalizeHandoff` roda o handoff com `{source:"agent_runtime", request_id: runId, actor: ai_agent|system}` |

Critério atendido: nenhum writer privilegiado suportado altera Opportunity Green sem contexto
confiável (o banco continua fail-closed) e nenhum fluxo não-Green muda (o header é ignorado fora
de funil Green; suíte de invariantes inteira verde, seção 6).

### GAP 3 — `green_canonical` não forjável

- `green.stage_event_ledger`: uma linha por mutação Green canonizada, escrita SÓ pelo trigger
  AFTER de `crm_leads` (dono). Antes de chamar `emit_event`, o trigger grava a linha e põe o id
  dela no GUC transacional `green.canonical_proof`.
- O porteiro de `event_log` (BEFORE INSERT) só aceita `metadata.green_canonical` /
  `green_context_version` se o GUC aponta para uma linha da MESMA transação (`txid`), ainda não
  carimbada, do mesmo lead e da mesma transição; carimba `canonical_event_id` e zera o GUC (uso
  único). Qualquer outro caminho → `42501 green_canonical_reserved`, para qualquer tipo de evento.
- A marca é imutável depois (BEFORE UPDATE em `event_log`): nem acrescentada, nem retirada
  (`green_canonical_immutable`); o drain continua mexendo em `status`/`consumed_by`.
- O trigger AFTER confere que o livro-razão foi carimbado com o id devolvido; senão falha (e o
  UPDATE inteiro com ele).
- MutationContext continua NÃO sendo autorização: a prova é de proveniência do evento.

### GAP 4 — `service_origin.kind=event` prova o contato real

`green.fn_assert_event_origin_contact(org, event, contact)` é a projeção SEM efeito colateral da
regra canônica de `public.fn_service_event_origin`: contato = contato da ENTIDADE do evento, pela
mesma tabela tipo → entidade (`lead.*`, `contact.tag_added`, `appointment.outcome_confirmed`,
`message.received`), contato ativo, e a cadeia `payload.service_origin.kind=event` seguida até a
raiz com o mesmo teto de ciclo. A função canônica não é chamada porque CONSUMIR o evento tem
efeitos (advisory lock do contato, `fn_service_begin`, memo `event_service_origins`). A paridade é
cobrada contra a própria função canônica (mesmo veredito de escopo) e por catraca estrutural
(mesmo conjunto tipo@entidade, lido de `pg_get_functiondef`). Tipo que a régua canônica não
ancora → recusa explícita (`green_service_origin_unsupported`), nunca aceite silencioso.

### GAP 5 — oracle cross-tenant

O schema `green` saiu da API de `authenticated`/`anon`: sem `USAGE`, sem `EXECUTE`, sem tabela.
Os três triggers passaram a `security definer` com `search_path=''`; função de trigger não pode
ser chamada fora de trigger, então o definer só é exercido por uma escrita real que a RLS já
autorizou. Dentro do definer `current_user` é o dono, por isso o chamador é classificado pelo
claim do JWT e pelo GUC `role` da request (o definer não os troca — medido). `service_role`
mantém `EXECUTE` nos helpers. Helpers viraram `security invoker` (rodam como dono via trigger).
Também saíram de `authenticated`: `fn_assert_service_origin` (oracle de conversa/demanda de outra
org), `fn_mutation_context`, validadores.

### GAP 6 — E2E PostgREST real

`tests/green-e2e/postgrest-real.e2e.ts` (config própria, fora de `test:unit`/`test:db`): rotas,
seams, handlers e motor reais → HTTP → Kong/PostgREST de um Supabase LOCAL → trigger → `event_log`.
Nenhum `set_config('request.headers', …)`. Credenciais do stack local só por variável de ambiente
lida de `supabase status -o json` (nada no Git).

### Supressor v2

Do "por lead" do v1 para "pelo gêmeo da mutação canonizada": um `lead.stage_changed` sem marca só
some se casa com uma linha do livro-razão do MESMO lead, MESMA transição (`to_stage_id`, e
`from_stage_id` quando o legado o traz), já carimbada, ainda sem gêmeo e criada há ≤ 5 min; o
mesmo `request_id` (quando os dois têm) escolhe a linha. O resto passa como no upstream —
inclusive lead não-Green (nunca tem linha), reordenação na mesma etapa, transição que nenhum
UPDATE fez e gêmeo atrasado. Seção 8 detalha o risco residual.

## 3. Arquivos (v1 → v2)

```
 lib/agent-engine/edge/crm/mcp-client.ts            |   6 +
 lib/ai/runtime/handoff.ts                          |  27 +-
 lib/api/auth-dual.ts                               |   9 +
 lib/auth/require-role.ts                           |   7 +
 lib/green/mutation-context.ts                      |  57 ++
 lib/green/seams-v2.test.ts                         | 354 ++++++++++++
 supabase/baseline.sql                              | 338 +++++++++---   (apêndice 0501, espelho derivado)
 supabase/migrations/20260930180000_0501_...sql     | 336 +++++++++---   (editada no lugar: o v1 nunca foi aplicado fora de banco efêmero)
 supabase/migrations/MANIFEST.md                    |   2 +-
 tests/green-e2e/postgrest-real.e2e.ts              | 583 ++++++++++++++++++++
 tests/invariants/green-mutation-context-v2.test.ts | 610 +++++++++++++++++++++
 vitest.green-e2e.config.ts                         |  33 ++
 docs/spike/GREEN-MUTATION-CONTEXT-V2.md            | este relatório
```

`tests/invariants/green-mutation-context.test.ts` (S1–S14 do v1) ficou INTACTO: `tests/invariants/**`
é congelado (`loop/hooks/freeze-invariants.sh`), então S15+ estão num arquivo novo.

## 4. Métricas de fork (contra o upstream `e8e2912`)

| Métrica | v1 | v2 |
|---|---|---|
| Arquivos upstream modificados | 8 | **12** (+`require-role.ts`, `auth-dual.ts`, `agent-engine/edge/crm/mcp-client.ts`, `ai/runtime/handoff.ts`) |
| Writers de `crm_leads.stage_id` alterados diretamente | 0 | **0** |
| Seams | 6 (1 transporte + 5 contexto) | **10** (2 transporte: `fetch-do-servidor`, client do agent-worker; 8 contexto: dispatcher, engine, mcp/server, ai/runtime/tools, fronteira-server, `requireRole`, `resolveAuthDual`, `finalizeHandoff`) |
| Seams novos na v2 | — | **4** |
| Hooks DB | 3 triggers / 3 funções | **4 triggers / 3 funções** (+BEFORE UPDATE em `event_log` para a marca imutável) + 1 tabela (`green.stage_event_ledger`) |
| Migrations | 1 (`0501`) | 1 (`0501`, editada) |
| Linhas líquidas, total | +2958 | **+5052** (sem este relatório) |
| Linhas líquidas, só upstream | +527 (TS +148/−56; baseline +434; MANIFEST +1) | **+772** (TS +189/−64; baseline +646, apêndice espelho da migration; MANIFEST +1) |
| Arquivos novos | 7 | 12 (com este relatório) |

O delta upstream de código TS cresceu 41 linhas em 4 hunks pequenos e locais — não explodiu. O maior
custo de rebase continua sendo o apêndice do `baseline.sql`.

## 5. Resultado S1–S23

Banco = `pnpm test:db` (Postgres efêmero `pgvector:pg15`, baseline com o apêndice 0501, request
simulada como o PostgREST a entrega). E2E = Supabase LOCAL real (Kong 2.8.1 + PostgREST v14.5 +
GoTrue v2.197.0 + Postgres 17), HTTP de verdade.

| Cenário | Onde | v1 (base) | v2 |
|---|---|---|---|
| S1–S14 + guarda de etapa | banco (`green-mutation-context.test.ts`, 23 casos) | PASS | **PASS** (arquivo intacto) |
| S15 forja do canônico (authenticated, service_role por RPC/INSERT/GUC, imutabilidade, trigger real) | banco | FAIL (forja aceita) | **PASS** (4 casos) |
| S16 evento E do contato A declarado como B + paridade com `fn_service_event_origin` + catraca | banco | FAIL (aceito) | **PASS** (3 casos) |
| S17 oracle cross-tenant (A×B, anon, triggers de A, service_role) | banco | FAIL (oracle respondia) | **PASS** (3 casos) |
| S18 agenda por Bearer, rota real | E2E | FAIL reproduzido (`green_mutation_context_required` engolido; card parado) | **PASS** |
| S19 metadata da requisição humana, rota real do Kanban | E2E | FAIL reproduzido (sem `source/request_id/correlation_id`) | **PASS** |
| S20 HTTP/PostgREST service-role | E2E | — | **PASS** |
| S20b client do agent-worker (`crmEdgeConfigFromEnv`) por HTTP | E2E | (v1: header nunca saía do processo) | **PASS** |
| S21 HTTP/PostgREST humano (header forjado, forja por RPC, oracle por HTTP) | E2E | — | **PASS** |
| S22 HTTP/PostgREST automação (dispatcher + motor + `create_or_move_lead` reais, anti-loop) | E2E | — | **PASS** |
| S23 supressor não engole evento legítimo (2º evento igual, reordenação, transição não canonizada, gêmeo atrasado, gêmeo certo por `request_id`) | banco | FAIL (v1 engolia) | **PASS** (4 casos) |

"v1 (base)" para S15–S17/S23: os testes novos rodados contra a migration do v1 — 12 falhas, 6 delas
"a escrita devia ter sido recusada e passou". Para S18/S19: o E2E rodado com `requireRole` e
`resolveAuthDual` revertidos ao v1.

## 6. E2E reais

| E2E | Prova |
|---|---|
| E2E-1 humano (S19 + S21) | rota real do Kanban com sessão GoTrue real: 1 canônico, `caller=user`, `actor={user, auth.uid}`, `source=http_session`, `request_id`/`correlation_id` = `X-Request-Id` da rota, gêmeo legado casado pelo mesmo id. Direto no PostgREST com header forjado (`actor=system`): ator continua o usuário, origem `command` derivada; `request_id` do header aparece só como advisory. Forja por `rpc/emit_event` → `green_canonical_reserved`; `rpc/fn_is_green_pipeline` com `Content-Profile: green` → recusado |
| E2E-2 service-role (S20 + S18) | `withGreenMutationContext` → `createAdminClient` → HTTP (espião confirma a URL do Kong e o header) → canônico com `caller=service_role`, `source`, `request_id`, `idempotency_key`, `actor`. Sem contexto: `42501 green_mutation_context_required` pelo PostgREST, nada muda. Não-Green sem contexto: passa, 0 canônico. Agenda por Bearer pela rota real: card anda, ator `api_token`. Client do agent-worker (S20b): `source=agent_engine`, `source_job_id`, ator do job chegam ao canônico |
| E2E-3 automação (S22) | evento E real → `dispatchEvent` → motor → `create_or_move_lead` → `moveLeadHandler` → HTTP: canônico com `request_id=rule:<R>`, `causation_event_id=E`, `service_origin={event,E,org,contato}`; gêmeo do handler suprimido (2 eventos no total); o canônico devolvido ao dispatcher volta `skipped/caused_by_rule` e nada mais acontece |

Resultado final: `Tests 6 passed | 1 skipped` (o `skip` é o marcador "sem stack", que só roda quando as variáveis faltam).

## 7. Testes e suítes rodados

```bash
corepack pnpm@9.15.9 exec tsc --noEmit -p tsconfig.typecheck.json              # exit 0
corepack pnpm@9.15.9 exec eslint lib/green lib/auth/require-role.ts lib/api/auth-dual.ts \
  lib/agent-engine/edge/crm/mcp-client.ts lib/ai/runtime/handoff.ts tests/invariants/green-mutation-context-v2.test.ts  # 0 erros
corepack pnpm@9.15.9 exec vitest run --project produto lib/green               # 4 arquivos, 35 testes
corepack pnpm@9.15.9 exec vitest run --project produto tests/unit/branding.test.ts lib/green \
  lib/supabase/fetch-do-servidor.test.ts tests/unit/service-boundary.test.ts tests/unit/auth-falha-alto.test.ts \
  tests/unit/auth-getuser-erro-mudo.test.ts tests/unit/rbac-matrix.test.ts tests/unit/etapa-de-perda-no-arrasto.test.ts
#   11 arquivos, 114 testes verdes
CONFERENCIA_KIT_RELEASE=v1.69.0 corepack pnpm@9.15.9 run test:db \
  tests/invariants/green-mutation-context.test.ts tests/invariants/green-mutation-context-v2.test.ts
#   install ok / update ok / update.sh (checkout, v1.69.0, v1.63.0) 158 regras — 2 arquivos, 37 testes verdes
pnpm exec vitest run -c vitest.green-e2e.config.ts                             # 6 passed | 1 skipped
corepack pnpm@9.15.9 cercas                                                     # ver §7.1
CONFERENCIA_KIT_RELEASE=v1.69.0 corepack pnpm@9.15.9 run test:db                # suíte inteira — ver §7.1
corepack pnpm@9.15.9 exec vitest run --project produto --maxWorkers=8           # suíte inteira — ver §7.1
```

Ambiente: Windows 11, Node 24.14.1, pnpm 9.15.9 (corepack), Docker Desktop; harness `pgvector:pg15`;
stack E2E isolado em portas 553xx (Supabase CLI 2.117.0, imagens em cache; Postgres 17 só porque é a
imagem local — o baseline roda em 15 e 17 na matriz do CI). A stack do Conector Green (543xx) não foi
tocada.

### 7.1 Falhas pré-existentes × novas

| Suíte | Resultado v2 | Classificação |
|---|---|---|
| `pnpm test:db` inteira | **343/343 arquivos, 2788 passed, 1 expected fail, 1 skipped** (1504 s, `test:db verde`) | zero falha. v1: 342/2774 — +1 arquivo, +14 casos |
| `vitest --project produto` inteira (8 workers) | 10 arquivos / 11 casos falharam | 3 arquivos foram I/O do Windows sob carga (`UNKNOWN: unknown error, read`, módulo de `node_modules` não lido, `Invalid package config`) e **passam isolados**. Os 7 restantes (`lgpd-pdf-*` ×4, `confianca-do-handoff-nao-e-similaridade`, `followups-de-demonstracao-sao-possiveis`, `rascunho-superado-nao-e-regravado`) falham **idênticos no commit v1** (11 casos nos dois) — os mesmos que o relatório v1 já atribuía ao ambiente. **Novas: 0** |
| `pnpm cercas` inteira | 1ª rodada (concorrência padrão): 13 arquivos, vários por `out of memory`/`fork: Resource temporarily unavailable`; rodada final (`--maxWorkers=4`): **9 arquivos / 37 casos** | os 9 falham **idênticos no commit v1** (37 casos nos dois): `atualizacao-confere-regras-de-isolamento`, `catalogo-de-ensaio-espelha-o-vocabulario`, `e2e-parte-4-fala-com-os-servicos-do-runner`, `e2e-supabase-start-tenta-de-novo`, `executor-proprio-so-roda-o-que-e-nosso`, `guarda-da-release-confere-identidade`, `guarda-da-release-reconhece-o-corte`, `populacao-do-proximo-nnnn`, `release-chega-na-lp` (git/gh de release, bash/tmp, rede da LP neste Windows). **Novas: 0** |
| Green focados (unit, banco, E2E) | todos verdes | — |

Uma falha NOVA apareceu durante a rodada e foi corrigida antes do commit: o prettier reformatou arquivos upstream inteiros (aspas do `mcp-client.ts`, linhas longas do `require-role.ts`); revertido — só os hunks do spike ficaram.

## 8. Análises

### Produtor canônico
Prova = linha do livro-razão (só o dono escreve) + GUC de uso único na mesma transação + amarração a
lead/transição. Não forja: authenticated e service_role pela API (RPC ou INSERT), nem service_role com
SQL que escreva o GUC (não tem a linha). Fica fora do modelo de ameaça quem tem privilégio de dono
(conexão direta como `postgres`): esse já pode desligar o trigger.

### Cobertura de service-role
Censo da seção 9: 8 primitives, nenhum 9º writer de UPDATE de `stage_id`. Coberto e transportado: MCP
externo, tools in-process do `runAgent`, automação, handlers do dispatcher, handoff do agent-worker por
`createAdminClient`, e agora agenda por Bearer, todo o agent-worker (client com transporte) e o handoff
do runtime legado. Sem caminho privilegiado de UPDATE de etapa Green conhecido sem contexto.

### Caminho humano
Um seam (`requireRole`) cobre as 6 entradas humanas que escrevem etapa. O ator nunca vem do header.
`request_id` humano é advisory: quem chama o PostgREST direto pode escrevê-lo (S21) — não concede nada.

### `service_origin`
`command` continua derivado no banco; `continuation` conferida contra a fronteira vigente; `event`
agora conferida contra o contato REAL do evento pela régua canônica (S16), e o canônico da automação
preserva a origem por evento (S22).

### Oracle cross-tenant
Fechado por privilégio, não por filtro: nenhum helper `green` é executável por `authenticated`/`anon`
e o schema não tem `USAGE` para eles (S17; por HTTP, S21).

### Supressor v2
Restrito ao gêmeo. Não existe chave transacional: os writers HTTP emitem o legado em OUTRA transação
(outra request PostgREST), depois do UPDATE commitado. A correspondência é por (lead, transição,
janela, gêmeo ainda não visto), com `request_id` como desempate. Risco residual exato: um
`lead.stage_changed` legado SEM mutação correspondente (ex.: um recurso futuro de reemissão/replay)
com a MESMA transição de uma mutação Green canonizada há ≤ 5 min cujo writer não emitiu gêmeo
(`encerraDemanda`, `arquivarEtapa` não emitem) seria engolido. Para fechar: os writers passarem o
`request_id` canônico ao legado (ou o legado deixar de existir para Green) — v3.

## 9. Censo dos 8 primitives (resumo)

| Primitive | Entradas | Cliente | Contexto v2 |
|---|---|---|---|
| `leads/[id]/move` | Kanban | sessão | `requireRole` |
| `moveLeadHandler` | MCP externo, `runAgent`, automação, turnos do agent-worker | admin / client do engine | MCP, tools, engine+dispatcher, `withServiceJob`+transporte do engine |
| `fn_mover_leads_em_lote` | `leads/bulk` | sessão | `requireRole` |
| `sincronizaEstagioDoAgente` | agent-worker `update_lead_state` | client do engine | `withServiceJob` + transporte do engine (v2) |
| `moverLeadParaEtapaDeHandoff` | dispatcher (IA/sentimento), MCP, agent-worker, `runAgent` legado | admin | dispatcher, MCP, `withServiceJob`, `finalizeHandoff` (v2) |
| `moverLeadParaEtapaDeAgendamento` | agenda sessão, agenda Bearer, MCP, agent-worker | sessão / admin / engine | `requireRole`, `resolveAuthDual` (v2), MCP, transporte do engine (v2) |
| `encerraDemanda` | win/lose/clone, MCP, automação, agent-worker | sessão / admin / engine | `requireRole`, MCP, engine, transporte do engine (v2) |
| `arquivarEtapa` | DELETE de etapa, MCP (só humano) | sessão / admin | `requireRole`, MCP |

Fora dos 8 (EV-01B, INSERT): `webhooks/in/[token]`, `lib/prospecting/store.ts`, `garantirLeadDaConversa`
(`pos-entrada`, `voice-agent`) criam lead com service-role sem contexto — num funil Green, recusados
(fail-closed). Não é regressão não-Green; é o próximo censo.

## 10. Riscos restantes

1. **EV-01B (INSERT)**: os nascimentos privilegiados acima não têm contexto; em funil Green falham.
2. **Supressor**: risco residual da seção 8 (janela de 5 min, transição idêntica, writer sem gêmeo).
3. **Metadata específica do legado** (`transicao`, `passo_do_agente`, `motivo_do_handoff`) não chega ao
   canônico — já era assim no v1; o livro-razão guarda só o `request_id` do gêmeo.
4. **Contrato do `enterWith`**: o gate tem de ser chamado pela rota (direto, após um `await`). Um gate
   chamado dentro de um helper depois de um `await` não propagaria. Todas as rotas atuais cumprem.
5. **Projeção da régua canônica**: a catraca confere o conjunto tipo@entidade e a paridade de escopo para
   `lead.*`, `contact.tag_added` e cadeia; uma mudança upstream só no WHERE de um tipo existente
   (`appointment.outcome_confirmed`, `message.received`) não seria pega pela catraca estrutural.
6. **Tipos sem âncora na automação**: regra disparada por tipo que a régua canônica não ancora e que
   mova lead Green é recusada com `green_service_origin_unsupported` (explícito). v3: o seam do motor
   só declarar origem por evento para tipos ancoráveis.
7. **Reordenação**: em lead Green, a emissão da rota para reordenar volta a nascer (não canônica), como
   no upstream; o v1 a engolia. Consumidor Green deve filtrar `green_canonical`.
8. **Livro-razão sem retenção** (uma linha por mudança de etapa Green).
9. **Direto `caller=direct` via GUC** segue aceito (v1, risco 7) — agora SÓ quando não há papel de
   request (header/claims não usam o GUC).
10. **Fork drift**: apêndice do baseline + 4 hunks upstream novos.

## 11. Divergências em relação ao pedido

- S15+ num arquivo novo de invariantes (o v1 é congelado pela governança do repo), não no mesmo arquivo.
- Contexto humano por `enterWith` no gate de auth (não há wrapper de rota para usar `run`).
- Dois seams fora da lista de gaps (client do agent-worker e `finalizeHandoff`), achados no censo.
- Supressor com tabela nova e janela de 5 min (sem chave transacional possível); a marca canônica
  ficou reservada para TODO tipo de evento e imutável em UPDATE (endurecimento além do pedido).
- Transporte por GUC restrito a `caller=direct`.
- Stack E2E em Postgres 17 (imagem em cache), a suíte de invariantes em 15.

## 12. Decisão do implementador

**PASS** para o gate do EV-03 da auditoria: (1) produtor canônico reservado e provado (S15, S21); (2) caminhos service-role reais cobertos a partir da agenda por Bearer, com censo dos 8 primitives e três origens corrigidas centralmente (S18, S20b, unitários); (3) request/correlation no caminho humano, provados na rota real (S19); (4) contato real de `service_origin.event` validado pela régua canônica (S16); (5) oracle fechado (S17, S21); (6) E2E PostgREST real para humano, service-role e automação (S19–S22); (7) 0 writers de etapa alterados. Regressão: S1–S14 intactos, `test:db` inteira verde, zero falha nova em `produto` e `cercas`; delta upstream TS +41 linhas em 4 arquivos.

O PASS não cobre o que está fora do gate e segue como risco explícito: censo EV-01B (nascimento privilegiado em funil Green), risco residual do supressor (§8) e o contrato do `enterWith` (§10.4).
