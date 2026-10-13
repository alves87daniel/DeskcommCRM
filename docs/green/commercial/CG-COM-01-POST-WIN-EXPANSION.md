# Comercial — Expansão pós-ganho

| Item                   | Valor                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID                     | `CG-COM-01`                                                                                                                                                                                    |
| Tipo                   | `FEAT`                                                                                                                                                                                         |
| Área                   | `CG-COM` (Comercial). ID oficial `CG-COM-01` confirmado pelo dono do produto em 2026-10-12 (pendência 1 da seção 11 resolvida)                                                                 |
| Estado                 | EM ANDAMENTO: PR #7 (Draft) com CI verde no código `f065581fd` (seção 13) e destino aprovado pelo dono do produto (seção 14). Sem merge na `main`                                              |
| Equivalência histórica | `PARCIAL` com a "GREEN-CRM-04" candidata da GREEN-CRM-01 (seções 16.7 e 16.8): este item entrega só a expansão manual a partir do dossiê. Importação por período e regra automática ficam fora |
| Branch                 | `feat/cg-com-01-post-win-expansion`, criada de `origin/main` = `c5b3b5eef`; `main` `f25c8276c` integrada por merge (`93af21a22`)                                                               |
| Migration              | `20261008120000_0510_green_commercial_origin_expansion.sql`                                                                                                                                    |

Este documento registra o que foi implementado e o que ficou de fora. O modelo de produto (contato, oportunidade,
funil, produto) e as alternativas descartadas vivem na [GREEN-CRM-01](../product/GREEN-CRM-01-PRODUCT-FOUNDATION.md)
(D-15, seções 16.7 e 16.8) e no catálogo da [GREEN-CRM-02](../product/GREEN-CRM-02-PRODUCT-CATALOG-CONTEXT.md), e não
são repetidos aqui.

## 1. Problema

Um cliente que já comprou (oportunidade ganha) pode comprar de novo: outro produto, outra unidade, um upgrade. Até
aqui o CRM não tinha como abrir essa nova venda sem mexer na venda ganha: mover a oportunidade ganha para outro funil
reescreve o desfecho dela, e criar uma oportunidade solta perde a ligação com a venda que originou a nova. O modelo
canônico (D-15) já dizia o que fazer: ganhar não move; a expansão é uma oportunidade nova, do mesmo contato, ligada à de
origem por vínculo de origem comercial.

```text
OPORTUNIDADE A (origem)               OPORTUNIDADE B (expansão)
contato Maria                          mesmo contato Maria (não duplicado)
funil ConexãoGreen, produto Alfa       funil Green escolhido, produto escolhido (pode ser Alfa)
status = won (INTACTA)                 status = open, source = expansao
                     crm_lead_links: B -> A, link_kind = commercial_origin
```

## 2. Modelo (migration 0510)

Nenhuma tabela nova e nenhuma coluna nova. As migrations 0501 a 0509 não foram tocadas. Espelho no `baseline.sql`
(antes da varredura de anon) e linha no `MANIFEST.md`.

| Objeto                                                                                                   | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trigger `trg_commercial_origin_link_guard` em `crm_lead_links` (`green.fn_commercial_origin_link_guard`) | Só para `link_kind = commercial_origin`: alvo `lead`; lead e alvo da organização do vínculo (inexistente e de outra organização dão a mesma recusa); alvo `won`; origem diferente do destino; sessão humana com papel `agent`+; vínculo imutável (sem UPDATE, e sem DELETE fora da cascata da expansão ou da organização). Vale para todo papel, inclusive `service_role` e o dono do banco. Os outros vínculos (agenda: `scheduled`) não mudam |
| `public.fn_green_pipeline_ids(org)` (definer)                                                            | Funis Green (com binding) da organização, só para membro dela. É a lista de destinos possíveis. Não expõe a chave de processo do binding                                                                                                                                                                                                                                                                                                        |
| `public.fn_crm_open_expansion_of(origem, produto)` (definer)                                             | A expansão ABERTA da origem com o produto, se houver: `(lead_id, visible)`. Enxerga a organização inteira (a duplicidade não pode depender da RLS do chamador), mas só devolve o id quando o chamador enxerga a expansão, e não responde nada por origem que ele não enxerga                                                                                                                                                                    |
| `public.fn_crm_create_expansion_opportunity(...)` (invoker)                                              | A escrita, numa transação. Roda com a RLS e o papel do chamador, exatamente como o INSERT do PostgREST que o `createLeadHandler` faz (travas de suporte e fronteira Green incluídas). O responsável da nova é quem cria (`auth.uid()`), nunca um parâmetro                                                                                                                                                                                      |

