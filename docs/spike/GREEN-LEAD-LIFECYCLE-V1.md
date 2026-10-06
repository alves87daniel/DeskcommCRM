# SPIKE-GREEN-01 - Lead Lifecycle: INSERT + DELETE + Tombstone

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhuma ADR. Relatório para auditoria independente.

| Item | Valor |
|---|---|
| Base | `spike/green-mutation-context-v3` @ `43494c930762def9fcde24f3433201be4f6111a3` (intacta) |
| Branch da spike | `spike/green-lead-lifecycle-v1` (local, sem push) |
| Fase 0 | `git status --short` vazio na v3; `HEAD` = SHA de referência |
| Commits | `c63a1a082` RED banco+processo → `9d60fc1af` RED E2E → `6bcb58654` migration 0503 → `645ec4f19` seams TS → `e518d86e6` teste antigo no contrato novo → relatório |
| Migration | `supabase/migrations/20261001120000_0503_spike_green_lead_lifecycle.sql` (+ apêndice espelho no `baseline.sql`, antes da varredura de anon; 0501 e 0502 intactas) |

Ordem TDD: todos os testes novos foram commitados e rodados contra a v3 ANTES de qualquer código de produção.

## 1. Censo INSERT (`crm_leads`)

Refeito do zero (não reaproveita o censo da v2). Busca por `.insert`/`.upsert` com tabela literal e variável,
helpers que recebem nome de tabela, SQL cru em TS, `insert into` em `baseline.sql` e migrations (inclusive
multilinha, `format()`/`execute`, `COPY`, `INSERT…SELECT`), RPCs, triggers e scripts. Comandos e contagens:
G1-G7, S1-S6, P1-P3, R1, C1-C6 (por exemplo `rg -U "from\(\s*['\"\`]crm_leads['\"\`]\s*\)\s*\.(insert|upsert)\("`
→ 40 sítios: 1 de produção, 8 em `scripts/`, 31 em `tests/`).

Há só **dois primitivos de escrita** em produção:

| Primitivo | Onde | Papel |
|---|---|---|
| A. `createLeadHandler` | `app/api/v1/leads/_handler.ts:506` (único `.insert` de `crm_leads` em produção) | o client que o chamador passar |
| B. `public.fn_nascer_lead_da_conversa` | `baseline.sql:37639` (vigente; insert em :37677), SECURITY INVOKER, `authenticated, service_role` | único chamador TS: `lib/leads/nascimento-do-lead.ts:376` |

Nenhum trigger, procedure, clone `INSERT…SELECT`, SQL dinâmico ou `pg` direto de produção cria lead
(`trg_emit_event_on_lead_change` só emitia `lead.created` e foi removido na `baseline.sql:6177`).
Os caminhos de feature que chegam em A ou B estão classificados na §3. Scripts de seed (9 sítios) e testes
(31 + 47) ficaram fora de produção e fora da classificação.

## 2. Censo DELETE (`crm_leads`)

| # | Caminho | Onde | Papel | Granularidade | Multi-request | Contexto Green (v3) |
|---|---|---|---|---|---|---|
| 1 | Zona de perigo | `app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts` → `lib/settings/apagar-dados-operacionais.ts` | `service_role` | organização inteira | **sim, 7 DELETE + storage**, sem transação | **não** |
| 2 | Exclusão em lote (e o "Excluir" do card) | `app/api/v1/leads/bulk/route.ts:482` | sessão (RLS) | até 50 ids | um DELETE (atômico) | sim (boundary + `user`) |
| 3 | Cascata de `organizations` | FK `crm_leads_organization_id_fkey` ON DELETE CASCADE (`baseline.sql:3621`) | platform admin pelo PostgREST (`orgs_write_platform_admin`), `service_role` ou SQL | organização inteira | um statement | a fronteira pula (org indo embora) |
| 4 | PostgREST direto com JWT de usuário | policy `crm_leads_delete` | sessão (RLS) | qualquer filtro | um request | `user` (lápide) |
| 5 | `scripts/seed-e2e-zona-de-perigo.ts:162` | script de dev | `service_role` cru | org | sim | não |
| 6 | `scripts/e2e-elegibilidade-helpers.ts:305` | script de dev | `pg` direto (`direct`) | por contato | sim | não |

