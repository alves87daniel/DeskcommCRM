# SPIKE Green — Mutation Context v1 (relatório para auditoria)

Status: SPIKE DESCARTÁVEL. Não é produto, não vai para produção, não vai para a `main`.

Branch: `spike/green-mutation-context-v1` (fork `alves87daniel/DeskcommCRM`).
Desenho: Conector Green, auditoria deskcomm-fit, documento `05A-SPIKE-MUTATION-CONTEXT`.

## 1. Base e commits

| Item | Valor |
|---|---|
| Upstream | `melgarafael/DeskcommCRM` |
| Tag base | `v1.69.0` (tag anotada `e21026b…`, aponta para o commit abaixo) |
| Commit base | `e8e2912178031d321caf0912b270ee06bd2c36c7` |
| `main` do upstream no fim do spike | `e8e2912178031d321caf0912b270ee06bd2c36c7` (não avançou; forward-check = base) |
| Commits do spike | ver `git log e8e2912..spike/green-mutation-context-v1` (6 commits, listados na entrega; o último é o deste relatório) |

## 2. Arquivos

### Upstream modificados (8)

| Arquivo | Papel | Linhas (sem espaço em branco) |
|---|---|---|
| `lib/supabase/fetch-do-servidor.ts` | transporte: header `x-green-mutation-context` lido do ALS NA HORA do fetch | +7 −1 |
| `lib/event-log/dispatcher.ts` | seam: causation/correlation do evento corrente para todo handler | +13 −1 |
| `lib/automation/engine.ts` | seam: `request_id=rule:<id>` + causation + `service_origin` por evento (anti-loop) | +29 −0 (o `git diff` exato mostra +63 −34 por reindentação do laço envolvido) |
| `lib/mcp/server.ts` | seam: ator técnico do token MCP externo | +11 −1 |
| `lib/ai/runtime/tools.ts` | seam: ator do agente, job e idempotency nas tools in-process | +16 −1 |
| `lib/atendimento/fronteira-server.ts` | seam: fronteira do job vira `service_origin.kind=continuation` | +21 −1 (exato: +38 −18 por reindentação do bloco envolvido) |
| `supabase/baseline.sql` | apêndice idempotente da migration 0501, ANTES da varredura de anon | +434 |
| `supabase/migrations/MANIFEST.md` | linha da migration 0501 | +1 |

### Novos (7)

- `lib/green/mutation-context.ts` — módulo Green (ALS, contrato v1, validação, serialização, adaptadores).
- `lib/green/mutation-context.test.ts`, `lib/green/transporte.test.ts`, `lib/green/seams.test.ts` — unitários.
- `supabase/migrations/20260930180000_0501_spike_green_mutation_context.sql` — migration do spike.
- `tests/invariants/green-mutation-context.test.ts` — S1–S14 no banco.
- `docs/spike/GREEN-MUTATION-CONTEXT-V1.md` — este relatório.

### Contagens do critério de custo

| Métrica | Valor |
|---|---|
| Writers de `crm_leads.stage_id` modificados diretamente | **0** (os 8 primitives do EV-01 ficaram intactos) |
| Seams de transporte | 1 (`fetch-do-servidor.ts`) |
| Seams de contexto | 5 (dispatcher, engine, mcp/server, ai/runtime/tools, fronteira-server) |
| Hooks DB centrais | 3 triggers (BEFORE em `crm_leads`, AFTER em `crm_leads`, BEFORE INSERT em `event_log`) |
| Migration | 1 (`0501`) |
| Arquivos upstream tocados | 8 (6 TS + 2 artefatos de schema) |

## 3. O que a migration 0501 instala

