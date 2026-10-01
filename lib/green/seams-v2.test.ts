/**
 * SPIKE Green v2 — os seams que a auditoria do v1 achou faltando:
 *
 * - boundary de REQUISIÇÃO: na v3 quem a delimita é `runGreenRequestBoundary`
 *   (a rota a declara no handler exportado); o gate de auth
 *   (`abrirContextoGreenDaRequisicao`) só PREENCHE. O contexto chega ao resto
 *   da rota, não volta para o framework nem cruza requisições. (Na v2 o gate
 *   abria sozinho, por `enterWith`; os casos abaixo que afirmavam esse
 *   mecanismo foram reescritos para o contrato v3 — ver
 *   docs/spike/GREEN-MUTATION-CONTEXT-V3.md, "Testes antigos alterados".)
 * - `requireRole` (rotas humanas): metadata operacional da requisição, sem ator
 *   (o banco deriva `auth.uid()`);
 * - `resolveAuthDual` no ramo Bearer: o ator técnico do token (agenda por token);
 * - o client do agent-worker (`crmEdgeConfigFromEnv`): o header SAI do processo;
 * - o handoff do runtime legado (`finalizeHandoff`): roda com contexto.
 *
 * Quem observa o contexto aqui é um handler/fetch de mentira no lugar do writer.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as McpAuth from "@/lib/mcp/auth";

import {
  GREEN_MUTATION_CONTEXT_HEADER,
  abrirContextoGreenDaRequisicao,
  currentGreenMutationContext,
  parseGreenMutationContext,
  runGreenRequestBoundary,
  withGreenMutationContext,
  type GreenMutationContextV1,
} from "./mutation-context";

const ORG = "00000000-0000-4000-8000-00000000000a";
const USUARIO = "00000000-0000-4000-8000-0000000000b1";
const TOKEN = "00000000-0000-4000-8000-0000000000c1";
const RUN = "00000000-0000-4000-8000-0000000000d1";
const CONVERSA = "00000000-0000-4000-8000-0000000000e1";

const visto = vi.hoisted(() => ({
  ctx: undefined as GreenMutationContextV1 | undefined,
  bearer: null as null | { actor: { type: string; id: string }; apiTokenId: string },
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: "manager", error: null }),
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: USUARIO,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "manager" }],
    is_platform_admin: false,
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, name: "Org", role: "manager" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/mcp/auth", async (orig) => {
  const real = await orig<typeof McpAuth>();
  return {
    ...real,
    validateBearerToken: async () => {
      await new Promise((r) => setTimeout(r, 2));
      return {
        organizationId: ORG,
        role: "admin",
        scopes: ["mcp:write", "mcp:read"],
        actor: visto.bearer!.actor,
        apiTokenId: visto.bearer!.apiTokenId,
      };
    },
  };
});
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: async () => {
    visto.ctx = currentGreenMutationContext();
  },
}));
vi.mock("@/lib/ai/runtime/finalize", () => ({ finalizeRun: async () => undefined }));

beforeEach(() => {
  visto.ctx = undefined;
  visto.bearer = null;
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma requisição como o framework a roda: raiz async própria (cada requisição
 * nasce do socket dela, não da anterior) e a rota começando por um `await`
 * (`requireSupportWrite()`/`createClient()` — todas as rotas medidas fazem isso
 * ANTES do gate). v3: a rota roda dentro da boundary explícita, como as rotas
 * que alcançam writer de etapa a declaram.
 */
function requisicao<T>(rota: () => Promise<T>): Promise<T> {
  return new Promise<T>((ok, erro) =>
    setImmediate(() => {
      void runGreenRequestBoundary(async () => {
        await tick(0);
        return rota();
      }).then(ok, erro);
    }),
  );
}

