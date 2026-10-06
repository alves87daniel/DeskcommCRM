# SPIKE-GREEN-03 - Canonical Event Cutover: Green Events, Legacy Suppression & Binding Semantics

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhum push.

| Item           | Valor                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base congelada | `spike/green-structural-boundary-v1` @ `8c4e903a4b6ceec0a58b12af034e744956f02db5` (= `origin`, árvore limpa; STRUCTURAL BOUNDARY = SEALED)                             |
| Branch         | `spike/green-canonical-event-cutover-v1` (local)                                                                                                                       |
| Migration      | `supabase/migrations/20261004150000_0508_spike_green_canonical_event_cutover.sql` (+ espelho no `baseline.sql` antes da VARREDURA anon + MANIFEST); 0501-0507 intactas |
| Commits (TDD)  | ver §7.4                                                                                                                                                               |
| Fora de escopo | lifecycle, automation origin, Structural Boundary, LIFE-ADV-05, o event bus inteiro do Deskcomm, GREEN-BASELINE                                                        |

## 1. Censo (Fase 1)

Busca do zero em `app/`, `lib/`, `workers/` e na última definição do SQL (`baseline.sql`). Todo `lead.*` chega aos
consumidores como linha de `event_log`; o que muda é o produtor.

| Evento                                                       | Produtor (local)                                                                                                                                                                                                                                                                                                 | DB/TS                                 | Green?               | Comum?      | Consumer                                                                                                      | Automação? | Duplicável na base?                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| `lead.stage_changed` (canônico)                              | `green.fn_crm_lead_boundary` (AFTER em `crm_leads`, 0506), mesma transação                                                                                                                                                                                                                                       | DB                                    | sim (só)             | não         | automação, `followup-gatilho-etapa.v1`, `leads.aviso-de-etapa`, `conversoes.venda`, `conversoes.qualificacao` | sim        | -                                                       |
| `lead.stage_changed` (legado)                                | 6 sites: rota do Kanban (`leads/[id]/move/route.ts:329`, sessão), `moveLeadHandler` (`leads/_handler.ts:1059`, MCP e automação, emite pelo admin), rota de lote (`leads/bulk/route.ts:393`, sessão, 1 por lead), `agent-stage-sync.ts:442`, `handoff-stage-move.ts:242`, `appointment-stage-move.ts:235` (admin) | TS, request própria, depois do commit | **sim (gêmeo)**      | sim (único) | os mesmos                                                                                                     | sim        | **sim** (gêmeo do canônico; casado pelo supressor)      |
| `lead.deleted`                                               | fronteira Green (lápide canônica); registro (`fn_event_log_e_registro`, nasce `done`)                                                                                                                                                                                                                            | DB                                    | sim (só)             | não emite   | nenhum                                                                                                        | não        | não                                                     |
| `lead.won` / `lead.lost` / `lead.reopened`                   | `fn_emit_event_on_lead_change` (AFTER UPDATE upstream, `entity_kind='lead'`), mesma transação                                                                                                                                                                                                                    | DB                                    | sim                  | sim         | `webPushInboundHandler`, `conversoes.venda` (won); `reopened` é registro                                      | não        | não (um produtor)                                       |
| `lead.assigned`                                              | idem (dono humano ou agente)                                                                                                                                                                                                                                                                                     | DB                                    | sim                  | sim         | web push                                                                                                      | não        | não                                                     |
| `lead.created`                                               | `createLeadHandler` (`_handler.ts:571`: REST, importação, clone, retomar, webhook-in, prospecção, MCP, automação) e `nascimento-do-lead.ts:470` (conversa, voice-agent); o banco grava só `green.lead_birth_provenance`                                                                                          | TS, depois do commit                  | sim (mesmo produtor) | sim         | automação, `followup-gatilho-lead`                                                                            | sim        | não (o banco não emite)                                 |
| `lead.tag_added`                                             | `updateLeadHandler`, lote (`bulk/route.ts:466`), ação `add_tag`                                                                                                                                                                                                                                                  | TS                                    | sim                  | sim         | automação                                                                                                     | sim        | não (a fronteira ignora coluna fora de etapa/funil/org) |
| `lead.updated`                                               | `updateLeadHandler`                                                                                                                                                                                                                                                                                              | TS                                    | sim                  | sim         | nenhum (registro)                                                                                             | não        | não                                                     |
| `lead.bulk_moved/assigned/tagged/deleted`                    | rota de lote, agregado (`entity_id` nulo)                                                                                                                                                                                                                                                                        | TS                                    | sim                  | sim         | nenhum                                                                                                        | não        | não                                                     |
| `lead.date_field_due`, `lead.silent_for`, `lead.stage_stale` | crons (admin), sintéticos, dirigidos (`payload.rule_id`); carimbados por `green.scheduler_trigger_emission` (0506)                                                                                                                                                                                               | TS (cron)                             | sim                  | sim         | automação                                                                                                     | sim        | não                                                     |
| `lead.risk_backlog_seeded`                                   | `risk-seed.ts` (`entity_kind='organization'`)                                                                                                                                                                                                                                                                    | TS                                    | -                    | -           | nenhum (registro)                                                                                             | não        | não                                                     |

Caminhos mapeados (quem escreve etapa e quem relata):

| Caminho                                 | Escreve etapa por                                                    | Relata `lead.stage_changed` legado?                                             |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Kanban (rota)                           | UPDATE pela sessão                                                   | sim, sessão; **inclusive reordenação** (`from = to`)                            |
| lote (rota)                             | `fn_mover_leads_em_lote` (RPC, uma transação)                        | sim, 1 por lead movido (pula quem já estava)                                    |
| ganhar / perder (rota, MCP, automação)  | `encerraDemanda` (UPDATE de `stage_id`; status pelo BEFORE upstream) | não (o banco emite `lead.won`/`lost`)                                           |
| clonar / transferir (rota, automação)   | `createLeadHandler` + `encerraDemanda` na origem                     | `lead.created` do clone; nada de etapa                                          |
| arquivar etapa com destino (rota, MCP)  | `arquivarEtapa` (UPDATE em massa)                                    | não (só `crm_lead_activities`)                                                  |
| agente (worker)                         | `sincronizaEstagioDoAgente`                                          | sim (admin, `passo_do_agente`, sem `request_id`)                                |
| handoff (dispatcher, worker, runtime)   | `moverLeadParaEtapaDeHandoff`                                        | sim (admin, `motivo_do_handoff`)                                                |
| agenda (rota por sessão ou Bearer, MCP) | `moverLeadParaEtapaDeAgendamento`                                    | sim (admin); pela SESSÃO a emissão morre em `reserved_service_origin` (INFO-03) |
| MCP `crm_move_lead_stage`, automação    | `moveLeadHandler`                                                    | sim (admin, `request_id` do contexto; `rule:<id>` na automação)                 |
| importação, webhook-in, prospecção      | INSERT (`createLeadHandler`/RPC de nascimento)                       | `lead.created`                                                                  |
| PostgREST direto (sessão/service_role)  | PATCH/RPC                                                            | não (a não ser que o cliente chame `rpc/emit_event`)                            |
| binding (dono)                          | nenhum UPDATE em `crm_leads`                                         | não (identidades da 0505; auditoria de saída da 0503/0507)                      |
| `emit_event` (RPC)                      | -                                                                    | qualquer membro (viewer+) emite qualquer tipo não reservado (AUTO-GAP-01)       |