- Schema `green`; tabela `green.product_pipeline_binding(organization_id, pipeline_id, product_key)` — marcador de pipeline gerenciado (RLS ligada, sem policy: só definer/service_role leem).
- `green.fn_is_green_pipeline(org, pipeline)` (definer; `to_regclass` ⇒ sem módulo, hooks no-op).
- `green.fn_mutation_context()` — resolver: header PostgREST (`request.headers` → Base64/JSON) ou GUC transacional `green.mutation_context` (conexão pg direta). Matriz de confiança:
  - `auth.uid()` presente ⇒ `caller=user`, actor = `{kind:user, id:auth.uid()}`; `actor`/`service_origin` do header IGNORADOS; `source/request_id/correlation_id/causation_event_id/idempotency_key/source_job_id` só como advisory (e só se válidos).
  - `service_role` (role da sessão ou claim) ou conexão direta ⇒ contexto validado por schema (v=1, `source`, `actor.kind ∈ {ai_agent, api_token, webhook_source, system}`, ids com charset/limite, `service_origin ∈ {event, continuation}`, chaves fora do contrato recusadas, ≤ 4 KB). Inválido/ausente ⇒ `valid=false` com `reason`.
- `green.fn_assert_service_origin(origin, org, contact)` — `event`: org/contato batem com o lead e o evento existe; `continuation`: org/contato batem e a fronteira é a vigente (mesma régua de `assertCurrentServiceBoundary`) ⇒ senão `service_boundary_stale` (40001) / `green_service_origin_scope_mismatch` (23503).
- `trg_green_guard_crm_lead_stage` BEFORE INSERT OR UPDATE: só quando muda `stage_id`/`pipeline_id` (ou INSERT) em pipeline Green — confere etapa do funil, exige contexto válido em caller ≠ user (`green_mutation_context_required`, 42501, `detail` = motivo), valida `service_origin`.
- `trg_green_emit_crm_lead_stage_changed` AFTER UPDATE: `OLD.stage_id IS DISTINCT FROM NEW.stage_id` em pipeline Green ⇒ `public.emit_event('lead.stage_changed','crm_lead', …)` com metadata `green_canonical=true`, `green_context_version=1`, `caller`, `actor`, `source`, `request_id`, `correlation_id`, `causation_event_id`, `idempotency_key`, `source_job_id`, mais `actor_user_id`/`actor_kind` (compat com o metadata legado). Payload: `pipeline_id`, `from_stage_id`, `to_stage_id`, `status` (já derivado pelo BEFORE `fn_crm_lead_close_on_stage`), e `service_origin` só para caller ≠ user; `command` nunca viaja (o `emit_event` deriva). Erro não é capturado ⇒ UPDATE faz rollback.
- `trg_green_suppress_legacy_stage_changed` BEFORE INSERT em `event_log`: `lead.stage_changed` + `crm_lead` + lead Green + sem `green_canonical` ⇒ `return null` (a linha não nasce). Outros tipos e leads não-Green intocados.

## 4. Resultado S1–S14

Todos executados em `tests/invariants/green-mutation-context.test.ts` (23 casos), contra o Postgres efêmero do harness com o baseline (+ apêndice 0501). Cada request é simulada como o PostgREST a entrega (`set local role`, `request.jwt.claims`, `request.headers`).

