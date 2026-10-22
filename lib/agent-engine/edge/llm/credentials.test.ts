/**
 * A ÚNICA CHAVE É A CREDENCIAL DA ORGANIZAÇÃO (ADR-0005).
 *
 * Até 2026-10 este arquivo provava o contrário: que a chave da Anthropic, da
 * OpenAI e da OpenRouter lidas do `.env` respondiam pela organização sem
 * credencial ("chave de plataforma por provider"), e que a credencial escolhida
 * e revogada "caía no .env". Era a prova de que a conta de UMA pessoa pagava a
 * IA de todas as organizações do servidor. A decisão do dono do produto apagou
 * os degraus; estes casos provam a ausência deles — e que a ausência é
 * TERMINAL para a fila (D3), nunca um retry.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-byok-da-org",
}));

import {
  llmEdgeConfigFromEnv,
  resolveOrgLlmConfig,
  LlmNotConfiguredError,
  type LlmEdgeConfig,
} from "./credentials";

/** Pool falso: 1ª query devolve settings->'llm', 2ª devolve credenciais BYOK. */
function poolFake(settingsLlm: unknown, credenciais: unknown[]) {
  let n = 0;
  const sqls: string[] = [];
  return {
    pool: {
      query: async (sql: string) => {
        sqls.push(sql);
        n += 1;
        return n === 1 ? { rows: [{ llm: settingsLlm }] } : { rows: credenciais };
      },
    } as never,
    sqls,
  };
}

const SEM_BYOK: unknown[] = [];
const COM_BYOK = [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }];

describe("resolveOrgLlmConfig — a única chave é a credencial da organização", () => {
  it("usa a credencial BYOK da org, e diz que é dela", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-4o" }, COM_BYOK).pool,
      {},
      "org-1",
    );
    expect(out.apiKey).toBe("chave-byok-da-org");
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
  });

  it.each(["anthropic", "openai", "openrouter"] as const)(
    "sem credencial da org em %s: LlmNotConfiguredError — nenhum degrau abaixo",
    async (provider) => {
      await expect(
        resolveOrgLlmConfig(poolFake({ provider }, SEM_BYOK).pool, {}, "org-1"),
      ).rejects.toBeInstanceOf(LlmNotConfiguredError);
    },
  );

  it("o override de provider (a transcrição pede OpenAI numa org Anthropic) também exige a credencial DELA", async () => {
    await expect(
      resolveOrgLlmConfig(
        poolFake({ provider: "anthropic", default_model: "claude-sonnet-4-6" }, SEM_BYOK).pool,
        {},
        "org-1",
        { provider: "openai" },
      ),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("credencial ESCOLHIDA e revogada: recusa, em vez de cair numa chave que não é dela", async () => {
    // O degrau menos óbvio da escada antiga: quem configurou escolheu uma
    // credencial da empresa, a linha deixou de estar ativa, a consulta voltava
    // vazia e o resolvedor entregava a chave do .env — a de outra conta.
    await expect(
      resolveOrgLlmConfig(poolFake({ provider: "openrouter" }, SEM_BYOK).pool, {}, "org-1", {
        provider: "openrouter",
        credentialId: "cred-revogada",
      }),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("sem override, a consulta pede a credencial MAIS RECENTE do provedor (D2)", async () => {
    const { pool, sqls } = poolFake({ provider: "openai" }, COM_BYOK);
    await resolveOrgLlmConfig(pool, {}, "org-1");
    expect(sqls[1]).toMatch(/order by created_at desc, id desc/);
  });

  it("o erro é TERMINAL: a fila cancela em vez de tentar cinco vezes (D3)", () => {
    const erro = new LlmNotConfiguredError() as unknown as { terminal?: unknown };
    expect(erro.terminal).toBe(true);
  });

  it("a mensagem manda para IA › Credenciais e não cita variável de ambiente", () => {
    const { message } = new LlmNotConfiguredError();
    expect(message).toMatch(/IA › Credenciais/);
    expect(message).not.toMatch(/API_KEY|\.env|plataforma, conforme/);
  });
});

describe("llmEdgeConfigFromEnv — só knobs, nenhuma chave", () => {
  it("monta os knobs e nada mais", () => {
    const cfg = llmEdgeConfigFromEnv({ LLM_CACHE_TTL: "5m" });
    expect(cfg).toEqual({ cacheTtl: "5m", deepseekThinking: "provider", budgetEnforcement: "on" });
  });

  it("uma chave que chegue por acidente não vira campo da config", () => {
    // O parâmetro não declara chave nenhuma; se alguém a passar por `as never`
    // (o caminho de um script antigo), ela não atravessa.
    const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-y" } as never);
    expect(JSON.stringify(cfg)).not.toMatch(/ApiKey|sk-/);
  });

  it("o tipo da config recusa campo de chave — é o compilador que vigia", () => {
    // @ts-expect-error — a ADR-0005 tirou a chave da config; voltar a aceitá-la é reprovado aqui.
    const cfg: LlmEdgeConfig = { anthropicApiKey: "sk-ant-x" };
    expect(cfg).toBeTruthy();
  });
});