## 2. Produtores e fonte de verdade (Fase 2)

> **Qual componente é dono do fato "lead Green mudou de estágio"? O banco:** `green.fn_crm_lead_boundary`, AFTER
> INSERT/UPDATE/DELETE em `crm_leads`, na transação da mutação persistida.

Provado contra o runtime: o canônico só existe se o estado comitou (ORD-1: invisível fora da transação antes do
commit, some no rollback junto com o livro-razão) e nasce para TODO caminho que muda etapa, inclusive os que não
relatam nada (PATCH direto, lote, arquivar, encerrar, MAT-1..13 e C1..C9).

| Classe                           | Fatos                                                                                                                   | Dono                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A. derivável do OLD/NEW da linha | `lead.stage_changed` e `lead.deleted` de lead Green; `lead.won/lost/reopened/assigned` (todos os leads)                 | banco (fronteira Green; gatilho upstream). `lead.stage_changed` de lead comum segue do writer (upstream, fora de escopo) |
| B. comando / intenção            | `lead.created` (via, origem, título), `lead.updated`, `lead.tag_added`, agregados de lote                               | writer                                                                                                                   |
| C. estrutural                    | entrada/saída do domínio por binding                                                                                    | estrutura (binding + identidade + auditoria), sem evento (§9)                                                            |
| D. externo / relógio             | webhook-in (nasce como B), gatilhos de relógio (`lead.date_field_due`, `silent_for`, `stage_stale`, `contact.birthday`) | cron/webhook; a 0506 prova quem emitiu os de relógio                                                                     |

Nada foi transformado em trigger SQL além do que já era A no Green.

## 3. Consumers

Registro em `lib/event-log/register-handlers.ts`; o dispatcher casa por `event_type` + `consumed_by`, sem filtrar
metadata. Para `lead.stage_changed`: o motor de automação (gatilho; condição curada `event.to_stage_id`),
`followup-gatilho-etapa.v1` (`to_stage_id`, `from_stage_id`, `service_origin`), `leads.aviso-de-etapa` (`to_stage_id`;
pula `from = to`), `conversoes.qualificacao` (`to_stage_id`), `conversoes.venda` (relê o lead).

**Nenhum consumidor registrado lê campo que só o legado traz.** O canônico tem `pipeline_id`, `from_stage_id`,
`to_stage_id`, `status`, `green_transition`, `from_pipeline_id` e `service_origin`. Exposição indireta: `call_webhook`
repassa o payload inteiro (o integrador vê `position_in_stage` no legado e `green_transition` no canônico) e condição/
template escritos à mão podem citar qualquer `event.*` (INFO-05).

## 4. Comportamento atual - RED do sistema (Fase 3)

Suíte nova `tests/invariants/green-canonical-event-cutover.test.ts` (47 casos), escrita antes de qualquer código. Os
writers privilegiados rodam REAIS pelo dublê PostgREST (`green-postgrest-shim.ts`: papel, claims e headers do escopo
ALS corrente); os caminhos de sessão são simulados como o transporte os entrega (mutação + emissão na mesma
requisição). **Base (`8c4e903a`, 0507): 13 falham / 34 passam.**

Matriz por ação (lead Green, base). `c` = canônicos, `l` = legados gravados:

| Ação                                            | Mudou        | Fatos de etapa (base)                         | Livro-razão                           | request_id / causation                  | Execuções |
| ----------------------------------------------- | ------------ | --------------------------------------------- | ------------------------------------- | --------------------------------------- | --------- |
| MAT-1 Kanban (sessão)                           | e1→e2        | 1c / 0l                                       | gêmeo casado (`legacy_suppressed_at`) | advisory da rota                        | -         |
| MAT-2 lote (3 leads)                            | →e3          | 1c / 0l cada                                  | casado                                | advisory                                | -         |
| MAT-3 MCP (`moveLeadHandler` real)              | e1→e2        | 1c / 0l                                       | casado                                | `mcp-…` confiável                       | -         |
| MAT-4 agente (real)                             | e1→e3        | 1c / 0l                                       | casado                                | job (sem request_id)                    | -         |
| MAT-5 handoff (real)                            | e1→handoff   | 1c / 0l                                       | casado                                | causation = evento                      | -         |
| MAT-6 agenda por MCP (real)                     | e1→agendado  | 1c / 0l                                       | casado                                | `mcp-…`                                 | -         |
| MAT-7/8 ganhar / perder (`encerraDemanda` real) | →ganho/perda | 1c / 0l + `lead.won`/`lead.lost`              | sem gêmeo (writer não relata)         | `mcp-…`                                 | -         |
| MAT-9 automação por evento                      | e2→e3        | 2c / 0l                                       | casado                                | `rule:<R>`, causation = canônico humano | 1         |
| MAT-10 automação por tempo (`lead.stage_stale`) | e1→e2        | 1c / 0l                                       | casado                                | `rule:<R>`, causation = gatilho         | 1         |
| MAT-11 transferência (automação)                | origem→perda | 1c / 0l + `lead.lost`; clone 1 `lead.created` | sem gêmeo                             | `rule:<R>`                              | 1         |
| MAT-12 arquivar etapa (2 cards)                 | e1→e2        | 1c / 0l cada                                  | sem gêmeo                             | advisory                                | -         |
| MAT-13 PostgREST direto (PATCH)                 | e1→e2        | 1c / 0l                                       | sem gêmeo                             | -                                       | -         |