| Cenário | Resultado | Evidência |
|---|---|---|
| S1 humano/Kanban | **PASS** | A→B: 1 evento, `actor={user, auth.uid}`, `service_origin.kind=command` derivado; `emit_event` legado da rota ⇒ ainda 1 evento |
| S2 header forjado | **PASS** | header com `actor=system` + `continuation`: evento segue `user`/`command`; membro de outra org: RLS recusa (0 linhas, 0 eventos) |
| S3 MCP | **PASS** | `api_token` e `ai_agent` (agent_id, api_token_id) no evento; `actor.kind=user` por service_role ⇒ 42501 `actor_kind` |
| S4 automação | **PASS** | evento canônico com `request_id=rule:R`, `causation_event_id=E`, `service_origin=event(E)`; `runAutomationForEvent` real devolve `skipped/caused_by_rule` sem consultar o banco; origem de outro contato ⇒ recusa, etapa intacta |
| S5 agent stage sync | **PASS** | CAS pela etapa de origem casa: evento com `agent_runtime`, `source_job_id`, `ai_agent`, `continuation`; humano moveu antes: CAS não casa, 0 linhas, 0 eventos |
| S6 handoff | **PASS** | fronteira vigente move; `service_revision` velha ⇒ `service_boundary_stale` 40001, etapa não muda, 0 eventos; fronteira de outro contato ⇒ scope_mismatch |
| S7 agenda | **PASS** | evento visível dentro da transação; rollback desfaz estado E evento; commit leva os dois com `source=agenda` |
| S8 bulk | **PASS** | `fn_mover_leads_em_lote` com 3 leads ⇒ 3 eventos canônicos (actor humano); emissão legada por lead ⇒ continua 3 |
| S9 archive stage | **PASS** | UPDATE em massa (`where stage_id=origem`) ⇒ 1 evento por card, com `from/to` corretos |
| S10 rollback | **PASS** | trigger sabotador em `event_log` ⇒ UPDATE falha, etapa fica A, 0 eventos; controle sem sabotagem move e emite |
| S11 non-Green | **PASS** | service_role sem contexto move; 0 eventos canônicos; `emit_event` legado nasce como sempre (humano e service_role); `fn_is_green_pipeline` = false |
| S12 service-role sem contexto | **PASS** | Green ⇒ 42501 (`missing`, `source`, `actor_required`, `undecodable_header`, `unknown_key`); INSERT privilegiado também; conexão pg direta com GUC passa (`caller=direct`) e sem GUC recusa |
| S13 concorrência | **PASS** | Node: 3 cadeias intercaladas mantêm o próprio header (6 requests); banco: 2 transações intercaladas com contextos diferentes, cada evento com o seu |
| S14 idempotency | **PASS** | `idempotency_key` e `correlation_id` preservados; replay com a mesma chave gera 2º evento (não há exactly-once — declarado, não fingido) |

Extra: guarda de binding de etapa (etapa de outro funil em lead Green ⇒ `green_stage_not_bound`, 0 eventos).

## 5. Comandos executados e outputs relevantes

```bash
corepack pnpm@9.15.9 install --frozen-lockfile                      # Done in 23.9s
corepack pnpm@9.15.9 exec tsc --noEmit -p tsconfig.typecheck.json    # exit 0
corepack pnpm@9.15.9 exec eslint lib/green lib/supabase/fetch-do-servidor.ts lib/event-log/dispatcher.ts lib/automation/engine.ts lib/mcp/server.ts lib/ai/runtime/tools.ts lib/atendimento/fronteira-server.ts   # exit 0
corepack pnpm@9.15.9 exec vitest run --project produto lib/green \
  lib/supabase/fetch-do-servidor.test.ts tests/unit/service-boundary.test.ts \
  tests/unit/mcp-servidor-busca-vazia-nao-e-sucesso.test.ts tests/unit/mcp-recusa-antes-de-executar-a-tool.test.ts \
  tests/unit/mcp-respeita-o-teto-por-token.test.ts tests/unit/busca-vazia-nao-e-sucesso.test.ts \
  tests/unit/dispatcher-external-mode.test.ts tests/unit/event-log-drain-loop.test.ts \
  tests/unit/fronteira-exige-procedencia-e-o-backfill-cobre-o-legado.test.ts \
  tests/unit/mcp-handoff-assignment.test.ts tests/unit/mcp-governance-tools.test.ts
#   Test Files 13 passed (13) / Tests 94 passed (94)
corepack pnpm@9.15.9 exec vitest run --project cercas tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts \
  tests/unit/manifest-cita-caminho-que-existe.test.ts tests/unit/drain-loop-carrega-deps-sob-tsx.test.ts \
  tests/unit/imagens-ok-so-aceita-pulo-declarado.test.ts tests/unit/manifest-x-migrations.test.ts \
  tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/baseline-reaplicavel.test.ts \
  tests/unit/main-sem-migration-duplicada.test.ts
#   Test Files 8 passed (8) / Tests 34 passed (34)
CONFERENCIA_KIT_RELEASE=v1.69.0 corepack pnpm@9.15.9 run test:db tests/invariants/green-mutation-context.test.ts
#   install ok / update ok (idempotente) / update.sh checkout+v1.69.0+v1.63.0: 158 regras
#   Test Files 1 passed (1) / Tests 23 passed (23) / test:db verde
corepack pnpm@9.15.9 cercas          # suíte estrutural inteira (ver §7)
CONFERENCIA_KIT_RELEASE=v1.69.0 corepack pnpm@9.15.9 run test:db   # suíte de invariantes inteira: 342/342 arquivos, 2774 testes, verde (ver §7)
corepack pnpm@9.15.9 exec vitest run --project produto --maxWorkers=8   # PowerShell, execução única (ver §7)
```

