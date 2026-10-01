# SPIKE-DESKCOMM-09 - Mutation Boundary v3: Bidirectional Guard + Trust Hardening

Status: SPIKE DESCARTÁVEL. Não é produto, não vai para produção, não vai para a `main`. Nenhum merge,
nenhum PR. Relatório para auditoria independente.

Branch: `spike/green-mutation-context-v3`, criada a partir de `spike/green-mutation-context-v2` sem
alterar v1 nem v2. Escopo: SOMENTE os cinco pontos falsificados pela `AUDIT-DESKCOMM-08.2` (veredito
`FAIL`). EV-01B, lifecycle de criação de leads, redesign do event bus e ADR ficaram de fora.

## 1. Base

| Item | Valor |
|---|---|
| Upstream | `e8e2912178031d321caf0912b270ee06bd2c36c7` (v1.69.0) |
| v1 | `69bf48cc459abbcf0a9ce1f086baf313f34d221c` (`spike/green-mutation-context-v1`, intacta) |
| v2 (base da v3) | `49695f9f229e66848ad3f5811bfe4991158ebbb3` (`spike/green-mutation-context-v2`, local = `origin`, intacta) |
| Fase 0 | `git status --short` vazio, branch `spike/green-mutation-context-v2`, `HEAD` = `origin/…-v2` = SHA esperado |
| Commits v3 | `git log 49695f9f2..spike/green-mutation-context-v3` |

Ordem dos commits (TDD): `82250e66f` testes RED → `3e96b49c7` migration 0502 → `d8e0d634d` boundary/seams TS
→ `1560e651d` testes antigos no contrato v3 → `f90c521ca`/`00fe85167` E2E Next real → `8e4e92888` controle da cascata
→ `d6b9ab39e` forma da boundary nas rotas (correção de uma falha nova achada na regressão, §13) → relatório.

A migration da v2 (`0501`) NÃO foi editada. A v3 tem o delta próprio:
`supabase/migrations/20261001090000_0502_spike_green_mutation_boundary_v3.sql` (e o apêndice espelho no
`baseline.sql`, logo depois do da 0501 e antes da varredura de anon).

## 2. Achados herdados (AUDIT-DESKCOMM-08.2)

| ID | Severidade | Achado | Tratamento na v3 |
|---|---|---|---|
| ADV-01 | CRITICAL | Saída do funil Green e DELETE sem guarda e sem canônico (a v2 decidia por `NEW.pipeline_id`) | corrigido (V3-R01, V3-R02) |
| ADV-02 | HIGH | Oracle cross-tenant: trigger `security definer` BEFORE respondia antes da RLS | corrigido (V3-R03) |
| ADV-03 | HIGH | Canônico reescrevível, realocável e apagável por `service_role` | corrigido (V3-R04) |
| ADV-04 | HIGH | Campos "advisory" humanos (`request_id=rule:*`) controlavam o motor de automação | corrigido (V3-R05, V3-R06) |
| ADV-05 | MEDIUM | `relogio/tick` e handlers herdavam o contexto da requisição humana | corrigido (raiz de sistema) |
| ADV-06 | MEDIUM | `enterWith` circunstancial; prova só em Node 24 | corrigido (`run` explícito; Node 22 + Next real) |
| ADV-07 | MEDIUM | Supressor disparável por membro da org | controle de não-regressão + `GAP-SUPPRESSOR-V3` (§12) |
| ADV-08 | MEDIUM | Drift da régua de `service_origin.event` | fora de escopo, justificado (§12); S16 segue verde |
| ADV-09 | MEDIUM | Lote entre funis põe etapa Green em lead não-Green | corrigido na fronteira, sem tocar o writer |
| ADV-10/11/12 | LOW/INFO | E2E parcial, prova negativa parcialmente estrutural, ator declarado | ADV-10/11 endereçados pelo método (§5, §7); ADV-12 fora de escopo |
| ADV-13 | INFO | EV-01B | FORA desta spike (pedido explícito) |

O texto da auditoria e os testes `AUDIT-DIAG-*` não estavam versionados; os ataques foram reproduzidos a partir
do relatório da auditoria e dos arquivos de diagnóstico dela.

## 3. Desenho v3 - o que mudou e por quê

### 3.1 Um hook AFTER no lugar de dois (ADV-01, ADV-02, ADV-09)

A v2 tinha um guard BEFORE e um emissor AFTER em `crm_leads`, os dois olhando só `NEW`. A v3 tem UM hook,
`green.fn_crm_lead_boundary`, `AFTER INSERT OR UPDATE OR DELETE`.

- **Pertencimento bidirecional.** A mutação entra na fronteira se OLD **ou** NEW tocam o domínio Green. "Tocar"
  = o funil é gerenciado OU a etapa pertence a um funil gerenciado **da mesma organização**
  (`green.fn_lead_touches_green`). Cobre entrada, permanência, saída, troca de funil, só etapa, lote e DELETE.
- **Stage binding central.** Sempre que a mutação toca o domínio, a etapa de NEW tem de ser do funil e da org de
  NEW (`green_stage_not_bound`). É isso que fecha o lote entre funis (ADV-09) sem editar
  `fn_mover_leads_em_lote`, e que impede "sair" trocando só `pipeline_id`.