Em todas as linhas: `correlation_id` = o `request_id` (advisory na sessão humana, confiável no writer privilegiado;
o handler herda o do evento canônico que consumiu); `consumed_by` vazio até o drain, `automation-rules` nos fatos
drenados (MAT-9/10/11, onde o canônico da regra volta `skipped`); `lead.won`/`lead.lost` com `entity_kind='lead'`
(gatilho upstream, mesma transação). Matriz completa por caso em `GREEN_CUTOVER_DIAG_OUT` (arquivo de diagnóstico
da suíte, fora do repositório).

O fluxo normal não duplicava na base: o supressor casava o gêmeo imediato. O defeito aparece fora do caminho feliz
(§5). Pelo servidor Next real (base, Node 22, `next dev`): 8 de 10 casos do E2E novo passam; os 2 vermelhos são o
mecanismo (C1: livro-razão do supressor em vez do escopo) e a decisão de reordenação (C2) (§14).

## 5. Ataques ao supressor (Fase 4)

Supressor da base (`green.fn_suppress_legacy_stage_changed`, 0502): um `lead.stage_changed` sem marca some se casa com
uma linha do livro-razão do MESMO lead, MESMA transição (`to_stage_id`, e `from_stage_id` quando vem), já carimbada,
sem gêmeo, criada há ≤ 5 min; o `request_id` confiável desempata, senão "a mais recente".

| Ataque                                                                                  | Base 0507                                                          | Veredito                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| S1 legado verdadeiro, mesma transição de canônica recente, não-gêmeo (binding removido) | **engolido** (casou com a linha sem gêmeo de outro movimento)      | evento legítimo perdido |
| S2 mesma transição 3× dentro da janela, gêmeos fora de ordem                            | 3c / 0l (casa "a mais recente": atribuição errada, contagem certa) | controle                |
| S3 gêmeo atrasado (> 5 min)                                                             | **1c / 1l** — segundo fato                                         | duplicado               |
| S4 writer sem gêmeo (PATCH, encerramento) + relato de outro escopo                      | **engolido** pela linha sem gêmeo                                  | armadilha com estado    |
| S5 dois writers concorrentes, leitura velha da origem                                   | **2c / 1l** (o `from_stage_id` velho não casa)                     | duplicado               |
| S6 mesmo `request_id` em execuções diferentes                                           | 3c / 0l                                                            | controle                |
| S7 `request_id` diferente no gêmeo                                                      | 1c / 0l (cai em "transição + recente")                             | controle                |
| S8 replay do gêmeo (2 em série + 3 em paralelo)                                         | **1c / 4l** — todo replay vira fato                                | duplicado               |
| S9 reordenação na mesma etapa (lead Green)                                              | 0c / 1l                                                            | decisão (§6)            |
| S10 mutação comum junto de Green (mesmo escopo)                                         | Green 1c, comum 1l                                                 | controle                |
| S11 relato sem escopo para lead Green (viewer, service_role)                            | **gravado** (não havia linha para casar)                           | fato sem mutação        |
| S12 escopo inventado por sessão                                                         | gravado                                                            | AUTO-GAP-01 (§16)       |
| S13 binding criado entre o movimento comum e o relato                                   | 0c / 1l                                                            | controle                |
| S14 binding removido entre o canônico e o gêmeo                                         | 1c / 0l (dentro da janela)                                         | controle                |
| AUT-1 gêmeo atrasado + replay com regra em `lead.stage_changed`                         | **a regra rodou 3 vezes** por um movimento                         | efeito duplicado        |
| CON-2 16 requisições concorrentes (humano, MCP, regra) em 8 leads, com replays          | **2 legados** a mais por lead                                      | duplicado               |

**Sim, a base engolia evento legítimo (S1, S4) e duplicava (S3, S5, S8, CON-2, AUT-1).** O supressor era heurística
com estado (linha "ainda sem gêmeo") e janela; nenhuma combinação de lead + transição + tempo identifica a mutação.

## 6. Decisão de cutover (Fase 5)

| Critério                 | A. canônico único, writers param de relatar para Green                                                                             | B. writers relatam, o banco reconhece o gêmeo por chave forte        | C. porteiro por "lead toca o Green" (sem chave)                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| duplicidade              | 0, se o writer souber que a mutação foi canonizada                                                                                 | 0 (chave exata)                                                      | 0 dentro do domínio; duplica se o binding sai entre mutação e relato  |
| matching heurístico      | nenhum                                                                                                                             | nenhum (igualdade de chave)                                          | nenhum, mas decide pelo estado NA HORA DO RELATO                      |
| acoplamento / drift      | cada writer precisa saber do Green (6 sites) ou de um retorno da mutação que o PostgREST não dá (o AFTER roda depois do RETURNING) | 0 writer tocado; 1 header no transporte central; 1 porteiro no banco | 0 writer tocado                                                       |
| regressão upstream       | média (6 arquivos upstream)                                                                                                        | nula para lead comum (sem linha no livro-razão, nunca casa)          | nula para lead comum                                                  |
| evento legítimo engolido | não                                                                                                                                | não                                                                  | **sim**: movimento comum relatado depois de o funil virar Green (S13) |

**Escolha: B com o porteiro de domínio de C como complemento** — "o canônico é o fato; o relato do writer é
reconhecido pela chave da execução que fez a mutação".

- **Chave forte = escopo de execução do servidor.** Toda execução Green (requisição, tool MCP, regra, job, handler)
  já é um escopo ALS (`lib/green/mutation-context.ts`). Cada escopo ganha um id próprio; o transporte central
  (`initComContextoGreen`, usado pelo `fetchDoServidor` dos três clients de servidor) o manda em
  `x-green-scope-id` junto do contexto. A mutação e o relato de um writer acontecem no mesmo escopo, então levam o
  mesmo id. O banco grava o id no livro-razão quando canoniza.
- **Porteiro (`green.fn_event_log_gate`, BEFORE INSERT em `event_log`)**, só para `lead.stage_changed`/`crm_lead`:
  1. existe linha canonizada do MESMO escopo, MESMO lead, MESMA etapa de destino → não nasce (é o gêmeo). Sem janela,
     sem estado, sem "mais recente"; independe de o lead ainda tocar o domínio (S14).
  2. lead fora do domínio Green → upstream intacto.
  3. lead no domínio, relato sem escopo → não nasce (não descreve mutação do servidor; S11).
  4. reordenação (`from = to`) → não nasce: não é mudança de etapa (S9).
  5. escopo que não canonizou essa transição → nasce: o movimento foi comum (S13).
