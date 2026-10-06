/**
 * SPIKE Green — transporte: o `fetchDoServidor` injeta `x-green-mutation-context`
 * NA HORA da chamada, nos dois ramos (identidade e reescrita de URL), só quando
 * há contexto, e sob concorrência cada request leva o contexto da própria
 * cadeia (S13). O navegador não passa por aqui (prova estrutural).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import {
  GREEN_MUTATION_CONTEXT_HEADER,
  parseGreenMutationContext,
  withGreenMutationContext,
} from "./mutation-context";

const PUBLICA = "https://abcxyz.supabase.co";
const INTERNA = "http://kong:8000";

const chamadas: Array<{ url: string; headers: Headers }> = [];
const fetchOriginal = globalThis.fetch;

beforeEach(() => {
  chamadas.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    chamadas.push({ url, headers });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.restoreAllMocks();
});

function contextoDe(h: Headers) {
  const valor = h.get(GREEN_MUTATION_CONTEXT_HEADER);
  return valor ? parseGreenMutationContext(valor) : null;
}

describe("injeção do header", () => {
  it("sem contexto, o transporte é byte a byte o de antes (nenhum header novo)", async () => {
    await fetchDoServidor(INTERNA, PUBLICA)(`${PUBLICA}/rest/v1/crm_leads`, {
      headers: { apikey: "k" },
    });
    await fetchDoServidor("", PUBLICA)(`${PUBLICA}/rest/v1/crm_leads`, {
      headers: { apikey: "k" },
    });
    expect(chamadas).toHaveLength(2);
    for (const c of chamadas) {
      expect(c.headers.get(GREEN_MUTATION_CONTEXT_HEADER)).toBeNull();
      expect(c.headers.get("apikey")).toBe("k");
    }
    expect(chamadas[0]!.url).toBe(`${INTERNA}/rest/v1/crm_leads`);
  });

  it("com contexto, os dois ramos injetam o header e preservam os headers do SDK", async () => {
    await withGreenMutationContext(
      { source: "mcp", request_id: "req-1", actor: { kind: "api_token", id: "tok" } },
      async () => {
        await fetchDoServidor(INTERNA, PUBLICA)(`${PUBLICA}/rest/v1/crm_leads`, {
          headers: { apikey: "k" },
        });
        await fetchDoServidor("", PUBLICA)(new URL(`${PUBLICA}/rest/v1/crm_leads`), {
          headers: { apikey: "k" },
        });
        await fetchDoServidor(
          INTERNA,
          PUBLICA,
        )(new Request(`${PUBLICA}/rest/v1/rpc/x`, { headers: { apikey: "k" } }));
      },
    );
    expect(chamadas).toHaveLength(3);
    for (const c of chamadas) {
      expect(c.headers.get("apikey")).toBe("k");
      expect(contextoDe(c.headers)).toEqual({
        v: 1,
        source: "mcp",
        request_id: "req-1",
        actor: { kind: "api_token", id: "tok" },
      });
    }
    expect(chamadas[0]!.url).toBe(`${INTERNA}/rest/v1/crm_leads`);
    expect(chamadas[2]!.url).toBe(`${INTERNA}/rest/v1/rpc/x`);
  });

  it("S13 — requests concorrentes de contextos diferentes não trocam header", async () => {
    const fetchServidor = fetchDoServidor(INTERNA, PUBLICA);
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cadeia = (rotulo: string, ms: number) =>
      withGreenMutationContext(
        { source: rotulo, request_id: `req-${rotulo}`, actor: { kind: "system", id: rotulo } },
        async () => {
          await espera(ms);
          await fetchServidor(`${PUBLICA}/rest/v1/crm_leads?rotulo=${rotulo}`);
          await espera(ms);
          await fetchServidor(`${PUBLICA}/rest/v1/crm_leads?rotulo=${rotulo}`);
        },
      );
    await Promise.all([cadeia("a", 4), cadeia("b", 1), cadeia("c", 2)]);
    expect(chamadas).toHaveLength(6);
    for (const c of chamadas) {
      const rotulo = new URL(c.url).searchParams.get("rotulo");
      const ctx = contextoDe(c.headers);
      expect(ctx?.source).toBe(rotulo);
      expect(ctx?.request_id).toBe(`req-${rotulo}`);
      expect(ctx?.actor?.id).toBe(rotulo);
    }
  });
});

describe("o navegador não recebe o transporte", () => {
  it("lib/supabase/browser.ts não importa fetchDoServidor nem o módulo Green", () => {
    const browser = readFileSync(join(process.cwd(), "lib/supabase/browser.ts"), "utf8");
    expect(browser).not.toMatch(/fetch-do-servidor/);
    expect(browser).not.toMatch(/lib\/green/);
  });
});
