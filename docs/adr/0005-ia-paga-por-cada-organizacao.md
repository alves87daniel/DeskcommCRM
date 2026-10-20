# ADR-0005 — IA paga por cada organização, nunca pela plataforma

- **Status:** aceito em 2026-10-20 pelo dono do produto
- **Data:** 2026-10-20
- **Contexto medido em:** `fc942f773` (topo de `origin/main` em 20/10/2026); o mapa dos caminhos de
  código, com arquivo e linha, está na issue
  [#32](https://github.com/alves87daniel/DeskcommCRM/issues/32)
- **Lei que muda quando aceita:** o anti-pattern 15 do [`CLAUDE.md`](../../CLAUDE.md), a regra 172
  do gabarito [`nao-negociaveis.md`](../doctrine/nao-negociaveis.md) e a regra 11 das Code Review
  Rules do [`AGENTS.md`](../../AGENTS.md); a "decisão 22-a" (endereço próprio exige chave própria)
  deixa de ser caso especial, porque não há mais chave da instalação a proteger; e, no desenho da
  [ADR-0004](0004-cobranca-do-revendedor.md), a decisão D-9 e o "teto de IA do plano" (ver
  "Consequências")
- **Trabalho que a executa:** issue
  [#33](https://github.com/alves87daniel/DeskcommCRM/issues/33) (remoção da queda para a chave
  global e cerca), com a condição de prazo registrada em "Consequências"

---

## Contexto

O upstream desenhou a chave de IA do `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`) como **"fallback de plataforma"**: a instalação de uma
empresa só cola a chave uma vez, no instalador, e todo ponto de IA responde por ela. Cadastrar uma
credencial pela tela (IA › Credenciais, tabela `ai_provider_credentials`) é opcional e vence a do
`.env` quando existe.

Neste fork a instalação serve **várias organizações** sob um licenciado, e o mesmo desenho produz o
oposto do que o produto promete:

| Fato                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Onde foi medido                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cinco resolvedores independentes terminam na chave do `.env` quando a organização não tem a sua: o do agent-engine (agentes, resumos de turno, roteador, follow-up, propostas, prospecção, visão), o dos workers do app (clima, resposta automática, cartão do Jev), o de embeddings da base de conhecimento, o de transcrição de áudio e o do agente de voz, que aplica a queda duas vezes antes de abrir a sessão Realtime paga e, quando há credencial, escolhe a mais antiga, não a mais recente | `lib/agent-engine/edge/llm/credentials.ts`, `lib/ai/gateway.ts` e `gateway-binding.ts`, `lib/ai/embeddings/chave.ts`, `workers/media-derive-worker.ts`, `lib/ai/agents.ts` e `workers/voice-agent/audioSocketBridge.ts`; linhas em #32 |
| A publicação de agente aceita versão **sem** `credential_id` quando a instalação tem a chave (`chaveDePlataforma`), e o banco a aceita por `p_platform_credential_verified`                                                                                                                                                                                                                                                                                                                          | `lib/ai/runtime/agent.ts`, `lib/ai/agents/publish.ts`, `fn_publish_ai_agent_version` no `supabase/baseline.sql`                                                                                                                        |
| A periferia anuncia o fallback como caminho legítimo: o seletor de modelo do roteador oferece modelos "plataforma", o retrato da instalação responde `origemDaChave: "instalacao"`, os avisos de boot chamam a env de "último degrau", e o instalador pergunta e grava as chaves no `.env`; o `update.sh` nunca as apaga de um `.env` existente                                                                                                                                                      | `lib/ai/classifier-models.ts`, `lib/instalacao/retrato.ts`, `lib/env.ts`, `hostgator-setup-kit/install.sh`, `hostgator-setup-kit/update.sh`                                                                                            |
| O teto por organização (`ai_budgets`) e o registro de gasto (`llm_calls`) sabem **de quem é o uso**, mas não **de quem é a chave**: com a chave global, a conta do provedor é uma só e a plataforma paga por todas                                                                                                                                                                                                                                                                                   | `lib/agent-engine/edge/llm/credentials.ts` (`OrgLlmConfig.orcamento`)                                                                                                                                                                  |
| Uma exceção já cumpre a regra: o Jev lê só a credencial da organização e documenta "nunca uma chave de ambiente global"                                                                                                                                                                                                                                                                                                                                                                              | `lib/ai/decisao/ponto.ts`                                                                                                                                                                                                              |

O desfecho, numa instalação com licenciado: uma organização que nunca cadastrou chave consome IA
pela chave da plataforma, sem saber, sem teto por conta e sem fatura própria. E a correção parcial
já existente (a decisão 22-a, que recusa chave da instalação com endereço escolhido pela
organização) protege o endereço, não o dinheiro.

---

## Decisão

### D1 — A plataforma não custeia IA

A instalação não paga chamada de IA de organização nenhuma. Não existe "chave de plataforma" como
conceito de produto: existe a chave de cada organização, e mais nada.

### D2 — A única fonte de chave é a credencial da organização

A chave de todo ponto de IA sai de `ai_provider_credentials` da organização, **ativa e validada**,
escolhida pelo binding do ponto (`ai_purpose_bindings`) ou, sem binding, pela credencial mais
recente do provedor da organização. Nenhum resolvedor tem degrau abaixo desse, e nenhum escolhe por
outra ordem: o agente de voz, que hoje desempata pela credencial mais antiga, passa a seguir esta.

### D3 — Sem chave, o recurso fica desligado para aquela organização, com aviso na tela

Organização sem credencial utilizável não tem IA: o ponto não chama provedor nenhum, nunca cai em
outra chave, e a tela do recurso e a Central dizem que a IA está desligada por falta de chave e
apontam IA › Credenciais. É o mesmo desfecho que o produto já dá a quem está "sem chave em lugar
nenhum", agora como único desfecho. Erro mudo e fallback silencioso são proibidos.