describe("boundary de requisição — `run` explícito na rota, gate só preenche", () => {
  /** O gate: abre na entrada, ANTES do primeiro await, e completa depois. */
  async function gate(id: string, ator?: string) {
    const h = abrirContextoGreenDaRequisicao({ source: "http_token", request_id: id });
    await tick(3);
    if (ator) h.vincular({ actor: { kind: "api_token", id: ator } });
  }
  /** A rota: chama o gate no corpo, como as rotas do Deskcomm fazem. */
  async function rota(id: string, atraso: number) {
    await tick(atraso); // ex.: requireSupportWrite / createClient antes do gate
    const antes = currentGreenMutationContext();
    await gate(id, `tok-${id}`);
    await tick(1);
    const depois = currentGreenMutationContext();
    const emPromessaFilha = await tick(1).then(() => currentGreenMutationContext());
    return { antes, depois, emPromessaFilha };
  }
  /** O framework: espera a rota; o contexto dela não pode voltar para cá. */
  async function framework(id: string, atraso: number) {
    const r = await runGreenRequestBoundary(() => rota(id, atraso));
    return { ...r, noFramework: currentGreenMutationContext() };
  }

  it("a rota inteira (e o que ela dispara) enxerga o contexto; o framework e as vizinhas não", async () => {
    const ids = ["req-1", "req-2", "req-3", "req-4", "req-5"];
    const resultados = await Promise.all(ids.map((id, i) => framework(id, 12 - i * 2)));
    resultados.forEach((r, i) => {
      const esperado = {
        v: 1,
        source: "http_token",
        request_id: ids[i],
        actor: { kind: "api_token", id: `tok-${ids[i]}` },
      };
      expect(r.antes).toBeUndefined();
      expect(r.depois).toEqual(esperado);
      expect(r.emPromessaFilha).toEqual(esperado);
      expect(r.noFramework).toBeUndefined();
    });
    expect(currentGreenMutationContext()).toBeUndefined();
  });

  it("não sobrescreve um contexto que já existe (tool MCP, job, regra)", async () => {
    const dentro = await withGreenMutationContext(
      { source: "mcp", actor: { kind: "api_token", id: "tok-mcp" } },
      async () => {
        abrirContextoGreenDaRequisicao({ source: "http_session", request_id: "req-x" });
        await tick(1);
        return currentGreenMutationContext();
      },
    );
    expect(dentro).toEqual({ v: 1, source: "mcp", actor: { kind: "api_token", id: "tok-mcp" } });
  });

  // v2 afirmava aqui que, com o gate antes do primeiro await, o contexto
  // "cobria também o resto da MESMA requisição no framework". Era o vazamento
  // que a AUDIT-08.2 mediu (ADV-06). Contrato v3: o contexto acaba com a rota.
  it("gate ANTES do primeiro await da rota: o contexto vale na rota e NÃO volta para o framework nem para a vizinha", async () => {
    const ids = ["req-a", "req-b", "req-c"];
    const vistos = await Promise.all(
      ids.map(
        (id, i) =>
          new Promise<(GreenMutationContextV1 | undefined)[]>((ok) =>
            setImmediate(() => {
              const p = runGreenRequestBoundary(async () => {
                abrirContextoGreenDaRequisicao({ source: "http_session", request_id: id });
                await tick(5 - i);
                return currentGreenMutationContext();
              });
              // o "framework" desta requisição continua depois da rota
              void p.then(async (naRota) => {
                await tick(1);
                ok([naRota, currentGreenMutationContext()]);
              });
            }),
          ),
      ),
    );
    vistos.forEach(([naRota, noFramework], i) => {
      expect(naRota?.request_id).toBe(ids[i]);
      expect(noFramework).toBeUndefined();
    });
    expect(currentGreenMutationContext()).toBeUndefined();
  });

  it("contexto inválido não abre nada (fail-open no seam; o banco recusa Green)", async () => {
    const r = await runGreenRequestBoundary(async () => {
      abrirContextoGreenDaRequisicao({ source: "Fonte Com Espaço" });
      await tick(1);
      return currentGreenMutationContext();
    });
    expect(r).toBeUndefined();
  });
});

describe("requireRole: a requisição humana ganha metadata operacional (sem ator)", async () => {
  const { requireRole } = await import("@/lib/auth/require-role");
  it("depois do await, a rota roda com source/request/correlation da própria requisição", async () => {
    const requestId = "6f1f7d9e-0000-4000-8000-000000000001";
    const rotaHumana = async () => {
      const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
      expect(authz.ok).toBe(true);
      await tick(1);
      return currentGreenMutationContext();
    };
    expect(await requisicao(rotaHumana)).toEqual({
      v: 1,
      source: "http_session",
      request_id: requestId,
      correlation_id: requestId,
    });
    // o header que sai (sessão humana): o banco usa só como advisory
    const { initComContextoGreen } = await import("./mutation-context");
    const header = await requisicao(async () => {
      await requireRole("agent", { requestId, resource: "crm_leads" });
      const init = initComContextoGreen("http://x/rest/v1/crm_leads", {});
      return new Headers(init?.headers).get(GREEN_MUTATION_CONTEXT_HEADER);
    });
    expect(parseGreenMutationContext(header!)).not.toHaveProperty("actor");
  });
});

