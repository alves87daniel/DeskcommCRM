/**
 * CONCLUIR O ASSISTENTE CARIMBA `onboarded_at` NOS DOIS MODOS — E O RASTRO DIZ
 * QUAL FOI (CG-IAM-01).
 *
 * `onboarded_at` significa "o administrador concluiu a configuração inicial":
 * é o que o gate de `/app` lê, o que a plataforma filtra como "em onboarding" e
 * o que o painel mostra como "Onboarding concluído". O modo simplificado não
 * muda esse contrato nem promete estrutura que não existe (funis Green ficam
 * fora desta entrega) — mas quem lê o rastro precisa saber que a organização
 * foi configurada pelo percurso enxuto, sem WhatsApp nem IA.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const h = vi.hoisted(() => ({
  modo: "herdado" as "herdado" | "simplificado",
  escritas: [] as { tabela: string; op: string; payload: unknown }[],
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "u1",
    email: "dona@x.example",
    full_name: "Dona",
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Licenciada", role: "admin" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/onboarding/modo", () => ({ modoDoOnboarding: () => h.modo }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      let op = "select";
      let payload: unknown;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        is: () => b,
        update: (p: unknown) => ((op = "update"), (payload = p), b),
        insert: (p: unknown) => ((op = "insert"), (payload = p), b),
        maybeSingle: async () => ({ data: { onboarded_at: null }, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          if (op !== "select") h.escritas.push({ tabela, op, payload });
          return Promise.resolve({ data: null, error: null }).then(ok);
        },
      };
      return b;
    },
  }),
}));

import { audit } from "@/lib/audit";
import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";

async function concluir(): Promise<string> {
  try {
    await finishOnboarding();
  } catch (e) {
    return (e as Error).message.replace(/^REDIRECT:/, "");
  }
  throw new Error("finishOnboarding não redirecionou");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.escritas = [];
});

describe("concluir o assistente", () => {
  for (const modo of ["herdado", "simplificado"] as const) {
    it(`${modo}: carimba onboarded_at, emite tenant.onboarded e registra o modo`, async () => {
      h.modo = modo;
      await concluir();

      expect(h.escritas.find((e) => e.tabela === "organizations")?.payload).toEqual({
        onboarded_at: expect.any(String),
      });
      // O payload do evento é contrato de quem o consome: não ganha campo novo.
      expect(h.escritas.find((e) => e.tabela === "event_log")?.payload).toMatchObject({
        event_type: "tenant.onboarded",
        payload: { completed_by: "u1" },
      });
      const concluiu = vi
        .mocked(audit)
        .mock.calls.map((c) => c[0])
        .find((a) => a.action === "onboarding.completed");
      expect(concluiu?.metadata).toEqual({ modo });
    });
  }

  it("herdado entrega na caixa de conversas, como sempre", async () => {
    h.modo = "herdado";
    expect(await concluir()).toBe("/app/inbox");
  });

  it("simplificado entrega na home do CRM — sem WhatsApp, a caixa de conversas estaria vazia", async () => {
    h.modo = "simplificado";
    expect(await concluir()).toBe("/app");
  });
});
