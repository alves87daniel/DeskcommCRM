/**
 * O PAINEL DE PROVEDORES ALCANÇA TAMBÉM A PILHA ANTIGA.
 *
 * O sistema resolvia modelo por três caminhos que não se falam. O seam do
 * agente (`run-model-call.ts`) já obedece ao painel. Faltavam os pontos que
 * ainda passam pela pilha antiga — `sentiment_classify`, `bot_respond` e o
 * ensaio de agente.
 *
 * Enquanto faltavam, a tela cometia o pior erro que uma tela de configuração
 * pode cometer: oferecia esses três pontos, aceitava a escolha, dizia "salvo" —
 * e nenhuma chamada a respeitava. Botão que não controla nada é pior que botão
 * ausente, porque gasta a confiança de quem clicou. É a mesma classe de defeito
 * que `tests/unit/pontos-de-ia-completude.test.ts` proíbe no registro; ela só
 * não era pega aqui porque o teste olha a LISTA, não a execução.
 *
 * ## Por que este módulo existe em vez de o worker chamar o seam
 *
 * O seam do agente fala `pg.Pool`; estes workers falam Supabase. Migrá-los para
 * o seam é a mudança certa e é grande — mexe em transação, em credencial e no
 * caminho que hoje responde o cliente. Este módulo é a ponte mínima que faz o
 * painel valer JÁ nos três pontos, sem reescrever o runtime que está no ar.
 * A unificação segue registrada como dívida no handoff.
 *
 * ## A escada tem DOIS degraus, e nenhum deles é o `.env` (ADR-0005)
 *
 *  1. **Binding do ponto** (`ai_purpose_bindings`) — a escolha explícita do painel.
 *  2. **Credencial da organização** — a mais recente ativa e validada do provedor
 *     dela (`lib/ai/credenciais/mais-recente.ts`, a mesma ordem do seam).
 *  3. Nada: `null`, e o chamador PULA com motivo claro. Até 2026-10 havia um
 *     terceiro degrau, `padraoDaInstalacao`, que resolvia o modelo pelas chaves
 *     do `.env` da instalação — a chave de UMA conta pagando o clima, a resposta
 *     automática e o cartão do Jev de TODAS as organizações do servidor. A
 *     decisão do dono do produto (`docs/adr/0005-ia-paga-por-cada-organizacao.md`)
 *     o apagou, e `tests/unit/ia-sem-chave-da-plataforma.test.ts` reprova a volta.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { DEEPSEEK_ENDPOINT, REQUESTY_ENDPOINT } from "@/lib/agent-engine/edge/llm/providers";
import { fetchParaDestinoDaOrganizacao } from "@/lib/automation/destinos-internos-autorizados";
import { credencialMaisRecente } from "@/lib/ai/credenciais/mais-recente";
import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { escolherModeloNoCatalogo } from "./agents/escolher-modelo";
import { OPENROUTER_BASE_URL, type ModelId } from "./gateway";

export interface ModeloResolvido {
  model: LanguageModel;
  /** Para o log: qual modelo e de onde veio a decisão. */
  modelId: string;
  origem: "binding" | "credencial_da_organizacao";
}

/**
 * Resolve o modelo de um ponto, honrando o painel quando há binding.
 *
 * `organizationId` é obrigatório porque binding é por organização — e um
 * resolvedor que aceitasse organização opcional acabaria chamado sem ela no
 * caminho que mais importa, aplicando a configuração de ninguém.
 *
 * Sem binding, a ordem é a MESMA do resto do produto (`resolveOrgLlmConfig`):
 * a credencial ativa e validada mais recente do provider da organização — e
 * mais nada. Sem ela, `null`: a organização sem chave fica sem IA, com aviso,
 * nunca com a chave de outra conta.
 */