describe("resolveAuthDual: Bearer ganha o ator técnico do token; sessão ganha o contexto humano", async () => {
  const { resolveAuthDual } = await import("@/lib/api/auth-dual");
  const req = (headers: Record<string, string>) =>
    ({ headers: new Headers(headers) }) as unknown as NextRequest;
  const opts = (requestId: string) => ({
    requestId,
    resource: "calendar_appointments",
    role: "agent" as const,
    scope: "mcp:write",
    tokenRole: "ai_operator" as const,
  });

  it("agenda por token (GAP 2): source http_token, request da rota e ator api_token", async () => {
    visto.bearer = { actor: { type: "api_token", id: TOKEN }, apiTokenId: TOKEN };
    const requestId = "6f1f7d9e-0000-4000-8000-000000000002";
    const rotaPorToken = async () => {
      const authz = await resolveAuthDual(
        req({ authorization: "Bearer dsk_fake_token_for_unit" }),
        opts(requestId),
      );
      expect(authz.ok && authz.via).toBe("token");
      return currentGreenMutationContext();
    };
    expect(await requisicao(rotaPorToken)).toEqual({
      v: 1,
      source: "http_token",
      request_id: requestId,
      correlation_id: requestId,
      actor: { kind: "api_token", id: TOKEN, api_token_id: TOKEN },
    });
  });

  it("token de agente (ai_agent) leva agent/api_token; sessão vai pelo requireRole (sem ator)", async () => {
    visto.bearer = {
      actor: { type: "ai_agent", id: RUN, role: "ai_operator" } as never,
      apiTokenId: TOKEN,
    };
    const requestId = "6f1f7d9e-0000-4000-8000-000000000003";
    const porToken = await requisicao(async () => {
      await resolveAuthDual(
        req({ authorization: "Bearer dsk_fake_token_for_unit" }),
        opts(requestId),
      );
      return currentGreenMutationContext();
    });
    expect(porToken?.actor).toEqual({ kind: "ai_agent", id: RUN, api_token_id: TOKEN });
    const porSessao = await requisicao(async () => {
      const authz = await resolveAuthDual(req({}), opts(requestId));
      expect(authz.ok && authz.via).toBe("session");
      return currentGreenMutationContext();
    });
    expect(porSessao).toEqual({
      v: 1,
      source: "http_session",
      request_id: requestId,
      correlation_id: requestId,
    });
  });
});

describe("agent-worker: o client do engine transporta o contexto do job", async () => {
  const { crmEdgeConfigFromEnv } = await import("@/lib/agent-engine/edge/crm/mcp-client");
  it("o UPDATE feito com cfg.supabase dentro do job leva o header", async () => {
    const headers: (string | null)[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get(GREEN_MUTATION_CONTEXT_HEADER));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const cfg = crmEdgeConfigFromEnv({
        SUPABASE_URL: "http://127.0.0.1:59999",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-de-teste",
      });
      await withGreenMutationContext(
        {
          source: "agent_engine",
          source_job_id: "job-1",
          actor: { kind: "system", id: "inbound_turn" },
        },
        // o writer real ESPERA o builder dentro do job — é o await que dispara o fetch
        async () => {
          await cfg.supabase.from("crm_leads").update({ stage_id: ORG }).eq("id", ORG);
        },
      );
      await cfg.supabase.from("crm_leads").select("id"); // fora do job: sem header
    } finally {
      globalThis.fetch = original;
    }
    expect(parseGreenMutationContext(headers[0]!)).toEqual({
      v: 1,
      source: "agent_engine",
      source_job_id: "job-1",
      actor: { kind: "system", id: "inbound_turn" },
    });
    expect(headers[1]).toBeNull();
  });
});

describe("runtime legado: finalizeHandoff roda o handoff com contexto", async () => {
  const { finalizeHandoff } = await import("@/lib/ai/runtime/handoff");
  it("sinal da tool ⇒ ai_agent; sentinela ⇒ system; request_id = run", async () => {
    await finalizeHandoff({
      runId: RUN,
      organizationId: ORG,
      conversationId: CONVERSA,
      reason: "requested_human",
      source: "tool",
    });
    expect(visto.ctx).toEqual({
      v: 1,
      source: "agent_runtime",
      request_id: RUN,
      actor: { kind: "ai_agent", id: RUN },
    });
    await finalizeHandoff({
      runId: RUN,
      organizationId: ORG,
      conversationId: CONVERSA,
      reason: "requested_human",
      source: "sentinel",
    });
    expect(visto.ctx?.actor).toEqual({ kind: "system", id: RUN });
  });
});
