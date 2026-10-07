# GREEN-CRM-02 - Catálogo de Produtos Green e Produto da Oportunidade

Primeira fatia vertical do modelo corrigido pela GREEN-CRM-01.1, sobre a GREEN-BASELINE-1.0.
Banco, serviço, API, UI e testes. Este documento registra o que foi implementado e o que ficou
de fora; as decisões de produto e as alternativas descartadas vivem na
[GREEN-CRM-01](GREEN-CRM-01-PRODUCT-FOUNDATION.md) (seções 4, 14, 16 e 17) e não são repetidas aqui.

## 1. Problema

Nada no CRM dizia **o que** está sendo vendido numa oportunidade Green. O operador anotava em texto
livre ou em tag, e o produto era confundido com o funil. A correção canônica (GREEN-CRM-01.1):

```text
FUNIL != PRODUTO     PRODUTO != TAG     CONTATO != OPORTUNIDADE
crm_leads = oportunidade     produto = item estruturado do catálogo     funil = processo
```

## 2. Modelo (migration 0509)

`20261007100000_0509_green_product_catalog_and_lead_context.sql`, com o apêndice espelho no
`supabase/baseline.sql` e a linha no `MANIFEST.md`. As migrations 0501-0508 e
`green.product_pipeline_binding.product_key` **não foram tocadas**.

### 2.1 `public.green_products` (catálogo)

| Coluna                     | Regra                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `organization_id`    | por organização; `organization_id` imutável                                                                                        |
| `code`                     | `^[a-z][a-z0-9_]{1,62}$`, **único por organização**, **imutável** (identificador estável)                                          |
| `name`                     | 1 a 120 caracteres                                                                                                                 |
| `description`              | opcional, até 1000                                                                                                                 |
| `family`                   | texto **aberto**: o banco confere só a forma (`^[a-z][a-z0-9_]{0,62}$`). Nenhum `CHECK` lista `energy`/`license`. Padrão `generic` |
| `is_active`                | inativar preserva o histórico                                                                                                      |
| `metadata`                 | `jsonb` objeto, para atributo futuro sem coluna nova                                                                               |
| `created_at`, `updated_at` | automáticos                                                                                                                        |

O catálogo **não é semeado** pela migration e não hardcoda produto iGreen. Os nomes plural/singular
seguem a convenção real do repositório (`crm_leads`, `contacts`): `green_products`; o contexto 1:1
mantém o nome da fundação, `green_lead_context`.

### 2.2 `public.green_lead_context` (extensão 1:1 da oportunidade)

| Coluna                     | Regra                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `lead_id`                  | PK; FK composta `(lead_id, organization_id)` -> `crm_leads (id, organization_id)` `ON DELETE CASCADE`  |
| `organization_id`          | explícito; FK para `organizations`                                                                     |
| `product_id`               | **obrigatório**; FK composta `(product_id, organization_id)` -> `green_products (id, organization_id)` |
| `created_at`, `updated_at` | automáticos                                                                                            |

Decisão do pedido: a GREEN-CRM-01 §14.1 listava também situação da análise, elegibilidade e
estágio de cadastro. A GREEN-CRM-02 ficou **só com o necessário agora** (o produto principal). Esses
campos entram depois, aditivamente, quando houver consumidor.

Fora do contexto, por fronteira própria: tags, UTM, campanha, origem, catálogo, produtos adicionais,
inteligência regional, vínculo de expansão, histórico duplicado do lead.

### 2.3 Tenant provado pela estrutura

```text
green_lead_context (lead_id, organization_id)    -> crm_leads     (id, organization_id)  CASCADE
green_lead_context (product_id, organization_id) -> green_products (id, organization_id)  NO ACTION
```

- Nem `service_role` consegue gravar lead da organização A com produto da B (`23503`).
- Lead/produto de outra organização e lead/produto inexistente dão **a mesma recusa** (sem oracle).
- Índice único novo `uniq_crm_leads_id_org (id, organization_id)` para a FK composta.
- `NO ACTION` (não `RESTRICT`): a exclusão da organização cascateia contexto e produto no mesmo
  comando; fora disso, **produto usado não é apagado** (`23503`).

## 3. Oportunidade x produto

Cardinalidade V1 (D-17): **1 oportunidade -> 1 produto principal**, em `green_lead_context.product_id`.
Evoluível para "principal + adicionais" por tabela filha aditiva, sem migrar linha existente. Não há
N:N nem produto adicional nesta fatia.

### 3.1 Regras no banco (trigger `BEFORE` no contexto, vale para todo papel)