Passos da escrita, nesta ordem: valida forma (produto obrigatório, título de 2 a 200, moeda ISO, valor não negativo);
toma `pg_advisory_xact_lock` por origem; lê a origem pela RLS, da organização pedida, `won` e com contato; confere que
o destino é funil Green e que a etapa é aberta (sem etapa, a primeira aberta); procura a expansão aberta da mesma origem
e produto (se existir, devolve ela com `created = false`; se o chamador não a enxerga, recusa `expansion_already_open`);
cria a oportunidade (`source = expansao`, contato da origem, aberta, com quem cria como responsável quando é atendente
ativo da organização), o contexto Green com o produto (regras da 0509: produto ativo e da organização) e o vínculo.
Qualquer recusa desfaz tudo: não sobra oportunidade sem vínculo nem vínculo sem produto.

`retomado_de_lead_id` (nova tentativa depois de perda) e `source_metadata.clonado_de` (troca de funil) não são usados:
a expansão grava `retomado_de_lead_id = null`, `external_id = null` e `source_metadata = {}` (provado em EX1).

## 3. Regras de negócio aplicadas

| #    | Regra                                                                                                                                                                                                              | Fonte                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| D-01 | A oportunidade de origem fica intacta: nenhum UPDATE, nenhuma atividade, nenhum evento. Continua `won`, no mesmo funil, com `closed_at` e histórico                                                                | D-15 (GREEN-CRM-01)                                                               |
| D-02 | Origem elegível: `won` e com contato, visível ao operador. O funil da origem não é restrito                                                                                                                        | D-15; "contato já convertido" (glossário)                                         |
| D-03 | A expansão reaproveita o contato da origem. Nunca cria contato e o corpo do pedido não aceita contato                                                                                                              | escopo item 4                                                                     |
| D-04 | Destino: qualquer funil Green elegível (com binding) e etapa aberta (não ganho, não perda, não arquivada), inclusive o mesmo funil da origem. Sem etapa, a primeira aberta. Sem funil próprio de expansão          | decisão do dono do produto (2026-10-13, seção 14); regras Green da 0509           |
| D-05 | Produto obrigatório, ativo e da organização. A tela sugere o produto da origem (se ativo); pode ser outro                                                                                                          | D-17 (produto principal obrigatório na oportunidade Green); 16.7 ("pode diferir") |
| D-06 | Idempotência: uma expansão ABERTA por (origem, produto). Repetir devolve a existente. Encerrada a expansão, outra com o mesmo produto é legítima. Produto diferente abre outra                                     | 16.8 (requisito de idempotência); resolve a DP-12                                 |
| D-07 | A expansão nasce com quem a cria como responsável (`owner_kind = user`, `assigned_at`), decidido no banco e nunca pelo corpo; título e valor vêm do formulário; etiquetas e campos personalizados não são copiados | decisão do dono do produto (2026-10-12); posse da 0070 e régua da 0403            |
| D-08 | `metadata` do vínculo: `reason = expansion`, `created_via = manual`, `product_id`                                                                                                                                  | 16.8 (vocabulário de `reason` e `created_via`)                                    |
| D-09 | A régua de campos obrigatórios por etapa (issue #1536) vale para a expansão, como vale para a retomada                                                                                                             | comportamento existente                                                           |
| D-10 | O vínculo `commercial_origin` não é apagado por nenhum papel: só sai junto com a expansão ou com a organização (cascata). Os outros vínculos não mudam                                                             | decisão do dono do produto (2026-10-12)                                           |

**DP-12 (chave de idempotência da expansão) resolvida aqui:** verificação pelo vínculo + produto + status aberto, sob
lock transacional por origem, na mesma transação da criação. A candidata `external_id = <A.id>:<product.code>` com
`source = expansao` foi recusada: o índice único a tornaria permanente (bloquearia uma nova expansão depois de a
primeira ser perdida ou ganha) e usaria `external_id`, que é identidade de sistema externo, como chave de domínio. A
decisão mora só aqui; a linha da DP-12 na GREEN-CRM-01 (seção 12) continua como registro histórico, com uma nota que
aponta para esta seção (pendência 3).

## 4. Idempotência e concorrência

Três camadas, cada uma com a sua prova:

1. **Banco (a garantia):** lock por origem + checagem dentro da transação. Cinco chamadas simultâneas criam uma
   expansão (ID2); repetir devolve a mesma, sem escrita nem evento (ID1). Com responsável, chamadas simultâneas de
   dois agentes criam uma só, do vencedor; o outro agente, que não a enxerga, recebe `expansion_already_open` (OW4).
   O vínculo não pode ser apagado para burlar a checagem (DL3).
2. **Servidor:** atalho idempotente antes de validar etapa e campos (`fn_crm_open_expansion_of`) e, se uma corrida
   for perdida entre o atalho e o lock, a RPC devolve a existente (`created = false`), sem `lead.created` nem
   auditoria.
3. **Requisição:** `Idempotency-Key` (o `apiClient` sempre manda; a tela gera uma por abertura do diálogo). Mesma
   chave e mesmo corpo repetem a resposta gravada sem reexecutar; mesma chave com outro corpo é 409.

A resposta do POST traz só ids e estado da oportunidade (`LeadDaExpansao`), porque ela é gravada como recibo em
`idempotency_keys`, fora da cascata de LGPD, e o título do negócio costuma ser o nome do cliente.

## 5. Isolamento e permissões

| Ação                                | Quem                                                                | Como é garantido                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ver a relação (`GET`)               | `viewer`+ da organização, só o que a RLS mostra                     | sessão do operador; oportunidade relacionada invisível aparece como `visible = false`, sem título                 |
| criar expansão (`POST`)             | `agent`+ (`requireRole`), fora de sessão de suporte somente leitura | rota + RPC invoker: a RLS de `crm_leads`/`green_lead_context`/`crm_lead_links` decide; viewer leva `42501` -> 403 |
| ser responsável da expansão         | quem cria, se atendente ativo (não viewer) da organização           | RPC (`auth.uid()` + régua da 0403); suporte da plataforma cria sem virar responsável; `service_role` não cria     |
| origem de outra organização         | ninguém                                                             | organização da sessão no filtro da rota e no parâmetro da RPC; mesma recusa de inexistente (404)                  |
| vínculo `commercial_origin` à mão   | `agent`+, alvo `won`, mesma organização                             | guarda da 0510 para todo papel, inclusive `service_role`                                                          |
| alterar vínculo `commercial_origin` | ninguém                                                             | guarda da 0510 (imutável)                                                                                         |
| apagar vínculo `commercial_origin`  | ninguém (só a cascata da expansão ou da organização)                | guarda da 0510 para todo papel, inclusive `service_role` e o dono do banco; outra organização nem alcança (RLS)   |

A organização vem sempre da sessão; o schema é `.strict()` e recusa `organization_id`, `contact_id`, `status`,
`owner_user_id` e `owner_agent_id` no corpo.

Visibilidade `own` (`organizations.settings.visibility_mode`): o agente só enxerga a origem de que é responsável e, com
a expansão nascendo dele, cria e enxerga a nova (OW3). Antes da correção ele via o botão e levava 403.

## 6. Eventos, auditoria e linha do tempo

- `lead.created` da expansão: emitido pelo servidor com o MESMO código de todo lead (`registrarNascimentoDoLead`,
  extraído do `createLeadHandler` sem mudar comportamento). Automações de "lead criado" valem para a expansão.
- `lead.green_context_changed` (`product_assigned`) da expansão: emitido pelo banco (trigger da 0509).
- Nenhum tipo de evento novo. Nenhum evento sobre a origem (EV1).
- Auditoria: `lead.created` e a ação nova `lead.expansion_created` (origem, vínculo, produto, funil, etapa).
- Linha do tempo: só a expansão recebe a atividade nova `opened_as_expansion` ("Nasceu como expansão de um negócio
  ganho"). A origem não recebe atividade: o trigger da timeline atualizaria `last_activity_at` dela.

## 7. API

| Rota                                | Papel   | Resposta                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/leads/[id]/expansion`  | viewer+ | `origin`, `expansions` (produto, funil, etapa, situação), `eligibility` (`not_won`, `without_contact`), `green_available` (a organização tem funil Green), `can_create`, `destinations` (funis Green com etapas abertas, só para agent+), `suggested_product_id`. Nunca escreve                                                                                                                                                                                        |
| `POST /api/v1/leads/[id]/expansion` | agent+  | corpo `{ pipeline_id, stage_id?, product_id, title, value_cents? }`. 201 criada; 200 já existia (`created = false`); 404 origem; 422 `expansion_origin_not_won`, `expansion_origin_without_contact`, `expansion_destination_not_green`, `expansion_stage_unavailable`, `green_product_not_found`, `green_product_inactive`, `required_fields_missing`, `validation_failed`; 409 `expansion_already_open`, `idempotency_conflict`, `idempotency_in_progress`; 403 papel |

Código: rota em `app/api/v1/leads/[id]/expansion/route.ts`; escrita `expandirLeadHandler` em
`app/api/v1/leads/_handler.ts` (ao lado da retomada); contrato e leitura em `lib/green/expansao/`.

## 8. UI

Seção "Expansão comercial" no `LeadDossier`, logo depois de "Produto Green" (`components/green/ExpansaoDoNegocio.tsx`):

- mostra de qual negócio esta oportunidade nasceu e as oportunidades abertas a partir dela, com link
  (`/app/leads/[id]`), produto, funil, etapa e situação;
- em negócio ganho e com contato, para agent+, o botão "Nova oportunidade de expansão" abre o diálogo
  (`components/green/NovaExpansaoDialog.tsx`): funil Green, etapa, produto (só ativos; sugere o da origem), título
  (sugere o da origem) e valor opcional. Não há campo de contato;
- organização com funil Green, mas sem etapa aberta em nenhum: a seção explica em vez de oferecer o botão;
- sem relação e sem como criar (negócio aberto sem origem, viewer sem relação, instalação sem Green), a seção some.

Nenhuma tela nova, nenhuma porta de navegação nova: é uma ação contextual do dossiê.

## 9. Testes

| Camada | Arquivo                                                           | O que prova                                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco  | `tests/invariants/green-expansion-commercial-origin.test.ts` (41) | EX (nova, mesmo contato, produto, vínculo, responsável, campos recusados não usados), OR (origem byte a byte intacta), ID (repetição, 5 simultâneas, produto diferente, expansão encerrada, invisível), EL, TN (incl. `service_role`), PM, DL (exclusão do vínculo), OW (responsável), EV, SG |
| API    | `tests/unit/green-expansao-api.test.ts` (33)                      | papel, suporte, `.strict()` (inclusive responsável no corpo), organização da sessão, elegibilidade, idempotência (existente, invisível, corrida, `Idempotency-Key` pelo helper real, recibo sem título), cada recusa nomeada, rastro e auditoria, GET                                         |
| UI     | `tests/unit/green-expansao-ui.test.tsx` (12)                      | relação (origem, expansões, sem acesso, seção ausente), formulário (padrões, funil troca etapa enviada), envio só para `/expansion`, mesma chave no reenvio e outra ao reabrir, "já existia"                                                                                                  |

Mutações dirigidas (script fora do repositório, cada arquivo restaurado depois): 9 de 9 no servidor e 6 de 6 na UI
reprovaram as suítes. Duas mutações da UI sobreviveram na primeira rodada e mostraram testes fracos (checagem antes
de a leitura terminar; `<select>` controlado que mostra a primeira opção com valor velho); os dois testes foram
reforçados e passaram a reprovar.

Rodar a suíte de banco: `CONFERENCIA_KIT_RELEASE=v1.69.0 pnpm test:db tests/invariants/green-expansion-commercial-origin.test.ts`.

Execução: os 28 casos originais passaram em 2026-10-09 (`3f2fdd30d`). Os 41 (com DL1 a DL7, OW1 a OW6 e o EX1
atualizado) passaram no CI do PR #7, em PostgreSQL 15 e 17 (`invariants-majors`), sem Docker local (seção 13).

## 10. Limitações reais

- **Sem prova pela tela (DoD 12):** a UI foi provada por testes de componente, não por Playwright num ambiente fresco
  estilo VPS. Nenhuma spec de `tests/e2e` abre o dossiê de um negócio Green nem chama `/expansion`: o `e2e` verde do
  PR não prova a jornada. Sem prova pela tela: o botão aparecer só para agent+ em negócio ganho, o diálogo criar de
  ponta a ponta com o banco real, a navegação até a nova e a recarga mostrando a relação. Fica para a validação
  seguinte, como na CG-PRD-01.
- **Expansão invisível:** o agente em modo de visibilidade restrito que tenta abrir uma expansão já aberta por outro
  atendente recebe 409 sem ver qual é. A lista de expansões do dossiê também mostra só as que ele enxerga. Com a
  expansão nascendo do criador, isso passa a valer também no modo padrão (`own_and_unassigned`) entre dois agentes.
- **Destino só Green:** funil comum não recebe expansão nesta versão (o produto só existe em funil Green). Ampliar
  não exige migration de dados, mas exige decidir a chave de idempotência sem produto.
- **Sem funil próprio de expansão:** o destino é qualquer funil Green elegível, e nada lê a chave de processo do
  binding. O "funil Expansão" do glossário (seção 14) fica para uma entrega futura.
- **Origem apagada:** se a oportunidade de origem for apagada, o vínculo fica com alvo pendente (como todo vínculo
  polimórfico, `target_id` sem FK); a leitura mostra a origem como `visible = false`. Apagar a expansão leva o vínculo
  junto, e uma nova expansão volta a ser possível (DL4).
- **`service_role` não cria expansão:** sem sessão humana, `fn_green_pipeline_ids` não reconhece a organização e a
  RPC recusa (falha fechada, OW6). Expansão automática ou por importação (CG-EXP) vai precisar de um caminho próprio.
- **Corrida com reabertura da origem:** se a origem deixar de ser `won` entre a checagem e o vínculo, a guarda recusa
  com `commercial_origin_origin_not_won`, que a API ainda não traduz (vira 500, sem meia escrita).
- **Sem MCP, sem automação, sem importação por período:** fora do escopo (16.7 e 16.8 continuam como próximos itens).
- **`.changes/`:** nenhum fragmento de release, como nas entregas Green anteriores (o fork não corta release do
  upstream).
- `lib/database.types.ts` ganhou as três funções à mão (o cliente do servidor não é tipado por `Database`).

## 11. Pendências e decisões para o dono do produto

| #   | Pendência                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **RESOLVIDA (2026-10-12).** Área do ID: o dono do produto confirmou `CG-COM-01` como identificador oficial (a árvore da seção 4.3 da nomenclatura sugeria `CG-EXP`)                                                                                                                                                          |
| 2   | **RESOLVIDA (2026-10-13).** D-04/D-05: o dono do produto aprovou o contrato desta versão (seção 14). Destino em qualquer funil Green elegível, inclusive o da origem, e produto obrigatório. O funil próprio de expansão (chave de processo `expansao`) não integra esta entrega; ampliar para funil comum também segue fora |
| 3   | **RESOLVIDA (2026-10-13).** Registro da DP-12: a decisão fica na seção 3 deste documento; a GREEN-CRM-01 (seção 12) ganhou só uma nota que aponta para cá, no padrão da nota da GREEN-CRM-02 na seção 14.1 de lá                                                                                                             |
| 4   | **RESOLVIDA (2026-10-12).** Responsável da expansão: quem cria (D-07), respeitando as permissões existentes                                                                                                                                                                                                                  |

## 12. Correções de 2026-10-12

Decisões aprovadas pelo dono do produto: o ID oficial segue `CG-COM-01`; os vínculos `commercial_origin` não podem ser
apagados indevidamente; a expansão nasce atribuída a quem a cria.

1. **Integridade do vínculo** (commit `6870aa52f`): a policy de DELETE de `crm_lead_links` (0042) deixa qualquer membro,
   até viewer, apagar vínculo, e apagar o `commercial_origin` quebrava a relação e a idempotência. A guarda
   `green.fn_commercial_origin_link_guard` passou a valer também no DELETE, para todo papel: o vínculo só sai na cascata
   da expansão ou da organização (a guarda vê que a linha-pai já saiu, o mesmo recurso que a fronteira Green usa para a
   organização apagada). A 0042 ficou intacta, para não mudar a agenda nem ampliar permissão de outro vínculo.
2. **Responsável** (mesmo commit): a RPC grava `owner_user_id = auth.uid()`, `owner_kind = 'user'` e `assigned_at`
   quando quem cria é atendente ativo da organização (a régua do gatilho da 0403), sem parâmetro novo. Suporte da
   plataforma cria sem virar responsável, porque não é membro e a 0403 o recusaria como dono.
3. **Na 0510, e não numa 0511:** a 0510 nunca saiu desta branch (sem push, e o ambiente de demonstração roda a `main`
   sem ela), então nenhum banco a aplicou. Uma 0511 só para remendar uma migration que ninguém aplicou deixaria duas
   definições da mesma guarda na cadeia e consumiria o próximo número livre. O espelho do `baseline.sql` e a linha do
   `MANIFEST.md` foram atualizados junto, e as cercas de baseline e cadeia passaram.
4. **Integração da `main`** (merge `93af21a22`, sem rebase): trouxe a CG-SEC-01 (`f25c8276c`). O único conflito foi o
   previsto, na tabela do registro canônico, resolvido com as duas linhas; próximos livres `CG-COM-02` e `CG-SEC-02`,
   migration `0511`.

## 13. Validação no PR #7 e revisão final (2026-10-13)

1. **Banco:** no `ci` do PR #7, `invariants-majors (15)` e `(17)` rodaram os 41 casos da suíte da expansão em
   PostgreSQL 15 e 17, com o `baseline.sql` em instalação e atualização. A 0510 está validada.
2. **FIX de CI** (commit `f065581fd`, só `tests/shell/colisao-de-migration.test.sh`): a suíte de colisão herdava o
   `GITHUB_REF` do job, e o PR real #7 virava o PR fictício #7 do fixture (9 de 106 vermelhos). `unset GITHUB_REF` no
   isolamento da suíte e caso 34 de regressão (106 -> 111 casos). O detector `scripts/checar-colisao-de-migration.sh`
   não mudou. No run `38395788980` o `verify-parte (3)` passou com as 32 suítes de shell, e a colisão com 111 casos.
3. **Checks do HEAD `f065581fd`:** 26, com 23 success e 3 skipped por desenho (`build-and-push`, `juntar-manifestos`,
   `promover-stable`, que só publicam fora de PR).
4. **Revisão funcional:** ID, responsável, proteção do `commercial_origin`, vínculos `scheduled` (DL7, PM4) e
   isolamento entre organizações (TN1 a TN4, DL6) conferidos contra a 0510 e a suíte. Nenhuma migration mudou.
5. **Pendências que seguiam** (seção 10 e 11): prova pela tela e a aprovação da amplitude do destino (pendência 2).
   A amplitude foi aprovada depois desta revisão (seção 14); a prova pela tela segue pendente.

## 14. Decisão de produto sobre o destino (2026-10-13)

Aprovada pelo dono do produto depois da revisão final (seção 13), para a versão atual da `CG-COM-01`:

1. **Destino:** qualquer funil Green elegível, inclusive o mesmo funil da origem. Elegível é o funil com binding Green
   da organização (`fn_green_pipeline_ids`) e com etapa aberta (D-04).
2. **Produto:** continua obrigatório, ativo e da organização (D-05).
3. **Origem:** permanece ganha e inalterada (D-01; casos OR da suíte de banco).
4. **Vínculo e responsável:** a expansão nasce ligada à origem por `commercial_origin` e atribuída a quem a cria,
   quando é atendente ativo e autorizado da organização (D-07, D-10).
5. **Fora desta entrega:** um funil específico de expansão. O "funil Expansão" do glossário
   ([CONECTORGREEN-VOCABULARY-AND-NAMING](../governance/CONECTORGREEN-VOCABULARY-AND-NAMING.md), linha Expansão) e das
   seções 16.7 e 16.8 da GREEN-CRM-01 descreve o modelo-alvo, que pertence à área `CG-EXP`. Restringir o destino a ele
   seria funcionalidade nova, com o próprio ID.

A decisão confirma o comportamento que a 0510 já tem: nenhum código, migration ou teste mudou por causa dela. O
glossário e as seções 16.7 e 16.8 da GREEN-CRM-01 não foram editados.
