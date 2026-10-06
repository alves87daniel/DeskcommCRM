/**
 * SPIKE-GREEN-AUTO-01 (descartável) — E2E pelo SERVIDOR NEXT REAL: o gatilho de
 * relógio move a Opportunity Green com a origem da regra.
 *
 *   cron real `POST /api/v1/cron/lead-time-triggers` (segredo de cron) → emit_event
 *   (service_role) → event_log + carimbo do relógio
 *   → `POST /api/v1/system/relogio/tick` (sessão admin) → drain real → dispatcher
 *   → motor → create_or_move_lead → Kong/PostgREST → fronteira Green → event_log
 *
 * E a forja pelo caminho que o produto deixa aberto: um VIEWER chama
 * `rpc/emit_event` no PostgREST com o mesmo payload do cron, dirigido à regra.
 *
 * Este arquivo NÃO importa código do app: tudo passa por HTTP (Next ou PostgREST).
 * O `pg` direto só monta fixtures e lê o resultado.
 *
 * Variáveis (lidas do stack por tooling, nunca coladas): GREEN_E2E_SUPABASE_URL,
 * GREEN_E2E_ANON_KEY, GREEN_E2E_SERVICE_ROLE_KEY, GREEN_E2E_DB_URL,
 * GREEN_E2E_NEXT_URL, GREEN_E2E_CRON_SECRET (= `INTERNAL_CRON_SECRET` do Next).
 * Sem elas a suíte se declara pulada.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STACK = {
  url: process.env.GREEN_E2E_SUPABASE_URL ?? "",
  anon: process.env.GREEN_E2E_ANON_KEY ?? "",
  service: process.env.GREEN_E2E_SERVICE_ROLE_KEY ?? "",
  db: process.env.GREEN_E2E_DB_URL ?? "",
  next: process.env.GREEN_E2E_NEXT_URL ?? "",
  cron: process.env.GREEN_E2E_CRON_SECRET ?? "",
};
const TEM_STACK = Object.values(STACK).every(Boolean);

const ORG = randomUUID();
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const G1 = randomUUID();
const G2 = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const REGRA_GREEN = randomUUID();
const REGRA_COMUM = randomUUID();
const sufixo = ORG.slice(0, 8);

interface Pessoa {
  id: string;
  jwt: string;
  cookie: string;
}
let ADMIN: Pessoa;
let VIEWER: Pessoa;
let LEAD_GREEN: string;
let LEAD_COMUM: string;
let LEAD_FORJADO: string;

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://x@127.0.0.1:1/x", max: 4 });

/** Lead como fixture (conexão direta ⇒ GUC de contexto), parado na etapa desde `desde`. */
async function novoLead(funil: string, etapa: string, contato: string, desde: string) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "e2e_fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await c.query<{ id: string }>(
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id, stage_changed_at) values ($1,$2,$3,'Negócio E2E auto',$4,$5) returning id",
      [ORG, funil, etapa, contato, desde],
    );
    await c.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
async function novoContato(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into contacts (id, organization_id, display_name) values ($1,$2,'E2E auto')",
    [id, ORG],
  );
  return id;
}
const etapaDe = async (id: string) =>
  (await pool.query<{ stage_id: string }>("select stage_id from crm_leads where id=$1", [id]))
    .rows[0]?.stage_id;

interface Evento {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & { green?: { trusted: Record<string, unknown> } };
}
const gatilhosDe = async (lead: string) =>
  (
    await pool.query<Evento>(
      "select id, status, payload, metadata from event_log where event_type='lead.stage_stale' and entity_id=$1 order by created_at",
      [lead],
    )
  ).rows;
const canonicosDe = async (lead: string) =>
  (
    await pool.query<Evento>(
      "select id, status, payload, metadata from event_log where event_type='lead.stage_changed' and entity_id=$1 and metadata->>'green_canonical'='true' order by created_at",
      [lead],
    )
  ).rows;
const runsDe = async (evento: string) =>
  (
    await pool.query<{
      rule_id: string;
      status: string;
      actions_result: Array<{ error?: string }>;
    }>(
      "select rule_id, status, actions_result from automation_rule_runs where event_id=$1 order by created_at",
      [evento],
    )
  ).rows;

