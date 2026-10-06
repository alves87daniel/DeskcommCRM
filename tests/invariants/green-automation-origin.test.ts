/**
 * SPIKE-GREEN-AUTO-01 — Automation Origin & Green Opportunity Triggers (DESCARTÁVEL).
 *
 * Contrato de proveniência de uma automação que escreve numa Opportunity Green.
 * Cada caso descreve o CONTRATO; rodado contra a base (lifecycle v1.3,
 * `b4ccb48f`), os casos que representam o defeito LIFE-ADV-01 falham pelo
 * motivo do defeito — a matriz RED está em `docs/spike/GREEN-AUTOMATION-ORIGIN-V1.md`.
 * Por isso o arquivo não depende de tabela ou função que só exista na spike: o
 * que é novo é lido por `to_regclass`/`to_regprocedure`, e a diferença aparece
 * na asserção, não num "does not exist".
 *
 * O caminho exercitado é o de produção, sem mock no ponto investigado:
 *
 *   emissor do gatilho (cron/rota/trigger, pelo papel real) → event_log
 *   → claim (`processing`, como o drain) → `dispatchEvent` (raiz de sistema)
 *   → `runAutomationForEvent` → `create_or_move_lead` → `moveLeadHandler` /
 *   `createLeadHandler` → dublê PostgREST (papel `service_role`, header Green
 *   tirado do escopo ALS corrente) → `green.fn_crm_lead_boundary` → event_log
 *
 * O dublê (`green-postgrest-shim.ts`) executa cada chamada como o PostgREST a
 * executa (papel, claims, headers); o teste não injeta contexto no código: quem
 * o declara é o seam do motor.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientePostgrest, type Identidade } from "./green-postgrest-shim";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchEvent, registerHandler, type EventRow } from "@/lib/event-log/dispatcher";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { ENTIDADE_ESPERADA_POR_GATILHO, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
const admin = () => clientePostgrest(pool, { papel: "service_role" });

beforeAll(() => {
  vi.mocked(createAdminClient).mockImplementation(admin);
  registerHandler(automationRulesHandler);
});

/** Linhas da matriz (RED/GREEN/censo), gravadas em arquivo se `GREEN_AUTO_DIAG_OUT` existir. */
const relatorio: Array<Record<string, unknown>> = [];
afterAll(async () => {
  if (process.env.GREEN_AUTO_DIAG_OUT) {
    writeFileSync(process.env.GREEN_AUTO_DIAG_OUT, JSON.stringify(relatorio, null, 2));
  }
  await pool.end();
});

/* ── request no formato do PostgREST (mesmo harness das suítes Green) ───────── */
interface Request {
  papel: Identidade["papel"];
  sub?: string;
  contexto?: Record<string, unknown>;
}
const b64 = (ctx: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(ctx), "utf8").toString("base64");

async function request<T extends pg.QueryResultRow = pg.QueryResultRow>(
  r: Request,
  sql: string,
  args: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const c = await pool.connect();
  try {
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
    await c.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
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

/** Escrita do DONO (fixture), com o contexto Green pelo GUC de conexão direta. */
async function comoDono(sql: string, args: unknown[] = []): Promise<pg.QueryResult> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
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

async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as pg.DatabaseError;
  }
}
const veredito = (e: pg.DatabaseError | null) => (e ? `${e.code} ${e.message}` : "ACEITO");

/* ── fixtures ─────────────────────────────────────────────────────────────── */
interface Tenant {
  org: string;
  admin: string;
  viewer: string;
  sessaoCanal: string;
  contato: string;
  contato2: string;
  conversa: string;
  funilGreen: string;
  etapaG1: string;
  etapaG2: string;
  etapaG3: string;
  funilComum: string;
  etapaC1: string;
  etapaC2: string;
}

async function tenant(): Promise<Tenant> {
  const t: Tenant = {
    org: randomUUID(),
    admin: randomUUID(),
    viewer: randomUUID(),
    sessaoCanal: randomUUID(),
    contato: randomUUID(),
    contato2: randomUUID(),
    conversa: randomUUID(),
    funilGreen: randomUUID(),
    etapaG1: randomUUID(),
    etapaG2: randomUUID(),
    etapaG3: randomUUID(),
    funilComum: randomUUID(),
    etapaC1: randomUUID(),
    etapaC2: randomUUID(),
  };
  for (const u of [t.admin, t.viewer]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2)", [
      u,
      `u-${u}@auto-origin.test`,
    ]);
  }
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [t.org, `ao-${t.org}`, `Org ${t.org.slice(0, 8)}`],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$3,'admin',now()), ($2,$3,'viewer',now())",
    [t.admin, t.viewer, t.org],
  );
  await pool.query(
    "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
    [t.sessaoCanal, t.org, `ao-${t.sessaoCanal}`],
  );
  for (const [id, nome] of [
    [t.contato, "Maria Green"],
    [t.contato2, "João Green"],
  ] as const) {
    await pool.query(
      "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,$3,$4)",
      [id, t.org, nome, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
    );
  }
  await pool.query(
    "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')",
    [t.conversa, t.org, t.contato, t.sessaoCanal],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default) values
       ($1,$2,'Green','green-${t.funilGreen.slice(0, 8)}',false), ($3,$2,'Comum','comum-${t.funilComum.slice(0, 8)}',false)`,
    [t.funilGreen, t.org, t.funilComum],
  );
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [t.org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [t.funilComum]);
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$2,$3,'G1','g1',1000), ($4,$2,$3,'G2','g2',2000), ($5,$2,$3,'G3','g3',3000),
       ($6,$2,$7,'C1','c1',1000), ($8,$2,$7,'C2','c2',2000)`,
    [t.etapaG1, t.org, t.funilGreen, t.etapaG2, t.etapaG3, t.etapaC1, t.funilComum, t.etapaC2],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [t.org, t.funilGreen],
  );
  return t;
}

async function leadDe(
  t: Tenant,
  funil: string,
  etapa: string,
  contato: string | null = t.contato,
): Promise<string> {
  const { rows } = await comoDono(
    "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio',$4) returning id",
    [t.org, funil, etapa, contato],
  );
  return rows[0].id as string;
}