- **Por que AFTER (ADV-02).** BEFORE ROW roda antes do `WITH CHECK` da RLS; por isso o guard da v2 lia o binding
  de outra org e devolvia `green_stage_not_bound` onde um funil comum devolvia erro de RLS. A alternativa
  sugerida pela auditoria (conferir se o caller é membro antes de ler o binding) seria uma segunda cópia da
  regra de acesso, que diverge da RLS (platform admin, suporte, dono do lead). A v3 muda o MOMENTO: trigger
  AFTER ROW só é enfileirado para a linha que a RLS (USING + WITH CHECK) aceitou e que foi escrita. Quem não
  pode escrever na org não executa nenhuma linha de código Green. A recusa continua atômica (exceção em AFTER
  aborta o comando). Etapa de outra org nunca é consultada como Green (não vira oracle pelo lado da etapa).

Contratos decididos:

| Transição | Humano (sessão) | Writer privilegiado sem contexto | Writer privilegiado com contexto |
|---|---|---|---|
| entrada (`enter`) | canônico `lead.stage_changed` | `42501 green_mutation_context_required` | canônico |
| permanência (`stay`) | canônico | `42501` | canônico |
| saída (`exit`) | canônico, com `from_pipeline_id` | `42501` | canônico |
| DELETE | lápide canônica `lead.deleted` | `42501` | lápide canônica |
| organização inteira apagada (cascata) | sem lápide: `event_log` e o binding vão junto | idem | idem |

`payload.green_transition` (`enter`/`stay`/`exit`/`delete`) e `payload.from_pipeline_id` (quando o funil muda)
são novos. INSERT continua sem evento canônico (EV-01B, fora de escopo), mas passa pelo binding e pela
exigência de contexto como na v2.

### 3.2 Canônico como registro histórico (ADV-03)

`green.fn_event_log_canonical_guard`, `BEFORE UPDATE OR DELETE` em `event_log` (substitui o trigger
`WHEN (old.metadata IS DISTINCT FROM new.metadata)` da v2):

- **Allowlist de colunas mutáveis** (as que o drain escreve, medidas em `lib/event-log/drain.ts`): `status`,
  `consumed_by`, `attempts`, `last_error`, `next_attempt_at`, `updated_at`.
- Todo o resto é write-once para qualquer papel: `metadata` inteira, `payload`, `entity_id`,
  `organization_id`, `event_type`, `entity_kind`, `created_at`. A comparação é
  `to_jsonb(old) - allowlist` × `to_jsonb(new) - allowlist`, então coluna nova nasce imutável por padrão.
- DELETE do canônico é recusado (`green_canonical_immutable`). Única exceção: a organização já não existe
  (cascata da exclusão do tenant). Manutenção administrativa (retenção) fica fora da API e fora do modelo: é
  o dono desligando o trigger numa janela explícita.
- A marca e o envelope (`green_canonical`, `green_context_version`, `green`) são reservados ao produtor também
  para a lápide `lead.deleted` (prova por livro-razão + GUC de uso único, como na v2).

### 3.3 Envelope trusted × advisory (ADV-04)

```text
metadata.green.v         = 2
metadata.green.trusted   = derivado pelo banco, ou contexto validado enviado pelo backend
metadata.green.advisory  = tudo o que uma sessão humana mandou no header
metadata.<topo>          = só o que é trusted (+ green_canonical, actor_user_id/actor_kind de compat)
```

`green.fn_mutation_envelope()` monta o envelope sobre o resolver da v2 (`fn_mutation_context`, intacto).
No código, `lib/green/proveniencia.ts` é o único caminho de leitura: `provenienciaConfiavel()` devolve só o
trusted; o advisory só sai por `advisoryDoEvento()`, com um tipo marcado (`AdvisoryGreen`) que não é atribuível
ao tipo confiável. Consumidores atualizados: anti-loop da automação (`causadoPorRegra`), correlação herdada
pelo dispatcher, livro-razão/supressor (`request_id` confiável × `advisory_request_id`).

### 3.4 Boundary explícita com `AsyncLocalStorage.run` (ADV-05, ADV-06)

- O que fica no ALS é um **escopo** `{ ctx, requisicao, aberto }`. Quem abre o escopo o FECHA quando o trabalho
  assenta (retorno, throw, promessa cumprida ou rejeitada). Escopo fechado não entrega contexto: callback
  tardio, timer e poller criados dentro da requisição não carregam nada depois dela.
- `runGreenRequestBoundary(fn)`: raiz nova por requisição, sempre. É o único lugar onde o gate de auth
  escreve. A rota a declara no handler exportado, logo depois da guarda de suporte:
  `export async function POST(…) { requireSupportWrite…; return runGreenRequestBoundary(() => handlePOST(…)); }`. `abrirContextoGreenDaRequisicao` (chamado por `requireRole` e
  `resolveAuthDual`, que NÃO mudaram) deixou de abrir contexto: só preenche o escopo de requisição corrente.
  Sem boundary não há contexto. Não existe mais `enterWith` no módulo.
- `vincular` troca o contexto do escopo por um objeto novo; nada é compartilhado por referência entre
  requisições (era a causa do ALS-01).
- `withGreenSystemRoot(ctx, fn)`: raiz de sistema, não herda nada. Usada pelo dispatcher de eventos e pelo job
  do agent-worker. `withoutGreenMutationContext(fn)`: corta o contexto de quem chamou; usada pelo tick do
  relógio. Uma requisição humana deixa de ser raiz causal de drain, worker, dispatcher e tarefas internas.