- **Contrato de confiança:** o porteiro acredita que um escopo do servidor só relata a mutação que ele mesmo fez
  (os 6 writers emitem depois de um UPDATE bem-sucedido daquele lead para aquela etapa). Um escopo inventado por um
  membro passa — é a forja do barramento aberto (AUTO-GAP-01), medida em S12/ORD-2/P1, não nasce aqui.
- **O supressor sai** (Fase 15/16). Não foi mantido "porque funciona": medido, ele engolia e duplicava.

A não foi escolhida porque o PostgREST não devolve o efeito de um trigger AFTER na resposta da mutação (o RETURNING é
calculado antes), então "o writer saber" exigiria Green em 6 writers ou um retorno de header por request; C sozinha
perde o fato no instante do binding. O desenho final dá a A no efeito (para Green o único fato de etapa é o canônico)
com a central da B (nenhum `if (isGreen)` no TypeScript, nenhuma regra de pertencimento fora do banco - Fase 6).

## 7. Implementação

### 7.1 Banco - 0508

| Peça                                                     | O quê                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `green.stage_event_ledger.scope_id`                      | escopo da mutação canonizada; índice parcial `stage_event_ledger_scope_idx (organization_id, lead_id, scope_id) where scope_id is not null`                  |
| `green.fn_request_scope()`                               | lê `x-green-scope-id` de `request.headers`; ausente/inválido = null                                                                                          |
| `green.fn_crm_lead_boundary()`                           | cópia **gerada** da 0506 (script, não redigitada) + a coluna `scope_id` no INSERT do livro-razão; nada mais muda                                             |
| `green.fn_event_log_gate()` + `trg_green_event_log_gate` | parte (a) idêntica à 0502 (marca reservada, prova por livro-razão + GUC de uso único); parte (b) as 5 regras do §6                                           |
| removidos                                                | `trg_green_suppress_legacy_stage_changed`, `green.fn_suppress_legacy_stage_changed`, `green.fn_guard_crm_lead_stage`, `green.fn_emit_crm_lead_stage_changed` |
| histórico (comentado, não escrito)                       | `legacy_suppressed_at`, `legacy_request_id`, índice `stage_event_ledger_twin_idx`                                                                            |

### 7.2 TypeScript - um ponto central

`lib/green/mutation-context.ts` (+20/-5): `EscopoGreen.id` novo (`randomUUID`) em `rodarComContexto`,
`withoutGreenMutationContext` e `runGreenRequestBoundary`; `initComContextoGreen` manda `x-green-scope-id` junto do
contexto, só quando há contexto (sem contexto o transporte segue byte a byte o de antes). **Nenhum writer, nenhuma rota,
nenhum handler foi tocado** nesta spike.

### 7.3 Migration (Fase 15)

0501-0507 sem diff. Fresh install e update (baseline duas vezes com `ON_ERROR_STOP=1`) verdes em toda corrida da
`test:db`. Upgrade 0507→0508: U2 (banco rebaixado à 0507 pela cadeia 0501-0507, com gêmeo em voo, 0508 duas vezes: foto
md5 idêntica, porteiro no lugar do supressor) e o stack local com os dados acumulados das spikes (§15). Rollout:
**banco antes do servidor** — entre os dois, o servidor antigo não manda escopo e o gêmeo dele para lead Green não nasce
(nunca duplica); lead comum igual (U2 passo 4).

### 7.4 Commits

| Commit      | O quê                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `969cfb7bd` | RED: suíte `green-canonical-event-cutover` (47 casos, 13 falham na base)                             |
| `50f414714` | 0508 + apêndice do baseline + MANIFEST                                                               |
| `8584c205b` | transporte: id do escopo em `x-green-scope-id` + unit `lib/green/escopo-do-gemeo.test.ts`            |
| `a20283bdb` | S23 (v2) e ADV-07 (v3) passam ao contrato GREEN-03 (válvula `DESKCOMM_GOV_INVARIANTS_EDIT=1`, §14.2) |
| `3985c1855` | E2E `canonical-cutover-real` + S18/S19 do `postgrest-real` no contrato GREEN-03                      |
| (este)      | relatório                                                                                            |

## 8. Lead comum é controle (Fase 7)

| Prova                                                                                                                | Resultado (base e spike) |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| COM-1 Kanban, reordenação e relato sem escopo: legado com o payload/metadata do writer, sem `green`, sem livro-razão | igual                    |
| COM-2 MCP, agente, handoff e agenda REAIS: 1 legado cada, `source` do writer                                         | igual                    |
| COM-3 automação: a regra roda 1 vez sobre o legado; o legado do handler (`rule:`) é pulado (anti-loop)               | igual                    |
| S10/S11/S13 controles comuns; C3/C4 pela rota real                                                                   | igual                    |

O porteiro só decide quando há linha do mesmo escopo no livro-razão (lead comum nunca tem) ou quando o lead toca o
domínio. Nenhuma dependência Green nova no caminho comum.

## 9. Binding: entrada e saída (Fases 8 e 9)

**Decisão consciente: binding NÃO gera evento por lead, nem estrutural no `event_log`.**

| Pergunta                | Entrada (binding novo / re-apontado para o funil)                                                     | Saída (binding removido / re-apontado para fora)                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| É `lead.stage_changed`? | não: a etapa não mudou                                                                                | não                                                                                                      |
| Fato por lead?          | sim, estrutural: `green.lead_identity` (`first_seen_at` = instante do binding, mesma transação, 0505) | não; a identidade continua `live`                                                                        |
| Fato estrutural único?  | a linha do binding (`created_at`)                                                                     | `api_audit_log` `green.binding_removed` com `released_leads`, `operation`, `new_pipeline_id` (0503/0507) |
| Quem audita?            | só o dono escreve binding (nenhum papel de API tem DML); o registro é o binding + identidades         | a auditoria herdada                                                                                      |
| Automação deve reagir?  | não: reclassificação administrativa dispararia regras em massa (centenas/milhares)                    | não                                                                                                      |
| Consumer precisa?       | nenhum no censo                                                                                       | nenhum                                                                                                   |
| Volume / atomicidade    | um evento por lead caberia mal na transação do binding (LIFE-ADV-05, teto de 8 s)                     | idem                                                                                                     |

