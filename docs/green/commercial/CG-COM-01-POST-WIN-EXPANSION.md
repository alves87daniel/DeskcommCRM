# Comercial — Expansão pós-ganho

| Item                   | Valor                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID                     | `CG-COM-01`                                                                                                                                                                                    |
| Tipo                   | `FEAT`                                                                                                                                                                                         |
| Área                   | `CG-COM` (Comercial), como pedido pelo dono do produto. Ver a pendência 1 (seção 11) sobre a árvore da seção 4.3 da nomenclatura                                                               |
| Estado                 | EM ANDAMENTO: checkpoint de implementação, aguardando análise. Sem push, PR ou merge                                                                                                           |
| Equivalência histórica | `PARCIAL` com a "GREEN-CRM-04" candidata da GREEN-CRM-01 (seções 16.7 e 16.8): este item entrega só a expansão manual a partir do dossiê. Importação por período e regra automática ficam fora |
| Branch                 | `feat/cg-com-01-post-win-expansion`, criada de `origin/main` = `c5b3b5eef`                                                                                                                     |
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

| Objeto                                                                                                   | O que faz                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trigger `trg_commercial_origin_link_guard` em `crm_lead_links` (`green.fn_commercial_origin_link_guard`) | Só para `link_kind = commercial_origin`: alvo `lead`; lead e alvo da organização do vínculo (inexistente e de outra organização dão a mesma recusa); alvo `won`; origem diferente do destino; sessão humana com papel `agent`+; vínculo imutável (sem UPDATE). Vale para todo papel, inclusive `service_role`. Os outros vínculos (agenda: `scheduled`) não mudam |
| `public.fn_green_pipeline_ids(org)` (definer)                                                            | Funis Green (com binding) da organização, só para membro dela. É a lista de destinos possíveis. Não expõe a chave de processo do binding                                                                                                                                                                                                                          |
| `public.fn_crm_open_expansion_of(origem, produto)` (definer)                                             | A expansão ABERTA da origem com o produto, se houver: `(lead_id, visible)`. Enxerga a organização inteira (a duplicidade não pode depender da RLS do chamador), mas só devolve o id quando o chamador enxerga a expansão, e não responde nada por origem que ele não enxerga                                                                                      |
| `public.fn_crm_create_expansion_opportunity(...)` (invoker)                                              | A escrita, numa transação. Roda com a RLS e o papel do chamador, exatamente como o INSERT do PostgREST que o `createLeadHandler` faz (travas de suporte e fronteira Green incluídas)                                                                                                                                                                              |

Passos da escrita, nesta ordem: valida forma (produto obrigatório, título de 2 a 200, moeda ISO, valor não negativo);
toma `pg_advisory_xact_lock` por origem; lê a origem pela RLS, da organização pedida, `won` e com contato; confere que
o destino é funil Green e que a etapa é aberta (sem etapa, a primeira aberta); procura a expansão aberta da mesma origem
e produto (se existir, devolve ela com `created = false`; se o chamador não a enxerga, recusa `expansion_already_open`);
cria a oportunidade (`source = expansao`, contato da origem, sem responsável, aberta), o contexto Green com o produto
(regras da 0509: produto ativo e da organização) e o vínculo. Qualquer recusa desfaz tudo: não sobra oportunidade sem
vínculo nem vínculo sem produto.

`retomado_de_lead_id` (nova tentativa depois de perda) e `source_metadata.clonado_de` (troca de funil) não são usados:
a expansão grava `retomado_de_lead_id = null`, `external_id = null` e `source_metadata = {}` (provado em EX1).

## 3. Regras de negócio aplicadas