export interface OpcoesDoResolvedor {
  /**
   * Quando a credencial da organização não executa o modelo pedido, usar o
   * padrão da organização (`settings.llm`: provedor e modelo JUNTOS) em vez de
   * devolver `null`.
   *
   * É para o ponto que mede, não para o que conversa: o clima pede um id da
   * Anthropic, e uma empresa que atende pela OpenAI (ou Google, ou DeepSeek)
   * sem modelo escolhido para ele ficava com o clima mudo — enquanto o painel
   * dizia "Usando o padrão da organização" para esse mesmo ponto. O modelo do
   * agente que responde o cliente é a personalidade dele e muda pela
   * publicação, nunca por esta queda; por isso é opção, e não regra.
   */
  naFaltaUsarOPadraoDaOrganizacao?: boolean;
}

export async function resolverModeloDoPonto(
  purpose: string,
  organizationId: string,
  padrao: ModelId,
  opcoes: OpcoesDoResolvedor = {},
): Promise<ModeloResolvido | null> {
  const binding = await lerBinding(purpose, organizationId);

  if (binding === null) {
    const daOrg = await credencialDaOrganizacao(organizationId);
    if (daOrg === null) return null;
    const idNoProvider = idParaOProvider(daOrg.provider, String(padrao));
    if (idNoProvider !== null) {
      const model = instanciar(daOrg.provider, daOrg.apiKey, idNoProvider, null);
      if (model !== null) {
        // `modelId` continua sendo o id CANÔNICO, não o traduzido: é ele que
        // casa com o catálogo de preço no log de custo.
        return { model, modelId: String(padrao), origem: "credencial_da_organizacao" };
      }
    }
    return opcoes.naFaltaUsarOPadraoDaOrganizacao === true
      ? padraoDaOrganizacao(organizationId, daOrg)
      : null;
  }

  const apiKey = await decifrarChave(binding.credential_id, organizationId);
  if (apiKey === null) {
    // Binding configurado mas sem chave utilizável: o ponto fica SEM IA, com
    // rastro. Antes daqui ele caía na chave da instalação — e era justamente o
    // caso em que a credencial escolhida tinha sido revogada e a conta de outra
    // pessoa assumia em silêncio.
    logger.warn("[gateway-binding] binding sem credencial utilizável — o ponto fica sem IA", {
      organization_id: organizationId,
      purpose,
    });
    return null;
  }

  const model = instanciar(binding.provider, apiKey, binding.model_id, binding.base_url);
  if (model === null) {
    logger.warn("[gateway-binding] provider do binding é desconhecido — o ponto fica sem IA", {
      organization_id: organizationId,
      purpose,
      provider: binding.provider,
    });
    return null;
  }

  return { model, modelId: binding.model_id, origem: "binding" };
}

