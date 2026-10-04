/**
 * SPIKE-GREEN-03 — Canonical Event Cutover (DESCARTÁVEL).
 *
 * Contrato do barramento Green depois do cutover (o que esta suíte exige):
 *
 *   CE1  cada fato Green tem UM produtor. `lead.stage_changed` de lead Green nasce do banco
 *        (canônico, na transação da mutação); o writer não grava um segundo fato.
 *   CE2  o gêmeo legado de uma mutação canonizada é reconhecido por CHAVE FORTE (o escopo de
 *        execução do servidor que fez a mutação e emitiu o gêmeo), sem janela de tempo e sem
 *        "o mais recente": atrasado, repetido, fora de ordem ou concorrente, ele não vira fato.
 *   CE3  nenhum evento legítimo é engolido: o que não é o gêmeo da mutação daquele escopo passa.
 *   CE4  `lead.stage_changed` de lead Green que não vem de escopo do servidor não nasce (no-op,
 *        como o gêmeo); reordenação na mesma etapa não é fato de etapa.
 *   CE5  lead comum: upstream intacto (legado continua, payload/metadata do writer).
 *   CE6  binding: nenhum evento por lead; o registro é estrutural e atômico (entrada: binding +
 *        identidade `first_seen_at`; saída: `green.binding_removed` com `released_leads`).
 *   CE7  `lead.created` continua do writer (um só); `lead.deleted` continua registro (`done`).
 *   CE8  automação recebe o fato uma vez; anti-loop e origem intactos.
 *   CE9  rollback leva estado e fato juntos; concorrência nunca dá 2.
 *   CE10 a migração (0508) é idempotente e sobe de um banco 0507 com dados.
 *
 * Mesmo arquivo contra a base (`8c4e903a`, 0507) e a spike: só muda o código sob teste. O que é
 * novo é lido por catálogo/`to_jsonb`, para a diferença aparecer na asserção e não num "does
 * not exist". As requisições SQL simulam o transporte do servidor (contexto + escopo); a base
 * ignora o header de escopo. Os writers privilegiados reais rodam pelo dublê PostgREST
 * (`green-postgrest-shim.ts`), que leva os headers do escopo ALS corrente — quem declara é o
 * código sob teste.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientePostgrest, type Identidade } from "./green-postgrest-shim";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchEvent, registerHandler, type EventRow } from "@/lib/event-log/dispatcher";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { sincronizaEstagioDoAgente } from "@/lib/leads/agent-stage-sync";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";
import { moverLeadParaEtapaDeAgendamento } from "@/lib/leads/appointment-stage-move";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { withGreenMutationContext, withGreenSystemRoot } from "@/lib/green/mutation-context";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 24,
});
const admin = () => clientePostgrest(pool, { papel: "service_role" });

beforeAll(() => {
  vi.mocked(createAdminClient).mockImplementation(admin);
  registerHandler(automationRulesHandler);
});

/** Matriz RED/GREEN e diagnóstico, gravados em arquivo se `GREEN_CUTOVER_DIAG_OUT` existir. */
const relatorio: Array<Record<string, unknown>> = [];
afterAll(async () => {
  if (process.env.GREEN_CUTOVER_DIAG_OUT) {
    writeFileSync(process.env.GREEN_CUTOVER_DIAG_OUT, JSON.stringify(relatorio, null, 2));
  }
  await pool.end();
});

/** Header do escopo de execução do servidor (o transporte o manda junto do contexto). */
const ESCOPO = "x-green-scope-id";

/* ── requests no formato do PostgREST ───────────────────────────────────────── */
interface Request {
  papel: Identidade["papel"];
  sub?: string;
  contexto?: Record<string, unknown>;
  escopo?: string;
}
const b64 = (ctx: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(ctx), "utf8").toString("base64");

async function prepararRequest(c: pg.PoolClient, r: Request) {
  await c.query("begin");
  await c.query(`set local role ${r.papel}`);
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(
      r.papel === "authenticated"
        ? { sub: r.sub, role: "authenticated" }
        : { role: "service_role" },
    ),
  ]);
  const headers: Record<string, string> = { "sb-request-id": randomUUID() };
  if (r.contexto) headers["x-green-mutation-context"] = b64(r.contexto);
  if (r.escopo) headers[ESCOPO] = r.escopo;
  await c.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
}

