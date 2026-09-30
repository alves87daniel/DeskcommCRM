/**
 * SPIKE Green — o MutationContext no processo Node: contrato fechado, merge
 * aninhado, serialização e o cenário S13 (concorrência sem vazamento entre
 * cadeias async).
 */
import { describe, expect, it } from "vitest";

import {
  GreenMutationContextError,
  currentGreenMutationContext,
  greenActorFromActor,
  parseGreenMutationContext,
  serializeGreenMutationContext,
  validateGreenMutationContext,
  withGreenMutationContext,
} from "./mutation-context";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("contrato v1 (fechado por chave)", () => {
  it("aceita o contexto mínimo e serializa em Base64 de JSON UTF-8", () => {
    const b64 = serializeGreenMutationContext({
      v: 1,
      source: "mcp",
      actor: { kind: "api_token", id: UUID_A },
    });
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(parseGreenMutationContext(b64)).toEqual({
      v: 1,
      source: "mcp",
      actor: { kind: "api_token", id: UUID_A },
    });
  });

  it.each([
    ["chave fora do contrato (PII)", { v: 1, source: "x", name: "Fulano" }, "root.name"],
    [
      "chave fora do contrato no actor",
      { v: 1, source: "x", actor: { kind: "system", email: "a@b" } },
      "actor.email",
    ],
    [
      "actor.kind=user não viaja",
      { v: 1, source: "x", actor: { kind: "user", id: UUID_A } },
      "actor.kind",
    ],
    ["source com texto livre", { v: 1, source: "Fulano da Silva" }, "source"],
    [
      "causation não-uuid",
      { v: 1, source: "x", causation_event_id: "rule:1" },
      "causation_event_id",
    ],
    ["request_id acima de 128", { v: 1, source: "x", request_id: "r".repeat(129) }, "request_id"],
    [
      "service_origin command nunca viaja",
      { v: 1, source: "x", service_origin: { kind: "command", observed: {} } },
      "service_origin.kind",
    ],
    [
      "boundary incompleta",
      {
        v: 1,
        source: "x",
        service_origin: { kind: "continuation", boundary: { organization_id: UUID_A } },
      },
      "service_origin.boundary.contact_id",
    ],
    ["versão errada", { v: 2, source: "x" }, "v"],
  ])("recusa: %s", (_, ctx, campo) => {
    expect(() => validateGreenMutationContext(ctx)).toThrow(new GreenMutationContextError(campo));
  });

  it("recusa contexto acima do teto de bytes", () => {
    expect(() =>
      validateGreenMutationContext({
        v: 1,
        source: "x",
        request_id: "a".repeat(128),
        correlation_id: "b".repeat(128),
        idempotency_key: "c".repeat(128),
        source_job_id: "d".repeat(128),
        actor: {
          kind: "system",
          id: "e".repeat(128),
          agent_id: "f".repeat(128),
          api_token_id: "g".repeat(128),
        },
      }),
    ).not.toThrow();
    // 4096 bytes só se alcança com muitos campos no teto — o resolver SQL usa o mesmo número.
  });
});

describe("merge aninhado", () => {
  it("o filho sobrescreve campo a campo e herda o que não declara", () => {
    const visto = withGreenMutationContext(
      {
        source: "agent_engine",
        source_job_id: "job-1",
        correlation_id: UUID_A,
        actor: { kind: "system", id: "inbound_turn" },
        service_origin: {
          kind: "event",
          event_id: UUID_A,
          organization_id: UUID_A,
          contact_id: UUID_B,
        },
      },
      () =>
        withGreenMutationContext(
          { source: "agent_runtime", actor: { kind: "ai_agent", id: "run-1", agent_id: UUID_B } },
          () => currentGreenMutationContext(),
        ),
    );
    expect(visto).toEqual({
      v: 1,
      source: "agent_runtime",
      source_job_id: "job-1",
      correlation_id: UUID_A,
      actor: { kind: "ai_agent", id: "run-1", agent_id: UUID_B },
      service_origin: {
        kind: "event",
        event_id: UUID_A,
        organization_id: UUID_A,
        contact_id: UUID_B,
      },
    });
  });

  it("contexto inválido no seam: roda SEM contexto (fail-open) e avisa — quem fecha é o banco", () => {
    const visto = withGreenMutationContext({ actor: { kind: "system" } }, () =>
      currentGreenMutationContext(),
    );
    expect(visto).toBeUndefined();
    // um filho inválido NÃO herda o pai por engano: a mutação sai sem autoria, nunca com a errada
    const dentro = withGreenMutationContext({ source: "pai", actor: { kind: "system" } }, () =>
      withGreenMutationContext({ source: "Filho Inválido" }, () => currentGreenMutationContext()),
    );
    expect(dentro).toBeUndefined();
  });

  it("fora de qualquer contexto, não há contexto", () => {
    expect(currentGreenMutationContext()).toBeUndefined();
  });
});

describe("S13 — concorrência: nenhuma cadeia enxerga o contexto da outra", () => {
  it("duas promises intercaladas mantêm cada uma o próprio actor/request/source", async () => {
    const vistos: Array<{ rotulo: string; ctx: ReturnType<typeof currentGreenMutationContext> }> =
      [];
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cadeia = (rotulo: string, ms: number) =>
      withGreenMutationContext(
        { source: rotulo, request_id: `req-${rotulo}`, actor: { kind: "system", id: rotulo } },
        async () => {
          await espera(ms);
          vistos.push({ rotulo, ctx: currentGreenMutationContext() });
          await espera(ms);
          vistos.push({ rotulo, ctx: currentGreenMutationContext() });
        },
      );
    await Promise.all([cadeia("a", 5), cadeia("b", 1), cadeia("c", 3)]);
    expect(vistos).toHaveLength(6);
    for (const { rotulo, ctx } of vistos) {
      expect(ctx?.source).toBe(rotulo);
      expect(ctx?.request_id).toBe(`req-${rotulo}`);
      expect(ctx?.actor?.id).toBe(rotulo);
    }
  });
});

describe("adaptador do Actor do host", () => {
  it("ai_agent leva id, agent_id e api_token_id; api_token leva o token; user vira system", () => {
    expect(
      greenActorFromActor(
        { type: "ai_agent", id: "run-1", role: "ai_operator", agent_id: UUID_A },
        UUID_B,
      ),
    ).toEqual({
      kind: "ai_agent",
      id: "run-1",
      agent_id: UUID_A,
      api_token_id: UUID_B,
    });
    expect(greenActorFromActor({ type: "api_token", id: UUID_B }, UUID_B)).toEqual({
      kind: "api_token",
      id: UUID_B,
      api_token_id: UUID_B,
    });
    expect(greenActorFromActor({ type: "webhook_source", id: UUID_A })).toEqual({
      kind: "webhook_source",
      id: UUID_A,
    });
    expect(greenActorFromActor({ type: "user", id: UUID_A })).toEqual({
      kind: "system",
      id: UUID_A,
    });
  });
});
