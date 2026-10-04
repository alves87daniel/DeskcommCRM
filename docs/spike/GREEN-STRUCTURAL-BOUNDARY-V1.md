# SPIKE-GREEN-02 - Structural Boundary: Pipelines, Stages & Organization

Status: SPIKE DESCARTÁVEL, experimental e auditável. Não é produto, não vai para produção nem para a `main`.
Nenhum merge, nenhum PR, nenhum push.

| Item           | Valor                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base congelada | `spike/green-automation-origin-v1` @ `bcfbafeeb2f618fc1ab9ddaa8f999d947cae0670` (árvore limpa; LIFECYCLE = SEALED; AUTOMATION ORIGIN = SEALED)                     |
| Branch         | `spike/green-structural-boundary-v1` (local)                                                                                                                       |
| Migration      | `supabase/migrations/20261004090000_0507_spike_green_structural_boundary.sql` (+ espelho no `baseline.sql` antes da VARREDURA anon + MANIFEST); 0501-0506 intactas |
| Commits (TDD)  | `8e310fcce` RED → `e85c4be94` 0507 → `1eb5406bb` E2E real → relatório                                                                                              |
| Fora de escopo | lifecycle, automation origin, mutation context, trusted/advisory, identidade, tombstone, zona de perigo, LIFE-ADV-05, supressor, GREEN-03                          |

## 1. Censo estrutural (Fase 1)

Feito do zero (busca em `app/`, `lib/`, `components/`, `scripts/`, `tests/`, `supabase/baseline.sql`,
`supabase/migrations/`; não há `supabase/functions`). **Nenhum writer de produção altera
`crm_stages.pipeline_id`, `crm_stages.organization_id` ou `crm_pipelines.organization_id`: os três só são
definidos no INSERT.** `green.product_pipeline_binding` não tem writer fora de testes (e das cascatas).

Clientes: **sessão** = `createClient` de `@/lib/supabase/server` (RLS: `crm_*_manager_write` exige membro +
manager); **admin** = `createAdminClient` (service_role, sem RLS).

### 1.1 Produção

| #   | Primitive (arquivo)                                                                  | Tabela                        | Operação                                                                                   | Caller                                                                            | RLS?          | Pode afetar Green?                                                                     | Leads indiretos                   |
| --- | ------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `app/api/v1/pipelines/route.ts:128-157`                                              | `crm_pipelines`, `crm_stages` | INSERT funil + 4 etapas (org do JWT); DELETE de rollback se a etapa falhar                 | POST `/api/v1/pipelines` (manager)                                                | sim (sessão)  | não (funil novo, sem binding)                                                          | 0                                 |
| 2   | `app/api/v1/pipelines/[id]/route.ts:258-263`                                         | `crm_pipelines`               | UPDATE nome, descrição, posição, `is_default`, `is_client_pipeline`, desarquivar           | PATCH `/api/v1/pipelines/[id]` (manager)                                          | sim           | não (nenhuma coluna de pertencimento)                                                  | 0                                 |
| 3   | `app/api/v1/pipelines/[id]/route.ts:342-348`                                         | `crm_pipelines`               | arquivar (padrão) ou DELETE (`?definitivo=1`, recusado com negócios)                       | DELETE `/api/v1/pipelines/[id]` (manager)                                         | sim           | arquivar: não; DELETE: cascata leva etapas e binding                                   | 0 (RESTRICT)                      |
| 4   | `lib/leads/stage-operations.ts:262-266` (`criarEtapa`)                               | `crm_stages`                  | INSERT (funil conferido como da org)                                                       | POST `.../stages` (sessão) e MCP `crm_create_stage` (admin)                       | sim / não     | etapa nova em funil Green: configuração                                                | 0                                 |
| 5   | `lib/leads/stage-operations.ts:433-439` (`atualizarEtapa`)                           | `crm_stages`                  | UPDATE nome, `is_won`/`is_lost`, hint, posição, probabilidade, aviso                       | PATCH `.../stages/[stageId]` (sessão) e MCP `crm_update_stage` (admin)            | sim / não     | não muda pertencimento (ver GAP-07)                                                    | 0                                 |
| 6   | `lib/leads/stage-operations.ts:546-551` + `:566-571` (`arquivarEtapa`)               | `crm_leads` → `crm_stages`    | UPDATE em massa `stage_id = destino` (mesmo funil) e depois `is_archived = true`           | DELETE `.../stages/[stageId]?destino=` (sessão) e MCP `crm_archive_stage` (admin) | sim / não     | **sim**: cada card Green passa pela fronteira de `crm_leads`                           | todos os da etapa, numa instrução |
| 7   | `app/api/v1/pipelines/[id]/agent-mapping/route.ts:243-249`                           | `crm_stages`                  | UPDATE `agent_stage_hint`                                                                  | PUT `.../agent-mapping` (manager)                                                 | sim           | não                                                                                    | 0                                 |
| 8   | `app/actions/settings/updatePipelineConfig.ts:73-76`                                 | `crm_pipelines`               | UPDATE `vocabulary`, `settings`                                                            | server action (admin+)                                                            | sim           | não                                                                                    | 0                                 |
| 9   | `app/actions/onboarding/montarQuadro.ts:232-245` → `fn_aplicar_quadro_do_onboarding` | `crm_stages`, `crm_pipelines` | DELETE de todas as etapas + INSERT das novas + UPDATE nome/slug (definer, só service_role) | server action do onboarding                                                       | não (definer) | só funil sem negócio (`funil_com_negocios`); em funil Green vazio é configuração       | 0                                 |
| 10  | `fn_seed_default_pipeline_for_org` (baseline:697-728, AFTER INSERT em organizations) | `crm_pipelines`, `crm_stages` | INSERT funil padrão + 8 etapas                                                             | toda criação de organização                                                       | definer       | não                                                                                    | 0                                 |
| 11  | `fn_mover_leads_em_lote` (baseline:17711) via `app/api/v1/leads/bulk/route.ts`       | `crm_leads`                   | UPDATE `stage_id` de até 50 leads (não é estrutural; o lote pode cruzar funis)             | POST `/api/v1/leads/bulk` (agent+)                                                | sim (invoker) | lead Green: a fronteira recusa etapa de outro funil; lead comum: fica "torto" (GAP-02) | ≤ 50                              |

### 1.2 Admin / suporte, scripts, testes, SQL

- **Admin:** `app/api/v1/admin/tenants/route.ts:195` → `fn_create_tenant_with_owner` (insere a org; semeia o funil
  padrão). Rotas de escrita barram sessão de suporte (`requireSupportWrite`). As três ferramentas MCP de etapa
  exigem manager, `mcp:write` e `apenasHumano` (não são montadas para o agente de IA).