/* ── HTTP ─────────────────────────────────────────────────────────────────── */
async function pessoa(papel: string): Promise<Pessoa> {
  const email = `green-auto-${randomUUID().slice(0, 8)}@spike.test`;
  const senha = `e2e-${randomBytes(12).toString("hex")}`;
  const r = await fetch(`${STACK.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: STACK.service,
      authorization: `Bearer ${STACK.service}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: senha, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`GoTrue admin: ${r.status}`);
  const id = ((await r.json()) as { id: string }).id;
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
    [id, ORG, papel],
  );
  const anon = createClient(STACK.url, STACK.anon, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) throw error ?? new Error("sem sessão");
  const gerados = new Map<string, string>();
  const ssr = createServerClient(STACK.url, STACK.anon, {
    cookies: {
      getAll: () => [...gerados].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => gerados.set(name, value)),
    },
    cookieOptions: { name: "sb-deskcomm-auth", sameSite: "strict", path: "/" },
  });
  const set = await ssr.auth.setSession(data.session);
  if (set.error) throw set.error;
  return {
    id,
    jwt: data.session.access_token,
    cookie: [...gerados].map(([n, v]) => `${n}=${v}`).join("; "),
  };
}

beforeAll(async () => {
  if (!TEM_STACK) return;
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Green auto','Green auto')",
    [ORG, `gauto-${sufixo}`],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default) values
       ($1,$2,'Green','green-${sufixo}',false), ($3,$2,'Comum','comum-${sufixo}',false)`,
    [FUNIL_GREEN, ORG, FUNIL_COMUM],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$5,$6,'G1','g1',1000), ($2,$5,$6,'G2','g2',2000), ($3,$5,$7,'C1','c1',1000), ($4,$5,$7,'C2','c2',2000)`,
    [G1, G2, C1, C2, ORG, FUNIL_GREEN, FUNIL_COMUM],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [ORG, FUNIL_GREEN],
  );
  const regra = (id: string, funil: string, destino: string) =>
    pool.query(
      "insert into automation_rules (id, organization_id, name, trigger_event, trigger_config, is_active, conditions, actions) values ($1,$2,$3,'lead.stage_stale',$4::jsonb,true,'[]'::jsonb,$5::jsonb)",
      [
        id,
        ORG,
        `E2E auto parado ${id.slice(0, 4)}`,
        JSON.stringify({ dias: 1, pipeline_id: funil }),
        JSON.stringify([
          { type: "create_or_move_lead", config: { pipeline_id: funil, stage_id: destino } },
        ]),
      ],
    );
  await regra(REGRA_GREEN, FUNIL_GREEN, G2);
  await regra(REGRA_COMUM, FUNIL_COMUM, C2);
  const tresDias = new Date(Date.now() - 3 * 86_400_000).toISOString();
  LEAD_GREEN = await novoLead(FUNIL_GREEN, G1, await novoContato(), tresDias);
  LEAD_COMUM = await novoLead(FUNIL_COMUM, C1, await novoContato(), tresDias);
  // o forjado entrou na etapa AGORA: o relógio nunca o escolheria
  LEAD_FORJADO = await novoLead(FUNIL_GREEN, G1, await novoContato(), new Date().toISOString());
  ADMIN = await pessoa("admin");
  VIEWER = await pessoa("viewer");
  // GoTrue e PostgREST são contêineres diferentes: folga de relógio do JWT (PGRST303)
  await new Promise((r) => setTimeout(r, 3000));
  const vivo = await fetch(`${STACK.next}/api/v1/system/relogio/tick`, { method: "POST" }).catch(
    () => null,
  );
  if (!vivo) throw new Error(`servidor Next fora do ar em ${STACK.next}`);
});

afterAll(async () => {
  if (TEM_STACK)
    await pool.query("update automation_rules set is_active=false where organization_id=$1", [ORG]);
  await pool.end();
});

