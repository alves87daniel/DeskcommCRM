# SPIKE-GREEN-AUTO-01 - Automation Origin & Green Opportunity Triggers

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhum push.

| Item           | Valor                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base congelada | `spike/green-lead-lifecycle-v1.3` @ `b4ccb48f68110cc91b53e5f154ac67f502e2c77f` (= `origin`, intacta; LEAD LIFECYCLE = SEALED)                                    |
| Branch         | `spike/green-automation-origin-v1` (local)                                                                                                                       |
| Achado de base | LIFE-ADV-01 (automação em Opportunity Green), BLOCKER PARA GREEN-BASELINE herdado da v3                                                                          |
| Migration      | `supabase/migrations/20261003200000_0506_spike_green_automation_origin.sql` (+ espelho no `baseline.sql` antes da VARREDURA anon + MANIFEST); 0501-0505 intactas |
| Commits (TDD)  | `8801c36b6` RED → `81bd15911` 0506 → `f120c67d0` motor/contrato TS → `534ed7120` transferência + E2E → `108bd74ce` gaps G1/G2 → relatório                        |
| Fora de escopo | lifecycle, identidade UUID, LIFE-ADV-05 (escala), supressor legado/canônico, Structural Boundary                                                                 |

## 1. Censo dos gatilhos (Fase 1)

**Número real: 16 gatilhos.** A fonte única é `ENTIDADE_ESPERADA_POR_GATILHO` (`lib/schemas/webhooks.ts`); o
handler do motor assina exatamente essa lista (`lib/automation/engine.handler.ts`, catraca
`lib/automation/gatilhos-em-uma-fonte.test.ts`). Os "16" do achado conferem com o código; nada foi adaptado a um
número.

**Todo gatilho chega ao motor como uma linha de `event_log`**: o motor é consumidor do barramento (dispatcher →
`runAutomationForEvent`). O que varia é o PRODUTOR da linha. A única ação que escreve em Opportunity (etapa, funil,
nascimento) é `create_or_move_lead` (mover; criar; transferir = clonar + encerrar a origem). `add_tag` e
`assign_owner` escrevem colunas que não passam pela fronteira Green (sem mudança de etapa/funil); as de mensagem não
escrevem em `crm_leads`.

Censo dos produtores (busca no código; latest definition do SQL pelo `baseline.sql`):

| Trigger                   | Família              | Como nasce (produtor · client)                                                                                                                                  | event_log real?    | entity_id              | Contato        | Origem antes        | Green antes                                 | Comum |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------- | -------------- | ------------------- | ------------------------------------------- | ----- |
| `lead.created`            | B (G via webhook-in) | `createLeadHandler` (admin, qualquer chamador: rota, import, clone, webhook-in, MCP); `nascimento-do-lead` (admin)                                              | sim                | `crm_lead`             | do lead        | `event` (ancorável) | PASS                                        | PASS  |
| `lead.stage_changed`      | A + B                | canônico Green pelo trigger de `crm_leads` (sessão ou serviço); legado pelas rotas move/bulk (SESSÃO) e writers de serviço (admin), gêmeo suprimido em Green    | sim                | `crm_lead`             | do lead        | `event`             | PASS                                        | PASS  |
| `lead.tag_added`          | B                    | handlers de lead e lote, `add_tag` (admin)                                                                                                                      | sim                | `crm_lead`             | do lead        | `event`             | PASS                                        | PASS  |
| `contact.tag_added`       | B                    | handler de contato, `add_tag` (admin); trigger 0262 do cliente pela agenda (dentro da transação da SESSÃO)                                                      | sim                | `contact`              | o próprio      | `event`             | PASS                                        | PASS  |
| `message.received`        | B                    | trigger de `messages` (INSERT inbound; tipo reservado contra sessão no `emit_event`)                                                                            | sim                | `message`              | da mensagem    | `event`             | PASS                                        | PASS  |
| `message.failed`          | B / G                | trigger de `messages` (INSERT já falhado); `falha-de-entrega` (SESSÃO pelo cookie, admin por token/worker, webhook de status da Meta, `recover-stuck-messages`) | sim                | `message`              | da mensagem    | `event`             | **FAIL** `green_service_origin_unsupported` | PASS  |
| `appointment.created`     | B                    | `fecharOLaco` da agenda (SESSÃO pela tela; admin por Bearer/MCP)                                                                                                | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `appointment.confirmed`   | B                    | idem                                                                                                                                                            | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `appointment.rescheduled` | B                    | idem                                                                                                                                                            | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `appointment.cancelled`   | B                    | idem                                                                                                                                                            | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `appointment.completed`   | B                    | idem                                                                                                                                                            | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `appointment.no_show`     | B                    | idem                                                                                                                                                            | sim                | `calendar_appointment` | do compromisso | `event`             | **FAIL**                                    | PASS  |
| `contact.birthday`        | C · D · E            | cron `contact-birthdays` (admin): a data vira acontecimento                                                                                                     | sim, **sintético** | `contact`              | o próprio      | `event`             | **FAIL**                                    | PASS  |
| `lead.date_field_due`     | C · D · E            | cron `lead-date-field-due` (admin), **dirigido** (`payload.rule_id`)                                                                                            | sim, **sintético** | `crm_lead`             | do lead        | `event`             | **FAIL**                                    | PASS  |
| `lead.silent_for`         | C · E · F            | cron `lead-time-triggers` (admin), varredura de AUSÊNCIA de mensagem, dirigido                                                                                  | sim, **sintético** | `crm_lead`             | do lead        | `event`             | **FAIL**                                    | PASS  |
| `lead.stage_stale`        | C · E · F            | cron `lead-time-triggers` (admin), varredura de etapa parada, dirigido                                                                                          | sim, **sintético** | `crm_lead`             | do lead        | `event`             | **FAIL**                                    | PASS  |

