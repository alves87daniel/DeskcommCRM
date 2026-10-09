# Registro de IDs e Mapa de Equivalência Histórica do ConectorGreen

Duas tabelas de manutenção contínua, subordinadas a
[`CONECTORGREEN-VOCABULARY-AND-NAMING.md`](CONECTORGREEN-VOCABULARY-AND-NAMING.md) (regras de ID na seção 6, governança na
seção 9). Nada aqui renomeia documento, branch, tag, commit ou migration: o mapa é a ponte entre o nome que o histórico
usa e o nome que o projeto passa a usar.

| Item   | Valor                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| Estado | ADOTADO. Equivalências 1:1 `APROVADAS` por `GOV-01` (2026-10-07); as demais não foram promovidas |
| Data   | 2026-10-07                                                                                       |
| Regra  | IDs só são acrescentados. Uma linha nunca é apagada; muda de estado (seção 6.3 da fonte)         |

## 1. Registro de IDs canônicos

Fonte do "próximo número" de cada área: o maior listado + 1. Áreas sem linha ainda não emitiram ID (próximo: `01`).

| ID          | Nome humano                                   | Tipo  | Estado    | Observação                                                                                                     |
| ----------- | --------------------------------------------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `CG-FND-01` | Fundação — Fronteira de mutação               | SPIKE | CONCLUÍDO | Contrato selado MUTATION BOUNDARY. Migrations 0501 e 0502                                                      |
| `CG-FND-02` | Fundação — Ciclo de vida da oportunidade      | SPIKE | CONCLUÍDO | Contrato selado LEAD LIFECYCLE. Migrations 0503, 0504 e 0505                                                   |
| `CG-FND-03` | Fundação — Origem de automação                | SPIKE | CONCLUÍDO | Contrato selado GREEN AUTOMATION ORIGIN. Migration 0506                                                        |
| `CG-FND-04` | Fundação — Fronteira estrutural               | SPIKE | CONCLUÍDO | Contrato selado STRUCTURAL BOUNDARY. Migration 0507                                                            |
| `CG-FND-05` | Fundação — Corte de eventos canônicos         | SPIKE | CONCLUÍDO | Contrato selado CANONICAL EVENT CUTOVER. Migration 0508                                                        |
| `CG-FND-06` | Fundação — Baseline 1.0 do ConectorGreen      | DOC   | CONCLUÍDO | Agrupamento histórico da adoção e selagem (`CG-FND-01` a `CG-FND-05`). Ver nota abaixo                         |
| `CG-FND-07` | Fundação — Modelo de produto do ConectorGreen | DOC   | CONCLUÍDO | Agrupamento histórico: GREEN-CRM-01 e sua revisão 01.1. Ver nota abaixo                                        |
| `CG-FND-08` | Fundação — Vocabulário e nomenclatura         | DOC   | CONCLUÍDO | Este conjunto. Ratificado (`GOV-01` a `GOV-05`). Integrado à `main` pelo PR #2 (merge `6cbe207f7`, 2026-10-08) |
| `CG-PRD-01` | Produtos — Catálogo e produto da oportunidade | FEAT  | CONCLUÍDO | GREEN-CRM-02. Migration 0509. Integrado e validado na `main` pelo PR #3 (merge `98049367f`, 2026-10-08)        |

Próximos livres na data deste registro: `CG-FND-09`, `CG-PRD-02`; demais áreas, `01`. Próximo número livre de
migration: `0510` (a 0509 é de `CG-PRD-01`; ver nota abaixo).

**Integração à `main`.** Este registro foi preparado para integração à `main` (branch `docs/cg-fnd-08-vocabulary-naming`,
sobre `b5962666`). `CG-FND-07` (GREEN-CRM-01 e 01.1, commit `a2d202168` da branch `green/crm-01-product-foundation`)
entra **junto com ele**, incorporado por cherry-pick a essa branch em 2026-10-08. `CG-PRD-01` (GREEN-CRM-02, branch
`green/crm-02-product-catalog-context`) **não entrou nessa integração**. `CONCLUÍDO` registra o checkpoint do item (seção
6.3 da fonte), não a presença na `main`. A 0509 pertence a `CG-PRD-01` e seguia reservada: o MANIFEST da `main` terminava
na 0508, a 0509 era a próxima a entrar na sequência, e `0510` é o próximo número livre para item novo, aplicado depois dela.

