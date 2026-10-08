# Vocabulário e Nomenclatura Oficial do ConectorGreen

Fonte única de verdade do **vocabulário de domínio** e da **nomenclatura de trabalho** do ConectorGreen. Princípio:
**nome humano primeiro, código técnico depois.** Nenhum identificador nem histórico anterior é destruído: o passado é
mapeado, não renomeado ([`CONECTORGREEN-EQUIVALENCE-MAP.md`](CONECTORGREEN-EQUIVALENCE-MAP.md)).

| Item          | Valor                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID            | CG-FND-08                                                                                                                                                      |
| Tipo          | DOC                                                                                                                                                            |
| Estado        | ADOTADO. GOV-01 a GOV-05 aprovadas pelo dono do produto em 2026-10-07 (seção 11)                                                                               |
| Data          | 2026-10-07                                                                                                                                                     |
| Base          | `GREEN-BASELINE-1.0`; vocabulário alinhado à [GREEN-CRM-01.1](../product/GREEN-CRM-01-PRODUCT-FOUNDATION.md) (seções 3.1, 16.2 e 17) e ao `GREEN-CRM-02`       |
| Não altera    | migrations 0501-0509, contratos selados, schema, API, UI, RLS, eventos, testes, nomes de branches, tags e commits existentes                                   |
| Fora de lugar | regras de produto (vivem em `docs/green/product/`), desenho dos contratos selados (vivem em `docs/spike/` e na baseline), política de upstream (ADR-GREEN-001) |

**Integração à `main`.** Este documento cita dois itens que, em 2026-10-07, estão concluídos só no checkpoint de cada
um e **não estão integrados à `main`**: a GREEN-CRM-01.1 (`CG-FND-07`, branch `green/crm-01-product-foundation`, commit
`a2d202168`), autoridade de semântica de domínio nas seções 1 e 9 e destino do link da linha "Base" acima, que só
resolve depois que ela for integrada; e a GREEN-CRM-02 (`CG-PRD-01`, branch `green/crm-02-product-catalog-context`,
commits `04ea1eb88` a `b36c81610`), dona da migration 0509 e de `public.green_products`. Na `main`, o MANIFEST termina na
0508; a 0509 segue reservada a `CG-PRD-01`, e por isso a próxima livre continua sendo a 0510. As referências descrevem o
estado factual desses checkpoints; integrar cada item à `main` é decisão separada (seção 6.3).

## 1. Precedência e uso

1. **Contratos selados e ADR-GREEN** mandam nos nomes **técnicos** (tabelas, colunas, funções, chaves, nomes de
   contrato). Este documento nunca os renomeia.
2. **Este documento** manda no **vocabulário em prosa** e na **nomenclatura de trabalho** (áreas, tipos, IDs, títulos,
   branches, commits). Documentos anteriores que divergem não são reescritos: valem o mapa de equivalência e a seção 3.4.
3. **Semântica de domínio** (o que é uma oportunidade, um funil, um produto) pertence à GREEN-CRM-01 seção 17. Se este
   documento a contradisser, o defeito é daqui e se corrige aqui.

Quem escreve documentação, título, commit, branch ou PR do ConectorGreen usa esta página. Itens já em andamento na data
de adoção ficam como estão (seção 9).

## 2. Princípios

1. **Nome humano primeiro.** O título visível começa pelo resultado para o negócio, não por um código.
2. **Quatro campos, quatro coisas.** Área, tipo, ID e nome humano são campos separados e nunca se fundem num só
   texto (seção 6).
3. **Identificador não se reutiliza e não se apaga.** Item cancelado continua no registro como cancelado.
4. **Vocabulário em prosa, nomes técnicos no código.** A UI e a documentação dizem "oportunidade"; o banco continua
   `crm_leads`. Nenhum dos dois força o outro.
5. **Poucas categorias.** Uma área ou um termo novo só entra com a justificativa da seção 9.
6. **Equivalência explícita.** Quando um item histórico foi dividido ou agregado, a relação é declarada como tal
   (`PARCIAL`), nunca presumida 1:1.

## 3. Glossário canônico

Colunas: **Termo** (forma recomendada), **Significado e fronteira**, **Na base** (nome técnico, que não muda),
**Sinônimos permitidos**, **Não recomendado**.

### 3.1 Núcleo do modelo (invariantes da GREEN-CRM-01.1)

```text
FUNIL != PRODUTO     PRODUTO != TAG     CONTATO != OPORTUNIDADE
```