Provas: B1 (3 leads entram: 0 evento, 0 execução, 3 identidades `live` com `first_seen_at` = `now()` da transação do
binding), B2 (saída: 0 evento, auditoria `released_leads=1`, o próximo movimento é legado comum), B3 (re-apontamento: 0
evento, auditoria com origem e destino, quem entra ganha identidade), B4 (depois de entrar, o primeiro movimento é
canônico `stay` e o relato não nasce). Uma auditoria nova `green.binding_created` chegou a ser implementada e foi
retirada: não acrescentava ator (o dono) nem fato que o binding e as identidades não registrem, e mudava a contagem de
auditoria de um teste selado do lifecycle.

## 10. `lead.created` (Fase 10)

**Dono no estado final: o writer** (`createLeadHandler`, `nascimento-do-lead`). Exceção legítima à regra "A é do banco":
(1) o fato carrega intenção que só o comando tem (`via: planilha`, origem, título) e o follow-up a lê; (2) o banco nunca
emitiu `lead.created`, então não há gêmeo: 1 por criação (CRE-1 no writer real; C6 e MAT-11 no clone); (3) o registro
atômico do nascimento Green já é do banco (`green.lead_birth_provenance`, mesma transação); (4) migrar exigiria o
porteiro casar gêmeo em 8+ caminhos de nascimento sem ganho de correção. O custo aceito é o do upstream: a emissão vem
depois do commit, em outra request (DÉBITO-02).

## 11. `lead.deleted` (Fase 11)

Inalterado: lápide canônica, registro, nasce `done`, `consumed_by` vazio, fora do drain (DEL-1). Nenhum consumidor foi
criado.

## 12. Automação (Fase 12)

| Prova                                                                                                                                                                                | Resultado spike                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| MAT-9 gatilho por evento: 1 execução; canônico da regra com `source=automation`, `request_id=rule:<R>`, causation = canônico humano; o canônico da regra volta `skipped` (anti-loop) | sim                                 |
| MAT-10 gatilho por tempo (`lead.stage_stale`): 1 execução, 1 canônico, 0 legado                                                                                                      | sim                                 |
| MAT-11 transferência: 1 execução, origem encerrada (canônico + `lead.lost`), clone com 1 `lead.created`                                                                              | sim                                 |
| AUT-1 gêmeo atrasado + replay: **1 execução** (base: 3)                                                                                                                              | sim                                 |
| C8 servidor Next real + tick real: 1 execução sobre o fato humano, 2 canônicos, 0 legado                                                                                             | sim                                 |
| `green-automation-origin` (selada, arquivo inteiro) e `automation-origin-real` (E2E, cron real + tick real)                                                                          | sim (verdes, nenhum teste alterado) |

Origem da automação continua provada pelo banco (0506 intacta; a fronteira da 0508 é cópia da 0506 + a coluna de
escopo): `service_origin.kind=automation`, `rule:<R>`, causation = evento consumido, e o canônico causado por regra
volta ao motor como `skipped/caused_by_rule`.

## 13. Ordem e concorrência (Fases 13 e 14)

Ordem medida: mutação → canônico (AFTER, mesma transação) → commit → relato do writer (outra request; o porteiro não
o grava para Green) → drain (tick/cron) → automação. ORD-1: dentro da transação o canônico existe; fora, antes do
commit, não; no rollback somem estado, fato e livro-razão. ORD-2: o porteiro confia no escopo (contrato do writer).

| Caso                                                                           | Base                        | Spike                       |
| ------------------------------------------------------------------------------ | --------------------------- | --------------------------- |
| CON-1 A→B→C no mesmo escopo, relatos em paralelo                               | 2c / 0l                     | 2c / 0l                     |
| CON-2 16 requisições concorrentes (humano, MCP, regra) em 8 leads, com replays | 2c / **2l**                 | 2c / 0l                     |
| CON-3 humano concorrente com regra, humano desfeito                            | 1c / 0l                     | 1c / 0l                     |
| S5 writers concorrentes com leitura velha                                      | 2c / **1l**                 | 2c / 0l                     |
| S8 replay em paralelo                                                          | 1c / **4l**                 | 1c / 0l                     |
| C9 servidor real: 12 movimentos em 6 leads ao mesmo tempo (200 ou 409 da OCC)  | canônicos = livro-razão, 0l | canônicos = livro-razão, 0l |

Cada fato aparece 0 vezes se desfeito e 1 vez se comitado; nunca 2.

## 14. RED → GREEN (Fase 17)

Mesmos arquivos, só muda o código sob teste.

| Suíte                                                             | Base (`8c4e903a`, 0507)                         | Spike (0508)                                              |
| ----------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `green-canonical-event-cutover` (banco, writers reais pelo dublê) | **13 falham / 34 passam** (47)                  | **47/47**                                                 |
| `canonical-cutover-real.e2e` (Next real Node 22 + PostgREST real) | 8/10 (`next dev`; C1 mecanismo, C2 reordenação) | **10/10** (build de produção)                             |
| `lib/green/escopo-do-gemeo.test.ts` (unit, novo)                  | não existe na base (o header não existe)        | 5/5 em Node 24, Node 22.23.3 e `--no-async-context-frame` |

Vermelhos da base, um a um: CEN-1/CEN-2 (supressor e funções mortas presentes), S1 e S4 (evento legítimo engolido),
S3, S5, S8 (duplicado), S9 (reordenação Green vira fato), S11 (relato sem escopo vira fato), AUT-1 (3 execuções),
CON-2 (2 legados por lead), U1/U2 (0508). Critérios da Fase 17 na spike:

| Critério                             | Prova                                                          | Spike |
| ------------------------------------ | -------------------------------------------------------------- | ----- |
| mutação Green → exatamente um fato   | MAT-1..13, S2, S3, S5-S8, S10, S14, CON-1..3; C1, C4-C9        | sim   |
| nenhuma supressão de evento legítimo | S1, S4, S10 (comum), S13; COM-1..3; C3, C4 (comum); P1 (comum) | sim   |
| lead comum → comportamento igual     | COM-1..3 e controles iguais nas duas versões                   | sim   |
| rollback → zero fatos                | ORD-1, CON-3                                                   | sim   |
| automação → uma execução             | MAT-9, MAT-10, MAT-11, AUT-1, C8                               | sim   |
| anti-loop preservado                 | MAT-9 (`skipped` no canônico da regra), COM-3, C8              | sim   |