Não apagam leads (conferidos): `leads/[id]` (só PATCH; não existe DELETE de lead único), DELETE de etapa (arquiva e
MOVE os leads), DELETE de funil (`RESTRICT` + `podeExcluirDeVez`), merge de contatos (repointa), LGPD
(anonimiza: UPDATE), MCP (só rollback de proposta), crons de retenção, super-admin (suspende/reativa).
**Na v3, nenhuma função SQL faz `delete from crm_leads`** (a 0503 cria a primeira, a RPC da zona de perigo, §5).
Censo por `rg` de `.delete(` com tabela literal e variável (28 sítios: 1 de produção, 27 em testes), `delete from` em
SQL (15 linhas: 14 em testes, 1 script), FKs pelo `ALTER TABLE … FOREIGN KEY` do baseline, 37 rotas `DELETE` (nenhuma
sob `leads/`) e as 211 chamadas `.rpc(`. FKs de `crm_leads`: `organization_id` CASCADE (a única que
apaga lead), `pipeline_id`/`stage_id` RESTRICT, `contact_id`/`owner_agent_id`/`retomado_de_lead_id`/
`lost_from_stage_id` SET NULL. Apagar contato com histórico (`fn_apagar_contato_com_historico`, 0488) **não apaga** o
lead: zera `contact_id` (§10, gap medido).

## 3. EV-01B - nascimento Green por caminho privilegiado

Funil Green = funil com linha em `green.product_pipeline_binding`. "Green possível?" = o destino do lead pode ser um
funil gerenciado por configuração da organização.

| # | Caminho | Caller | Contexto Green na v3 | Green possível? | Resultado na v3 | Falha visível na v3? | Lifecycle |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/v1/leads` (manual) | sessão | `user` (banco deriva) | sim (body) | aceito, sem proveniência | n/a | aceito + proveniência `actor=auth.uid()` |
| 2 | Retomada (rota) | sessão | `user` | sim (funil do lead de origem) | aceito, sem proveniência | n/a | idem |
| 3 | Retomada MCP / agente | admin | MCP/`agent_runtime` (v2) | sim | aceito | n/a | aceito + proveniência |
| 4 | Clone | sessão + boundary | `user` | sim | aceito | n/a | idem |
| 5 | Import CSV | sessão | `user` | sim (form) | aceito | n/a (erros por linha no resumo) | idem |
| 6 | **webhook-in** `webhooks/in/[token]` | admin | **nenhum** | sim (`webhook_sources.default_pipeline_id`) | **42501**: 500, contato já criado fica órfão, reenvio repete | parcial: 500 + captação `recusado/erro_ao_criar_lead` (com o contato), mas o contato segue sem lead e cada reenvio repete | contexto declarado (ator = a fonte); aceito + proveniência; contato não fica órfão |
| 7 | Automação `create_or_move_lead` (criar) | admin (dispatcher) | motor (`automation`, `rule:<id>`, `service_origin` evento) | sim (regra) | aceito para gatilhos ancoráveis; `green_service_origin_unsupported` para `message.failed`, `contact.birthday`, `appointment.*` | sim: `failed` em `actions_result` | **inalterado** (gap, §10) |
| 8 | Automação transferência (clone) | admin | idem | sim | idem | sim | inalterado |
| 9 | MCP `crm_create_lead` | admin | `mcp` (ator do token) | sim | aceito | n/a | aceito + proveniência |
| 10 | Agente `crm_create_lead` | admin/engine | `agent_runtime` (+ `continuation` em job) | sim, se o funil está no escopo | aceito; `service_boundary_stale` se a fronteira mudou | sim (erro ao modelo + audit) | inalterado |
| 11 | **Prospecção** `activateCampaign` | admin | **nenhum** | sim (config da campanha) | **42501**: contato criado, candidato atualizado, 500 **genérico** (causa escondida) | parcial (500 sem causa) | contexto declarado (ator = a campanha); aceito + proveniência |
| 12 | **Canal**: WAHA, Meta, Zernio, `webhook-replay` (`pos-entrada` → `garantirLeadDaConversa` → B) | admin (RPC invoker) | **nenhum** | sim (funil padrão, de clientes ou da campanha) | **42501** → `{criado:false, motivo:"erro"}`; conversa, mensagem e demanda ficam sem lead; cada nova mensagem repete | **NÃO**: `logger.info("lead nao criado")` com `motivo`, sem o detalhe | contexto declarado (ator da timeline); aceito + proveniência; recusa residual vira `logger.error` com o detalhe |
| 13 | **Voice-agent** (`workers/voice-agent/index.ts:129` → B) | admin | **nenhum** | sim (padrão/clientes) | **42501** → `console.info` | **NÃO** | mesmo seam do #12; recusa residual vira `console.error` |
| 14 | PostgREST direto (`POST /rest/v1/crm_leads`) | sessão | `user` | sim | aceito | n/a | aceito + proveniência |

Caminhos que falhavam **em silêncio**: #12 e #13 (e #11 escondia a causa). Os três são os que criam o lead pelo
client de serviço sem declarar contexto.

### Contrato de nascimento adotado na spike