Famílias: A canônico real (1, compartilhado com B); B evento legado real (12); C sintético (4); D temporal (2);
E scheduler (4); F derivado/scan (2); G webhook/integração (`lead.created` por webhook-in, `message.failed` por
webhook de status); H nenhum. **"Green antes" = medido** pelo motor real (§4, coluna base): 11 de 16 recusados
(`message.failed`, os 6 `appointment.*` e os 4 de relógio), 5 aceitos. O trigger legado
`fn_emit_event_on_lead_change` só emite `lead.won/lost/reopened/assigned` com `entity_kind='lead'`: nenhum é gatilho.

Fato que decidiu o desenho (censo dos emissores): `public.emit_event` é executável por `authenticated` e, na última
definição (0279), só reserva `message.received`, `appointment.outcome_confirmed` e `ai.case_*` contra sessão.
**Qualquer membro (viewer em diante) consegue gravar no `event_log` da própria organização uma linha de qualquer
outro tipo**, inclusive os 4 de relógio, pelo PostgREST. Ao mesmo tempo há produtores LEGÍTIMOS com sessão humana
para a família de evento (agenda pela tela, mover pela rota, falha de envio pelo cookie, trigger da agenda).

## 2. Arquitetura anterior

```text
gatilho → event_log → drain (claim processing) → dispatchEvent (withGreenSystemRoot: event_handler)
→ runAutomationForEvent → withGreenMutationContext{ source:automation, request_id:rule:<id>,
  causation:<evento>, actor:webhook_source/<regra>, service_origin: kind=event{evento, org, contato do contexto} }
→ create_or_move_lead → moveLeadHandler/createLeadHandler (admin) → fetchDoServidor (header)
→ PostgREST (service_role) → crm_leads → green.fn_crm_lead_boundary (AFTER)
→ fn_mutation_envelope → fn_assert_service_origin(origem, org, contato)
→ green.fn_assert_event_origin_contact(org, evento, contato)
```

`fn_assert_event_origin_contact` é a projeção SEM efeito colateral de `public.fn_service_event_origin`, a régua de
ATENDIMENTO ("de que atendimento é este evento"), e só conhece 6 pares tipo@entidade: `lead.created`,
`lead.stage_changed`, `lead.tag_added` (crm_lead), `contact.tag_added` (contact),
`appointment.outcome_confirmed` (appointment, no-show), `message.received` (message inbound). A catraca S16 a amarra à
função canônica: alargá-la mudaria a régua de atendimento, não a de automação.

## 3. Causa do bug (Fase 2)

Hipótese do pedido **provada por medição** (§4) e localizada:

| Pergunta                     | Resposta                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onde nasce o erro            | `green.fn_assert_event_origin_contact`, ramo `else` (0501:352): tipo fora dos 6 pares → `raise 'green_service_origin_unsupported'` (23503), chamado pela fronteira (0505) na escrita privilegiada de `crm_leads` |
| Classificação no TS          | **erro de classificação**: o motor (`engine.ts:244`) chamava TODA execução de regra de `service_origin.kind=event`, uma origem de ATENDIMENTO                                                                    |
| Representação                | **erro de representação**: não existia origem para "esta regra executou por causa deste evento"; o modelo só tinha `event` (atendimento), `continuation` (fronteira de atendimento) e `command` (derivada)       |
| Whitelist incompleta         | sintoma, não causa: alargar a lista de atendimento faria a régua de atendimento aceitar tipos que ela não ancora (e quebraria a paridade S16)                                                                    |
| Ausência de anchor confiável | para a família de relógio, **sim**: a linha é real mas sintética, e qualquer membro pode emitir uma igual (`emit_event`); nada no banco dizia QUEM a emitiu                                                      |
| Regra de banco               | a régua fazia o que dizia; o defeito era o motor declarar a origem errada                                                                                                                                        |
| Contraste                    | regra sem contato no contexto saía SEM `service_origin` e era ACEITA (resíduo ADV-08): o mesmo gatilho passava ou falhava conforme o lead tivesse contato                                                        |

## 4. RED (Fase 3)

Suíte nova `tests/invariants/green-automation-origin.test.ts` (57 casos de contrato; 59 com os gaps documentados G1/G2, §14), escrita antes de qualquer código de
produção. Caminho de produção sem mock no ponto investigado: emissor real do gatilho (cron/rota/trigger, pelo papel
real) → `event_log` → claim `processing` (como o drain) → `dispatchEvent` (raiz de sistema) →
`runAutomationForEvent` → `create_or_move_lead` → handlers reais → dublê PostgREST com papel `service_role` e header
Green tirado do escopo ALS (`green-postgrest-shim.ts`) → fronteira → `event_log`. Mockados só `createAdminClient`
(→ dublê) e `audit` (no-op).