async function request<T extends pg.QueryResultRow = pg.QueryResultRow>(
  r: Request,
  sql: string,
  args: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const c = await pool.connect();
  try {
    await prepararRequest(c, r);
    const out = await c.query<T>(sql, args);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Abre a transação de uma request e devolve o client (o teste decide commit/rollback). */
async function requestAberta(r: Request): Promise<pg.PoolClient> {
  const c = await pool.connect();
  await prepararRequest(c, r);
  return c;
}

const CONTEXTO_DONO = JSON.stringify({
  v: 1,
  source: "fixture",
  actor: { kind: "system", id: "fixture" },
});
async function comoDono(sql: string, args: unknown[] = []): Promise<pg.QueryResult> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('green.mutation_context', $1, true)", [CONTEXTO_DONO]);
    const out = await c.query(sql, args);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/* ── escopos de execução, como o servidor os entrega ─────────────────────────── */
/**
 * Um escopo = uma execução do servidor (uma requisição humana, uma tool MCP, uma regra, um job).
 * O writer faz a mutação e emite o legado DENTRO do mesmo escopo; as duas requests levam o
 * mesmo contexto e o mesmo id de escopo.
 */
interface Escopo {
  id: string;
  quem: Request;
}
function humano(sub: string): Escopo {
  const rid = randomUUID();
  return {
    id: randomUUID(),
    quem: {
      papel: "authenticated",
      sub,
      contexto: { v: 1, source: "http_session", request_id: rid, correlation_id: rid },
    },
  };
}
function servico(extra: Record<string, unknown> = {}): Escopo {
  return {
    id: randomUUID(),
    quem: {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "mcp",
        request_id: `req-${randomUUID()}`,
        actor: { kind: "api_token", id: "tok-cutover", api_token_id: "tok-cutover" },
        ...extra,
      },
    },
  };
}
const no = (e: Escopo): Request => ({ ...e.quem, escopo: e.id });

/** UPDATE de etapa como o writer faz; devolve a etapa de origem lida na mesma instrução. */
async function mover(e: Escopo | Request, lead: string, para: string): Promise<string> {
  const r = "id" in e && "quem" in e ? no(e) : e;
  const { rows } = await request<{ de: string }>(
    r,
    `with antes as (select id, stage_id from crm_leads where id=$1)
     update crm_leads l set stage_id=$2 from antes where l.id=antes.id returning antes.stage_id de`,
    [lead, para],
  );
  return rows[0]!.de;
}

/** A emissão legada do writer (`emit_event`), na request indicada. Devolve o id (null = não gravou). */
async function legado(
  r: Request,
  org: string,
  lead: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<string | null> {
  const { rows } = await request<{ id: string | null }>(
    r,
    "select public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,$3::jsonb,$4) id",
    [lead, JSON.stringify(payload), JSON.stringify(metadata), org],
  );
  return rows[0]!.id;
}
/** O gêmeo do writer: o legado emitido no MESMO escopo da mutação. */
const gemeo = (
  e: Escopo,
  org: string,
  lead: string,
  de: string,
  para: string,
  meta: Record<string, unknown> = {},
) => legado(no(e), org, lead, { from_stage_id: de, to_stage_id: para }, meta);

/* ── leitura do que existe ────────────────────────────────────────────────── */
interface Fato {
  id: string;
  event_type: string;
  entity_kind: string;
  status: string;
  consumed_by: string[];
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & {
    green?: { trusted?: Record<string, unknown>; advisory?: Record<string, unknown> };
  };
  canonico: boolean;
}
async function fatos(lead: string): Promise<Fato[]> {
  const { rows } = await pool.query<Fato>(
    `select id, event_type, entity_kind, status, consumed_by, payload, metadata,
            coalesce(metadata->>'green_canonical','') = 'true' as canonico
       from event_log
      where entity_id=$1 and entity_kind in ('crm_lead','lead')
      order by created_at, id`,
    [lead],
  );
  return rows;
}
const etapasMudadas = async (lead: string) =>
  (await fatos(lead)).filter((f) => f.event_type === "lead.stage_changed");
const canonicos = async (lead: string) => (await etapasMudadas(lead)).filter((f) => f.canonico);
const legados = async (lead: string) => (await etapasMudadas(lead)).filter((f) => !f.canonico);

async function livro(lead: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<{ l: Record<string, unknown> }>(
    "select to_jsonb(l) l from green.stage_event_ledger l where lead_id=$1 order by created_at, id",
    [lead],
  );
  return rows.map((r) => r.l);
}
const etapaDe = async (lead: string) =>
  (await pool.query<{ stage_id: string }>("select stage_id from crm_leads where id=$1", [lead]))
    .rows[0]?.stage_id;

/** Linha da matriz (RED/GREEN): o que a execução produziu, sem interpretar. */
async function linha(caso: string, lead: string, extra: Record<string, unknown> = {}) {
  const fs = await fatos(lead);
  const ultimoCanonico = fs.filter((f) => f.canonico).at(-1);
  const l = {
    caso,
    etapa: await etapaDe(lead),
    fatos: fs.map(
      (f) =>
        `${f.event_type}${f.canonico ? "[canônico]" : f.event_type === "lead.stage_changed" ? "[legado]" : ""}:${f.status}`,
    ),
    canonicos: fs.filter((f) => f.event_type === "lead.stage_changed" && f.canonico).length,
    legados: fs.filter((f) => f.event_type === "lead.stage_changed" && !f.canonico).length,
    livro: (await livro(lead)).map((x) => ({
      kind: x.kind,
      escopo: x.scope_id === undefined ? "(sem coluna)" : x.scope_id ? "sim" : "não",
      request_id: x.request_id ?? null,
      legacy_suppressed: x.legacy_suppressed_at ? "sim" : "não",
    })),
    request_id:
      (ultimoCanonico?.metadata.green?.trusted?.request_id as string | undefined) ??
      (ultimoCanonico?.metadata.green?.advisory?.request_id as string | undefined) ??
      null,
    correlation:
      ultimoCanonico?.metadata.green?.trusted?.correlation_id ??
      ultimoCanonico?.metadata.green?.advisory?.correlation_id ??
      null,
    causation: ultimoCanonico?.metadata.green?.trusted?.causation_event_id ?? null,
    consumed_by: fs.map((f) => f.consumed_by),
    ...extra,
  };
  relatorio.push(l);
  return l;
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */
interface Funil {
  id: string;
  e1: string;
  e2: string;
  e3: string; // hint do agente `qualifying`
  handoff: string; // slug `chamar-humano`
  agendado: string; // slug `agendado`
  ganho: string;
  perda: string;
}
interface Tenant {
  org: string;
  admin: string;
  agente: string;
  viewer: string;
  contato: string;
  contato2: string;
  conversa: string;
  green: Funil;
  comum: Funil;
}

async function novoFunil(org: string, nome: string): Promise<Funil> {
  const f: Funil = {
    id: randomUUID(),
    e1: randomUUID(),
    e2: randomUUID(),
    e3: randomUUID(),
    handoff: randomUUID(),
    agendado: randomUUID(),
    ganho: randomUUID(),
    perda: randomUUID(),
  };
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug, is_default) values ($1,$2,$3,$4,false)",
    [f.id, org, nome, `${nome.toLowerCase()}-${f.id.slice(0, 8)}`],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, agent_stage_hint, is_won, is_lost) values
       ($1,$8,$9,'E1','e1',1000,null,false,false),
       ($2,$8,$9,'E2','e2',2000,null,false,false),
       ($3,$8,$9,'E3','e3',3000,'qualifying',false,false),
       ($4,$8,$9,'Chamar humano','chamar-humano',4000,null,false,false),
       ($5,$8,$9,'Agendado','agendado',5000,null,false,false),
       ($6,$8,$9,'Ganho','ganho',8000,null,true,false),
       ($7,$8,$9,'Perdido','perdido',9000,null,false,true)`,
    [f.e1, f.e2, f.e3, f.handoff, f.agendado, f.ganho, f.perda, org, f.id],
  );
  return f;
}

async function tenant(): Promise<Tenant> {
  const org = randomUUID();
  const [adminU, agente, viewer] = [randomUUID(), randomUUID(), randomUUID()];
  for (const u of [adminU, agente, viewer]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2)", [
      u,
      `u-${u}@cutover.test`,
    ]);
  }
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [org, `co-${org}`, `Org ${org.slice(0, 8)}`],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1,$4,'admin',now()), ($2,$4,'agent',now()), ($3,$4,'viewer',now())`,
    [adminU, agente, viewer, org],
  );
  const sessaoCanal = randomUUID();
  await pool.query(
    "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
    [sessaoCanal, org, `co-${sessaoCanal}`],
  );
  const [contato, contato2, conversa] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, nome] of [
    [contato, "Maria Cutover"],
    [contato2, "João Cutover"],
  ] as const) {
    await pool.query(
      "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,$3,$4)",
      [id, org, nome, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
    );
  }
  await pool.query(
    "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')",
    [conversa, org, contato, sessaoCanal],
  );
  const green = await novoFunil(org, "Green");
  const comum = await novoFunil(org, "Comum");
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [comum.id]);
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [org, green.id],
  );
  return { org, admin: adminU, agente, viewer, contato, contato2, conversa, green, comum };
}

async function novoLead(
  t: Tenant,
  funil: Funil,
  etapa: string,
  contato: string | null = null,
): Promise<string> {
  const { rows } = await comoDono(
    "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio',$4) returning id",
    [t.org, funil.id, etapa, contato],
  );
  return rows[0].id as string;
}

/* ── drain (um evento): claim `processing` → dispatchEvent → `done` ────────── */
const COLS_EVENTO =
  "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at::text";
async function drenar(eventId: string) {
  const { rows } = await pool.query<EventRow>(
    `update event_log set status='processing' where id=$1 and status='pending' returning ${COLS_EVENTO}`,
    [eventId],
  );
  expect(rows, `evento ${eventId} não estava pending`).toHaveLength(1);
  const resultados = await dispatchEvent(rows[0]!);
  const ok = resultados
    .filter((r) => r.status === "ok" || r.status === "skipped")
    .map((r) => r.consumer_key);
  await pool.query(
    "update event_log set status='done', consumed_by = consumed_by || $2::text[] where id=$1",
    [eventId, ok],
  );
  return resultados;
}
async function runsDe(eventId: string) {
  const { rows } = await pool.query<{ rule_id: string; status: string; actions_result: unknown }>(
    "select rule_id, status, actions_result from automation_rule_runs where event_id=$1 order by created_at",
    [eventId],
  );
  return rows;
}
async function regra(
  t: Tenant,
  gatilho: string,
  destino: string,
  funil: Funil,
  conditions: unknown[] = [],
) {
  const id = randomUUID();
  await pool.query(
    "insert into automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true)",
    [
      id,
      t.org,
      `R ${gatilho}`,
      gatilho,
      JSON.stringify(conditions),
      JSON.stringify([
        { type: "create_or_move_lead", config: { pipeline_id: funil.id, stage_id: destino } },
      ]),
    ],
  );
  return id;
}