1. **Contexto declarado no ponto de entrada**, como raiz de sistema (`withGreenSystemRoot`), com o MESMO ator que o
   código já declara para timeline/audit: canal `webhook_source/canal-inbound` + `source=canal.ingest`
   (+ `correlation_id` = conversa); webhook-in `webhook_source/<fonte>` + `webhook.in` + `request_id`; prospecção
   `webhook_source/<campanha>` + `prospecting` (o `rule:<campanha>` do audit **não** entra: `rule:*` confiável é o
   marcador de causa de automação do anti-loop). Funil comum: o banco ignora o header.
2. **Proveniência gravada na transação do INSERT**: `green.lead_birth_provenance` (lead, org, funil, etapa, `caller`,
   `trusted`, `advisory`, `service_origin`). Sessão humana: `trusted = {caller:user, actor:auth.uid(), source:user_session}`
   e o header vai para `advisory`. Writer privilegiado sem contexto continua recusado (`42501`) e não deixa nada.
   **Não é evento**: um `lead.created` canônico seria gêmeo do `lead.created` que o código já emite depois do insert
   (consumido por automação e follow-up) e dispararia regras em dobro; resolver gêmeo é o supressor, fora de escopo.
3. **Recusa residual é erro**, com o motivo do banco (`pos-entrada`, voice-agent). A ingestão segue (a mensagem
   nunca é descartada) e a próxima interação tenta de novo.

## 4. Zona de perigo (L2)

Rotina (v3): sete `DELETE … where organization_id = <org da sessão>` pelo client de serviço, **cada um uma request
PostgREST** (`RAIZES_DO_APAGAMENTO`: `messages`, `conversations`, `calendar_appointments`, `orders`, `crm_proposals`,
`crm_leads`, `contacts`), depois a limpeza do bucket `propostas`, que só roda se os sete passarem. Não há contexto
Green: nem boundary, nem declaração.

Reproduzido pelo **PostgREST real** (stack local na v3, Node 22.23.3; `tests/green-e2e/lifecycle-real.e2e.ts`), org
com 1 mensagem, 1 conversa, 1 lead Green, 1 lead comum, 1 contato:

```text
antes      messages 1  conversations 1  lead_green 1  lead_comum 1  contacts 1  lápides 0
1ª exec.   r1 = db_error: green_mutation_context_required
depois     messages 0  conversations 0  lead_green 1  lead_comum 1  contacts 1  lápides 0
2ª exec.   r2 = db_error: green_mutation_context_required
depois     messages 0  conversations 0  lead_green 1  lead_comum 1  contacts 1  lápides 0
```

| Pergunta | Resposta medida |
|---|---|
| O que é apagado antes | passos 1-5, cada um já commitado: mensagens; conversas e o que cascateia delas (`agent_cases`, `conversation_notes`, `conversation_assignment_events`, `demanda_conversas`); agenda; pedidos; propostas |
| Onde falha | passo 6, `DELETE crm_leads`: a fronteira recusa a linha Green (`42501 green_mutation_context_required`) e o statement inteiro desfaz — **o lead comum também fica** |
| O que permanece | todos os leads (Green e comuns), todos os contatos; os PDFs de proposta ficam no bucket SEM linha que aponte para eles (o laço do storage só roda no sucesso) |
| Retry converge? | **não**: os passos 1-5 apagam 0, o passo 6 recusa igual, para sempre (estrutural, não transitório) |
| Perda irreversível? | **sim**: mensagens, conversas e cascatas, agenda, pedidos e propostas sumiram, e a operação que o admin pediu nunca termina; a auditoria registra `falhou_em: crm_leads` com as contagens parciais |
| Sem lead Green? | a mesma classe de defeito: qualquer falha no meio (provado com uma FK `RESTRICT` nova para `contacts`) deixa os passos anteriores apagados — **defeito do upstream**, que o Green só torna permanente |

Pelo `test:db` (dublê de PostgREST com papel simulado, §7) os mesmos quatro casos dão o mesmo retrato.

## 5. Atomicidade

