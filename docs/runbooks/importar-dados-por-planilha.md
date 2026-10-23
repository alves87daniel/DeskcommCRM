# Importar dados por planilha (contatos, oportunidades e contexto Green)

> Para quem vai subir no CRM instalado os dados que hoje estão espalhados, pela tela, sem ser
> desenvolvedor. Escrito em 2026-10-21 a partir do código da `main` (issue #52). O que este
> documento afirma sobre o importador foi lido em `lib/contacts/csv.ts` e `lib/leads/planilha.ts`;
> quando os dois discordarem, vale o código.

**O modelo:** [`modelo-importacao-de-dados.xlsx`](modelo-importacao-de-dados.xlsx), uma aba por
tipo de dado, com os cabeçalhos exatamente como o importador os reconhece, uma linha de exemplo
fictícia e a aba **Instruções** em português simples. O arquivo é gerado sem dependência nova (um
`.xlsx` é um zip de XML) e cada aba importável foi lida pelo parser do próprio importador antes de
entrar neste repositório (seção 7).

---

## 1. O que o CRM importa hoje

| Dado                      | Onde na tela                                                                 | Formato                                                                                                                                                                                                       | Limites                                                         | Quem pode          |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| **Contatos**              | Contatos › botão **Importar CSV**                                            | só CSV (`.xlsx` é recusado)                                                                                                                                                                                   | 5 MB, 500 linhas por arquivo                                    | `agent` ou acima   |
| **Oportunidades** (leads) | Quadro (funil) › botão **Importar planilha**, escolhendo o funil de destino  | só CSV; a tela oferece um modelo CSV                                                                                                                                                                          | 5 MB, 500 linhas; **toda linha entra na primeira etapa aberta** | `agent` ou acima   |
| Empresas e pessoas        | Importações (só com o módulo **Empresas e pessoas** ligado em Configurações) | CSV, ou `.xlsx` de **uma aba só** (esse importador lê só a primeira aba; o modelo deste runbook tem Instruções em primeiro, então **exporte a aba Empresas e pessoas como CSV**, não envie o `.xlsx` inteiro) | 2 MB, 2.000 linhas                                              | `manager` ou acima |
| Catálogo da loja          | Produtos › Importar planilha                                                 | só CSV                                                                                                                                                                                                        | 500 linhas                                                      | `manager` ou acima |

O catálogo da loja (Produtos) **não é** o catálogo Green: são tabelas diferentes. O catálogo Green
vive em Configurações › Produtos Green e não tem importador (seção 5).

Não existe tela de "mapear colunas": o importador reconhece os cabeçalhos pelo nome (com e sem
acento, maiúsculas ou minúsculas) e lista no resumo as colunas que ignorou. Para "mapear", renomeie
o cabeçalho na planilha. O modelo já vem com os nomes certos.

Outras portas de entrada, para saber que existem: captação por webhook
(`app/api/v1/webhooks/in/[token]/route.ts`, com mapa de campos e dedupe por telefone), a ferramenta
MCP `crm_create_lead` que o agente de IA usa, e a API REST por sessão. **Não** existe importação em
lote por token Bearer: `POST /api/v1/leads` e `POST /api/v1/contacts` não estão em
`lib/auth/public-paths.ts`, então um script externo precisaria de sessão de navegador. Os
`scripts/seed-*.ts` do repositório são sementes de teste, não importadores. Para a semana de 29/10,
o caminho é a tela.

---

## 2. Antes de começar

1. **Funil pronto.** Crie o funil (ou confira o existente) com as etapas na ordem certa. A
   importação joga tudo na **primeira etapa aberta** do funil, na ordem do quadro: etapas de Ganho e
   de Perdido são ignoradas na escolha, mesmo que estejam em primeiro. A importação só é recusada se o
   funil não tiver **nenhuma** etapa aberta. Não precisa reordenar o quadro por causa disso.
2. **Produtos Green cadastrados** em Configurações › Produtos Green (manager+), um por um. O
   `code` segue a regra `^[a-z][a-z0-9_]{1,62}$` (minúsculas, números e `_`, começando por letra) e
   não pode ser trocado depois. Use a aba **Produtos Green** do modelo só para listar o que vai
   cadastrar.
3. **Automações pausadas.** Cada oportunidade importada emite o mesmo evento de "negócio criado"
   (`lead.created`) de um negócio aberto à mão, e o motor de automações (`lib/automation/engine.ts`)
   roda toda regra **ativa** com esse gatilho, sem distinguir o que veio de planilha. Uma regra que
   manda WhatsApp ou aciona a IA quando nasce um negócio dispararia para as 500 linhas. Antes de
   importar Oportunidades: abra **Webhooks › aba Automações**, e em cada regra com gatilho de negócio
   criado clique em **Pausar** (o estado passa de "Ativa" para "Pausada"). Depois que a importação
   terminar e o quadro estiver conferido, volte lá e clique em **Ligar**. Os follow-ups do funil
   (`lib/followup/gatilho-lead.ts`) já ignoram quem veio de planilha; as automações, não. Quem faz
   isso precisa de papel que edite regras (manager+).
4. **Seu papel** na organização é `agent` ou acima (viewer só lê).
5. **O modelo** baixado deste repositório, ou o CSV modelo que a própria tela de Importar planilha
   oferece ("Baixar planilha modelo").

---

## 3. Passo a passo

### 3.1 Preencher a planilha

- Uma aba por tipo de dado. **Não mude a linha 1** (cabeçalho).
- Deixe as colunas como **Texto** (o modelo já vem assim). Telefone que o Excel converte em número
  perde o `+` e o zero; data convertida em data sai em outro formato; `12.500,00` convertido em número
  vira `12,5`.
- Para mais de 500 linhas, divida em arquivos de até 500.
- Mesma pessoa em várias oportunidades: repita o telefone em cada linha de **Oportunidades**. O
  importador cria **um** contato e liga as oportunidades a ele.

### 3.2 Exportar cada aba como CSV

O CRM lê CSV, não `.xlsx`. No Excel: deixe a aba ativa › Arquivo › Salvar como › tipo **CSV UTF-8
(delimitado por vírgulas)**. O Excel salva **só a aba aberta**, então repita para Contatos e para
Oportunidades. O Excel em português costuma separar por `;`: o importador aceita `,`, `;` e
tabulação, e também o arquivo em Latin-1 que versões antigas geram. No Google Planilhas: Arquivo ›
Fazer download › CSV (também salva só a aba atual).

### 3.3 Importar os contatos

1. Entre em **Contatos** e clique em **Importar CSV**.
2. Escolha o arquivo da aba **Contatos** e confirme.
3. Leia o resumo na própria janela: `importados`, `duplicados` e a lista de linhas com problema,
   cada uma com o número da linha e o motivo.

Regras que o importador aplica (`lib/contacts/csv.ts`):

| Coluna       | Outros nomes aceitos                             | Regra                                                                                                                                                  |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nome`       | `name`, `cliente`                                | até 200 caracteres                                                                                                                                     |
| `apelido`    | `display_name`, `nome de exibicao`               | como a pessoa é chamada; é o que aparece na lista                                                                                                      |
| `telefone`   | `phone_number`, `whatsapp`, `celular`, `fone`    | com DDD, com ou sem máscara: `11988887777`, `(11) 98888-7777`, `+5511988887777`. 10 ou 11 dígitos ganham `+55`; de fora do Brasil, venha com `+` e DDI |
| `email`      | `e-mail`                                         | `nome@dominio.com`                                                                                                                                     |
| `cpf`        |                                                  | 11 dígitos, com ou sem pontos e traço. O dígito verificador é conferido; CPF inválido recusa a linha. Fica cifrado no banco                            |
| `nascimento` | `data de nascimento`, `aniversario`, `birthdate` | `DD/MM/AAAA` ou `AAAA-MM-DD`; dia inexistente (`31/02`) recusa a linha                                                                                 |
| `tags`       | `etiquetas`, `grupos`                            | separadas por `;` ou `\|`, até 20, viram minúsculas                                                                                                    |

- **Obrigatório por linha:** telefone **ou** e-mail. Sem os dois, a linha é pulada.
- **Repetido não é erro:** telefone, e-mail ou CPF que já existe na organização conta como
  `duplicado` e a linha não é criada de novo. Reimportar o mesmo arquivo é seguro.
- Todo contato importado nasce com origem `import_csv`. **Não há coluna de origem** neste
  importador (seção 5).

### 3.4 Importar as oportunidades

1. Entre no **Quadro** (funil) e clique em **Importar planilha**.
2. Escolha o **funil de destino**.
3. Escolha o arquivo da aba **Oportunidades**.
4. Leia o resumo na própria janela: `criados`, `contatos novos`, `colunas que não reconheci` e a lista
   de linhas recusadas com motivo. O resumo fica na tela até você fechar.

Regras que o importador aplica (`lib/leads/planilha.ts`):

| Coluna            | Outros nomes aceitos                                              | Regra                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nome`            | `titulo`, `negocio`, `oportunidade`, `empresa`, `assunto`, `lead` | o nome do card; sem ele, o nome do contato vira o título                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `nome do contato` | `contato`, `responsavel`, `pessoa`                                | quem é a pessoa                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `telefone`        | `celular`, `whatsapp`, `fone`, `phone`                            | mesma regra de contatos. Se já existe um contato com esse telefone, a oportunidade é ligada a ele; se não, o contato é criado                                                                                                                                                                                                                                                                                                                                             |
| `email`           | `e-mail`                                                          | só entra se tiver `@`; **só é gravado quando o importador cria o contato**. Contato que já existe (achado pelo telefone) não ganha nem corrige e-mail por aqui; a oportunidade não tem campo de e-mail. Para corrigir e-mail, use Contatos                                                                                                                                                                                                                                |
| `valor`           | `preco`, `ticket`, `value`                                        | **na moeda configurada da organização** (Configurações › Organização): o importador não converte, só grava o número e carimba a moeda da organização. Planilha em reais numa organização em EUR ou USD entra com o número errado. Formatos aceitos: `12.500,00`, `1200`, `R$ 1.200,00`, `1200.50` e `1200,50` (o último separador com 1 ou 2 dígitos depois é o decimal; com 3, é milhar: `1.200` e `1,200` são mil e duzentos, nunca 1,2). Valor ilegível recusa a linha |
| `origem`          | `fonte`, `canal`, `source`                                        | texto livre, sem acento, sempre com a mesma grafia (`indicacao`, `site`, `meta_ads`, `whatsapp`). Vazio vira `importacao_planilha`                                                                                                                                                                                                                                                                                                                                        |
| `tags`            | `etiquetas`, `marcadores`                                         | separadas por `,`, `;` ou `\|`, até 20. **Ficam como escritas** (`Quente` e `quente` são duas tags diferentes no filtro do quadro): escreva sempre em minúsculas, como o importador de contatos já faz sozinho                                                                                                                                                                                                                                                            |
| `observacao`      | `descricao`, `notas`, `detalhes`                                  | texto livre; vai para a descrição do card                                                                                                                                                                                                                                                                                                                                                                                                                                 |

- **Obrigatório:** a planilha precisa ter a coluna `nome` **ou** `nome do contato`; a linha precisa
  ter ao menos 2 caracteres num dos dois.
- **Telefone ilegível não derruba a linha:** a oportunidade **entra assim mesmo, sem contato**, e o
  resumo avisa. **Não reimporte essa linha:** este importador não reconhece oportunidade repetida, e a
  linha corrigida viraria um segundo card. O card que entrou sem contato **não tem como ganhar um
  contato pela tela** (o dossiê só mostra "este negócio não tem contato vinculado"). O caminho é:
  apague esse card no quadro e importe de novo **só essa linha**, com o telefone corrigido.
- **Reimportar o mesmo arquivo cria tudo de novo.** Diferente do importador de contatos, aqui não há
  "duplicado": cada linha vira uma oportunidade nova, mesmo que igual a uma que já existe. Importe cada
  arquivo uma vez; o que precisar de ajuste, ajuste no card.
- **Etapa:** não existe coluna de etapa. Tudo entra na primeira etapa aberta do funil escolhido.
- Cada linha passa pelo mesmo caminho de um negócio criado à mão (mesma validação, mesma auditoria
  `lead.created`), por isso o teto de 500 linhas.

### 3.5 Dar o contexto Green a cada oportunidade

Hoje isto é **pela tela, uma oportunidade por vez**:

1. Abra o card no quadro (dossiê da oportunidade).
2. Na seção **Produto Green** (só aparece em funil Green), escolha o produto e salve.
3. Para a etapa, **arraste o card** até a coluna certa. Alternativa: um arquivo CSV por etapa, e
   depois de cada importação mova em bloco os cards recém-criados. **O mover em lote aceita no máximo
   50 cards por vez**: um arquivo de 200 linhas é movido em quatro seleções de até 50.

A aba **Contexto Green** do modelo existe para você já reunir produto e etapa de cada oportunidade
(pelo telefone), mesmo sem importador para ela. É o insumo da seção 5.

### 3.6 Conferir

- Contatos: a lista mostra os importados; o filtro por tag ajuda a achar o lote (`cliente`, `sp`).
- Quadro: a primeira etapa deve ter o número de cards que o resumo disse em `criados`.
- Audit Log (menu lateral, **só `manager` ou acima**): uma entrada `contacts.imported` e uma
  `lead.imported` por arquivo, com os totais. Se algo deu errado, é por aqui que se prova o que entrou.
  Exceção: um arquivo de contatos em que **nenhuma linha** passou na validação não gera entrada no Audit
  Log (a rota devolve o resumo antes de auditar); nesse caso a única prova é o resumo da janela.
  Quem importa como `agent` não alcança essa tela: guarde o resumo que apareceu na janela (print ou
  anotação dos totais e das linhas recusadas) e peça a um `manager` para conferir no Audit Log.

---

## 4. Campos que existem e o que a planilha alcança

| Entidade                              | Campos que existem no banco                                                                                                                                                                                        | O que a planilha preenche hoje                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Contato (`contacts`)                  | `name`, `display_name`, `phone_number` (E.164), `email`, `cpf` (cifrado + hash), `birthdate`, `tags`, `source`, `source_metadata`, `custom_fields`, `consent`, `person_id`, `kind`                                 | nome, apelido, telefone, email, cpf, nascimento, tags. `source` fixo em `import_csv`                                             |
| Oportunidade (`crm_leads`)            | `title`, `description`, `pipeline_id`, `stage_id`, `contact_id`, `value_cents` + `currency`, `source`, `source_metadata`, `tags`, `owner_user_id`, `expected_close_date`, `status`, `custom_fields`, `external_id` | título, descrição, contato, valor, origem, tags. Etapa = primeira aberta; sem dono, sem data prevista, sem campos personalizados |
| Contexto Green (`green_lead_context`) | `product_id` (1:1 com a oportunidade; só em funil Green; só com a oportunidade aberta)                                                                                                                             | **nada**                                                                                                                         |
| Catálogo Green (`green_products`)     | `code`, `name`, `description`, `family`, `is_active`, `metadata`                                                                                                                                                   | **nada** (tela ou `POST /api/v1/green/products`, um por vez)                                                                     |
| Empresa / pessoa (módulo B2B)         | empresa, razão social, nome fantasia, CNPJ, pessoa, cargo, telefone, e-mail                                                                                                                                        | tudo, se o módulo estiver ligado                                                                                                 |

Modelo completo das entidades e o que o Green reaproveita:
[`GREEN-CRM-01`](../green/product/GREEN-CRM-01-PRODUCT-FOUNDATION.md) e
[`GREEN-CRM-02`](../green/product/GREEN-CRM-02-PRODUCT-CATALOG-CONTEXT.md).

---

## 5. O que o importador não cobre, e o caminho mais simples (sem implementar)

> **Decisão do dono, 2026-10-21:** nenhuma das colunas abaixo (`etapa`, `produto`, `origem`) será
> implementada por ora. O volume é baixo e esses dados entram **manualmente**; o produto Green por
> oportunidade depende de regras de negócio (produto, localidade e tipo de contrato) que ainda serão
> definidas. O desenho futuro e as perguntas em aberto estão na issue #54. O que segue é o registro
> das lacunas e do caminho anotado, não um plano de implementação.

### 5.1 Etapa e produto Green por linha (a lacuna que pesa)

**Falta:** o importador de oportunidades não lê etapa nem produto. Para N oportunidades, hoje são N
aberturas de dossiê para o produto e N arrastos para a etapa.

**Caminho mais simples proposto:** duas colunas **opcionais** no importador que já existe, sem tabela
nova e sem migration:

- `etapa`: casada pelo **nome** entre as etapas **abertas** do funil escolhido, ignorando acento e
  caixa. Vazia, vale a regra de hoje (primeira etapa aberta). Nome que não existe no funil recusa a
  linha com o motivo (`etapa "X" não existe neste funil`), nunca chuta.
- `produto`: o `code` de um produto **ativo** de Configurações › Produtos Green. Depois de criar a
  oportunidade, o importador chama a mesma função que o dossiê usa para salvar o produto
  (`lib/green/produto/servico.ts`), com as mesmas recusas: funil que não é Green, produto inexistente
  ou inativo recusam a linha com motivo. Vazia, a oportunidade nasce sem produto, como hoje.

Onde isso mora: o leitor em `lib/leads/planilha.ts` (duas entradas na tabela de colunas) e a rota
`app/api/v1/leads/import/route.ts` (resolver etapa e produto por nome antes do laço, com uma consulta
cada; gravar o contexto depois de cada `createLeadHandler`). A aba **Contexto Green** do modelo já
tem essas colunas; quando o caminho existir, basta copiá-las para a aba Oportunidades. Destino:
**núcleo** (é o importador que já existe ganhando duas colunas opcionais; sem elas, nada muda).

**Enquanto não existe:** um CSV por etapa (o importador coloca tudo na primeira aberta; arraste o
lote) e produto pelo dossiê. Viável para dezenas; para centenas, o caminho acima.

### 5.2 Catálogo Green por planilha

**Falta:** não há importador de `green_products`. **Caminho:** cadastrar pela tela. São poucos
produtos por organização e o `code` é imutável, o que pede atenção humana por item. Não vale um
importador.

### 5.3 Origem no contato

**Falta:** o importador de contatos grava `source = import_csv` em todos; só o de oportunidades lê
`origem`. **Caminho:** coluna `origem` opcional no importador de contatos, gravando `contacts.source`
(vocabulário aberto, como já é na oportunidade). Uma linha na tabela de cabeçalhos e uma no insert.
Até lá, a origem fica na oportunidade, que é onde ela é registrada hoje.

### 5.4 Campos que não entram de jeito nenhum hoje

Dono da oportunidade, data prevista de fechamento, campos personalizados, endereço e empresa do
contato (fora do módulo B2B). Guarde o que importa na coluna `observacao` da oportunidade, que vira a
descrição do card e fica legível para quem atende e para o agente de IA.

### 5.5 Status já ganho ou perdido

Oportunidade histórica já ganha ou perdida não deve ser importada como aberta e fechada no quadro
uma a uma: importe só o que está **em andamento**. Histórico fechado, se precisar entrar, é assunto
da issue #54 (o importador escolhe, de propósito, só etapa aberta).

---

## 6. Plano para a semana de 29/10

1. Segunda: funil e etapas conferidos; produtos Green cadastrados; papéis conferidos; lista das
   automações com gatilho de negócio criado anotada (Webhooks › Automações).
2. Terça: planilha preenchida; exportar as abas Contatos e Oportunidades em CSV; importar **num
   ambiente de teste primeiro** (ou com 10 linhas) e ler o resumo.
3. Quarta: **pausar as automações de negócio criado**; importar Contatos (todos os arquivos),
   depois Oportunidades (um arquivo por etapa, se
   for seguir a saída da seção 5.1). **Cada arquivo de Oportunidades sobe uma vez só**; o que der
   errado se corrige no card, não reimportando.
4. Quinta: produto Green pelo dossiê; mover os lotes para a etapa certa (até 50 cards por seleção);
   conferir auditoria; **religar as automações** pausadas na quarta.
5. Sexta: folga para as linhas recusadas.

---

## 7. Como o modelo foi conferido

O `.xlsx` foi gerado por script (zip de XML, células como texto, sem dependência nova) e lido com os
parsers do próprio repositório, em 2026-10-21:

- aba **Contatos** por `mapHeader`/`mapLinha` de `lib/contacts/csv.ts`: as 7 colunas reconhecidas;
  a linha de exemplo saiu com telefone `+5511988887777`, CPF normalizado, nascimento `1988-03-15` e
  tags em minúsculas;
- aba **Oportunidades** por `lerPlanilhaDeLeads` de `lib/leads/planilha.ts`: 1 lead, 0 erros,
  0 colunas ignoradas, valor `12.500,00` lido como 1.250.000 centavos, origem `indicacao`;
- aba **Empresas e pessoas** por `suggestColumnMapping` de `lib/crm-b2b/spreadsheet.ts`: os 8
  campos mapeados;
- o arquivo inteiro por `parseImportFile` (o leitor de `.xlsx` do módulo B2B): abre e lê a primeira
  aba.

Os dados de exemplo são fictícios: o CPF `529.982.247-25` é um número de teste que passa no dígito
verificador e não pertence a ninguém; telefone e e-mail seguem o padrão do CSV modelo da tela.
