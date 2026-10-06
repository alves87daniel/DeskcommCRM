# SPIKE-GREEN-01.3 - Lead Lifecycle: identidade por binding e selagem

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhum push.

| Item                    | Valor                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base congelada          | `spike/green-lead-lifecycle-v1.2` @ `bc727cbcedcfcf0cddb47ae828e57cf24b59cf41` (intacta)                                                                       |
| Branch da spike         | `spike/green-lead-lifecycle-v1.3` (local)                                                                                                                      |
| Auditoria de referência | AUDIT-GREEN-01.2.1: PASS NÃO SUSTENTADO                                                                                                                        |
| Migration               | `supabase/migrations/20261003090000_0505_spike_green_lifecycle_v13.sql` (+ espelho no `baseline.sql`, antes da VARREDURA anon, + MANIFEST); 0501-0504 intactas |
| Escopo                  | V12-ADV-01, V12-ADV-02, V12-ADV-03, texto da política de UUID. Fora: LIFE-ADV-01 (automação), LIFE-ADV-05 (escala)                                             |

## 1. Contrato de identidade (definitivo)

> **Todo lead que EFETIVAMENTE tocar o domínio Green deixa uma identidade histórica não reciclável.**

Entradas cobertas: INSERT já em Green; UPDATE comum → Green; pipeline que passa a ser Green por criação de binding;
lead que já existia no pipeline no momento do binding. O UUID de um lead que **nunca** tocou Green não é protegido.

O relatório da v1.2 (§1) dizia que todo UUID de `crm_leads` não é reciclável. A política implementada nunca foi essa;
o texto foi corrigido lá, com nota apontando para cá.

## 2. Delta