- Rotas que declaram a boundary (as que alcançam writer de etapa): `leads/[id]/move`, `leads/bulk`,
  `leads/[id]/win|lose|clone`, `pipelines/[id]/stages/[stageId]` (DELETE) e a escrita de
  `agenda/agendamentos` (POST/PATCH/DELETE).

## 4. Trust model

| Campo | Fonte | Trusted? | Pode controlar comportamento? |
|---|---|---|---|
| `caller` | banco: `auth.uid()`, claim `role` do JWT, GUC `role` da request | sim | sim (decide exigência de contexto) |
| `actor` (sessão humana) | banco: `auth.uid()` | sim | sim |
| `actor` (writer privilegiado) | contexto do backend, validado por schema; declarado, não provado (ADV-12) | sim, no nível "backend" | sim |
| `source` (sessão humana) | banco: constante `user_session`, derivada do canal | sim | sim |
| `source` (header de sessão humana) | cliente | NÃO (advisory) | não |
| `source` (writer privilegiado) | contexto do backend | sim | sim (anti-loop: `automation`) |
| `request_id` / `correlation_id` (header de sessão humana) | cliente (a rota os gera, mas viajam no header que o cliente pode forjar no PostgREST direto) | NÃO (advisory) | não |
| `request_id` / `correlation_id` (writer privilegiado) | contexto do backend | sim | sim (anti-loop `rule:*`, desempate do supressor) |
| `causation_event_id` | sessão humana: advisory; writer privilegiado: backend (dispatcher/motor) | só de backend | sim, só o de backend |
| `idempotency_key`, `source_job_id` | idem | só de backend | sim, só o de backend |
| `service_origin` | humano: nunca transportada (`command` derivada no banco); backend: validada contra org/contato/fronteira/evento | sim | sim |
| `green_canonical`, `green`, `green_context_version` | só o produtor (trigger + livro-razão + GUC de uso único) | sim | sim |
| `payload.green_transition`, `from_pipeline_id` | banco (OLD/NEW) | sim | sim |
| `legacy_request_id` (livro-razão) | metadata do evento legado (cliente) | NÃO | não (só diagnóstico) |

## 5. Prova RED - os testes novos contra a v2

Todos escritos antes de qualquer código de produção (`82250e66f`) e rodados contra a v2 sem alteração.

### 5.1 Banco (`tests/invariants/green-mutation-context-v3.test.ts`, `pnpm test:db`, Postgres efêmero pg15)

Resultado na v2: **32 falhas, 11 passam** (os 11 são controles que devem passar nas duas versões).

| ID | v2 esperado | v2 observado |
|---|---|---|
| V3-R01 saída, service_role sem contexto | FAIL (passa sem guarda) | `ACEITO` em vez de `42501 green_mutation_context_required` |
| V3-R01 saída, humano | FAIL (sem canônico) | 0 eventos |
| V3-R01 saída, service_role com contexto | FAIL (sem canônico) | 0 eventos |
| V3-R01 sair só com `pipeline_id` | FAIL | `ACEITO` em vez de `23503 green_stage_not_bound` |
| V3-R01 `enter` / `stay` declaradas | FAIL (payload sem `green_transition`) | payload sem o campo |
| V3-R02 DELETE, service_role sem contexto | FAIL | `ACEITO` |
| V3-R02 DELETE, humano / com contexto | FAIL (sem lápide) | 0 eventos |
| V3-R02 lápide não forjável; DELETE não-Green; cascata da org | PASS (controles) | PASS |
| V3-R03 INSERT cross-tenant | FAIL (oracle) | `23503 green_stage_not_bound` × `42501 new row violates row-level security policy` |
| V3-R03 binding etapa↔funil alheio | FAIL (oracle) | 2 vereditos distintos |
| V3-R03 UPDATE do próprio lead para a org alheia | FAIL (oracle) | `23503 green_stage_not_bound` × `PT404 Contato não encontrado.` |
| V3-R03 UPDATE/DELETE de lead alheio; contrato dentro da própria org | PASS (controles) | PASS |
| V3-R04 reescrita do canônico (10 ataques por coluna) | FAIL | `ACEITO` nos 10 |
| V3-R04 DELETE do canônico | FAIL | `ACEITO` |
| V3-R04 allowlist do consumer; evento não canônico | PASS (controles) | PASS |
| V3-R05 `request_id=rule:*` humano | FAIL | `metadata.request_id = "rule:qualquer"` |
| V3-R06 envelope (4 casos) | FAIL | sem `metadata.green`; advisory no topo |
| ADV-09 lote / UPDATE / INSERT com etapa Green em lead não-Green | FAIL | `ACEITO` nos 3 |
| ADV-09 controles (lote dentro do Green, funis comuns) | PASS | PASS |
| ADV-07 gêmeo suprimido / segundo evento passa | PASS (controle) | PASS |
| ADV-07 lápide nunca é gêmeo | FAIL (não há lápide) | 0 linhas no livro-razão |

Nenhuma falha é estrutural ("does not exist"): a suíte lê livro-razão e eventos por `to_jsonb`, de propósito,
para a diferença aparecer na asserção (resposta ao ADV-11).

### 5.2 Processo (`lib/green/boundary-v3.test.ts`)

`rota` é a rota como a versão a entrega: na v3 embrulhada por `runGreenRequestBoundary`; na v2 não existe
boundary e a rota roda crua (é o que as rotas da v2 fazem).

