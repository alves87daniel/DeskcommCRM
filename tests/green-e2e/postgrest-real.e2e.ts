/**
 * SPIKE Green v2 (descartável) — E2E PostgREST REAL (fecha o EV-03).
 *
 *   AsyncLocalStorage → fetchDoServidor / client Supabase → HTTP real →
 *   Kong/PostgREST local → request.headers → trigger de crm_leads → event_log
 *
 * Nada de `set_config('request.headers', …)` aqui: toda escrita sob teste sai
 * por HTTP, do código real (rotas Next, seams, handlers, motor de regras), até
 * um Supabase LOCAL. O `pg` direto só monta fixtures e lê o resultado.
 *
 * ─── Como rodar (só ambiente local; nenhuma credencial no Git) ──────────────
 *
 *   1. stack local isolado (portas 553xx) com `supabase start` e o
 *      `supabase/baseline.sql` aplicado;
 *   2. exportar, a partir de `supabase status -o json` (nunca colar à mão):
 *        GREEN_E2E_SUPABASE_URL      ← API_URL
 *        GREEN_E2E_ANON_KEY          ← ANON_KEY
 *        GREEN_E2E_SERVICE_ROLE_KEY  ← SERVICE_ROLE_KEY
 *        GREEN_E2E_DB_URL            ← DB_URL
 *   3. `pnpm exec vitest run -c vitest.green-e2e.config.ts`
 *
 * Sem as variáveis, a suíte se declara pulada (nunca "verde por omissão").
 *
 * Cenários: S18 agenda por Bearer (rota real), S19 metadata da requisição
 * humana (rota real do Kanban), S20 service-role por HTTP, S21 humano direto no
 * PostgREST (header forjado), S22 automação (dispatcher + motor de regras reais).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const STACK = {
  url: process.env.GREEN_E2E_SUPABASE_URL ?? "",
  anon: process.env.GREEN_E2E_ANON_KEY ?? "",
  service: process.env.GREEN_E2E_SERVICE_ROLE_KEY ?? "",
  db: process.env.GREEN_E2E_DB_URL ?? "",
};
const TEM_STACK = Boolean(STACK.url && STACK.anon && STACK.service && STACK.db);

/* ── cookies da sessão: o único pedaço do Next que não existe fora dele ────── */
const jarro = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jarro.cookies].map(([name, value]) => ({ name, value })),
    get: (name: string) =>
      jarro.cookies.has(name) ? { name, value: jarro.cookies.get(name)! } : undefined,
    set: () => {},
  }),
  headers: async () => new Headers(),
}));

/* ── fixtures ─────────────────────────────────────────────────────────────── */
const ORG = randomUUID();
const CONTATO_HUMANO = randomUUID();
const CONTATO_AGENDA = randomUUID();
const CONTATO_SERVICO = randomUUID();
const CONTATO_AUTOMACAO = randomUUID();
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const ETAPA = {
  A: randomUUID(),
  B: randomUUID(),
  C: randomUUID(),
  SOLICITADO: randomUUID(),
  AGENDADO: randomUUID(),
  COMUM_A: randomUUID(),
  COMUM_B: randomUUID(),
};
const TOKEN_ID = randomUUID();
const TOKEN_PLAIN = `dsk_e2e_${randomBytes(18).toString("hex")}`;
const TIPO = randomUUID();
const COMPROMISSO = randomUUID();
const REGRA = randomUUID();
const EMAIL = `green-e2e-${ORG.slice(0, 8)}@spike.test`;
const SENHA = `e2e-${randomBytes(12).toString("hex")}`;
let USUARIO = "";
let JWT_USUARIO = "";

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://x@127.0.0.1:1/x", max: 3 });

/** Lead criado como fixture por conexão direta (caller=direct ⇒ GUC de contexto). */
async function novoLead(funil: string, etapa: string, contato: string | null): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "e2e_fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await client.query<{ id: string }>(
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio E2E',$4) returning id",
      [ORG, funil, etapa, contato],
    );
    await client.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function etapaDe(lead: string): Promise<string> {
  return (await pool.query("select stage_id from crm_leads where id=$1", [lead])).rows[0].stage_id;
}