| #    | Regra                                                                                                                                                                          | Fonte                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| D-01 | A oportunidade de origem fica intacta: nenhum UPDATE, nenhuma atividade, nenhum evento. Continua `won`, no mesmo funil, com `closed_at` e histórico                            | D-15 (GREEN-CRM-01)                                                               |
| D-02 | Origem elegível: `won` e com contato, visível ao operador. O funil da origem não é restrito                                                                                    | D-15; "contato já convertido" (glossário)                                         |
| D-03 | A expansão reaproveita o contato da origem. Nunca cria contato e o corpo do pedido não aceita contato                                                                          | escopo item 4                                                                     |
| D-04 | Destino: funil Green (com binding) e etapa aberta (não ganho, não perda, não arquivada). Sem etapa, a primeira aberta. O funil de destino pode ser o mesmo da origem           | glossário (expansão em funil Green com produto); regras Green da 0509             |
| D-05 | Produto obrigatório, ativo e da organização. A tela sugere o produto da origem (se ativo); pode ser outro                                                                      | D-17 (produto principal obrigatório na oportunidade Green); 16.7 ("pode diferir") |
| D-06 | Idempotência: uma expansão ABERTA por (origem, produto). Repetir devolve a existente. Encerrada a expansão, outra com o mesmo produto é legítima. Produto diferente abre outra | 16.8 (requisito de idempotência); resolve a DP-12                                 |
| D-07 | A expansão nasce sem responsável, como a criação manual de negócio (`NewLeadDialog`); título e valor vêm do formulário; etiquetas e campos personalizados não são copiados     | comportamento existente da criação manual                                         |
| D-08 | `metadata` do vínculo: `reason = expansion`, `created_via = manual`, `product_id`                                                                                              | 16.8 (vocabulário de `reason` e `created_via`)                                    |
| D-09 | A régua de campos obrigatórios por etapa (issue #1536) vale para a expansão, como vale para a retomada                                                                         | comportamento existente                                                           |

**DP-12 (chave de idempotência da expansão) resolvida aqui:** verificação pelo vínculo + produto + status aberto, sob
lock transacional por origem, na mesma transação da criação. A candidata `external_id = <A.id>:<product.code>` com
`source = expansao` foi recusada: o índice único a tornaria permanente (bloquearia uma nova expansão depois de a
primeira ser perdida ou ganha) e usaria `external_id`, que é identidade de sistema externo, como chave de domínio. A
GREEN-CRM-01 não foi editada; a linha da DP-12 lá continua como registro histórico (pendência 3).

## 4. Idempotência e concorrência

Três camadas, cada uma com a sua prova:

1. **Banco (a garantia):** lock por origem + checagem dentro da transação. Cinco chamadas simultâneas criam uma
   expansão (ID2); repetir devolve a mesma, sem escrita nem evento (ID1).
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
| origem de outra organização         | ninguém                                                             | organização da sessão no filtro da rota e no parâmetro da RPC; mesma recusa de inexistente (404)                  |
| vínculo `commercial_origin` à mão   | `agent`+, alvo `won`, mesma organização                             | guarda da 0510 para todo papel, inclusive `service_role`                                                          |
| alterar vínculo `commercial_origin` | ninguém                                                             | guarda da 0510 (imutável)                                                                                         |

A organização vem sempre da sessão; o schema é `.strict()` e recusa `organization_id`, `contact_id` e `status` no
corpo.

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

| Camada | Arquivo                                                           | O que prova                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Banco  | `tests/invariants/green-expansion-commercial-origin.test.ts` (28) | EX (nova, mesmo contato, produto, vínculo, campos recusados não usados), OR (origem byte a byte intacta), ID (repetição, 5 simultâneas, produto diferente, expansão encerrada, invisível), EL, TN (incl. `service_role`), PM, EV, SG |
| API    | `tests/unit/green-expansao-api.test.ts` (33)                      | papel, suporte, `.strict()`, organização da sessão, elegibilidade, idempotência (existente, invisível, corrida, `Idempotency-Key` pelo helper real, recibo sem título), cada recusa nomeada, rastro e auditoria, GET                 |
| UI     | `tests/unit/green-expansao-ui.test.tsx` (12)                      | relação (origem, expansões, sem acesso, seção ausente), formulário (padrões, funil troca etapa enviada), envio só para `/expansion`, mesma chave no reenvio e outra ao reabrir, "já existia"                                         |

Mutações dirigidas (script fora do repositório, cada arquivo restaurado depois): 9 de 9 no servidor e 6 de 6 na UI
reprovaram as suítes. Duas mutações da UI sobreviveram na primeira rodada e mostraram testes fracos (checagem antes
de a leitura terminar; `<select>` controlado que mostra a primeira opção com valor velho); os dois testes foram
reforçados e passaram a reprovar.

Rodar a suíte de banco: `CONFERENCIA_KIT_RELEASE=v1.69.0 pnpm test:db tests/invariants/green-expansion-commercial-origin.test.ts`.

## 10. Limitações reais

- **Sem prova pela tela (DoD 12):** a UI foi provada por testes de componente, não por Playwright num ambiente fresco
  estilo VPS. Fica para a validação seguinte, como na CG-PRD-01.
- **Expansão invisível:** o agente em modo de visibilidade restrito que tenta abrir uma expansão já aberta por outro
  atendente recebe 409 sem ver qual é. A lista de expansões do dossiê também mostra só as que ele enxerga.
- **Destino só Green:** funil comum não recebe expansão nesta versão (o produto só existe em funil Green). Ampliar
  não exige migration de dados, mas exige decidir a chave de idempotência sem produto.
- **Sem responsável na expansão:** num funil de organização em modo de visibilidade `own`, o agente não consegue
  criar oportunidade sem dono (regra existente da RLS, igual à criação manual); manager+ consegue.
- **Vínculo apagável por membro:** a policy de DELETE de `crm_lead_links` (0042) continua permitindo a membro da
  organização apagar vínculo; o guarda novo só impede UPDATE. A auditoria `lead.expansion_created` preserva o fato.
  Se a origem for apagada, o vínculo fica com alvo pendente (como todo vínculo polimórfico); a leitura mostra a origem
  como `visible = false`.
- **Sem MCP, sem automação, sem importação por período:** fora do escopo (16.7 e 16.8 continuam como próximos itens).
- **`.changes/`:** nenhum fragmento de release, como nas entregas Green anteriores (o fork não corta release do
  upstream).
- `lib/database.types.ts` ganhou as três funções à mão (o cliente do servidor não é tipado por `Database`).

## 11. Pendências e decisões para o dono do produto

| #   | Pendência                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Área do ID.** A árvore da seção 4.3 da nomenclatura manda pós-ganho para `CG-EXP` (regra 8). O ID foi o ditado (`CG-COM-01`): a entrega é criação de oportunidade a partir do dossiê em qualquer funil Green, que a tabela de áreas põe em `CG-COM`. Confirmar ou trocar antes do PR (o número é livre nas duas) |
| 2   | Confirmar D-04/D-05: destino restrito a funil Green e produto obrigatório. Ampliar para funil comum exige decidir a chave de idempotência sem produto                                                                                                                                                              |
| 3   | Registrar a resolução da DP-12 na GREEN-CRM-01 (seção 12) ou só neste documento                                                                                                                                                                                                                                    |
| 4   | Responsável da expansão: hoje nasce sem dono (D-07). Alternativas: quem cria, ou o dono da origem                                                                                                                                                                                                                  |