| ID | v2 Node 24 | v2 `--no-async-context-frame` | v2 Node 22.23.3 real |
|---|---|---|---|
| ALS-01 duas requisições no mesmo tick | FAIL: B roda com request e ator de A | FAIL | FAIL |
| ALS-02 poller sobrevive à requisição | FAIL: job de B roda com contexto de A | FAIL | FAIL |
| ALS-03 `node:http` keep-alive, gate síncrono | passa | FAIL: req 2..4 começam com o contexto da req 1 | FAIL |
| sem boundary não há contexto | FAIL | FAIL | FAIL |
| contexto termina (callback tardio, throw) | FAIL | FAIL | FAIL |
| contexto aninhado | passa (controle) | passa | passa |
| ADV-05 handler dentro de requisição humana | FAIL: `request_id = req-do-admin` | FAIL | FAIL |
| ADV-05 correlação herdada | FAIL: `request_id = req-externo` | FAIL | FAIL |
| V3-R05 canônico humano com `rule:*` | FAIL: `skipped/caused_by_rule` | FAIL | FAIL |
| V3-R05 `caused_by_rule` no topo de canônico humano | FAIL | FAIL | FAIL |
| V3-R05 controles (advisory v3, regra legítima, evento legado) | passa | passa | passa |
| Total | 8 falhas / 13 | 9 falhas / 13 | 9 falhas / 13 |

### 5.3 E2E pelo servidor Next real (`tests/green-e2e/next-real-v3.e2e.ts`)

Servidor Next com o código da v2 + banco do stack na v2, Node 22.23.3: **7 falhas, 2 passam**.

| ID | v2 observado |
|---|---|
| N1 Kanban pela rota real | FAIL: canônico sem envelope (advisory no topo) |
| N2 12 requisições humanas concorrentes x 2 rajadas | PASSA (ver nota) |
| N3 6 tokens concorrentes (agenda por Bearer) | PASSA (ver nota) |
| N4 PATCH direto tirando do Green | FAIL: 204 e 0 eventos |
| N5 exclusão em lote pela rota | FAIL: sem lápide |
| N6 lote pela rota, etapa Green em lead comum | FAIL: o lead recebeu a etapa Green |
| N7 oracle cross-tenant por HTTP | FAIL: `409 23503 green_stage_not_bound` × `403 42501 … row-level security` |
| N8 service_role reescreve/apaga o canônico | FAIL: PATCH devolve 204 |
| N9 `rule:*` forjado + tick | FAIL: o lead forjado ficou em B (o controle foi a C) |

Nota honesta sobre N2/N3: no servidor Next real, em Node 22, a v2 NÃO misturou contexto entre requisições
concorrentes nas rotas medidas. Confere com a auditoria (ALS-03b): com um `await` antes do gate, que é o
formato dessas rotas, o `enterWith` não vaza. O defeito da v2 era a garantia ser circunstancial, e ele é
reproduzido em §5.2 (ALS-01/02/03 com servidor `node:http` real). N2/N3 provam que a boundary da v3 funciona
no framework real; não são prova negativa da v2.

## 6. Prova GREEN - os mesmos testes na v3

| Suíte | v2 | v3 |
|---|---|---|
| `tests/invariants/green-mutation-context-v3.test.ts` | 32 falhas / 43 | **44/44** (um caso de supressor acrescentado depois, §9) |
| `tests/green-e2e/next-real-v3.e2e.ts` contra BUILD DE PRODUÇÃO (`next build` + `next start`, Node 22) | não rodado | **9/9** |
| `lib/green/boundary-v3.test.ts`, Node 24 padrão | 8 falhas / 13 | **13/13** |
| idem, `NODE_OPTIONS=--no-async-context-frame` | 9 falhas / 13 | **13/13** |
| idem, Node 22.23.3 real | 9 falhas / 13 | **13/13** |
| `tests/green-e2e/next-real-v3.e2e.ts` (Next real, Node 22) | 7 falhas / 9 | **9/9** |

## 7. E2E real (Fases 9, 10, 11)

Fluxo exercitado, sem nenhum handler chamado in-process e sem mock de `next/headers`:

```text
cliente HTTP (vitest, Node 22) → servidor Next 16.3.6 (processo próprio, Node 22.23.3)
→ proxy.ts (middleware) → route handler real → requireRole / resolveAuthDual reais
→ cookies de sessão GoTrue reais (ou Bearer dsk_) → client Supabase → Kong 2.8.1
→ PostgREST v16.2 → Postgres 17.6 → trigger green.fn_crm_lead_boundary → event_log
```

```text
node --version   v22.23.3   (pacote npm `node@22`, reproduzível: `npx -y -p node@22 -- node …`)
pnpm --version   9.15.9     (corepack)
máquina          Node v24.14.1 (usado só nas corridas rotuladas "Node 24")
```

O arquivo de E2E não importa código do app: fala HTTP com o Next e com o PostgREST, e usa `pg` só para
fixtures e leitura. A testemunha de "qual requisição fez esta mutação" é o `api_audit_log` (a rota grava o
`requestId` da variável local dela, sem passar pelo ALS); o `x-request-id` da resposta não serve, porque o
middleware o sobrescreve com o id dele.