| Opção | Resolve? | Por quê |
|---|---|---|
| Compensação | não | mensagens apagadas não voltam; "compensar" seria copiar o grafo antes (backup), não desfazer |
| Mudar a ordem (`crm_leads` primeiro) | parcial | tira a recusa Green da frente dos passos irreversíveis, mas qualquer outra falha no meio (FK nova, timeout, rede entre requests) continua deixando estado parcial — o caso não-Green da §4 |
| Pré-flight (contar leads Green, exigir contexto antes) | parcial | só prevê a falha que conhece; janela entre conferir e apagar; continua não atômico. Serve como UX ("N Opportunities Green deixarão lápide"), não como garantia |
| **RPC / transação única** | **sim** | qualquer recusa desfaz tudo; repetir converge (a 2ª execução apaga 0 e termina). É o que o upstream fez para a MESMA classe: `fn_apagar_contato_com_historico` (0488, #752, "as três saem numa transação só") |

Adotado: `public.fn_apagar_dados_operacionais_da_org(p_org uuid) returns jsonb`, **SECURITY INVOKER**, `search_path=''`,
EXECUTE só para `service_role` (revogada de `public`, `anon`, `authenticated`), mesma ordem, o filtro de organização em
cada DELETE. Não é a porta que o comentário original da lib recusou (definer em `public` cujo único seletor é a org):
é invoker e só alcançável por quem já podia cada DELETE; o seletor continua vindo da sessão, na action. A action
declara o contexto (`settings.danger_zone`, humano rebaixado a `system/<userId>` por `greenActorFromActor`, `request_id`
do middleware) e o header chega à fronteira na **própria request da RPC** (medido pelo PostgREST real). Cada
Opportunity Green deixa lápide com esse ator. O storage segue fora da transação (não é transacional): roda depois do
commit; se falhar, repetir converge (a RPC apaga 0 e o laço continua), e nunca há linha apontando para arquivo apagado.

Outras rotinas multi-request achadas nos censos são de INSERT (webhook-in, prospecção, ingestão de canal: contato →
conversa/mensagem → lead). Não viraram RPC: a mensagem precisa entrar mesmo sem lead, e redesenhar a ingestão está
fora do escopo. Elas convergem por retry porque o upsert de contato e o nascimento são idempotentes — **desde que a
recusa estrutural (falta de contexto) não exista**, que é o que os seams resolvem.

## 6. Tombstone `lead.deleted`

Reproduzido (L3): DELETE humano de lead Green → `lead.deleted` canônico `pending`, `consumed_by={}`, `attempts=0`.
O drain (`lib/event-log/drain.ts:259-261`) só reivindica `status='pending'` **e** `event_type in (tipos com handler)`;
nenhum handler consome `lead.deleted` (`register-handlers.ts`), a automação recusa o tipo
(`lib/schemas/webhooks.test.ts:75`). No stack local havia **4 lápides `pending`** deixadas pela E2E da v3 — o
estoque real.

### Derivação a partir do desenho do `event_log`

- `event_log` é o barramento do CRM. O status é a **pertença à fila**: `pending` = à espera de consumidor
  (`event_log_pending_idx`), `done`/`dead` = fora dela.
- A migration 0239 (issue #753) fixou a regra: **"tipo de evento que ninguém consome não é fila — é registro, e a
  linha nasce `done`"**, por uma lista no BANCO (`fn_event_log_e_registro` + `trg_event_log_marca_registro` + backfill),
  porque é o banco que escreve o status. Análogos diretos já estão nela: `contact.deleted`, `lead.bulk_deleted`,
  `contact.anonymized`.
- `tests/unit/evento-comando-tem-consumidor.test.ts` separa **comando** (`*_requested`, tem de ter consumidor) de
  **fato**; `tests/unit/evento-de-fato-nao-fica-pendente.test.ts` cobra que todo fato emitido sem consumidor esteja na
  lista — e estava **cego** para a lápide, porque a v3 a emitia com o tipo numa variável (`v_tipo`).
- Anti-pattern 3 do `CLAUDE.md`: "Evento sem consumer".

| Opção | Veredito |
|---|---|
| A. comando a consumir | não: não há o que executar — o DELETE já aconteceu na mesma transação; inventar consumidor é o anti-pattern 3 |
| **B. evento-fato já concluído** | **sim**: tempo passado, emitido depois do fato, write-once (guard da v3), sem consumidor → registro, pelo mecanismo da 0239 |
| C. tombstone fora da fila em estrutura própria | não: B já tira a lápide da fila **pela definição da própria fila** (o status); C duplicaria o fato canônico que já está em `event_log` + livro-razão (DIRC "Duplicar" sem fonte de verdade), exigiria imutabilidade, RLS e retenção próprias e ficaria fora das cercas de evento |

### As sete respostas

1. **Entra no drain?** Não. Sem handler, `pending` é permanência indefinida.
2. **Quem consome?** Ninguém no Deskcomm. Leitores: auditoria e histórico da entidade (`event_log_entity_idx`); um
   consumidor futuro (ex.: sincronização do Conector Green) lê **por consulta** (`event_type='lead.deleted' and
   metadata ? 'green_canonical'`, cursor por `created_at`), não pela fila.
3. **É registro-fato?** Sim.
4. **Status inicial?** `done`, `consumed_by='{}'`, `attempts=0` (o trigger BEFORE INSERT do upstream fecha a linha).
5. **Pode ser reprocessado?** Não pela fila: o drain nunca a seleciona, e a cerca proíbe tipo com consumidor na lista
   de registro. O conteúdo é imutável (guard da v3); só os campos do consumer mudam. Se um consumidor nascer, o tipo
   sai da lista, as **novas** lápides passam a nascer `pending` e as históricas **ficam `done`**: reprocessar história
   vira decisão explícita (job de backfill por consulta), nunca efeito colateral de registrar um handler. Com as
   lápides `pending` da v3, registrar um handler reprocessaria toda exclusão já feita.
6. **Backlog × histórico?** Pelo status: `pending` = backlog real (só tipos com handler); lápide = `done` com
   `consumed_by` vazio. Invariante: `status='pending' and event_type='lead.deleted'` é vazio. O estoque da v3 é fechado
   pelo backfill da 0503 (medido no stack: 4 `pending` → 4 `done`).
7. **`event_log` ou estrutura própria?** `event_log`, com o livro-razão `green.stage_event_ledger` (`kind='deleted'`)
   como prova de produtor — sem tabela de lápide. Limite aceito: lápides morrem com a organização (FK CASCADE de
   `event_log`); para isso há o rastro de nível de organização (§10).

Implementação: `lead.deleted` entra em `fn_event_log_e_registro` (mesma lista da 0417 + o tipo), a fronteira emite
cada tipo com **literal** (a cerca do upstream passou a enxergar a lápide e fica verde), backfill do estoque. Drift
controlado: se o upstream redefinir a lista sem `lead.deleted`, a cerca acusa o órfão.

## 7. RED - os testes novos contra a v3

Nenhum teste existente foi alterado para fabricar RED. Harness de banco: o código REAL (`garantirLeadDaConversa`, a
rota `webhooks/in/[token]`, a server action da zona de perigo) roda contra o banco real com triggers reais por
`tests/invariants/green-postgrest-shim.ts`, que faz cada chamada como o PostgREST (`set local role`, claims,
`request.headers`) e tira o header Green do escopo ALS **no momento da chamada**, como o `fetchDoServidor`. O teste
não injeta contexto: quem declara é o seam. O que só existe no lifecycle é lido por `to_regclass`/`to_jsonb`, para a
v3 falhar na asserção e não num "does not exist".

### 7.1 Banco - `tests/invariants/green-lead-lifecycle.test.ts` (`test:db`, pg15 efêmero)

v3: **16 falham, 7 passam** (os 7 são controles).

| Caso | v3 observado |
|---|---|
| L1 WAHA/Meta/Zernio vira lead Green com proveniência | `{criado:false, motivo:"erro"}` (42501) |
| L1 voice-agent (mesma chamada do worker) | `{criado:false, motivo:"erro"}` |
| L1 idempotência do nascimento (2 mensagens → 1 lead, 1 registro) | 1ª mensagem já não cria |
| L1 webhook-in vira lead Green | `500` |
| L1 contato/conversa parcialmente criado (2 envios) | 1 contato órfão |
| L1 com contexto: proveniência na mesma transação | nenhum registro |
| L1 humano: `actor=auth.uid()`, header em advisory | nenhum registro |
| L2 action termina, lápide com ator da sessão, vizinho intacto | `db_error` |
| L2 retry converge | `db_error` de novo |
| L2 DELETE de serviço sem contexto: nada irreversível | `messages` 1 → 0 antes da recusa |
| L2 falha não-Green no meio não deixa estado parcial | `messages` 1 → 0 |
| L3 lápide nasce `done` | `pending` |
| L3 `fn_event_log_e_registro('lead.deleted')` | `false` |
| L3 backlog × histórico: nenhuma lápide `pending` | 3 `pending` |
| Cascata (service_role): nenhum resíduo Green | 1 linha órfã no livro-razão |
| Cascata (platform admin pelo PostgREST): rastro auditável sem PII | 0 linhas |
| controles: sem contexto `42501`; fora do Green; API não escreve no registro; papel de API não alcança a RPC; lápide write-once e 1:1; lote misto tudo-ou-nada; DIAGNÓSTICO do contato | passam (nas duas versões) |

### 7.2 Processo - `lib/green/lifecycle-seams.test.ts`

v3: **2 falham, 1 passa**. `pos-entrada`: a recusa não gera `logger.error` (`expected [] to have a length of 1`).
Prospecção: `currentGreenMutationContext()` no `createLeadHandler` é `undefined`. Controle (`ja_existe` é informativo)
passa.

### 7.3 E2E PostgREST real - `tests/green-e2e/lifecycle-real.e2e.ts`

Stack local na v3 (0502), Node 22.23.3, `createAdminClient` real → `fetchDoServidor` → Kong 2.8.1 → PostgREST v16.2 →
Postgres 17.6: **4 falham** - zona de perigo pela action (retrato da §4), lib sem contexto (`messages`/`conversations`
1 → 0), canal (`criado:false`), estoque (`[{status:'pending', n:4}]`).

## 8. GREEN - os mesmos testes no lifecycle

| Suíte | v3 | lifecycle |
|---|---|---|
| `green-lead-lifecycle.test.ts` (banco) | 16 falhas / 23 | **23/23** (baseline install + update com `ON_ERROR_STOP`) |
| `lifecycle-seams.test.ts` (processo) | 2 falhas / 3 | **3/3** |
| `lifecycle-real.e2e.ts` (PostgREST real, Node 22) | 4 falhas / 4 | **4/4** (0503 aplicada no stack local) |

| Cenário | v3 | lifecycle | Teste |
|---|---|---|---|
| nascimento Green pelo canal/voz | recusado, `info` sem motivo | nasce com proveniência | L1; E2E canal |
| webhook-in em funil Green | 500 + contato órfão, não converge | 200, lead + proveniência, converge | L1 |
| prospecção | `createLeadHandler` sem contexto | com contexto da campanha, sem `rule:*` | processo |
| proveniência do nascimento | descartada | `green.lead_birth_provenance` (trusted × advisory) | L1 |
| zona de perigo com lead Green | perda irreversível, não converge | termina, converge, lápide com ator | L2; E2E |
| zona de perigo sem contexto / falha no meio | estado parcial | nada apagado | L2; E2E |
| lápide | `pending` para sempre | `done` (registro), estoque fechado | L3; E2E |
| cascata de organização | livro-razão órfão, nenhum rastro | sem resíduo; `green.binding_removed` em `api_audit_log` | cascata |

## 9. Regressão

Ambiente: Windows 11, Docker Desktop; `test:db` em `pgvector:pg15` efêmero; stack local `deskcomm-green-spike`
(Kong 2.8.1, PostgREST v16.2, GoTrue v2.196.0, Postgres 17.6); suítes de banco uma de cada vez.

| Suíte | Resultado no lifecycle | Base de comparação | Classificação |
|---|---|---|---|
| `tsc --noEmit -p tsconfig.typecheck.json` | exit 0 | - | - |
| `eslint` nos arquivos tocados | 0 erros, 0 avisos | - | - |
| Invariantes Green v1 + v2 + v3 + `webhooks-inbound` | 117 passed, 1 skipped (4 arquivos) | v3: 81/81 Green | 0 alterados |
| `pnpm test:db` inteira | **345/345 arquivos, 2855 passed, 1 expected fail, 1 skipped** (`test:db verde`, 1492 s) | v3: 344/344, 2832 passed | zero falha; +1 arquivo, +23 casos |
| Unitários focados | 1ª corrida (código novo, teste antigo): `zona-de-perigo-apaga-so-a-propria-org` 13 falhas — contrato de sete requests; depois da §9.1: zona de perigo + automação 37/37; cercas-chave (suporte, evento-fato, evento-comando, varredura de anon, mapas de arquitetura) **220/220** | - | 1 arquivo alterado por contrato (§9.1) |
| `vitest --project cercas` inteira | 1ª corrida (com carga): 12 arquivos / 40 casos; os 12 sozinhos: **9 arquivos / 37 casos** | os mesmos 9 arquivos num worktree destacado da v3: **9 / 37 idênticos** | pré-existentes (`bash` ENOENT no processo filho, git/gh de release, runner de E2E, bancada de extensões neste Windows); os 3 a mais da 1ª corrida eram timeout de 15 s sob carga e passam sozinhos. **Novas: 0**. A cerca de evento-fato e a de suporte (rota alterada) passam |
| `vitest --project produto` inteira (6 workers) | 1400 arquivos passam; **7 arquivos / 11 casos falham** (14689 passed, 1 expected fail) | os mesmos 7 nomes e a mesma contagem que a v3 registrou (`lgpd-pdf-*` x4, `confianca-do-handoff-nao-e-similaridade`, `followups-de-demonstracao-sao-possiveis`, `rascunho-superado-nao-e-regravado`) | pré-existentes: URL de fontes do pdfjs sem barra final e separador `\` do Windows; nenhum dos 7 importa módulo alterado. **Novas: 0** |
| E2E v2 `postgrest-real.e2e.ts` (stack com 0503, Node 22) | 6 passed, 1 skipped | v3: 6 + 1 | - |
| E2E v3 `next-real-v3.e2e.ts` (servidor Next real, `next dev`, Node 22) | **9/9** | v3: 9/9 | - |

### 9.1 Teste antigo alterado (mudança de contrato)

| Teste | Afirmava | Por que ficou inválido | Novo contrato |
|---|---|---|---|
| `tests/unit/zona-de-perigo-apaga-so-a-propria-org.test.ts` (commit próprio `e518d86e6`, marcado `CONTRATO lifecycle`) | sete chamadas `.from(t).delete().eq()`; "parada no meio audita o que JÁ foi apagado" (`counts.messages=7`, `falhou_em=crm_leads`) | a parada no meio era exatamente a perda irreversível da §4 | o dublê ganhou `rpc()` que executa o **corpo** da função SQL lido da migration (filtro de org, ordem RESTRICT e tabelas preservadas continuam medidos sobre o que roda); a parada no meio audita `counts` 0 e `falhou_em=transacao` |

Nenhum invariante congelado (`tests/invariants/**`) foi modificado; só arquivos novos.

Integridade ao final: árvore limpa na branch do lifecycle; v1 (`69bf48cc4`), v2 (`49695f9f2`) e v3 (`43494c930`, = `origin`)
intactas; nenhum push, PR ou merge; `.next/` e o worktree destacado da v3 removidos (junction de `node_modules` desfeita
antes). O stack local `deskcomm-green-spike` ficou com a 0503 aplicada e com as fixtures dos testes (como a E2E da v3
já deixava). As chaves do stack foram lidas por script e passadas só ao processo filho; nenhuma foi impressa nem
gravada em arquivo.

## 10. Riscos restantes

### Resolvidos nesta spike

L1 (canal, voz, webhook-in, prospecção, falha silenciosa, contato órfão, proveniência), L2 (perda irreversível,
retry, DELETE de serviço sem contexto, falha não-Green no meio), L3 (lápide como registro, estoque, cerca cega),
resíduo e rastro da cascata de organização.

### Gaps (não corrigidos)

1. **Automação em funil Green com gatilho não ancorável** (`message.failed`, `contact.birthday`, `appointment.*`) —
   derivado do código, NÃO medido por teste: o motor (`lib/automation/engine.ts:244`) declara `service_origin.kind=event`
   com o evento disparador, e `green.fn_assert_event_origin_contact` só ancora `lead.created`, `lead.stage_changed`,
   `lead.tag_added`, `contact.tag_added`, `appointment.outcome_confirmed` e `message.received`; o resto recusa com
   `green_service_origin_unsupported`. Visível (`failed` em `actions_result`), não silencioso. Família ADV-08 (régua de
   `service_origin.event`), fora de escopo.
2. **Contato apagado com histórico** (`fn_apagar_contato_com_historico`): a Opportunity Green perde o contato (SET NULL)
   sem nenhum registro Green — a fronteira só olha etapa/funil/organização. Medido no caso DIAGNÓSTICO (igual na v3 e
   no lifecycle).
3. **Visibilidade da recusa é de log** (`logger.error`/`console.error`), não aviso na Central. Para quem opera o
   produto, a falha ainda não aparece na tela.
4. **Escala da zona de perigo**: uma transação para a org inteira (N lápides + N linhas de livro-razão, locks, WAL,
   `statement_timeout` do PostgREST). Falhar por tamanho é seguro (nada apagado), mas a feature ficaria inutilizável em
   organização grande; produção pediria lote com fronteira explícita.
5. **Organização apagada**: lápide por lead é impossível (`event_log` cascateia); o rastro é UMA linha por funil
   gerenciado (`green.binding_removed`), sem contagem de leads (no momento do trigger do binding a cascata já levou os
   leads). Exclusão de tenant pelo PostgREST de platform admin continua sem audit do upstream.
6. **Ator privilegiado declarado, não provado** (ADV-12, inalterado): `system/<userId>` da zona de perigo é declarado
   pelo backend; a autorização real é a da action (admin/platform admin, MFA, nome conferido no banco).
7. **Supressor** (inalterado, fora de escopo) — e é por ele que o nascimento não é evento canônico.
8. **Partial state não-Green do upstream** no webhook-in e na prospecção (contato criado e lead recusado por outra
   causa, ex. validação) continua existindo; só a recusa estrutural Green foi removida. A prospecção ainda devolve 500
   genérico para outras causas.
9. **Cobertura**: webhook-in e prospecção foram medidos pelo dublê de PostgREST e por unidade, não pelo PostgREST
   real; a troca de `console.info` por `console.error` no voice-agent não tem teste automatizado (o nascimento da
   ligação tem, pelo seam compartilhado).
10. **Registro de nascimento sem retenção** (uma linha por nascimento Green; sobrevive à exclusão do lead como
    histórico, morre com a organização).
11. **Chave do registro de nascimento = `lead_id`**: reinserir num funil Green um lead com um id JÁ usado (ex.: restauração
    de backup com os ids originais) esbarra na PK e o INSERT inteiro falha (fechado, não silencioso). Nenhum caminho do
    repositório reinsere id; produção pediria chave própria.

### Introduzidos pelo lifecycle

1. `fn_event_log_e_registro` (função do upstream) passa a ter cópia no fork. Drift vigiado pela cerca de evento-fato.
2. Nova função em `public` (`fn_apagar_dados_operacionais_da_org`) e 8 arquivos upstream a mais no fork (§11).
3. Seams novos são regra a lembrar: todo caminho NOVO que crie lead pelo client de serviço num funil que possa ser
   Green precisa declarar contexto; sem isso falha fechado (agora com erro, não em silêncio, nos seams cobertos).

## 11. Custo arquitetural

| Métrica (contra o upstream `e8e2912`) | v3 | lifecycle |
|---|---|---|
| Arquivos upstream modificados | 20 | **28** (+7 de produção, +1 teste) |
| Arquivos novos (sem o relatório da própria versão) | 17 | 23 (20 de código/teste + 3 relatórios anteriores) |
| TS de produção alterado (delta sobre a v3) | - | +161 / -57 em 7 arquivos; os "-" são quase todos re-indentação de chamada embrulhada |
| Writers de etapa alterados | 0 | 0 |
| Triggers em tabela core | 3 | 3 (o novo é em tabela `green`) |
| Tabelas `green` | 2 | 3 (+ `lead_birth_provenance`) |
| Funções `public` novas / redefinidas | 0 / 0 | 1 / 1 (`fn_event_log_e_registro`) |
| Migrations | 2 | 3 (0501 e 0502 intactas) |
| Apêndice do `baseline.sql` | 2 blocos | 3 blocos (+375 linhas) |
| Declarações de contexto novas | - | 4 (canal, webhook-in, prospecção, zona de perigo) |

O custo dominante de rebase continua sendo o apêndice do `baseline.sql`. O lifecycle não tocou nenhum writer de
etapa e não criou hook novo em tabela core; o que cresceu foi declaração de contexto nos pontos de entrada e uma RPC
de atomicidade.

## 12. Recomendação para baseline

Levar para o baseline Green (quando houver ADR):

1. **Lápide = registro-fato** pelo mecanismo do upstream (lista do banco + emissão literal + backfill). Não criar
   estrutura própria.
2. **Nascimento Green com proveniência gravada** na transação do INSERT, fora do `event_log` enquanto o problema de
   gêmeo não for resolvido; reavaliar `lead.created` canônico junto com o supressor.
3. **Contexto declarado no ponto de entrada** de todo nascimento privilegiado, com o ator que o código já usa para
   timeline/audit, como raiz de sistema.
4. **Apagamento multi-entidade que alcança Opportunity Green = uma transação** (invoker, só `service_role`) com
   contexto declarado por quem autoriza. A atomicidade da zona de perigo é defeito do upstream independente do Green
   (provado sem lead Green) e é candidata a correção upstream.
5. Livro-razão com FK de tenant; remoção de funil gerenciado com rastro auditável.

Antes do baseline: decidir a visibilidade de produto da recusa (Central), a régua de origem da automação (ADV-08), o
lote da zona de perigo para organização grande e o tratamento Green do contato apagado com histórico. Ainda não é
hora de ADR: próximo passo sugerido é auditoria independente desta spike.

### Veredito do implementador

**PASS-COM-GAPS.** Os três problemas foram reproduzidos primeiro (banco, processo e PostgREST real) e cada RED
obrigatório tem prova negativa na v3 e positiva no lifecycle com o MESMO teste:

| Problema | Neutralizado? | Evidência decisiva |
|---|---|---|
| L1 EV-01B (canal, voz, webhook-in, prospecção, silêncio, contato órfão) | sim, nos caminhos sem contexto; automação com gatilho não ancorável fica como gap | L1 (16→23/23), processo (2→3/3), E2E canal |
| L2 zona de perigo (perda irreversível, retry, sem contexto, falha no meio) | sim | retrato antes/depois pelo PostgREST real; L2 no banco |
| L3 `lead.deleted` preso em `pending` | sim, derivado do desenho do `event_log` (opção B) | L3; estoque do stack 4 `pending` → `done`; cerca de evento-fato passa a enxergar o tipo |
| Cascata de organização | sim para resíduo e rastro; lápide por lead é impossível por desenho | casos de cascata |

Não é PASS porque ficam gaps delimitados (§10): régua de origem da automação (derivado do código), contato apagado
com histórico (medido), visibilidade só em log, escala da transação da zona de perigo, ator privilegiado declarado e
um teste antigo alterado por mudança de contrato (§9.1), que a auditoria deve confirmar. Regressão: zero falha nova em
`test:db`, `cercas` e `produto`; E2E v2 e v3 verdes no stack migrado.

SPIKE-GREEN-01: PASS-COM-GAPS