/** Regra ativa com UMA ação `create_or_move_lead` (a ação que escreve em Opportunity). */
async function regra(
  t: Tenant,
  gatilho: string,
  destino: { funil: string; etapa: string },
  opts: { ativa?: boolean; acoes?: unknown[]; org?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active) values ($1,$2,$3,$4,'[]'::jsonb,$5::jsonb,$6)",
    [
      id,
      opts.org ?? t.org,
      `R ${gatilho}`,
      gatilho,
      JSON.stringify(
        opts.acoes ?? [
          {
            type: "create_or_move_lead",
            config: { pipeline_id: destino.funil, stage_id: destino.etapa },
          },
        ],
      ),
      opts.ativa ?? true,
    ],
  );
  return id;
}

/** `emit_event` pelo papel do emissor real (cron/rota de token = service_role; tela = sessão). */
async function emitir(
  quem: Identidade,
  org: string,
  tipo: string,
  entidade: string,
  id: string,
  payload: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const r = await clientePostgrest(pool, quem).rpc("emit_event", {
    p_event_type: tipo,
    p_entity_kind: entidade,
    p_entity_id: id,
    p_payload: payload,
    p_metadata: metadata,
    p_organization_id: org,
  });
  if (r.error) throw new Error(`emit_event(${tipo}): ${r.error.code} ${r.error.message}`);
  return r.data as string;
}
const SERVICO: Identidade = { papel: "service_role" };
const sessao = (sub: string): Identidade => ({ papel: "authenticated", sub });

const COLS_EVENTO =
  "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at::text";

/** O drain, um evento: claim `processing` → `dispatchEvent` → `done`. */
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
  return { resultados, runs: await runsDe(eventId) };
}

/** Despacha a linha como ela está (sem claim): o que um replay/redelivery faria. */
async function despacharComoEsta(eventId: string) {
  const { rows } = await pool.query<EventRow>(`select ${COLS_EVENTO} from event_log where id=$1`, [
    eventId,
  ]);
  return dispatchEvent({ ...rows[0]!, consumed_by: [] });
}

interface Run {
  rule_id: string;
  status: string;
  actions_result: Array<{ type: string; status: string; error?: string; detail?: unknown }>;
}
async function runsDe(eventId: string): Promise<Run[]> {
  const { rows } = await pool.query<Run>(
    "select rule_id, status, actions_result from automation_rule_runs where event_id=$1 order by created_at",
    [eventId],
  );
  return rows;
}

const etapaDe = async (lead: string) =>
  (await pool.query<{ stage_id: string }>("select stage_id from crm_leads where id=$1", [lead]))
    .rows[0]?.stage_id;

interface Evento {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & {
    green?: { trusted?: Record<string, unknown>; advisory?: Record<string, unknown> };
  };
}
async function canonicosDe(lead: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    `select id, event_type, payload, metadata from event_log
      where entity_kind='crm_lead' and entity_id=$1 and event_type='lead.stage_changed'
        and metadata->>'green_canonical'='true' order by created_at, id`,
    [lead],
  );
  return rows;
}

const origemDaRegra = (t: Tenant, regraId: string, eventoId: string) => ({
  kind: "automation",
  rule_id: regraId,
  event_id: eventoId,
  organization_id: t.org,
});
const trustedDaRegra = (regraId: string, eventoId: string) => ({
  caller: "service_role",
  source: "automation",
  request_id: `rule:${regraId}`,
  causation_event_id: eventoId,
  actor: { kind: "webhook_source", id: regraId },
});

/** Linha da matriz: o que a execução real produziu, sem interpretar. */
async function linha(
  rotulo: string,
  lead: string | null,
  eventoId: string,
  esperado: string,
): Promise<Record<string, unknown>> {
  const runs = await runsDe(eventoId);
  const canonicos = lead ? await canonicosDe(lead) : [];
  const ultimo = canonicos.at(-1);
  const l = {
    caso: rotulo,
    run: runs.map((r) => r.status).join(",") || "(nenhuma)",
    acao: runs
      .flatMap((r) => r.actions_result.map((a) => `${a.status}${a.error ? `:${a.error}` : ""}`))
      .join(","),
    etapa: lead ? await etapaDe(lead) : null,
    esperado,
    trusted: ultimo?.metadata.green?.trusted ?? null,
    service_origin: ultimo?.payload.service_origin ?? null,
  };
  relatorio.push(l);
  return l;
}

/* ── emissores reais por família ─────────────────────────────────────────── */
type Emissor = (t: Tenant, regraId: string, lead: string, quem?: Identidade) => Promise<string>;

/** Os quatro gatilhos de RELÓGIO, exatamente como os crons emitem (admin client). */
const EMISSOR_DE_RELOGIO: Record<string, Emissor> = {
  "lead.stage_stale": (t, r, lead, quem = SERVICO) =>
    emitir(
      quem,
      t.org,
      "lead.stage_stale",
      "crm_lead",
      lead,
      {
        rule_id: r,
        dias: 3,
        ancora: "2026-09-01T00:00:00.000Z",
        etapa_desde: "2026-09-01T00:00:00.000Z",
      },
      { actor_kind: "system", source: "cron/lead-time-triggers" },
    ),
  "lead.silent_for": (t, r, lead, quem = SERVICO) =>
    emitir(
      quem,
      t.org,
      "lead.silent_for",
      "crm_lead",
      lead,
      {
        rule_id: r,
        dias: 5,
        ancora: "2026-09-01T00:00:00.000Z",
        direcao: "inbound",
        silencio_desde: "2026-09-01T00:00:00.000Z",
      },
      { actor_kind: "system", source: "cron/lead-time-triggers" },
    ),
  "lead.date_field_due": (t, r, lead, quem = SERVICO) =>
    emitir(
      quem,
      t.org,
      "lead.date_field_due",
      "crm_lead",
      lead,
      {
        rule_id: r,
        pipeline_id: t.funilGreen,
        campo: "data_do_evento",
        dias: 10,
        local_date: "2026-10-03",
        date: "2026-10-13",
        valor: "2026-10-13",
      },
      { actor_kind: "system", source: "cron/lead-date-field-due" },
    ),
  "contact.birthday": (t, _r, _lead, quem = SERVICO) =>
    emitir(
      quem,
      t.org,
      "contact.birthday",
      "contact",
      t.contato,
      { local_date: "2026-10-03" },
      { actor_kind: "system", source: "cron/contact-birthdays" },
    ),
};

