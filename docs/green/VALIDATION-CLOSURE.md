# Encerramento da validação do Deskcomm - GREEN-BASELINE-1.0

Relatório de fechamento da fase de validação. Fundação: [`GREEN-BASELINE-1.0.md`](GREEN-BASELINE-1.0.md); decisão de
upstream: [ADR-GREEN-001](../adr/GREEN-001-deskcomm-fundacao-congelada.md); backlog:
[`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md).

## 1. Respostas

1. **O Deskcomm foi validado?** SIM, como fundação histórica do ConectorGreen (v1.69.0, `e8e29121`).
2. **Ainda precisamos provar compatibilidade arquitetural?** NÃO. As cinco frentes estão seladas e a regressão do
   conjunto, tratado como uma única baseline, passou (seção 4).
3. **Existem débitos?** SIM, registrados em [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md): 9 P0, 5 P1, 12 P2 e
   os INFO.
4. **Esses débitos impedem começar a construir produto?** NÃO. Nenhum item está classificado como BLOCKER; os P0
   impedem o deploy de produção, não a construção.
5. **Qual é a próxima fase?** CONSTRUÇÃO DO CONECTORGREEN.

## 2. Fonte e identificação

| Item                   | Valor                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Fonte congelada        | `spike/green-canonical-event-cutover-v1` @ `38e2f16cd987ff3b627dbb266ed9631a142cf486` (local = origin) |
| Branch da baseline     | `release/green-baseline-1.0`, criada exatamente em `38e2f16c`                                          |
| `main` antes da adoção | `e8e2912178031d321caf0912b270ee06bd2c36c7` (= upstream v1.69.0)                                        |
| Base comum             | `git merge-base origin/main 38e2f16c` = `e8e29121`: a cadeia Green descende da fundação, +50 / -0      |
| Commit de consolidação | o commit que traz este documento; só documentação (seção 6)                                            |
| Data                   | 2026-10-04                                                                                             |

Preflight (Fase 0): árvore limpa, `HEAD` = `origin/spike/green-canonical-event-cutover-v1` = `38e2f16c`; `origin/main`
não avançou desde a fundação e não tem commit fora da cadeia. Nenhuma divergência.

## 3. Ambiente

Windows 11, Docker Desktop; `test:db` e harness de upgrade em `pgvector/pgvector:pg15` efêmero (o piso); stack local
`deskcomm-green-spike` (Kong, PostgREST, GoTrue, Postgres 17) para os E2Es; Node 22.23.3 (`npx -p node@22`, a versão
de produção/CI) para `test:db`, `tsc`, build e E2Es; Node 24.14.1 e `--no-async-context-frame` como controle do
contexto ALS. `SENTRY_DSN=off`. Suítes de banco uma de cada vez. Chaves do stack lidas do `kong.yml` por script e
passadas só ao processo filho; nada impresso nem gravado no repositório.

## 4. Regressão (Fase 9)

Regressão, não auditoria: nenhum ataque novo, nenhum contrato reaberto. Código sob teste = `38e2f16c`; o commit de
consolidação só acrescenta documentação.

| #   | Suíte                                                            | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tsc --noEmit -p tsconfig.typecheck.json` (Node 22)              | **exit 0**, nenhum diagnóstico (147 s)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | `eslint` nos 54 arquivos `.ts` novos/alterados pela cadeia       | **54 arquivos, 0 erros, 0 avisos**, nenhum ignorado                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Suítes Green seladas (`test:db`, 9 arquivos)                     | **9/9 arquivos, 342/342** (63 s); por arquivo 23/14/44/23/28/31/59/73/47, iguais às selagens                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | `test:db` inteira (Node 22)                                      | **350/350 arquivos, 3093 passed, 1 expected fail, 1 skipped**, exit 0, 1711 s; install + update com `ON_ERROR_STOP=1`; isolamento do `update.sh` (checkout, v1.69.0, v1.63.0) 158/158 regras. Idêntico à selagem do GREEN-03                                                                                                                                                                                                                                           |
| 5   | `test:db:update` (atualização sobre banco com dados)             | **verde**, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | Unidade `lib/green` (9 arquivos)                                 | **97/97** em Node 24.14.1, em `--no-async-context-frame` e em Node 22.23.3                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | `test:unit` inteira (`vitest run`, controles não-Green e cercas) | 1673 arquivos: 1652 verdes, 21 vermelhos (54 casos) na corrida cheia. Isolados: 4 passam (carga) e 17 seguem vermelhos com 49 casos; os **mesmos 17 arquivos e os mesmos 49 casos falham na v1.69.0 intocada** (worktree destacado em `e8e29121`). Nenhum dos 17 é tocado pela cadeia; causas do ambiente Windows (`spawnSync bash ENOENT`, URL de fonte do `pdfjs` com barra invertida, CRLF em repositório temporário, timeout). **Nenhuma falha nova**              |
| 8   | Build de produção (`next build`, Node 22)                        | **exit 0** (381 s), Node 22.23.3, Next.js 16.3.6 (Turbopack): compilação 69 s, TypeScript 4,1 min, 61/61 páginas estáticas; nenhum erro no log. `.next` parcial da tentativa anterior apagado antes (build limpo)                                                                                                                                                                                                                                                      |
| 9   | E2Es Green (`vitest.green-e2e`, 6 arquivos) no Next de produção  | **6/6 arquivos, 42 passed, 2 skipped, 0 failed**, exit 0 (51,8 s) contra `next start -p 3101` do build da linha 8 (servidor respondeu `/` 307 e `/login` 200 antes da suíte). Por arquivo: `canonical-cutover-real` 10, `structural-real` 12, `next-real-v3` 9, `postgrest-real` 6, `lifecycle-real` 4, `automation-origin-real` 1; os 2 skipped são os marcadores "sem stack" de `postgrest-real` e `automation-origin-real`. Idêntico à selagem do GREEN-03 (42 + 2) |

Incidente ambiental, não regressão: a primeira tentativa da linha 8 morreu com `os error 1455` (paging file / commit
limit do Windows esgotado, workers do Turbopack e do Node caindo em consequência). A causa era a capacidade de commit
da máquina, não o código. O pagefile foi reconfigurado e o build foi refeito, sem nenhuma mudança de código, em
ambiente com capacidade de commit adequada (resultado acima). Não é requisito do ConectorGreen.

## 5. Instalação e upgrade (Fase 8)

Harness descartável (fora do repositório): Postgres 15 efêmero, prelude extraído de `scripts/test-db.sh`, baseline
v1.69.0 tirado de `e8e29121`, dados semeados numa instalação v1.69.0 (2 organizações, com os funis que o produto semeia mais 4 funis e 12
etapas próprios, 80 contatos, 160 leads abertos e ganhos, movimentos e eventos legados: 379 linhas em 14 tabelas). Impressão digital do
catálogo: uma linha por esquema, tabela, coluna, constraint, índice, função (md5 da definição e ACL), trigger,
policy, view, enum, default ACL, publicação e extensão (6110 objetos na 1.0).

| Item                               | Prova                                                                                                                                                                                                                                                                                                        | Resultado |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| A. Fresh install                   | `baseline.sql` 1.0 com `ON_ERROR_STOP=1` (5,7 s); também a cada `test:db`                                                                                                                                                                                                                                    | SIM       |
| B. Reaplicação / idempotência      | segunda passada com `ON_ERROR_STOP=1` (3,5 s); catálogo da instalação nova = catálogo depois de reaplicar                                                                                                                                                                                                    | SIM       |
| C. Upgrade v1.69.0 → 0508 (cadeia) | v1.69.0 + dados + 0501..0508, uma transação por arquivo (~0,5 s cada): delta de catálogo **idêntico** ao do apêndice do baseline (113 linhas: 1 esquema, 5 tabelas, 40 colunas, 18 constraints, 10 índices, 25 funções, 10 triggers; 3 FKs e 1 função substituídas); dados das 14 tabelas byte a byte iguais | SIM       |
| C. Upgrade v1.69.0 → 0508 (kit)    | v1.69.0 + dados + `baseline.sql` 1.0 duas vezes com `ON_ERROR_STOP=1` (3,4 s): catálogo **idêntico** ao da instalação nova; dados mudam exatamente como no controle (o `update.sh` da própria v1.69.0 reaplicando a v1.69.0: mesmas 6 tabelas, mesmas colunas, backfills idempotentes do upstream)           | SIM       |
| C'. Cadeia seguida do kit          | banco da cadeia + `baseline.sql` 1.0: catálogo idêntico ao da instalação nova                                                                                                                                                                                                                                | SIM       |
| D. MANIFEST consistente            | 8 linhas 0501-0508 com arquivo; cercas `manifest-x-migrations` e `manifest-cita-caminho-que-existe` verdes na corrida cheia da linha 7 da seção 4 (feita com a nota de consolidação já no `MANIFEST.md`; nenhuma das duas está entre os 21 vermelhos)                                                        | SIM       |
| E. `baseline.sql` consistente      | o diff sobre a v1.69.0 é um bloco único de 3497 linhas acrescentadas, zero removidas; catálogo cadeia ≡ apêndice (acima); cercas `apendice-do-baseline-nao-diverge-da-cadeia` e `baseline-nao-constroi-o-que-derruba` verdes na linha 7                                                                      | SIM       |
| F. 0501-0508 presentes e ordenadas | 414 migrations, nenhum timestamp nem número repetido; 0501-0508 são as últimas e a ordem por timestamp = ordem por número                                                                                                                                                                                    | SIM       |

Único resíduo de catálogo, e não é Green: a view upstream `public.calendar_google_reconcilable_appointments`
(`select` com `*`) ganha 12 colunas quando o baseline é aplicado uma segunda vez; banco feito só pela cadeia tem a
forma de uma aplicação única, igual à v1.69.0 instalada uma vez. Nenhuma migration Green a toca.

## 6. Adoção (Fases 12-17)

- **Commit de consolidação:** só documentação - `docs/green/GREEN-BASELINE-1.0.md`, `docs/green/PRODUCTION-READINESS.md`,
  este relatório, `docs/adr/GREEN-001-deskcomm-fundacao-congelada.md` e uma nota no `supabase/migrations/MANIFEST.md`.
  Nenhuma migration, código, teste ou baseline alterado.
- **CI:** o fork `alves87daniel/DeskcommCRM` não tem workflow registrado nem branch protection; o PR de adoção não
  recebe check nenhum. Pela política do repositório (sem checks obrigatórios) o merge é permitido; a regressão da
  seção 4 é o equivalente local dos checks do upstream (`verify`, `invariants`, `build-and-size`, mais as suítes
  Green que nenhum workflow roda). Ligar o CI é o P0-08.
- **Merge:** merge commit (sem squash) de `release/green-baseline-1.0` na `main`; a história técnica das spikes fica.
- **Tag:** `GREEN-BASELINE-1.0`, anotada, no merge commit.

## 7. Matriz final (Fase 10)

| Critério                              | Prova                                                                                                                         | Resultado |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
| Mutation Boundary selada              | `green-mutation-context` v1/v2/v3 23/14/44 (seção 4, linha 3); `postgrest-real`, `next-real-v3` (linha 9)                     | SIM       |
| Lead Lifecycle selado                 | `green-lead-lifecycle` / v12 / v13 23/28/31 (linha 3); `lifecycle-real` (linha 9)                                             | SIM       |
| Automation Origin selada              | `green-automation-origin` 59 (linha 3); `automation-origin-real` (linha 9)                                                    | SIM       |
| Structural Boundary selada            | `green-structural-boundary` 73 (linha 3); `structural-real` (linha 9)                                                         | SIM       |
| Canonical Event Cutover selado        | `green-canonical-event-cutover` 47 (linha 3); `canonical-cutover-real` (linha 9)                                              | SIM       |
| 0501-0508 consistentes                | seção 5, itens C, C', D, E e F                                                                                                | SIM       |
| fresh install verde                   | seção 5, item A; `test:db` inteira (linha 4)                                                                                  | SIM       |
| upgrade verde                         | seção 5, itens B, C e C'; `test:db:update` (linha 5)                                                                          | SIM       |
| typecheck verde                       | linha 1; TypeScript do `next build` (linha 8)                                                                                 | SIM       |
| build produção verde                  | linha 8                                                                                                                       | SIM       |
| test:db sem regressão nova            | linhas 3, 4 e 5                                                                                                               | SIM       |
| E2Es Green verdes                     | linha 9                                                                                                                       | SIM       |
| lead comum sem regressão nova         | controles de lead comum nas suítes seladas e nos E2Es (linhas 3 e 9); `test:db` inteira; `test:unit` sem falha nova (linha 7) | SIM       |
| backlog de produção consolidado       | [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md): 9 P0, 5 P1, 12 P2 e INFO                                                | SIM       |
| política de upstream documentada      | [ADR-GREEN-001](../adr/GREEN-001-deskcomm-fundacao-congelada.md)                                                              | SIM       |
| nenhum BLOCKER arquitetural conhecido | BLOCKER arquitetural = 0 (régua de [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md))                                      | SIM       |

**BLOCKER arquitetural = 0.** P0 pré-deploy ≠ BLOCKER da GREEN-BASELINE: os P0/P1/P2 medem a prontidão operacional e
técnica para produção (o P0 impede o primeiro deploy, não a construção) e não reabrem a validação arquitetural selada
acima.
