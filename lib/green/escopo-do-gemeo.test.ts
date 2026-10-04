/**
 * SPIKE-GREEN-03 — o id do escopo de execução (`x-green-scope-id`) é a chave do gêmeo legado.
 *
 * O banco (0508) reconhece o `lead.stage_changed` legado de um writer como gêmeo da mutação
 * canonizada quando as duas requests vieram do MESMO escopo. Esta suíte prova o lado do
 * processo: o mesmo id em toda request de um escopo (inclusive o builder preguiçoso do
 * PostgREST e o escopo de requisição preenchido pelo gate), ids diferentes entre escopos —
 * aninhados, irmãos ou concorrentes —, e nenhum header sem contexto (transporte de antes).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import {
  abrirContextoGreenDaRequisicao,
  GREEN_MUTATION_CONTEXT_HEADER,
  GREEN_SCOPE_HEADER,
  runGreenRequestBoundary,
  withGreenMutationContext,
  withGreenSystemRoot,
  withoutGreenMutationContext,
} from "./mutation-context";

const PUBLICA = "https://abcxyz.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const chamadas: Array<{ url: string; headers: Headers }> = [];
const fetchOriginal = globalThis.fetch;
beforeEach(() => {
  chamadas.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    chamadas.push({ url, headers: new Headers(init?.headers) });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

const f = fetchDoServidor("", PUBLICA);
const escopoDe = (i: number) => chamadas[i]!.headers.get(GREEN_SCOPE_HEADER);
const ctx = {
  source: "mcp",
  request_id: "req-1",
  actor: { kind: "api_token" as const, id: "tok" },
};

describe("o escopo viaja junto do contexto", () => {
  it("mutação e emissão do MESMO escopo levam o MESMO id; o id é um UUID", async () => {
    await withGreenMutationContext(ctx, async () => {
      await f(`${PUBLICA}/rest/v1/crm_leads?id=eq.1`, { method: "PATCH" });
      await f(`${PUBLICA}/rest/v1/rpc/emit_event`, { method: "POST" });
    });
    expect(chamadas).toHaveLength(2);
    expect(escopoDe(0)).toMatch(UUID);
    expect(escopoDe(1)).toBe(escopoDe(0));
  });

  it("sem contexto, nenhum header (nem o do escopo): transporte byte a byte o de antes", async () => {
    await f(`${PUBLICA}/rest/v1/crm_leads`);
    await withoutGreenMutationContext(() => f(`${PUBLICA}/rest/v1/crm_leads`));
    await runGreenRequestBoundary(() => f(`${PUBLICA}/rest/v1/crm_leads`)); // gate ainda não rodou
    for (const c of chamadas) {
      expect(c.headers.get(GREEN_SCOPE_HEADER)).toBeNull();
      expect(c.headers.get(GREEN_MUTATION_CONTEXT_HEADER)).toBeNull();
    }
  });

  it("escopos diferentes nunca compartilham id: irmãos, aninhados, raiz de sistema, concorrentes", async () => {
    await withGreenMutationContext(ctx, () => f(`${PUBLICA}/rest/v1/a`));
    await withGreenMutationContext(ctx, () => f(`${PUBLICA}/rest/v1/b`));
    await withGreenMutationContext(ctx, async () => {
      await f(`${PUBLICA}/rest/v1/pai`);
      await withGreenMutationContext({ source: "automation" }, () => f(`${PUBLICA}/rest/v1/filho`));
      await withGreenSystemRoot(ctx, () => f(`${PUBLICA}/rest/v1/raiz`));
      await f(`${PUBLICA}/rest/v1/pai-de-novo`);
    });
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all(
      [3, 1, 2].map((ms, i) =>
        withGreenMutationContext(ctx, async () => {
          await espera(ms);
          await f(`${PUBLICA}/rest/v1/c?i=${i}`);
          await espera(ms);
          await f(`${PUBLICA}/rest/v1/c?i=${i}`);
        }),
      ),
    );
    const porUrl = (s: string) =>
      chamadas.filter((c) => c.url.endsWith(s)).map((c) => c.headers.get(GREEN_SCOPE_HEADER));
    const [a] = porUrl("/a");
    const [b] = porUrl("/b");
    const [pai, paiDeNovo] = [porUrl("/pai")[0], porUrl("/pai-de-novo")[0]];
    const [filho, raiz] = [porUrl("/filho")[0], porUrl("/raiz")[0]];
    expect(new Set([a, b, pai, filho, raiz]).size).toBe(5);
    expect(paiDeNovo).toBe(pai); // o filho terminou; o pai continua o mesmo escopo
    const concorrentes = [0, 1, 2].map((i) => porUrl(`?i=${i}`));
    for (const par of concorrentes) expect(par[1]).toBe(par[0]);
    expect(new Set(concorrentes.map((p) => p[0])).size).toBe(3);
  });

  it("requisição humana: o escopo é o da boundary, preenchido pelo gate — o mesmo antes e depois de vincular", async () => {
    await runGreenRequestBoundary(async () => {
      const req = abrirContextoGreenDaRequisicao({
        source: "http_session",
        request_id: "r-1",
        correlation_id: "r-1",
      });
      await f(`${PUBLICA}/rest/v1/crm_leads`, { method: "PATCH" });
      req.vincular({ actor: { kind: "api_token", id: "tok" } });
      await f(`${PUBLICA}/rest/v1/rpc/emit_event`, { method: "POST" });
    });
    await runGreenRequestBoundary(async () => {
      abrirContextoGreenDaRequisicao({
        source: "http_session",
        request_id: "r-2",
        correlation_id: "r-2",
      });
      await f(`${PUBLICA}/rest/v1/crm_leads`, { method: "PATCH" });
    });
    expect(escopoDe(0)).toMatch(UUID);
    expect(escopoDe(1)).toBe(escopoDe(0));
    expect(escopoDe(2)).not.toBe(escopoDe(0));
  });

  it("o builder preguiçoso do PostgREST (thenable) leva o id do escopo em que foi consumido", async () => {
    const preguicoso = {
      then: (ok: (v: unknown) => void) => f(`${PUBLICA}/rest/v1/rpc/x`).then(ok),
    };
    await withGreenMutationContext(ctx, async () => {
      await f(`${PUBLICA}/rest/v1/antes`);
      await withGreenMutationContext(ctx, () => preguicoso as unknown as Promise<unknown>);
    });
    expect(escopoDe(1)).toMatch(UUID);
    expect(escopoDe(1)).not.toBe(escopoDe(0));
  });
});