Corrida na base (`b4ccb48f` + a suíte, implementação da base restaurada por `git checkout <base> -- engine.ts
mutation-context.ts baseline.sql`): **49 falham / 8 passam (57)**. Primeira corrida (antes de duas correções de
teste, ver abaixo): 48 / 7 (55).

| Caso (matriz RED)                   | run     | ação                                      | lead     | trusted / service_origin              |
| ----------------------------------- | ------- | ----------------------------------------- | -------- | ------------------------------------- |
| `lead.stage_stale` (cron)           | failed  | failed:`green_service_origin_unsupported` | não move | sem canônico                          |
| `lead.silent_for` (cron)            | failed  | failed:`green_service_origin_unsupported` | não move | sem canônico                          |
| `lead.date_field_due` (cron)        | failed  | failed:`green_service_origin_unsupported` | não move | sem canônico                          |
| `contact.birthday` (cron)           | failed  | failed:`green_service_origin_unsupported` | não move | sem canônico                          |
| `lead.tag_added` (já funcionava)    | success | success                                   | move     | `automation`/`rule:<R>`; `kind=event` |
| controle comum (`lead.stage_stale`) | success | success                                   | move     | (sem canônico: lead comum)            |

Censo na base (motor real, um tenant por gatilho): `lead.created`, `lead.stage_changed`, `lead.tag_added`,
`contact.tag_added`, `message.received` = success com `kind=event`; `message.failed` e os 6 `appointment.*` =
failed:`green_service_origin_unsupported`; criação Green por gatilho de contato e as duas transferências = failed
pelo mesmo motivo. **LIFE-ADV-01 reproduzido: 11 de 16**, mais os caminhos de criação/transferência dos tipos não
ancoráveis. Correlation, causation e `rule:<R>` estavam corretos onde a escrita passava; o `event_log` envolvido é
sempre a linha que o motor consumiu.

Os 8 que passam na base são controles ou recusas de forma iguais nas duas versões: C0 (lista de 16), os dois
controles comuns, A2, A3, X18, X19, X20. Todo caso adversarial X1-X17/X21 falha na base com
`42501 green_mutation_context_required` (o kind não existia): o resultado (lead não se move) já era o certo, pelo
motivo errado.

Correções de TESTE depois da primeira corrida RED (nenhuma afrouxa o contrato): (1) A3 afirmava canônico humano sem
`service_origin`; o `emit_event` da 0279 carimba `kind=command` derivado pelo banco, e o teste passou a afirmar
"origem derivada `command`, nunca a declarada pela sessão"; (2) K2 (catraca do WHEN do carimbo) e os dois casos de
transferência foram acrescentados.

## 5. Modelo de origem escolhido (Fases 4 e 5)

> **Todo gatilho de automação possui necessariamente um event_log confiável que pode ser usado como origem?**

Neste runtime, todo gatilho TEM uma linha de `event_log` (o motor só consome o barramento; os gatilhos de relógio são
materializados pelos crons). **Mas a linha não é igualmente confiável:** para 4 tipos ela é a materialização de uma
decisão do relógio, não uma ocorrência de domínio, e qualquer membro consegue gravar uma igual. Por isso o modelo não
força o relógio a "ser um evento": a família é derivada pelo banco e cada família tem a sua raiz.

**Taxonomia mínima:** UM kind novo transportado, `automation`. A família (`event` × `scheduler`) é DERIVADA pelo
banco a partir do tipo do evento (`green.fn_automation_trigger_family`), nunca declarada. Não existe kind
`scheduler`/`timer`/`system_job`: o runtime real tem um executor (o motor) e duas famílias de raiz.

```text
service_origin = { kind: "automation", rule_id, event_id, organization_id }   (só o motor declara)
```

Invariantes provados pela fronteira na transação da escrita (`green.fn_assert_automation_origin`, ordem fixa, uma
causa por recusa):

| #   | Invariante                                                                                                                                                                                                                                 | Recusa                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | organização da origem = organização do lead                                                                                                                                                                                                | `green_service_origin_scope_mismatch` |
| 2   | marcadores confiáveis são os da regra: `source=automation`, `request_id=rule:<rule_id>`, `causation_event_id=<event_id>`, `actor={webhook_source, rule_id}`, `correlation_id` (se houver) = a confiável do evento raiz ou o próprio evento | `green_automation_origin_incoherent`  |
| 3   | qual regra: existe NESTA organização, ativa, com `create_or_move_lead`                                                                                                                                                                     | `green_automation_rule_invalid`       |
| 4   | qual ocorrência: evento existe NESTA organização                                                                                                                                                                                           | `green_automation_event_invalid`      |
| 5   | qual gatilho legítimo: tipo = gatilho da regra, gatilho do produto, entidade esperada, dirigido a ESTA regra                                                                                                                               | `green_automation_trigger_mismatch`   |
| 6   | raiz de relógio emitida pelo servidor                                                                                                                                                                                                      | `green_automation_trigger_untrusted`  |
| 7   | qual execução: o evento está vivo (`pending`/`processing`) - é a execução corrente, não um replay                                                                                                                                          | `green_automation_event_stale`        |
| 8   | qual lead: o alvo é o sujeito do evento (o próprio lead; ou lead do contato do evento, contato ativo)                                                                                                                                      | `green_automation_subject_mismatch`   |
| -   | nenhum valor do cliente decide: sessão humana nunca transporta `service_origin` (caller `user`)                                                                                                                                            | (ignorado; derivado `command`)        |