- **Scripts:** `scripts/seed-crm-vivo.ts:300` reescreve a linha inteira da etapa com os MESMOS `organization_id` e
  `pipeline_id` (no-op nas guardas: o `WHEN` só dispara com mudança); demais seeds só criam organização.
- **Testes:** os únicos writers do binding (suítes Green de `tests/invariants` e `tests/green-e2e`), inclusive o
  DELETE e o UPDATE do binding no lifecycle v1.3 (`green-lifecycle-v13.test.ts:339, :354`).
- **SQL/FK (base 0506):** `crm_stages.pipeline_id → crm_pipelines` CASCADE; `crm_leads.pipeline_id` e
  `crm_leads.stage_id` RESTRICT; binding `pipeline_id → crm_pipelines` CASCADE; nenhuma FK amarra a organização da
  etapa/lead/binding à do funil. Triggers estruturais: `updated_at`, o seed, o claim de identidade do binding (0505) e
  a auditoria de remoção do binding (0503, só DELETE).

## 2. Invariantes estruturais (Fase 2)

Derivados do schema (não das FKs, que não os garantiam). Domínio Green = funil com binding OU etapa de funil com
binding da MESMA organização (`green.fn_lead_touches_green`, 0502).

| #   | Invariante                                                                       | Base 0506                                                                                                  | 0507                                                                             |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S1  | todo lead que toca o domínio tem etapa do próprio funil e da própria organização | só a mutação do LEAD era conferida (ADV-09); estrutura e binding quebravam                                 | fronteira de `crm_leads` + guarda de etapa + checagem do binding + FKs compostas |
| S2  | etapa de funil Green não é realocada                                             | não garantido (aceito)                                                                                     | `green_stage_relocation_forbidden`                                               |
| S3  | etapa comum não entra em funil Green                                             | não garantido (aceito; leads entram sem identidade)                                                        | `green_stage_relocation_forbidden`                                               |
| S4  | funil Green não muda de organização                                              | não garantido (aceito; binding, etapas e leads ficam na org antiga)                                        | `green_structure_tenant_immutable` + FKs compostas                               |
| S5  | binding não cria lead Green sem identity/lifecycle                               | identidade sim (0505); coerência não                                                                       | 0505 intacto + `green_binding_structure_invalid`                                 |
| S6  | remoção de binding não destrói invariantes/histórico                             | identidade e histórico preservados; o DELETE era auditado sem dizer o que soltava; o UPDATE era silencioso | idem + `released_leads` e auditoria do re-apontamento                            |
| S7  | DELETE/arquivamento de etapa/funil não cria órfão                                | RESTRICT/CASCADE já garantiam                                                                              | mantido (FKs compostas com a mesma ação)                                         |
| S8  | etapa, binding e lead só apontam para estrutura da própria organização           | não garantido (FK passa por cima da RLS)                                                                   | FKs compostas (mesmo nome)                                                       |

## 3. RED (Fase 3)

Suíte nova `tests/invariants/green-structural-boundary.test.ts` (73 casos), escrita e commitada antes de qualquer
código (`8e310fcce`). Ataques diretos no banco pelos papéis reais (PostgREST simulado: `authenticated` com JWT,
`service_role` com e sem contexto) e pelo dono. Cada recusa é conferida contra a **foto** das organizações (md5 das
linhas inteiras de funis, etapas, leads, binding, identidades, livro-razão e `event_log`): sem estado parcial.

**Base (`bcfbafee`): 41 falham / 32 passam.** Uma correção de teste depois da primeira corrida: I2/X4 usavam o funil
padrão do fixture e caíam em `uniq_crm_pipelines_org_default` (23505), um falso RED; passaram a usar funil não padrão
(corrigido antes do commit do RED). Antes do GREEN, o U2 passou a conferir o detail da recusa de legado por chave (o
regex anterior aceitaria dígito de outra chave). Nenhuma correção afrouxa o contrato.
O comportamento da base foi registrado por um diagnóstico do próprio teste (estado deixado no banco por ataque):

| Ataque                                                    | Base                                                           | O que ficou no banco                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A etapa comum com leads → funil Green (manager, service)  | ACEITO                                                         | 3 leads tocando o Green **sem identidade** e com etapa de outro funil           |
| A etapa comum vazia → funil Green                         | ACEITO                                                         | (nada imediato; abre corrida com INSERT)                                        |
| B etapa Green com leads → funil comum                     | ACEITO                                                         | 3 leads Green incoerentes                                                       |
| C etapa Green → outro funil Green                         | ACEITO                                                         | 2 leads Green incoerentes                                                       |
| D etapa → funil de outra org                              | ACEITO                                                         | etapa da org A dentro de funil da B                                             |
| D etapa muda de org (admin das duas)                      | ACEITO                                                         | 2 leads da A apontando para etapa da B                                          |
| I funil Green muda de org (admin das duas)                | ACEITO                                                         | 2 etapas e o binding na org antiga; 3 leads da A num funil da B                 |
| I funil comum / vazio muda de org                         | ACEITO                                                         | etapas e leads em funil alheio / funil trocou de dono                           |
| E/F lead deixa funil e etapa discordando                  | `23503 green_stage_not_bound`                                  | nada (controle: fronteira de `crm_leads`, ADV-09)                               |
| G binding sobre lead torto (as duas direções, re-apontar) | ACEITO                                                         | lead Green incoerente com identidade                                            |
| G binding da org A sobre funil da B                       | ACEITO                                                         | binding em funil alheio                                                         |
| H remoção / re-apontamento do binding                     | aceito; DELETE auditado SEM contagem; UPDATE **sem auditoria** | leads saem do domínio sem registro do que saiu                                  |
| J/K DELETE de etapa/funil com leads Green                 | `23503` RESTRICT                                               | nada (controle)                                                                 |
| X1/X3 etapa/lead da A com estrutura da B                  | ACEITO (vs FK para inexistente: **oracle**)                    | etapa/lead da A dentro da estrutura da B; B não consegue apagar a própria etapa |
| AT3 etapa Green com 500 leads realocada                   | ACEITO                                                         | **500** leads Green incoerentes                                                 |
| AT5 funil Green com 500 leads muda de org                 | ACEITO                                                         | 500 leads, 2 etapas e o binding em estrutura alheia                             |
| AT4 arquivar com destino, 1 destino inválido em 500       | `23503 green_stage_not_bound`, nada move                       | nada (controle: a instrução é atômica)                                          |
| C2/C3/C6/C7 corridas estrutura × binding × lead           | binding comita sem esperar                                     | leads Green incoerentes/sem identidade                                          |