| Arquivo                                        | Mudança                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0505`                                         | `green.fn_claim_binding_identities()` + trigger `trg_green_binding_claims_identities` (AFTER INSERT e UPDATE de `organization_id`/`pipeline_id` em `green.product_pipeline_binding`); `green.fn_crm_lead_boundary()` redefinida (cópia da 0504 com o DELETE defensivo); backfill reaplicável |
| `baseline.sql`                                 | espelho da 0505 (texto idêntico, antes da VARREDURA anon); só adições                                                                                                                                                                                                                        |
| `MANIFEST.md`                                  | linha da 0505                                                                                                                                                                                                                                                                                |
| `lib/green/request-id-v12.test.ts`             | `vi.importActual<typeof McpAuth>` (TS2709; sem `any`, sem ignore, sem exclusão)                                                                                                                                                                                                              |
| `tests/invariants/green-lifecycle-v13.test.ts` | suíte nova: B, R, D, C, O, Z, U (31 casos)                                                                                                                                                                                                                                                   |
| `docs/spike/GREEN-LEAD-LIFECYCLE-V1.2.md`      | §1: texto da política corrigido                                                                                                                                                                                                                                                              |

Nenhum teste antigo foi alterado.

## 3. Como funciona

**Binding.** Quando um binding nasce (ou muda de pipeline), o trigger reivindica, na MESMA transação, a identidade
`live` de todo lead da organização que está no pipeline ou numa etapa dele (`insert … on conflict do nothing`:
idempotente, sem duplicidade). Se algum desses leads vivos tiver o UUID já `retired` (lead comum que reaproveitou um
UUID Green), o binding inteiro é recusado com `green_lead_id_reuse_forbidden`, a mesma resposta de sempre, e a
transação desfaz as identidades que tinha criado.

**Corrida.** Antes de ler, o trigger toma `SHARE ROW EXCLUSIVE` em `public.crm_leads`: espera as escritas de lead em voo
(que têm `ROW EXCLUSIVE`) e faz as seguintes esperarem o binding. Depois do lock, o `select` (READ COMMITTED) vê tudo
o que foi comitado, e a fronteira de quem esperou vê o binding. Sem o lock existe o buraco: lead em voo que o binding
não enxerga e que a fronteira, sem enxergar o binding, não reivindica.

**DELETE defensivo.** A fronteira continua aposentando a identidade existente antes de qualquer retorno. Além disso,
se o lead apagado TOCA o domínio e não tem linha de identidade (estado inesperado), ela grava a identidade já
`retired`. Lead que nunca tocou o domínio continua sem identidade ao ser apagado.

## 4. RED → GREEN

Mesma suíte (`green-lifecycle-v13.test.ts`), dois códigos:

| Família                                                                                                        | v1.2 (`bc727cb`)                   | v1.3                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| B binding (0, 1, 150 leads; já com identidade; mistura; idempotência; troca de pipeline; atomicidade; sem PII) | 7 de 8 falham (só "0 leads" passa) | 8/8                                      |
| R reuso A-D depois do binding                                                                                  | 4/4 falham (reuso **ACEITO**)      | 4/4 recusados                            |
| R-E lead que nunca tocou Green                                                                                 | passa (controle)                   | passa: UUID reutilizável, sem identidade |
| D DELETE defensivo                                                                                             | falha (identidade fica ausente)    | `retired`                                |
| C concorrência (9 cenários)                                                                                    | 9/9 falham                         | 9/9                                      |
| O oracle                                                                                                       | falha (reuso aceito)               | assinatura idêntica                      |
| Z foto cross-org ampliada                                                                                      | passa (a implementação já isolava) | passa                                    |
| U upgrade 0504 → 0505                                                                                          | (escrito depois da 0505)           | passa                                    |

Placar do RED: 23 falham, 7 passam (controles). GREEN: 31/31.

## 5. Concorrência

Cada cenário com duas conexões e ordem de commit escolhida (o segundo fica bloqueado até o primeiro comitar):

| Cenário                                                                  | Resultado                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| lead em voo (INSERT) → binding                                           | o binding espera; o lead entra `live`                                                   |
| binding em voo → INSERT de lead                                          | o INSERT espera; a fronteira vê o binding e reivindica                                  |
| DELETE em voo → binding                                                  | o lead apagado era comum (sem identidade); o resto fecha                                |
| binding em voo → DELETE                                                  | o DELETE espera e aposenta a identidade que o binding criou; reuso recusado             |
| movimento comum→Green em voo → binding                                   | o binding vê o lead no pipeline e o registra                                            |
| binding em voo → movimento comum→Green                                   | o movimento espera e reivindica                                                         |
| dois bindings do mesmo pipeline                                          | um vence, o outro cai na PK (`23505`); 20/20 identidades, uma linha cada                |
| dois bindings de pipelines diferentes                                    | ambos fecham                                                                            |
| 12 rodadas de binding + 4 INSERTs + 3 movimentos + 2 DELETEs simultâneos | nenhuma falha, nenhum lead Green sem identidade, todo apagado com lápide está `retired` |

Invariante verificado em todos: `nenhum lead vivo toca o domínio sem linha em green.lead_identity`.

## 6. Cerca cross-org (V12-ADV-03)

A foto da zona de perigo agora cobre **toda** tabela de `public` com `organization_id` (mais de 50) e o estado
`green.*` (binding, proveniência, ledger) das organizações vizinhas, com contagem + `md5` das linhas inteiras.

Mutation test (diagnóstico, nunca commitado; mutação no `baseline.sql`, restaurado por `git checkout`, árvore limpa
confirmada):

| Mutante                                                                       | Cerca v1.3 (Z)                        |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| controle (sem mutação)                                                        | verde                                 |
| M1 DELETE de `crm_leads` sem filtro de organização                            | **RED**                               |
| M3b `TRUNCATE` válido (`orders`: 0 FKs entrando, `service_role` tem TRUNCATE) | **RED**                               |
| M4b statement cross-org fora das sete raízes (`user_organizations <> p_org`)  | **RED** (o R4 da v1.2 deixava passar) |

## 7. Migration e baseline

- 0501, 0502, 0503 e 0504 intactas; 0505 nova; MANIFEST atualizado; baseline com o espelho da 0505 (só adições).
- Install novo + update (baseline aplicado duas vezes, `ON_ERROR_STOP=1`): verde dentro do `test:db`.
- **Upgrade 0504 → 0505 com histórico** (teste U, permanente): o banco é rebaixado ao estado da 0504 (sem o trigger,
  com a fronteira antiga), recebe um pipeline comum com 4 leads e binding posterior, um deles apagado com lápide Green
  e sem identidade (o defeito da 0504, reproduzido: o reuso é aceito), um lead Green normal e um comum. A 0505 é
  aplicada **duas vezes**: vivos do binding `live`, apagado `retired`, Green `live`, comum sem linha (4 linhas), reuso
  recusado, e um binding novo depois da 0505 fecha sozinho.
- Stack local `deskcomm-green-spike`: 0505 aplicada duas vezes sem erro (idempotente).
- Grants: `fn_claim_binding_identities` revogada de `public`, `anon`, `authenticated` e `service_role`; só o trigger a
  executa (definer, `search_path = ''`). Nenhuma coluna nova, nenhuma PII nova.

## 8. Regressão

Ambiente: Windows 11, Docker Desktop 29.8; `test:db` em `pgvector:pg15` efêmero; stack local `deskcomm-green-spike`
com a 0505; Node 22.23.3 para os E2Es; suítes de banco uma de cada vez.

| Suíte                                                                                  | Resultado                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tsc --noEmit -p tsconfig.typecheck.json`                                              | **exit 0** (era exit 2 na v1.2)                                                                        |
| `eslint` + `prettier --check` nos arquivos tocados                                     | 0 erros                                                                                                |
| banco `green-lifecycle-v13`                                                            | 31/31                                                                                                  |
| `test:db` inteira                                                                      | **347/347 arquivos, 2914 passed, 1 expected fail, 1 skipped** (v1.2: 346/346)                          |
| unitários `lib/green`, `lib/api`, `lib/auth`, zona de perigo (inclui `request-id-v12`) | 259/259                                                                                                |
| E2E PostgREST real (v2 + lifecycle)                                                    | 10 passed, 1 skipped (igual à v1.2)                                                                    |
| E2E Next real v3 (`next dev`, Node 22)                                                 | 9/9                                                                                                    |
| `vitest --project cercas`                                                              | só falhas de ambiente, a mesma família da v1.2 (release/CI, `bash`/`git`, timeout sob carga); ver §8.1 |