"Qual execução/run": a execução é o par (regra, evento) enquanto o evento está na fila do motor; a linha de
`automation_rule_runs` (gravada pelo motor depois das ações, com `rule_id` e `event_id`) é o registro dela, ligável
ao canônico pelo mesmo par. Não foi criada tabela de execução prévia: o par já é a identidade que o banco consegue
provar no momento da escrita (§14, AUTO-GAP-04).

Implementação (alteração mínima, sem condicional por handler):

| Arquivo                         | Mudança                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/automation/engine.ts`      | a origem deixa de depender do contato: toda execução declara `greenAutomationOrigin(regra, evento, org)` (−17 linhas, +6)                                                                                                                                                         |
| `lib/green/mutation-context.ts` | kind `automation` no contrato fechado (chaves, uuids) + `greenAutomationOrigin`                                                                                                                                                                                                   |
| `0506` (+ espelho no baseline)  | `fn_automation_trigger_entity`/`_family`; `green.scheduler_trigger_emission` + trigger; `fn_mutation_context` (cópia da 0504 + um ramo); `fn_assert_automation_origin`; overload de 5 argumentos de `fn_assert_service_origin`; `fn_crm_lead_boundary` (cópia da 0505, UMA linha) |

As cópias foram geradas por script a partir da 0504/0505 com substituição de ocorrência única; o `diff` contra os
originais mostra só o ramo `automation` (9 linhas) e a linha da chamada da prova. A de 3 argumentos e
`fn_assert_event_origin_contact` ficaram intactas (S16 continua valendo).

## 6. Event-driven (Fase 7)

Para os 12 gatilhos da família `event`, o vínculo provado é:

```text
automation run (regra R, evento E)  ↔  event_log E (org, tipo = R.trigger_event, entidade esperada, vivo)
                                   ↔  organização (R, E e o lead na MESMA org)
                                   ↔  entidade/contato (crm_lead: E.entity_id; contato: E.entity_id;
                                        mensagem: messages.contact_id; compromisso: calendar_appointments.contact_id)
                                   ↔  lead alvo (= E.entity_id, ou lead do contato do evento; contato ativo)