## 4. Classificação das operações (Fase 4)

| Operação                                                   | Classe                     | Contrato                                                                                 |
| ---------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| criar funil, criar etapa (inclusive em funil Green)        | CONFIGURAÇÃO               | aceita; etapa nasce vazia                                                                |
| renomear, recolorir, reordenar, hint, probabilidade, aviso | CONFIGURAÇÃO               | aceita; nenhum evento                                                                    |
| arquivar etapa com destino                                 | MUTAÇÃO DE DOMÍNIO         | cada card passa pela fronteira de `crm_leads` (canônico por card); a instrução é atômica |
| arquivar etapa/funil sem mover                             | CONFIGURAÇÃO               | leads seguem na etapa/funil, coerentes e Green                                           |
| DELETE de etapa/funil com leads                            | OPERAÇÃO PROIBIDA          | RESTRICT (upstream)                                                                      |
| DELETE de etapa/funil vazio (inclusive Green)              | CONFIGURAÇÃO               | cascata leva etapas e binding; remoção auditada com 0 soltos                             |
| quadro do onboarding em funil sem negócio                  | CONFIGURAÇÃO               | aceito (inclusive Green vazio)                                                           |
| etapa entra/sai de funil Green por UPDATE                  | OPERAÇÃO PROIBIDA          | `green_stage_relocation_forbidden` (nenhum writer do produto faz)                        |
| etapa entre funis comuns por UPDATE                        | upstream (fora do domínio) | aceita; lead torto não entra no Green depois (binding e fronteira recusam)               |
| funil/etapa muda de organização                            | OPERAÇÃO PROIBIDA          | `green_structure_tenant_immutable` (nenhum writer do produto faz)                        |
| criar binding / re-apontar binding                         | MIGRAÇÃO ADMINISTRATIVA    | só o dono; reivindica identidades (0505) e exige estrutura coerente (0507), atômico      |
| remover binding                                            | MIGRAÇÃO ADMINISTRATIVA    | só o dono; auditado com `released_leads`; identidades seguem `live`; histórico fica      |
| apagar organização                                         | política do tenant (0503)  | cascata; auditoria `org_deleted`; não redesenhada                                        |

## 5. Pipeline (Fases 7 e 8)

Escritas reais em `crm_pipelines`: criar, editar atributos, marcar padrão/clientes, arquivar/desarquivar,
excluir de vez (só sem negócio), configurar vocabulário/settings e renomear pelo onboarding. Nenhuma toca
`organization_id`.

- **Troca de tenant:** a base aceitava (manager das duas orgs pelo PostgREST, platform admin, `service_role`) e
  deixava binding, etapas e leads na org antiga apontando para um funil da nova (I1; AT5 com 500 leads). Agora
  `trg_green_structure_pipeline` (BEFORE UPDATE OF `organization_id`, `WHEN` mudou) recusa com
  `green_structure_tenant_immutable`, inclusive funil vazio (I3): estrutura não troca de dono. A decisão não lê
  nada de outra organização (não é oracle) e a recusa acontece antes de qualquer cascata; mesmo sem o trigger, as
  FKs compostas de etapa, lead e binding recusariam funil com dependentes.
- **Arquivar** funil Green com leads (o que a rota faz por padrão): configuração; leads seguem Green, coerentes, com
  identidade `live` (K4).
- **Excluir de vez:** com leads, RESTRICT (K1); vazio, a cascata leva etapas e binding e a remoção do binding é
  auditada com `released_leads = 0` (K2 no banco, N3 pela rota real).

## 6. Stages (Fase 6)

Respostas pedidas pela Fase 6, medidas na base (0506):

| Pergunta                                         | Base                                                                                                    | 0507                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| o banco permite trocar `crm_stages.pipeline_id`? | sim, para qualquer funil existente, de qualquer org (a FK simples passa por cima da RLS)                | só entre funis comuns da própria org; Green na origem ou no destino → recusa |
| a API permite?                                   | nenhuma rota/MCP/ação aceita `pipeline_id` (N2: o PATCH da rota não muda o funil); PostgREST direto sim | PostgREST direto recusa (P1, P2, P4)                                         |
| a RLS permite?                                   | sim para manager da org da etapa (USING e WITH CHECK só olham `organization_id` da etapa)               | a RLS é a mesma; a guarda decide depois dela                                 |
| quais leads ficam apontando para a etapa?        | todos (o `stage_id` deles não muda)                                                                     | nenhum caso Green chega a gravar                                             |
| o `pipeline_id` desses leads é atualizado?       | não                                                                                                     | -                                                                            |
| eles passam a tocar Green?                       | sim (A: entram pelo lado da etapa); os Green ficam incoerentes (B, C)                                   | não                                                                          |
| identidade reivindicada?                         | **não** (A: 3 de 3 sem identidade)                                                                      | -                                                                            |
| evento canônico nasce?                           | não                                                                                                     | -                                                                            |
| mismatch etapa/funil possível?                   | sim (B, C, AT3 com 500)                                                                                 | não no domínio                                                               |

Veredito da base: **BLOCKER** (uma escrita de uma linha reclassificava 500 leads sem tocar `crm_leads`). Contrato:
`trg_green_structure_stage` (BEFORE UPDATE OF `organization_id`, `pipeline_id`, `WHEN` mudou) recusa troca de
organização (`green_structure_tenant_immutable`) e qualquer troca de funil em que a origem OU o destino seja Green
(`green_stage_relocation_forbidden`), com ou sem leads (o produto não faz; recusar também a etapa vazia elimina a
corrida "realocação × INSERT"). Entre funis comuns da mesma org segue o upstream; um lead que fique torto ali não
entra no Green depois (o binding e a fronteira recusam). Destino em outra organização cai na FK composta, com a
mesma resposta de funil inexistente (D1).

## 7. Binding (Fase 5)

Revalidação do lifecycle v1.3 sem redesenho (o trigger `trg_green_binding_claims_identities` e a função da 0505
estão intactos; as suítes v1, v1.2 e v1.3 passam inteiras):

| Caso                                        | Resultado                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| binding com 0 leads                         | aceito (v1.3 B, K2, C5)                                                                                                              |
| binding com leads coerentes (5, 150, 500)   | todos `live`, uma linha por lead (v1.3 B, G controle, AT1: 500 numa transação)                                                       |
| binding sobre lead torto (as duas direções) | **contornava** o lifecycle na base: o lead entrava `live` mas incoerente (G). Agora `green_binding_structure_invalid`, atômico (AT2) |
| re-apontar o binding                        | mesma checagem no funil novo; o funil antigo passa a ser auditado (H2)                                                               |
| organização                                 | binding sobre funil de outra org: FK composta (G); antes aceito                                                                      |
| concorrência com INSERT/DELETE/move         | v1.3 C (9 cenários) verde; C3a/C3b, C6, C7 desta suíte                                                                               |
| identidade                                  | inalterada: o claim da 0505 roda primeiro; a checagem nova só pode recusar                                                           |
| idempotência                                | PK do binding; apagar e recriar não duplica (v1.3)                                                                                   |