| Cenário | Prova na v3 |
|---|---|
| N1 | rota real do Kanban: 1 canônico; `trusted = {caller:user, actor:auth.uid(), source:user_session}`; `advisory.request_id` = `request_id` do audit da rota; nada do header no topo |
| N2 | 24 requisições concorrentes (2 rajadas no mesmo processo): cada canônico carrega o request da SUA requisição (lista inteira × lista do audit), todos distintos |
| N3 | 6 tokens em paralelo: o ator de cada mutação é o token da própria requisição; request confere com o audit |
| N4 | saída por PATCH direto: 204 + canônico `exit`; `service_role` sem contexto recusado pelo PostgREST |
| N5 | exclusão em lote pela rota: lápide `lead.deleted` com ator da sessão |
| N6 | lote pela rota não põe etapa Green em lead comum |
| N7 | oracle fechado por HTTP: Green ≡ comum (`403 42501 … row-level security`) |
| N8 | `service_role` pelo PostgREST não reescreve nem apaga o canônico; `status`/`consumed_by` seguem mutáveis |
| N9 | humano forja `request_id=rule:qualquer`; a sessão ADMIN bate `POST /api/v1/system/relogio/tick` no servidor real; o drain roda a regra para os dois leads (controle e forjado chegam a C); o canônico da regra tem `source=automation`, `request_id=rule:<regra>`, `causation_event_id` = evento humano, e a metadata não contém o id da requisição do tick nem o uid do admin; o anti-loop continua de pé (sem terceiro evento) |

O servidor foi exercitado nos dois modos, sempre em Node 22.23.3: `next dev` (Turbopack; é o modo da
comparação v2 × v3) e build de produção (`next build`, "Compiled successfully", + `next start`), este só na v3.
Resultado no build de produção: `next-real-v3.e2e.ts` 9/9 e `postgrest-real.e2e.ts` 6 passam + 1 marcador pulado.

Reprodução (nada de credencial no Git; as chaves são lidas do stack por tooling e nunca impressas):

```bash
# Node 22 reproduzível numa máquina com outro Node
npx -y -p node@22 -- node --version
# variáveis: URL/DB pelas portas publicadas do stack; chaves lidas do kong.yml do stack local,
# identificadas pelo claim `role` do JWT (anon / service_role) -> GREEN_E2E_* e as do Next
node node_modules/next/dist/bin/next build && node node_modules/next/dist/bin/next start -p 3101   # ou `next dev`
node node_modules/vitest/vitest.mjs run -c vitest.green-e2e.config.ts
```

Limite desta prova: no caminho da automação, a herança do contexto do tick (ADV-05) não é observável no banco nem na v2 (o motor
sobrescreve `request_id`); a prova negativa do ADV-05 é a de processo (§5.2), com o dispatcher real.

E2E pré-existente (`postgrest-real.e2e.ts`, S18-S22), agora em Node 22: 6 passam, 1 marcador pulado, depois de
S19 e S21 passarem ao contrato v3 (§9).

## 8. Prova v2 × v3 (mesmo teste nas duas versões)

| Cenário | v2 | v3 | Teste |
|---|---|---|---|
| saída Green sem contexto | FAIL do contrato (aceita, 0 eventos) | PASS (`42501` ou canônico `exit`) | V3-R01; N4 |
| DELETE de Opportunity Green | invisível | PASS (`42501` ou lápide canônica) | V3-R02; N5 |
| oracle cross-tenant | vulnerável (`green_stage_not_bound` × RLS) | fechado (veredito idêntico) | V3-R03; N7 |
| rewrite do canônico | permitido | recusado (`green_canonical_immutable`) | V3-R04; N8 |
| DELETE do canônico | permitido | recusado | V3-R04; N8 |
| `request_id` `rule:*` forjado | afeta a automação (lead fica em B) | não afeta (lead vai a C) | V3-R05; N9 |
| etapa Green em lead não-Green (lote) | aceita | recusada | ADV-09; N6 |
| tick herda contexto humano | sim (`request_id` do admin no contexto do handler) | não | boundary-v3 ADV-05; N9 |
| isolamento ALS Node 22 | circunstancial (ALS-01/02/03 falham) | estrutural (13/13 nos três runtimes; N2/N3 no Next real) | boundary-v3; N2; N3 |

Em todas as linhas o harness é o mesmo nas duas colunas; só mudam o código servido e a migration aplicada.

## 9. S1-S23 e testes antigos alterados (Fase 15)

S1-S23 continuam válidos, exceto nos pontos abaixo, onde o teste afirmava exatamente o comportamento que a
auditoria falsificou. Nenhum foi editado em silêncio: commit próprio (`1560e651d`, e `00fe85167` para o E2E),
com comentário `CONTRATO v3` no ponto alterado.

| Teste | Comportamento anterior (afirmado) | Por que ficou inválido | Novo contrato |
|---|---|---|---|
| S1 (`green-mutation-context.test.ts`) | `metadata.source = "kanban"` e `metadata.request_id` do header humano no topo | valores escolhidos pela sessão humana ocupavam o lugar do confiável (ADV-04) | `source = "user_session"` (derivado); header em `green.advisory`; sem `request_id` no topo |
| S8 (idem) | `metadata.source = "bulk"` | idem | `user_session` + `green.advisory.source = "bulk"` |
| S9 (idem) | `metadata.source = "stage_archive"` | idem | `user_session` + `green.advisory.source = "stage_archive"` |
| S23 #4 (`green-mutation-context-v2.test.ts`) | o `request_id` de sessão humana escolhia a linha do livro-razão | advisory decidindo o supressor (ADV-04) | humano casa por (lead, transição, janela, mais recente); `advisory_request_id` só diagnóstico; desempate por request confiável provado na suíte v3 (`GAP-SUPPRESSOR-V3`) |
| S19 (`postgrest-real.e2e.ts`) | `source=http_session`, `request_id`, `correlation_id` da rota no topo; livro-razão `request_id = requestId` | idem ADV-04 | topo `user_session`; rota em `green.advisory`; livro-razão `request_id = null`, `legacy_request_id = requestId` |
| S21 (idem) | `request_id: "req-forjado"` no topo ("advisory, não autoriza nada") | era o campo que o motor lia | `green.advisory.request_id`; sem `request_id` no topo |
| `seams-v2.test.ts` (unit, 5 casos) | o gate abria o contexto sozinho (`enterWith`), inclusive "cobrindo o resto da requisição no framework" | era o mecanismo circunstancial (ADV-06) | a rota declara a boundary; o contexto não volta para o framework |
| `seams.test.ts` (unit, 1 caso) | dispatcher herdava `correlation_id` do metadata de qualquer evento | correlação de evento legado é do emissor e virava trusted adiante | só a correlação confiável de canônico é herdada |