/* ═══ R — matriz RED representativa (Fase 3) ═══════════════════════════════ */
describe("R — matriz RED: a automação real move a Opportunity Green, com origem confiável", () => {
  for (const gatilho of [
    "lead.stage_stale",
    "lead.silent_for",
    "lead.date_field_due",
    "contact.birthday",
  ]) {
    it(`R-${gatilho}: o gatilho de relógio emitido pelo cron move o lead Green e a proveniência é da regra`, async () => {
      const t = await tenant();
      const lead = await leadDe(t, t.funilGreen, t.etapaG1);
      const r = await regra(t, gatilho, { funil: t.funilGreen, etapa: t.etapaG2 });
      const e = await EMISSOR_DE_RELOGIO[gatilho]!(t, r, lead);

      const { resultados } = await drenar(e);
      const l = await linha(`R-${gatilho}`, lead, e, "PASS");

      expect(resultados.find((x) => x.consumer_key === "automation-rules")?.status).toBe("ok");
      expect(l.run).toBe("success");
      expect(await etapaDe(lead)).toBe(t.etapaG2);
      const [c] = (await canonicosDe(lead)).slice(-1);
      expect(c!.metadata.green!.trusted).toMatchObject({
        ...trustedDaRegra(r, e),
        correlation_id: e,
      });
      expect(c!.payload.service_origin).toEqual(origemDaRegra(t, r, e));
    });
  }

  it("R-lead.tag_added (já funcionava em Green): continua movendo, agora com a origem da regra", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.tag_added", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await emitir(SERVICO, t.org, "lead.tag_added", "crm_lead", lead, {
      added_tags: ["vip"],
      tags: ["vip"],
    });
    await drenar(e);
    const l = await linha("R-lead.tag_added", lead, e, "PASS");
    // comportamento: a regra move (já era assim na base)
    expect(l.run).toBe("success");
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    // contrato novo: a origem é a da regra, não a do evento de atendimento
    const [c] = (await canonicosDe(lead)).slice(-1);
    expect(c!.payload.service_origin).toEqual(origemDaRegra(t, r, e));
  });

  it("R-controle comum: o mesmo gatilho de relógio move um lead COMUM (antes e depois)", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilComum, t.etapaC1);
    const r = await regra(t, "lead.stage_stale", { funil: t.funilComum, etapa: t.etapaC2 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead);
    await drenar(e);
    const l = await linha("R-controle-comum-stage_stale", lead, e, "PASS");
    expect(l.run).toBe("success");
    expect(await etapaDe(lead)).toBe(t.etapaC2);
    expect(await canonicosDe(lead)).toHaveLength(0); // lead comum não tem canônico Green
  });
});