As mutações estruturais de etapa/funil **contornavam** o binding de duas formas na base: (1) etapa movida para funil
já Green levava leads ao domínio sem passar pelo claim (A); (2) estrutura torta anterior ao binding entrava no
domínio pelo próprio claim (G). As duas estão fechadas.

## 8. Organization (Fases 7 e 9)

- **Funil/etapa não trocam de tenant** (§5, §6). A preferência arquitetural é confirmada pelo produto: nenhum
  writer muda `organization_id` de estrutura.
- **Etapa, binding e lead só apontam para estrutura da própria organização:** FKs compostas (§13). A RLS continua
  sendo a primeira fronteira; a FK é a que alcança o que a RLS não vê (o alvo da referência).
- **Cascata de organização (Fase 9, sem reabrir a zona de perigo):** O1 apaga uma org com funil Green, etapas,
  binding, 3 leads Green com identidade, livro-razão e eventos. Nada sobra em funis, etapas, leads e binding da org;
  as identidades ficam `retired` (UUID não reciclável); a vizinha fica idêntica (md5 de todas as tabelas estruturais
  e do rastro Green); a auditoria `green.binding_removed` sai com `org_deleted = true` e `released_leads = null` (os
  leads vão junto com o tenant, não são soltos). As suítes de lifecycle (cascata pelo platform admin, resíduo Green
  zero) seguem verdes. A política especial de tenant deletion não foi redesenhada.

## 9. Delete / archive (Fase 8)

Comportamento real do Deskcomm, medido (rotas reais em N1, N3, N5):

| Operação                              | Vazio                                       | Leads comuns                   | Leads Green                                       | Misto                    |
| ------------------------------------- | ------------------------------------------- | ------------------------------ | ------------------------------------------------- | ------------------------ |
| DELETE etapa                          | aceito (J4)                                 | RESTRICT                       | RESTRICT (J1)                                     | RESTRICT                 |
| arquivar etapa com destino (rota/MCP) | arquiva                                     | move sem canônico (N5)         | move pela fronteira, 1 canônico por card (J2, N1) | cada lead pela sua regra |
| arquivar etapa sem mover (PostgREST)  | arquiva                                     | leads ficam                    | leads ficam Green e coerentes (J3)                | idem                     |
| DELETE funil (`?definitivo=1`)        | cascata etapas + binding, auditada (K2, N3) | RESTRICT (a rota recusa antes) | RESTRICT (K1)                                     | RESTRICT                 |
| arquivar funil (padrão da rota)       | arquiva                                     | leads ficam                    | leads ficam Green (K4)                            | idem                     |

Nenhum DELETE estrutural deixa lead órfão, etapa ou funil incompatível, ou identidade inconsistente: RESTRICT e
CASCADE são os mesmos de antes, agora nas FKs compostas. Lead com etapa do funil Green e `pipeline_id` de outro
funil não consegue nascer (a fronteira recusa), então a cascata do funil Green vazio não esbarra em referência
escondida (K3). O arquivamento com destino da rota é UMA instrução para os leads (atômica, AT4) seguida de outra
para a etapa: o estado intermediário possível (leads movidos, etapa não arquivada) é estruturalmente válido (GAP-06).

## 10. Cross-tenant (Fase 10)

Ataques obrigatórios, todos recusados sem erro Green e sem oracle (assinatura completa do erro, com os UUIDs do
próprio atacante normalizados, idêntica para alvo Green, alvo comum e alvo inexistente):

| Ataque                                               | Base                                                                                              | 0507                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| X1 etapa da org A criada em funil da B               | aceito (Green e comum); FK só para inexistente                                                    | `23503` FK composta, igual nos três (banco e PostgREST real, P5)          |
| G binding da A sobre funil da B                      | aceito                                                                                            | `23503` FK composta                                                       |
| X3 lead da A com funil + etapa da B                  | aceito; inexistente dava FK: **oracle de existência**                                             | `23503`, igual nos três (banco e P6)                                      |
| X3b/X3c lead da A no próprio funil com etapa da B    | aceito                                                                                            | `23503`, igual a etapa inexistente                                        |
| X4 service_role realocando estrutura entre tenants   | aceito                                                                                            | etapa → funil da B: FK; funil → org B: `green_structure_tenant_immutable` |
| L manager da B tentando realocar etapa Green da A    | 0 linhas (RLS)                                                                                    | 0 linhas, igual para etapa comum                                          |
| X5 A lendo estrutura/binding da B                    | 0 linhas; schema `green` 42501                                                                    | igual                                                                     |
| X6 a B apagar a própria etapa depois das sondas da A | **falhava**: o lead da A prendia a etapa da B (RESTRICT) e o erro revelava a referência escondida | aceito (a sonda da A nunca grava)                                         |

Nenhuma leitura Green acontece para estrutura de outra organização: a guarda de etapa só consulta o binding da
própria org (`fn_is_green_pipeline(org da etapa, …)`) e a FK recusa o destino estrangeiro antes de qualquer efeito.

## 11. Atomicidade (Fase 12)

| Caso                                                          | Resultado                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| AT1 binding com 500 leads coerentes                           | 500 `live` numa transação (abaixo do teto de 8 s do PostgREST) |
| AT2 binding com 499 coerentes + 1 torto                       | recusado inteiro: 0 identidades, sem binding, foto idêntica    |
| AT3 etapa Green com 500 leads realocada                       | recusada inteira, foto idêntica (base: 500 incoerentes)        |
| AT4 arquivamento com destino de 500 leads, 1 destino inválido | nenhum move (a exceção da fronteira aborta a instrução)        |
| AT5 funil Green com 500 leads trocando de org                 | recusado inteiro (base: tudo em estrutura alheia)              |
| AT6 remoção de binding com 500 leads                          | uma linha de auditoria com `released_leads = 500`; 500 `live`  |

Nenhuma operação estrutural do contrato tem caminho parcial: ou é recusada antes de gravar (guardas BEFORE, FKs),
ou é uma instrução cujo trigger AFTER aborta tudo (binding, arquivamento em massa).

## 12. Concorrência (Fase 13)

Cada cenário com duas (ou três) conexões e ordem de commit escolhida; o invariante final conferido em todos é a
função `estruturaImpossivel` vazia (nenhum lead Green incoerente ou sem identidade `live`, nenhuma etapa/binding/lead
em estrutura alheia).