`tests/invariants/**` é congelado pela governança do repo (`loop/hooks/freeze-invariants.sh`). As quatro
asserções de S1/S8/S9/S23 foram alteradas com a válvula declarada (`DESKCOMM_GOV_INVARIANTS_EDIT=1`) e a
mudança de contrato citada no commit. Se a auditoria preferir os arquivos congelados byte-idênticos à v2, a
alternativa é reverter `1560e651d` nesses dois arquivos e aceitar 4 vermelhos conhecidos.

Depois do RED, a suíte v3 de banco ganhou 1 caso (desempate do supressor por request confiável) e a correção
de `any` do lint; nenhum caso existente teve expectativa afrouxada.

## 10. Censo dos writers (Fase 17)

UPDATE de `crm_leads.stage_id` no código, refeito por busca depois da implementação: **continuam 8
primitives**; nenhum UPDATE de `pipeline_id` em código de produção.

| # | Primitive | Local | UPDATE alterado na v3? |
|---|---|---|---|
| 1 | `leads/[id]/move` | `app/api/v1/leads/[id]/move/route.ts:215` | não (ver nota) |
| 2 | `moveLeadHandler` | `app/api/v1/leads/_handler.ts:1027` | não |
| 3 | `fn_mover_leads_em_lote` | `supabase/baseline.sql:17757` | não |
| 4 | `sincronizaEstagioDoAgente` | `lib/leads/agent-stage-sync.ts:362` | não |
| 5 | `moverLeadParaEtapaDeHandoff` | `lib/leads/handoff-stage-move.ts:200` | não |
| 6 | `moverLeadParaEtapaDeAgendamento` | `lib/leads/appointment-stage-move.ts:193` | não |
| 7 | `encerraDemanda` | `lib/leads/encerramento.ts:252` | não |
| 8 | `arquivarEtapa` | `lib/leads/stage-operations.ts:549` | não |

Nota (exceção a declarar): o primitive 1 mora num arquivo de rota, e a rota precisou declarar a boundary. O
diff nesse arquivo é de 10 linhas INSERIDAS e nenhuma removida (import; depois da guarda de suporte, o
`return runGreenRequestBoundary(() => handlePOST(req, ctx))` e a assinatura de `handlePOST`); o corpo,
inclusive o UPDATE, é byte-idêntico. É o custo de trocar `enterWith` por uma boundary `run` explícita num
framework sem wrapper de rota compartilhado. Nenhum writer recebeu lógica Green.

Caminhos fora dos 8, agora cobertos pela fronteira:

- PATCH direto no PostgREST em `stage_id`/`pipeline_id` (entrada, permanência e saída): V3-R01, N4;
- `rpc/fn_mover_leads_em_lote` direto e lote entre funis: ADV-09, N6;
- DELETE (exclusão em lote, direto): V3-R02, N5;
- INSERT: binding e contexto como na v2; sem canônico (EV-01B, fora de escopo).

## 11. Métricas de fork (contra o upstream `e8e2912`)

| Métrica | v1 | v2 | v3 |
|---|---|---|---|
| Arquivos upstream modificados | 8 | 12 | **20** (+7 rotas, +`lib/relogio/executar.ts`) |
| Arquivos novos | 7 | 12 | 17 |
| Writers de etapa com lógica alterada | 0 | 0 | **0** (1 arquivo de writer com declaração de boundary) |
| Seams de contexto / transporte | 5 / 1 | 8 / 2 | 8 / 2, mais 9 declarações de boundary (7 arquivos de rota) e 1 corte (tick) |
| Módulos novos de leitura | - | - | 1 (`lib/green/proveniencia.ts`) |
| Hooks DB (triggers) | 3 | 4 | **3** (`trg_green_crm_lead_boundary`, `trg_green_suppress_legacy_stage_changed`, `trg_green_canonical_immutable`) |
| Funções no schema `green` | 8 | 9 | 13 (2 da v2 ficam órfãs de trigger, não removidas porque a 0501 as recria) |
| Tabelas | 1 | 2 | 2 (+4 colunas no livro-razão) |
| Migrations | 1 | 1 (editada) | 2 (0501 intacta + 0502) |
| Linhas líquidas, só upstream | +527 | +772 | +1245 (TS +273/-72; baseline +1042, apêndices espelho; MANIFEST +2) |
| Linhas líquidas, total (git, com os relatórios anteriores) | +2958 | +5360 | +8320, sem este relatório |

