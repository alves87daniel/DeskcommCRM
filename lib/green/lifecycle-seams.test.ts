/**
 * SPIKE-GREEN-01 (descartável) — seams de processo do lifecycle.
 *
 * O banco já prova, em `tests/invariants/green-lead-lifecycle.test.ts`, que o
 * nascimento Green COM contexto passa e grava a proveniência, e SEM contexto é
 * recusado. Aqui ficam os dois caminhos que o harness de banco não alcança sem
 * fixture desproporcional, medidos no ponto exato da escrita:
 *
 *   - pos-entrada (toda ingestão de canal, e o replay): a recusa do nascimento não pode
 *     virar `info` sem o motivo — é a falha silenciosa do EV-01B;
 *   - prospecção (`activateCampaign`): o `createLeadHandler` tem de rodar sob
 *     contexto Green confiável (é ele que vira o header da request).
 *
 * Mesmo arquivo para a v3 e para o lifecycle: só muda o código sob teste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { capabilitiesOf, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { currentGreenMutationContext } from "@/lib/green/mutation-context";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));
const nascimento = vi.hoisted(() => ({
  resultado: {
    criado: false,
    motivo: "erro",
    detalhe: "green_mutation_context_required",
  } as unknown,
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: vi.fn(async () => nascimento.resultado),
}));

/* prospecção: o que o activateCampaign alcança fora do pg */
const capturado = vi.hoisted(() => ({ contextoNoLead: undefined as unknown, leads: 0 }));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async () => {
    capturado.contextoNoLead = currentGreenMutationContext();
    capturado.leads += 1;
    return { id: "00000000-0000-4000-8000-0000000000a1" };
  }),
}));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: vi.fn(async () => ({
    contact: { id: "00000000-0000-4000-8000-0000000000c1" },
  })),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: vi.fn(async () => ({
    conversation_id: "00000000-0000-4000-8000-0000000000b1",
  })),
}));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({
  loadActiveRouter: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: vi.fn(async () => ({
    agentId: "00000000-0000-4000-8000-00000000a6e0",
  })),
}));

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { activateCampaign } from "@/lib/prospecting/store";

/** Client que responde vazio a tudo: o passo sob teste é o nascimento. */
function adminVazio(): never {
  const resposta = { data: null, error: null, count: 0 };
  const cadeia: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then")
        return (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok);
      return () => cadeia;
    },
    apply() {
      return cadeia;
    },
  });
  return cadeia as never;
}

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  capturado.contextoNoLead = undefined;
  capturado.leads = 0;
});

describe("pos-entrada: nascimento Green recusado não é falha silenciosa", () => {
  it("a recusa do banco vira `error` com o motivo, e a ingestão segue (não lança)", async () => {
    await expect(
      aplicarEfeitosPosEntrada(adminVazio(), {
        organizationId: "00000000-0000-4000-8000-000000000001",
        contactId: "00000000-0000-4000-8000-000000000002",
        conversationId: "00000000-0000-4000-8000-000000000003",
        messageId: null,
        channelSessionId: "00000000-0000-4000-8000-000000000004",
        texto: "oi",
        nomeDoContato: "Maria",
        origem: "teste",
      } as never),
    ).resolves.toBeUndefined();
    const erros = logger.error.mock.calls.filter(([msg]) => String(msg).includes("lead"));
    expect(erros).toHaveLength(1);
    expect(erros[0]![1]).toMatchObject({
      motivo: "erro",
      detalhe: "green_mutation_context_required",
    });
  });

  it("controle: `ja_existe` continua informativo (não é falha)", async () => {
    nascimento.resultado = { criado: false, motivo: "ja_existe" };
    await aplicarEfeitosPosEntrada(adminVazio(), {
      organizationId: "00000000-0000-4000-8000-000000000001",
      contactId: "00000000-0000-4000-8000-000000000002",
      conversationId: "00000000-0000-4000-8000-000000000003",
      messageId: null,
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      texto: "oi",
      nomeDoContato: "Maria",
      origem: "teste",
    } as never);
    expect(logger.error.mock.calls.filter(([msg]) => String(msg).includes("lead"))).toHaveLength(0);
    nascimento.resultado = {
      criado: false,
      motivo: "erro",
      detalhe: "green_mutation_context_required",
    };
  });
});

describe("prospecção: o lead da campanha nasce sob contexto Green confiável", () => {
  const ORG = "00000000-0000-4000-8000-0000000000f1";
  const CAMPANHA = "00000000-0000-4000-8000-0000000000f2";
  /** `activateCampaign` só aceita canal que inicia conversa de texto livre: pede-se a capacidade. */
  const PROVIDER = PROVIDERS_DE_MENSAGEM.find((p) => capabilitiesOf(p).freeformOutsideWindow)!;
  const config = {
    agent_id: "00000000-0000-4000-8000-00000000a6e0",
    channel_session_id: "00000000-0000-4000-8000-0000000000f3",
    pipeline_id: "00000000-0000-4000-8000-0000000000f4",
    stage_id: "00000000-0000-4000-8000-0000000000f5",
    qualified_stage_id: "00000000-0000-4000-8000-0000000000f6",
    instruction: "Apresente a oferta com calma.",
    qualification: "Tem interesse e orçamento.",
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "LIA-2026-01",
  };

  /** pg falso: responde por forma de SQL, na ordem em que `activateCampaign` pergunta. */
  function poolFalso() {
    const cliente = {
      async query(sql: string) {
        const s = sql.replace(/\s+/g, " ");
        if (s.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
        if (s.includes("from ai_agents a join ai_agent_versions"))
          return {
            rows: [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [config.pipeline_id] }],
          };
        if (s.includes("from channel_sessions"))
          return { rows: [{ provider: PROVIDER, status: "WORKING" }] };
        if (s.includes("from crm_stages"))
          return { rows: [{ id: config.stage_id }, { id: config.qualified_stage_id }] };
        if (s.startsWith("select * from prospecting_campaigns"))
          return {
            rows: [
              {
                id: CAMPANHA,
                name: "Campanha",
                status: "draft",
                search_status: "succeeded",
                config: null,
              },
            ],
          };
        if (s.includes("from prospecting_candidates") && s.includes("status='new'"))
          return {
            rows: [
              {
                id: "00000000-0000-4000-8000-0000000000e1",
                phone: "+5511987654321",
                contact_id: null,
                lead_id: null,
                data: { name: "Padaria Sol", key: "place-1", maps_url: "https://maps.example/1" },
              },
            ],
          };
        return { rows: [] };
      },
      release() {},
    };
    return { connect: async () => cliente } as never;
  }

  it("`createLeadHandler` roda com contexto Green (actor + source), sem `rule:*` no request confiável", async () => {
    await activateCampaign(poolFalso(), adminVazio(), ORG, CAMPANHA, config);
    expect(capturado.leads).toBe(1);
    expect(capturado.contextoNoLead).toMatchObject({
      v: 1,
      source: "prospecting",
      actor: { kind: "webhook_source", id: CAMPANHA },
    });
    const ctx = capturado.contextoNoLead as { request_id?: string };
    expect(ctx.request_id ?? "").not.toMatch(/^rule:/);
  });
});