/* ── writers privilegiados REAIS, cada um no escopo que o servidor abre ─────── */
const ctxDeHandler = (t: Tenant, requestId: string) => ({
  organization_id: t.org,
  actor: { type: "api_token" as const, id: "tok-cutover" },
  requestId,
});
/** Tool MCP: `withGreenMutationContext` do `lib/mcp/server.ts` em volta do handler. */
function viaMcp<T>(fn: () => Promise<T>): Promise<T> {
  return withGreenMutationContext(
    {
      source: "mcp",
      request_id: `mcp-${randomUUID()}`,
      actor: { kind: "api_token", id: "tok-cutover", api_token_id: "tok-cutover" },
    },
    fn,
  );
}
/** Job do agent-worker: raiz de sistema (`withServiceJob`). */
function viaJob<T>(fn: () => Promise<T>): Promise<T> {
  return withGreenSystemRoot(
    {
      source: "agent_engine",
      source_job_id: `job-${randomUUID()}`,
      actor: { kind: "ai_agent", id: "agente-cutover" },
    },
    fn,
  );
}
/** Handler do dispatcher (raiz de sistema por evento). */
function viaHandler<T>(causa: string, fn: () => Promise<T>): Promise<T> {
  return withGreenSystemRoot(
    {
      source: "event_handler",
      actor: { kind: "system", id: "handler-cutover" },
      causation_event_id: causa,
      correlation_id: causa,
    },
    fn,
  );
}