/* ═══ C — censo dos 16 gatilhos (Fase 14) ══════════════════════════════════ */
describe("C — censo: todo gatilho do produto move a Opportunity Green pelo motor real", () => {
  it("C0 — os 16 gatilhos do censo são exatamente os do produto (fonte única)", () => {
    expect([...TRIGGER_EVENTS].sort()).toEqual(
      [
        "appointment.cancelled",
        "appointment.completed",
        "appointment.confirmed",
        "appointment.created",
        "appointment.no_show",
        "appointment.rescheduled",
        "contact.birthday",
        "contact.tag_added",
        "lead.created",
        "lead.date_field_due",
        "lead.silent_for",
        "lead.stage_changed",
        "lead.stage_stale",
        "lead.tag_added",
        "message.failed",
        "message.received",
      ].sort(),
    );
  });

  /** Emissores dos gatilhos de EVENTO, pelo produtor real (trigger de banco, rota ou cron). */
  const EMISSOR_DE_EVENTO: Record<string, Emissor> = {
    "lead.created": (t, _r, lead) =>
      emitir(
        SERVICO,
        t.org,
        "lead.created",
        "crm_lead",
        lead,
        {
          pipeline_id: t.funilGreen,
          stage_id: t.etapaG1,
          title: "Negócio",
        },
        { request_id: randomUUID(), actor_type: "api_token" },
      ),
    // a mudança humana de etapa: o canônico nasce do trigger de crm_leads
    "lead.stage_changed": async (t, _r, lead) => {
      await request(
        { papel: "authenticated", sub: t.admin },
        "update crm_leads set stage_id=$1 where id=$2",
        [t.etapaG3, lead],
      );
      return (await canonicosDe(lead)).at(-1)!.id;
    },
    "lead.tag_added": (t, _r, lead) =>
      emitir(SERVICO, t.org, "lead.tag_added", "crm_lead", lead, {
        added_tags: ["vip"],
        tags: ["vip"],
      }),
    "contact.tag_added": (t) =>
      emitir(SERVICO, t.org, "contact.tag_added", "contact", t.contato, {
        added_tags: ["vip"],
        tags: ["vip"],
      }),
    // a mensagem que ENTRA: o produtor é o trigger de `messages`
    "message.received": async (t) => {
      const { rows } = await pool.query<{ id: string }>(
        "insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, external_id) values ($1,$2,$3,$4,'text','inbound','received','oi',$5) returning id",
        [t.org, t.conversa, t.sessaoCanal, t.contato, `wa-${randomUUID()}`],
      );
      return (
        await pool.query<{ id: string }>(
          "select id from event_log where event_type='message.received' and entity_id=$1",
          [rows[0]!.id],
        )
      ).rows[0]!.id;
    },
    // a mensagem que SAI já falhada: o produtor é o mesmo trigger
    "message.failed": async (t) => {
      const { rows } = await pool.query<{ id: string }>(
        "insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, external_id) values ($1,$2,$3,$4,'text','outbound','failed','oi',$5) returning id",
        [t.org, t.conversa, t.sessaoCanal, t.contato, `wa-${randomUUID()}`],
      );
      const ev = await pool.query<{ id: string }>(
        "select id from event_log where event_type='message.failed' and entity_id=$1",
        [rows[0]!.id],
      );
      if (ev.rows[0]) return ev.rows[0].id;
      // trigger que não emite no INSERT: o emissor de `falha-de-entrega` (admin)
      return emitir(
        SERVICO,
        t.org,
        "message.failed",
        "message",
        rows[0]!.id,
        {
          message_id: rows[0]!.id,
          conversation_id: t.conversa,
          contact_id: t.contato,
        },
        { source: "meta-status-webhook" },
      );
    },
  };

  /** Compromisso do contato, e o evento do laço da agenda pelo client de quem o emite. */
  async function compromisso(t: Tenant): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id) values ($1,'Visita',now() + interval '2 days',now() + interval '2 days 1 hour',$2) returning id",
      [t.org, t.contato],
    );
    return rows[0]!.id;
  }
  const APPOINTMENT: Array<[string, "sessao" | "servico"]> = [
    ["appointment.created", "sessao"],
    ["appointment.confirmed", "sessao"],
    ["appointment.rescheduled", "sessao"],
    ["appointment.cancelled", "servico"],
    ["appointment.completed", "servico"],
    ["appointment.no_show", "servico"],
  ];
  for (const [tipo, quem] of APPOINTMENT) {
    EMISSOR_DE_EVENTO[tipo] = async (t) => {
      const ap = await compromisso(t);
      return emitir(
        quem === "sessao" ? sessao(t.admin) : SERVICO,
        t.org,
        tipo,
        "calendar_appointment",
        ap,
        {
          appointment_id: ap,
          contact_id: t.contato,
          transicao: tipo.split(".")[1],
          lead_ids: [],
        },
        { request_id: randomUUID() },
      );
    };
  }

  for (const gatilho of Object.keys(ENTIDADE_ESPERADA_POR_GATILHO)) {
    if (gatilho in EMISSOR_DE_RELOGIO) continue; // cobertos pela matriz R
    it(`C-${gatilho}: PASS — run success, lead Green movido, origem da regra`, async () => {
      const t = await tenant();
      const lead = await leadDe(t, t.funilGreen, t.etapaG1);
      // lead.stage_changed: a regra leva o lead que o humano pôs em G3 para G2
      const r = await regra(t, gatilho, { funil: t.funilGreen, etapa: t.etapaG2 });
      const e = await EMISSOR_DE_EVENTO[gatilho]!(t, r, lead);
      await drenar(e);
      const l = await linha(`C-${gatilho}`, lead, e, "PASS");
      expect(l.run).toBe("success");
      expect(await etapaDe(lead)).toBe(t.etapaG2);
      const [c] = (await canonicosDe(lead)).slice(-1);
      expect(c!.metadata.green!.trusted).toMatchObject(trustedDaRegra(r, e));
      expect(c!.payload.service_origin).toEqual(origemDaRegra(t, r, e));
    });
  }

  it("C-criação: gatilho de relógio de CONTATO sem negócio no funil cria a Opportunity Green com a origem da regra", async () => {
    const t = await tenant();
    const r = await regra(t, "contact.birthday", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await EMISSOR_DE_RELOGIO["contact.birthday"]!(t, r, "");
    await drenar(e);
    const { rows } = await pool.query<{ id: string; stage_id: string }>(
      "select id, stage_id from crm_leads where organization_id=$1 and contact_id=$2 and pipeline_id=$3",
      [t.org, t.contato, t.funilGreen],
    );
    const l = await linha("C-criação-contact.birthday", rows[0]?.id ?? null, e, "PASS");
    expect(l.run).toBe("success");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_id).toBe(t.etapaG2);
    const prov = await pool.query<{ p: Record<string, unknown> }>(
      "select to_jsonb(p) p from green.lead_birth_provenance p where lead_id=$1",
      [rows[0]!.id],
    );
    expect(prov.rows[0]!.p.service_origin).toEqual(origemDaRegra(t, r, e));
    expect(prov.rows[0]!.p.trusted).toMatchObject(trustedDaRegra(r, e));
  });

  /** Etapa de perda no funil: o encerramento da transferência leva a origem para ela. */
  async function etapaDePerda(t: Tenant, funil: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost) values ($1,$2,$3,'Perdido',$4,9000,true)",
      [id, t.org, funil, `perdido-${id.slice(0, 8)}`],
    );
    return id;
  }

  it("C-transferência comum→Green: a regra clona o negócio do contato para o funil Green (nascimento com a origem da regra) e encerra a origem comum", async () => {
    const t = await tenant();
    const perdaComum = await etapaDePerda(t, t.funilComum);
    const origemComum = await leadDe(t, t.funilComum, t.etapaC1);
    const r = await regra(t, "contact.birthday", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await EMISSOR_DE_RELOGIO["contact.birthday"]!(t, r, "");
    await drenar(e);
    const { rows } = await pool.query<{ id: string; stage_id: string }>(
      "select id, stage_id from crm_leads where organization_id=$1 and contact_id=$2 and pipeline_id=$3",
      [t.org, t.contato, t.funilGreen],
    );
    const l = await linha("C-transferência-comum→Green", rows[0]?.id ?? null, e, "PASS");
    expect(l.run).toBe("success");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_id).toBe(t.etapaG2);
    const prov = await pool.query<{ p: Record<string, unknown> }>(
      "select to_jsonb(p) p from green.lead_birth_provenance p where lead_id=$1",
      [rows[0]!.id],
    );
    expect(prov.rows[0]!.p.service_origin).toEqual(origemDaRegra(t, r, e));
    expect(await etapaDe(origemComum)).toBe(perdaComum);
  });

  it("C-transferência Green→comum: a regra encerra a Opportunity Green (canônico com a origem da regra) e clona no funil comum", async () => {
    const t = await tenant();
    const perdaGreen = await etapaDePerda(t, t.funilGreen);
    const origemGreen = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "contact.birthday", { funil: t.funilComum, etapa: t.etapaC2 });
    const e = await EMISSOR_DE_RELOGIO["contact.birthday"]!(t, r, "");
    await drenar(e);
    const l = await linha("C-transferência-Green→comum", origemGreen, e, "PASS");
    expect(l.run).toBe("success");
    expect(await etapaDe(origemGreen)).toBe(perdaGreen);
    const [c] = (await canonicosDe(origemGreen)).slice(-1);
    expect(c!.payload).toMatchObject({ to_stage_id: perdaGreen, green_transition: "stay" });
    expect(c!.payload.service_origin).toEqual(origemDaRegra(t, r, e));
    expect(c!.metadata.green!.trusted).toMatchObject(trustedDaRegra(r, e));
    const { rows } = await pool.query<{ stage_id: string }>(
      "select stage_id from crm_leads where organization_id=$1 and contact_id=$2 and pipeline_id=$3",
      [t.org, t.contato, t.funilComum],
    );
    expect(rows.map((x) => x.stage_id)).toEqual([t.etapaC2]);
  });

  for (const gatilho of Object.keys(EMISSOR_DE_RELOGIO)) {
    it(`C-${gatilho} forjado por sessão: FAIL ESPERADO — o relógio não é um membro da organização`, async () => {
      const t = await tenant();
      const lead = await leadDe(t, t.funilGreen, t.etapaG1);
      const r = await regra(t, gatilho, { funil: t.funilGreen, etapa: t.etapaG2 });
      // o mesmo payload do cron, emitido por uma sessão (aqui, um viewer) pelo PostgREST
      const e = await EMISSOR_DE_RELOGIO[gatilho]!(t, r, lead, sessao(t.viewer));
      await drenar(e);
      const l = await linha(`C-${gatilho}-forjado-por-sessao`, lead, e, "FAIL ESPERADO");
      expect(l.run).toBe("failed");
      expect(l.acao).toContain("green_automation_trigger_untrusted");
      expect(await etapaDe(lead)).toBe(t.etapaG1);
      expect(await canonicosDe(lead)).toHaveLength(0);
    });
  }

  it("C-controle comum: o gatilho de relógio forjado por sessão continua movendo lead COMUM (upstream intacto)", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilComum, t.etapaC1);
    const r = await regra(t, "lead.stage_stale", { funil: t.funilComum, etapa: t.etapaC2 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead, sessao(t.viewer));
    await drenar(e);
    const l = await linha("C-controle-comum-forjado-por-sessao", lead, e, "PASS (upstream)");
    expect(l.run).toBe("success");
    expect(await etapaDe(lead)).toBe(t.etapaC2);
  });
});