### 14.1 Correções de TESTE durante a corrida (nenhuma afrouxa o contrato)

1. Fixture de etapas com um parâmetro `$8` sem tipo (o arquivo nem rodava).
2. CRE-1 sem `source` (NOT NULL de `crm_leads`).
3. ORD-1 e CON-3 emitiam o gêmeo de uma mutação DESFEITA, o que nenhum writer faz (lançam antes de emitir). Passaram a
   modelar o writer real; o comportamento do porteiro para "escopo que relata sem ter mutado" ficou explícito em ORD-2
   (contrato de confiança, CUT-GAP-02).
4. B1/B3 contavam também o binding do próprio fixture; e, depois da retirada da auditoria `green.binding_created`
   (§9), passaram a afirmar o registro estrutural (identidades) em vez de uma linha de auditoria nova.
5. S11/U2 trocaram "recusa `42501 green_stage_changed_canonical_only`" por "não nasce": a primeira versão do porteiro
   recusava com erro o relato sem escopo para lead Green; isso vermelhava a v1 selada (S1, S3, S8 de
   `green-mutation-context.test.ts`, que afirmam "a emissão legada da rota vira no-op"). O no-op mantém a semântica já
   selada e o efeito (nenhum fato) é o mesmo.
6. E2E C8 contava execuções da regra sobre outro lead do mesmo arquivo (o canônico pendente do C1 também ia a e2);
   passou a contar só as execuções sobre os fatos do lead do caso.

O RED registrado (13/47) é o do arquivo final commitado em `969cfb7bd`, rodado contra a base com a implementação posta
de lado.

### 14.2 Testes antigos alterados por mudança de contrato

| Teste                                        | Afirmava (supressor temporal)                                                                  | Agora (GREEN-03)                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S23 #1 (`green-mutation-context-v2`)         | gêmeo registrado em `legacy_suppressed_at`/`legacy_request_id`; segundo relato igual grava (2) | livro-razão sem registro de gêmeo; relato sem escopo de lead Green não nasce (1 evento)      |
| S23 #2                                       | reordenação e transição nunca canonizada de lead Green viram fato (2)                          | 0 (reordenação não é fato; relato sem escopo não é fato)                                     |
| S23 #3                                       | gêmeo atrasado além da janela grava (2)                                                        | 1: era o defeito S3                                                                          |
| S23 #4                                       | atribuição "a mais recente" por `legacy_*`                                                     | só a contagem (3 mutações, 3 fatos); nenhuma linha "escolhida"                               |
| ADV-07 #1 e #2 (`green-mutation-context-v3`) | segundo relato grava; `request_id` confiável escolhe a linha; humano casa a mais recente       | segundo relato não nasce; nenhuma linha escolhida; contagens iguais                          |
| S18, S19 (`postgrest-real.e2e`)              | gêmeo provado por `legacy_suppressed_at`/`legacy_request_id`                                   | gêmeo provado pelo escopo: UPDATE e emissão com o mesmo `x-green-scope-id`, o do livro-razão |

Os arquivos de `tests/invariants/**` são congelados pela governança (`loop/hooks/freeze-invariants.sh`); a alteração foi
feita com a válvula declarada (`DESKCOMM_GOV_INVARIANTS_EDIT=1`), em commit próprio, cada asserção marcada `CONTRATO
GREEN-03` com o valor anterior. Lifecycle, automation origin, structural boundary e a v1 do mutation context: **nenhum
teste alterado**.

## 15. Regressão (Fase 18)

Ambiente: Windows 11, Docker Desktop; `test:db` em `pgvector:pg15` efêmero (install + update do baseline com
`ON_ERROR_STOP=1`); stack local `deskcomm-green-spike` (Kong, PostgREST, GoTrue, Postgres 17); Node 22.23.3
(`npx -p node@22`) para o build de produção do Next, o `next start` e os E2Es; `SENTRY_DSN=off` (log: `[telemetria]
Desligada`); suítes de banco uma de cada vez, nada pesado em paralelo ao build. Chaves do stack lidas do `kong.yml` por
script e passadas só ao processo filho; segredos do servidor gerados no scratchpad; nada impresso nem gravado no
repositório.

| Suíte                                                                                                                                                                                                                                           | Resultado                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| suíte nova `green-canonical-event-cutover` (banco)                                                                                                                                                                                              | **47/47** (base: 13 falham / 34 passam)                                                                                                                                                                                                                   |
| Green seladas: mutation context v1/v2/v3, lifecycle v1/v1.2/v1.3, automation origin, structural boundary + a nova                                                                                                                               | **9/9 arquivos, 342/342**; alterados só S23 (v2) e ADV-07 (v3) por contrato (§14.2)                                                                                                                                                                       |
| `test:db` inteira                                                                                                                                                                                                                               | **350/350 arquivos, 3093 passed, 1 expected fail, 1 skipped** (`test:db verde`, 1621 s; install + update `ON_ERROR_STOP=1`). GREEN-02: 349/3046; delta = o arquivo novo e seus 47 casos                                                                   |
| `tsc --noEmit -p tsconfig.typecheck.json`                                                                                                                                                                                                       | **exit 0**                                                                                                                                                                                                                                                |
| `eslint` nos arquivos tocados/novos; `prettier --check`                                                                                                                                                                                         | 0 erros; formatados só os que já eram limpos na base (`green-mutation-context-v3.test.ts` não era, ficou como estava)                                                                                                                                     |
| unit `lib/green` (9 arquivos)                                                                                                                                                                                                                   | **97/97** em Node 24, em `--no-async-context-frame` e em Node 22.23.3                                                                                                                                                                                     |
| writers/rotas e transporte (`supabase-server-url-opcional`, `service-boundary`, `auth-falha-alto`, `rbac-matrix`, `etapa-de-perda-no-arrasto`, `agent-stage-sync`, `handoff-stage-move`, `appointment-stage-move`, `aviso-de-etapa-na-central`) | **9/9 arquivos, 113/113**                                                                                                                                                                                                                                 |
| cercas de baseline/migration/MANIFEST/event-log/suporte (24 arquivos de `tests/unit`, projetos `cercas` e `produto`) + `lib/supabase/fetch-do-servidor.test.ts`                                                                                 | **25/25 arquivos, 135/135** (inclui `apendice-do-baseline-nao-diverge-da-cadeia`, `baseline-nao-constroi-o-que-derruba`, `manifest-x-migrations`, `manifest-cita-caminho-que-existe`, `evento-de-fato-nao-fica-pendente`, `suporte-cobertura-de-efeitos`) |
| E2E novo `canonical-cutover-real` (build de produção, `next start`, Node 22)                                                                                                                                                                    | **10/10**                                                                                                                                                                                                                                                 |
| E2E Green existentes (`postgrest-real`, `lifecycle-real`, `next-real-v3`, `automation-origin-real`, `structural-real`)                                                                                                                          | verdes: os 6 arquivos juntos **42 passed + 2 skipped** (os 2 são os marcadores "sem stack", que pulam quando o stack existe)                                                                                                                              |
| lead comum como controle                                                                                                                                                                                                                        | COM-1..3, S10/S11/S13 e controles comuns iguais nas duas versões; C3, C4 e P1 pela rota/PostgREST reais                                                                                                                                                   |