interface Evento {
  id: string;
  organization_id: string;
  event_type: string;
  entity_kind: string;
  entity_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  consumed_by: string[];
  attempts: number;
}
async function eventosDe(lead: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts from event_log where event_type='lead.stage_changed' and entity_kind='crm_lead' and entity_id=$1 order by created_at, id",
    [lead],
  );
  return rows;
}
async function livroDe(lead: string) {
  return (
    await pool.query(
      "select request_id, legacy_request_id, legacy_suppressed_at, canonical_event_id from green.stage_event_ledger where lead_id=$1 order by created_at",
      [lead],
    )
  ).rows;
}

/** Registra cada request HTTP que sai do processo (sem alterar nada nela). */
function espiaoDeFetch() {
  const vistos: { url: string; header: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    vistos.push({ url, header: new Headers(init?.headers).get("x-green-mutation-context") });
    return original(input, init);
  }) as typeof fetch;
  return { vistos, restaurar: () => (globalThis.fetch = original) };
}

/** Cookies `sb-deskcomm-auth*` da sessão real, gerados pelo próprio @supabase/ssr. */
async function cookiesDaSessao(session: { access_token: string; refresh_token: string }) {
  const gerados = new Map<string, string>();
  const ssr = createServerClient(STACK.url, STACK.anon, {
    cookies: {
      getAll: () => [...gerados].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => gerados.set(name, value)),
    },
    cookieOptions: { name: "sb-deskcomm-auth", sameSite: "strict", path: "/" },
  });
  const { error } = await ssr.auth.setSession(session);
  if (error) throw error;
  return gerados;
}

