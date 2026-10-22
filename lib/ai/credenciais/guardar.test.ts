/**
 * A CREDENCIAL QUE PASSA NO PROVEDOR FECHA O AVISO "IA desligada por falta de
 * chave" (ADR-0005, D3 — item 20 da #33). É a validação em segundo plano de
 * `guardarCredencial` (e de `rotacionarCredencial`) quem fecha: ela é o único
 * ponto em que o produto SABE que a organização passou a ter chave utilizável.
 * A que o provedor recusa não fecha nada — o aviso continuaria verdadeiro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: () => ({ ciphertext: Buffer.from("ct"), iv: Buffer.from("iv"), tag: Buffer.from("tag"), last4: "c0de" }),
  bufToBytea: (b: Buffer) => `\\x${b.toString("hex")}`,
}));
const validacao = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/ai/provider-validators", () => ({
  validateProviderKey: vi.fn(async () => (validacao.ok ? { ok: true, models: ["m"] } : { ok: false, error: "auth_failed_401" })),
}));

import { guardarCredencial, rotacionarCredencial } from "./guardar";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Dublê do admin que registra o UPDATE da Central e responde o resto. */
function adminFalso() {
  const fechamentos: Array<{ patch: unknown; filtros: Array<[string, unknown]> }> = [];
  const from = (tabela: string) => {
    if (tabela === "agent_inbox_items") {
      const atual = { patch: null as unknown, filtros: [] as Array<[string, unknown]> };
      const cadeia = {
        update: (p: unknown) => {
          atual.patch = p;
          return cadeia;
        },
        eq: (c: string, v: unknown) => {
          atual.filtros.push([c, v]);
          return cadeia;
        },
        in: (c: string, v: unknown) => {
          atual.filtros.push([c, v]);
          fechamentos.push(atual);
          return Promise.resolve({ data: null, error: null });
        },
      };
      return cadeia;
    }
    // ai_provider_credentials: insert → select → single; update → eq → eq; select(base_url) → eq → eq → maybeSingle
    const cadeia = {
      insert: () => cadeia,
      update: () => cadeia,
      select: () => cadeia,
      eq: () => cadeia,
      single: async () => ({ data: { id: "cred-1" }, error: null }),
      maybeSingle: async () => ({ data: { id: "cred-1", base_url: null }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return cadeia;
  };
  return { admin: { from } as never, fechamentos };
}

beforeEach(() => {
  validacao.ok = true;
});

describe("a credencial utilizável fecha o aviso de IA sem chave (item 20)", () => {
  it("cadastrar uma chave que o provedor ACEITA fecha o aviso aberto da organização", async () => {
    const { admin, fechamentos } = adminFalso();
    const r = await guardarCredencial({ admin, orgId: ORG, userId: "u1", provider: "anthropic", label: "Anthropic", apiKey: "sk-ant-x" });
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(fechamentos).toHaveLength(1));
    expect(fechamentos[0]!.patch).toEqual({ status: "resolved" });
    expect(fechamentos[0]!.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["status", "open"],
      ]),
    );
  });

  it("chave que o provedor RECUSA não fecha nada — o aviso continua verdadeiro", async () => {
    validacao.ok = false;
    const { admin, fechamentos } = adminFalso();
    const r = await guardarCredencial({ admin, orgId: ORG, userId: "u1", provider: "anthropic", label: "Anthropic", apiKey: "sk-ant-x" });
    expect(r.ok).toBe(true); // guardar e validar são coisas diferentes
    await new Promise((resolve) => setTimeout(resolve, 20)); // a validação em segundo plano já correu
    expect(fechamentos).toHaveLength(0);
  });

  it("rotacionar para uma chave que passa também fecha", async () => {
    const { admin, fechamentos } = adminFalso();
    const r = await rotacionarCredencial({
      admin,
      orgId: ORG,
      userId: "u1",
      credentialId: "cred-1",
      provider: "anthropic",
      apiKey: "sk-ant-nova",
    });
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(fechamentos).toHaveLength(1));
  });
});
