/**
 * SPIKE-GREEN-AUTO-01 — a origem `automation` no processo Node: contrato fechado
 * por chave e a declaração do motor para TODO gatilho (inclusive os de relógio e
 * o lead sem contato, que antes saíam sem origem ou com uma origem que o banco
 * não sabia provar). A prova contra o banco está em
 * `tests/invariants/green-automation-origin.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  GreenMutationContextError,
  currentGreenMutationContext,
  greenAutomationOrigin,
  parseGreenMutationContext,
  serializeGreenMutationContext,
  validateGreenMutationContext,
  type GreenMutationContextV1,
} from "./mutation-context";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const REGRA = "00000000-0000-4000-8000-0000000000a2";
const EVENTO = "00000000-0000-4000-8000-0000000000a3";

describe("contrato: service_origin.kind=automation", () => {
  it("aceita regra + evento + organização e faz o round-trip do transporte", () => {
    const ctx: GreenMutationContextV1 = {
      v: 1,
      source: "automation",
      request_id: `rule:${REGRA}`,
      causation_event_id: EVENTO,
      actor: { kind: "webhook_source", id: REGRA },
      service_origin: greenAutomationOrigin(REGRA, EVENTO, ORG),
    };
    expect(parseGreenMutationContext(serializeGreenMutationContext(ctx))).toEqual(ctx);
    expect(ctx.service_origin).toEqual({
      kind: "automation",
      rule_id: REGRA,
      event_id: EVENTO,
      organization_id: ORG,
    });
  });

  it.each([
    [
      "chave extra (o contato não viaja: o banco deriva o sujeito do evento)",
      {
        kind: "automation",
        rule_id: REGRA,
        event_id: EVENTO,
        organization_id: ORG,
        contact_id: ORG,
      },
      "service_origin.contact_id",
    ],
    [
      "regra que não é uuid",
      { kind: "automation", rule_id: "rule:1", event_id: EVENTO, organization_id: ORG },
      "service_origin.rule_id",
    ],
    [
      "sem evento",
      { kind: "automation", rule_id: REGRA, organization_id: ORG },
      "service_origin.event_id",
    ],
    [
      "sem organização",
      { kind: "automation", rule_id: REGRA, event_id: EVENTO },
      "service_origin.organization_id",
    ],
    [
      "kind de relógio declarado (não existe: a família é derivada pelo banco)",
      { kind: "scheduler", rule_id: REGRA, organization_id: ORG },
      "service_origin.kind",
    ],
  ])("recusa: %s", (_, origem, campo) => {
    expect(() =>
      validateGreenMutationContext({ v: 1, source: "automation", service_origin: origem }),
    ).toThrow(new GreenMutationContextError(campo));
  });
});

describe("motor: toda execução de regra declara a origem `automation`", async () => {
  const { registerAction } = await import("@/lib/automation/actions");
  const { runAutomationForEvent } = await import("@/lib/automation/engine");
  const visto = { ctx: undefined as GreenMutationContextV1 | undefined };
  registerAction({
    type: "observa_origem",
    async execute() {
      visto.ctx = currentGreenMutationContext();
      return { type: "observa_origem", status: "success" };
    },
  });

  /** Admin de mentira: uma regra ativa com a ação observadora; o lead/contato que o caso pedir. */
  function admin(entidades: Record<string, unknown>) {
    const tabela = (nome: string) => {
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: () => cadeia,
        order: () => cadeia,
        insert: () => cadeia,
        update: () => cadeia,
        maybeSingle: async () => ({ data: entidades[nome] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            nome === "automation_rules"
              ? {
                  data: [
                    {
                      id: REGRA,
                      name: "R",
                      conditions: [],
                      actions: [{ type: "observa_origem" }],
                    },
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
  const evento = (tipo: string, entidade: string, payload: Record<string, unknown> = {}) => ({
    id: EVENTO,
    organization_id: ORG,
    event_type: tipo,
    entity_kind: entidade,
    entity_id: "x",
    payload,
    metadata: { actor_kind: "system", source: "cron/lead-time-triggers" },
    consumed_by: [],
    attempts: 0,
  });

  it.each([
    [
      "gatilho de relógio dirigido (lead.stage_stale)",
      evento("lead.stage_stale", "crm_lead", { rule_id: REGRA }),
      { crm_leads: { id: "x", contact_id: null, pipeline_id: "p" } },
    ],
    [
      "lead SEM contato (antes saía sem origem nenhuma)",
      evento("lead.tag_added", "crm_lead"),
      { crm_leads: { id: "x", contact_id: null, pipeline_id: "p" } },
    ],
    ["aniversário (contato)", evento("contact.birthday", "contact"), { contacts: { id: "c" } }],
    [
      "compromisso",
      evento("appointment.created", "calendar_appointment"),
      { calendar_appointments: { id: "x", contact_id: "c" } },
    ],
  ])("%s", async (_, linha, entidades) => {
    visto.ctx = undefined;
    const r = await runAutomationForEvent(admin(entidades), linha);
    expect(r.status).toBe("ok");
    expect(visto.ctx).toMatchObject({
      source: "automation",
      request_id: `rule:${REGRA}`,
      causation_event_id: EVENTO,
      actor: { kind: "webhook_source", id: REGRA },
      service_origin: {
        kind: "automation",
        rule_id: REGRA,
        event_id: EVENTO,
        organization_id: ORG,
      },
    });
  });
});