A `vitest --project cercas` inteira não foi repetida: nesta máquina ela tem 11 arquivos vermelhos por ambiente nas duas
versões (GREEN-02 §16) e nenhum arquivo de produção fora de `lib/green/mutation-context.ts` mudou; rodaram as cercas
que leem o que esta spike tocou (baseline, migration, MANIFEST, event-log, rotas).

**Upgrade no stack com dados reais** (antes do E2E da spike): 758 leads, 113 bindings, 12711 identidades, 12869
linhas de livro-razão, 13152 eventos, 39 linhas de auditoria Green. 0508 aplicada **duas vezes** por `psql -v
ON_ERROR_STOP=1` (~0,4 s cada; a segunda só com `NOTICE` de "não existe, pulando"): foto md5 de `event_log`, livro-razão
(sem a coluna nova), leads, bindings, identidades e auditoria Green **idêntica** antes/depois; `event_log` com
`trg_green_canonical_immutable`, `trg_green_event_log_gate`, `trg_green_stamp_scheduler_trigger`; supressor e funções
mortas fora; as 12869 linhas antigas com `scope_id` nulo (nunca casam gêmeo: o servidor antigo não manda escopo).

## 16. Gaps classificados

Classificação: BLOCKER (impede a selagem) · PRODUÇÃO (backlog do GREEN-BASELINE / pré-deploy) · DÉBITO · INFO.

| ID                    | Classe                 | Gap                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (base) CUT-B1         | BLOCKER → **fechado**  | Supressor temporal duplicava: gêmeo atrasado (S3), replay (S8: 4 de 4), writers concorrentes com leitura velha (S5), rajada concorrente (CON-2); uma regra rodava 3× por movimento (AUT-1).                                                                                                                                                                             |
| (base) CUT-B2         | BLOCKER → **fechado**  | Supressor engolia evento legítimo: linha sem gêmeo de um writer que não relata (PATCH, encerramento, arquivar) casava o relato de outro movimento (S1, S4). Fecha também o `GAP-SUPPRESSOR-V3`/DIAG-06 herdado.                                                                                                                                                         |
| (base) CUT-B3         | PRODUÇÃO → **fechado** | Relato sem escopo para lead Green (sessão ou service_role pelo PostgREST) virava fato de etapa sem mutação (S11).                                                                                                                                                                                                                                                       |
| CUT-GAP-01            | PRODUÇÃO               | **Ordem de deploy: banco (0508) antes do servidor.** Na ordem inversa o servidor novo fala com a 0507, que ignora o escopo e segue com o supressor temporal (com os defeitos medidos) até a migration; na ordem certa o gêmeo do servidor antigo não nasce (U2 passo 4). Item do checklist de rollout do GREEN-BASELINE, junto com o STRUCT-GAP-01.                     |
| AUTO-GAP-01 (herdado) | PRODUÇÃO               | Barramento aberto: um membro emite qualquer tipo não reservado por `rpc/emit_event`. O cutover fecha o relato SEM escopo para lead Green, mas um escopo inventado no header passa (S12, ORD-2, P1): o header de escopo é transporte, não autorização. Fechar exige o barramento deixar de ser executável por `authenticated` para `lead.*` (decisão do GREEN-BASELINE). |
| CUT-GAP-02            | DÉBITO                 | Contrato de confiança no escopo: o porteiro grava o relato de um escopo do servidor que não canonizou aquela transição (é o que preserva o movimento comum relatado depois do binding, S13). Um writer que emitisse depois de um UPDATE que falhou gravaria um fato falso; hoje os 6 writers só emitem depois do UPDATE bem-sucedido (lançam antes), ORD-2 documenta.   |
| CUT-GAP-03            | DÉBITO                 | Os writers ainda fazem a request de relato para lead Green (uma ida ao banco que vira no-op). Custo de latência, não de correção; tirar exige o writer saber da canonização (ver §6, opção A).                                                                                                                                                                          |
| CUT-GAP-04            | DÉBITO                 | `lead.created` continua do writer, depois do commit, em outra request (não atômico, como no upstream); o registro atômico do nascimento Green é `green.lead_birth_provenance` (§10).                                                                                                                                                                                    |
| CUT-GAP-05            | INFO                   | Histórico mantido: `legacy_suppressed_at`/`legacy_request_id` (não escritos) e `stage_event_ledger_twin_idx` (o baseline o recria a cada update; a cerca de índices proíbe criar-e-derrubar). O `update.sh` reaplica os apêndices 0501/0502 antes do da 0508: durante a corrida o supressor antigo existe por instantes ao lado do porteiro (os dois só recusam).       |
| INFO-01               | INFO                   | Reordenação de lead COMUM continua emitindo `lead.stage_changed` (`from = to`), e `followup-gatilho-etapa`, `conversoes.qualificacao` e regras em `event.to_stage_id` reagem a ela (upstream; só `aviso-de-etapa` filtra). No Green deixou de ser fato (S9, C2).                                                                                                        |
| INFO-02               | INFO                   | `lead.bulk_moved` não tem consumidor e não está na lista de registro: fica `pending` para sempre (upstream).                                                                                                                                                                                                                                                            |
| INFO-03               | INFO                   | Agenda pela SESSÃO: `appointment-stage-move` manda `service_origin` no payload e o `emit_event` recusa (`reserved_service_origin`); o lead COMUM perde o `lead.stage_changed` desse caminho (upstream). No Green o fato é o canônico.                                                                                                                                   |
| INFO-04               | INFO                   | Payload legado com `status` de antes do movimento (agente, handoff, agenda) e sem `status` (lote); o canônico traz o `status` depois do gatilho BEFORE. Nenhum consumidor registrado lê `status`.                                                                                                                                                                       |
| INFO-05               | INFO                   | `call_webhook` repassa o payload inteiro: para lead Green o integrador recebe o formato canônico (`green_transition`, `from_pipeline_id`; sem `position_in_stage`). Condição/template escritos à mão sobre `event.position_in_stage` não casam em lead Green.                                                                                                           |
| INFO-06               | INFO                   | Achados de passagem do censo (upstream, fora de escopo): prospecção grava `lead.created` com `request_id=rule:<campanha>` e as regras de `lead.created` o pulam; a condição curada `event.to_stage_id` de `lead.stage_stale` nunca é verdadeira (o cron não manda o campo); comentários velhos em `lib/automation/engine.ts` e `lib/schemas/webhooks.ts`.               |
| INFO-07               | INFO                   | Binding: entrada e saída sem evento por lead (decisão §9); a saída conta `released_leads` sem listar (STRUCT-GAP-10 continua).                                                                                                                                                                                                                                          |
| herdados              | -                      | LIFE-ADV-05 (escala), AUTO-GAP-02..08, STRUCT-GAP-01..10, EV-01B residual: intocados. `GAP-SUPPRESSOR-V3`: fechado (CUT-B2).                                                                                                                                                                                                                                            |