beforeAll(async () => {
  if (!TEM_STACK) return;
  // usuário REAL no GoTrue local (é dele o JWT que o PostgREST vai validar)
  const r = await fetch(`${STACK.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: STACK.service,
      authorization: `Bearer ${STACK.service}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: EMAIL, password: SENHA, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`GoTrue admin: ${r.status}`);
  USUARIO = ((await r.json()) as { id: string }).id;

  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Green E2E','Green E2E')",
    [ORG, `green-e2e-${ORG.slice(0, 8)}`],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'manager',now())",
    [USUARIO, ORG],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name) values ($1,$5,'E2E Humano'),($2,$5,'E2E Agenda'),($3,$5,'E2E Serviço'),($4,$5,'E2E Automação')",
    [CONTATO_HUMANO, CONTATO_AGENDA, CONTATO_SERVICO, CONTATO_AUTOMACAO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'Green','green-${FUNIL_GREEN.slice(0, 8)}'),($3,$2,'Comum','comum-${FUNIL_COMUM.slice(0, 8)}')`,
    [FUNIL_GREEN, ORG, FUNIL_COMUM],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$8,$9,'A','etapa-a',1000), ($2,$8,$9,'B','etapa-b',2000), ($3,$8,$9,'C','etapa-c',3000),
       ($4,$8,$9,'Agendamento solicitado','agendamento-solicitado',4000), ($5,$8,$9,'Agendado','agendado',5000),
       ($6,$8,$10,'A','etapa-a',1000), ($7,$8,$10,'B','etapa-b',2000)`,
    [
      ETAPA.A,
      ETAPA.B,
      ETAPA.C,
      ETAPA.SOLICITADO,
      ETAPA.AGENDADO,
      ETAPA.COMUM_A,
      ETAPA.COMUM_B,
      ORG,
      FUNIL_GREEN,
      FUNIL_COMUM,
    ],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [ORG, FUNIL_GREEN],
  );
  // token de servidor `dsk_` (o hash é o que `resolveApiToken` procura)
  await pool.query(
    "insert into api_tokens (id, organization_id, created_by, name, prefix, token_hash, scopes) values ($1,$2,$3,'e2e agenda',$4,$5,$6::jsonb)",
    [
      TOKEN_ID,
      ORG,
      USUARIO,
      TOKEN_PLAIN.slice(0, 12),
      createHash("sha256").update(TOKEN_PLAIN).digest(),
      JSON.stringify(["mcp:read", "mcp:write", "role:ai_operator"]),
    ],
  );
  // sessão REAL (senha → GoTrue) e os cookies que o browser mandaria
  const anon = createClient(STACK.url, STACK.anon, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: EMAIL, password: SENHA });
  if (error || !data.session) throw error ?? new Error("sem sessão");
  JWT_USUARIO = data.session.access_token;
  jarro.cookies = await cookiesDaSessao(data.session);
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!TEM_STACK)("E2E PostgREST real — Green Mutation Boundary v2", () => {
  it("S18 — agenda por Bearer (rota real): confirmar move o card Green com o ator do token", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA.SOLICITADO, CONTATO_AGENDA);
    await pool.query(
      "insert into calendar_event_types (id, organization_id, name, slug) values ($1,$2,'Visita','visita-e2e')",
      [TIPO, ORG],
    );
    await pool.query(
      "insert into calendar_appointments (id, organization_id, title, starts_at, ends_at, status, contact_id, event_type_id, owner_user_id, time_zone) values ($1,$2,'Visita E2E', now() + interval '2 days', now() + interval '2 days 30 minutes','pending',$3,$4,$5,'America/Sao_Paulo')",
      [COMPROMISSO, ORG, CONTATO_AGENDA, TIPO, USUARIO],
    );
    jarro.cookies = new Map(); // integração de servidor: só o Bearer, nenhuma sessão
    const espiao = espiaoDeFetch();
    let res: Response;
    try {
      const { PATCH } = await import("@/app/api/v1/agenda/agendamentos/route");
      res = await PATCH(
        new NextRequest("http://localhost:3000/api/v1/agenda/agendamentos", {
          method: "PATCH",
          headers: { authorization: `Bearer ${TOKEN_PLAIN}`, "content-type": "application/json" },
          body: JSON.stringify({ id: COMPROMISSO, status: "confirmed" }),
        }),
      );
    } finally {
      espiao.restaurar();
    }
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id");
    expect(
      (await pool.query("select status from calendar_appointments where id=$1", [COMPROMISSO]))
        .rows[0].status,
    ).toBe("confirmed");
    // o espelho de etapa NÃO falhou: o card andou
    expect(await etapaDe(lead)).toBe(ETAPA.AGENDADO);
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.metadata).toMatchObject({
      green_canonical: true,
      caller: "service_role",
      source: "http_token",
      request_id: requestId,
      actor: { kind: "api_token", id: TOKEN_ID, api_token_id: TOKEN_ID },
      actor_kind: "api_token",
    });
    expect(eventos[0]!.payload).toMatchObject({
      from_stage_id: ETAPA.SOLICITADO,
      to_stage_id: ETAPA.AGENDADO,
    });
    // o UPDATE saiu por HTTP até o Kong, com o header
    const update = espiao.vistos.find(
      (v) => v.url.startsWith(`${STACK.url}/rest/v1/crm_leads`) && v.header,
    );
    expect(update).toBeDefined();
    // o gêmeo legado do writer foi o ÚNICO suprimido
    const [linha] = await livroDe(lead);
    expect(linha.legacy_suppressed_at).not.toBeNull();
  });

  it("S19 — requisição humana REAL (rota do Kanban): actor = usuário, request/correlation = da rota", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA.A, CONTATO_HUMANO);
    // o valor EXATO (microssegundos) que a OCC da rota compara
    const { updated_at } = (
      await pool.query("select to_json(updated_at)#>>'{}' updated_at from crm_leads where id=$1", [
        lead,
      ])
    ).rows[0];
    jarro.cookies = await cookiesDaSessao(
      (
        await createClient(STACK.url, STACK.anon, {
          auth: { persistSession: false },
        }).auth.signInWithPassword({ email: EMAIL, password: SENHA })
      ).data.session!,
    );
    const espiao = espiaoDeFetch();
    let res: Response;
    try {
      const { POST } = await import("@/app/api/v1/leads/[id]/move/route");
      res = await POST(
        new NextRequest(`http://localhost:3000/api/v1/leads/${lead}/move`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stage_id: ETAPA.B,
            position_in_stage: 1000,
            expected_updated_at: updated_at,
          }),
        }),
        { params: Promise.resolve({ id: lead }) },
      );
    } finally {
      espiao.restaurar();
    }
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id")!;
    expect(await etapaDe(lead)).toBe(ETAPA.B);
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(1); // a emissão legada da rota virou o gêmeo suprimido
    // CONTRATO v3 (AUDIT-08.2, ADV-04): o v2 afirmava `source: "http_session"`,
    // `request_id` e `correlation_id` da rota no TOPO do canônico. São valores que
    // viajam no header de uma sessão humana — advisory. No topo fica só o derivado.
    expect(eventos[0]!.metadata).toMatchObject({
      green_canonical: true,
      caller: "user",
      actor: { kind: "user", id: USUARIO },
      actor_user_id: USUARIO,
      source: "user_session",
      green: {
        advisory: { source: "http_session", request_id: requestId, correlation_id: requestId },
      },
    });
    expect(eventos[0]!.metadata).not.toHaveProperty("request_id");
    // o gêmeo legado casou com ESTA mutação; o request_id da rota fica registrado
    // como diagnóstico (`legacy_request_id`), não como chave confiável (`request_id`)
    const [linha] = await livroDe(lead);
    expect(linha).toMatchObject({ request_id: null, legacy_request_id: requestId });
    expect(linha.legacy_suppressed_at).not.toBeNull();
    // e o header humano saiu por HTTP (advisory, sem ator)
    const update = espiao.vistos.find(
      (v) => v.url.startsWith(`${STACK.url}/rest/v1/crm_leads`) && v.header,
    );
    expect(update).toBeDefined();
    expect(JSON.parse(Buffer.from(update!.header!, "base64").toString("utf8"))).not.toHaveProperty(
      "actor",
    );
  });

  it("S20 — service-role por HTTP: o header chega ao banco; sem contexto Green falha; não-Green passa", async () => {
    const { withGreenMutationContext } = await import("@/lib/green/mutation-context");
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const lead = await novoLead(FUNIL_GREEN, ETAPA.A, CONTATO_SERVICO);
    const requestId = `e2e-svc-${randomUUID()}`;
    const espiao = espiaoDeFetch();
    try {
      await withGreenMutationContext(
        {
          source: "e2e_service",
          request_id: requestId,
          idempotency_key: requestId,
          actor: { kind: "system", id: "e2e-worker" },
        },
        async () => {
          const { error } = await admin
            .from("crm_leads")
            .update({ stage_id: ETAPA.B })
            .eq("id", lead)
            .eq("stage_id", ETAPA.A);
          expect(error).toBeNull();
        },
      );
    } finally {
      espiao.restaurar();
    }
    expect(espiao.vistos.some((v) => v.url.startsWith(`${STACK.url}/rest/v1/`) && v.header)).toBe(
      true,
    );
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      green_canonical: true,
      caller: "service_role",
      source: "e2e_service",
      request_id: requestId,
      idempotency_key: requestId,
      actor: { kind: "system", id: "e2e-worker" },
    });

    // sem contexto: o PostgREST devolve a recusa do trigger e nada muda
    const semContexto = await admin.from("crm_leads").update({ stage_id: ETAPA.C }).eq("id", lead);
    expect(semContexto.error?.code).toBe("42501");
    expect(semContexto.error?.message).toBe("green_mutation_context_required");
    expect(await etapaDe(lead)).toBe(ETAPA.B);
    expect(await eventosDe(lead)).toHaveLength(1);

    // não-Green, sem contexto, pelo mesmo client: igual ao upstream
    const comum = await novoLead(FUNIL_COMUM, ETAPA.COMUM_A, CONTATO_SERVICO);
    const ok = await admin.from("crm_leads").update({ stage_id: ETAPA.COMUM_B }).eq("id", comum);
    expect(ok.error).toBeNull();
    expect(await etapaDe(comum)).toBe(ETAPA.COMUM_B);
    expect(await eventosDe(comum)).toHaveLength(0);
  });

  it("S20b — client do agent-worker (crmEdgeConfigFromEnv) por HTTP: o contexto do job chega ao banco", async () => {
    const { withGreenMutationContext } = await import("@/lib/green/mutation-context");
    const { crmEdgeConfigFromEnv } = await import("@/lib/agent-engine/edge/crm/mcp-client");
    const cfg = crmEdgeConfigFromEnv({
      SUPABASE_URL: STACK.url,
      SUPABASE_SERVICE_ROLE_KEY: STACK.service,
    });
    const lead = await novoLead(FUNIL_GREEN, ETAPA.A, CONTATO_SERVICO);
    const job = `job-${randomUUID()}`;
    // a mesma forma que `withServiceJob` amarra para um job sem fronteira
    await withGreenMutationContext(
      { source: "agent_engine", source_job_id: job, actor: { kind: "system", id: "inbound_turn" } },
      async () => {
        // compare-and-set pela etapa de origem, como `sincronizaEstagioDoAgente`
        const { error } = await cfg.supabase
          .from("crm_leads")
          .update({ stage_id: ETAPA.B })
          .eq("id", lead)
          .eq("stage_id", ETAPA.A);
        expect(error).toBeNull();
      },
    );
    expect(await etapaDe(lead)).toBe(ETAPA.B);
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      caller: "service_role",
      source: "agent_engine",
      source_job_id: job,
      actor: { kind: "system", id: "inbound_turn" },
    });
  });

  it("S21 — humano direto no PostgREST: header forjado não muda o ator; forja de canônico e oracle recusados", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA.A, CONTATO_HUMANO);
    const forjado = Buffer.from(
      JSON.stringify({
        v: 1,
        source: "forjado",
        request_id: "req-forjado",
        actor: { kind: "system", id: "admin" },
      }),
      "utf8",
    ).toString("base64");
    const base = {
      apikey: STACK.anon,
      authorization: `Bearer ${JWT_USUARIO}`,
      "content-type": "application/json",
    };
    const r = await fetch(`${STACK.url}/rest/v1/crm_leads?id=eq.${lead}`, {
      method: "PATCH",
      headers: { ...base, "x-green-mutation-context": forjado, prefer: "return=minimal" },
      body: JSON.stringify({ stage_id: ETAPA.B }),
    });
    expect(r.status).toBe(204);
    const [e] = await eventosDe(lead);
    // CONTRATO v3 (ADV-04): o v2 afirmava `request_id: "req-forjado"` no TOPO. O
    // usuário continua podendo escrevê-lo — só que agora ele fica em advisory.
    expect(e!.metadata).toMatchObject({
      caller: "user",
      actor: { kind: "user", id: USUARIO },
      source: "user_session",
      green: { advisory: { request_id: "req-forjado" } },
    });
    expect(e!.metadata).not.toHaveProperty("request_id");
    expect((e!.payload.service_origin as { kind: string }).kind).toBe("command");

    // forjar o canônico pela RPC pública
    const forja = await fetch(`${STACK.url}/rest/v1/rpc/emit_event`, {
      method: "POST",
      headers: base,
      body: JSON.stringify({
        p_event_type: "lead.stage_changed",
        p_entity_kind: "crm_lead",
        p_entity_id: lead,
        p_payload: { from_stage_id: ETAPA.A, to_stage_id: ETAPA.B },
        p_metadata: { green_canonical: true },
        p_organization_id: ORG,
      }),
    });
    expect(forja.status).toBeGreaterThanOrEqual(400);
    expect(((await forja.json()) as { message: string }).message).toBe("green_canonical_reserved");
    expect(await eventosDe(lead)).toHaveLength(1);

    // o oracle não é alcançável por HTTP (schema fora da API; sem USAGE)
    const oracle = await fetch(`${STACK.url}/rest/v1/rpc/fn_is_green_pipeline`, {
      method: "POST",
      headers: { ...base, "content-profile": "green" },
      body: JSON.stringify({ p_org: ORG, p_pipeline: FUNIL_GREEN }),
    });
    expect(oracle.status).toBeGreaterThanOrEqual(400);
  });

  it("S22 — automação real (dispatcher + motor + create_or_move_lead): causation, origem e anti-loop", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA.A, CONTATO_AUTOMACAO);
    await pool.query(
      "insert into automation_rules (id, organization_id, name, trigger_event, is_active, conditions, actions) values ($1,$2,'E2E move para C','lead.stage_changed',true,'[]'::jsonb,$3::jsonb)",
      [
        REGRA,
        ORG,
        JSON.stringify([
          { type: "create_or_move_lead", config: { pipeline_id: FUNIL_GREEN, stage_id: ETAPA.C } },
        ]),
      ],
    );
    try {
      // E: o humano move A → B direto no PostgREST (evento canônico real)
      const r = await fetch(`${STACK.url}/rest/v1/crm_leads?id=eq.${lead}`, {
        method: "PATCH",
        headers: {
          apikey: STACK.anon,
          authorization: `Bearer ${JWT_USUARIO}`,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        body: JSON.stringify({ stage_id: ETAPA.B }),
      });
      expect(r.status).toBe(204);
      const [E] = await eventosDe(lead);

      const { dispatchEvent, registerHandler } = await import("@/lib/event-log/dispatcher");
      const { automationRulesHandler } = await import("@/lib/automation/engine.handler");
      registerHandler(automationRulesHandler);

      const espiao = espiaoDeFetch();
      let resultado;
      try {
        resultado = await dispatchEvent({ ...E!, entity_id: E!.entity_id });
      } finally {
        espiao.restaurar();
      }
      expect(resultado.find((x) => x.consumer_key === "automation-rules")?.status).toBe("ok");
      expect(await etapaDe(lead)).toBe(ETAPA.C);

      const eventos = await eventosDe(lead);
      expect(eventos).toHaveLength(2); // E + canônico da regra; o gêmeo do handler sumiu
      const E2 = eventos[1]!;
      expect(E2.metadata).toMatchObject({
        green_canonical: true,
        caller: "service_role",
        source: "automation",
        request_id: `rule:${REGRA}`,
        causation_event_id: E!.id,
        actor: { kind: "webhook_source", id: REGRA },
      });
      expect(E2.payload.service_origin).toEqual({
        kind: "event",
        event_id: E!.id,
        organization_id: ORG,
        contact_id: CONTATO_AUTOMACAO,
      });
      expect(
        espiao.vistos.some((v) => v.url.startsWith(`${STACK.url}/rest/v1/crm_leads`) && v.header),
      ).toBe(true);

      // anti-loop: o evento que a regra causou volta ao dispatcher e a regra NÃO roda
      const deNovo = await dispatchEvent(E2);
      expect(deNovo.find((x) => x.consumer_key === "automation-rules")).toMatchObject({
        status: "skipped",
        detail: "caused_by_rule",
      });
      expect(await etapaDe(lead)).toBe(ETAPA.C);
      expect(await eventosDe(lead)).toHaveLength(2);
    } finally {
      await pool.query("update automation_rules set is_active=false where id=$1", [REGRA]);
    }
  });
});

describe.skipIf(TEM_STACK)("E2E PostgREST real — sem stack local", () => {
  it.skip("exporte GREEN_E2E_* a partir de `supabase status -o json` para rodar", () => {});
});