/* ═══ A — anti-loop (Fase 6) ═══════════════════════════════════════════════ */
describe("A — anti-loop: a escrita da regra não reexecuta regras", () => {
  it("A1 — regra A move o lead; o canônico que ela causou volta ao motor e NENHUMA regra roda", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const a = await regra(t, "lead.stage_stale", { funil: t.funilGreen, etapa: t.etapaG2 });
    const b = await regra(t, "lead.stage_changed", { funil: t.funilGreen, etapa: t.etapaG3 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, a, lead);
    await drenar(e);
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    const [c] = await canonicosDe(lead);
    expect(c!.metadata.green!.trusted).toMatchObject({
      source: "automation",
      request_id: `rule:${a}`,
    });

    const { resultados } = await drenar(c!.id);
    expect(resultados.find((x) => x.consumer_key === "automation-rules")).toMatchObject({
      status: "skipped",
      detail: "caused_by_rule",
    });
    expect(await runsDe(c!.id)).toHaveLength(0); // B não rodou
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    expect(await canonicosDe(lead)).toHaveLength(1);
    void b;
  });

  it("A2 — A→B e B→A no mesmo gatilho: cada regra roda uma vez por evento humano; os canônicos delas não reentram", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    // A: quando muda de etapa → G2; B: quando muda de etapa → G1 (o par que "devolve")
    const a = await regra(t, "lead.stage_changed", { funil: t.funilGreen, etapa: t.etapaG2 });
    const b = await regra(t, "lead.stage_changed", { funil: t.funilGreen, etapa: t.etapaG1 });
    await request(
      { papel: "authenticated", sub: t.admin },
      "update crm_leads set stage_id=$1 where id=$2",
      [t.etapaG3, lead],
    );
    const [humano] = await canonicosDe(lead);
    await drenar(humano!.id);
    const runs = await runsDe(humano!.id);
    relatorio.push({
      caso: "A2",
      runs: runs.map((r) => `${r.rule_id === a ? "A" : "B"}:${r.status}`),
    });
    expect(runs.map((r) => r.status)).toEqual(["success", "success"]);
    // ordem de criação: A (G2) e depois B (G1) — o lead termina onde a ÚLTIMA regra o pôs
    expect(await etapaDe(lead)).toBe(t.etapaG1);
    const daRegra = (await canonicosDe(lead)).slice(1);
    expect(daRegra.map((c) => c.metadata.green!.trusted!.request_id)).toEqual([
      `rule:${a}`,
      `rule:${b}`,
    ]);
    for (const c of daRegra) {
      const { resultados } = await drenar(c.id);
      expect(resultados.find((x) => x.consumer_key === "automation-rules")?.detail).toBe(
        "caused_by_rule",
      );
    }
    expect(await canonicosDe(lead)).toHaveLength(3); // humano + A + B; nenhuma reentrada
  });

  it("A3 — humano com `source=automation`/`request_id=rule:*`/origem de regra no header: advisory; o canônico humano DISPARA regra", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.stage_changed", { funil: t.funilGreen, etapa: t.etapaG3 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead);
    await request(
      {
        papel: "authenticated",
        sub: t.admin,
        contexto: {
          v: 1,
          source: "automation",
          request_id: `rule:${r}`,
          causation_event_id: e,
          actor: { kind: "webhook_source", id: r },
          service_origin: origemDaRegra(t, r, e),
        },
      },
      "update crm_leads set stage_id=$1 where id=$2",
      [t.etapaG2, lead],
    );
    const [c] = await canonicosDe(lead);
    expect(c!.metadata.green!.trusted).toEqual({
      caller: "user",
      actor: { kind: "user", id: t.admin },
      source: "user_session",
    });
    // a origem de um canônico humano é a que o banco deriva (`command`, carimbada pelo
    // `emit_event` da 0279), nunca a que a sessão declarou
    expect((c!.payload.service_origin as { kind?: string } | undefined)?.kind).toBe("command");
    expect(c!.metadata.green!.advisory).toMatchObject({
      source: "automation",
      request_id: `rule:${r}`,
    });
    await drenar(c!.id);
    expect((await runsDe(c!.id)).map((x) => x.status)).toEqual(["success"]);
    expect(await etapaDe(lead)).toBe(t.etapaG3);
  });
});