Nenhum BLOCKER aberto.

## 17. Matriz de selagem (Fase 19)

| Critério                                                    | Prova                                                                                                                                     | Resultado |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Green tem fonte de verdade explícita para `stage_changed`   | §2 (o banco, na transação da mutação); CEN-3; ORD-1; porteiro: relato sem escopo e reordenação de lead Green não nascem (S9, S11, C2, P1) | SIM       |
| mutação Green gera exatamente um evento                     | MAT-1..13; S2, S3, S5-S8, S14; CON-1..3; C1, C4-C9                                                                                        | SIM       |
| rollback gera zero evento                                   | ORD-1, CON-3                                                                                                                              | SIM       |
| nenhum evento legítimo é engolido                           | S1, S4, S10, S13; COM-1..3; C3, C4, P1 (comum)                                                                                            | SIM       |
| supressor atual foi removido ou justificado definitivamente | removido na 0508 (CEN-1, CEN-2, U2, stack); colunas/índice só históricos (CUT-GAP-05)                                                     | SIM       |
| lead comum mantém comportamento upstream                    | COM-1..3, controles iguais nas duas versões, C3, C4; `test:db` inteira                                                                    | SIM       |
| `lead.created` tem dono explícito                           | §10 (writer; exceção justificada); CRE-1, MAT-11, C6: um só                                                                               | SIM       |
| `lead.deleted` mantém semântica de fato                     | §11; DEL-1 (canônico, registro, `done`, sem consumidor)                                                                                   | SIM       |
| binding enter tem semântica explícita                       | §9 (sem evento; binding + identidade `first_seen_at` na mesma transação); B1, B4                                                          | SIM       |
| binding exit tem semântica explícita                        | §9 (sem evento; `green.binding_removed` com `released_leads`); B2, B3                                                                     | SIM       |
| automação recebe evento uma vez                             | MAT-9, MAT-10, MAT-11, AUT-1 (base: 3), C8                                                                                                | SIM       |
| anti-loop continua correto                                  | MAT-9, COM-3, C8; `green-automation-origin` e `automation-origin-real` intactos e verdes                                                  | SIM       |
| concorrência não duplica fatos                              | S5, S8, CON-1..3, C9                                                                                                                      | SIM       |
| nenhuma regressão crítica                                   | §15: `test:db` inteira verde (350/3093), seladas 342/342, E2E de produção 42 + 10, `tsc`/lint/cercas verdes                               | SIM       |

## Veredito

Os 14 critérios foram provados com o mesmo teste nas duas versões (base: 13 de 47 vermelhos, com fato duplicado,
evento legítimo engolido e uma regra rodando 3 vezes por movimento; spike: 47/47) e pelos caminhos reais: writers
privilegiados reais pelo dublê PostgREST, servidor Next de produção em Node 22 com sessão GoTrue real, tick real,
PostgREST real e upgrade de um banco com os dados acumulados das spikes.

O cutover ficou pequeno: um porteiro de INSERT no banco e um header no transporte central. Nenhum writer, rota ou
handler foi tocado; nenhuma regra de pertencimento Green foi copiada para o TypeScript; o supressor temporal saiu.
Para Green, o único fato de mudança de etapa é o canônico; o relato do writer é reconhecido pela chave da execução que
fez a mutação. Lead comum segue o upstream.

**CANONICAL EVENT CUTOVER = SEALED.** Não é PASS limpo: ficam gaps classificados, nenhum BLOCKER — CUT-GAP-01 (ordem de
deploy: banco antes do servidor) e AUTO-GAP-01 herdado (forja no barramento aberto, agora só com escopo inventado) como
PRODUÇÃO; CUT-GAP-02..04 como DÉBITO; o resto INFO. E seis asserções de suítes seladas (S23, ADV-07, S18/S19 do E2E)
mudaram por mudança de contrato deliberada, documentada em §14.2.

Próxima tarefa prevista (não iniciada): GREEN-BASELINE-1.0.

Integridade: `spike/green-structural-boundary-v1` intacta em `8c4e903a`; 0501-0507 sem diff; sem push, PR ou merge;
`main` intocada; servidor Next parado e `.next/` removido; containers efêmeros da `test:db` removidos. O stack local
`deskcomm-green-spike` ficou com a 0508 aplicada e as fixtures dos E2Es (orgs `green-co-*`); a regra de automação do
E2E foi desativada no `afterAll`. Chaves do stack lidas do `kong.yml` por script e passadas só ao processo filho;
segredos do servidor gerados no scratchpad da sessão; nenhum valor impresso nem gravado no repositório.

CANONICAL EVENT CUTOVER = SEALED
SPIKE-GREEN-03: PASS-COM-GAPS