| Termo        | Significado e fronteira                                                                                                                                                                                                                                                              | Na base                                        | Sinônimos permitidos                           | Não recomendado                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Contato      | Pessoa ou empresa. Existe antes, durante e depois de qualquer negócio. Tem **várias** oportunidades ao longo do tempo e ao mesmo tempo. Não é negócio e não carrega etapa, produto nem valor                                                                                         | `contacts`, `companies`, `people`              | pessoa, empresa (quando o tipo importa)        | "cliente" como entidade (é um estado ou segmento: ganhou, tag "cliente ativo")  |
| Oportunidade | Tentativa comercial de um contato: uma linha de `crm_leads`. Hoje **é** `crm_leads`; não existe segunda entidade "Green". É Green quando o funil dela tem binding. Declara o produto trabalhado. Pode ficar `open`, `won` ou `lost`; ganhar não a move de funil                      | `crm_leads` em funil com binding               | negócio (uso informal), oportunidade Green     | "lead Green", "deal", "oportunidade" como sinônimo de contato                   |
| Funil        | **Jornada ou processo operacional** (Novo, Contato, Qualificação, Proposta, Negociação, Ganho, Perda). Define como se trabalha, não o que se vende. O mesmo funil hospeda produtos diferentes. Funil Green é o `crm_pipelines` com binding. Funis de fábrica: ConexãoGreen, Expansão | `crm_pipelines`, `crm_stages`, binding         | pipeline (apenas em código e conversa técnica) | "funil do produto X", funil criado só para separar um produto                   |
| Etapa        | Posição do funil, com marcadores de ganho e perda (`is_won`, `is_lost`). Pertence a um funil                                                                                                                                                                                         | `crm_stages`                                   | estágio (evitar), fase (ver abaixo)            | usar "fase" para etapa de um funil                                              |
| Produto      | Oferta **estruturada** do catálogo Green: o que está sendo comercializado. Referenciado por FK a partir da oportunidade. Catálogo aberto; `energy` e `license` são exemplos, não enum                                                                                                | `public.green_products` (0509)                 | item do catálogo, oferta                       | produto como tag, como funil ou como enum fixo                                  |
| Catálogo     | O conjunto de produtos de uma organização. Aberto, com código imutável por organização                                                                                                                                                                                               | `public.green_products`                        | catálogo de produtos                           | confundir com `catalog_products` (catálogo de venda do Deskcomm, outro domínio) |
| Tag          | Classificação **livre e auxiliar** (alta prioridade, indicação, base outubro, campanha específica). Não substitui produto, funil nem origem                                                                                                                                          | `crm_leads.tags`, `contacts.tags`              | etiqueta                                       | tag para guardar produto, origem ou etapa                                       |
| Lead         | Nome do CRM genérico para a linha de `crm_leads`. No ConectorGreen a linha chama-se **oportunidade**. "Lead" fica para o código, o CRM genérico e os eventos (`lead.won`) e, em prosa, para o ato de captura quando a precisão não importa                                           | `crm_leads`, eventos `lead.*`                  | lead (CRM genérico, código, eventos)           | "lead Green" como entidade; usar lead e oportunidade como coisas diferentes     |
| Expansão     | **Nova oportunidade** aberta para um contato já convertido, no funil Expansão, com o produto que está sendo trabalhado (pode diferir do original). Ligada à de origem por vínculo de origem comercial. Nunca a oportunidade ganha movida de funil                                    | `crm_leads` + `crm_lead_links` (kind abaixo)   | oportunidade de expansão                       | "mover para expansão"; "upsell" ou "cross-sell" como nome de entidade           |
| Origem       | Por onde a oportunidade ou o contato **entrou** (`meta_ads`, `google_ads`, `site`, `whatsapp`, `referral`, planilha). Vocabulário aberto. Não é tag. Em prosa ambígua, escrever **origem de entrada**                                                                                | `crm_leads.source`, `contacts.source`          | origem de entrada, fonte                       | "origem" sozinha quando houver dúvida entre as três origens da seção 3.4        |
| Campanha     | Iniciativa de **aquisição** identificável (anúncio, UTM, ação orgânica). Vive em metadado da origem                                                                                                                                                                                  | `source_metadata`, `webhook_lead_captures.utm` | campanha de aquisição                          | "campanha" para disparo de mensagens em massa (use **disparo**; ver seção 3.4)  |

### 3.2 Termos de apoio ao modelo

| Termo                       | Significado e fronteira                                                                                                                                                                                    | Na base                                                          | Não recomendado                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Fase canônica               | Identidade estável de uma etapa independente de funil e produto (GREEN-CRM-01 seção 5.1). **Fase** só se diz neste sentido                                                                                 | proposto (`green_stage_phase`, futuro)                           | fase como sinônimo de etapa                             |
| Binding                     | Ligação de um funil a um processo Green. Marca o funil como Green                                                                                                                                          | `green.product_pipeline_binding`                                 | tratar o binding como produto                           |
| Chave de processo           | O que o binding guarda: o processo que o funil implementa (`conexao_green`, `expansao`). **Não é produto**                                                                                                 | coluna `product_key` (nome legado, não muda)                     | chamar de "chave de produto"                            |
| Vínculo de origem comercial | Ligação da oportunidade de expansão à oportunidade que a originou (`link_kind = commercial_origin`). A de destino é a **oportunidade de origem**                                                           | `crm_lead_links`                                                 | confundir com a origem de entrada (`source`)            |
| Aquisição                   | **Esforço** de trazer demanda: tráfego pago, orgânico, indicação, ações. É estratégia e custo, não mecanismo técnico                                                                                       | conceito (campanha, UTM, origem)                                 | "captação" (ver seção 3.4)                              |
| Captura                     | O **fato** de a pessoa ter entrado (formulário, WhatsApp, importação, indicação). Não é entidade                                                                                                           | `source`, `source_metadata`, `external_id`, registros de captura | tratar captura como tabela própria                      |
| Ingestão                    | O **mecanismo** que traz o dado para o modelo: webhook de entrada, importação de planilha, formulário, mapeamento e deduplicação. Toda fonte converge para contato + oportunidade pelos writers existentes | `webhook_sources`, `webhook_lead_captures`, importações          | criar mecanismo de ingestão paralelo para o Green       |
| Integração                  | Conexão contínua com sistema externo através de porta e adapter (leitura, escrita ou ambos), sem decidir o modelo de domínio                                                                               | adapters e portas                                                | usar integração para o que é só ingestão de entrada     |
| Automação                   | Regra executada pelo motor sem ação humana (gatilho, condição, ação). A escrita da regra declara `service_origin.kind = automation`                                                                        | `automation_rules`                                               | chamar de automação um passo manual ou um script avulso |
| Atividade                   | Registro **legível** da linha do tempo da oportunidade ou do contato (nota, mudança, mensagem)                                                                                                             | `crm_lead_activities`                                            | usar atividade para fato de domínio de máquina          |
| Evento                      | **Fato de domínio** emitido no barramento (`lead.won`, `lead.stage_changed`), consumido por automações e integrações. Tem um dono por fato (CANONICAL EVENT CUTOVER)                                       | `event_log`                                                      | usar evento como sinônimo de atividade                  |
| Tarefa                      | Compromisso de follow-up do CRM atribuído a alguém. **Item de trabalho** é outra coisa (seção 6): em governança de projeto nunca se diz só "tarefa"                                                        | tarefas do CRM                                                   | chamar de tarefa o item de trabalho `CG-...`            |
| Organização                 | O tenant. Toda entidade tenant-scoped tem `organization_id`                                                                                                                                                | `organizations`                                                  | "workspace" (nome do v0, não se aplica a esta base)     |
| Usuário / Licenciado        | **Usuário** é o membro da organização. **Licenciado** é o usuário que vende; não é entidade. Dado comercial do licenciado, se existir, é outra entidade futura                                             | `user_organizations`                                             | tratar licenciado como contato                          |
| Parceiro de indicação       | Quem indicou e não é usuário (futuro)                                                                                                                                                                      | proposto (futuro)                                                | confundir com origem `referral`                         |