/* ═══ X — segurança adversarial (Fase 9) e tenant (Fase 10) ════════════════ */
describe("X — origem de automação não é forjável", () => {
  interface Cena {
    t: Tenant;
    lead: string;
    regra: string;
    evento: string;
  }
  /** Cena válida: regra de relógio, evento emitido pelo cron, lead Green em G1. */
  async function cena(): Promise<Cena> {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.stage_stale", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead);
    return { t, lead, regra: r, evento: e };
  }
  /** O contexto que o motor declara para (regra, evento) — o caminho legítimo. */
  const contextoDaRegra = (c: Cena, ajuste: Record<string, unknown> = {}) => ({
    v: 1,
    source: "automation",
    request_id: `rule:${c.regra}`,
    correlation_id: c.evento,
    causation_event_id: c.evento,
    actor: { kind: "webhook_source", id: c.regra },
    service_origin: origemDaRegra(c.t, c.regra, c.evento),
    ...ajuste,
  });
  const moverComo = (
    c: Cena,
    contexto: Record<string, unknown>,
    lead = c.lead,
    etapa = c.t.etapaG2,
  ) =>
    erroDe(
      request({ papel: "service_role", contexto }, "update crm_leads set stage_id=$1 where id=$2", [
        etapa,
        lead,
      ]),
    );
  const origem = (c: Cena, ajuste: Record<string, unknown>) => ({
    ...origemDaRegra(c.t, c.regra, c.evento),
    ...ajuste,
  });

  it("X0 — controle positivo: o contexto que o motor declara move o lead", async () => {
    const c = await cena();
    const e = await moverComo(c, contextoDaRegra(c));
    relatorio.push({ caso: "X0", veredito: veredito(e) });
    expect(veredito(e)).toBe("ACEITO");
    expect(await etapaDe(c.lead)).toBe(c.t.etapaG2);
  });

  const ataques: Array<
    [
      string,
      (c: Cena, alheia: Cena) => Record<string, unknown> | Promise<Record<string, unknown>>,
      string,
    ]
  > = [
    [
      "X1 regra de OUTRA organização",
      (c, alheia) =>
        contextoDaRegra(c, {
          request_id: `rule:${alheia.regra}`,
          actor: { kind: "webhook_source", id: alheia.regra },
          service_origin: origem(c, { rule_id: alheia.regra }),
        }),
      "green_automation_rule_invalid",
    ],
    [
      "X2 regra inexistente",
      (c) => {
        const r = randomUUID();
        return contextoDaRegra(c, {
          request_id: `rule:${r}`,
          actor: { kind: "webhook_source", id: r },
          service_origin: origem(c, { rule_id: r }),
        });
      },
      "green_automation_rule_invalid",
    ],
    [
      "X3 evento inexistente",
      (c) => {
        const e = randomUUID();
        return contextoDaRegra(c, {
          causation_event_id: e,
          correlation_id: e,
          service_origin: origem(c, { event_id: e }),
        });
      },
      "green_automation_event_invalid",
    ],
    [
      "X4 evento de OUTRA organização",
      (c, alheia) =>
        contextoDaRegra(c, {
          causation_event_id: alheia.evento,
          correlation_id: alheia.evento,
          service_origin: origem(c, { event_id: alheia.evento }),
        }),
      "green_automation_event_invalid",
    ],
    [
      "X5 evento de OUTRO lead da mesma organização",
      async (c) => {
        const outro = await leadDe(c.t, c.t.funilGreen, c.t.etapaG1, c.t.contato2);
        const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(c.t, c.regra, outro);
        return contextoDaRegra(c, {
          causation_event_id: e,
          correlation_id: e,
          service_origin: origem(c, { event_id: e }),
        });
      },
      "green_automation_subject_mismatch",
    ],
    [
      "X6 organização da origem trocada",
      (c, alheia) =>
        contextoDaRegra(c, { service_origin: origem(c, { organization_id: alheia.t.org }) }),
      "green_service_origin_scope_mismatch",
    ],
    [
      "X7 correlation de outro evento",
      async (c) => {
        const outro = await emitir(SERVICO, c.t.org, "lead.tag_added", "crm_lead", c.lead, {
          added_tags: ["x"],
        });
        return contextoDaRegra(c, { correlation_id: outro });
      },
      "green_automation_origin_incoherent",
    ],
    [
      "X8 request_id de outra regra",
      (c) => contextoDaRegra(c, { request_id: `rule:${randomUUID()}` }),
      "green_automation_origin_incoherent",
    ],
    [
      "X9 causation de outro evento",
      async (c) => {
        const outro = await emitir(SERVICO, c.t.org, "lead.tag_added", "crm_lead", c.lead, {
          added_tags: ["x"],
        });
        return contextoDaRegra(c, { causation_event_id: outro });
      },
      "green_automation_origin_incoherent",
    ],
    [
      "X10 ator que não é a regra",
      (c) => contextoDaRegra(c, { actor: { kind: "system", id: c.regra } }),
      "green_automation_origin_incoherent",
    ],
    [
      "X11 source que não é automation",
      (c) => contextoDaRegra(c, { source: "mcp" }),
      "green_automation_origin_incoherent",
    ],
    [
      "X12 evento de outro tipo (regra de relógio, evento de etiqueta)",
      async (c) => {
        const outro = await emitir(SERVICO, c.t.org, "lead.tag_added", "crm_lead", c.lead, {
          added_tags: ["x"],
        });
        return contextoDaRegra(c, {
          causation_event_id: outro,
          correlation_id: outro,
          service_origin: origem(c, { event_id: outro }),
        });
      },
      "green_automation_trigger_mismatch",
    ],
    [
      "X13 evento dirigido a OUTRA regra",
      async (c) => {
        const outraRegra = await regra(c.t, "lead.stage_stale", {
          funil: c.t.funilGreen,
          etapa: c.t.etapaG2,
        });
        const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(c.t, outraRegra, c.lead);
        return contextoDaRegra(c, {
          causation_event_id: e,
          correlation_id: e,
          service_origin: origem(c, { event_id: e }),
        });
      },
      "green_automation_trigger_mismatch",
    ],
    [
      "X14 regra inativa",
      async (c) => {
        await pool.query("update automation_rules set is_active=false where id=$1", [c.regra]);
        return contextoDaRegra(c);
      },
      "green_automation_rule_invalid",
    ],
    [
      "X15 regra sem ação que escreve em Opportunity",
      async (c) => {
        await pool.query(
          `update automation_rules set actions='[{"type":"add_tag","config":{"tags":["x"]}}]'::jsonb where id=$1`,
          [c.regra],
        );
        return contextoDaRegra(c);
      },
      "green_automation_rule_invalid",
    ],
    [
      "X16 relógio declarado à mão: evento de relógio emitido por SESSÃO",
      async (c) => {
        const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(
          c.t,
          c.regra,
          c.lead,
          sessao(c.t.viewer),
        );
        return contextoDaRegra(c, {
          causation_event_id: e,
          correlation_id: e,
          service_origin: origem(c, { event_id: e }),
        });
      },
      "green_automation_trigger_untrusted",
    ],
    [
      "X17 replay: evento já drenado (done)",
      async (c) => {
        await pool.query("update event_log set status='done' where id=$1", [c.evento]);
        return contextoDaRegra(c);
      },
      "green_automation_event_stale",
    ],
    [
      "X18 kind inventado (`scheduler`)",
      (c) =>
        contextoDaRegra(c, {
          service_origin: { kind: "scheduler", rule_id: c.regra, organization_id: c.t.org },
        }),
      "green_mutation_context_required",
    ],
    [
      "X19 chave extra na origem",
      (c) => contextoDaRegra(c, { service_origin: origem(c, { contact_id: c.t.contato }) }),
      "green_mutation_context_required",
    ],
  ];

  for (const [rotulo, montar, esperado] of ataques) {
    it(`${rotulo} → ${esperado}`, async () => {
      const c = await cena();
      const alheia = await cena();
      const e = await moverComo(c, await montar(c, alheia));
      relatorio.push({ caso: rotulo, veredito: veredito(e), esperado });
      expect(e?.message).toBe(esperado);
      expect(await etapaDe(c.lead)).toBe(c.t.etapaG1);
      expect(await canonicosDe(c.lead)).toHaveLength(0);
    });
  }

  it("X20 — ausência de oracle: regra/evento de outra organização ≡ inexistente (mesmo código, mesma mensagem, mesmo detalhe)", async () => {
    const c = await cena();
    const alheia = await cena();
    const r = randomUUID();
    const comRegra = (id: string) =>
      contextoDaRegra(c, {
        request_id: `rule:${id}`,
        actor: { kind: "webhook_source", id },
        service_origin: origem(c, { rule_id: id }),
      });
    const comEvento = (id: string) =>
      contextoDaRegra(c, {
        causation_event_id: id,
        correlation_id: id,
        service_origin: origem(c, { event_id: id }),
      });
    const forma = (e: pg.DatabaseError | null) => [
      e?.code,
      e?.message,
      e?.detail ?? null,
      e?.hint ?? null,
    ];
    expect(forma(await moverComo(c, comRegra(alheia.regra)))).toEqual(
      forma(await moverComo(c, comRegra(r))),
    );
    expect(forma(await moverComo(c, comEvento(alheia.evento)))).toEqual(
      forma(await moverComo(c, comEvento(randomUUID()))),
    );
  });

  it("X21 — cross-tenant: lead da org B com a origem completa da org A é recusado", async () => {
    const c = await cena();
    const alheia = await cena();
    const e = await moverComo(c, contextoDaRegra(c), alheia.lead, alheia.t.etapaG2);
    relatorio.push({ caso: "X21", veredito: veredito(e) });
    expect(e?.message).toBe("green_service_origin_scope_mismatch");
    expect(await etapaDe(alheia.lead)).toBe(alheia.t.etapaG1);
  });

  it("X22 — sessão humana não alcança a origem de automação nem o carimbo do relógio", async () => {
    const c = await cena();
    // a sessão manda a origem completa e válida: o banco a ignora (caller=user)
    await request(
      { papel: "authenticated", sub: c.t.admin, contexto: contextoDaRegra(c) },
      "update crm_leads set stage_id=$1 where id=$2",
      [c.t.etapaG2, c.lead],
    );
    const [ev] = await canonicosDe(c.lead);
    expect(ev!.metadata.green!.trusted).toEqual({
      caller: "user",
      actor: { kind: "user", id: c.t.admin },
      source: "user_session",
    });
    // o carimbo do relógio não é tabela de API (green fora de authenticated)
    const e = await erroDe(
      request(
        { papel: "authenticated", sub: c.t.admin },
        "select count(*) from green.scheduler_trigger_emission",
      ),
    );
    expect(e?.code).toBe("42501");
    // nem service_role escreve nele: só o produtor (trigger) grava
    const s = await erroDe(
      request(
        { papel: "service_role" },
        "insert into green.scheduler_trigger_emission (event_id, organization_id, event_type, caller) values ($1,$2,'lead.stage_stale','service_role')",
        [randomUUID(), c.t.org],
      ),
    );
    expect(s?.code).toBe("42501");
  });

  it("X23 — o carimbo do relógio registra QUEM emitiu (cron = service_role; forja = user + uid)", async () => {
    const c = await cena();
    const forjado = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(
      c.t,
      c.regra,
      c.lead,
      sessao(c.t.viewer),
    );
    const existe = (
      await pool.query("select to_regclass('green.scheduler_trigger_emission') is not null as e")
    ).rows[0].e;
    const carimbos = existe
      ? (
          await pool.query<{ event_id: string; caller: string; user_id: string | null }>(
            "select event_id, caller, user_id from green.scheduler_trigger_emission where event_id = any($1) order by caller",
            [[c.evento, forjado]],
          )
        ).rows
      : [];
    expect(carimbos).toEqual([
      { event_id: c.evento, caller: "service_role", user_id: null },
      { event_id: forjado, caller: "user", user_id: c.t.viewer },
    ]);
  });
});

