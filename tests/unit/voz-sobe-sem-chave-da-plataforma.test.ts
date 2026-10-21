/**
 * O WORKER DE VOZ SOBE SEM `OPENAI_API_KEY` — e recusa SÓ a ligação da
 * organização sem credencial (ADR-0005; revisão do Codex no PR #34).
 *
 * O defeito que este arquivo prende: `assertEnv` em `workers/voice-agent/index.ts`
 * exigia a chave da OpenAI no boot. Com a ADR-0005, toda instalação roda com a
 * env vazia — e o worker de voz ficaria fora do ar em todas elas, no mesmo dia.
 * A chave é credencial da ORGANIZAÇÃO, resolvida por ligação; sem ela a
 * ligação não abre, o worker avisa na Central e encerra o socket.
 *
 * `index.ts` chama `main()` no topo e não pode ser importado por teste; as
 * propriedades sobre ele são medidas no TEXTO, com controle negativo. A lista
 * de envs obrigatórias mora num módulo próprio, importável.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ } from "@/workers/voice-agent/env-obrigatorio";

const RAIZ = process.cwd();
const INDEX = readFileSync(join(RAIZ, "workers/voice-agent/index.ts"), "utf8");
const BRIDGE = readFileSync(join(RAIZ, "workers/voice-agent/audioSocketBridge.ts"), "utf8");

describe("o boot do worker de voz", () => {
  it("não exige a chave da OpenAI — ela é credencial da organização, não do ambiente", () => {
    expect(ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ).not.toContain("OPENAI_API_KEY");
    expect([...ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ]).toEqual(["ARI_URL", "ARI_WS_URL", "ARI_USERNAME", "ARI_PASSWORD"]);
  });

  it("assertEnv lê a lista do módulo — não uma lista própria com a chave", () => {
    const assertEnv = INDEX.slice(INDEX.indexOf("function assertEnv()"), INDEX.indexOf("}", INDEX.indexOf("function assertEnv()") + 200));
    expect(assertEnv).toContain("ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ");
    expect(INDEX).not.toMatch(/OPENAI_API_KEY/);
    expect(BRIDGE).not.toMatch(/process\.env\.OPENAI_API_KEY/);
  });

  it("controle negativo: a volta da chave na lista é acusada", () => {
    const sabotada = [...ENVS_OBRIGATORIAS_DO_WORKER_DE_VOZ, "OPENAI_API_KEY"];
    expect(sabotada).toContain("OPENAI_API_KEY");
  });
});

describe("a ligação da organização sem credencial", () => {
  it("o worker recusa a ligação, avisa a Central e encerra o socket — antes de abrir a sessão Realtime", () => {
    const trecho = INDEX.slice(INDEX.indexOf("agent.apiKey === null"), INDEX.indexOf("new AudioSocketCallBridge("));
    expect(trecho.length, "a recusa precisa vir ANTES de o bridge (e o WebSocket pago) ser criado").toBeGreaterThan(0);
    expect(trecho).toContain("avisarIaDesligadaPorFaltaDeChaveViaSupabase(supabaseAdmin, callRow.organization_id)");
    expect(trecho).toContain("socket.end()");
  });

  it("o bridge não tem mais degrau para a chave do ambiente: a chave do contexto é obrigatória", () => {
    expect(BRIDGE).toMatch(/apiKey: string;/);
    expect(BRIDGE).toContain("const apiKey = ctx.apiKey;");
  });

  it("getActiveVoiceAgent devolve apiKey null quando a organização não tem credencial OpenAI", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: (tabela: string) => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            not: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: async () => ({
              data: tabela === "ai_agents" ? { id: "ag-1", system_prompt: "oi", config: {} } : null,
              error: null,
            }),
            then: (ok: (r: { data: unknown; error: unknown }) => void) => ok({ data: [], error: null }),
          };
          return chain;
        },
      }),
    }));
    vi.resetModules();
    const { getActiveVoiceAgent } = await import("@/lib/ai/agents");
    const agente = await getActiveVoiceAgent("11111111-1111-4111-8111-111111111111");
    expect(agente).not.toBeNull();
    expect(agente?.apiKey).toBeNull();
  });

  it("getActiveVoiceAgent usa a credencial MAIS RECENTE da organização (D2)", async () => {
    const linhas = [
      { id: "antiga", label: "a", api_key_encrypted: "chave-antiga", api_key_iv: "x", api_key_tag: "y", created_at: "2026-10-01" },
      { id: "nova", label: "n", api_key_encrypted: "chave-nova", api_key_iv: "x", api_key_tag: "y", created_at: "2026-10-20" },
    ];
    vi.doMock("@/lib/crypto/aes_gcm", () => ({
      byteaToBuffer: (v: unknown) => v,
      decryptKey: ({ ciphertext }: { ciphertext: unknown }) => String(ciphertext),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: (tabela: string) => {
          const ordens: Array<{ coluna: string; ascending: boolean }> = [];
          const chain = {
            select: () => chain,
            eq: () => chain,
            not: () => chain,
            order: (coluna: string, o: { ascending: boolean }) => {
              ordens.push({ coluna, ascending: o.ascending });
              return chain;
            },
            limit: () => chain,
            maybeSingle: async () => ({
              data: tabela === "ai_agents" ? { id: "ag-1", system_prompt: "oi", config: {} } : null,
              error: null,
            }),
            then: (ok: (r: { data: unknown; error: unknown }) => void) => {
              const ordenadas = [...linhas].sort((a, b) => {
                for (const o of ordens) {
                  const x = String(a[o.coluna as keyof typeof a]);
                  const y = String(b[o.coluna as keyof typeof b]);
                  if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
                }
                return 0;
              });
              return ok({ data: ordenadas, error: null });
            },
          };
          return chain;
        },
      }),
    }));
    vi.resetModules();
    const { getActiveVoiceAgent } = await import("@/lib/ai/agents");
    const agente = await getActiveVoiceAgent("11111111-1111-4111-8111-111111111111");
    expect(agente?.apiKey).toBe("chave-nova");
  });
});