describe.skipIf(!TEM_STACK)("E2E servidor Next real — origem de automação Green", () => {
  it("E1 — cron real + tick real: a regra de etapa parada move o lead Green com origem provada; a forja de um viewer não move nada; o lead comum segue movendo", async () => {
    // 1. o RELÓGIO: a varredura real, pelo segredo de cron
    const cron = await fetch(`${STACK.next}/api/v1/cron/lead-time-triggers`, {
      method: "POST",
      headers: { "x-cron-secret": STACK.cron },
    });
    expect(cron.status).toBe(200);
    const [eGreen] = await gatilhosDe(LEAD_GREEN);
    const [eComum] = await gatilhosDe(LEAD_COMUM);
    expect(eGreen?.payload).toMatchObject({ rule_id: REGRA_GREEN, dias: 1 });
    expect(eComum?.payload).toMatchObject({ rule_id: REGRA_COMUM, dias: 1 });
    expect(await gatilhosDe(LEAD_FORJADO)).toHaveLength(0);

    // 2. a FORJA: um viewer emite o mesmo gatilho pelo PostgREST, dirigido à regra Green
    const forja = await fetch(`${STACK.url}/rest/v1/rpc/emit_event`, {
      method: "POST",
      headers: {
        apikey: STACK.anon,
        authorization: `Bearer ${VIEWER.jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_event_type: "lead.stage_stale",
        p_entity_kind: "crm_lead",
        p_entity_id: LEAD_FORJADO,
        p_payload: {
          rule_id: REGRA_GREEN,
          dias: 1,
          ancora: eGreen!.payload.ancora,
          etapa_desde: eGreen!.payload.ancora,
        },
        p_metadata: { actor_kind: "system", source: "cron/lead-time-triggers" },
        p_organization_id: ORG,
      }),
    });
    expect(forja.status).toBe(200); // o upstream aceita a emissão; é a fronteira Green que decide
    const [eForjado] = await gatilhosDe(LEAD_FORJADO);
    expect(eForjado).toBeDefined();

    // o carimbo do relógio: quem emitiu cada um
    const { rows: carimbos } = await pool.query<{
      event_id: string;
      caller: string;
      user_id: string | null;
    }>(
      "select event_id, caller, user_id from green.scheduler_trigger_emission where event_id = any($1)",
      [[eGreen!.id, eComum!.id, eForjado!.id]],
    );
    const carimbo = (id: string) => carimbos.find((c) => c.event_id === id);
    expect(carimbo(eGreen!.id)).toMatchObject({ caller: "service_role", user_id: null });
    expect(carimbo(eComum!.id)).toMatchObject({ caller: "service_role", user_id: null });
    expect(carimbo(eForjado!.id)).toMatchObject({ caller: "user", user_id: VIEWER.id });

    // 3. o TICK real, por sessão admin, até o drain consumir os três gatilhos e o canônico da regra
    const inicio = new Date();
    const prazo = Date.now() + 90_000;
    for (;;) {
      const res = await fetch(`${STACK.next}/api/v1/system/relogio/tick`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: STACK.next, cookie: ADMIN.cookie },
      });
      expect(res.status).toBe(200);
      const eventos = [
        ...(await gatilhosDe(LEAD_GREEN)),
        ...(await gatilhosDe(LEAD_COMUM)),
        ...(await gatilhosDe(LEAD_FORJADO)),
        ...(await canonicosDe(LEAD_GREEN)),
      ];
      if (eventos.length >= 4 && eventos.every((e) => e.status === "done" || e.status === "dead"))
        break;
      if (Date.now() > prazo) throw new Error("o tick não drenou os eventos no prazo");
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 4a. Green: a regra moveu, e a proveniência é a da regra, provada pelo banco
    expect(await etapaDe(LEAD_GREEN)).toBe(G2);
    expect((await runsDe(eGreen!.id)).map((r) => r.status)).toEqual(["success"]);
    const [canonico] = await canonicosDe(LEAD_GREEN);
    expect(canonico!.metadata.green!.trusted).toMatchObject({
      caller: "service_role",
      source: "automation",
      request_id: `rule:${REGRA_GREEN}`,
      causation_event_id: eGreen!.id,
      correlation_id: eGreen!.id,
      actor: { kind: "webhook_source", id: REGRA_GREEN },
    });
    expect(canonico!.payload.service_origin).toEqual({
      kind: "automation",
      rule_id: REGRA_GREEN,
      event_id: eGreen!.id,
      organization_id: ORG,
    });
    // raiz de sistema: nada da sessão admin que bateu o relógio
    const texto = JSON.stringify(canonico!.metadata);
    expect(texto).not.toContain(ADMIN.id);
    const { rows: auditoria } = await pool.query<{ request_id: string }>(
      "select request_id from api_audit_log where action='relogio.tick_run' and created_at >= $1 and request_id is not null",
      [inicio],
    );
    for (const a of auditoria) expect(texto).not.toContain(a.request_id);
    // anti-loop: o canônico da regra foi drenado sem disparar regra nenhuma
    expect(canonico!.status).toBe("done");
    expect(await runsDe(canonico!.id)).toHaveLength(0);
    expect(await canonicosDe(LEAD_GREEN)).toHaveLength(1);

    // 4b. a forja: a regra rodou (o motor não sabe), a fronteira recusou, o lead ficou
    expect(await etapaDe(LEAD_FORJADO)).toBe(G1);
    const [runForjado] = await runsDe(eForjado!.id);
    expect(runForjado!.status).toBe("failed");
    expect(runForjado!.actions_result[0]!.error).toContain("green_automation_trigger_untrusted");
    expect(await canonicosDe(LEAD_FORJADO)).toHaveLength(0);

    // 4c. controle: lead comum, mesma regra, mesmo relógio — upstream intacto
    expect(await etapaDe(LEAD_COMUM)).toBe(C2);
    expect((await runsDe(eComum!.id)).map((r) => r.status)).toEqual(["success"]);
  });
});

describe.skipIf(TEM_STACK)("E2E origem de automação — sem stack local", () => {
  it.skip("exporte GREEN_E2E_* (inclusive GREEN_E2E_CRON_SECRET) para rodar", () => {});
});