### 3.3 Termos do trabalho de engenharia

| Termo            | Significado                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fundação         | **Duas coisas, desambiguadas pelo contexto.** (a) A área `CG-FND`, que abriga o que sustenta o produto: baseline, contratos selados, modelo de produto, governança. (b) O Deskcomm v1.69.0 como "fundação histórica" (ancestral). Em texto ambíguo, escrever "fundação Deskcomm" para (b) |
| Baseline         | A fundação **adotada e selada**: `GREEN-BASELINE-1.0` (tag, documento e estado do código). Referência estática; novas baselines têm outro nome                                                                                                                                            |
| Contrato selado  | Regra provada em suíte e adotada na baseline; só muda por ADR `GREEN-NNN` (baseline seção 4). Hoje cinco: MUTATION BOUNDARY, LEAD LIFECYCLE, GREEN AUTOMATION ORIGIN, STRUCTURAL BOUNDARY, CANONICAL EVENT CUTOVER. Os nomes dos contratos ficam em inglês e maiúsculas                   |
| Spike            | Experimento delimitado e descartável cujo produto é **conhecimento**, não funcionalidade. Os spikes históricos mantêm o nome `SPIKE-*`; o que foi adotado vive na baseline                                                                                                                |
| Item de trabalho | A unidade rastreável de trabalho do ConectorGreen. Tem área, tipo, ID e nome humano (seções 4 a 6)                                                                                                                                                                                        |

### 3.4 Ambiguidades reais resolvidas

| Ambiguidade                                | Resolução                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead x oportunidade                        | Mesma linha (`crm_leads`). No ConectorGreen diz-se **oportunidade**. Não há "lead Green". No v0 `lead` era captura; nesta base captura é atributo (GREEN-CRM-01 seção 3.1)                                                                                                                                                        |
| Três sentidos de "origem"                  | **Origem de entrada** (`source`: por onde entrou). **Vínculo de origem comercial** (`commercial_origin`: de qual oportunidade a expansão nasceu). **Origem da escrita** (`service_origin.kind`: quem escreveu, humano, automação, serviço; contrato AUTOMATION ORIGIN). Escrever o nome completo quando houver chance de confusão |
| Aquisição, captação, captura, ingestão     | Aquisição = o esforço. Captura = o fato. Ingestão = o mecanismo. **Captação** não é termo canônico: soa como as três; usar a palavra exata                                                                                                                                                                                        |
| Campanha                                   | **Campanha de aquisição** (anúncio, UTM, origem) é a canônica. O Deskcomm também tem campanha de mensagens em massa (`campaign_recipients`): chamar **disparo** em texto do ConectorGreen quando for esse caso                                                                                                                    |
| Atividade x evento                         | Atividade é registro legível na linha do tempo. Evento é fato de máquina no barramento. Um comando relevante pode gerar os dois; um não substitui o outro                                                                                                                                                                         |
| Fase x etapa x estado                      | **Etapa** é do funil. **Fase canônica** é a identidade estável da etapa entre funis. **Estado de CRM** é `(funil, etapa, status)`. **Estado do negócio Green** é a situação da análise e do cadastro (futuro)                                                                                                                     |
| `product_key` guarda processo, não produto | Coluna legada de `green.product_pipeline_binding`. Em prosa: **chave de processo**. A coluna não é renomeada (migrations seladas)                                                                                                                                                                                                 |
| P0 / P1 / P2                               | No `PRODUCTION-READINESS.md` são **classes de severidade**. Não são fases nem entregas. Nunca usar `P0` como prefixo de item de trabalho                                                                                                                                                                                          |
| "Tarefa"                                   | Compromisso de follow-up do CRM. Item de trabalho do projeto é **item de trabalho** (ou pelo tipo: feature, correção, spike...)                                                                                                                                                                                                   |
| Workspace x organização                    | Nesta base o tenant é a **organização**. "Workspace" pertence ao v0 e não é usado                                                                                                                                                                                                                                                 |
| Pipeline x funil                           | **Funil** em prosa e na UI; `pipeline` somente em código e conversa técnica                                                                                                                                                                                                                                                       |

## 4. Áreas e prefixos

Uma área responde à pergunta "**qual capacidade do ConectorGreen este item muda?**", não "quem faz" nem "qual tecnologia".
Todo item tem **exatamente uma** área principal; áreas secundárias vão na descrição.

