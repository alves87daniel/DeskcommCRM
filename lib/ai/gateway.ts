/**
 * Constantes da camada de modelos — ids canônicos no formato
 * `"provedor/modelo"` e o endereço da OpenRouter.
 *
 * ═══ O QUE SAIU DAQUI, E POR QUÊ (ADR-0005) ═══
 *
 * Este arquivo nasceu como "wrapper do Vercel AI Gateway": `resolveLanguageModel`
 * roteava um id pelo gateway, pela OpenRouter ou pelo provedor direto usando as
 * chaves do `.env` da INSTALAÇÃO, e `isEmbeddingProviderConfigured` respondia
 * "tem IA" olhando as mesmas variáveis. Era o segundo resolvedor que fazia a
 * chave de uma conta pagar a IA de todas as organizações do servidor. A
 * decisão do dono do produto (`docs/adr/0005-ia-paga-por-cada-organizacao.md`)
 * acabou com a chave da instalação: a única chave é a credencial da organização,
 * e quem a resolve é `lib/ai/gateway-binding.ts` (pontos da pilha antiga) e
 * `lib/agent-engine/edge/llm/credentials.ts` (o seam do agente). O gateway da
 * Vercel segue possível — como credencial da organização, nunca como chave do
 * ambiente.
 *
 * Anti-pattern guard (CLAUDE.md): we never `import Anthropic from "@anthropic-ai/sdk"`.
 * Only model strings via the gateway-shaped `ai` SDK calls.
 */

/** Endpoint da OpenRouter. Compatível com a API da OpenAI, então o provider
 *  `@ai-sdk/openai` fala com ela sem dependência nova. É ENDEREÇO, não chave:
 *  a variável diz para onde a chave DA ORGANIZAÇÃO vai quando a instalação
 *  passa por um proxy — nunca de quem é a chave. */
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";

export type ModelId =
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-5"
  | "anthropic/claude-haiku-4-5"
  | "openai/text-embedding-3-small"
  // Allow arbitrary tenant-configured strings without losing autocomplete on the canonical ones.
  | (string & {});

export const DEFAULT_BOT_MODEL: ModelId = "anthropic/claude-sonnet-5";
export const DEFAULT_CLASSIFIER_MODEL: ModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_EMBEDDING_MODEL: ModelId = "openai/text-embedding-3-small";