/* ═══ CEN — o barramento depois do cutover ═════════════════════════════════ */
describe("CEN — produtores do banco: um porteiro de INSERT em event_log, sem supressor temporal", () => {
  it("CEN-1 event_log não tem mais o supressor temporal; tem o porteiro do cutover", async () => {
    const { rows } = await pool.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid='public.event_log'::regclass and not tgisinternal and tgname like 'trg_green%'
        order by 1`,
    );
    const nomes = rows.map((r) => r.tgname);
    relatorio.push({ caso: "CEN-1", triggers_green_em_event_log: nomes });
    expect(nomes).not.toContain("trg_green_suppress_legacy_stage_changed");
    expect(nomes).toContain("trg_green_event_log_gate");
    expect(nomes).toContain("trg_green_canonical_immutable");
    expect(nomes).toContain("trg_green_stamp_scheduler_trigger");
  });

  it("CEN-2 o código morto do supressor e da v2 saiu (função do supressor e os hooks órfãos da 0501)", async () => {
    const { rows } = await pool.query<{ f: string }>(
      `select p.proname f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='green' and p.proname in
          ('fn_suppress_legacy_stage_changed','fn_guard_crm_lead_stage','fn_emit_crm_lead_stage_changed')`,
    );
    relatorio.push({ caso: "CEN-2", funcoes_mortas_presentes: rows.map((r) => r.f) });
    expect(rows).toHaveLength(0);
  });

  it("CEN-3 crm_leads: os produtores de fato no banco são a fronteira Green e o gatilho legado de status/dono (intocado)", async () => {
    const { rows } = await pool.query<{ tgname: string; f: string }>(
      `select t.tgname, p.proname f from pg_trigger t join pg_proc p on p.oid=t.tgfoid
        where t.tgrelid='public.crm_leads'::regclass and not t.tgisinternal
          and pg_get_functiondef(p.oid) ~ '(emit_event|fn_log_event)\\('
        order by 1`,
    );
    relatorio.push({ caso: "CEN-3", produtores_em_crm_leads: rows });
    expect(rows.map((r) => r.tgname)).toEqual([
      "trg_emit_event_on_lead_change",
      "trg_green_crm_lead_boundary",
    ]);
  });
});

/* ═══ MAT — matriz por ação (lead Green): o que cada caminho produz ════════ */
describe("MAT — cada ação sobre lead Green produz exatamente um fato de etapa", () => {
  it("MAT-1 Kanban (sessão): UPDATE + gêmeo no mesmo escopo → 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    const id = await gemeo(e, t.org, lead, de, t.green.e2, {
      request_id: e.quem.contexto!.request_id,
      actor_user_id: t.admin,
    });
    const l = await linha("MAT-1 Kanban", lead, { gemeo_gravado: id !== null });
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-2 lote (sessão, `fn_mover_leads_em_lote`): N canônicos, 0 legado", async () => {
    const t = await tenant();
    const leads = [
      await novoLead(t, t.green, t.green.e1),
      await novoLead(t, t.green, t.green.e1),
      await novoLead(t, t.green, t.green.e2),
    ];
    const e = humano(t.admin);
    const { rows } = await request<{ lead_id: string; from_stage_id: string }>(
      no(e),
      "select lead_id, from_stage_id from public.fn_mover_leads_em_lote($1,$2::uuid[],$3,null)",
      [t.org, leads, t.green.e3],
    );
    for (const r of rows) {
      await legado(
        no(e),
        t.org,
        r.lead_id,
        { pipeline_id: t.green.id, from_stage_id: r.from_stage_id, to_stage_id: t.green.e3 },
        {
          request_id: e.quem.contexto!.request_id,
          actor_user_id: t.admin,
        },
      );
    }
    for (const lead of leads) {
      const l = await linha("MAT-2 lote", lead);
      expect(l.canonicos).toBe(1);
      expect(l.legados).toBe(0);
    }
  });

  it("MAT-3 MCP (`moveLeadHandler` real): 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    await viaMcp(() =>
      moveLeadHandler(admin(), ctxDeHandler(t, `mcp-${randomUUID()}`), lead, {
        to_stage_id: t.green.e2,
      }),
    );
    const l = await linha("MAT-3 MCP moveLeadHandler", lead);
    expect(await etapaDe(lead)).toBe(t.green.e2);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-4 agente (`sincronizaEstagioDoAgente` real, job): 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await viaJob(() =>
      sincronizaEstagioDoAgente(admin(), {
        organizationId: t.org,
        contactId: t.contato,
        passo: "qualifying",
      }),
    );
    const l = await linha("MAT-4 agente", lead, { resultado: r });
    expect(r.moveu).toBe(true);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-5 handoff (`moverLeadParaEtapaDeHandoff` real, handler): 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await viaHandler(randomUUID(), () =>
      moverLeadParaEtapaDeHandoff(admin(), {
        organizationId: t.org,
        leadId: lead,
        reason: "customer_request",
      }),
    );
    const l = await linha("MAT-5 handoff", lead, { resultado: r });
    expect(r.moveu).toBe(true);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-6 agenda por MCP (`moverLeadParaEtapaDeAgendamento` real, admin): 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await viaMcp(() =>
      moverLeadParaEtapaDeAgendamento(admin(), {
        organizationId: t.org,
        leadId: lead,
        transicao: "confirmed",
      }),
    );
    const l = await linha("MAT-6 agenda", lead, { resultado: r });
    expect(r.moveu).toBe(true);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-7 ganhar (`encerraDemanda` real): 1 canônico de etapa + `lead.won` do gatilho de status; nenhum legado de etapa", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e2, t.contato);
    await viaMcp(() =>
      encerraDemanda(admin(), ctxDeHandler(t, `mcp-${randomUUID()}`), {
        leadId: lead,
        desfecho: "won",
        motivo: "fechou",
      }),
    );
    const l = await linha("MAT-7 ganhar", lead);
    const fs = await fatos(lead);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
    expect(fs.filter((f) => f.event_type === "lead.won")).toHaveLength(1);
  });

  it("MAT-8 perder (`encerraDemanda` real): 1 canônico de etapa + `lead.lost`; nenhum legado de etapa", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e2, t.contato);
    await viaMcp(() =>
      encerraDemanda(admin(), ctxDeHandler(t, `mcp-${randomUUID()}`), {
        leadId: lead,
        desfecho: "lost",
        motivo: "price",
      }),
    );
    const l = await linha("MAT-8 perder", lead);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
    expect((await fatos(lead)).filter((f) => f.event_type === "lead.lost")).toHaveLength(1);
  });

  it("MAT-9 automação por evento (regra em `lead.stage_changed`): 1 execução, 1 canônico da regra, gêmeo do handler não vira fato, anti-loop", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await regra(t, "lead.stage_changed", t.green.e3, t.green, [
      { field: "event.to_stage_id", op: "eq", value: t.green.e2 },
    ]);
    const e = humano(t.admin);
    await mover(e, lead, t.green.e2);
    const [humanoCanonico] = await canonicos(lead);
    await drenar(humanoCanonico!.id);
    const runs = await runsDe(humanoCanonico!.id);
    const todos = await canonicos(lead);
    expect(await etapaDe(lead)).toBe(t.green.e3);
    expect(runs.map((x) => x.status)).toEqual(["success"]);
    expect(todos).toHaveLength(2);
    // o canônico da regra volta ao motor e é pulado (anti-loop)
    const daRegra = todos[1]!;
    expect(daRegra.metadata.green?.trusted).toMatchObject({
      source: "automation",
      request_id: `rule:${r}`,
      causation_event_id: humanoCanonico!.id,
    });
    const res = await drenar(daRegra.id);
    expect(res.find((x) => x.consumer_key === "automation-rules")?.status).toBe("skipped");
    expect(await runsDe(daRegra.id)).toHaveLength(0);
    const l = await linha("MAT-9 automação por evento", lead, { runs: runs.length });
    expect(l.legados).toBe(0);
  });

  it("MAT-10 automação por tempo (`lead.stage_stale` do relógio): 1 execução, 1 canônico, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await regra(t, "lead.stage_stale", t.green.e2, t.green);
    const ev = await clientePostgrest(pool, { papel: "service_role" }).rpc("emit_event", {
      p_event_type: "lead.stage_stale",
      p_entity_kind: "crm_lead",
      p_entity_id: lead,
      p_payload: {
        rule_id: r,
        dias: 3,
        ancora: "2026-09-01T00:00:00.000Z",
        etapa_desde: "2026-09-01T00:00:00.000Z",
      },
      p_metadata: { actor_kind: "system", source: "cron/lead-time-triggers" },
      p_organization_id: t.org,
    });
    expect(ev.error).toBeNull();
    await drenar(ev.data as string);
    const runs = await runsDe(ev.data as string);
    const l = await linha("MAT-10 automação por tempo", lead, { runs: runs.length });
    expect(runs.map((x) => x.status)).toEqual(["success"]);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("MAT-11 transferência pela automação (Green → comum): origem fecha com 1 canônico + `lead.lost`; o clone nasce com 1 `lead.created`", async () => {
    const t = await tenant();
    const origem = await novoLead(t, t.green, t.green.e1, t.contato);
    // gatilho de CONTATO: é o caminho em que `create_or_move_lead` transfere (clona + encerra)
    await regra(t, "contact.birthday", t.comum.e2, t.comum);
    const ev = await clientePostgrest(pool, { papel: "service_role" }).rpc("emit_event", {
      p_event_type: "contact.birthday",
      p_entity_kind: "contact",
      p_entity_id: t.contato,
      p_payload: { local_date: "2026-10-03" },
      p_metadata: { actor_kind: "system", source: "cron/contact-birthdays" },
      p_organization_id: t.org,
    });
    expect(ev.error).toBeNull();
    await drenar(ev.data as string);
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_leads where organization_id=$1 and contact_id=$2 and pipeline_id=$3",
      [t.org, t.contato, t.comum.id],
    );
    const l = await linha("MAT-11 transferência", origem, { clone: rows[0]?.id ?? null });
    expect(await etapaDe(origem)).toBe(t.green.perda);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
    expect((await fatos(origem)).filter((f) => f.event_type === "lead.lost")).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect((await fatos(rows[0]!.id)).filter((f) => f.event_type === "lead.created")).toHaveLength(
      1,
    );
  });

  it("MAT-12 arquivar etapa com destino (UPDATE em massa, writer sem emissão): 1 canônico por card, 0 legado", async () => {
    const t = await tenant();
    const leads = [await novoLead(t, t.green, t.green.e1), await novoLead(t, t.green, t.green.e1)];
    const e = humano(t.admin);
    await request(
      no(e),
      "update crm_leads set stage_id=$2 where organization_id=$1 and stage_id=$3",
      [t.org, t.green.e2, t.green.e1],
    );
    for (const lead of leads) {
      const l = await linha("MAT-12 arquivar etapa", lead);
      expect(l.canonicos).toBe(1);
      expect(l.legados).toBe(0);
    }
  });

  it("MAT-13 PostgREST direto (PATCH de sessão, sem escopo, sem emissão): 1 canônico", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    await request(
      { papel: "authenticated", sub: t.agente },
      "update crm_leads set stage_id=$2 where id=$1",
      [lead, t.green.e2],
    );
    const l = await linha("MAT-13 PostgREST direto", lead);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });
});

/* ═══ SUP — ataques ao supressor (S1-S14) ═══════════════════════════════════ */
describe("SUP — o gêmeo é reconhecido por chave forte; nada legítimo é engolido", () => {
  it("S1 legado verdadeiro com a MESMA transição de uma canônica recente, que NÃO é o gêmeo, passa", async () => {
    // L Green: PATCH direto e1→e2 (canônico sem gêmeo) e de volta e2→e1 (idem); o binding sai
    // (funil comum); o Kanban move e1→e2 num funil já comum: o legado desse movimento é FATO.
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const direto: Request = { papel: "authenticated", sub: t.agente };
    await mover(direto, lead, t.green.e2);
    await mover(direto, lead, t.green.e1);
    await comoDono(
      "delete from green.product_pipeline_binding where organization_id=$1 and pipeline_id=$2",
      [t.org, t.green.id],
    );
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    const id = await gemeo(e, t.org, lead, de, t.green.e2, {
      request_id: e.quem.contexto!.request_id,
    });
    const l = await linha("S1 legado verdadeiro, mesma transição", lead, {
      legado_gravado: id !== null,
    });
    expect(id, "o fato do movimento comum foi engolido").not.toBeNull();
    expect(l.canonicos).toBe(2);
    expect(l.legados).toBe(1);
  });

  it("S2 mesma transição repetida dentro da janela, gêmeos fora de ordem: 3 canônicos, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const [k1, k2, k3] = [humano(t.admin), humano(t.admin), humano(t.admin)];
    await mover(k1, lead, t.green.e2);
    await mover(k2, lead, t.green.e1);
    await mover(k3, lead, t.green.e2);
    await gemeo(k3, t.org, lead, t.green.e1, t.green.e2);
    await gemeo(k1, t.org, lead, t.green.e1, t.green.e2);
    await gemeo(k2, t.org, lead, t.green.e2, t.green.e1);
    const l = await linha("S2 mesma transição repetida", lead);
    expect(l.canonicos).toBe(3);
    expect(l.legados).toBe(0);
  });

  it("S3 gêmeo atrasado (além de qualquer janela) não vira segundo fato", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    await pool.query(
      "update green.stage_event_ledger set created_at = now() - interval '2 hours' where lead_id=$1",
      [lead],
    );
    const id = await gemeo(e, t.org, lead, de, t.green.e2);
    const l = await linha("S3 gêmeo atrasado", lead, { gemeo_gravado: id !== null });
    expect(id, "o gêmeo atrasado virou fato").toBeNull();
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("S4 writer sem gêmeo (PATCH direto, encerramento) não arma armadilha: o porteiro não guarda estado entre escopos", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    await mover({ papel: "authenticated", sub: t.agente }, lead, t.green.e2); // canônico sem gêmeo
    // um legado de OUTRO escopo com a mesma transição é julgado pelo que ELE é, nunca casado com a
    // linha sem gêmeo de outra execução (o escopo afirma ter feito a mutação: contrato do writer)
    const outro = servico();
    const id = await legado(no(outro), t.org, lead, {
      from_stage_id: t.green.e1,
      to_stage_id: t.green.e2,
    });
    const l = await linha("S4 writer sem gêmeo", lead, { legado_gravado: id !== null });
    expect(id, "o evento de outro escopo foi engolido pela linha sem gêmeo").not.toBeNull();
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(1);
  });

  it("S5 dois writers concorrentes com leitura velha da origem: 2 canônicos, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const [w1, w2] = [servico(), servico()];
    // os dois leram e1; w1 move para e2, w2 (depois) para e3 — o gêmeo de w2 diz "de e1"
    await mover(w1, lead, t.green.e2);
    await mover(w2, lead, t.green.e3);
    await Promise.all([
      gemeo(w1, t.org, lead, t.green.e1, t.green.e2),
      gemeo(w2, t.org, lead, t.green.e1, t.green.e3),
    ]);
    const l = await linha("S5 writers concorrentes", lead);
    expect(l.canonicos).toBe(2);
    expect(l.legados).toBe(0);
  });

  it("S6 mesmo request_id em execuções diferentes não troca nem engole gêmeos", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const rid = `rule:${randomUUID()}`;
    const [k1, k2] = [servico({ request_id: rid }), servico({ request_id: rid })];
    await mover(k1, lead, t.green.e2);
    await mover(humano(t.admin), lead, t.green.e1);
    await mover(k2, lead, t.green.e2);
    await gemeo(k2, t.org, lead, t.green.e1, t.green.e2, { request_id: rid });
    await gemeo(k1, t.org, lead, t.green.e1, t.green.e2, { request_id: rid });
    const l = await linha("S6 mesmo request_id", lead);
    expect(l.canonicos).toBe(3);
    expect(l.legados).toBe(0);
  });

  it("S7 request_id diferente no gêmeo (writer que não manda request_id ou manda outro) continua reconhecido", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const k = servico();
    await mover(k, lead, t.green.e2);
    const id = await gemeo(k, t.org, lead, t.green.e1, t.green.e2, {
      request_id: "outro-id",
      source: "agent-stage-sync",
    });
    const l = await linha("S7 request_id diferente", lead);
    expect(id).toBeNull();
    expect(l.legados).toBe(0);
  });

  it("S8 replay do gêmeo (o writer reenviou): nenhum vira fato, nem em série nem em paralelo", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    const serie = [
      await gemeo(e, t.org, lead, de, t.green.e2),
      await gemeo(e, t.org, lead, de, t.green.e2),
    ];
    const paralelo = await Promise.all([
      gemeo(e, t.org, lead, de, t.green.e2),
      gemeo(e, t.org, lead, de, t.green.e2),
      gemeo(e, t.org, lead, de, t.green.e2),
    ]);
    const l = await linha("S8 replay do gêmeo", lead, {
      gravados: [...serie, ...paralelo].filter(Boolean).length,
    });
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });

  it("S9 reordenação na mesma etapa de lead Green não é fato de etapa (decisão GREEN-03)", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    await request(no(e), "update crm_leads set position_in_stage=42 where id=$1", [lead]);
    const id = await legado(no(e), t.org, lead, {
      from_stage_id: t.green.e1,
      to_stage_id: t.green.e1,
      position_in_stage: 42,
    });
    const l = await linha("S9 reordenação Green", lead, { legado_gravado: id !== null });
    expect(l.canonicos).toBe(0);
    expect(l.legados).toBe(0);
  });

  it("S10 mutação comum junto de mutação Green (mesmo escopo e escopos vizinhos): o comum passa, o Green é um só", async () => {
    const t = await tenant();
    const g = await novoLead(t, t.green, t.green.e1);
    const c = await novoLead(t, t.comum, t.comum.e1);
    const e = servico();
    await mover(e, g, t.green.e2);
    await mover(e, c, t.comum.e2);
    const [ig, ic] = await Promise.all([
      gemeo(e, t.org, g, t.green.e1, t.green.e2),
      gemeo(e, t.org, c, t.comum.e1, t.comum.e2),
    ]);
    const lg = await linha("S10 Green", g);
    const lc = await linha("S10 comum", c);
    expect(ig).toBeNull();
    expect(ic).not.toBeNull();
    expect(lg.canonicos + lg.legados).toBe(1);
    expect(lc.canonicos).toBe(0);
    expect(lc.legados).toBe(1);
  });

  it("S11 `lead.stage_changed` de lead Green sem escopo do servidor não nasce (não é relato de mutação)", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const forjado = await legado({ papel: "authenticated", sub: t.viewer }, t.org, lead, {
      from_stage_id: t.green.e1,
      to_stage_id: t.green.e3,
    });
    const doServico = await legado({ papel: "service_role" }, t.org, lead, {
      from_stage_id: t.green.e1,
      to_stage_id: t.green.e3,
    });
    relatorio.push({
      caso: "S11 sem escopo",
      sessao_gravou: forjado !== null,
      service_role_gravou: doServico !== null,
    });
    expect(forjado).toBeNull();
    expect(doServico).toBeNull();
    expect(await etapasMudadas(lead)).toHaveLength(0);
    // controle: o mesmo relato sem escopo para lead COMUM continua nascendo (upstream)
    const comum = await novoLead(t, t.comum, t.comum.e1);
    expect(
      await legado({ papel: "service_role" }, t.org, comum, {
        from_stage_id: t.comum.e1,
        to_stage_id: t.comum.e2,
      }),
    ).not.toBeNull();
  });

  it("S12 (gap AUTO-GAP-01, explícito) escopo inventado por sessão grava um legado de lead Green: o barramento segue aberto a forja", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const id = await legado(
      { papel: "authenticated", sub: t.viewer, escopo: randomUUID() },
      t.org,
      lead,
      { from_stage_id: t.green.e1, to_stage_id: t.green.e3 },
    );
    relatorio.push({ caso: "S12 escopo inventado", gravado: id !== null });
    expect(id).not.toBeNull();
    expect(await legados(lead)).toHaveLength(1);
  });

  it("S13 binding criado entre o movimento comum e o legado dele: o fato comum NÃO é perdido", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.comum, t.comum.e1);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.comum.e2);
    await comoDono(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, t.comum.id],
    );
    const id = await gemeo(e, t.org, lead, de, t.comum.e2);
    const l = await linha("S13 binding criado no meio", lead, { legado_gravado: id !== null });
    expect(id).not.toBeNull();
    expect(l.canonicos).toBe(0);
    expect(l.legados).toBe(1);
  });

  it("S14 binding removido entre o canônico e o gêmeo: o gêmeo continua não sendo fato", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    await comoDono(
      "delete from green.product_pipeline_binding where organization_id=$1 and pipeline_id=$2",
      [t.org, t.green.id],
    );
    const id = await gemeo(e, t.org, lead, de, t.green.e2);
    const l = await linha("S14 binding removido no meio", lead, { gemeo_gravado: id !== null });
    expect(id).toBeNull();
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
  });
});

/* ═══ COM — lead comum é controle ══════════════════════════════════════════ */
describe("COM — lead comum: upstream intacto", () => {
  it("COM-1 Kanban, lote, reordenação, sem escopo: o legado nasce com o payload/metadata do writer e nenhum canônico", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.comum, t.comum.e1);
    const e = humano(t.admin);
    await mover(e, lead, t.comum.e2);
    const meta = { request_id: e.quem.contexto!.request_id, actor_user_id: t.admin };
    await legado(
      no(e),
      t.org,
      lead,
      {
        from_stage_id: t.comum.e1,
        to_stage_id: t.comum.e2,
        position_in_stage: 1000,
        status: "open",
      },
      meta,
    );
    await legado(
      no(e),
      t.org,
      lead,
      { from_stage_id: t.comum.e2, to_stage_id: t.comum.e2, position_in_stage: 42 },
      meta,
    ); // reordenação
    await legado(
      { papel: "authenticated", sub: t.admin },
      t.org,
      lead,
      { from_stage_id: t.comum.e2, to_stage_id: t.comum.e3 },
      meta,
    ); // sem escopo
    const fs = await etapasMudadas(lead);
    relatorio.push({ caso: "COM-1", legados: fs.length });
    expect(fs).toHaveLength(3);
    expect(fs.every((f) => !f.canonico)).toBe(true);
    expect(fs[0]!.payload).toMatchObject({
      from_stage_id: t.comum.e1,
      to_stage_id: t.comum.e2,
      position_in_stage: 1000,
      status: "open",
    });
    expect(fs[0]!.metadata).toMatchObject(meta);
    expect(fs[0]!.metadata).not.toHaveProperty("green");
    expect(await livro(lead)).toHaveLength(0);
  });

  it("COM-2 writers privilegiados reais em lead comum: MCP, agente, handoff e agenda emitem o legado (1 cada)", async () => {
    const t = await tenant();
    const a = await novoLead(t, t.comum, t.comum.e1, t.contato2);
    await viaMcp(() =>
      moveLeadHandler(admin(), ctxDeHandler(t, `mcp-${randomUUID()}`), a, {
        to_stage_id: t.comum.e2,
      }),
    );
    const b = await novoLead(t, t.comum, t.comum.e1, t.contato);
    const rAg = await viaJob(() =>
      sincronizaEstagioDoAgente(admin(), {
        organizationId: t.org,
        contactId: t.contato,
        passo: "qualifying",
      }),
    );
    const rHo = await viaHandler(randomUUID(), () =>
      moverLeadParaEtapaDeHandoff(admin(), {
        organizationId: t.org,
        leadId: b,
        reason: "customer_request",
      }),
    );
    const rAp = await viaMcp(() =>
      moverLeadParaEtapaDeAgendamento(admin(), {
        organizationId: t.org,
        leadId: b,
        transicao: "confirmed",
      }),
    );
    relatorio.push({ caso: "COM-2", agente: rAg, handoff: rHo, agenda: rAp });
    expect([rAg.moveu, rHo.moveu, rAp.moveu]).toEqual([true, true, true]);
    expect(await legados(a)).toHaveLength(1);
    const lb = await legados(b);
    expect(lb.map((f) => f.metadata.source)).toEqual([
      "agent-stage-sync",
      "handoff-stage-move",
      "appointment-stage-move",
    ]);
    expect(await canonicos(a)).toHaveLength(0);
    expect(await canonicos(b)).toHaveLength(0);
  });

  it("COM-3 automação em lead comum: a regra roda uma vez sobre o legado e o legado do handler nasce (anti-loop pelo `rule:`)", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.comum, t.comum.e1, t.contato);
    await regra(t, "lead.stage_changed", t.comum.e3, t.comum, [
      { field: "event.to_stage_id", op: "eq", value: t.comum.e2 },
    ]);
    const e = humano(t.admin);
    await mover(e, lead, t.comum.e2);
    const id = await legado(
      no(e),
      t.org,
      lead,
      { from_stage_id: t.comum.e1, to_stage_id: t.comum.e2 },
      { request_id: "r-humano" },
    );
    await drenar(id!);
    expect(await etapaDe(lead)).toBe(t.comum.e3);
    const fs = await legados(lead);
    expect(fs).toHaveLength(2);
    expect(String(fs[1]!.metadata.request_id)).toMatch(/^rule:/);
    const res = await drenar(fs[1]!.id);
    expect(res.find((x) => x.consumer_key === "automation-rules")?.status).toBe("skipped");
    expect(await runsDe(id!)).toHaveLength(1);
  });
});

/* ═══ BIND — entrada e saída do domínio por binding ════════════════════════ */
describe("BIND — binding não finge mudança de etapa; entra e sai com auditoria estrutural", () => {
  async function auditoria(org: string) {
    const { rows } = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from api_audit_log where organization_id=$1 and action like 'green.binding_%' order by created_at, id",
      [org],
    );
    return rows;
  }

  async function identidades(leads: string[]) {
    const { rows } = await pool.query<{ lead_id: string; state: string; first_seen_at: Date }>(
      "select lead_id, state, first_seen_at from green.lead_identity where lead_id = any($1::uuid[]) order by lead_id",
      [leads],
    );
    return rows;
  }

  it("B1 binding novo sobre N leads: nenhum evento por lead, nenhuma automação; o registro é o binding + a identidade de cada lead (mesma transação)", async () => {
    const t = await tenant();
    const leads = [
      await novoLead(t, t.comum, t.comum.e1),
      await novoLead(t, t.comum, t.comum.e2),
      await novoLead(t, t.comum, t.comum.e2),
    ];
    await regra(t, "lead.stage_changed", t.comum.e3, t.comum);
    const antes = await pool.query<{ n: number }>(
      "select count(*)::int n from event_log where organization_id=$1",
      [t.org],
    );
    const c = await pool.connect();
    await c.query("begin");
    await c.query("select set_config('green.mutation_context', $1, true)", [CONTEXTO_DONO]);
    await c.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, t.comum.id],
    );
    const { rows: noBinding } = await c.query<{ agora: Date }>("select now() agora");
    await c.query("commit");
    c.release();
    const depois = await pool.query<{ n: number }>(
      "select count(*)::int n from event_log where organization_id=$1",
      [t.org],
    );
    const ids = await identidades(leads);
    relatorio.push({
      caso: "B1",
      eventos_novos: depois.rows[0]!.n - antes.rows[0]!.n,
      identidades: ids.length,
      auditoria: await auditoria(t.org),
    });
    expect(depois.rows[0]!.n).toBe(antes.rows[0]!.n);
    for (const lead of leads) expect(await fatos(lead)).toHaveLength(0);
    const { rows: runs } = await pool.query(
      "select 1 from automation_rule_runs r join automation_rules a on a.id=r.rule_id where a.organization_id=$1",
      [t.org],
    );
    expect(runs).toHaveLength(0);
    expect(ids).toHaveLength(3);
    expect(
      ids.every(
        (i) => i.state === "live" && i.first_seen_at.getTime() === noBinding[0]!.agora.getTime(),
      ),
    ).toBe(true);
  });

  it("B2 remoção do binding: nenhum evento por lead; `green.binding_removed` com `released_leads`; o próximo movimento é legado comum", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    await comoDono(
      "delete from green.product_pipeline_binding where organization_id=$1 and pipeline_id=$2",
      [t.org, t.green.id],
    );
    const a = await auditoria(t.org);
    expect(await fatos(lead)).toHaveLength(0);
    expect(a.filter((x) => x.action === "green.binding_removed")[0]!.metadata).toMatchObject({
      released_leads: 1,
      operation: "delete",
    });
    const e = humano(t.admin);
    await mover(e, lead, t.green.e2);
    await gemeo(e, t.org, lead, t.green.e1, t.green.e2);
    expect(await canonicos(lead)).toHaveLength(0);
    expect(await legados(lead)).toHaveLength(1);
  });

  it("B3 re-apontamento: nenhum evento por lead; `binding_removed` diz de onde saiu e para onde foi; quem entra ganha identidade", async () => {
    const t = await tenant();
    const velho = await novoLead(t, t.green, t.green.e1);
    const novo = await novoLead(t, t.comum, t.comum.e1);
    await comoDono(
      "update green.product_pipeline_binding set pipeline_id=$3 where organization_id=$1 and pipeline_id=$2",
      [t.org, t.green.id, t.comum.id],
    );
    const a = await auditoria(t.org);
    relatorio.push({ caso: "B3", auditoria: a });
    expect(await fatos(velho)).toHaveLength(0);
    expect(await fatos(novo)).toHaveLength(0);
    expect(a.find((x) => x.action === "green.binding_removed")?.metadata).toMatchObject({
      released_leads: 1,
      operation: "update",
      pipeline_id: t.green.id,
      new_pipeline_id: t.comum.id,
    });
    expect((await identidades([novo])).map((i) => i.state)).toEqual(["live"]);
  });

  it("B4 depois de entrar por binding, o primeiro movimento é canônico `stay` (o lead já estava no domínio) e o gêmeo não vira fato", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.comum, t.comum.e1);
    await comoDono(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, t.comum.id],
    );
    const e = humano(t.admin);
    const de = await mover(e, lead, t.comum.e2);
    await gemeo(e, t.org, lead, de, t.comum.e2);
    const c = await canonicos(lead);
    expect(c).toHaveLength(1);
    expect(c[0]!.payload.green_transition).toBe("stay");
    expect(await legados(lead)).toHaveLength(0);
  });
});

/* ═══ CRE / DEL — lead.created e lead.deleted ══════════════════════════════ */
describe("CRE/DEL — `lead.created` tem um dono (o writer); `lead.deleted` é registro", () => {
  it("CRE-1 nascimento Green pelo writer real: um `lead.created` (writer), proveniência no banco, nenhum canônico de criação", async () => {
    const t = await tenant();
    const { createLeadHandler } = await import("@/app/api/v1/leads/_handler");
    const criado = (await viaMcp(() =>
      createLeadHandler(admin(), ctxDeHandler(t, `mcp-${randomUUID()}`), {
        title: "Nasce Green",
        pipeline_id: t.green.id,
        stage_id: t.green.e1,
        contact_id: t.contato,
        source: "automation",
      } as never),
    )) as { id: string };
    const fs = await fatos(criado.id);
    relatorio.push({
      caso: "CRE-1",
      fatos: fs.map((f) => `${f.event_type}${f.canonico ? "[canônico]" : ""}`),
    });
    expect(fs.filter((f) => f.event_type === "lead.created")).toHaveLength(1);
    expect(fs.filter((f) => f.canonico)).toHaveLength(0);
    const prov = await pool.query("select 1 from green.lead_birth_provenance where lead_id=$1", [
      criado.id,
    ]);
    expect(prov.rowCount).toBe(1);
  });

  it("DEL-1 exclusão de lead Green: uma lápide canônica, nascida `done`, sem consumidor", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    await request({ papel: "authenticated", sub: t.admin }, "delete from crm_leads where id=$1", [
      lead,
    ]);
    const fs = await fatos(lead);
    expect(fs.map((f) => `${f.event_type}:${f.status}:${f.canonico}`)).toEqual([
      "lead.deleted:done:true",
    ]);
    expect(fs[0]!.consumed_by).toEqual([]);
  });
});

/* ═══ AUT — automação recebe o fato uma vez ═════════════════════════════════ */
describe("AUT — automação: uma execução por fato, mesmo com gêmeo atrasado ou repetido", () => {
  it("AUT-1 gêmeo atrasado/repetido de uma mutação Green não dispara a regra de novo", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1, t.contato);
    const r = await regra(t, "lead.stage_changed", t.green.e3, t.green, [
      { field: "event.to_stage_id", op: "eq", value: t.green.e2 },
    ]);
    const e = humano(t.admin);
    const de = await mover(e, lead, t.green.e2);
    await pool.query(
      "update green.stage_event_ledger set created_at = now() - interval '2 hours' where lead_id=$1",
      [lead],
    );
    const g1 = await gemeo(e, t.org, lead, de, t.green.e2);
    const g2 = await gemeo(e, t.org, lead, de, t.green.e2);
    for (const id of [g1, g2]) if (id) await drenar(id);
    const [c] = await canonicos(lead);
    await drenar(c!.id);
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int n from automation_rule_runs where rule_id=$1 and status='success'",
      [r],
    );
    relatorio.push({
      caso: "AUT-1",
      gemeos_gravados: [g1, g2].filter(Boolean).length,
      execucoes: rows[0]!.n,
    });
    expect(rows[0]!.n).toBe(1);
  });
});

/* ═══ ORD — ordem: mutação → canônico → commit → (gêmeo recusado) → drain ═══ */
describe("ORD — o consumidor nunca vê fato de estado que não comitou", () => {
  it("ORD-1 antes do commit o canônico não é visível; no rollback somem estado, fato e livro-razão", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const c = await requestAberta(no(e));
    await c.query("update crm_leads set stage_id=$2 where id=$1", [lead, t.green.e2]);
    const dentro = await c.query(
      "select count(*)::int n from event_log where entity_id=$1 and event_type='lead.stage_changed'",
      [lead],
    );
    const fora = await pool.query(
      "select count(*)::int n from event_log where entity_id=$1 and event_type='lead.stage_changed'",
      [lead],
    );
    await c.query("rollback");
    c.release();
    relatorio.push({
      caso: "ORD-1",
      dentro: dentro.rows[0].n,
      fora_antes_do_commit: fora.rows[0].n,
    });
    expect(dentro.rows[0].n).toBe(1);
    expect(fora.rows[0].n).toBe(0);
    expect(await etapaDe(lead)).toBe(t.green.e1);
    expect(await fatos(lead)).toHaveLength(0);
    expect(await livro(lead)).toHaveLength(0);
    // o writer real não emite depois de um UPDATE que falhou (lança antes); depois do commit, o
    // gêmeo chega numa transação própria e encontra o canônico já comitado
    const c2 = await requestAberta(no(e));
    await c2.query("update crm_leads set stage_id=$2 where id=$1", [lead, t.green.e2]);
    await c2.query("commit");
    c2.release();
    expect(await gemeo(e, t.org, lead, t.green.e1, t.green.e2)).toBeNull();
    expect((await fatos(lead)).map((f) => f.canonico)).toEqual([true]);
  });

  it("ORD-2 contrato de confiança: o porteiro acredita no escopo do servidor — um legado de escopo sem mutação dele grava (writer não faz isso; forja = AUTO-GAP-01)", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = humano(t.admin);
    const c = await requestAberta(no(e));
    await c.query("update crm_leads set stage_id=$2 where id=$1", [lead, t.green.e2]);
    await c.query("rollback");
    c.release();
    const g = await gemeo(e, t.org, lead, t.green.e1, t.green.e2);
    relatorio.push({ caso: "ORD-2 escopo sem mutação", gravado: g !== null });
    expect(g).not.toBeNull();
    expect(await canonicos(lead)).toHaveLength(0);
  });
});

/* ═══ CON — concorrência: 0 se rollback, 1 se commit, nunca 2 ═══════════════ */
describe("CON — concorrência não duplica fatos", () => {
  it("CON-1 A→B→C rápido no mesmo escopo, gêmeos em paralelo: 2 canônicos, 0 legado", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const e = servico();
    await mover(e, lead, t.green.e2);
    await mover(e, lead, t.green.e3);
    await Promise.all([
      gemeo(e, t.org, lead, t.green.e1, t.green.e2),
      gemeo(e, t.org, lead, t.green.e2, t.green.e3),
    ]);
    const l = await linha("CON-1 A→B→C", lead);
    expect(l.canonicos).toBe(2);
    expect(l.legados).toBe(0);
  });

  it("CON-2 16 requisições concorrentes (humano, MCP, regra) em 8 leads, com gêmeos e replays: 1 fato por mutação comitada", async () => {
    const t = await tenant();
    const leads = await Promise.all(
      Array.from({ length: 8 }, () => novoLead(t, t.green, t.green.e1)),
    );
    const fluxos = leads.flatMap((lead, i) => {
      const a = i % 2 ? humano(t.admin) : servico();
      const b =
        i % 3
          ? servico({ source: "automation", request_id: `rule:${randomUUID()}` })
          : humano(t.agente);
      return [
        (async () => {
          await mover(a, lead, t.green.e2);
          await gemeo(a, t.org, lead, t.green.e1, t.green.e2);
          await gemeo(a, t.org, lead, t.green.e1, t.green.e2);
        })(),
        (async () => {
          await mover(b, lead, t.green.e3);
          await gemeo(b, t.org, lead, t.green.e1, t.green.e3);
        })(),
      ];
    });
    await Promise.all(fluxos);
    const totais = [];
    for (const lead of leads) {
      const l = await linha("CON-2", lead);
      totais.push(l);
      // as duas mutações comitaram, mas uma pode não ter mudado nada (o lead já estava na etapa)
      const mudancas = (await livro(lead)).length;
      expect(l.canonicos).toBe(mudancas);
      expect(l.legados).toBe(0);
    }
  });

  it("CON-3 mutação humana concorrente com a da regra no mesmo lead, uma desfeita: o fato da desfeita não existe", async () => {
    const t = await tenant();
    const lead = await novoLead(t, t.green, t.green.e1);
    const h = humano(t.admin);
    const r = servico({ source: "automation", request_id: `rule:${randomUUID()}` });
    const ch = await requestAberta(no(h));
    await ch.query("update crm_leads set stage_id=$2 where id=$1", [lead, t.green.e2]);
    const regraEmVoo = mover(r, lead, t.green.e3); // espera o lock do humano
    await ch.query("rollback");
    ch.release();
    await regraEmVoo;
    // o writer humano falhou (rollback) e não emite; a regra comitou e emite o gêmeo dela
    await gemeo(r, t.org, lead, t.green.e1, t.green.e3);
    const l = await linha("CON-3 rollback concorrente", lead);
    expect(l.canonicos).toBe(1);
    expect(l.legados).toBe(0);
    expect(await etapaDe(lead)).toBe(t.green.e3);
  });
});

/* ═══ UPG — migração 0508 (por último: altera o schema deste banco) ════════ */
const DIR_MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const arquivoDa = (n: string) => readdirSync(DIR_MIGRATIONS).find((f) => f.includes(`_${n}_`));

describe("UPG — a 0508 é idempotente e sobe de um banco 0507 com dados", () => {
  it("U1 a migration existe, está no MANIFEST e no apêndice do baseline (antes da VARREDURA anon)", () => {
    const f = arquivoDa("0508");
    expect(f, "migration 0508 ausente").toBeTruthy();
    const manifest = readFileSync(join(DIR_MIGRATIONS, "MANIFEST.md"), "utf8");
    expect(manifest).toContain(
      f!
        .replace(/\.sql$/, "")
        .split("_")
        .slice(1)
        .join("_"),
    );
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const apendice = baseline.indexOf("(migration 0508)");
    expect(apendice).toBeGreaterThan(0);
    expect(apendice).toBeLessThan(baseline.indexOf("-- ---- VARREDURA anon"));
  });

  it("U2 rebaixado à 0507 (supressor de volta, sem escopo no livro) e com twins em voo, a 0508 sobe duas vezes sem mudar dado", async () => {
    const f = arquivoDa("0508");
    expect(f, "migration 0508 ausente").toBeTruthy();
    const sql0508 = readFileSync(join(DIR_MIGRATIONS, f!), "utf8");
    // 1) rebaixa: a cadeia 0501-0507 reaplicada recoloca o supressor e a fronteira da 0506; os
    //    objetos da 0508 saem à mão (é o banco que o deploy encontra)
    for (const n of ["0501", "0502", "0503", "0504", "0505", "0506", "0507"]) {
      await pool.query(readFileSync(join(DIR_MIGRATIONS, arquivoDa(n)!), "utf8"));
    }
    await pool.query(`
      drop trigger if exists trg_green_event_log_gate on public.event_log;
      drop function if exists green.fn_event_log_gate();
      drop index if exists green.stage_event_ledger_scope_idx;
      alter table green.stage_event_ledger drop column if exists scope_id;
      drop function if exists green.fn_request_scope();`);
    const no0507 = await pool.query<{ t: string }>(
      "select tgname t from pg_trigger where tgrelid='public.event_log'::regclass and tgname like 'trg_green%' order by 1",
    );
    expect(no0507.rows.map((r) => r.t)).toContain("trg_green_suppress_legacy_stage_changed");

    // 2) dados de 0507: mutação Green com gêmeo ainda em voo, comum, lápide
    const t = await tenant();
    const verde = await novoLead(t, t.green, t.green.e1);
    const comum = await novoLead(t, t.comum, t.comum.e1);
    const apagado = await novoLead(t, t.green, t.green.e2);
    await mover({ papel: "authenticated", sub: t.admin }, verde, t.green.e2);
    await mover({ papel: "authenticated", sub: t.admin }, comum, t.comum.e2);
    await request({ papel: "authenticated", sub: t.admin }, "delete from crm_leads where id=$1", [
      apagado,
    ]);
    const foto = async () =>
      (
        await pool.query<{ e: string; l: string; c: string }>(
          `select md5(coalesce(string_agg(to_jsonb(e)::text, ',' order by e.id), '')) e,
                  (select md5(coalesce(string_agg((to_jsonb(l) - 'scope_id')::text, ',' order by l.id), '')) from green.stage_event_ledger l) l,
                  (select md5(coalesce(string_agg(to_jsonb(c)::text, ',' order by c.id), '')) from crm_leads c where c.organization_id=$1) c
             from event_log e where e.organization_id=$1`,
          [t.org],
        )
      ).rows[0]!;
    const antes = await foto();

    // 3) a 0508, duas vezes
    await pool.query(sql0508);
    await pool.query(sql0508);
    expect(await foto()).toEqual(antes);
    const depois = await pool.query<{ t: string }>(
      "select tgname t from pg_trigger where tgrelid='public.event_log'::regclass and tgname like 'trg_green%' order by 1",
    );
    expect(depois.rows.map((r) => r.t)).toEqual([
      "trg_green_canonical_immutable",
      "trg_green_event_log_gate",
      "trg_green_stamp_scheduler_trigger",
    ]);

    // 4) o gêmeo em voo da mutação de antes do deploy: escritor antigo (sem escopo) não nasce,
    //    nunca duplica; o fluxo novo depois do deploy funciona
    const velho = await legado({ papel: "authenticated", sub: t.admin }, t.org, verde, {
      from_stage_id: t.green.e1,
      to_stage_id: t.green.e2,
    });
    expect(velho).toBeNull();
    const e = humano(t.admin);
    const de = await mover(e, verde, t.green.e3);
    expect(await gemeo(e, t.org, verde, de, t.green.e3)).toBeNull();
    expect(await canonicos(verde)).toHaveLength(2);
    expect(await legados(verde)).toHaveLength(0);
    relatorio.push({
      caso: "U2",
      triggers_0507: no0507.rows.map((r) => r.t),
      triggers_0508: depois.rows.map((r) => r.t),
    });
  });
});