### 4.1 Taxonomia ratificada (14 áreas, GOV-02)

| Prefixo  | Nome humano (usado nos títulos) | Escopo                                                                                                                                 | Não é (vai para)                                                        |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `CG-FND` | Fundação                        | Baseline, contratos selados e sua evolução, modelo de produto, política de upstream, vocabulário e governança do próprio projeto       | Deploy e CI (`CG-INF`); permissões de produto (`CG-IAM`)                |
| `CG-COM` | Comercial                       | Contatos, **oportunidades**, funis, etapas, atividades comerciais, follow-up, tarefas, ganho e perda, dossiê da oportunidade           | Catálogo e produto (`CG-PRD`); pós-ganho (`CG-EXP`); métricas (`CG-BI`) |
| `CG-PRD` | Produtos                        | Catálogo de produtos Green, regras dos produtos e o produto da oportunidade                                                            | Funil (`CG-COM`); tag (`CG-COM`)                                        |
| `CG-EXP` | Expansão                        | Funil Expansão, regra de expansão pós-ganho, licenciado e pós-venda, parceiro de indicação                                             | Criar oportunidades de qualquer outro funil (`CG-COM`)                  |
| `CG-ING` | Ingestão                        | **Entrada** de contato e oportunidade: webhook de entrada, formulário, importação de planilha, mapeamento de campos, deduplicação      | Atribuição e custo (`CG-MKT`); conectores bidirecionais (`CG-INT`)      |
| `CG-MKT` | Aquisição                       | Origem, campanha, UTM, tráfego pago e orgânico, atribuição e custo de aquisição                                                        | O mecanismo de entrada (`CG-ING`); painel de resultado (`CG-BI`)        |
| `CG-AUT` | Automações                      | Motor de regras, gatilhos, condições, ações, regras de expansão automática, origem de automação                                        | Mensageria WhatsApp em si (`CG-ZAP`)                                    |
| `CG-ZAP` | WhatsApp                        | ConectorZap (extensão do navegador) e a fronteira com o canal WhatsApp: instalação, abordagem, eventos de canal                        | Regra do motor que dispara mensagem (`CG-AUT`)                          |
| `CG-DAT` | Dados                           | Dados de referência e inteligência regional (distribuidoras, cobertura por município e DDD, ofertas), qualidade e modelagem de dados   | Dados pessoais e LGPD (`CG-SEC`); dashboards (`CG-BI`)                  |
| `CG-BI`  | Métricas                        | Métricas, relatórios e dashboards (ganho por período, por origem, por produto, por atendente)                                          | Coleta de origem e campanha (`CG-MKT`)                                  |
| `CG-INT` | Integrações                     | Conexão com sistemas externos por porta e adapter: iGreen, ERPs, anúncios (via API), webhooks de saída                                 | Entrada de oportunidade por webhook (`CG-ING`)                          |
| `CG-IAM` | Acesso                          | Identidade, membros, papéis, permissões, visibilidade de dados, hierarquia comercial (que **não** implica acesso a dados pessoais)     | Hardening e vazamento (`CG-SEC`)                                        |
| `CG-INF` | Infraestrutura                  | Deploy, ambientes, CI, Docker, banco local, observabilidade, backup, custos de operação                                                | Segredo e superfície de ataque (`CG-SEC`)                               |
| `CG-SEC` | Segurança                       | Hardening transversal, segredos, LGPD e minimização de dados pessoais, modelo de ameaça, varreduras, endurecimento de RLS e de funções | Quem pode fazer o quê no produto (`CG-IAM`)                             |

### 4.2 Mudanças em relação à proposta inicial