**Fechamento de `CG-FND-08` (2026-10-08).** O PR #2 (branch `docs/cg-fnd-08-vocabulary-naming`, head `b1abca2e3`) foi
integrado à `main` pelo merge commit `6cbe207f7`, de pais `b5962666` e `b1abca2e3`, com os cinco documentos desta
governança, `CG-FND-07` incluído. O parágrafo acima descreve o estado anterior ao merge e fica preservado como histórico.
Esse merge não mudou nada para `CG-PRD-01`, que seguiu fora da `main`, com a 0509 reservada a ele, até o PR #3 (abaixo).

**Fechamento de `CG-PRD-01` (2026-10-08).** O PR #3 (branch `ops/cg-prd-01-product-catalog-integration`, head
`d26ff2e50`) integrou `CG-PRD-01` à `main` pelo merge commit `98049367f`, de pais `6cbe207f7` e `d26ff2e50`. A origem
fica preservada: os commits `04ea1eb88` a `b36c81610` da branch `green/crm-02-product-catalog-context` entraram por
cherry-pick `-x` (`928ee2499`, `9cc925317`, `b898e68e7` e `6dd8920c8`), mais o ajuste `d26ff2e50`, que move o bloco da
0509 no `baseline.sql` para antes da varredura de anon. A 0509 entrou no MANIFEST da `main` depois da 0508, e `0510`
segue como o próximo número livre. Validação após o merge: CI, E2E, performance e imagem Docker aprovados; o workflow de
release falhou por motivo preexistente e não bloqueante, e nenhuma release foi emitida.

**Nota sobre `CG-FND-01` a `CG-FND-07`.** Estes IDs foram reservados **retroativamente** em 2026-10-07, para dar nome canônico ao
que já existia. `CG-FND-06` e `CG-FND-07` são **agrupamentos e equivalências históricas** (a baseline e os dois documentos de
modelagem). Não são tarefas executadas sob este padrão, não implicam trabalho funcional novo e não alteram código,
migrations nem contratos. A relação com os identificadores históricos é `PARCIAL` (seções 3.4 e 3.5).

Os tipos acima são a **melhor leitura** do que cada item entregou (os spikes históricos tinham por produto o
conhecimento que virou contrato; a baseline e os dois documentos de modelagem entregaram documentação). Revisar no
momento da aprovação; a ratificação `GOV-03` vale para a taxonomia de tipos, não revalida item a item.

## 2. Estados da equivalência

| Estado        | Significado                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `APROVADA`    | Registrada com `GOV-NN` pelo dono do produto. Pode ser usada como fato                                                            |
| `PROPOSTA`    | Relação 1:1 clara, sugerida aqui, aguardando aprovação                                                                            |
| `PARCIAL`     | Divisão ou agregação: vários identificadores históricos para um canônico, ou o inverso. Não é 1:1; ler a observação               |
| `SEM DECISÃO` | O documento histórico não permite estabelecer a relação, ou depende de decisão que não existe. **Não** inferir                    |
| `PRESERVADO`  | O identificador histórico **continua sendo o identificador oficial** (série própria, achado local, marco do Git). Sem ID canônico |

Natureza do identificador histórico, anotada na observação: **legado** (nome de item de trabalho anterior ao padrão),
**série própria** (continua válida), **local** (vale só dentro do documento que o define).

## 3. Mapa histórico para canônico

### 3.1 Frente Mutation Boundary (mutation context)