Ambiente: Windows 11, Node 24.14.1, pnpm 9.15.9 via corepack (o `packageManager` do repo), Docker Desktop 4.92 (engine 29.8.0), imagem `pgvector/pgvector:pg15` (piso do harness). Tags `v1.69.0` e `v1.63.0` foram buscadas do upstream para a conferência do kit (o fork nasce sem tags).

## 6. O que NÃO foi possível executar

- **E2E real por PostgREST/HTTP.** O harness de invariantes do Deskcomm sobe só um Postgres cru; o transporte pelo header é provado em dois níveis: (a) unitário, o `fetchDoServidor` injeta o header a partir do ALS nos dois ramos e sob concorrência; (b) no banco, o resolver lê `request.headers` exatamente como o PostgREST o expõe (mesmo GUC que a migration 0250 lê em produção). Falta a prova ponta a ponta contra um Kong/PostgREST real (`supabase start` do fork exige `.env.local` do instalador). Risco residual: PostgREST rebaixa headers para minúsculas e os expõe em `request.headers` — o resolver lê a chave minúscula; não há indício de filtragem de headers customizados no PostgREST.
- **`pnpm test:shell` / e2e Playwright** — fora do escopo do spike (não tocam nos seams).

## 7. Suítes inteiras (regressão upstream)