| Proposta inicial | Decisão      | Justificativa                                                                                                                                                                                                                               |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CG-LEAD`        | **Removida** | Duplicava `CG-COM`: a oportunidade é o centro do comercial, não existe segundo domínio de "lead". O prefixo também perpetuaria o termo que a GREEN-CRM-01.1 retirou do vocabulário Green. Oportunidade, funil e follow-up ficam em `CG-COM` |
| `CG-FND`         | Ampliada     | Passa a abrigar também o **modelo de produto** (GREEN-CRM-01, "fundação funcional") e a governança do projeto. Evita criar uma área só para documentos de modelagem e de vocabulário                                                        |
| Demais 13        | Mantidas     | Sem fusão: cada uma tem fronteira testável pela árvore da seção 4.3. Nomes humanos encurtados (WhatsApp, Dados, Métricas, Acesso) para caber nos títulos                                                                                    |

Resultado: 15 propostas, 14 áreas. Nenhuma criada.

### 4.3 Como escolher a área (nesta ordem; vale a primeira que responde "sim")

1. O item muda **contrato selado, baseline, modelo de produto ou o próprio vocabulário**? `CG-FND`.
2. Muda **quem pode ver ou fazer** algo no produto (papel, permissão, visibilidade)? `CG-IAM`.
3. O resultado é **proteger** (segredo, LGPD, hardening, ameaça)? `CG-SEC`.
4. O resultado é **rodar** o sistema (deploy, CI, ambiente, banco local)? `CG-INF`.
5. Toca o **WhatsApp ou a extensão ConectorZap**? `CG-ZAP`.
6. É o **motor de regras** (gatilho, condição, ação)? `CG-AUT`.
7. É o **catálogo, as regras dos produtos ou o produto da oportunidade**? `CG-PRD`.
8. É o **pós-ganho**: expansão, licenciado, parceiro? `CG-EXP`.
9. Faz um contato ou uma oportunidade **entrar** (webhook, planilha, formulário)? `CG-ING`.
10. É **origem, campanha, UTM, tráfego ou custo** de aquisição? `CG-MKT`.
11. É **conexão com sistema externo** que não é só entrada? `CG-INT`.
12. É **dado de referência ou regional**? `CG-DAT`.
13. É **medir ou exibir** resultado? `CG-BI`.
14. Caso contrário, é trabalho sobre contato, oportunidade, funil ou follow-up? `CG-COM`.

Desempates: escolher pelo **resultado entregue**, não pela tecnologia usada. Se dois itens parecem dois resultados, são dois
itens. Item que realmente atravessa áreas é dividido, e cada parte recebe a sua (seção 6.5).

## 5. Tipos de trabalho

O **tipo** diz qual é a natureza da entrega e que prova se espera. É um campo independente da área, do ID e do nome.

| Tipo    | Quando usar                                                                                                                                           | Entrega esperada                                                     | Não usar quando                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `FEAT`  | Nova capacidade ou mudança intencional de comportamento visível ao negócio ou ao operador                                                             | Código, testes, documentação, migration se preciso                   | Só corrige um defeito (`FIX`)                                      |
| `FIX`   | Corrigir comportamento que **já estava entregue** e diverge do contrato ou da intenção. Inclui dívida técnica registrada sem mudança de comportamento | Correção na causa raiz e teste que falhava antes                     | Comportamento novo (`FEAT`)                                        |
| `SPIKE` | Perguntar algo incerto num prazo curto; o produto é a **resposta**. Pode ser descartável                                                              | Relatório e, se houver código, marcado como descartável              | A solução já é conhecida (`FEAT`)                                  |
| `AUDIT` | Verificação **independente** de um item pronto, com veredito e achados. Não corrige                                                                   | Relatório com veredito; correções viram `FIX` ou nova rodada         | Verificar o próprio trabalho em andamento (isso é teste)           |
| `DOC`   | Entrega cujo produto é documentação, modelagem, vocabulário ou decisão, sem mudar comportamento                                                       | Documento no lugar certo, links verificados                          | Documentar uma `FEAT` (a documentação faz parte da `FEAT`)         |
| `OPS`   | Operar ou configurar o ambiente: deploy, CI, infraestrutura, rotação, backup. Sem mudar comportamento do produto                                      | Procedimento executado e evidência                                   | Mudança de código do produto (`FEAT` ou `FIX`)                     |
| `MIG`   | A entrega **é** a mudança de schema ou de dados: nova tabela isolada, endurecimento, backfill, porte de migration do upstream                         | Migration versionada, linha no MANIFEST, espelho no baseline, testes | A migration é parte de uma capacidade maior (então é `FEAT`/`FIX`) |

Sem tipos `REFACTOR`, `TEST`, `CHORE` ou `HOTFIX`: refatoração e testes acompanham o item que os exige; a urgência de uma
correção é prioridade, não tipo. Tipos de **commit** (seção 8) são outro eixo e não precisam coincidir com o tipo de trabalho.

## 6. Identificação

### 6.1 Formato

```text
CG-<ÁREA>-<NN>
```

- `<ÁREA>` é o código de três letras (ou `BI`) da seção 4. `<NN>` é um sequencial **por área**, com dois dígitos, e passa a
  três dígitos depois do 99 (`CG-PRD-100`).
- O ID **não carrega tipo** (`CG-PRD-01`, nunca `CG-FEAT-PRD-01`), nem fase, nem data, nem versão. Se o item mudar de tipo,
  o ID não muda.
- Exemplos: `CG-PRD-01`, `CG-COM-04`, `CG-FND-08`.

### 6.2 Reserva e colisão

1. O ID nasce **no registro** ([`CONECTORGREEN-EQUIVALENCE-MAP.md`](CONECTORGREEN-EQUIVALENCE-MAP.md), seção 1), com estado
   `RESERVADO`, **no primeiro commit** da branch do item, antes de qualquer outro documento citá-lo.
2. O próximo número é o **maior já registrado na área + 1**, incluindo itens cancelados. Não existe contador separado,
   para não envelhecer.
3. Duas branches que reservarem o mesmo número colidem **na mesma linha do registro** como conflito de merge. Quem
   fundir depois pega o número seguinte e corrige suas referências antes do merge.
4. Reservar sem usar é permitido (estado `RESERVADO`); o número fica ocupado.

### 6.3 Ciclo de vida do registro

`RESERVADO` -> `EM ANDAMENTO` -> `CONCLUÍDO`; ou `CANCELADO`; ou `SUBSTITUÍDO` (aponta o item que o substituiu).
`CONCLUÍDO` significa que a entrega do item chegou ao seu checkpoint. Não significa aprovação de push, PR, merge nem release:
essas são decisões separadas, tomadas pelo dono do produto, e não se deduzem do estado nem de um `GOV-NN` de nomenclatura.
**Nenhum ID é reutilizado nem removido.** Um item cancelado permanece com a linha e o motivo.

### 6.4 Revisão

- **Revisão** (mesmo resultado, escopo corrigido ou refeito depois de auditoria): sufixo `.N` no mesmo ID
  (`CG-PRD-01.1`). Não gera número novo, mas é anotada no registro com data e motivo.
- Revisão **não** é para escopo novo. Escopo novo é item novo.
- Os sufixos históricos (`01.1`, `v1.2`, `v1.3`) **não** são reescritos como `.N`; ver o mapa.

### 6.5 Divisão e agregação

- **Divisão**: o item original continua como pai e cada parte recebe ID próprio, com "Origem: `CG-XXX-NN`". A parte é um
  item completo, não uma subtarefa.
- **Agregação**: um item pode agrupar vários trabalhos históricos (ver mapa); nesse caso a relação é `PARCIAL` e os
  identificadores históricos permanecem citáveis.
- Letras (`A`, `B`) e sufixos de sessão **não** existem no ID. O nome da sessão pode usar o ID e o nome humano completos.

### 6.6 O que **não** é ID de item de trabalho

| Identificador                                | Natureza                                          | Regra                                                            |
| -------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `ADR-GREEN-NNN`                              | Decisão arquitetural                              | Série própria (ADR-GREEN-001). Cita o item de trabalho de origem |
| `D-NN`, `R-NN` dentro de um documento        | Decisão e risco locais ao documento               | Citar com o ID do item: `CG-FND-07/D-15`                         |
| `0509`, `0510`...                            | Número de migration                               | Sequência própria (MANIFEST). Próxima: `0510`                    |
| `LIFE-ADV-NN`, `V12-ADV-NN`, `S23`, `MC1`... | Achados e casos de relatório                      | Escopo local do relatório; não viram ID de item                  |
| `P0`, `P1`, `P2`                             | Classe de severidade do `PRODUCTION-READINESS.md` | Não é fase nem entrega                                           |
| Tags (`GREEN-BASELINE-1.0`, `v1.69.0`)       | Marcos do Git                                     | Imutáveis; citar o ID do item que as produziu, se existir        |

## 7. Nomes humanos

### 7.1 Formato

```text
Área humana — Resultado ou capacidade
```

Exemplo: **Produtos — Catálogo e produto da oportunidade**, ID técnico `CG-PRD-01`.

O separador é o travessão `—` com um espaço de cada lado, **apenas** nesta posição (entre a área humana e o resultado). O
ID, o tipo e o estado ficam em campos próprios, nunca dentro do nome. O travessão não vale para convenções técnicas
(branch, commit, tag, nome de arquivo), que seguem a seção 8.

### 7.2 Regras

1. **Concisão.** Até cerca de 60 caracteres no total. Resultado com 2 a 7 palavras.
2. **Resultado, não atividade.** "Catálogo e produto da oportunidade", não "Implementar tabelas de produto".
3. **Capitalização de frase.** Maiúscula na primeira palavra da área e do resultado; o restante em minúsculas, exceto nome
   próprio (ConectorGreen, ConectorZap, iGreen, WhatsApp, Meta). Sem ponto final.
4. **Vocabulário do glossário.** Usa "oportunidade", "funil", "produto"; não usa "lead Green", "captação" nem nome de tabela.
5. **Sem código técnico no começo.** O ID aparece depois do nome ou em campo próprio; nunca antes do nome humano.
6. **Desambiguação.** Se dois itens da mesma área ficarem com nomes parecidos, acrescentar o diferencial no **resultado**
   (o que muda), não numeração: "Comercial — Dossiê com histórico de produto" e não "Comercial — Dossiê 2".
7. **Estável.** O nome humano pode melhorar por revisão (anotada no registro); o ID não muda.

### 7.3 Onde cada forma aparece

| Lugar                              | Forma                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Título (H1) de documento de item   | `# Produtos — Catálogo e produto da oportunidade`                                                       |
| Tabela de metadados do documento   | Linhas `ID`, `Tipo`, `Área`, `Estado`, `Equivalência histórica`                                         |
| Lista, quadro, relatório, registro | Colunas separadas: Nome humano, ID, Tipo, Estado                                                        |
| Título de PR                       | `Produtos — Catálogo e produto da oportunidade (CG-PRD-01)`; o ID vai ao final por causa do truncamento |
| Nome de sessão de IA               | O mesmo texto do PR                                                                                     |
| Texto corrido                      | Nome humano na primeira menção; depois pode abreviar para o ID                                          |

