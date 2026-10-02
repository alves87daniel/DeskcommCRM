# SPIKE-GREEN-01.2 - Lead Lifecycle: correções da auditoria

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhum push.

| Item                    | Valor                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base congelada          | `spike/green-lead-lifecycle-v1` @ `3ac8fa7471af1982d634b99aa7862810dd014a9a` (intacta; v3 `43494c930` também)                                                                                 |
| Branch da spike         | `spike/green-lead-lifecycle-v1.2` (local)                                                                                                                                                     |
| Auditoria de referência | AUDIT-GREEN-01.1: PASS COM RESSALVAS                                                                                                                                                          |
| Migration               | `supabase/migrations/20261002090000_0504_spike_green_lifecycle_v12.sql` (+ apêndice espelho no `baseline.sql`, antes da VARREDURA anon, + linha no `MANIFEST.md`); 0501, 0502 e 0503 intactas |
| Escopo                  | LIFE-ADV-02, LIFE-ADV-03, LIFE-ADV-04; correção do relatório sobre LIFE-ADV-01                                                                                                                |

## 1. Objeto

Corrigir os defeitos que a SPIKE-GREEN-01 introduziu e a auditoria confirmou, sob a decisão arquitetural nova:

> **O UUID interno de `crm_leads` NÃO é reciclável.** Um UUID identifica uma única existência lógica de lead. DELETE não
> o libera. Novo lead lógico = novo UUID. O histórico permanece em tombstone, `event_log`, livro-razão e proveniência.

## 2. Delta