| Identificador histórico         | Nome histórico                                                                | ID canônico | Nome humano canônico                           | Estado        | Observação                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------- | ----------- | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPIKE-DESKCOMM-07` (inferido)  | SPIKE Green - Mutation Context v1 (`docs/spike/GREEN-MUTATION-CONTEXT-V1.md`) | `CG-FND-01` | Fundação — Fronteira de mutação                | `PARCIAL`     | Legado. O relatório v1 não traz ID; o v2 cita a "Auditoria independente do SPIKE-DESKCOMM-07" como escopo, o que o liga ao v1. Migration 0501. Branch `spike/green-mutation-context-v1`     |
| (sem ID próprio nos documentos) | SPIKE Green - Mutation Context v2 (`GREEN-MUTATION-CONTEXT-V2.md`)            | `CG-FND-01` | Fundação — Fronteira de mutação                | `SEM DECISÃO` | Legado. Nenhum documento versionado diz qual ID o v2 teve (`SPIKE-DESKCOMM-08` não aparece em lugar nenhum). Não inventar. Editou a 0501 no lugar. Branch `spike/green-mutation-context-v2` |
| `SPIKE-DESKCOMM-09`             | Mutation Boundary v3: Bidirectional Guard + Trust Hardening                   | `CG-FND-01` | Fundação — Fronteira de mutação                | `PARCIAL`     | Legado. Fecha a `AUDIT-DESKCOMM-08.2`. Migration 0502. Branch `spike/green-mutation-context-v3`. Veredito do relatório: V3-PASS-COM-GAPS                                                    |
| `AUDIT-DESKCOMM-08.2`           | Auditoria independente do v2 (veredito FAIL)                                  | (nenhum)    | (evidência de Fundação — Fronteira de mutação) | `PRESERVADO`  | Legado. Relatório da auditoria não está versionado neste repositório; só é citado no v3. Fica como identificador de evidência de `CG-FND-01`                                                |
| `MUTATION BOUNDARY`             | Contrato selado (baseline seção 4)                                            | `CG-FND-01` | Fundação — Fronteira de mutação                | `APROVADA`    | O **nome do contrato é imutável** (só muda por ADR). O ID canônico identifica o item que o selou, não renomeia o contrato                                                                   |

### 3.2 Frente Lead Lifecycle

| Identificador histórico | Nome histórico                                    | ID canônico | Nome humano canônico                                    | Estado       | Observação                                                                                                                               |
| ----------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SPIKE-GREEN-01`        | Lead Lifecycle: INSERT + DELETE + Tombstone       | `CG-FND-02` | Fundação — Ciclo de vida da oportunidade                | `PARCIAL`    | Legado. Migration 0503. Branch `spike/green-lead-lifecycle-v1`. O "lead" do nome é a oportunidade (seção 3.4 da fonte)                   |
| `SPIKE-GREEN-01.2`      | Lead Lifecycle: correções da auditoria            | `CG-FND-02` | Fundação — Ciclo de vida da oportunidade                | `PARCIAL`    | Legado. Rodada corretiva (referência: `AUDIT-GREEN-01.1`). Migration 0504. O sufixo `.2` histórico **não** é revisão `.N` do padrão novo |
| `SPIKE-GREEN-01.3`      | Lead Lifecycle: identidade por binding e selagem  | `CG-FND-02` | Fundação — Ciclo de vida da oportunidade                | `PARCIAL`    | Legado. Selagem (referência: `AUDIT-GREEN-01.2.1`). Migration 0505                                                                       |
| `AUDIT-GREEN-01.1`      | Auditoria do lifecycle (PASS COM RESSALVAS)       | (nenhum)    | (evidência de Fundação — Ciclo de vida da oportunidade) | `PRESERVADO` | Legado. Relatório da auditoria não versionado; citado no v1.2                                                                            |
| `AUDIT-GREEN-01.2.1`    | Auditoria do lifecycle v1.2 (PASS NÃO SUSTENTADO) | (nenhum)    | (evidência de Fundação — Ciclo de vida da oportunidade) | `PRESERVADO` | Legado. Idem; citado no v1.3                                                                                                             |
| `LEAD LIFECYCLE`        | Contrato selado                                   | `CG-FND-02` | Fundação — Ciclo de vida da oportunidade                | `APROVADA`   | Nome do contrato imutável                                                                                                                |

### 3.3 Frentes Automation Origin, Structural Boundary e Canonical Event Cutover