/* ═══ I — idempotência e retry (Fase 11) ═══════════════════════════════════ */
describe("I — idempotência: a mesma execução repetida não duplica nem muda a proveniência", () => {
  it("I1 — redelivery do MESMO evento ainda em processamento: não move de novo, não duplica canônico", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.stage_stale", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead);
    await pool.query("update event_log set status='processing' where id=$1", [e]);
    await despacharComoEsta(e);
    const antes = await canonicosDe(lead);
    await despacharComoEsta(e); // o reaper devolveu o evento; o motor roda de novo
    const depois = await canonicosDe(lead);
    const runs = await runsDe(e);
    relatorio.push({ caso: "I1", runs: runs.map((x) => x.status), canonicos: depois.length });
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    expect(depois).toHaveLength(1);
    expect(depois[0]!.payload.service_origin).toEqual(antes[0]!.payload.service_origin);
    // o registro da execução é upstream: uma linha por passagem do motor
    expect(runs.map((x) => x.status)).toEqual(["success", "success"]);
  });

  it("I2 — replay de execução antiga (evento já `done`) pelo motor: recusado na fronteira, lead não se move", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.stage_stale", { funil: t.funilGreen, etapa: t.etapaG2 });
    const e = await EMISSOR_DE_RELOGIO["lead.stage_stale"]!(t, r, lead);
    await drenar(e);
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    // alguém volta o lead e reprocessa o evento antigo
    await comoDono("update crm_leads set stage_id=$1 where id=$2", [t.etapaG1, lead]);
    await despacharComoEsta(e);
    const runs = await runsDe(e);
    relatorio.push({
      caso: "I2",
      runs: runs.map((x) => `${x.status}:${x.actions_result.map((a) => a.error ?? "").join("")}`),
    });
    expect(runs.at(-1)!.status).toBe("failed");
    expect(runs.at(-1)!.actions_result[0]!.error).toContain("green_automation_event_stale");
    expect(await etapaDe(lead)).toBe(t.etapaG1);
  });
});

