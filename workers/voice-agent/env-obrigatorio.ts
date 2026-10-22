/**
 * O que o worker de voz EXIGE no boot — e só isso.
 *
 * Fora daqui, de propósito, a chave da OpenAI: ela é credencial da ORGANIZAÇÃO,
 * resolvida por ligação (`lib/ai/agents.ts`), nunca do ambiente (ADR-0005).
 * Enquanto `OPENAI_API_KEY` estava nesta lista, o worker se recusava a subir em
 * toda instalação com a env vazia — que, desde a ADR-0005, é toda instalação:
 * o serviço de voz ficaria fora do ar no mesmo dia em que a chave da instalação
 * deixasse de existir. Medido pela revisão do Codex no PR #34, e vigiado por
 * `tests/unit/voz-sobe-sem-chave-da-plataforma.test.ts`.
 *
 * Lista num módulo próprio porque `index.ts` chama `main()` no topo e não pode
 * ser importado por teste.
 */
export const ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ = [
  "ARI_URL",
  "ARI_WS_URL",
  "ARI_USERNAME",
  "ARI_PASSWORD",
] as const;