| Cenário                                                                         | Mecanismo                                                                                             | Resultado (base → 0507)                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1 realocar etapa para Green × INSERT de lead nela (lead em voo)                | a guarda recusa pelo destino Green; não depende de quem vê o lead                                     | base: realocação espera o lead e comita (lead Green sem identidade) → recusada; lead comum íntegro |
| C2a realocação comum→comum em voo × binding do destino                          | a guarda segura SHARE no binding; o INSERT do binding espera o commit e enxerga a etapa no lugar novo | base: binding comita sem ver → `green_binding_structure_invalid`                                   |
| C2b binding em voo × realocação para o destino                                  | o SHARE da guarda espera o binding comitar; o destino já é Green                                      | base: realocação comita → `green_stage_relocation_forbidden`                                       |
| C3a lead indo para etapa de outro funil (em voo) × binding desse funil          | lock SHARE ROW EXCLUSIVE em `crm_leads` (o mesmo da 0505) espera o lead                               | base: binding aceito com lead torto → recusado                                                     |
| C3b binding em voo × lead indo para etapa do funil                              | o lead espera o binding; a fronteira vê o funil Green                                                 | `green_stage_not_bound` nas duas (controle)                                                        |
| C4 DELETE de etapa × lead entrando nela (as duas ordens)                        | lock de linha da FK (agora composta)                                                                  | `23503` nas duas ordens; nada órfão (controle)                                                     |
| C5 DELETE de funil × binding dele (as duas ordens)                              | lock de linha da FK do binding                                                                        | binding cai na FK / funil vazio apagado com o binding (controle)                                   |
| C6 duas realocações comuns→X em voo × binding de X                              | o binding espera as DUAS (SHARE compatível entre elas)                                                | base: binding comita → recusado                                                                    |
| C7 rajadas (8 rodadas): realocações, binding, leads tortos, movimentos, DELETEs | todos os mecanismos juntos                                                                            | base: estrutura impossível já na 1ª rodada → nenhuma rodada deixa estrutura impossível             |

Custo e limites: a realocação de etapa toma SHARE em `green.product_pipeline_binding` (só quando o funil da etapa
muda, operação que o produto não faz) e a remoção/re-apontamento de binding toma o mesmo lock de `crm_leads` da 0505.
Sob contenção, realocação × binding × movimento de lead podem formar ciclo; o Postgres aborta um deles (`40P01`) e
nenhum estado impossível é comitado (C7 conta isso como resultado válido). Ver GAP-05.

## 13. Correção escolhida (Fase 11) e migration (Fase 15)

Ordem de preferência do pedido, aplicada:

1. **Constraints fortalecidas (o grosso):** as FKs simples `crm_stages_pipeline_id_fkey`, `crm_leads_pipeline_id_fkey`,
   `crm_leads_stage_id_fkey` e `product_pipeline_binding_pipeline_id_fkey` são TROCADAS por FKs compostas com
   `organization_id`, com o MESMO nome e a mesma ação de DELETE, sobre os índices únicos novos
   `uniq_crm_pipelines_id_org` e `uniq_crm_stages_id_org`. Fecham S8 inteiro (etapa/lead/binding em estrutura de
   outra org) e o oracle de existência, sem trigger. Mesmo nome porque o PostgREST embeda por nome
   (`crm_stages!crm_leads_stage_id_fkey`, `etapas:crm_stages!crm_stages_pipeline_id_fkey`) e trocar, em vez de
   acrescentar, mantém UMA relação entre cada par de tabelas (embed sem dica continua sem ambiguidade; P7 e N4).
2. **Trigger estrutural central (o mínimo que a FK não expressa):** `trg_green_structure_pipeline` e
   `trg_green_structure_stage` (BEFORE UPDATE com `WHEN` de mudança: custo zero para qualquer outra escrita) e
   `trg_green_binding_structure` (AFTER INSERT/UPDATE do binding). A auditoria de remoção do binding (0503) foi
   redefinida (cópia + `operation`, `released_leads`, `new_pipeline_id`) e ligada também ao UPDATE.
3. RPC, handler TS e condicionais em writers: **nenhum**. Nenhum writer foi tocado.

Por que não S1 universal (`crm_leads(stage_id, pipeline_id) → crm_stages(id, pipeline_id)`): mudaria o lead comum
(o lote do produto move leads entre funis só pela etapa, GAP-02) e não é preciso para o domínio: dentro dele a
fronteira de `crm_leads` já exige etapa do funil, e as duas portas estruturais (realocação e binding) agora também.

**Migration 0507** (0501-0506 intactas): bloco 0 de recusa explícita de estrutura impossível herdada
(`green_structural_legacy_violation`, contagens no detail, nada aplicado); índices; troca das FKs (idempotente:
só troca se a FK ainda for de uma coluna); guardas; checagem do binding; auditoria. Espelho idêntico no
`baseline.sql` antes da VARREDURA anon (cria função); linha no MANIFEST. Grants: as três funções novas revogadas de
`public`, `anon`, `authenticated` e `service_role` (só os triggers as executam; definer com `search_path = ''`); a
auditoria mantém os grants da 0503.

Upgrade 0506 → 0507 provado de três formas:

- **U1 (banco do teste, histórico estrutural):** o banco é rebaixado ao estado da 0506 (FKs simples, sem guardas,
  auditoria da 0503); recebe funil Green com 4 leads, funil comum com 3, um lead comum torto (como o lote faz), etapa
  arquivada e uma segunda org. A 0507 é aplicada **duas vezes**: dados idênticos (foto md5), as quatro FKs com 2
  colunas e validadas, identidades intactas, e as guardas de pé (realocação recusada; binding sobre o funil com o lead
  torto recusado).
- **U2 (estrutura impossível herdada):** etapa Green com leads movida para funil comum e etapa em funil de outra org,
  gravadas no estado da 0506. A 0507 recusa com `green_structural_legacy_violation` e
  `{"green_incoerente": 2, "etapa_em_funil_alheio": 1, …}`; nada é aplicado (FK segue de uma coluna, foto idêntica).
  Corrigida a estrutura, a 0507 passa.
- **Stack local com dados acumulados das spikes** (§16).

## 14. GREEN (Fase 16)

Mesma suíte, código da spike: **73/73** (base: 41 falham / 32 passam), install + update do baseline com
`ON_ERROR_STOP=1` verdes. Cada recusa é conferida na fronteira certa e contra a foto (nenhuma tabela mudou, nenhuma
estrutura impossível); "deu erro" nunca foi critério sozinho.