/* ═══ G — gaps documentados: comportamento ATUAL, não contrato desejado ═════ */
// Cada caso registra um resíduo classificado no relatório (§14). Se um deles
// ficar vermelho, o gap mudou: atualize a classificação, não "conserte" o teste.
describe("G — gaps documentados (comportamento atual)", () => {
  it("G1 (AUTO-GAP-01, PRODUÇÃO) — evento da família `event` emitido por um VIEWER pelo PostgREST: a regra roda e move o lead Green", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const r = await regra(t, "lead.tag_added", { funil: t.funilGreen, etapa: t.etapaG2 });
    // nenhuma etiqueta foi posta: o viewer só grava a linha no barramento (o `emit_event` aceita)
    const e = await emitir(sessao(t.viewer), t.org, "lead.tag_added", "crm_lead", lead, {
      added_tags: ["vip"],
      tags: ["vip"],
    });
    await drenar(e);
    const l = await linha("G1-lead.tag_added-emitido-por-viewer", lead, e, "GAP (aceito)");
    expect(l.run).toBe("success");
    expect(await etapaDe(lead)).toBe(t.etapaG2);
    // a origem diz a verdade sobre a regra e o evento; quem emitiu o evento não é registrado
    const [c] = (await canonicosDe(lead)).slice(-1);
    expect(c!.payload.service_origin).toEqual(origemDaRegra(t, r, e));
    expect(JSON.stringify(c!.metadata)).not.toContain(t.viewer);
  });

  it("G2 (AUTO-GAP-02, DÉBITO) — backend com `source=automation`/`rule:*` e SEM origem: aceito, e o anti-loop o lê como causado por regra", async () => {
    const t = await tenant();
    const lead = await leadDe(t, t.funilGreen, t.etapaG1);
    const regraQualquer = randomUUID();
    const e = await erroDe(
      request(
        {
          papel: "service_role",
          contexto: {
            v: 1,
            source: "automation",
            request_id: `rule:${regraQualquer}`,
            actor: { kind: "webhook_source", id: regraQualquer },
          },
        },
        "update crm_leads set stage_id=$1 where id=$2",
        [t.etapaG2, lead],
      ),
    );
    relatorio.push({ caso: "G2", veredito: veredito(e) });
    expect(veredito(e)).toBe("ACEITO");
    const [c] = await canonicosDe(lead);
    expect(c!.metadata.green!.trusted).toMatchObject({
      source: "automation",
      request_id: `rule:${regraQualquer}`,
    });
    // sem origem transportada, o banco carimba a derivada (`command`), não a de automação
    expect((c!.payload.service_origin as { kind?: string } | undefined)?.kind).toBe("command");
    const { resultados } = await drenar(c!.id);
    expect(resultados.find((x) => x.consumer_key === "automation-rules")?.detail).toBe(
      "caused_by_rule",
    );
  });
});

/* ═══ K — catraca: o banco classifica exatamente os gatilhos do produto ═════ */
describe("K — catraca: a régua do banco e a fonte única do TS concordam", () => {
  it("K1 — família e entidade de cada gatilho no banco = `ENTIDADE_ESPERADA_POR_GATILHO` + os 4 do relógio", async () => {
    const existe = (
      await pool.query(
        "select to_regprocedure('green.fn_automation_trigger_entity(text)') is not null and to_regprocedure('green.fn_automation_trigger_family(text)') is not null as e",
      )
    ).rows[0].e;
    const banco: Record<string, [string | null, string | null]> = {};
    if (existe) {
      for (const g of TRIGGER_EVENTS) {
        const { rows } = await pool.query<{ ent: string | null; fam: string | null }>(
          "select green.fn_automation_trigger_entity($1) ent, green.fn_automation_trigger_family($1) fam",
          [g],
        );
        banco[g] = [rows[0]!.ent, rows[0]!.fam];
      }
    }
    const RELOGIO = new Set([
      "contact.birthday",
      "lead.date_field_due",
      "lead.silent_for",
      "lead.stage_stale",
    ]);
    const esperado = Object.fromEntries(
      TRIGGER_EVENTS.map((g) => [
        g,
        [ENTIDADE_ESPERADA_POR_GATILHO[g], RELOGIO.has(g) ? "scheduler" : "event"],
      ]),
    );
    expect(banco).toEqual(esperado);
    // K2 — o carimbo do relógio vigia EXATAMENTE a família `scheduler`
    const def = (
      await pool.query<{ d: string | null }>(
        "select pg_get_triggerdef(oid) d from pg_trigger where tgrelid='public.event_log'::regclass and tgname='trg_green_stamp_scheduler_trigger'",
      )
    ).rows[0]?.d;
    const vigiados = [...(def ?? "").matchAll(/'([a-z_]+\.[a-z_]+)'::text/g)]
      .map((m) => m[1])
      .sort();
    expect(vigiados).toEqual([...RELOGIO].sort());
    // tipo fora do produto não é gatilho de automação para o banco
    if (existe) {
      const { rows } = await pool.query(
        "select green.fn_automation_trigger_family('lead.updated') fam, green.fn_automation_trigger_entity('message.group_received') ent",
      );
      expect(rows[0]).toEqual({ fam: null, ent: null });
    }
  });
});