### 7.4 Limites: sidebars e interfaces de ferramentas externas

Este padrão rege o que **o projeto escreve**: documentos, registro, PRs, nomes de sessão digitados, mensagens de commit. Ele
**não** controla, e este documento não afirma que se possa renomear automaticamente:

- barras laterais e listas de ferramentas (editor, aplicativo de assistente, GitHub, gerenciador de tarefas), que
  ordenam, truncam e títulos próprios por regras delas;
- títulos gerados automaticamente (nome de sessão derivado do primeiro prompt, título de PR derivado da branch);
- nomes de branches, tags e commits **existentes**, que não mudam.

Mitigação: onde a ferramenta deixar o humano digitar o título, aplicar a seção 7.3; onde ela truncar, o texto relevante
(o nome humano) vem primeiro e o ID fica ao final; onde ela gerar o título sozinha, repetir o nome humano na primeira linha
do corpo (PR) ou do primeiro prompt (sessão). Branch e commit são técnicos e seguem a seção 8.

## 8. Padrões operacionais

**Novos** padrões, vigentes a partir da adoção. O que existe permanece como está (coluna "Histórico preservado").

| Objeto                | Padrão novo                                                                                                                                                                                                                                              | Histórico preservado                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                | `<tipo>/<id>-<slug>` com o tipo em minúsculas (`feat`, `fix`, `spike`, `audit`, `docs`, `ops`, `mig`), o ID em minúsculas e slug em inglês `kebab-case`. Ex.: `feat/cg-prd-02-product-lifecycle`                                                         | `green/crm-0N-*`, `spike/green-*`, `release/green-baseline-1.0`. Não renomear. Hoje o CI não restringe nomes                          |
| Commit                | `<tipo-convencional>(<área>): <resultado em minúsculas>` com a área em minúsculas (`prd`), assunto até 72 caracteres, idioma português. Rodapé `Refs: CG-PRD-01`. Tipos convencionais: `feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore`, `spike` | Escopos `green`, `green-cutover`, `green-lifecycle`... e o tipo `spike(...)`. Mantidos; novos commits deixam de usar o escopo `green` |
| Tarefa / item         | Registro com nome humano, ID, tipo, área, estado (seção 6.3). Descrição começa pelo resultado esperado                                                                                                                                                   | `GREEN-CRM-NN`, `SPIKE-GREEN-NN`                                                                                                      |
| PR                    | Título conforme 7.3. Corpo cita o ID, o tipo e a equivalência histórica, se houver                                                                                                                                                                       | Merge commits "Merge pull request #N" inalterados                                                                                     |
| Documento de item     | `docs/green/<tema>/CG-<ÁREA>-<NN>-<SLUG-EM-MAIÚSCULAS>.md`. Slug em ASCII. H1 = nome humano; tabela de metadados com ID, tipo, área, estado e equivalência. Relatórios de `SPIKE` e `AUDIT` ficam em `docs/spike/`                                       | `docs/green/product/GREEN-CRM-0N-*.md`, `docs/spike/GREEN-*-V*.md`. Não renomear fisicamente                                          |
| Documento transversal | Nome descritivo em maiúsculas, sem ID no nome do arquivo (como esta página), em `docs/green/<tema>/`                                                                                                                                                     | `GREEN-BASELINE-1.0.md`, `PRODUCTION-READINESS.md`                                                                                    |
| ADR                   | `docs/adr/GREEN-NNN-slug.md`; H1 `ADR-GREEN-NNN - <título humano>`; cabeçalho cita o ID do item de origem. Obrigatória para mudar contrato selado. A série `GREEN-` já evita disputa com `0001`-`0004` do Deskcomm                                       | ADR-GREEN-001, formato inalterado                                                                                                     |
| Registro de decisões  | Decisão local a um item: `D-NN` no documento do item. Decisão de vocabulário, área, tipo ou ID: `GOV-NN` na seção 11 desta página. Decisão que muda arquitetura ou contrato selado: ADR                                                                  | `D-01`...`D-20` da GREEN-CRM-01                                                                                                       |
| Migration             | Arquivo `<timestamp>_<NNNN>_green_<tema>.sql` (NNNN na sequência do MANIFEST), **sem** o infixo `spike`. Cabeçalho `-- Item: CG-<ÁREA>-<NN>`; linha no MANIFEST iniciada pelo ID; espelho no `baseline.sql`; tipo `MIG` ou parte de `FEAT`               | `0501`-`0509` intocadas; `0501`-`0508` mantêm o infixo `spike_`                                                                       |
| Documento de migração | Item `MIG` tem documento próprio (motivo, DDL resumido, RLS, forma de reverter ou corrigir à frente, testes). Migration que é parte de `FEAT` documenta o modelo na seção do documento da `FEAT`, como a GREEN-CRM-02                                    | Seção 2 da GREEN-CRM-02                                                                                                               |
| Tag                   | Marcos de baseline: `GREEN-BASELINE-X.Y`. Tags não carregam ID de item                                                                                                                                                                                   | `GREEN-BASELINE-1.0`                                                                                                                  |