| Ataque (pedido)                                                                     | Veredito 0507                                                    | Classe                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| A etapa comum → funil Green (com e sem leads)                                       | `23514 green_stage_relocation_forbidden`, nada muda              | PROIBIDO COM ERRO DE DOMÍNIO        |
| B etapa Green → funil comum (com e sem leads)                                       | `23514 green_stage_relocation_forbidden`                         | PROIBIDO COM ERRO DE DOMÍNIO        |
| C etapa Green → outro funil Green                                                   | `23514 green_stage_relocation_forbidden`                         | PROIBIDO COM ERRO DE DOMÍNIO        |
| D etapa → funil de outra org                                                        | `23503` FK composta, igual a funil inexistente                   | PROIBIDO (FK, sem oracle)           |
| D etapa muda de organização                                                         | `23514 green_structure_tenant_immutable`                         | PROIBIDO COM ERRO DE DOMÍNIO        |
| E lead troca `pipeline_id` deixando etapa incompatível                              | `23503 green_stage_not_bound`                                    | CONTROLE (fronteira de lead)        |
| F lead troca `stage_id` deixando funil incompatível                                 | `23503 green_stage_not_bound`                                    | CONTROLE (fronteira de lead)        |
| F lead comum com etapa de outro funil comum                                         | aceito (upstream)                                                | CONTROLE LEGÍTIMO (fora do domínio) |
| G binding sobre funil coerente com leads                                            | aceito, todos `live`                                             | CONTROLE LEGÍTIMO                   |
| G binding sobre lead torto / re-apontar para torto                                  | `23514 green_binding_structure_invalid`                          | PROIBIDO COM ERRO DE DOMÍNIO        |
| G binding da org A sobre funil da B                                                 | `23503` FK composta                                              | PROIBIDO (FK)                       |
| H remover / re-apontar binding com leads                                            | aceito (dono); auditado com `released_leads`; identidades `live` | PASS (migração administrativa)      |
| H papéis de API escrevendo binding                                                  | `42501`                                                          | CONTROLE                            |
| I funil (Green, comum, vazio) muda de organização                                   | `23514 green_structure_tenant_immutable`                         | PROIBIDO COM ERRO DE DOMÍNIO        |
| J DELETE de etapa com leads Green                                                   | `23503` RESTRICT                                                 | CONTROLE                            |
| J arquivar com destino / sem mover / etapa vazia                                    | aceito; canônico por card quando move                            | CONTROLE LEGÍTIMO                   |
| K DELETE de funil Green com leads                                                   | `23503` RESTRICT                                                 | CONTROLE                            |
| K DELETE de funil Green vazio / arquivar                                            | aceito; remoção do binding auditada com 0                        | PASS / CONTROLE LEGÍTIMO            |
| L PostgREST de usuário (agent, manager alheio)                                      | 0 linhas (RLS), indistinguível de etapa comum                    | CONTROLE                            |
| M service_role sem contexto                                                         | mesmas recusas (o contexto não é a regra)                        | PROIBIDO COM ERRO DE DOMÍNIO        |
| N operações do produto (editar, criar, onboarding, seed, no-op de org, comum→comum) | aceitas                                                          | CONTROLE LEGÍTIMO                   |

Pelo PostgREST real (P1-P7) e pelo servidor Next real (N1-N5): ver §16.

## 15. Eventos (Fase 14)

Não resolvido aqui (GREEN-03); só registrado:

| Mutação estrutural                                    | Gera hoje                                                                                                            | Deveria gerar?                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| criar/editar/arquivar/apagar etapa ou funil sem mover | nada (EV2)                                                                                                           | não (configuração)                                                                 |
| arquivar etapa com destino                            | 1 `lead.stage_changed` canônico por card Green (J2, N1); o writer não emite evento legado (só `crm_lead_activities`) | sim, e já gera                                                                     |
| binding novo sobre leads existentes                   | nada: identidade `live`, nenhum evento de entrada (EV1)                                                              | **a decidir em GREEN-03**: os leads entram no domínio sem `green_transition=enter` |
| remoção / re-apontamento de binding                   | nada no `event_log`; uma linha em `api_audit_log` com `released_leads`                                               | **a decidir em GREEN-03**: os leads saem sem `green_transition=exit`               |
| realocação de etapa, troca de tenant                  | nada (recusadas)                                                                                                     | não (proibidas)                                                                    |
| cascata de organização                                | nada (o `event_log` vai junto; política do tenant)                                                                   | não                                                                                |

Nenhum gêmeo legado/canônico novo apareceu: nenhuma operação estrutural emite `lead.stage_changed` legado.

## 16. Regressão (Fase 17)

Ambiente: Windows 11, Docker Desktop; `test:db` em `pgvector:pg15` efêmero (install + update do baseline com
`ON_ERROR_STOP=1`); stack local `deskcomm-green-spike` (0506 → **0507 por upgrade**, com os dados acumulados das
spikes); Node 22.23.3 (`npx -p node@22`) para o build de produção do Next, o `next start` e os E2Es; `SENTRY_DSN=off`
(log: `[telemetria] Desligada`); suítes de banco uma de cada vez. Chaves do stack lidas do `kong.yml` por script e
passadas só ao processo filho; segredos do servidor gerados no scratchpad; nada impresso nem gravado no repositório.