| Identificador histórico   | Nome histórico                                                                | ID canônico | Nome humano canônico                  | Estado     | Observação                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------- | ----------- | ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SPIKE-GREEN-AUTO-01`     | Automation Origin & Green Opportunity Triggers                                | `CG-FND-03` | Fundação — Origem de automação        | `APROVADA` | Legado. Migration 0506. Branch `spike/green-automation-origin-v1`. O ID histórico quebra a série `SPIKE-GREEN-NN`; foi emitido entre o `01.3` e o `02` |
| `GREEN AUTOMATION ORIGIN` | Contrato selado                                                               | `CG-FND-03` | Fundação — Origem de automação        | `APROVADA` | Nome do contrato imutável                                                                                                                              |
| `SPIKE-GREEN-02`          | Structural Boundary: Pipelines, Stages & Organization                         | `CG-FND-04` | Fundação — Fronteira estrutural       | `APROVADA` | Legado. Migration 0507. Branch `spike/green-structural-boundary-v1`                                                                                    |
| `STRUCTURAL BOUNDARY`     | Contrato selado                                                               | `CG-FND-04` | Fundação — Fronteira estrutural       | `APROVADA` | Nome do contrato imutável                                                                                                                              |
| `SPIKE-GREEN-03`          | Canonical Event Cutover: Green Events, Legacy Suppression & Binding Semantics | `CG-FND-05` | Fundação — Corte de eventos canônicos | `APROVADA` | Legado. Migration 0508. Branch `spike/green-canonical-event-cutover-v1`                                                                                |
| `CANONICAL EVENT CUTOVER` | Contrato selado                                                               | `CG-FND-05` | Fundação — Corte de eventos canônicos | `APROVADA` | Nome do contrato imutável                                                                                                                              |

### 3.4 Baseline, validação e decisões de fundação

| Identificador histórico                                  | Nome histórico                                                                   | ID canônico | Nome humano canônico                     | Estado       | Observação                                                                                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GREEN-BASELINE-1.0`                                     | Fundação do ConectorGreen (documento, tag e branch `release/green-baseline-1.0`) | `CG-FND-06` | Fundação — Baseline 1.0 do ConectorGreen | `PARCIAL`    | A **tag `GREEN-BASELINE-1.0` e o nome do documento permanecem**; viram marco do item. Agrega as cinco frentes (`CG-FND-01` a `CG-FND-05`) mais a regressão e a adoção (PR #1, `b5962666`). Não é 1:1 com nenhum spike |
| `VALIDATION-CLOSURE`                                     | Encerramento da validação do Deskcomm (`docs/green/VALIDATION-CLOSURE.md`)       | `CG-FND-06` | Fundação — Baseline 1.0 do ConectorGreen | `PARCIAL`    | Documento de apoio do item; mantém o nome                                                                                                                                                                             |
| `PRODUCTION-READINESS`                                   | Backlog de produção sobre a GREEN-BASELINE-1.0                                   | `CG-FND-06` | Fundação — Baseline 1.0 do ConectorGreen | `PARCIAL`    | Documento de apoio. Suas classes `P0`, `P1`, `P2` são **severidade** (série própria) e não se confundem com fase ou entrega                                                                                           |
| `ADR-GREEN-001`                                          | Deskcomm como fundação congelada                                                 | (nenhum)    | (não aplicável)                          | `PRESERVADO` | Série própria `ADR-GREEN-NNN` continua. Decisão de 2026-10-04; cita a baseline                                                                                                                                        |
| `0501` a `0508` (infixo `spike_`)                        | Migrations da cadeia Green                                                       | (nenhum)    | (não aplicável)                          | `PRESERVADO` | Série própria (MANIFEST). Nomes `spike_*` mantidos por decisão da baseline seção 8. Referenciam `CG-FND-01` a `CG-FND-05`                                                                                             |
| `LIFE-ADV-NN`, `V12-ADV-NN`, `S23`, `ADV-07`, `MC1`...   | Achados e casos dentro dos relatórios                                            | (nenhum)    | (não aplicável)                          | `PRESERVADO` | Locais ao relatório; não viram ID de item                                                                                                                                                                             |
| Branches `spike/green-*` e `release/green-baseline-1.0`  | Branches das frentes e da baseline                                               | (nenhum)    | (não aplicável)                          | `PRESERVADO` | Não renomear (baseline seção 8)                                                                                                                                                                                       |
| Commits `spike(green-*)`, `test(green-*)`, `docs(spike)` | Mensagens históricas                                                             | (nenhum)    | (não aplicável)                          | `PRESERVADO` | Não reescrever                                                                                                                                                                                                        |

### 3.5 Produto

| Identificador histórico                | Nome histórico                                                                                                                           | ID canônico | Nome humano canônico                          | Estado       | Observação                                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GREEN-CRM-01`                         | Fundação de Produto do ConectorGreen (`docs/green/product/GREEN-CRM-01-PRODUCT-FOUNDATION.md`; branch `green/crm-01-product-foundation`) | `CG-FND-07` | Fundação — Modelo de produto do ConectorGreen | `PARCIAL`    | Legado. Documento único; é modelagem, não entrega de código. O prefixo `CRM` do nome histórico não é área do padrão novo                                                                                        |
| `GREEN-CRM-01.1`                       | Revisão: Produto, Funil e Expansão (seção 16 do mesmo documento; commit `a2d202168`)                                                     | `CG-FND-07` | Fundação — Modelo de produto do ConectorGreen | `PARCIAL`    | Não é item separado: é revisão do mesmo documento que **alterou o escopo da tarefa seguinte**. Fonte do vocabulário canônico. Entra como `CG-FND-07` sem sufixo `.N` (o sufixo só vale após a adoção do padrão) |
| `GREEN-CRM-02`                         | Catálogo de Produtos Green e Produto da Oportunidade (branch `green/crm-02-product-catalog-context`)                                     | `CG-PRD-01` | Produtos — Catálogo e produto da oportunidade | `APROVADA`   | Legado. Exemplo do briefing da CG-FND-08. Migration 0509; commits `04ea1eb88` a `b36c81610`. A branch **não** muda de nome. Aprovada a equivalência. Integrado à `main` pelo PR #3 (merge `98049367f`)          |
| `D-01` a `D-20`, `R-NN` (GREEN-CRM-01) | Decisões e riscos do documento                                                                                                           | (nenhum)    | (não aplicável)                               | `PRESERVADO` | Locais ao documento. Citar como `CG-FND-07/D-15`                                                                                                                                                                |
| `0509`                                 | `0509_green_product_catalog_and_lead_context`                                                                                            | (nenhum)    | (não aplicável)                               | `PRESERVADO` | Série própria. Pertence a `CG-PRD-01`                                                                                                                                                                           |

### 3.6 Nomenclatura anterior fora deste repositório

| Identificador histórico                                                                               | Nome histórico                                                          | ID canônico | Nome humano canônico | Estado       | Observação                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------- | -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F0`..`F3`, `P0.x`, `T0.x.xx`, `BUG-`, `SPIKE-` (v0)                                                  | Esquema de trabalho do repositório `conector-green` (antes `growth-os`) | (nenhum)    | (nenhum)             | `PRESERVADO` | Legado em relação ao padrão `CG-`, sem equivalência e não promovido a nomenclatura oficial. **Exceção:** segue em uso ativo no repositório `conector-green` (pendência 2 da fonte). Não presumir equivalência com fases ou áreas `CG-` |
| `ADR-004`, `ADR-005`, `ADR-012`, `ADR-016`, `ADR-017`, `PD-011` a `PD-013`, `RAD-008`, `RAD-027` (v0) | Decisões e radares do v0 citados na GREEN-CRM-01                        | (nenhum)    | (nenhum)             | `PRESERVADO` | Legado, série do v0, sem equivalência. **Não** confundir com `ADR-GREEN-NNN`. Continuam citáveis como "v0 ADR-016" etc.                                                                                                                |

## 4. Como manter

1. **Item novo:** acrescentar a linha na seção 1 (estado `RESERVADO`) no primeiro commit da branch.
2. **Item concluído:** mudar o estado; se houver identificadores anteriores a ele, acrescentar linhas na seção 3.
3. **Aprovação:** o dono do produto registra `GOV-NN` na fonte e o estado muda de `PROPOSTA` para `APROVADA` linha a linha;
   uma aprovação em bloco cita as linhas.
4. **Nunca:** apagar linha, reutilizar ID, mudar a coluna "Identificador histórico".

## 5. Registro de aprovação

Aprovação em bloco por `GOV-01`, pelo dono do produto, em 2026-10-07. Critério: relação **1:1** com evidência documental.

| Categoria                                               | Linhas                                                                                                                                                                                                      | Resultado                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Correspondência direta                                  | `MUTATION BOUNDARY`, `LEAD LIFECYCLE`, `SPIKE-GREEN-AUTO-01`, `GREEN AUTOMATION ORIGIN`, `SPIKE-GREEN-02`, `STRUCTURAL BOUNDARY`, `SPIKE-GREEN-03`, `CANONICAL EVENT CUTOVER`, `GREEN-CRM-02` (`CG-PRD-01`) | `PROPOSTA` -> `APROVADA` |
| Correspondência parcial ou agregada                     | `SPIKE-DESKCOMM-07`, `SPIKE-DESKCOMM-09`, `SPIKE-GREEN-01`, `01.2`, `01.3`, `GREEN-BASELINE-1.0`, `VALIDATION-CLOSURE`, `PRODUCTION-READINESS`, `GREEN-CRM-01`, `GREEN-CRM-01.1`                            | `PARCIAL`, mantida       |
| Legado preservado sem equivalência                      | `AUDIT-DESKCOMM-08.2`, `AUDIT-GREEN-01.1`, `AUDIT-GREEN-01.2.1`, esquema e séries do v0, séries próprias, achados locais, branches, commits e migrations                                                    | `PRESERVADO`             |
| Informação histórica sem decisão por falta de evidência | Mutation Context v2 (sem ID próprio nos documentos)                                                                                                                                                         | `SEM DECISÃO`, mantida   |

`GREEN-CRM-02` -> `CG-PRD-01` está ratificada como equivalência. A aprovação de merge ou release do trabalho dessa branch é
decisão **separada** e não consta aqui: o estado `CONCLUÍDO` de `CG-PRD-01` indica só o checkpoint de implementação.