| Regra                                                                                                   | Erro nomeado                                                           | Quando                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| só lead de funil com binding Green (reuso de `green.fn_is_green_pipeline`; **nenhuma** flag `is_green`) | `green_context_outside_binding`                                        | INSERT ou troca de `product_id` |
| oportunidade `won`/`lost` não recebe nem troca de produto                                               | `green_context_lead_closed`                                            | INSERT ou troca de `product_id` |
| produto inativo não entra em nova associação                                                            | `green_product_inactive`                                               | INSERT ou troca de `product_id` |
| `lead_id`/`organization_id` do contexto e `code`/`organization_id` do produto são imutáveis             | `green_context_identity_immutable`, `green_product_identity_immutable` | UPDATE                          |

As regras olham a **mudança** de `product_id`, nunca o estado do produto já associado. Por isso a
oportunidade histórica com produto inativo continua legível e o contexto dela pode ser tocado
(`updated_at`) sem erro. O trigger toma `SHARE` no lead e no produto: fechar a oportunidade ou
inativar o produto em paralelo espera o commit (e vice-versa).

### 3.2 Histórico e fechamento

A GREEN-CRM-01.1 estava silenciosa sobre alterar o produto depois do fechamento. Regra conservadora
V1 adotada:

- `open`: produto pode ser atribuído e trocado por operador autorizado;
- `won`/`lost`: **alteração comum recusada** (inclui a primeira atribuição: não reescreve métrica
  retroativamente);
- reaberta (`open`): volta a ser editável;
- uma operação administrativa explícita de correção fica para depois (ver seção 9).

### 3.3 Produto inativo

- continua existindo (sem hard delete de produto usado);
- não é selecionável para **nova** associação (seletor da UI, API e banco recusam);
- oportunidades históricas continuam referenciando o produto e a leitura continua íntegra;
- a UI mostra o produto com o aviso "Produto inativo" e não o oferece no seletor;
- sair de um produto inativo para um ativo é permitido.

## 4. Funil != produto (prova)

Nenhuma coluna, tabela ou FK liga produto a funil: não há `green_products.pipeline_id`, nem
`green_pipeline_product`, nem FK entre `product_pipeline_binding` e o catálogo (em nenhum sentido).
`product_key` do binding segue sendo a chave **histórica de processo** (`conexao_green`, `expansao`).

Prova funcional (`tests/invariants/green-product-catalog.test.ts`, família `FP`): organização A com
"Produto Alfa", "Produto Beta" e o funil ConexãoGreen; duas oportunidades no **mesmo funil**:

- lead 1 -> Alfa, lead 2 -> Beta; ambos continuam em `pipeline_id` do mesmo funil;
- nenhum funil novo nasce (contagem de `crm_pipelines` igual antes e depois);
- nenhuma tag (`tags` vazio);
- trocar o produto não muda funil nem etapa;
- o mesmo produto serve a **mais de um** funil Green;
- o tenant B não enxerga produto nem contexto da A.

## 5. RLS e autorização

| Recurso              | Leitura                                                                                                           | Escrita                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `green_products`     | membro da organização (`fn_user_org_ids()`)                                                                       | `manager`+ (`fn_role_at_least`); **sem DELETE** para `authenticated` |
| `green_lead_context` | membro **e** lead visível (a subconsulta em `crm_leads` passa pela RLS do chamador, logo vale `fn_can_view_lead`) | `agent`+ e lead visível; **sem DELETE** para `authenticated`         |

`anon` não alcança nenhuma das duas. As travas de suporte (`support_write_*`, somente leitura em
sessão de suporte) são aplicadas por `fn_aplicar_travas_de_suporte()` ao fim da migration. A
organização vem sempre da sessão (`requireRole`), nunca do corpo; schemas Zod `.strict()` recusam
`organization_id` e `pipeline_id`.

`public.fn_green_lead_eligible(uuid)` (`security definer`, `search_path = ''`, `EXECUTE` só para
`authenticated`/`service_role`) responde "este lead é de funil Green e eu o enxergo?". Lead
inexistente, de outra organização ou invisível dá `false`.

## 6. Evento canônico

Um único tipo, **produzido só pelo banco** (trigger `AFTER`, mesma transação, via `fn_log_event`):

```text
lead.green_context_changed
  { lead_id, change: 'product_assigned' | 'product_changed',
    product_id, previous_product_id (null na 1a atribuição), changed_by }
```

- distingue "primeiro produto atribuído" de "produto alterado" por `change`, com antes/depois;
- emitido só quando `product_id` muda (tocar `updated_at` não emite; rollback não deixa evento);
- sem PII (ids apenas; nenhum nome, telefone ou e-mail);
- é fato, não comando: entra na lista de registro (`fn_event_log_e_registro`) e nasce `done`;
- **a API não emite evento**: ela só audita (`api_audit_log`: `green.product.created`,
  `green.product.updated`, `green.lead_context.updated`). Um produtor por fato.

Não há `crm_lead_activities` (timeline) para esta mudança nesta fatia; ver seção 9.

## 7. API

Fronteira em `lib/green/produto/` (`schemas.ts` compartilhado com a UI, `servico.ts`). As rotas só
autenticam, validam a forma e traduzem o resultado em HTTP; a integridade é do banco.

