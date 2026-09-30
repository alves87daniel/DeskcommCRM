/**
 * SPIKE Green — os seams centrais amarram o contexto ANTES de qualquer writer
 * rodar: dispatcher (causation do evento), motor de regras (anti-loop
 * `rule:<id>` + causation + origem por evento), MCP externo (ator técnico do
 * token), tools in-process do agente (ator do agente) e fronteira de
 * atendimento (continuação). Nenhum writer de `stage_id` é tocado: quem observa
 * o contexto aqui é um handler/ação de mentira no lugar dele.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { currentGreenMutationContext, type GreenMutationContextV1 } from "./mutation-context";

const ORG = "00000000-0000-4000-8000-00000000000a";
const EVENTO = "00000000-0000-4000-8000-00000000000e";
const REGRA = "00000000-0000-4000-8000-00000000000f";
const CONTATO = "00000000-0000-4000-8000-00000000000c";
const CONVERSA = "00000000-0000-4000-8000-00000000000d";

const visto = vi.hoisted(() => ({ ctx: undefined as GreenMutationContextV1 | undefined }));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: async () => undefined }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/tools", () => {
  const tool = {
    name: "observa_contexto",
    description: "devolve o contexto Green corrente",
    inputSchema: { lead_id: z.string().optional() },
    // `read` de propósito: o gate de escopo de funil (só escrita) não é o que
    // se mede aqui — o wrapper do contexto é o mesmo para as duas categorias.
    category: "read",
    requiresRole: "viewer",
    requiresScope: "mcp:read",
    handler: async () => {
      visto.ctx = currentGreenMutationContext();
      return { ok: true };
    },
  };
  return { allTools: [tool], getToolByName: (n: string) => (n === tool.name ? tool : undefined) };
});
vi.mock("@/lib/mcp/tools/catalog", () => ({
  catalogEntry: () => undefined,
  deCapacidadeDesligada: () => false,
  deModuloDesligado: () => false,
}));

beforeEach(() => {
  visto.ctx = undefined;
});

describe("dispatcher: o handler roda com a causalidade do evento", async () => {
  const { dispatchEvent, registerHandler } = await import("@/lib/event-log/dispatcher");
  it("causation = id do evento; correlation herda do metadata ou cai no id", async () => {
    registerHandler({
      key: "observador",
      events: ["lead.stage_changed"],
      async handle() {
        visto.ctx = currentGreenMutationContext();
        return { consumer_key: "observador", status: "ok" };
      },
    });
    const base = {
      organization_id: ORG,
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: null,
      payload: {},
      consumed_by: [],
      attempts: 0,
    };
    await dispatchEvent({ ...base, id: EVENTO, metadata: {} });
    expect(visto.ctx).toEqual({
      v: 1,
      source: "event_handler",
      actor: { kind: "system", id: "observador" },
      causation_event_id: EVENTO,
      correlation_id: EVENTO,
    });
    await dispatchEvent({ ...base, id: EVENTO, metadata: { correlation_id: CONVERSA } });
    expect(visto.ctx?.correlation_id).toBe(CONVERSA);
  });
});

describe("motor de regras: a ação roda com request_id=rule:<id>, causation e origem por evento", async () => {
  const { registerAction } = await import("@/lib/automation/actions");
  const { runAutomationForEvent } = await import("@/lib/automation/engine");

  /** Admin de mentira: uma regra ativa com a ação observadora; o resto é no-op. */
  function admin() {
    const tabela = (nome: string) => {
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: () => cadeia,
        order: () => cadeia,
        insert: () => cadeia,
        update: () => cadeia,
        maybeSingle: async () =>
          nome === "crm_leads"
            ? { data: { id: "lead", contact_id: CONTATO, pipeline_id: "p" }, error: null }
            : { data: null, error: null },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            nome === "automation_rules"
              ? {
                  data: [
                    { id: REGRA, name: "R", conditions: [], actions: [{ type: "observa_ctx" }] },
                  ],
                  error: null,
                }
              : { data: [], error: null },
          ).then(resolve),
      };
      return cadeia;
    };
    return { from: tabela } as never;
  }

  it("S4 (lado Node) — a marca anti-loop e a causation chegam ANTES do writer", async () => {
    registerAction({
      type: "observa_ctx",
      async execute() {
        visto.ctx = currentGreenMutationContext();
        return { type: "observa_ctx", status: "success" };
      },
    });
    const r = await runAutomationForEvent(admin(), {
      id: EVENTO,
      organization_id: ORG,
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: "lead",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    });
    expect(r.status).toBe("ok");
    expect(visto.ctx).toEqual({
      v: 1,
      source: "automation",
      request_id: `rule:${REGRA}`,
      causation_event_id: EVENTO,
      actor: { kind: "webhook_source", id: REGRA },
      service_origin: {
        kind: "event",
        event_id: EVENTO,
        organization_id: ORG,
        contact_id: CONTATO,
      },
    });
  });

  it("S4 — o evento canônico que a regra causou não reexecuta a regra (anti-loop upstream)", async () => {
    const nuncaChamado = {
      from: () => {
        throw new Error("o motor não pode consultar nada num evento causado por regra");
      },
    } as never;
    const r = await runAutomationForEvent(nuncaChamado, {
      id: CONVERSA,
      organization_id: ORG,
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: "lead",
      payload: {},
      // exatamente o que `green.fn_emit_crm_lead_stage_changed` grava
      metadata: { green_canonical: true, request_id: `rule:${REGRA}`, causation_event_id: EVENTO },
      consumed_by: [],
      attempts: 0,
    });
    expect(r).toMatchObject({ status: "skipped", detail: "caused_by_rule" });
  });
});