Compatibilidade com o que já existe: nenhuma regra acima conflita com `CONTRIBUTING.md` (que lista `feat/`, `fix/`, `chore/`,
`docs/` e commits convencionais com escopo `EPIC-XX`; a seção 8 acrescenta `spike/`, `audit/`, `ops/` e `mig/` e troca o
escopo por área apenas para o ConectorGreen), nem com o CI (nenhum workflow restringe nome de branch ou de commit), nem com as guardas de MANIFEST,
baseline e documentação (`tests/unit/manifest-x-migrations.test.ts`, `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`).

## 9. Governança

**Mantenedor lógico:** o dono do produto ConectorGreen. Agentes e colaboradores **propõem**; só o dono do produto
**aprova**, e pode delegar por escrito. A aprovação fica registrada como `GOV-NN` na seção 11.

| Mudança                            | Critério de aprovação                                                                                                                                                                                      | Como se registra                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Novo **termo**                     | (1) não é coberto por termo existente; (2) não contradiz GREEN-CRM-01 seção 17 nem contrato selado; (3) traz significado, fronteira, sinônimos permitidos e não recomendados; (4) é usado por um item real | Linha no glossário + `GOV-NN`                      |
| Novo **sinônimo** ou **banimento** | Resolve ambiguidade que apareceu em item real                                                                                                                                                              | Linha em 3.4 + `GOV-NN`                            |
| Nova **área**                      | Resultado que **não cabe** em nenhuma área pela árvore 4.3; pelo menos **dois** itens previstos; fronteira escrita com o que não é. Preferir ampliar escopo a criar prefixo                                | Seção 4 + `GOV-NN`; sem renumerar áreas existentes |
| Novo **tipo**                      | Mostrar que os sete tipos distorcem prova ou métrica; descrever a prova esperada                                                                                                                           | Seção 5 + `GOV-NN`                                 |
| **Fusão ou aposentadoria** de área | Área sem itens abertos. Os IDs existentes continuam válidos e apontam para a nova                                                                                                                          | Seção 4.2 + `GOV-NN`                               |
| Novo **ID**                        | Não precisa de aprovação: basta reservar no registro (6.2)                                                                                                                                                 | Registro                                           |
| Revisão de nome humano             | Melhora clareza sem mudar o resultado                                                                                                                                                                      | Linha do registro com data e motivo                |