| Suíte                                                                                                                            | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| suíte nova `green-structural-boundary` (banco)                                                                                   | **73/73** (base: 41 falham / 32 passam)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Green seladas: `green-lead-lifecycle`, `-v12`, `-v13`, `green-automation-origin`, `green-mutation-context` (v1, v2, v3) + a nova | **8/8 arquivos, 295/295**, nenhum teste antigo alterado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test:db` inteira                                                                                                                | **347/349 arquivos, 3040 passed, 1 expected fail, 1 skipped; 6 casos vermelhos em 2 arquivos por ambiente** (`fatal error: runtime: cannot allocate memory` do próprio cliente `docker` e `spawnSync docker UNKNOWN`, sob pressão de memória no host). Os 2 arquivos (`rls-completude-varredura`, `anexo-da-nota-interna-responde-a-lgpd`) reexecutados isolados: **2/2, 110/110**. Efetivo: 349/349, 3046 passed (1738 s). Automation origin: 348/348, 2971 passed. O delta de +75 casos inclui os 73 da suíte nova; os outros 2 não foram atribuídos a um arquivo (o reporter da corrida cheia não lista arquivos verdes) e nenhum falhou |
| `tsc --noEmit -p tsconfig.typecheck.json`                                                                                        | **exit 0**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `eslint` + `prettier --check` nos arquivos novos                                                                                 | 0 erros (`MANIFEST.md` já não era prettier-limpo na base; não reformatado)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| cercas de baseline/migration/MANIFEST/funil/etapa/embed (51 arquivos de `tests/unit`)                                            | **49/51 → 51/51**: `manifest-cita-caminho-que-existe` só até este relatório existir; `main-sem-migration-duplicada` caiu com `FATAL ERROR: Zone Allocation failed - process out of memory`; isolados, 7/7                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `vitest --project cercas` inteira                                                                                                | 263 arquivos; a corrida cheia (máquina sob carga: setup 571 s, import 712 s) deu 38 arquivos / 70 casos vermelhos, quase todos timeout e `spawnSync bash`. Diferencial: os 38 reexecutados na spike (24 vermelhos) e na base `bcfbafee` (worktree destacado, 12 vermelhos); os 13 que só a spike reprovou caíram por timeout e, reexecutados com a máquina calma, passaram (**13/13, 97 passed**). Ficam **11 arquivos vermelhos nas DUAS versões** (guarda de release/`gh`, executor de CI, scripts E2E em `bash`, `spawnSync bash ENOENT`, timeouts de imagem/LP). **Falha nova: 0**                                                      |
| E2E nova `structural-real` (PostgREST real + Next de produção)                                                                   | **12/12** (P1-P7, N1-N5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| E2E Green existentes (`postgrest-real`, `lifecycle-real`, `next-real-v3`, `automation-origin-real`)                              | **4/4 arquivos, 20 passed, 2 skipped** (os mesmos marcadores "sem stack" da selagem da automação)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| upgrade 0506 → 0507 no stack com dados reais                                                                                     | ver abaixo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| lead comum como controle                                                                                                         | F (etapa de outro funil comum aceita), N (comum→comum), N5 pela rota real (sem canônico), J/K controles, E2E existentes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Upgrade no stack com dados reais** (124 organizações, 324 funis, 1453 etapas, 654 leads, 591 tocando o Green,
100 bindings, 12627 identidades, 12772 linhas de livro-razão, 13010 eventos):

1. Primeira aplicação: **a 0507 recusou** com `green_structural_legacy_violation` e
   `{"green_incoerente": 4, …}`, nas duas tentativas, sem aplicar nada (foto md5 idêntica). Os 4 eram fixtures das
   corridas **v2** do diferencial `next-real-v3` (orgs `gv3-*`, 2026-10-01 17:25-17:28), gravadas quando o banco só
   tinha a fronteira v2 (sem ADV-09): funil comum + etapa do funil Green, identidade `live` pelo backfill da 0505,
   sem livro-razão. É o legado que o bloco 0 existe para pegar, e confirma o STRUCT-GAP-01 com dado real.
2. Correção administrativa explícita (`corrige-legado-stack.sql`, no scratchpad da sessão): o dono alinhou o
   `pipeline_id` de cada lead ao funil da etapa **pela fronteira de `crm_leads`**, com contexto de migração; nasceram
   4 `lead.stage_changed` canônicos `green_transition=enter` com o ator `spike-green-02-correcao-legado`, +4 linhas no
   livro-razão; nada apagado.
3. 0507 aplicada **duas vezes** (~0,5 s cada; a segunda só com `NOTICE` de "já existe"): dados idênticos à foto da
   etapa 2 (md5 de funis, etapas, leads, binding, identidades, livro-razão e `event_log`), as quatro FKs com 2 colunas
   e validadas, as quatro guardas instaladas. Depois disso rodaram os E2Es acima.

## 17. Gaps classificados

Classificação: BLOCKER (impede a selagem) · PRODUÇÃO (backlog obrigatório antes do deploy) · DÉBITO · INFO.

| ID               | Classe                 | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (base) STRUCT-B1 | BLOCKER → **fechado**  | Realocação de etapa (A/B/C/AT3) reclassificava até 500 leads sem tocar `crm_leads`, sem identidade e sem regra.                                                                                                                                                                                                                                                                                                                                   |
| (base) STRUCT-B2 | BLOCKER → **fechado**  | Funil/etapa trocavam de organização levando binding, etapas e leads para estrutura alheia (D, I, AT5).                                                                                                                                                                                                                                                                                                                                            |
| (base) STRUCT-B3 | BLOCKER → **fechado**  | Etapa/lead/binding apontavam para estrutura de outra org (X1, X3, G) com oracle de existência e trava cruzada de DELETE (X6).                                                                                                                                                                                                                                                                                                                     |
| (base) STRUCT-B4 | BLOCKER → **fechado**  | Binding sobre estrutura torta criava lead Green incoerente (G, AT2) e corridas estrutura × binding deixavam lead Green sem identidade (C2, C3a, C6, C7).                                                                                                                                                                                                                                                                                          |
| (base) STRUCT-B5 | PRODUÇÃO → **fechado** | Re-apontamento de binding soltava leads sem nenhum registro; a remoção não dizia quantos (H).                                                                                                                                                                                                                                                                                                                                                     |
| STRUCT-GAP-01    | PRODUÇÃO               | **Rollout da 0507.** (a) O bloco 0 recusa a migration se a base tiver estrutura impossível; rodar as mesmas contagens em produção antes (no stack local com os dados das spikes deu zero). (b) A troca das FKs valida na hora, varrendo `crm_leads`/`crm_stages` sob SHARE ROW EXCLUSIVE; com volume real, fazer `NOT VALID` + `VALIDATE CONSTRAINT` em janela.                                                                                   |
| STRUCT-GAP-02    | DÉBITO                 | **Lead comum "torto" (upstream).** Lead comum com etapa de outro funil da MESMA org continua possível (lote `fn_mover_leads_em_lote` cruza funis só pela etapa; PostgREST direto; realocação comum→comum). Fora do domínio não afeta o Green: o binding (`green_binding_structure_invalid`) e a fronteira (`green_stage_not_bound`) recusam a entrada dele. No produto o card some do quadro. S1 universal mudaria o lead comum e não foi pedido. |
| STRUCT-GAP-03    | DÉBITO (GREEN-03)      | Entrada no domínio por binding novo e saída por remoção/re-apontamento não geram evento canônico (`enter`/`exit`): ficam identidade `live` e a auditoria com `released_leads`.                                                                                                                                                                                                                                                                    |
| STRUCT-GAP-04    | DÉBITO                 | `lib/database.types.ts` descreve as quatro FKs com uma coluna; regenerar os tipos. Sem efeito em runtime (embeds por nome provados no PostgREST real, P7, e pela rota real, N4).                                                                                                                                                                                                                                                                  |
| STRUCT-GAP-05    | INFO                   | Custo de lock: remoção/re-apontamento de binding seguram escrita em `crm_leads` pelo tempo da transação (a mesma classe do claim da 0505; entra com LIFE-ADV-05); realocação de etapa toma SHARE no binding. Ciclo realocação × binding × movimento de lead sob contenção termina em `40P01` (um abortado, nenhum estado impossível).                                                                                                             |
| STRUCT-GAP-06    | INFO                   | Arquivar etapa com destino (rota/MCP) são duas instruções sem transação comum (upstream): o estado intermediário (leads movidos, etapa ativa) é estruturalmente válido e cada card passou pela fronteira.                                                                                                                                                                                                                                         |
| STRUCT-GAP-07    | INFO                   | Trocar `is_won`/`is_lost` de uma etapa Green muda o fechamento automático de quem ENTRAR nela (trigger upstream); não muda pertencimento nem os leads que já estão lá.                                                                                                                                                                                                                                                                            |
| STRUCT-GAP-08    | INFO                   | Outras referências a etapa/funil continuam com FK de uma coluna (`webhook_sources.default_stage_id`, `crm_leads.lost_from_stage_id`, `google_ads_conversion_rules`, `campaigns`): não decidem pertencimento ao domínio; upstream.                                                                                                                                                                                                                 |
| STRUCT-GAP-09    | INFO                   | A exclusão definitiva de funil pela rota conta negócios só por `pipeline_id`; um lead comum torto com etapa do funil faz a cascata cair em RESTRICT e a rota responde 500 genérico (upstream; no Green não ocorre, a fronteira impede o lead).                                                                                                                                                                                                    |
| STRUCT-GAP-10    | INFO                   | `released_leads` conta, não lista: cada lead solto mantém identidade `live`, mas não há registro por lead de qual remoção o soltou (depende da decisão de GREEN-03).                                                                                                                                                                                                                                                                              |
| herdados         | -                      | LIFE-ADV-05 (escala), AUTO-GAP-01..08, `GAP-SUPPRESSOR-V3`, EV-01B residual: intocados.                                                                                                                                                                                                                                                                                                                                                           |

Nenhum BLOCKER aberto.

## 18. Matriz de selagem (Fase 18)

| Critério                                             | Prova                                                                                                                                                                              | Resultado |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| stage não pode ser realocada e quebrar leads         | A, B, C, M, AT3, C1, C2b, P1, P2, P4; N2 (a rota não realoca)                                                                                                                      | SIM       |
| pipeline não pode trocar tenant silenciosamente      | I (Green, comum, vazio), AT5, X4, P3, P4                                                                                                                                           | SIM       |
| lead nunca fica stage/pipeline mismatch (no domínio) | `estruturaImpossivel` vazia após todo caso; E/F, G, AT2, AT4, C1-C7; upgrade recusa o legado (U2, stack)                                                                           | SIM       |
| binding continua seguro                              | v1.3 inteira verde; G, AT1, AT2, C2, C3, C6; claim da 0505 intacto                                                                                                                 | SIM       |
| remoção de binding tem contrato explícito            | H1, H2, AT6, K2, N3, O1: migração administrativa, só o dono, auditada com `released_leads`, identidades `live`                                                                     | SIM       |
| delete/archive de stage é seguro                     | J1-J4, C4, N1, N5, AT4                                                                                                                                                             | SIM       |
| delete/archive de pipeline é seguro                  | K1-K4, C5, N3                                                                                                                                                                      | SIM       |
| cross-tenant fechado                                 | X1-X6, D1, G (binding alheio), L, P5, P6; sem oracle (assinaturas idênticas)                                                                                                       | SIM       |
| operações estruturais multi-lead são atômicas        | AT1-AT6                                                                                                                                                                            | SIM       |
| concorrência não cria estado impossível              | C1-C7 (inclui rajadas de 8 rodadas)                                                                                                                                                | SIM       |
| lifecycle continua SEALED                            | `green-lead-lifecycle`, `-v12`, `-v13` e `lifecycle-real` verdes; nenhum teste de lifecycle alterado; funções da 0503-0505 intactas exceto a auditoria de remoção (cópia + campos) | SIM       |
| automation origin continua SEALED                    | `green-automation-origin` (arquivo inteiro) e `automation-origin-real` verdes; nada da 0506 alterado                                                                               | SIM       |
| regressão crítica = zero                             | §16                                                                                                                                                                                | SIM       |

## Veredito

Todos os critérios da matriz foram provados com o mesmo teste nas duas versões (base: 41 de 73 vermelhos, com até
500 leads reclassificados por uma escrita estrutural de uma linha; spike: 73/73) e pelos caminhos reais: PostgREST
real com sessão GoTrue e `service_role`, servidor Next de produção em Node 22 e upgrade de um banco com os dados
acumulados das spikes. A correção ficou na estrutura: quatro FKs fortalecidas (mesmo nome, mesma ação de DELETE),
duas guardas BEFORE UPDATE, uma checagem no binding e a auditoria de remoção completada. Nenhum writer foi tocado,
nenhum teste antigo foi alterado e o lead comum só perdeu o que era estado impossível (estrutura de outra organização).

O upgrade real encontrou legado impossível (4 leads Green incoerentes das corridas v2) e recusou sem aplicar nada,
como o contrato manda; a correção administrativa passou pela fronteira e deixou rastro canônico.

**STRUCTURAL BOUNDARY = SEALED.** Não é PASS limpo porque ficam gaps classificados, nenhum BLOCKER: STRUCT-GAP-01
(rollout da 0507: censo de legado e `NOT VALID` + `VALIDATE` com volume real) como PRODUÇÃO; STRUCT-GAP-02 (lead
comum torto, upstream), -03 (entrada/saída por binding sem evento, para GREEN-03) e -04 (tipos gerados) como DÉBITO;
os demais INFO.

Próxima tarefa prevista (não iniciada): SPIKE-GREEN-03 - Canonical Event Cutover.

Integridade: `spike/green-automation-origin-v1` intacta em `bcfbafeeb`; diff da spike só com adições (0501-0506 sem
diff); sem push, PR ou merge; `main` intocada; servidor Next parado e `.next/` removido; worktree da base removido
(junção antes); containers efêmeros da `test:db` removidos. O stack local `deskcomm-green-spike` ficou com a 0507
aplicada, os 4 leads legados corrigidos pela fronteira e as fixtures dos E2Es (orgs `green-st-*`). Chaves do stack
lidas do `kong.yml` por script e passadas só ao processo filho; segredos do servidor gerados no scratchpad da sessão;
nenhum valor impresso nem gravado no repositório.

STRUCTURAL BOUNDARY = SEALED
SPIKE-GREEN-02: PASS-COM-GAPS