- `pnpm cercas` (263 arquivos): na branch do spike, 12 arquivos falham; **10 falham identicamente no commit base** `e8e2912` neste ambiente Windows (Python não instalado, caminhos bash do `/tmp`, workflows `gh`/git de release, locale, `release-chega-na-lp` sem rede à LP, `telas-sem-dado-de-mentira` timeout de 15 s). Os 2 restantes (`drain-loop-carrega-deps-sob-tsx`, `imagens-ok-so-aceita-pulo-declarado`) foram timeouts de 15 s sob carga concorrente e **passam isolados na branch do spike** (8/8 arquivos, 34/34 casos, §5). Os dois únicos vermelhos causados pelo spike (`varredura-anon-e-o-ultimo-bloco`, `manifest-cita-caminho-que-existe`) foram corrigidos antes do commit (apêndice antes da varredura, sem grant a anon; MANIFEST sem caminho externo).
- `pnpm test:db` inteira (todos os `tests/invariants/**`, com os hooks Green instalados no baseline): **verde** — `Test Files 342 passed (342)`, `Tests 2774 passed | 1 expected fail | 1 skipped (2776)`, 1477 s, `test:db verde` (inclui `green-mutation-context.test.ts`). Prova S11 em escala: nenhum invariante upstream de lead/evento/RLS mudou com os três hooks ativos.
- `vitest --project produto` inteira, execução única pelo PowerShell com `--maxWorkers=8` e nenhuma outra suíte em paralelo: `Test Files 8 failed | 1396 passed (1404)`, `Tests 16 failed | 14659 passed | 1 expected fail (14676)`, 414 s, sem nenhum erro de criação de processo. **Zero falhas introduzidas pelo spike.** As 8 falham igualmente no commit base `e8e2912`, rodadas isoladas nas duas árvores neste mesmo Windows:

  | Arquivo | Causa no ambiente | Base `e8e2912` |
  |---|---|---|
  | `lgpd-pdf-meet`, `lgpd-pdf-propostas`, `lgpd-pdf-replies`, `lgpd-pdf-campos-personalizados` | `pdfjs-dist`: caminho Windows sem barra final (`Invalid factory url`) | falha igual |
  | `painel-nao-promete-o-que-nao-cumpre` | varredura de fonte acha 0 leituras de ambiente no Windows | falha igual (5/12) |
  | `confianca-do-handoff-nao-e-similaridade`, `followups-de-demonstracao-sao-possiveis`, `rascunho-superado-nao-e-regravado` | caminho com `\` e contagem de chamadas em fixture | falha igual |

  Uma rodada anterior pelo Git Bash (MSYS) acusou também `branding.test.ts`, e essa falha **era do spike**: o nome da marca num literal de `lib/green/mutation-context.test.ts`. Corrigida no commit final e verificada isolada (`branding` + `lib/green`: 4 arquivos, 65 testes verdes). As demais falhas daquela rodada (`theme`, `faixa-de-conexao-caida-vem-do-seam`, `tag-em-lote-mostra-existentes`) foram timeouts de 15 s sob carga e não se repetem na execução limitada a 8 workers.

## 8. Riscos encontrados

1. **Reordenação na mesma etapa em lead Green não gera evento.** `moveLeadHandler` emite `lead.stage_changed` mesmo quando `to_stage_id == stage_id` (reordenação); o hook só emite quando a etapa MUDA e o supressor engole a emissão legada. Para lead Green, reordenar deixa de gerar `lead.stage_changed` (consumidores de follow-up/aviso não recebem "entrou na etapa" que não entrou). É arguivelmente o comportamento correto, mas é diferença observável.
2. **O supressor é por lead, não por transação.** Qualquer `lead.stage_changed`/`crm_lead` sem `green_canonical` para lead Green é engolido — inclusive um emitido por um caminho futuro que NÃO tenha passado pelo UPDATE (não existe hoje). `event_log` não tem coluna de transação para uma regra mais fina.
3. **`service_origin` na automação é validada contra o lead escrito.** Se uma ação de regra escrever um lead de outro contato (ex.: transferência/clone), a origem `event` do contexto do motor não casa e a mutação Green é recusada (fail-closed, como o desenho pede). Precisa de tratamento explícito na adaptação (contexto por ação, não por regra).
4. **`fronteira-server` marca `actor=system/<job.kind>`**; o agente real só aparece quando a tool in-process roda (contexto aninhado sobrescreve para `ai_agent`). Um writer que rode dentro do job MAS fora das tools (ex.: `mirrorLeadStageToCrm` → `sincronizaEstagioDoAgente`) sai como `system` + `source=agent_engine` + `source_job_id`. Autoria menos precisa que a atual (`actor_kind: "ai"`), porém rastreável pelo job.
5. **Custo por linha.** Dois triggers a mais em `crm_leads` (um SELECT no binding por INSERT/UPDATE que muda etapa) e um em `event_log` (um SELECT em `crm_leads` por `lead.stage_changed`). Desprezível, mas existe em lead não-Green.
6. **Header por request humana também.** `server.ts` (sessão do usuário) injeta o header quando há contexto ALS na rota — o banco ignora actor/origin; só metadata advisory. Sem risco de autoridade, mas o header viaja em toda chamada do SDK dentro do contexto (inclusive leituras).
7. **`caller=direct` aceita GUC.** Uma conexão pg com privilégio de escrever `crm_leads` pode escrever o GUC; isso não amplia nada (quem escreve o GUC já escreve a tabela), mas é o ponto a fechar quando houver writer pg real (política: RPC/command boundary aprovada).
8. **Upgrade/fork drift.** Os 6 seams TS são hunks pequenos e locais; o maior custo de rebase é o apêndice do `baseline.sql` (posição antes da varredura de anon) e o número `0501`, que colidirá com a próxima migration upstream (a política do repo é renumerar).

## 9. Decisões tomadas durante a implementação

- **Fail-open no seam, fail-closed no banco.** `withGreenMutationContext` com contexto inválido roda SEM contexto (nunca sob o do pai) e avisa; a boundary do banco recusa lead Green sem contexto. Motivo: o upstream `tests/unit/service-boundary.test.ts` usa fronteira com ids não-UUID — um seam que lança derrubaria fluxo não-Green.
- **Guarda por MUDANÇA de etapa, não por `UPDATE OF`.** `UPDATE OF stage_id` dispara também quando o SET repete o valor; a guarda só age quando `stage_id`/`pipeline_id` mudam (ou INSERT), para reordenação privilegiada não exigir contexto.
- **Trigger functions sem grant a anon** (a varredura de anon do baseline proíbe devolver anon; o Postgres não confere EXECUTE ao disparar trigger). Guarda retorna cedo para `anon`.
- **Apêndice do baseline entra antes do bloco `VARREDURA anon`** (regra do repo, `varredura-anon-e-o-ultimo-bloco.test.ts`).
- **Compat de metadata:** o evento canônico grava também `actor_user_id` (humano) e `actor_kind`, os campos que o metadata legado já usava.
- **Dispatcher não propaga `request_id` do evento causador** (só causation/correlation): propagar `rule:*` faria handlers de 2º nível (handoff etc.) serem pulados pelo motor — o anti-loop de profundidade 2 é v2 no upstream.
- **`command` nunca viaja; `unavailable` não é origem.** O `emit_event` deriva o retrato no banco quando não há `service_origin`.
- **Migration 0501 registrada no MANIFEST e no apêndice do baseline** (os 3 artefatos que o repo exige), apesar de ser spike: sem isso as cercas do próprio repo ficam vermelhas e a suíte de invariantes inteira não roda com os hooks.

## 10. Divergências em relação ao documento 05A

- O documento sugere `actor.kind` no contexto do job do agente como `ai_agent`; o `withServiceJob` não conhece o agente (só o job), então marca `system` + `source=agent_engine` + `source_job_id`; a tool in-process refina para `ai_agent` (contexto aninhado).
- O documento cita `fallback futuro para GUC transacional em conexão pg`; o spike já implementa (`green.mutation_context`, S12) porque o worker do agent-engine usa `pg` direto em parte dos caminhos.
- Metadata canônica tem `caller` (user/service_role/direct) além dos campos listados — para o auditor distinguir a origem da confiança.
- O supressor foi ligado na mesma migration (o documento pede "só depois dos testes de contexto/anti-loop verdes"): os testes estão no mesmo commit e a suíte S1–S14 passou antes do commit da migration.
- Sem ledger Green dedicado (o documento o deixa como decisão de retenção, não de atomicidade).

## 11. Decisão EV

**PASS** para os critérios do documento: estado + evento canônico no mesmo commit (S7, S10); exatamente um evento por mutação Green (S1, S3, S8); actor humano não forjável (S2); actor privilegiado atribuído (S3, S5); anti-loop preservado (S4); `service_origin` preservada e validada (S4, S5, S6); non-Green sem mudança (S11 + suíte de invariantes inteira); concorrência sem cross-context (S13); delta de core pequeno (0 writers, 6 seams, 1 migration); forward-check = base (upstream `main` ainda é `v1.69.0`).

Reservas: item 6 (E2E HTTP real pendente) e riscos 1–4 acima.