interface LinhaBinding {
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBinding(
  purpose: string,
  organizationId: string,
): Promise<LinhaBinding | null> {
  try {
    const admin = createAdminClient();
    // Admin client bypassa RLS, então o filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("ai_purpose_bindings")
      .select("provider, credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", purpose)
      .eq("is_enabled", true)
      .maybeSingle();
    return (data as LinhaBinding | null) ?? null;
  } catch (err) {
    // Tabela ausente (clone sem o baseline aplicado) não pode derrubar o
    // atendimento — mas também não pode passar em silêncio.
    logger.warn("[gateway-binding] não consegui ler o binding — seguindo sem ele", {
      organization_id: organizationId,
      purpose,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * O id canônico traduzido para o que o provider da organização entende — ou
 * `null` quando ele não sabe executar aquele modelo.
 *
 * O prefixo de um id canônico (`anthropic/claude-haiku-4-5`) é ROTA, não nome
 * de modelo: quem já está dentro do provedor recebe só o nome. A OpenRouter é a
 * exceção porque é agregadora — lá o prefixo é parte do endereço e vai inteiro.
 * A Requesty também é agregadora, e segue a mesma regra.
 *
 * O `null` é o freio do PR #151: id de outro provedor não vira chamada com a
 * chave da organização. Antes virava queda para a chave da instalação; agora
 * é `null` — ou o padrão da organização, quando o chamador pediu
 * (`naFaltaUsarOPadraoDaOrganizacao`).
 */
function idParaOProvider(provider: string, id: string): string | null {
  // Os roteadores levam o prefixo inteiro — inclusive o provedor personalizado
  // (#1642), que serve id de QUALQUER fabricante atrás do próprio endpoint.
  if (provider === "openrouter" || provider === "requesty" || provider === "custom")
    return id;
  if (!id.includes("/")) return id;
  if (id.startsWith(`${provider}/`)) return id.slice(provider.length + 1);
  return null;
}

/**
 * O último recurso de `naFaltaUsarOPadraoDaOrganizacao`: o par (provedor,
 * modelo) que a organização escolheu, com a credencial dela. Sem credencial do
 * provedor do par, `null` — nunca a chave de outra conta (ADR-0005).
 *
 * O par vai inteiro — a lição do PR #151. O `modelId` sai com o prefixo do
 * provedor, porque é ele que diz a `llm_calls` de quem é o gasto.
 */
async function padraoDaOrganizacao(
  organizationId: string,
  daOrg: { provider: string; apiKey: string },
): Promise<ModeloResolvido | null> {
  const llm = await llmDaOrganizacao(organizationId);
  if (llm === null || llm.defaultModel === null) return null;
  if (daOrg.provider !== llm.provider) return null;
  const defaultModel = await modeloDoProvedor(organizationId, llm.provider, llm.defaultModel);
  const modelId =
    llm.provider === "openrouter" ||
    llm.provider === "requesty" ||
    llm.provider === "custom" ||
    defaultModel.startsWith(`${llm.provider}/`)
      ? defaultModel
      : `${llm.provider}/${defaultModel}`;
  const id = idParaOProvider(llm.provider, modelId);
  const model = id === null ? null : instanciar(llm.provider, daOrg.apiKey, id, null);
  return model === null ? null : { model, modelId, origem: "credencial_da_organizacao" };
}

/**
 * O `default_model` da organização, se ele for DESTE provedor — senão, o do
 * catálogo do provedor pela régua do onboarding.
 *
 * Instalações feitas antes de `bootstrap-owner.ts` e `install.sh` gravarem o
 * par inteiro têm `{provider: 'openai', default_model: 'claude-sonnet-5'}`: o
 * gatilho semeou o par da Anthropic e o instalador trocou só o provedor. Montar
 * `openai/claude-sonnet-5` com isso mandava à OpenAI um id que ela não conhece,
 * em todo ponto que cai no padrão da empresa — e sem migration de dados, é aqui
 * que o par se conserta, na leitura.
 *
 * A pertença é conferida pelo id como o catálogo o guarda: sem o prefixo do
 * próprio provedor, exceto na OpenRouter, onde o `/` faz parte do id. Par
 * coerente passa intacto, inclusive quando não é o curado — é a escolha de
 * alguém. Catálogo vazio ou ilegível devolve o gravado: o desfecho de antes,
 * nunca um id inventado. Nunca lança.
 */
async function modeloDoProvedor(
  organizationId: string,
  provider: string,
  defaultModel: string,
): Promise<string> {
  const idNoCatalogo =
    provider !== "openrouter" && defaultModel.startsWith(`${provider}/`)
      ? defaultModel.slice(provider.length + 1)
      : defaultModel;
  const oGravado = (motivo: string): string => {
    logger.warn("[gateway-binding] não consegui conferir o modelo padrão no catálogo — usando o gravado", {
      organization_id: organizationId,
      provider,
      motivo,
    });
    return defaultModel;
  };
  try {
    // `ai_models` é o catálogo da instalação, sem `organization_id`: não há
    // tenant a filtrar aqui.
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_models")
      .select("model_id")
      .eq("provider", provider)
      .eq("model_id", idNoCatalogo)
      .limit(1)
      .maybeSingle();
    if (error) return oGravado(error.message);
    if (data !== null) return defaultModel;

    const escolha = await escolherModeloNoCatalogo(admin, provider);
    if (escolha === null) return oGravado("catálogo ilegível");
    if (!escolha.escolhido) return defaultModel;
    logger.warn("[gateway-binding] o modelo padrão da organização não é do provedor dela — usando o do catálogo", {
      organization_id: organizationId,
      provider,
      gravado: defaultModel,
      usado: escolha.modelId,
    });
    return escolha.modelId;
  } catch (erro) {
    return oGravado(erro instanceof Error ? erro.name : typeof erro);
  }
}

async function llmDaOrganizacao(
  organizationId: string,
): Promise<{ provider: string; defaultModel: string | null } | null> {
  try {
    const admin = createAdminClient();
    // Admin client bypassa RLS: filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    const llm = (data?.settings as { llm?: { provider?: unknown; default_model?: unknown } } | null)
      ?.llm;
    if (typeof llm?.provider !== "string" || llm.provider === "") return null;
    const defaultModel =
      typeof llm.default_model === "string" && llm.default_model !== "" ? llm.default_model : null;
    return { provider: llm.provider, defaultModel };
  } catch (erro) {
    logger.warn("[gateway-binding] não consegui ler o provedor da organização", {
      organization_id: organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * A credencial que a organização cadastrou para o SEU provider — a mais
 * recente ativa e validada, pelo resolvedor único (`credencialMaisRecente`).
 *
 * O MODELO não vem daqui — vem de quem chamou. Trocá-lo pelo `default_model`
 * da organização mandaria o modelo de conversa fazer o trabalho do
 * classificador barato, e é a metade errada do par que o PR #151 ensinou a não
 * cruzar: aqui provider e credencial andam juntos, que é o par que importa.
 *
 * Nunca lança: leitura que falha devolve `null` com rastro no log. Sem rastro,
 * uma leitura quebrada — baseline sem a tabela, chave de decifragem trocada —
 * seria indistinguível de "esta organização não cadastrou credencial".
 */
async function credencialDaOrganizacao(
  organizationId: string,
): Promise<{ provider: string; apiKey: string } | null> {
  const llm = await llmDaOrganizacao(organizationId);
  if (llm === null) return null;
  const credencial = await credencialMaisRecente(createAdminClient(), organizationId, llm.provider);
  if (credencial === null) {
    logger.warn("[gateway-binding] organização sem credencial ativa e validada do seu provedor — o ponto fica sem IA", {
      organizationId,
      provider: llm.provider,
    });
    return null;
  }
  return { provider: llm.provider, apiKey: credencial.apiKey };
}

/** Decifra a chave da organização. Plaintext só existe no retorno. */
async function decifrarChave(
  credentialId: string | null,
  organizationId: string,
): Promise<string | null> {
  if (credentialId === null) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data) return null;
    return decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
  } catch (erro) {
    // Fecha a ação, abre a informação, e o log leva só a classe do erro.
    logger.warn("credencial escolhida no painel não pôde ser decifrada — o ponto fica sem IA", {
      credentialId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * Instancia o provider. Espelha `createDefaultRegistry` do agent-engine — e a
 * duplicação é consciente e temporária: unificar exige que estes workers falem
 * `pg.Pool`, que é a dívida registrada no handoff. Provider desconhecido
 * devolve `null` para o chamador pular com aviso, nunca um fallback silencioso
 * para outro provedor.
 */
function instanciar(
  provider: string,
  apiKey: string,
  modelId: string,
  baseUrl: string | null,
): LanguageModel | null {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? OPENROUTER_BASE_URL }).chat(modelId); // ver providers.ts
    // A DeepSeek fala a API da OpenAI. Sem este caso, uma organização em
    // DeepSeek cairia no `default` (null) e o ponto ficaria sem IA com aviso —
    // a tela ofereceria um provedor que estes workers ignoram.
    case "deepseek":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? DEEPSEEK_ENDPOINT })(modelId);
    case "requesty":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? REQUESTY_ENDPOINT }).chat(modelId); // ver providers.ts
    // Provedor personalizado (#1642): endpoint do operador. Sem `baseUrl` não
    // há onde ir — `null` deixa o chamador pular COM AVISO, que é o contrato
    // deste switch; inventar um endpoint seria mandar a chave para outro lugar.
    case "custom":
      return baseUrl
        ? createOpenAI({ apiKey, baseURL: baseUrl, fetch: fetchParaDestinoDaOrganizacao() }).chat(modelId)
        : null;
    default:
      return null;
  }
}
