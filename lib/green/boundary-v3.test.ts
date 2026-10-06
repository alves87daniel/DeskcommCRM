// @vitest-environment node
/**
 * SPIKE Green v3 — contraexemplos de PROCESSO da AUDIT-DESKCOMM-08.2:
 *
 * - ADV-06 (ALS-01/02/03): a boundary de requisição era `enterWith` no gate de
 *   auth — segura só enquanto a rota tivesse um `await` antes do gate, o runtime
 *   fosse o AsyncContextFrame do Node 24 e nada sobrevivesse à requisição;
 * - ADV-05: trabalho de sistema (drain, handler, worker) herdava o contexto da
 *   requisição humana que o disparou (`relogio/tick`);
 * - ADV-04: o motor de automação decidia o anti-loop por `metadata.request_id`,
 *   campo que um humano escolhe.
 *
 * O MESMO arquivo roda contra a v2 e a v3. `rota` é a rota "como a versão a
 * entrega": na v3, embrulhada pela boundary explícita (`runGreenRequestBoundary`);
 * na v2 não existe boundary e a rota roda crua, que é exatamente o que as rotas
 * da v2 fazem. Rodar DUAS vezes: runtime padrão e
 * `NODE_OPTIONS=--no-async-context-frame` (a implementação de ALS do Node 22).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { runAutomationForEvent } from "@/lib/automation/engine";
import { dispatchEvent, registerHandler, type EventRow } from "@/lib/event-log/dispatcher";

import * as mc from "./mutation-context";
import {
  abrirContextoGreenDaRequisicao,
  currentGreenMutationContext,
  withGreenMutationContext,
  type GreenMutationContextV1,
} from "./mutation-context";

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

type Boundary = <T>(fn: () => T) => T;
const rota: Boundary =
  ((mc as Record<string, unknown>).runGreenRequestBoundary as Boundary | undefined) ??
  ((fn) => fn());

const MODO =
  process.execArgv.includes("--no-async-context-frame") ||
  (process.env.NODE_OPTIONS ?? "").includes("--no-async-context-frame")
    ? "async_hooks (Node 22)"
    : `padrão do Node ${process.versions.node.split(".")[0]}`;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Raiz assíncrona própria: cada requisição nasce do socket dela, não do teste. */
const raiz = <T>(fn: () => Promise<T>) =>
  new Promise<T>((ok, erro) => setImmediate(() => void fn().then(ok, erro)));

const atorDoToken = (id: string) => ({
  kind: "api_token" as const,
  id: `tok-${id}`,
  api_token_id: `tok-${id}`,
});

/** O formato de `resolveAuthDual` no ramo Bearer: gate ANTES do primeiro await, ator depois. */
async function rotaPorToken(id: string, validacaoMs: number) {
  const h = abrirContextoGreenDaRequisicao({
    source: "http_token",
    request_id: id,
    correlation_id: id,
  });
  await tick(validacaoMs); // validateBearerToken
  h.vincular({ actor: atorDoToken(id) });
  await tick(15); // o writer roda depois
  return currentGreenMutationContext();
}