Duas corridas cheias de `test:db` foram interrompidas pelo limite de 2 horas do executor de background: a máquina
recém-reiniciada estava lenta (um arquivo levou 1106 s e falhou; isolado, passou 12/12 em 37 s). A terceira corrida,
sem nada em paralelo, terminou verde em 27 minutos.

### 8.1 Cercas

`manifest-cita-caminho-que-existe` falhava só até este relatório existir (a linha da 0505 no MANIFEST o cita);
`namespace-das-imagens` caiu por timeout de 15 s sob carga. Os dois foram reexecutados isolados depois deste relatório
(2 arquivos, 19/19 verdes). As demais falhas são os mesmos arquivos de ambiente registrados na v1.2.

## 9. Limites conhecidos

1. **Duplo estado impossível:** identidade apagada à força E cascata da organização. Quando a cascata já levou o
   binding, a fronteira não tem como saber se o lead tocava o domínio e não inventa identidade; o reuso é aceito. O
   teste `LIMITE CONHECIDO` registra isso. Nenhum papel de API apaga linha de `green.lead_identity` (`42501` para
   `anon`, `authenticated` e `service_role`, provado na AUDIT-GREEN-01.2.1), então o estado só existe por escrita do
   dono do banco.
2. **Custo do lock do binding:** criar um binding segura as escritas em `crm_leads` (de todas as organizações) pelo
   tempo da transação do binding. Aceitável para a spike, porque binding é operação rara de administração. Para
   produção, entra junto com LIFE-ADV-05 (lock por organização ou advisory lock por pipeline).
3. O R4 da v1.2 (sete raízes) continua como estava; a cerca nova (Z) é a que detecta o M4b.

## 10. Gaps deixados para depois

- **LIFE-ADV-01 (automação):** BLOCKER PARA GREEN-BASELINE, herdado da v3, intocado.
- **LIFE-ADV-05 (escala da zona de perigo):** bloqueia produção, não o baseline arquitetural; agora inclui o custo do
  lock do binding.
- `idempotency_key` do MCP em `trusted` (resíduo INFO, nenhum consumidor de controle).
- Registro de identidade sem retenção (sem PII, cresce com o uso).
- `TRUNCATE` herdado do baseline para `anon`/`authenticated` em tabelas de `public` (não dispara a fronteira; sem rota
  no PostgREST; upstream, não é desta spike).

## 11. Selagem binária

| Critério de saída                                                | Prova                                                                                   | Resultado |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------- |
| pipeline que vira Green registra identidade dos leads existentes | B (0, 1, 150, mistura, já com identidade, troca de pipeline, idempotência, atomicidade) | ✅        |
| DELETE Green nunca deixa UUID reciclável                         | R-A/B, D, C (binding × DELETE), rajadas; limite §9.1 só por escrita do dono             | ✅        |
| reuso same-org é recusado                                        | R-A, R-B                                                                                | ✅        |
| reuso cross-org é recusado sem oracle                            | R-C, R-D, O (assinatura idêntica)                                                       | ✅        |
| concorrência binding × lead não deixa buraco                     | C (9 cenários, 12 rajadas)                                                              | ✅        |
| typecheck está verde                                             | `tsc` exit 0                                                                            | ✅        |
| trusted/advisory continua verde                                  | `request-id-v12` 31/31, `green-lifecycle-v12` R2, E2Es                                  | ✅        |
| zona de perigo continua cross-org safe                           | Z (todas as tabelas com `organization_id` + `green.*`), R4                              | ✅        |
| teste ampliado detecta M4b                                       | mutation test §6                                                                        | ✅        |
| nenhuma regressão nova crítica                                   | `test:db` 347/347, unitários, E2Es, cercas sem falha nova de código                     | ✅        |

**LEAD LIFECYCLE = SEALED.** Os blockers que sobram (LIFE-ADV-01, LIFE-ADV-05) não pertencem ao lifecycle e seguem
para tarefas próprias.

## 12. Integridade

Árvore da branch só com mudanças intencionais; `spike/green-lead-lifecycle-v1.2` (`bc727cb`) intacta; sem push, PR ou
merge; `.next/` removido; mutações restauradas (confirmado por `git status`); containers efêmeros removidos. As chaves do
stack foram lidas por script e passadas só ao processo filho, sem impressão nem gravação.

SPIKE-GREEN-01.3: PASS