Da v2 para a v3 o TS upstream cresceu 84 linhas adicionadas (e as removidas subiram de 64 para 72), em hunks
pequenos: 7 a 10 linhas inseridas por rota (zero removidas nas 6 rotas humanas), 5 a 10 nos quatro seams de
`lib/`. O custo de rebase dominante continua sendo o apêndice do `baseline.sql` (agora dois blocos). O delta
não foi comprimido à custa de segurança: o que cresceu foi declaração explícita de boundary.

## 12. Riscos restantes

### Resolvidos

- ADV-01 saída e DELETE; ADV-02 oracle; ADV-03 imutabilidade; ADV-04 advisory controlando comportamento;
  ADV-05 herança de contexto por trabalho de sistema; ADV-06 `enterWith`; ADV-09 lote entre funis.

### Mitigados

- **`GAP-SUPPRESSOR-V3` (ADV-07).** O supressor não foi redesenhado. A separação trusted/advisory não piorou o
  matching (controles verdes), mas: (a) mutação humana não tem chave confiável por requisição, então o gêmeo
  casa por (lead, transição, janela de 5 min, mais recente sem gêmeo); (b) continua valendo o achado DIAG-06:
  um membro da org consegue fazer um `lead.stage_changed` legado ser engolido por uma linha sem gêmeo. Não foi
  inventada heurística nova. Fecha com chave transacional (o writer passar o id do livro-razão) ou com o fim do
  evento legado para leads Green: spike própria.
- **Ator privilegiado declarado, não provado (ADV-12).** `trusted` de writer privilegiado significa "enviado
  por quem tem a chave de serviço", não "provado pelo banco".

### Fora de escopo (declarado)

- EV-01B / ADV-13 (INSERT, nascimento privilegiado, estados parciais).
- ADV-08 (drift da régua de `service_origin.event`: raiz sem origem aceita, catraca por regex). Não tocado; S16
  segue verde.
- Retenção do livro-razão e do `event_log` canônico; ADR; rollout; migração de produção.

### Novos (introduzidos ou revelados pela v3)

1. **O arquivo do writer 1 foi tocado** (declaração de boundary, §10). E toda rota NOVA que alcance writer de
   etapa por token precisa declarar a boundary; sem ela, o writer privilegiado falha fechado em lead Green
   (seguro, mas é uma regra a lembrar). Rota humana sem boundary continua funcionando (o ator é `auth.uid()`),
   só perde o advisory.
2. **Comparação v2 × v3 do E2E feita em `next dev`.** O build de produção foi exercitado só na v3 (9/9). O
   servidor `standalone` empacotado (`.next/standalone/server.js`, o do Dockerfile) não foi exercitado: rodou
   `next start` sobre o mesmo build.
3. **DELETE de lead Green por writer privilegiado sem contexto passa a ser recusado.** Caminhos de serviço que
   apagam leads (`apagarDadosOperacionais`, rotinas LGPD) não têm contexto: num funil Green, falham fechado.
   Mesma classe do EV-01B; precisa de censo próprio antes de qualquer uso real.
4. **Canônico não apagável.** Qualquer retenção/purga de `event_log` passa a exigir procedimento de dono.
   `TRUNCATE` (fora da API; só conexão SQL direta) não é coberto pelo trigger de linha.
5. **Exclusão da organização inteira** apaga os canônicos dela (exceção deliberada do guard).
6. **Ordem dos triggers AFTER.** A fronteira roda depois dos AFTER do upstream (ordem alfabética); o efeito
   deles é desfeito pelo rollback quando a fronteira recusa, mas é mais uma dependência semântica do upstream.
7. **Eventos canônicos antigos da v2** (sem envelope) num banco migrado: `provenienciaConfiavel` trata o topo
   como confiável só quando `caller != user`. Não há backfill.
8. **Fork drift**: 20 arquivos upstream modificados (eram 12).

## 13. Regressão (Fase 16)

Ambiente: Windows 11, Docker Desktop; `test:db` em Postgres efêmero `pgvector:pg15`; stack E2E local isolado
(`deskcomm-green-spike`, Kong 2.8.1, PostgREST v16.2, GoTrue v2.196.0, Postgres 17.6). Suítes de banco rodadas
uma de cada vez.

| Suíte | Resultado v3 | Base de comparação | Classificação |
|---|---|---|---|
| `tsc --noEmit -p tsconfig.typecheck.json` | exit 0 | - | - |
| `eslint` focado (lib/green, seams, rotas tocadas, suítes Green) | 0 erros | - | - |
| Green unit (`lib/green`, 5 arquivos) | 48/48 em Node 24, em `--no-async-context-frame` e em Node 22.23.3 | v2: 35 testes | - |
| Invariantes Green (v1 + v2 + v3) | 81/81 | v2: 37/37 | 4 asserções antigas alteradas (§9) |
| `pnpm test:db` inteira | **344/344 arquivos, 2832 passed, 1 expected fail, 1 skipped** (`test:db verde`, 1470 s) | v2: 343/343, 2788 passed | zero falha; +1 arquivo, +44 casos |
| E2E Green (2 arquivos), Node 22, `next dev` | 15 passed, 1 skipped | v2 no arquivo novo: 7 falhas / 9 | - |
| E2E Green (2 arquivos), Node 22, build de produção | 15 passed, 1 skipped | - | - |
| `vitest --project produto` inteira (6 workers) | 1399 arquivos passam; **7 arquivos / 11 casos falham** | os mesmos 7 arquivos rodados com `app/`+`lib/` da v2: 7 / 11 idênticos | pré-existentes (`lgpd-pdf-*` x4, `confianca-do-handoff-nao-e-similaridade`, `followups-de-demonstracao-sao-possiveis`, `rascunho-superado-nao-e-regravado`). **Novas: 0** |
| `vitest --project cercas` inteira (4 workers) | 1ª corrida: 10 arquivos / 38 casos; depois da correção: **9 arquivos / 37 casos** | os mesmos 10 arquivos num worktree destacado da v2: 9 / 37 idênticos | 9 pré-existentes (git/gh de release, bash/tmp, rede neste Windows). **1 falha NOVA achada e corrigida** (abaixo) |