describe(`V3 boundary de requisição [ALS: ${MODO}]`, () => {
  it("ALS-01: duas requisições iniciadas no MESMO tick não dividem contexto nem ator", async () => {
    const { a, b } = await raiz(async () => {
      const [a, b] = await Promise.all([
        rota(() => rotaPorToken("A", 5)),
        rota(() => rotaPorToken("B", 1)),
      ]);
      return { a, b };
    });
    expect(a).toMatchObject({ request_id: "A", actor: atorDoToken("A") });
    expect(b).toMatchObject({ request_id: "B", actor: atorDoToken("B") });
  });

  it("ALS-02: fila/poller criado dentro de uma requisição não carrega o contexto dela depois que ela termina", async () => {
    const fila: Array<() => void> = [];
    let poller: NodeJS.Timeout | undefined;
    const enfileirar = (job: () => void) => {
      fila.push(job);
      poller ??= setInterval(() => fila.splice(0).forEach((j) => j()), 2);
    };
    const vistos: Record<string, GreenMutationContextV1 | null> = {};
    // requisição A (token): abre o gate, cria o poller, termina
    await raiz(() =>
      rota(async () => {
        await tick(0);
        const h = abrirContextoGreenDaRequisicao({ source: "http_token", request_id: "A" });
        await tick(1);
        h.vincular({ actor: atorDoToken("A") });
        enfileirar(() => undefined);
        await tick(6);
      }),
    );
    // requisição B: rota pública/webhook, SEM gate, usa a mesma fila
    await raiz(async () => {
      await tick(0);
      vistos.rotaB = currentGreenMutationContext() ?? null;
      enfileirar(() => (vistos.jobDeB = currentGreenMutationContext() ?? null));
      await tick(10);
    });
    clearInterval(poller);
    expect(vistos).toEqual({ rotaB: null, jobDeB: null });
  });

  it("ALS-03: servidor http real com keep-alive e gate SÍNCRONO no handler — cada requisição começa limpa", async () => {
    const vistos: { antes: string | null; depois: string | null }[] = [];
    let n = 0;
    const server = http.createServer((_req, res) => {
      const id = `req-${++n}`;
      void rota(async () => {
        const antes = currentGreenMutationContext()?.request_id ?? null;
        abrirContextoGreenDaRequisicao({ source: "http_session", request_id: id });
        await tick(2);
        vistos.push({ antes, depois: currentGreenMutationContext()?.request_id ?? null });
        res.end(id);
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const porta = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<void>((ok, erro) =>
        http
          .get({ host: "127.0.0.1", port: porta, agent }, (res) => {
            res.resume();
            res.on("end", () => ok());
          })
          .on("error", erro),
      );
    for (let i = 0; i < 4; i++) await get();
    agent.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
    expect(vistos).toEqual([1, 2, 3, 4].map((i) => ({ antes: null, depois: `req-${i}` })));
  });

  it("sem boundary não há contexto: o gate chamado fora de uma requisição delimitada não deixa nada para trás", async () => {
    const depois = await raiz(async () => {
      abrirContextoGreenDaRequisicao({ source: "http_session", request_id: "solto" });
      await tick(1);
      return currentGreenMutationContext() ?? null;
    });
    expect(depois).toBeNull();
  });

  it("o contexto termina com a requisição: callback tardio e continuação depois de throw não o enxergam", async () => {
    const vistos: Record<string, string | null> = {};
    await raiz(async () => {
      await rota(async () => {
        abrirContextoGreenDaRequisicao({ source: "http_session", request_id: "ok" });
        await tick(1);
        vistos.durante = currentGreenMutationContext()?.request_id ?? null;
        // callback agendado DENTRO da requisição, disparado depois dela
        setTimeout(() => (vistos.tardio = currentGreenMutationContext()?.request_id ?? null), 8);
      });
      await rota(async () => {
        abrirContextoGreenDaRequisicao({ source: "http_session", request_id: "explode" });
        await tick(1);
        setTimeout(() => (vistos.aposThrow = currentGreenMutationContext()?.request_id ?? null), 4);
        throw new Error("rota falhou");
      }).catch(() => undefined);
      vistos.depois = currentGreenMutationContext()?.request_id ?? null;
      await tick(15);
    });
    expect(vistos).toEqual({ durante: "ok", tardio: null, aposThrow: null, depois: null });
  });

  it("contexto aninhado funciona dentro da boundary e devolve o da requisição ao sair", async () => {
    const vistos = await raiz(() =>
      rota(async () => {
        abrirContextoGreenDaRequisicao({ source: "http_token", request_id: "req", correlation_id: "req" });
        await tick(1);
        const dentro = await withGreenMutationContext(
          { source: "mcp", actor: { kind: "system", id: "tool" } },
          async () => {
            await tick(1);
            return currentGreenMutationContext();
          },
        );
        return { dentro, fora: currentGreenMutationContext() };
      }),
    );
    expect(vistos.dentro).toMatchObject({ source: "mcp", correlation_id: "req", actor: { id: "tool" } });
    expect(vistos.fora).toMatchObject({ source: "http_token", request_id: "req" });
    expect(vistos.fora?.actor).toBeUndefined();
  });
});

describe(`V3 raiz de sistema — ADV-05 [ALS: ${MODO}]`, () => {
  const evento = (over: Partial<EventRow> = {}): EventRow => ({
    id: "00000000-0000-4000-8000-0000000000e1",
    organization_id: "00000000-0000-4000-8000-00000000000a",
    event_type: "spike.v3_probe",
    entity_kind: "crm_lead",
    entity_id: "00000000-0000-4000-8000-0000000000f1",
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  });

  it("handler disparado de dentro de uma requisição humana (tick do relógio) NÃO herda request/correlation dela", async () => {
    let visto: GreenMutationContextV1 | undefined;
    registerHandler({
      key: "spike-v3-probe",
      events: ["spike.v3_probe"],
      handle: async () => {
        await tick(1);
        visto = currentGreenMutationContext();
        return { consumer_key: "spike-v3-probe", status: "ok" };
      },
    });
    await raiz(() =>
      rota(async () => {
        await tick(0);
        // o gate da sessão admin que chamou `relogio/tick`
        abrirContextoGreenDaRequisicao({
          source: "http_session",
          request_id: "req-do-admin",
          correlation_id: "req-do-admin",
        });
        await tick(1);
        await dispatchEvent(evento());
      }),
    );
    expect(visto).toMatchObject({
      source: "event_handler",
      causation_event_id: "00000000-0000-4000-8000-0000000000e1",
      actor: { kind: "system", id: "spike-v3-probe" },
    });
    expect(visto?.request_id).toBeUndefined();
    expect(visto?.correlation_id).not.toBe("req-do-admin");
  });

  it("a correlação que o handler herda é a do EVENTO (quando confiável), não a de quem o drenou", async () => {
    let visto: GreenMutationContextV1 | undefined;
    registerHandler({
      key: "spike-v3-probe",
      events: ["spike.v3_probe"],
      handle: async () => {
        visto = currentGreenMutationContext();
        return { consumer_key: "spike-v3-probe", status: "ok" };
      },
    });
    await raiz(() =>
      withGreenMutationContext(
        { source: "mcp", request_id: "req-externo", correlation_id: "corr-externa", actor: { kind: "system", id: "x" } },
        () => dispatchEvent(evento()),
      ),
    );
    expect(visto?.request_id).toBeUndefined();
    expect(visto?.correlation_id).toBe("00000000-0000-4000-8000-0000000000e1");
  });
});

describe("V3-R05 — anti-loop do motor decide por proveniência confiável (ADV-04)", () => {
  const semRegras = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: async () => ({ data: [], error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  const canonico = (metadata: Record<string, unknown>): EventRow => ({
    id: "00000000-0000-4000-8000-0000000000e2",
    organization_id: "00000000-0000-4000-8000-00000000000a",
    event_type: "lead.stage_changed",
    entity_kind: "crm_lead",
    entity_id: "00000000-0000-4000-8000-0000000000f1",
    payload: {},
    metadata: { green_canonical: true, green_context_version: 1, ...metadata },
    consumed_by: [],
    attempts: 0,
  });
  const USUARIO = "00000000-0000-4000-8000-0000000000b1";
  const humanoConfiavel = { caller: "user", actor: { kind: "user", id: USUARIO }, source: "user_session" };

  it("canônico de humano com `request_id=rule:*` (como a v2 gravava) NÃO é pulado", async () => {
    const r = await runAutomationForEvent(
      semRegras,
      canonico({
        caller: "user",
        actor: { kind: "user", id: USUARIO },
        source: "automation",
        request_id: "rule:qualquer",
      }),
    );
    expect(r).not.toMatchObject({ status: "skipped", detail: "caused_by_rule" });
  });

  it("canônico v3 de humano com `rule:*` só no advisory NÃO é pulado", async () => {
    const r = await runAutomationForEvent(
      semRegras,
      canonico({
        ...humanoConfiavel,
        green: {
          v: 2,
          trusted: humanoConfiavel,
          advisory: { source: "automation", request_id: "rule:qualquer", caused_by_rule: true },
        },
      }),
    );
    expect(r).not.toMatchObject({ status: "skipped", detail: "caused_by_rule" });
  });

  it("canônico de humano com `caused_by_rule` no topo (forja por UPDATE antigo/legado) NÃO é pulado", async () => {
    const r = await runAutomationForEvent(
      semRegras,
      canonico({ ...humanoConfiavel, caused_by_rule: true, green: { v: 2, trusted: humanoConfiavel, advisory: {} } }),
    );
    expect(r).not.toMatchObject({ status: "skipped", detail: "caused_by_rule" });
  });

  it("controle: o canônico que a PRÓPRIA automação causou continua pulado (o anti-loop segue funcionando)", async () => {
    const trusted = {
      caller: "service_role",
      actor: { kind: "webhook_source", id: "regra" },
      source: "automation",
      request_id: "rule:regra",
    };
    const r = await runAutomationForEvent(
      semRegras,
      canonico({ ...trusted, green: { v: 2, trusted, advisory: {} } }),
    );
    expect(r).toMatchObject({ status: "skipped", detail: "caused_by_rule" });
  });

  it("controle: evento NÃO canônico segue a régua do upstream (request_id `rule:` ou caused_by_rule)", async () => {
    const legado = (metadata: Record<string, unknown>): EventRow => ({ ...canonico({}), metadata });
    expect(await runAutomationForEvent(semRegras, legado({ request_id: "rule:x" }))).toMatchObject({
      status: "skipped",
      detail: "caused_by_rule",
    });
    expect(await runAutomationForEvent(semRegras, legado({ request_id: "req-1" }))).toMatchObject({
      status: "ok",
      detail: "no_rules",
    });
  });
});