### D4 — As envs de IA ficam vazias em produção

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` e `AI_GATEWAY_API_KEY` continuam
**declaradas** em `lib/env.ts`, para scripts locais de desenvolvimento e teste (`scripts/smoke-llm.ts`,
`scripts/provoke-agent-turn.ts` e afins), e **vazias** em toda instalação de produção. Código de
produto em `app/`, `lib/`, `workers/`, `hooks/` e `components/` não as lê para atender organização.

"Vazias" vale também para quem já instalou: o `hostgator-setup-kit/update.sh` esvazia as quatro
variáveis do `.env` existente, de forma idempotente, e só depois de conferir que a organização do
dono tem credencial ativa e validada. Sem essa credencial, a limpeza não acontece e o `update.sh`
avisa o que falta, em vez de deixar a instalação sem IA. Ninguém edita o `.env` à mão, como manda a
[doutrina de packaging](../doctrine/packaging.md).

### D5 — O instalador cadastra a chave como credencial da organização do dono

O instalador continua perguntando a chave de IA, mas grava-a como credencial da organização do
dono, não no `.env`. A experiência de quem instala não muda; a propriedade da chave, sim.

Há dois caminhos que criam o dono e a organização, e os dois cadastram a chave: o
`scripts/bootstrap-owner.ts` e o bloco SQL inline do `hostgator-setup-kit/install.sh`, que é o que a
VPS de fato roda e não chama o script. A #33 escolhe entre mudar os dois ou fazer o instalador
chamar o script canônico; mudar só um deles deixaria a instalação nova sem IA.

---

## Consequências

- **Produção, de 20/10/2026 até a entrega da #33:** roda com as envs de IA **vazias** e a chave
  cadastrada em IA › Credenciais. É o estado que já cumpre D1 a D4 por operação, antes de o código
  deixar de permitir o contrário.
- **O PR que remove a queda para a chave global e traz a cerca (#33) fica para depois de
  01/11/2026 e é obrigatório antes do primeiro licenciado.** Nenhum licenciado entra numa
  instalação em que o código ainda consiga cair na chave da plataforma.
- **Quem opera só pela chave do `.env`:** antes de atualizar para a versão da #33, cadastra a chave
  pela tela. O fragmento de release daquele PR declara `exige_acao`. O `update.sh` da mesma versão
  esvazia as envs de IA quando a credencial existe (D4) e avisa quando não existe.
- **Doutrina e revisão de código:** o anti-pattern 15 do `CLAUDE.md`, a regra 172 do gabarito e a
  regra 11 das Code Review Rules do `AGENTS.md` reprovam leitura de chave de IA do ambiente no
  produto e qualquer "sem credencial da organização, outra chave responde".
- **A decisão 22-a** some como caso especial: sem chave da instalação, não há chave alheia que
  possa sair para o endereço escolhido pela organização.
- **Cobrança (ADR-0004):** a ADR-0004 continua valendo, mas esta ADR **supera a decisão D-9 e o
  "teto de IA do plano"** do [desenho dela](../superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md).
  Aquele teto só bloqueia chamadas feitas com a chave da instalação
  (`origemDaChave === 'chave_da_instalacao'`), que deixa de existir; construí-lo reintroduziria o
  caminho que esta ADR proíbe. Por isso o campo `teto_ia_usd_cents` de `cobranca_planos`, o recurso
  `'ia_usd_cents'` de `fn_limite_do_plano`, a linha "Teto de IA do plano" da §5 e o campo no
  `POST /api/v1/admin/cobranca/planos` saem do desenho. O controle de gasto de IA fica com o
  orçamento que cada organização escolhe (`ai_budgets`), sobre a própria chave. Medido em
  20/10/2026: nada disso foi construído (`grep -rln "teto_ia\|ia_usd_cents" lib app workers supabase`
  volta vazio).

---

## Alternativas consideradas e recusadas

| Alternativa                                                                               | Por que não                                                                                                                                            | Reconsideraríamos se                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| **Manter o fallback com teto por organização** (`ai_budgets` já existe)                   | O teto limita quanto a plataforma paga, não quem paga. A conta do provedor continua uma só, e a organização que não cadastrou chave não sabe que gasta | nunca: contraria D1                           |
| **Cobrar o uso da chave global pelo eixo 3 da ADR-0004** (repassar o custo na assinatura) | Transforma a plataforma em revendedora de IA, com margem, fatura e deriva de preço de provedor. Fora do modelo do projeto                              | decisão do dono de mudar o modelo — outra ADR |
| **Fallback só para pontos "baratos"** (clima, classificador)                              | O mesmo caminho silencioso, em menor escala, e mais uma régua para manter                                                                              | —                                             |

---

## O que esta ADR não decide

- **A forma final da cerca e da migration** que recusa versão de agente sem credencial: são da
  #33.
- **Credencial compartilhada entre organizações do mesmo licenciado:** não existe hoje; se um dia
  for pedida, é outra ADR, e a chave continua sendo de uma organização, nunca da instalação.
- **O destino de `TRANSCRIPTION_API_KEY`** (serviço de transcrição compatível): a #33 decide se
  vira credencial da organização ou sai.

## Aceite

**Aceita em 2026-10-20 pelo dono do produto.** O aceite não implementa nada: registra a decisão,
a condição de prazo e a regra de revisão. Para ver o que já chegou à `main`:
`git log --oneline origin/main -- lib/agent-engine/edge/llm/credentials.ts lib/ai/gateway-binding.ts lib/ai/embeddings/chave.ts`.