**Falha nova introduzida pela v3 e corrigida antes da entrega.** A primeira forma da boundary nas rotas era
`export const POST = comFronteiraGreen(handlePOST)`. A cerca upstream `tests/unit/suporte-cobertura-de-efeitos`
exige que o handler mutante exportado mostre `requireSupportWrite(` e reprova indireção opaca de propósito: 6
rotas acusadas. Não era flaky nem ambiente; era regressão de um gate do upstream. Correção (`d6b9ab39e`): o
handler exportado volta a ser `export async function`, mantém a guarda de suporte e delega ao corpo original
dentro de `runGreenRequestBoundary`. Depois dela: cerca verde, testes das rotas verdes (187/187 no recorte
rodado), E2E reexecutado inteiro no build de produção (9/9 + 6/6). Como a correção veio depois da primeira
corrida completa, `test:db` e `produto` foram REEXECUTADAS inteiras no SHA final de código (`d6b9ab39e`), com
os mesmos números da tabela acima (344/344 e 2832 passed; 7 arquivos / 11 casos pré-existentes). A `cercas`
inteira não foi repetida depois da correção: foram repetidos os 10 arquivos que falharam nela (9 / 37, iguais
à v2) e os demais 253 já tinham passado.

Ruído de ambiente observado e tratado no harness (não mascarado): o PostgREST recusou um JWT recém-emitido com
`PGRST303 JWT issued at future` (defasagem de relógio entre contêineres logo após o Docker subir); o `beforeAll`
do E2E passou a esperar 3 s depois do login. E a rota de Kanban devolve 409 quando `expected_updated_at` perde
os microssegundos (o harness passou a ler o timestamp com a precisão do banco).

Integridade da árvore ao final: `git status` limpo na branch v3; v1 e v2 nos mesmos SHAs; nenhum push, PR ou
merge; `.next/` e o worktree temporário da v2 removidos. O stack E2E local ficou com a 0502 aplicada e com as
fixtures dos testes (como o E2E original já deixava); a regra de automação de teste é desativada no `afterAll`.

## 14. Veredito do implementador

**V3-PASS-COM-GAPS.**

Os invariantes centrais falsificados pela auditoria foram corrigidos e cada um tem prova negativa na v2 e prova
positiva na v3 com o mesmo teste:

| Achado | Neutralizado? | Evidência decisiva |
|---|---|---|
| ADV-01 | sim | V3-R01/R02 (v2 `ACEITO`, 0 eventos → v3 `42501` ou canônico `exit` / lápide); N4, N5 por HTTP |
| ADV-02 | sim | V3-R03 e N7: `green_stage_not_bound` × RLS na v2; veredito idêntico na v3, por construção (hook AFTER) |
| ADV-03 | sim | V3-R04 (10 colunas + DELETE) e N8: `ACEITO`/204 na v2; `green_canonical_immutable` na v3 |
| ADV-04 | sim | V3-R05/R06, anti-loop unitário e N9: o lead forjado ficava em B na v2; vai a C na v3 |
| ADV-05 | sim | boundary-v3 (dispatcher real): `request_id` do admin no handler na v2; raiz própria na v3; N9 no servidor real |
| ADV-06 | sim | ALS-01/02/03 falham na v2 (Node 22 real); 13/13 na v3 nos três runtimes; N2/N3 no Next real, dev e produção |

A hipótese da mutation boundary continua viável: os 8 UPDATEs de etapa não mudaram, e PATCH direto, lote entre
funis, saída e DELETE passaram a ser cobertos no banco.

Não é V3-PASS porque há gaps residuais delimitados, que não invalidam o desenho:

1. `GAP-SUPPRESSOR-V3`: supressor não redesenhado; sem chave confiável para mutação humana; DIAG-06 segue válido.
2. Quatro asserções de invariantes congelados (S1, S8, S9, S23 #4) e duas do E2E (S19, S21) foram alteradas por
   mudança de contrato. Está documentado e justificado (§9), mas é decisão que a auditoria deve confirmar.
3. O arquivo do writer 1 recebeu a declaração de boundary (10 linhas inseridas, corpo intacto) e 7 arquivos de
   rota upstream entraram no fork.
4. DELETE de Opportunity Green por caminho de serviço sem contexto agora falha fechado (classe EV-01B, sem censo).
5. A prova negativa do ADV-05 e do ADV-06 é de processo; no servidor Next real a v2 não vazou nas rotas medidas.
6. ADV-08 e ADV-12 não foram tocados; EV-01B (ADV-13) continua fora.

Próximo passo sugerido (não executado): auditoria independente limitada à v3; depois, spikes próprias para o
supressor e para EV-01B (incluindo o censo de DELETE/INSERT privilegiados em funil Green). Ainda não é hora de ADR.

SPIKE-DESKCOMM-09: V3-PASS-COM-GAPS