**Conflitos.** Precedência da seção 1. Se dois documentos discordam sobre um **nome técnico**, vale o contrato selado ou o
ADR. Sobre **semântica de domínio**, vale a GREEN-CRM-01 seção 17. Sobre **nome em prosa ou de trabalho**, vale esta página.
Conflito que a precedência não resolve fica na seção 12 como pendência aberta, para decisão do dono do produto, e o item
afetado segue com o nome atual até lá.

**Adoção.** Depois de ADOTADO, todo item **novo** usa área, tipo, ID e nome humano canônicos. Itens em andamento na data da
adoção terminam com seus nomes e são mapeados no registro; nada é renomeado fisicamente.

**Guarda automática.** Ainda não existe. Verificar formato de ID ou branches por teste é possível e fica como pendência
(seção 12), para não conflitar com checks existentes sem decisão.

## 10. Equivalência histórica

O mapa histórico para canônico, o registro de IDs emitidos e o vocabulário dos estados da equivalência vivem em
[`CONECTORGREEN-EQUIVALENCE-MAP.md`](CONECTORGREEN-EQUIVALENCE-MAP.md). Regras de uso:

1. Documento ou relatório antigo **não** é editado para trocar o ID; o mapa é a ponte.
2. Ao citar um item histórico num documento novo, usar o ID canônico e, na primeira menção, o histórico entre parênteses.
3. Quando a equivalência for `PARCIAL` ou `SEM DECISÃO`, citar o identificador histórico, não o canônico.
4. Equivalência só vira `APROVADA` com `GOV-NN`.

## 11. Registro de decisões desta fonte

Ratificadas pelo dono do produto em 2026-10-07, em bloco, pelo procedimento da seção 9. Nenhuma decisão além destas cinco foi
criada.

| ID       | Data       | Decisão                                                                                            | Estado   | Resultado da ratificação                                                                                                                                                                                                                                                                                                      |
| -------- | ---------- | -------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOV-01` | 2026-10-07 | Adotar este documento como fonte única de vocabulário e nomenclatura (CG-FND-08)                   | APROVADA | Documento ADOTADO. Mapa de equivalência aprovado em bloco: as linhas 1:1 viram `APROVADA`; `PARCIAL`, `SEM DECISÃO` e `PRESERVADO` não são promovidas. Esquema do v0 classificado como legado, com exceção de uso ativo registrada (seção 12, pendência 2). `CONCLUÍDO` não implica aprovação de merge ou release (seção 6.3) |
| `GOV-02` | 2026-10-07 | Taxonomia de 14 áreas (remoção de `CG-LEAD`, seção 4.2)                                            | APROVADA | 14 áreas mantidas, sem `CG-LEAD`. Esclarecido no escopo: `CG-COM` inclui atividades comerciais; `CG-PRD` inclui as regras dos produtos                                                                                                                                                                                        |
| `GOV-03` | 2026-10-07 | Sete tipos de trabalho e ID sem tipo (seções 5 e 6)                                                | APROVADA | Sete tipos (`FEAT`, `FIX`, `SPIKE`, `AUDIT`, `DOC`, `OPS`, `MIG`) e formato `CG-<ÁREA>-<NN>` mantidos sem alteração                                                                                                                                                                                                           |
| `GOV-04` | 2026-10-07 | Nome humano com travessão entre área e resultado; ID ao final nos títulos de PR e sessão (seção 7) | APROVADA | Travessão `—` mantido como separador do nome humano, que vem primeiro nos títulos visíveis. Não altera as convenções técnicas de Git. Pendência 3 resolvida                                                                                                                                                                   |
| `GOV-05` | 2026-10-07 | Convenções operacionais novas de branch, commit, documento, ADR e migration (seção 8)              | APROVADA | Convenções mantidas sem alteração. Nenhuma guarda automática de ID criada nesta ratificação (pendência 4)                                                                                                                                                                                                                     |

## 12. Pendências

| #   | Pendência                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Dono            | Estado                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ---------------------- |
| 1   | Aprovar `GOV-01` a `GOV-05` e promover as equivalências `PROPOSTA` a `APROVADA`                                                                                                                                                                                                                                                                                                                                                                                          | dono do produto | RESOLVIDA (2026-10-07) |
| 2   | Esquema do v0 (`F0`, `P0.x`, `T0.x.xx`, `ADR-NNN`, `PD-NNN`, `RAD-NNN`, repositório `conector-green`): é **legado** em relação a este padrão e não é nomenclatura oficial nova. **Exceção registrada:** continua em uso ativo dentro do repositório `conector-green` (o `CLAUDE.md` dele define a "Nomenclatura oficial" e há commits `T1.4.11` de 2026-09-28). Vale só ali; neste repositório não se usa e não se promove. A equivalência com `CG-` segue `SEM DECISÃO` | dono do produto | RESOLVIDA (2026-10-07) |
| 3   | O travessão `—` do nome humano diverge da regra de separador ASCII do v0 (`F0 - P0.2 - ...`). Resolvida por `GOV-04`: o v0 mantém o seu padrão no seu repositório e o `—` vale para o nome humano do ConectorGreen                                                                                                                                                                                                                                                       | dono do produto | RESOLVIDA (2026-10-07) |
| 4   | Guarda automática opcional: formato do ID e do registro (teste de documentação). Não criada na ratificação. Precisa de decisão e escopo próprios antes, para não criar check novo sem aprovação                                                                                                                                                                                                                                                                          | arquitetura     | ABERTA (adiada)        |
| 5   | O relatório `GREEN-MUTATION-CONTEXT-V2.md` cita `docs/audits/deskcomm-fit/05-...`, caminho que não existe neste repositório. Não corrigido aqui por tocar histórico selado                                                                                                                                                                                                                                                                                               | dono do produto | ABERTA                 |