| Rota                                     | Papel    | Notas                                                                                                                                                    |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/green/products`             | viewer+  | só ativos; `?include_inactive=true` exige manager+                                                                                                       |
| `POST /api/v1/green/products`            | manager+ | `code` inválido 422; duplicado 409 `green_product_code_taken`                                                                                            |
| `PATCH /api/v1/green/products/[id]`      | manager+ | nome, descrição, família, metadata, `is_active`; `code` no corpo = 422; produto de outra organização = 404                                               |
| `GET /api/v1/leads/[id]/green-context`   | viewer+  | sem contexto = 200 com `context: null` (não escreve); funil comum = 404 `green_context_not_applicable`; devolve produto (inclusive inativo) e `editable` |
| `PATCH /api/v1/leads/[id]/green-context` | agent+   | `{ product_id }`; 1o save cria, os seguintes trocam; mesmo produto = 200 idempotente, sem escrita/evento                                                 |

Erros do PATCH do contexto: lead inexistente/de outra organização 404; funil comum 422
`green_context_outside_binding`; produto inexistente/de outra organização 422
`green_product_not_found` (mesma resposta); produto inativo 422 `green_product_inactive`;
`won`/`lost` 409 `green_context_lead_closed`. A recusa do banco (corrida) é traduzida igual.

## 8. UI

- **Catálogo:** Configurações -> Produtos Green (`/app/settings/produtos-green`, manager+, porta no
  `NAV_CATALOG`). Lista ativos e inativos, cria (código estável, nome, família aberta), edita
  nome/descrição/família e ativa/inativa. Sem preço, estoque, comissão, região, oferta ou combo.
  Nunca apaga.
- **Oportunidade:** seção "Produto Green" no `LeadDossier`, só em funil Green (a seção some sozinha
  no 404). Mostra o produto atual, oferece só produtos ativos, salva, e continua mostrando após
  recarregar. Produto inativo associado aparece com "Produto inativo". Ganho/perdido e viewer veem,
  sem formulário.
- A UI **não** cria funil, não move etapa, não grava tag e não filtra produto por binding (a seção
  fala só com `/green-context` e `/green/products`).

## 9. Limitações e próximos passos

- **Sem timeline:** a troca de produto não grava `crm_lead_activities`; o rastro é o evento do banco
  e a auditoria da API. Entrar na timeline é decisão de produto para a fatia seguinte.
- **Correção administrativa pós-fechamento** (trocar produto de oportunidade `won`/`lost`) não
  existe; precisa de operação explícita e auditada.
- **Seção Green no dossiê e GET por abertura:** cada abertura do dossiê chama
  `GET /green-context`; em instalação sem Green a resposta é 404 e a seção some. Se o custo importar,
  o board pode passar a informar "funil Green" no payload do lead.
- **Escopo do catálogo (DP-11):** V1 por organização; compatível com catálogo global futuro por
  coluna aditiva.
- **Binding:** continua escrito só pelo dono do banco (DP-01). O catálogo e o contexto não o alteram.
- **Próximas fatias:** GREEN-CRM-03 (fase por etapa e funis de fábrica) e GREEN-CRM-04 (expansão:
  nova oportunidade relacionada por `crm_lead_links`, dashboard por produto). Nada disso foi
  implementado aqui.
- `lib/database.types.ts` ganhou as duas tabelas e a função à mão (o cliente do servidor não é
  tipado por `Database`); regenerar quando houver um stack local limpo.

## 10. Testes

| Camada  | Arquivo                                                             | O que prova                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco   | `tests/invariants/green-product-catalog.test.ts` (24)               | catálogo (unicidade, imutabilidade, família aberta, sem hard delete), contexto 1:1, FKs compostas (incl. `service_role`), elegibilidade, produto inativo, `won`/`lost`, evento (um por mudança, `done`, sem PII, rollback), RLS por papel/visibilidade/tenant, funil != produto |
| API     | `tests/unit/green-produto-api.test.ts` (26)                         | papel mínimo, organização da sessão, validação, cada erro nomeado, GET sem contexto sem escrita, auditoria sem evento                                                                                                                                                           |
| UI      | `tests/unit/green-produto-ui.test.tsx` (16)                         | catálogo (lista, cria, edita sem `code`, inativa), dossiê (renderiza, seleciona, salva, recarrega, inativo, fechado, viewer, funil comum), separação funil x produto                                                                                                            |
| Guardas | `baseline`, `MANIFEST`, `i18n`, `navegação`, `suporte`, `auditoria` | espelho baseline x migration, tradução ES, porta de navegação, travas de suporte, código de auditoria                                                                                                                                                                           |

Rodar a suíte de banco: `CONFERENCIA_KIT_RELEASE=v1.69.0 pnpm test:db tests/invariants/green-product-catalog.test.ts`
(a variável existe porque a conferência do `update.sh` consulta a última release; sem rede ela exige o valor).