describe("MCP externo: a tool roda com o ator técnico do token", async () => {
  const { createMcpServer } = await import("@/lib/mcp/server");
  it("S3 (lado Node) — api_token/ai_agent, request_id e idempotency_key", async () => {
    const server = createMcpServer(
      {
        organizationId: ORG,
        role: "admin",
        actor: { type: "ai_agent", id: "run-1", role: "admin", agent_id: CONTATO },
        apiTokenId: CONVERSA,
        scopes: ["mcp:read"],
      },
      "req-mcp",
      [],
      [],
      "idem-1",
    );
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    await client.callTool({ name: "observa_contexto", arguments: {} });
    await client.close();
    expect(visto.ctx).toEqual({
      v: 1,
      source: "mcp",
      request_id: "req-mcp",
      idempotency_key: "idem-1",
      actor: { kind: "ai_agent", id: "run-1", agent_id: CONTATO, api_token_id: CONVERSA },
    });
  });
});

describe("tools in-process do agente: a tool roda com o ator do agente", async () => {
  const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
  it("S5 (lado Node) — source agent_runtime, job e ator ai_agent", async () => {
    const auth = {
      organizationId: ORG,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "run-2", role: "ai_operator", agent_id: CONTATO },
      apiTokenId: CONVERSA,
      scopes: ["mcp:read", "mcp:write"],
    } as never;
    const tools = pickToolsFromMcp({
      supabase: {} as never,
      ctx: {
        organizationId: ORG,
        role: "ai_operator",
        actor: (auth as { actor: never }).actor,
        apiTokenId: CONVERSA,
        requestId: "req-run",
        sourceJobId: "job-9",
        supabase: {} as never,
      },
      auth,
      toolIds: ["observa_contexto"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });
    const { execute } = tools.observa_contexto as unknown as {
      execute: (a: unknown, o?: unknown) => Promise<unknown>;
    };
    const resposta = await execute({}, { toolCallId: "1", messages: [] });
    expect(resposta, "a tool de mentira tem de ter chegado ao handler").toEqual({ ok: true });
    expect(visto.ctx).toEqual({
      v: 1,
      source: "agent_runtime",
      request_id: "req-run",
      source_job_id: "job-9",
      actor: { kind: "ai_agent", id: "run-2", agent_id: CONTATO, api_token_id: CONVERSA },
    });
  });
});

describe("fronteira de atendimento: job e continuação viram service_origin", async () => {
  const { withServiceBoundary, withServiceJob } =
    await import("@/lib/atendimento/fronteira-server");
  const boundary = {
    organization_id: ORG,
    contact_id: CONTATO,
    conversation_id: CONVERSA,
    service_revision: 3,
    demanda_id: null,
    demanda_revision: null,
  };
  /** `db` de mentira: devolve a fronteira vigente igual à esperada. */
  const db = {
    query: async () => ({ rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] }),
  } as never;

  it("S5/S6 (lado Node) — withServiceJob leva job + continuação; a tool aninhada herda a origem", async () => {
    const job = {
      id: "job-7",
      kind: "inbound_turn",
      organization_id: ORG,
      contact_id: CONTATO,
      payload: { service_boundary: boundary },
    } as never;
    const dentro = await withServiceJob(db, job, async () => currentGreenMutationContext());
    expect(dentro).toEqual({
      v: 1,
      source: "agent_engine",
      source_job_id: "job-7",
      actor: { kind: "system", id: "inbound_turn" },
      service_origin: { kind: "continuation", boundary },
    });
    // Continuação sem job (decisão humana sobre caso existente): mesma origem.
    const continuacao = await withServiceBoundary(db, boundary, async () =>
      currentGreenMutationContext(),
    );
    expect(continuacao).toEqual({
      v: 1,
      source: "service_boundary",
      actor: { kind: "system", id: "service_boundary" },
      service_origin: { kind: "continuation", boundary },
    });
    // Fronteira nula é stale para o upstream (`assertCurrentServiceBoundary`), e
    // continua sendo: o contexto Green não afrouxa nada.
    await expect(withServiceBoundary(db, null, async () => 1)).rejects.toThrow(
      "service_boundary_stale",
    );
  });
});