```

Não é whitelist de tipo: a régua de tipos só decide a entidade esperada e a família; a aceitação exige a ocorrência
concreta (X3, X4, X5, X12, X13). Qualquer emissor é aceito na família `event`, porque há produtores legítimos com
sessão (C-`appointment.created/confirmed/rescheduled` foram emitidos por sessão no censo e passam). Isso deixa um
resíduo herdado do barramento (AUTO-GAP-01).

## 7. Time-based / synthetic (Fase 8)

| Pergunta               | Resposta                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quem iniciou           | o cron (`lead-time-triggers`, `lead-date-field-due`, `contact-birthdays`) com o client de serviço; o carimbo `green.scheduler_trigger_emission` registra `caller=service_role`                    |
| scheduler / clock tick | o cron decide e materializa a linha; o tick do relógio só drena (raiz de sistema, sem herdar a sessão que bateu o relógio: E1 confere que nada do admin nem do request do tick entra no canônico) |
| automation engine      | executa a regra apontada (`payload.rule_id`) ou as do tipo (aniversário)                                                                                                                          |
| qual rule              | `rule_id` da origem = `payload.rule_id` do evento dirigido = regra ativa da org com o tipo                                                                                                        |
| qual run               | par (regra, evento) com o evento vivo                                                                                                                                                             |
| qual tenant            | o do evento = o da regra = o do lead                                                                                                                                                              |
| por que aquele lead    | o cron o escolheu (entidade do evento) pela âncora da varredura; para aniversário, o lead do contato aniversariante                                                                               |

O carimbo: tabela `green.scheduler_trigger_emission (event_id → event_log on delete cascade, organization_id,
event_type, caller, user_id)`, gravada SÓ pelo trigger `AFTER INSERT` de `event_log` com
`WHEN (event_type in <os 4>)` (definer, `search_path=''`), com a mesma classificação de caller do
`fn_mutation_context`. Nenhum papel de API escreve nela (X22: `authenticated` 42501 no schema; `service_role`
42501 no INSERT). Uma sessão que emite o mesmo tipo fica carimbada `user` + uid e a raiz é recusada; o `emit_event`
continua aceitando a emissão (upstream intacto: o controle comum C-forjado move o lead COMUM). Nenhum `event_log`
foi inventado.

## 8. Anti-loop (Fase 6)

| Caso                                                                             | Resultado                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1: regra A move → canônico → motor                                              | `skipped/caused_by_rule`, nenhuma run, lead fica onde A pôs, 1 canônico (inclusive com uma regra B de `lead.stage_changed` ativa)                                                               |
| A2: A→B e B→A no mesmo gatilho (`lead.stage_changed`)                            | o evento humano roda A e B uma vez cada (ordem de criação; termina onde a última pôs); os canônicos de A e de B voltam ao motor e são `caused_by_rule`; 3 canônicos no total, nenhuma reentrada |
| A3: sessão humana com `source=automation`, `rule:<R>`, origem de regra no header | `trusted={user, auth.uid(), user_session}`; tudo em advisory; origem derivada `command`; o canônico humano DISPARA a regra (não é tratado como causado por regra)                               |
| E1 (Next real)                                                                   | o canônico da regra é drenado `done` pelo tick sem nenhuma run                                                                                                                                  |

Comportamento documentado (inalterado): profundidade 1. Um evento causado por regra não roda NENHUMA regra; duas
regras do mesmo gatilho rodam uma vez cada no evento humano. A marca anti-loop passa a ser PROVADA (invariante 2)
sempre que a escrita declara a origem `automation` (o que o motor faz em toda regra): `request_id=rule:<R>`,
`source`, `actor` e causation têm de ser os da regra R e do evento. O backend que declara `rule:*` SEM origem continua
aceito e lido como causado por regra (AUTO-GAP-02, G2). Nenhuma proteção nova de recursão foi criada;
`causadoPorRegra` não mudou.

A→B/B→A através do RELÓGIO (regra A de etapa parada; regra B de mudança de etapa) também não fecha ciclo: a escrita
de A nunca roda B (A1), e a de B só faz A rodar de novo quando o cron emitir uma NOVA âncora (N dias depois; a trava
`regra:negócio:âncora` impede repetir a mesma). Igual em lead comum.

## 9. Tenant (Fase 10)

Toda leitura da prova filtra a organização do LEAD; regra e evento de outra organização são indistinguíveis de
inexistentes. X1 (regra alheia) ≡ X2 (inexistente); X4 (evento alheio) ≡ X3 (inexistente); X20 compara código,
mensagem, `detail` e `hint`: idênticos (sem oracle). X6 (org da origem trocada) e X21 (lead da org B com a origem
completa da org A) → `green_service_origin_scope_mismatch`. A fronteira continua AFTER (só roda para linha que a
RLS já aceitou), como na v3.

## 10. Ataques adversariais (Fase 9)

Todos com `service_role` (o único caller que transporta origem) e um contexto montado à mão; o lead fica onde estava
e nenhum canônico nasce. X0 é o controle positivo (o contexto que o motor monta passa).

| Ataque                                                                                         | Veredito                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| X1 regra de outra organização                                                                  | `23503 green_automation_rule_invalid`                            |
| X2 regra inexistente                                                                           | `23503 green_automation_rule_invalid`                            |
| X3 evento inexistente / run inexistente                                                        | `23503 green_automation_event_invalid`                           |
| X4 evento de outra organização                                                                 | `23503 green_automation_event_invalid`                           |
| X5 evento de OUTRO lead                                                                        | `23503 green_automation_subject_mismatch`                        |
| X6 organização da origem trocada (contato de outro tenant)                                     | `23503 green_service_origin_scope_mismatch`                      |
| X7 correlation de outro evento                                                                 | `23503 green_automation_origin_incoherent`                       |
| X8 `request_id` de outra regra                                                                 | `23503 green_automation_origin_incoherent`                       |
| X9 causation de outro evento                                                                   | `23503 green_automation_origin_incoherent`                       |
| X10 ator que não é a regra                                                                     | `23503 green_automation_origin_incoherent`                       |
| X11 `source` que não é `automation`                                                            | `23503 green_automation_origin_incoherent`                       |
| X12 evento de outro tipo                                                                       | `23503 green_automation_trigger_mismatch`                        |
| X13 evento dirigido a outra regra                                                              | `23503 green_automation_trigger_mismatch`                        |
| X14 regra inativa                                                                              | `23503 green_automation_rule_invalid`                            |
| X15 regra sem ação que escreve em Opportunity                                                  | `23503 green_automation_rule_invalid`                            |
| X16 origem de relógio declarada à mão (evento emitido por sessão)                              | `23503 green_automation_trigger_untrusted`                       |
| X17 replay de execução antiga (evento `done`)                                                  | `23503 green_automation_event_stale`                             |
| X18 kind inventado `scheduler`                                                                 | `42501 green_mutation_context_required`                          |
| X19 chave extra na origem (`contact_id`)                                                       | `42501 green_mutation_context_required`                          |
| X22 `source=automation`/`rule:*`/origem completa vindos de SESSÃO                              | ignorados: `trusted=user_session`; carimbo inalcançável pela API |
| C-forjado (4 tipos de relógio emitidos por um viewer pelo PostgREST, drenados pelo motor real) | run `failed:green_automation_trigger_untrusted`, lead não move   |

## 11. GREEN (Fase 13)

Mesma suíte, código da spike: **57/57** de contrato (mais G1/G2 = 59/59) (`test:db` do arquivo, install + update do baseline com `ON_ERROR_STOP=1`
verdes). Para cada gatilho: run `success`, ação `success`, o lead Green muda de etapa (ou nasce, ou é encerrado na
transferência), `trusted = {caller:service_role, source:automation, request_id:rule:<R>, causation_event_id:<E>,
correlation_id:<E>, actor:webhook_source/<R>}`, `payload.service_origin = {kind:automation, rule_id:R, event_id:E,
organization_id}` e o anti-loop segue de pé. "Não deu `green_service_origin_unsupported`" não foi critério: cada
caso afirma a etapa, o canônico e a proveniência.

Idempotência e retry (Fase 11):

| Caso                                              | Resultado                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| I1 redelivery do MESMO evento ainda vivo (reaper) | o lead não se move de novo; 1 canônico só; a proveniência não muda; `automation_rule_runs` ganha 2 linhas `success` (upstream) |
| I2 replay de execução antiga (evento já `done`)   | a regra roda (o motor não sabe), a fronteira recusa `green_automation_event_stale`, run `failed`, lead não volta               |
| retry × execução nova                             | retry = mesmo par (regra, evento) com o evento vivo; execução nova = outro evento. Nada duplica no Green                       |

## 12. Matriz completa de triggers (Fase 14)

Motor real, emissor real (papel do produtor), base × spike:

| Trigger                                  | Emissor no teste                                                | Base                              | Spike | Classe          |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------- | ----- | --------------- |
| `lead.created`                           | `emit_event` service_role (handler)                             | PASS (`kind=event`)               | PASS  | PASS            |
| `lead.stage_changed`                     | canônico Green de uma mudança HUMANA                            | PASS (`kind=event`)               | PASS  | PASS            |
| `lead.tag_added`                         | `emit_event` service_role                                       | PASS (`kind=event`)               | PASS  | PASS            |
| `contact.tag_added`                      | `emit_event` service_role                                       | PASS (`kind=event`)               | PASS  | PASS            |
| `message.received`                       | trigger de `messages` (INSERT inbound)                          | PASS (`kind=event`)               | PASS  | PASS            |
| `message.failed`                         | trigger de `messages` (INSERT já falhado)                       | FAIL unsupported                  | PASS  | PASS            |
| `appointment.created`                    | `emit_event` SESSÃO (tela)                                      | FAIL unsupported                  | PASS  | PASS            |
| `appointment.confirmed`                  | `emit_event` SESSÃO                                             | FAIL unsupported                  | PASS  | PASS            |
| `appointment.rescheduled`                | `emit_event` SESSÃO                                             | FAIL unsupported                  | PASS  | PASS            |
| `appointment.cancelled`                  | `emit_event` service_role (token/MCP)                           | FAIL unsupported                  | PASS  | PASS            |
| `appointment.completed`                  | `emit_event` service_role                                       | FAIL unsupported                  | PASS  | PASS            |
| `appointment.no_show`                    | `emit_event` service_role                                       | FAIL unsupported                  | PASS  | PASS            |
| `contact.birthday`                       | `emit_event` service_role (cron)                                | FAIL unsupported                  | PASS  | PASS            |
| `lead.date_field_due`                    | `emit_event` service_role (cron)                                | FAIL unsupported                  | PASS  | PASS            |
| `lead.silent_for`                        | `emit_event` service_role (cron)                                | FAIL unsupported                  | PASS  | PASS            |
| `lead.stage_stale`                       | `emit_event` service_role (cron) e **cron real pelo Next** (E1) | FAIL unsupported                  | PASS  | PASS            |
| criação Green (contato)                  | `contact.birthday` cron                                         | FAIL unsupported                  | PASS  | PASS            |
| transferência comum→Green                | `contact.birthday` cron                                         | FAIL unsupported                  | PASS  | PASS            |
| transferência Green→comum                | `contact.birthday` cron                                         | FAIL unsupported                  | PASS  | PASS            |
| os 4 de relógio emitidos por SESSÃO      | `emit_event` viewer (PostgREST)                                 | FAIL (motivo errado: unsupported) | FAIL  | FAIL ESPERADO   |
| controle comum (relógio, cron e forjado) | idem                                                            | PASS                              | PASS  | PASS (upstream) |

**Nenhum gatilho legítimo do produto falha por deficiência da representação de origem Green.** FORA DE ESCOPO: nenhum
gatilho; ficam fora as ações que não escrevem em Opportunity (mensagem, tarefa, webhook) e o agente de IA chamado por
`send_ai_message`/fluxos (tem raiz própria, `continuation`/`agent_runtime`).

## 13. Regressão (Fase 15)

Ambiente: Windows 11, Docker Desktop; `test:db` em `pgvector:pg15` efêmero; stack local `deskcomm-green-spike`
(0505 → **0506 aplicada por upgrade**, duas passadas, a segunda idempotente); Node 22.23.3 (`npx -p node@22`) para o
servidor e os E2Es; suítes de banco uma de cada vez. Credenciais do stack lidas do `kong.yml` por script e passadas
só ao processo filho; nenhuma impressa nem gravada no repositório; `SENTRY_DSN=off` no servidor.

| Suíte                                                                                                 | Resultado                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| suíte nova `green-automation-origin` (banco)                                                          | **59/59** = 57 de contrato (base: 49 falham / 8 passam) + G1/G2 (gaps documentados, passam nas duas versões)                                                                                                                                                                                                                                                                                |
| `tsc --noEmit -p tsconfig.typecheck.json`                                                             | **exit 0**                                                                                                                                                                                                                                                                                                                                                                                  |
| `eslint` focado (arquivos tocados) + `prettier --check`                                               | 0 erros (`engine.ts` já não era prettier-limpo na base; não reformatado)                                                                                                                                                                                                                                                                                                                    |
| cercas de migration/baseline/MANIFEST/automação (34 arquivos de `tests/unit`, antes da corrida cheia) | **236/236** (inclui `apendice-do-baseline-nao-diverge-da-cadeia`, `manifest-cita-caminho-que-existe`, `automacao-troca-de-funil-transfere-o-negocio`)                                                                                                                                                                                                                                       |
| unitários `lib/green` + `lib/automation` (inclui motor e a suíte nova)                                | **230/230** (22 arquivos)                                                                                                                                                                                                                                                                                                                                                                   |
| `test:db` inteira (pg15 efêmero, install + update)                                                    | **348/348 arquivos, 2971 passed, 1 expected fail, 1 skipped** (1606 s); v1.3: 347/347, 2914 passed. Delta = a suíte nova (+1 arquivo, +57 casos); nenhuma falha                                                                                                                                                                                                                             |
| E2E (build de produção do Next, `next start`, Node 22), 4 arquivos                                    | **20 passed, 2 skipped** (marcadores "sem stack"), duas corridas: E1 (novo), N1-N9, S18-S22, lifecycle L1-L3                                                                                                                                                                                                                                                                                |
| `vitest --project produto` inteira                                                                    | 1400/1409 arquivos, 14728 passed; 9 arquivos / 13 casos vermelhos sob carga. Isolados: `lib/theme` e `tag-em-lote-mostra-existentes` passam (carga); ficam **7 arquivos / 11 casos = o conjunto pré-existente registrado na v3** (`lgpd-pdf-*` ×4, `confianca-do-handoff-nao-e-similaridade`, `followups-de-demonstracao-sao-possiveis`, `rascunho-superado-nao-e-regravado`). **Novas: 0** |
| `vitest --project cercas` inteira                                                                     | 253/263 arquivos, 2501 passed; 10 arquivos / 38 casos vermelhos, os MESMOS 10 arquivos / 38 casos (diff vazio) rodados no commit da base (`b4ccb48f`, checkout destacado no próprio clone): ambiente Windows (`spawnSync bash ENOENT`, Python ausente, timeouts de 15/60 s, guarda de release/`gh`). **Novas: 0**                                                                           |
| lifecycle SEALED (`green-lead-lifecycle`, `-v12`, `-v13` + `lifecycle-real`)                          | dentro do `test:db` inteiro e do E2E; nenhum teste de lifecycle alterado                                                                                                                                                                                                                                                                                                                    |

Testes antigos alterados por mudança de contrato (cada um com comentário `CONTRATO GREEN-AUTO-01`; nenhum em
`tests/invariants/**`):

| Teste                                       | Afirmava                                     | Novo contrato                          |
| ------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| `lib/green/seams.test.ts` S4                | o motor declara `kind=event` com o contato   | `kind=automation` (regra, evento, org) |
| `tests/green-e2e/postgrest-real.e2e.ts` S22 | canônico da regra com `kind=event` + contato | `kind=automation` (regra, evento, org) |

## 14. Gaps restantes

Classificação: BLOCKER (impede a selagem) · PRODUÇÃO (bloqueia produção, não o baseline arquitetural) · DÉBITO ·
INFO.

| ID          | Classe   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUTO-GAP-01 | PRODUÇÃO | **Barramento aberto na família `event`.** `emit_event` aceita de qualquer membro (viewer em diante) os 12 tipos de evento (exceto `message.received`). Uma linha forjada do tipo certo, sobre o sujeito certo, de uma regra ativa, passa na prova (a origem diz a verdade sobre a regra e o evento; o evento é que não prova a ocorrência). Já era assim na base para os 5 tipos ancoráveis e é assim para lead comum. G1 documenta. Fecha com decisão upstream: reservar os tipos de gatilho a produtores de servidor/trigger ou exigir papel de escrita no `emit_event`, ou estender o carimbo a toda a família e levar o emissor ao canônico. |
| AUTO-GAP-02 | DÉBITO   | Resíduo ADV-08/ADV-12: writer privilegiado SEM `service_origin` continua aceito, e `rule:*`/`source=automation` declarados pelo backend sem a origem `automation` continuam sendo honrados pelo anti-loop (declarado, não provado). Só o backend alcança. A recíproca ("marca de regra ⇒ origem `automation` obrigatória") quebraria invariantes congelados que representam o backend com `rule:<aleatório>` e não foi pedida. G2 documenta.                                                                                                                                                                                                     |
| AUTO-GAP-03 | PRODUÇÃO | Rollout: eventos de relógio emitidos ANTES da 0506 não têm carimbo; se drenados depois e apontarem lead Green, a raiz é recusada (fail-closed) e o cron não reemite a mesma âncora. Drenar a fila de relógio antes do deploy.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AUTO-GAP-04 | INFO     | A execução é o par (regra, evento) enquanto o evento está vivo; não há registro de run ANTES das ações (o `automation_rule_runs` é gravado depois). Redelivery pelo reaper reexecuta a regra: o Green não duplica (I1), o registro upstream ganha uma linha por passagem.                                                                                                                                                                                                                                                                                                                                                                        |
| AUTO-GAP-05 | INFO     | A vivacidade depende do `status` do `event_log`: uma operação que devolva um evento `done`/`dead` a `pending` (só `service_role`/dono) o torna executável de novo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AUTO-GAP-06 | DÉBITO   | Régua de gatilhos espelhada (`fn_automation_trigger_entity`/`_family` e o WHEN do carimbo) × TS. Gatilho novo sem espelho falha FECHADO em Green (`trigger_mismatch`) e a catraca K1/K2 fica vermelha.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AUTO-GAP-07 | INFO     | Regra desativada ou editada (sem `create_or_move_lead`) no meio da execução recusa a escrita Green (run `failed`, visível).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AUTO-GAP-08 | INFO     | `green.scheduler_trigger_emission` sem retenção própria (cascateia com o `event_log`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| herdados    | -        | LIFE-ADV-05 (escala), `GAP-SUPPRESSOR-V3`, EV-01B residual e os gaps do lifecycle: intocados.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 15. Verificação de selagem e readiness para GREEN-BASELINE

| Critério de saída                               | Evidência                                                                                                                                                                     | OK  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| censo completo de gatilhos                      | §1: 16 do código, produtores por família                                                                                                                                      | ✅  |
| modelo de origem documentado                    | §5 (kind `automation`, família derivada, 8 invariantes)                                                                                                                       | ✅  |
| event-driven com anchor confiável               | §6; X3/X4/X5/X12/X13; censo PASS                                                                                                                                              | ✅  |
| time-based/synthetic com raiz confiável própria | §7; carimbo do relógio; C-forjado e X16 FAIL ESPERADO; E1 pelo cron real                                                                                                      | ✅  |
| gatilhos legítimos Green deixam de falhar       | §12: 16/16 PASS + criação + 2 transferências                                                                                                                                  | ✅  |
| anti-loop continua correto                      | §8: A1/A2/A3, E1, N9                                                                                                                                                          | ✅  |
| cliente não consegue forjar automation origin   | A3, X22; sessão nunca transporta origem; carimbo inalcançável pela API                                                                                                        | ✅  |
| cross-tenant fechado                            | §9: X1/X4/X6/X21, X20 sem oracle                                                                                                                                              | ✅  |
| lead comum não regrediu                         | controles comuns (cron e forjado), E1 4c                                                                                                                                      | ✅  |
| lifecycle continua sealed                       | `green-lead-lifecycle`, `-v12`, `-v13` verdes no `test:db` inteiro; `lifecycle-real` L1-L3 verde; nenhum teste de lifecycle alterado; `fn_crm_lead_boundary` = 0505 + 1 linha | ✅  |
| typecheck verde                                 | `tsc` exit 0                                                                                                                                                                  | ✅  |
| regressão crítica = zero                        | §13: `test:db` 348/348; E2E 20/20; `produto`/`cercas` sem falha nova (diferencial contra a base)                                                                              | ✅  |

Gaps novos: AUTO-GAP-01 e -03 PRODUÇÃO; -02 e -06 DÉBITO; -04, -05, -07, -08 INFO. **Nenhum BLOCKER.**

Readiness para GREEN-BASELINE: LIFE-ADV-01 deixa de ser BLOCKER. Levar ao baseline: origem `automation` provada
pela fronteira; família derivada pelo banco; raiz de relógio com carimbo de emissor; anti-loop provado para escrita
Green por automação. Antes de produção: AUTO-GAP-01 (decisão sobre o barramento `emit_event`), AUTO-GAP-03 (rollout)
e LIFE-ADV-05 (escala, herdado).

## Veredito

Todos os critérios de saída foram provados com o mesmo teste nas duas versões (base: 11 de 16 gatilhos recusados,
`green_service_origin_unsupported`; spike: 16/16, mais criação e transferência, com origem provada pelo banco) e pelo
servidor Next real (build de produção, Node 22): o cron real emite, o tick real drena, a Opportunity Green se move com
`service_origin.kind=automation`, a forja de um viewer é recusada e o lead comum segue movendo. O anti-loop não piorou
e ficou mais forte para a escrita do motor (a marca de regra é provada quando a origem `automation` é declarada; o
resíduo sem origem é AUTO-GAP-02) e nada do lifecycle mudou além da linha da
chamada da prova.

**GREEN AUTOMATION ORIGIN = SEALED.** Não é PASS limpo porque ficam gaps classificados, nenhum BLOCKER:
AUTO-GAP-01 (barramento `emit_event` aberto na família `event`) e AUTO-GAP-03 (rollout dos eventos de relógio
pré-0506) como PRODUÇÃO; AUTO-GAP-02 e -06 como DÉBITO; os demais INFO.

Integridade: `spike/green-lead-lifecycle-v1.3` intacta em `b4ccb48f`; sem push, PR ou merge; `main` intocada;
`.next/` do build de produção removido; servidor Next parado; o stack local ficou com a
0506 aplicada e as fixtures dos testes (regras E2E desativadas no `afterAll`). Credenciais do stack lidas por script e
passadas só ao processo filho; nenhuma impressa nem gravada no repositório.

SPIKE-GREEN-AUTO-01: PASS-COM-GAPS