| Arquivo                                                                                                            | Mudança                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0504`                                                                                                             | `green.lead_identity` (registro mínimo) + `fn_claim_lead_identity`; `fn_mutation_context` (chave `client_request_id`), `fn_mutation_envelope` (advisory) e `fn_crm_lead_boundary` redefinidas por `create or replace` (cópias das vigentes com só o delta); backfill |
| `lib/green/mutation-context.ts`                                                                                    | chave `client_request_id`; `novoRequestIdDoServidor`, `requestIdDoCliente`, `identificadoresDaRequisicao`                                                                                                                                                            |
| `lib/auth/require-role.ts`, `lib/api/auth-dual.ts`, `app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts` | o id confiável nasce no servidor; o header do cliente vira `client_request_id`                                                                                                                                                                                       |
| testes novos                                                                                                       | `lib/green/request-id-v12.test.ts` (31), `tests/invariants/green-lifecycle-v12.test.ts` (28)                                                                                                                                                                         |
| testes antigos tocados                                                                                             | `lib/green/seams-v2.test.ts` (3 expectativas), `tests/green-e2e/postgrest-real.e2e.ts` (S18, S19), `tests/green-e2e/next-real-v3.e2e.ts` (helper `requestDe` e N1): ver §13                                                                                          |

Commits locais: `cf9bfc31a` (RED) → `15d5b32e8` (0504 + TS) → commits de contrato dos testes e do relatório.

## 3. RED (antes de qualquer código de produção)

Os testes novos foram commitados e rodados contra a v1 (`3ac8fa7`) antes da correção.

| Achado               | Prova na v1                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1 / LIFE-ADV-02** | zona de perigo com `x-request-id: rule:forjado-pelo-humano`: `trusted.request_id = "rule:forjado-pelo-humano"`, e `causadoPorRegra(metadata) = true` (a lápide humana lida como causada por regra). Também: sem header não há `request_id` confiável; header de 5000 caracteres é descartado em silêncio. Nos gates: 29 de 31 casos de processo falham |
| **C2 / LIFE-ADV-03** | INSERT Green com UUID histórico: `23505 lead_birth_provenance_pkey` (acidental). Lead comum com o UUID histórico movido para Green: **ACEITO**, herda a proveniência. Mesma org e outra org: ACEITO. Depois da cascata da organização: ACEITO (a proveniência cascateou junto)                                                                         |
| **C3 / LIFE-ADV-04** | ver §10: os testes antigos deixam passar mutantes de DELETE cross-org                                                                                                                                                                                                                                                                                  |

Banco: 17 falham, 10 passam (controles, Casos D/E e a cerca cross-org, que a v1 cumpre).

## 4. Trusted × advisory (LIFE-ADV-02)

Regra: nenhum valor controlável pelo cliente entra em `metadata.green.trusted`. A confiança vem da **origem**, não do
formato (nenhum teste depende de o valor "parecer UUID").

- A causa estava no backend: os gates de sessão (`requireRole`) e de token (`resolveAuthDual`) e a zona de perigo copiavam
  o `x-request-id` do cliente para `request_id`/`correlation_id`; num writer privilegiado o banco confia no contexto
  do backend, então o valor virava `trusted`.
- Conserto: `identificadoresDaRequisicao(header)` gera o `request_id` (e `correlation_id`) **no servidor**
  (`randomUUID`) e põe o que o cliente mandou em `client_request_id`, saneado (charset do contrato, teto 128), sempre
  **advisory** (o envelope o coloca em `advisory` para qualquer caller). Header gigante ou fora do charset não derruba mais
  o contexto (na v1 ele invalidava o contexto e o writer Green falhava fechado: um cliente podia causar recusa).
- O ledger grava `request_id` (servidor) e `advisory_request_id` (cliente). O evento continua correlacionável: o id do
  servidor correlaciona operacionalmente, o do cliente fica ao lado como advisory.
- `rule:<id>` do **motor de automação** (backend) continua sendo causa de regra (controle).

Cerca estrutural (`request-id-v12.test.ts`): todo arquivo de produção que declara contexto Green só pode pôr em
`request_id`/`correlation_id` um `rule:<id>`, um id do servidor ou um valor da lista revisada (run do agente, id de
conversa, correlação herdada, id da campanha, `randomUUID` do webhook-in e do MCP). Na v1 a cerca acusa exatamente os
três seams defeituosos.

## 5. Provas do request id

Gates de sessão e de token × {sem header, UUID, arbitrário, `rule:*`, `automation`, 5000 caracteres, fora do charset}:
o contexto existe, `request_id` é UUID do servidor e diferente do cliente, `correlation_id = request_id`,
`client_request_id` = valor saneado, o contexto serializa. Chamadas simultâneas (24): cada requisição vê só o próprio
valor e um id do servidor único. Pela zona de perigo real contra o banco real: 6 headers (inclusive `rule:*`,
`automation`, 5000 caracteres) + 4 ações concorrentes com headers forjados distintos: nenhuma lápide é lida como regra.
`advisory` nunca participa do anti-loop (`causadoPorRegra` só lê `trusted`). Os invariantes trusted/advisory da v3
foram reexecutados (§13).

## 6. Política de identidade e UUID não reciclável (LIFE-ADV-03)

Decisão técnica (Fase 5): **registro mínimo novo**, não fortalecer `lead_birth_provenance`. Motivos: a proveniência tem
FK de organização com cascata (o UUID voltaria a ser reutilizável quando o tenant fosse apagado), carrega
ator/origem (não é "só o necessário"), e só é gravada no INSERT (leads que entram por UPDATE nunca teriam registro).
`green.lead_birth_provenance` segue uma linha por lead: o reuso é recusado **antes** do insert.

`green.lead_identity (lead_id uuid pk, state live|retired, first_seen_at, retired_at)`:

- sem FK para o lead (sobrevive ao DELETE) e sem FK/coluna de organização (a cascata do tenant não devolve o UUID);
- sem org, ator, origem ou PII (o histórico vive no `event_log`, no livro-razão e na proveniência);
- RLS ligada, `revoke all`, `select` só para `service_role`; nenhum papel de API escreve nem lê (testado: `authenticated`/`anon`
  recebem `42501`, e nem `service_role` reabilita um UUID aposentado);
- `live` enquanto o lead existe; `retired` para sempre depois do DELETE de **qualquer** lead com identidade (Green ou não,
  inclusive pela cascata da organização: a retirada roda antes de qualquer retorno antecipado da fronteira);
- a fronteira reivindica a identidade em toda **entrada** no domínio (INSERT Green ou lead que vem de fora por UPDATE);
  UUID aposentado é recusado; "mesmo lead continuando a vida" (mudar de etapa, sair e reentrar) é permitido porque a
  linha segue `live`;
- trocar o `id` de um lead com identidade é recusado (`green_lead_id_immutable`), senão libertaria o UUID antigo.

Corrida: o DELETE que aposenta e o INSERT que reivindica o mesmo UUID só convivem depois do commit do DELETE (a PK de
`crm_leads` serializa), então a aposentadoria já está visível.

## 7. Comportamento de reuso (Casos A-E)

| Caso                                                | v1                             | v1.2                                                                                   |
| --------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| A. lead Green X apagado; INSERT Green com X         | `23505` da PK da proveniência  | `green_lead_id_reuse_forbidden`                                                        |
| B. X apagado; lead comum com X; mover para Green    | **aceito, herda proveniência** | `green_lead_id_reuse_forbidden`; a transação desfaz; proveniência continua com 1 linha |
| C. mesmo cenário em outra organização               | **aceito**                     | mesma recusa, mensagem idêntica à da mesma org                                         |
| D. UUID nunca usado (INSERT Green; comum→Green)     | permitido                      | permitido                                                                              |
| E. mesmo lead muda de etapa, sai e reentra          | permitido                      | permitido                                                                              |
| lead que saiu do Green e foi apagado no funil comum | reuso aceito                   | recusado                                                                               |
| lead que entrou por UPDATE e foi apagado            | reuso aceito                   | recusado                                                                               |
| cascata da organização, depois reuso                | reuso aceito                   | recusado (INSERT e comum→Green)                                                        |

## 8. Erro de domínio

`green_lead_id_reuse_forbidden` (`P0001`), sem `constraint`, sem `detail`, sem `hint`. O teste serializa o erro e
afirma que ele não contém a organização histórica, o ator histórico, a origem histórica nem a de outro tenant, e que a
resposta cross-tenant é **idêntica** à da mesma organização. Residual consciente: o erro revela "este UUID já foi
retirado do domínio Green" a quem escolheu o UUID. UUIDs v4 não são adivinháveis e o PK de `crm_leads` já revela a
existência de um id vivo em outro tenant (`23505`); nada além disso vaza.

## 9. Proteção cross-tenant

A fronteira é AFTER ROW: só roda para a linha que a RLS já aceitou, então a recusa não é oracle de pertencimento
por lado de RLS. O registro é global por UUID de propósito (é o que torna o reuso cross-tenant detectável).

## 10. Zona de perigo cross-org (LIFE-ADV-04) e §11 mutation tests

**Testes por comportamento** (`R4`): duas organizações com as **sete** raízes populadas (`messages`, `conversations`,
`calendar_appointments`, `orders`, `crm_proposals`, `crm_leads` Green e comum, `contacts`); executada a zona de perigo
de A (pela action real e pela RPC), A fica com 0 em todas as raízes e a vizinha B é idêntica **linha a linha** (contagem +
`md5` das linhas inteiras de cada tabela) e sem lápide nova; recusa no meio (lead Green sem contexto) deixa A **e** B
intactas (atomicidade e isolamento juntos); três organizações; `p_org` nulo é recusado. Nada depende do texto SQL. A
RPC continua uma transação só: não voltei aos sete DELETE separados (Fase 10).

**Mutation tests** (diagnóstico, nunca commitados; runner no scratchpad, restaura por `git checkout`, árvore limpa
confirmada ao fim). Mutações aplicadas à função da 0503 (migration e apêndice do baseline):

| Mutação                         | Teste unitário antigo | Teste de banco antigo (L2) | R4 novo (v1.2)  |
| ------------------------------- | --------------------- | -------------------------- | --------------- |
| M1 DELETE sem `organization_id` | detecta (5)           | detecta (1)                | **detecta (3)** |
| M2 `organization_id <> p_org`   | detecta (2)           | **passa**                  | **detecta (3)** |
| M3 `TRUNCATE`                   | **passa**             | **passa**                  | **detecta (3)** |
| M4 statement extra cross-org    | detecta (4)           | **passa**                  | **detecta (3)** |
| M5 `or true`                    | detecta (2)           | **passa**                  | **detecta (3)** |

Os testes antigos de banco só pegam M1 e o unitário (que lê o texto SQL) é cego a `TRUNCATE`: é a lacuna que a
auditoria apontou. O R4 detecta os cinco, tanto sobre a v1 quanto sobre a v1.2.

## 12. Migration e baseline (Fase 13)

- 0501, 0502, 0503 intactas; 0504 adicionada; MANIFEST atualizado; baseline espelha a 0504 (texto idêntico, antes da
  VARREDURA anon).
- Install novo + update com `ON_ERROR_STOP` (baseline aplicado duas vezes): verde dentro do `test:db`.
- **Upgrade 0503 → 0504 com dados históricos** (container pg15 efêmero: baseline da v1, histórico, 0504 sobre ele):
  lead Green vivo, lead Green apagado (com lápide, ledger e proveniência), lead Green anterior à 0503 (sem
  proveniência), lead que saiu do Green e lead comum nunca-Green. Resultado: `01=live 02=retired 03=live 04=live`, o
  lead comum fora do registro (4 linhas). Reaplicação da 0504: mesmo resultado, sem erro (idempotente). Sobre o histórico:
  INSERT Green com o UUID histórico recusado com o erro de domínio, comum→Green com o UUID histórico recusado, lead vivo
  continua e o que saiu do Green reentra.
- Limite honesto do backfill: UUIDs de leads cuja organização foi apagada **antes** da 0504 não deixaram rastro (proveniência
  e livro-razão cascateiam com o tenant) e não podem ser aposentados retroativamente.

## 13. Regressão

Ambiente: Windows 11, Docker Desktop 29.8; `test:db` em `pgvector:pg15` efêmero; stack local `deskcomm-green-spike` com a
0504 aplicada; Node 22.23.3 para os E2Es; suítes de banco uma de cada vez.

| Suíte                                                                            | Resultado v1.2                                                                                                                        | Base (v1)                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `tsc --noEmit -p tsconfig.typecheck.json`                                        | exit 0                                                                                                                                | exit 0                                                  |
| `eslint` + `prettier --check` nos arquivos tocados                               | 0 erros, 0 avisos                                                                                                                     | -                                                       |
| processo `request-id-v12`                                                        | 31/31                                                                                                                                 | RED: 29 falhas                                          |
| banco `green-lifecycle-v12`                                                      | 28/28                                                                                                                                 | RED: 17 falhas                                          |
| invariantes Green v1/v2/v3 + lifecycle v1                                        | todos verdes (lifecycle v1: 23/23)                                                                                                    | -                                                       |
| `pnpm test:db` inteira                                                           | **346/346 arquivos, 2883 passed, 1 expected fail, 1 skipped**                                                                         | 345/345, 2855 passed                                    |
| unitários `lib/green`, `lib/api`, `lib/auth`, zona de perigo                     | 259/259                                                                                                                               | -                                                       |
| `vitest --project cercas` (os 12 arquivos que falham na corrida cheia, isolados) | 9 arquivos / 37 casos                                                                                                                 | os mesmos 9 nomes (a base falhou +1 por carga: 10 / 38) |
| `vitest --project produto`                                                       | 1396 arquivos passam; 7 arquivos / 11 casos falham (os 4 arquivos extra da 1ª corrida eram timeout sob carga e passam isolados 10/10) | os mesmos 7 nomes, 11 casos                             |
| E2E v2 PostgREST real (Node 22)                                                  | 6 passed, 1 skipped                                                                                                                   | 6 + 1                                                   |
| E2E lifecycle PostgREST real                                                     | 4/4                                                                                                                                   | 4/4                                                     |
| E2E v3 Next real (`next dev`, Node 22)                                           | 9/9                                                                                                                                   | 9/9                                                     |

`cercas` e `produto`: toda falha chamada de pré-existente foi comparada com a base congelada (`3ac8fa7`) num worktree
destacado (`git worktree` em `3ac8fa7`): mesmos nomes de arquivo (`bash`/`python` ausentes neste Windows, git/gh de release, runner de E2E, bancada de extensões). A 1ª corrida cheia de `cercas` teve 13 arquivos: 12 sozinhos dão os 9 acima e o 13º, `manifest-cita-caminho-que-existe`, falhou só até este relatório existir (a linha do MANIFEST o cita) e agora passa. **Novas: 0.**

### 13.1 Testes antigos alterados por mudança de contrato

Nenhum invariante congelado (`tests/invariants/**` da v1/v2/v3) foi modificado. Cinco arquivos antigos tinham
expectativas que fixavam **exatamente o contrato defeituoso** (o id do cliente/rota como `request_id` confiável); foram
alteradas só essas expectativas, cada uma comentada como `CONTRATO v1.2`:

| Teste                                  | Afirmava                                               | Agora                                                                               |
| -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `lib/green/seams-v2.test.ts` (3 casos) | `request_id`/`correlation_id` do contexto = id da rota | UUID do servidor + `client_request_id` = id da rota                                 |
| `postgrest-real.e2e.ts` S18            | `request_id` confiável do canônico = id da rota        | UUID do servidor, `green.advisory.client_request_id` = id da rota                   |
| `postgrest-real.e2e.ts` S19            | `advisory.{request_id,correlation_id}` = id da rota    | `advisory.client_request_id` = id da rota                                           |
| `next-real-v3.e2e.ts` N1-N3            | o request da rota estava em `advisory.request_id`      | está em `advisory.client_request_id` (os ids do servidor são únicos por requisição) |

## 14. Prova diferencial

Mesmos testes, dois códigos (não alterei os testes entre as colunas; os da §13.1 são contrato antigo, não os novos):

| Caso                             | lifecycle v1                                                | lifecycle v1.2                                                          |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `x-request-id: rule:*`           | `trusted.request_id = rule:*`, anti-loop enganado           | `trusted` = id do servidor; `rule:*` só em `advisory.client_request_id` |
| header de 5000 caracteres        | contexto invalidado ou id descartado                        | contexto válido; advisory truncado a 128                                |
| reuso direto                     | `23505` acidental da PK                                     | erro de domínio `green_lead_id_reuse_forbidden`                         |
| comum→Green com UUID histórico   | herda proveniência                                          | recusado                                                                |
| cross-tenant                     | herda proveniência                                          | recusado, resposta idêntica, sem vazamento                              |
| após cascata da organização      | reuso aceito                                                | recusado                                                                |
| DELETE cross-org mutante (M2-M5) | testes antigos de banco passam; M3 passa também no unitário | R4 falha nos cinco                                                      |

## 15. Gaps restantes

1. **LIFE-ADV-01 (automação)**: ver §16; fora desta spike.
2. **LIFE-ADV-05 (escala da zona de perigo)**: ver §17; bloqueia produção, não o baseline arquitetural.
3. `idempotency_key` do MCP continua em `trusted`: é um UUID declarado pelo cliente (`Idempotency-Key`), mas nenhum
   consumidor de controle o lê (só `request_id`/`source` no anti-loop e `correlation_id` no dispatcher). Registrado como
   resíduo; mover para advisory seria a mesma mudança de `client_request_id` e não foi pedido.
4. Backfill não alcança UUIDs de organizações apagadas antes da 0504 (§12).
5. O registro de identidade não tem retenção (uma linha por lead que tocou o domínio; sem PII, sobrevive à organização
   por desenho).
6. A cerca estrutural do request id é lexical (varre `request_id:`/`correlation_id:` dentro das chamadas de contexto) e usa
   lista revisada: um seam futuro que passe o valor por outra forma sintática precisa do teste de comportamento.
7. Gaps 1-9 da §10 do relatório da SPIKE-GREEN-01 não mudaram.

## 16. Automation blocker (LIFE-ADV-01), correção do relatório

> **BLOCKER PARA GREEN-BASELINE. HERDADO DA V3.**

A auditoria **mediu** falha da origem de serviço (`service_origin`) em **11 dos 16 gatilhos relevantes** de Opportunity Green,
incluindo `lead.stage_stale`, `lead.silent_for`, `lead.date_field_due` e `contact.birthday`, além dos demais tipos não
ancoráveis identificados pelo censo (entre eles `message.failed` e `appointment.*`). O relatório da SPIKE-GREEN-01 tratava
isto como "gap derivado do código, não medido" e o descrevia por três exemplos; isso está **corrigido aqui**. Não é um defeito
introduzido pelo lifecycle: a régua de `green.fn_assert_event_origin_contact` é da v3 (0502/0501). A política de origem das
automações é uma tarefa separada, depois desta spike. Nada na régua foi alterado.

## 17. Escala (Fase 16)

Não resolvi LIFE-ADV-05. Smoke para provar que a 0504 não piorou materialmente a RPC: stack local, organização com 3000 leads
Green + 3000 comuns, `fn_apagar_dados_operacionais_da_org` numa transação, fronteira da 0503 trocada por `create or replace`
pela da 0504 e vice-versa no MESMO banco, duas rodadas:

| Fronteira   | DELETE de 3000 Green (RPC) | INSERT dos 6000 |
| ----------- | -------------------------- | --------------- |
| v1 (0503)   | 3,36 s e 3,41 s            | 0,90 s e 0,91 s |
| v1.2 (0504) | 3,75 s e 3,64 s            | 1,00 s e 1,00 s |

Custo ≈ +8 a +10 % (um `UPDATE` por PK em `lead_identity` por DELETE e um `INSERT … ON CONFLICT` na entrada): não material.
`LIFE-ADV-05 = bloqueia produção, não o baseline arquitetural` (inalterado).

## 18. Readiness para baseline

Levar: o id de requisição confiável é gerado no servidor e o do cliente é advisory; identidade de lead Green como registro
mínimo, não reciclável, sobrevivente à organização; erro de domínio estável sem oracle. Antes do baseline: ADV-01
(automação), ADV-05 (lote/escala), tratamento Green do contato apagado com histórico, visibilidade de produto da recusa.

## 19. Integridade

Árvore da branch com apenas mudanças intencionais; `spike/green-lead-lifecycle-v1` (`3ac8fa7`) intacta; sem push, PR ou
merge; `.next/` e o worktree da base removidos; mutações restauradas (confirmado por `git status`). O stack local ficou com
a 0504 aplicada e fixtures de teste, como nas spikes anteriores. Incidente de ambiente (sem efeito no Git): ao remover o worktree da base, `git worktree remove --force` atravessou a junction de `node_modules` e apagou parte do `node_modules` do checkout principal; restaurado por `pnpm install --frozen-lockfile --offline` (lockfile intacto) e reverificado (`lib/green`, `lib/api`, `lib/auth` e zona de perigo: 259/259). As corridas de regressão desta seção são anteriores ao incidente; os testes da spike foram reexecutados depois dele. As chaves do stack foram lidas por script e passadas só
ao processo filho; nenhuma foi impressa nem gravada.

## Veredito do implementador

Todos os critérios de PASS foram provados: o cliente não controla `trusted.request_id`; `rule:*` forjado não afeta o
anti-loop; UUID histórico Green não representa outro lead; common→Green não herda proveniência; cross-tenant não herda nem
cria oracle; o teste da zona de perigo detecta DELETE cross-org (5 de 5 mutantes) e a implementação atual isola
corretamente; zero regressão nova (`test:db`, `cercas`, `produto`, E2Es). Ficam gaps delimitados (§15) e o blocker
herdado de automação (§16).

SPIKE-GREEN-01.2: PASS-COM-GAPS
