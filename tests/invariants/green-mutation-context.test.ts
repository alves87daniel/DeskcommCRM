/**
 * SPIKE Green — Green Mutation Boundary no banco (migration 0501): S1–S14 do
 * desenho `05A-SPIKE-MUTATION-CONTEXT.md`, executados contra o Postgres efêmero
 * do harness (baseline aplicado, com o apêndice 0501).
 *
 * O harness não tem PostgREST, então cada cenário SIMULA a request exatamente
 * como o PostgREST a entrega ao Postgres: `set local role <papel>`,
 * `request.jwt.claims` e `request.headers` (com `x-green-mutation-context` em
 * Base64) — o mesmo caminho que `auth.uid()` e a 0250 leem em produção. Uma
 * conexão `pg` direta (sem request) usa o GUC `green.mutation_context`.
 *
 * Nenhum writer TypeScript de `stage_id` é chamado: o que se mede é a boundary
 * do banco, que é onde os oito writers convergem.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTOMATION_CONSUMER_KEY, runAutomationForEvent } from "@/lib/automation/engine";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

/* ── fixtures (UUIDs aleatórios: nada colide com outro arquivo) ─────────────── */
const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const GERENTE = randomUUID();
const OUTRO_GERENTE = randomUUID();
const SESSAO = randomUUID();
const CONTATO = randomUUID();
const CONTATO_2 = randomUUID();
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const ETAPA_A = randomUUID();
const ETAPA_B = randomUUID();
const ETAPA_C = randomUUID();
const ETAPA_COMUM_A = randomUUID();
const ETAPA_COMUM_B = randomUUID();
const TOKEN = randomUUID();
const AGENTE = randomUUID();
const REGRA = randomUUID();

type Papel = "authenticated" | "service_role";
interface Request {
  papel: Papel;
  sub?: string;
  contexto?: Record<string, unknown> | string;
}

function b64(ctx: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(ctx), "utf8").toString("base64");
}

/** Prepara a transação de `client` como o PostgREST prepararia a request. */
async function comoRequest(client: pg.PoolClient, r: Request): Promise<void> {
  await client.query(`set local role ${r.papel}`);
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(
      r.papel === "authenticated"
        ? { sub: r.sub, role: "authenticated" }
        : { role: "service_role" },
    ),
  ]);
  const headers: Record<string, string> = { "sb-request-id": randomUUID() };
  if (r.contexto !== undefined) {
    headers["x-green-mutation-context"] =
      typeof r.contexto === "string" ? r.contexto : b64(r.contexto);
  }
  await client.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
}

/** Uma request PostgREST inteira: begin → papel/claims/headers → sql → commit. */
async function request<T extends pg.QueryResultRow = pg.QueryResultRow>(
  r: Request,
  sql: string,
  args: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await comoRequest(client, r);
    const out = await client.query<T>(sql, args);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function recusa(p: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await p;
  } catch (e) {
    return e as pg.DatabaseError;
  }
  throw new Error("a escrita devia ter sido recusada e passou");
}

async function novoLead(
  funil: string,
  etapa: string,
  contato: string | null = CONTATO,
): Promise<string> {
  // Nasce pela sessão humana (RLS + guarda Green sem contexto obrigatório).
  const { rows } = await request<{ id: string }>(
    { papel: "authenticated", sub: GERENTE },
    "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio',$4) returning id",
    [ORG, funil, etapa, contato],
  );
  return rows[0]!.id;
}

async function etapaDe(lead: string): Promise<string> {
  return (await pool.query("select stage_id from crm_leads where id=$1", [lead])).rows[0]
    .stage_id as string;
}

interface Evento {
  id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
async function eventosDe(lead: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select id, payload, metadata from event_log where event_type='lead.stage_changed' and entity_kind='crm_lead' and entity_id=$1 order by created_at, id",
    [lead],
  );
  return rows;
}

/** O que a rota humana / os writers privilegiados fazem DEPOIS do UPDATE. */
function emitLegado(lead: string, de: string, para: string, r: Request) {
  return request(
    r,
    "select public.emit_event('lead.stage_changed','crm_lead',$1, jsonb_build_object('pipeline_id',$2::uuid,'from_stage_id',$3::uuid,'to_stage_id',$4::uuid,'status','open'), $5::jsonb, $6)",
    [
      lead,
      FUNIL_GREEN,
      de,
      para,
      JSON.stringify(
        r.papel === "authenticated"
          ? { request_id: randomUUID(), actor_user_id: r.sub }
          : { actor_kind: "system", source: "legado" },
      ),
      ORG,
    ],
  );
}

const mover = (lead: string, para: string, r: Request, de?: string) =>
  request<{ id: string }>(
    r,
    `update crm_leads set stage_id=$2 where id=$1 ${de ? "and stage_id=$3" : ""} returning id`,
    de ? [lead, para, de] : [lead, para],
  );

async function fronteira(): Promise<{
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  service_revision: number;
  demanda_id: string | null;
  demanda_revision: number | null;
}> {
  const { rows } = await pool.query("select fn_service_boundary($1,$2) b", [ORG, CONVERSA]);
  const b = rows[0].b as Record<string, unknown>;
  return {
    organization_id: b.organization_id as string,
    contact_id: b.contact_id as string,
    conversation_id: b.conversation_id as string,
    service_revision: Number(b.service_revision),
    demanda_id: (b.demanda_id as string | null) ?? null,
    demanda_revision:
      b.demanda_revision === null || b.demanda_revision === undefined
        ? null
        : Number(b.demanda_revision),
  };
}
let CONVERSA: string;

beforeAll(async () => {
  await pool.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [
    GERENTE,
    `green-${GERENTE}@invariant.test`,
    OUTRO_GERENTE,
    `green-${OUTRO_GERENTE}@invariant.test`,
  ]);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Green Spike', 'Green Spike'), ($3, $4, 'Outra', 'Outra')`,
    [ORG, `green-${ORG}`, OUTRA_ORG, `outra-${OUTRA_ORG}`],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'manager',now()), ($3,$4,'manager',now())`,
    [GERENTE, ORG, OUTRO_GERENTE, OUTRA_ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values ($1,$2,$3,'\\x00'::bytea)`,
    [SESSAO, ORG, `green-${SESSAO}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name) values ($1,$2,'Green Contato'), ($3,$2,'Green Contato 2')`,
    [CONTATO, ORG, CONTATO_2],
  );
  CONVERSA = randomUUID();
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')`,
    [CONVERSA, ORG, CONTATO, SESSAO],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'Green','green-${FUNIL_GREEN.slice(0, 8)}'), ($3,$2,'Comum','comum-${FUNIL_COMUM.slice(0, 8)}')`,
    [FUNIL_GREEN, ORG, FUNIL_COMUM],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$2,$3,'A','etapa-a',1000), ($4,$2,$3,'B','etapa-b',2000), ($5,$2,$3,'C','etapa-c',3000),
       ($6,$2,$7,'A','etapa-a',1000), ($8,$2,$7,'B','etapa-b',2000)`,
    [ETAPA_A, ORG, FUNIL_GREEN, ETAPA_B, ETAPA_C, ETAPA_COMUM_A, FUNIL_COMUM, ETAPA_COMUM_B],
  );
  // O binding é o que faz o funil ser Green — existe ANTES de qualquer lead.
  await pool.query(
    `insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')`,
    [ORG, FUNIL_GREEN],
  );
});
afterAll(() => pool.end());

describe("S1 — humano / Kanban", () => {
  it("A → B: exatamente um lead.stage_changed, actor = auth.uid(), emissão legada da rota vira no-op", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    expect(await eventosDe(lead)).toHaveLength(0);
    const requestId = randomUUID();
    const humano: Request = {
      papel: "authenticated",
      sub: GERENTE,
      contexto: { v: 1, source: "kanban", request_id: requestId },
    };
    await mover(lead, ETAPA_B, humano);
    expect(await etapaDe(lead)).toBe(ETAPA_B);

    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(1);
    const [e] = eventos;
    expect(e!.metadata).toMatchObject({
      green_canonical: true,
      green_context_version: 1,
      caller: "user",
      actor: { kind: "user", id: GERENTE },
      actor_user_id: GERENTE,
      source: "kanban",
      request_id: requestId,
    });
    expect(e!.payload).toMatchObject({
      pipeline_id: FUNIL_GREEN,
      from_stage_id: ETAPA_A,
      to_stage_id: ETAPA_B,
      status: "open",
    });
    // `emit_event` derivou a origem `command` no banco, como faz hoje para a rota humana.
    expect((e!.payload.service_origin as { kind: string }).kind).toBe("command");

    // A rota do quadro ainda emite depois do UPDATE — para Green é no-op.
    await emitLegado(lead, ETAPA_A, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    expect(await eventosDe(lead)).toHaveLength(1);
  });
});

describe("S2 — header forjado pela sessão humana", () => {
  it("actor=system e service_origin no header são ignorados: o evento continua do usuário real", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const b = await fronteira();
    await mover(lead, ETAPA_B, {
      papel: "authenticated",
      sub: GERENTE,
      contexto: {
        v: 1,
        source: "forjado",
        actor: { kind: "system", id: "admin" },
        service_origin: { kind: "continuation", boundary: b },
      },
    });
    const [e] = await eventosDe(lead);
    expect(e!.metadata.actor).toEqual({ kind: "user", id: GERENTE });
    expect(e!.metadata.caller).toBe("user");
    expect((e!.payload.service_origin as { kind: string }).kind).toBe("command");
    expect(await eventosDe(lead)).toHaveLength(1);
  });

  it("membro de OUTRA organização não move o lead (RLS continua mandando; o header não autoriza)", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const { rowCount } = await mover(lead, ETAPA_B, {
      papel: "authenticated",
      sub: OUTRO_GERENTE,
      contexto: { v: 1, source: "forjado", actor: { kind: "system" } },
    });
    expect(rowCount).toBe(0);
    expect(await etapaDe(lead)).toBe(ETAPA_A);
    expect(await eventosDe(lead)).toHaveLength(0);
  });
});

describe("S3 — MCP externo (service_role + token)", () => {
  it("api_token move: actor técnico correto no evento canônico; emissão legada do handler vira no-op", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const mcp: Request = {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "mcp",
        request_id: randomUUID(),
        actor: { kind: "api_token", id: TOKEN, api_token_id: TOKEN },
      },
    };
    await mover(lead, ETAPA_B, mcp);
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      caller: "service_role",
      source: "mcp",
      actor: { kind: "api_token", id: TOKEN, api_token_id: TOKEN },
      actor_kind: "api_token",
    });
    expect(e!.metadata).not.toHaveProperty("actor_user_id");
    await emitLegado(lead, ETAPA_A, ETAPA_B, { papel: "service_role" });
    expect(await eventosDe(lead)).toHaveLength(1);
  });

  it("ai_agent pelo token: agent_id e api_token_id viajam", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "mcp",
        actor: { kind: "ai_agent", id: "run-1", agent_id: AGENTE, api_token_id: TOKEN },
      },
    });
    const [e] = await eventosDe(lead);
    expect(e!.metadata.actor).toEqual({
      kind: "ai_agent",
      id: "run-1",
      agent_id: AGENTE,
      api_token_id: TOKEN,
    });
  });

  it("actor.kind=user NÃO nasce de header service_role (fail-closed)", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const erro = await recusa(
      mover(lead, ETAPA_B, {
        papel: "service_role",
        contexto: { v: 1, source: "mcp", actor: { kind: "user", id: GERENTE } },
      }),
    );
    expect(erro.code).toBe("42501");
    expect(erro.detail).toBe("actor_kind");
    expect(await etapaDe(lead)).toBe(ETAPA_A);
  });
});

describe("S4 — automação: causation preservada, sem loop", () => {
  it("a regra move com request_id=rule:<id> + causation; o evento canônico não reexecuta a regra", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    // O evento E que disparou a regra (humano moveu A → B).
    await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [E] = await eventosDe(lead);
    // A regra R move B → C pelo `moveLeadHandler` (service_role) com o contexto que o motor amarra.
    await mover(lead, ETAPA_C, {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "automation",
        request_id: `rule:${REGRA}`,
        causation_event_id: E!.id,
        actor: { kind: "webhook_source", id: REGRA },
        service_origin: {
          kind: "event",
          event_id: E!.id,
          organization_id: ORG,
          contact_id: CONTATO,
        },
      },
    });
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(2);
    const canonico = eventos[1]!;
    expect(canonico.metadata).toMatchObject({
      request_id: `rule:${REGRA}`,
      causation_event_id: E!.id,
      source: "automation",
      actor: { kind: "webhook_source", id: REGRA },
    });
    expect(canonico.payload.service_origin).toEqual({
      kind: "event",
      event_id: E!.id,
      organization_id: ORG,
      contact_id: CONTATO,
    });

    // Anti-loop: o motor real, alimentado com a linha canônica, pula sem consultar nada.
    const nuncaChamado = {
      from: () => {
        throw new Error("o motor consultou o banco num evento causado por regra");
      },
    } as never;
    const r = await runAutomationForEvent(nuncaChamado, {
      id: canonico.id,
      organization_id: ORG,
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: lead,
      payload: canonico.payload,
      metadata: canonico.metadata,
      consumed_by: [],
      attempts: 0,
    });
    expect(r).toEqual({
      consumer_key: AUTOMATION_CONSUMER_KEY,
      status: "skipped",
      detail: "caused_by_rule",
    });
  });

  it("service_origin por evento de OUTRO contato/organização é recusada (não degrada em silêncio)", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [E] = await eventosDe(lead);
    const erro = await recusa(
      mover(lead, ETAPA_C, {
        papel: "service_role",
        contexto: {
          v: 1,
          source: "automation",
          actor: { kind: "webhook_source", id: REGRA },
          service_origin: {
            kind: "event",
            event_id: E!.id,
            organization_id: ORG,
            contact_id: CONTATO_2,
          },
        },
      }),
    );
    expect(erro.message).toBe("green_service_origin_scope_mismatch");
    expect(await etapaDe(lead)).toBe(ETAPA_B);
    expect(await eventosDe(lead)).toHaveLength(1);
  });
});

describe("S5 — agent stage sync (IA move; CAS continua)", () => {
  it("source/actor do agente e a continuação de atendimento chegam ao evento", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const b = await fronteira();
    const ia: Request = {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "agent_runtime",
        source_job_id: "job-1",
        actor: { kind: "ai_agent", id: "run-7", agent_id: AGENTE },
        service_origin: { kind: "continuation", boundary: b },
      },
    };
    // compare-and-set pela etapa de origem, como `sincronizaEstagioDoAgente` faz
    const { rowCount } = await mover(lead, ETAPA_B, ia, ETAPA_A);
    expect(rowCount).toBe(1);
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      source: "agent_runtime",
      source_job_id: "job-1",
      actor: { kind: "ai_agent", id: "run-7", agent_id: AGENTE },
    });
    expect(e!.payload.service_origin).toEqual({ kind: "continuation", boundary: b });
  });

  it("um humano moveu antes: o CAS do agente não casa, nada muda e nenhum evento nasce", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_C, { papel: "authenticated", sub: GERENTE }); // humano venceu
    const { rowCount } = await mover(
      lead,
      ETAPA_B,
      {
        papel: "service_role",
        contexto: { v: 1, source: "agent_runtime", actor: { kind: "ai_agent", id: "run-8" } },
      },
      ETAPA_A,
    );
    expect(rowCount).toBe(0);
    expect(await etapaDe(lead)).toBe(ETAPA_C);
    expect(await eventosDe(lead)).toHaveLength(1);
  });
});

describe("S6 — handoff: boundary válida move; boundary stale recusa", () => {
  it("fronteira vigente move; fronteira com service_revision velha não muda a etapa", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const b = await fronteira();
    const handoff = (boundary: typeof b): Request => ({
      papel: "service_role",
      contexto: {
        v: 1,
        source: "handoff",
        actor: { kind: "system", id: "handoff-orchestrator" },
        service_origin: { kind: "continuation", boundary },
      },
    });
    await mover(lead, ETAPA_B, handoff(b), ETAPA_A);
    expect(await etapaDe(lead)).toBe(ETAPA_B);
    expect((await eventosDe(lead))[0]!.payload.service_origin).toEqual({
      kind: "continuation",
      boundary: b,
    });

    const stale = { ...b, service_revision: b.service_revision + 1 };
    const erro = await recusa(mover(lead, ETAPA_C, handoff(stale), ETAPA_B));
    expect(erro.message).toBe("service_boundary_stale");
    expect(erro.code).toBe("40001");
    expect(await etapaDe(lead)).toBe(ETAPA_B);
    expect(await eventosDe(lead)).toHaveLength(1);
  });

  it("fronteira de OUTRO contato é recusada antes de olhar a conversa", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A, CONTATO_2);
    const b = await fronteira(); // fronteira do CONTATO, lead é do CONTATO_2
    const erro = await recusa(
      mover(lead, ETAPA_B, {
        papel: "service_role",
        contexto: {
          v: 1,
          source: "handoff",
          actor: { kind: "system" },
          service_origin: { kind: "continuation", boundary: b },
        },
      }),
    );
    expect(erro.message).toBe("green_service_origin_scope_mismatch");
    expect(await etapaDe(lead)).toBe(ETAPA_A);
  });
});

describe("S7 — agenda: stage move originado de agendamento é atômico", () => {
  it("dentro da transação o evento já existe; o commit leva os dois; o rollback desfaz os dois", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const agenda: Request = {
      papel: "service_role",
      contexto: { v: 1, source: "agenda", actor: { kind: "system", id: "appointment-stage-move" } },
    };

    const client = await pool.connect();
    try {
      await client.query("begin");
      await comoRequest(client, agenda);
      await client.query("update crm_leads set stage_id=$2 where id=$1 and stage_id=$3", [
        lead,
        ETAPA_B,
        ETAPA_A,
      ]);
      const dentro = await client.query(
        "select count(*)::int n from event_log where entity_id=$1 and event_type='lead.stage_changed'",
        [lead],
      );
      expect(dentro.rows[0].n).toBe(1);
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect(await etapaDe(lead)).toBe(ETAPA_A);
    expect(await eventosDe(lead)).toHaveLength(0);

    await mover(lead, ETAPA_B, agenda, ETAPA_A);
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      source: "agenda",
      actor: { kind: "system", id: "appointment-stage-move" },
    });
  });
});

describe("S8 — bulk humano", () => {
  it("N leads → N eventos canônicos pela função de lote; a emissão legada por lead não duplica", async () => {
    const leads = [
      await novoLead(FUNIL_GREEN, ETAPA_A),
      await novoLead(FUNIL_GREEN, ETAPA_A),
      await novoLead(FUNIL_GREEN, ETAPA_A),
    ];
    const { rows } = await request<{ lead_id: string; from_stage_id: string }>(
      {
        papel: "authenticated",
        sub: GERENTE,
        contexto: { v: 1, source: "bulk", request_id: randomUUID() },
      },
      "select * from public.fn_mover_leads_em_lote($1, $2::uuid[], $3)",
      [ORG, leads, ETAPA_B],
    );
    expect(rows.map((r) => r.lead_id).sort()).toEqual([...leads].sort());
    expect(rows.every((r) => r.from_stage_id === ETAPA_A)).toBe(true);
    for (const lead of leads) {
      const eventos = await eventosDe(lead);
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.metadata).toMatchObject({
        green_canonical: true,
        actor: { kind: "user", id: GERENTE },
        source: "bulk",
      });
      await emitLegado(lead, ETAPA_A, ETAPA_B, { papel: "authenticated", sub: GERENTE });
      expect(await eventosDe(lead)).toHaveLength(1);
    }
  });
});

describe("S9 — arquivamento de etapa", () => {
  it("o UPDATE em massa do arquivamento gera um evento canônico por card, embora o writer nunca tenha emitido", async () => {
    const origem = randomUUID();
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'Velha',$4,4000)",
      [origem, ORG, FUNIL_GREEN, `velha-${origem.slice(0, 6)}`],
    );
    const leads = [await novoLead(FUNIL_GREEN, origem), await novoLead(FUNIL_GREEN, origem)];
    // exatamente o UPDATE de `arquivarEtapa` (stage-operations.ts), pela sessão humana
    const { rowCount } = await request(
      { papel: "authenticated", sub: GERENTE, contexto: { v: 1, source: "stage_archive" } },
      "update crm_leads set stage_id=$3 where organization_id=$1 and stage_id=$2",
      [ORG, origem, ETAPA_B],
    );
    expect(rowCount).toBe(2);
    for (const lead of leads) {
      const eventos = await eventosDe(lead);
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.payload).toMatchObject({ from_stage_id: origem, to_stage_id: ETAPA_B });
      expect(eventos[0]!.metadata).toMatchObject({
        source: "stage_archive",
        actor: { kind: "user", id: GERENTE },
      });
    }
  });
});

describe("S10 — rollback: evento falha ⇒ stage não muda", () => {
  it("uma falha forçada na gravação do evento canônico desfaz o UPDATE inteiro", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await pool.query(`
      create or replace function public.fn_spike_green_sabotagem() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'lead.stage_changed' and coalesce(new.metadata->>'green_canonical','') = 'true'
           and new.payload->>'to_stage_id' = '${ETAPA_C}' then
          raise exception 'sabotagem_do_evento_canonico';
        end if;
        return new;
      end $$;
      create trigger trg_zz_spike_green_sabotagem before insert on public.event_log for each row execute function public.fn_spike_green_sabotagem();
    `);
    try {
      const erro = await recusa(mover(lead, ETAPA_C, { papel: "authenticated", sub: GERENTE }));
      expect(erro.message).toBe("sabotagem_do_evento_canonico");
      expect(await etapaDe(lead)).toBe(ETAPA_A);
      expect(await eventosDe(lead)).toHaveLength(0);
      // controle: sem sabotagem (outro destino) o mesmo lead move e ganha o evento
      await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
      expect(await eventosDe(lead)).toHaveLength(1);
    } finally {
      await pool.query(
        "drop trigger if exists trg_zz_spike_green_sabotagem on public.event_log; drop function if exists public.fn_spike_green_sabotagem();",
      );
    }
  });
});

describe("S11 — lead não-Green: comportamento upstream idêntico", () => {
  it("service_role sem contexto move; nenhum evento canônico; a emissão legada continua nascendo", async () => {
    const lead = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    await mover(lead, ETAPA_COMUM_B, { papel: "service_role" });
    expect(await etapaDe(lead)).toBe(ETAPA_COMUM_B);
    expect(await eventosDe(lead)).toHaveLength(0);
    await request(
      { papel: "service_role" },
      "select public.emit_event('lead.stage_changed','crm_lead',$1, jsonb_build_object('from_stage_id',$2::uuid,'to_stage_id',$3::uuid), '{\"actor_kind\":\"system\"}'::jsonb, $4)",
      [lead, ETAPA_COMUM_A, ETAPA_COMUM_B, ORG],
    );
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.metadata).not.toHaveProperty("green_canonical");
  });

  it("humano move lead comum: nenhum evento canônico, emissão da rota nasce como sempre", async () => {
    const lead = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    await mover(lead, ETAPA_COMUM_B, {
      papel: "authenticated",
      sub: GERENTE,
      contexto: { v: 1, source: "kanban" },
    });
    expect(await eventosDe(lead)).toHaveLength(0);
    await request(
      { papel: "authenticated", sub: GERENTE },
      "select public.emit_event('lead.stage_changed','crm_lead',$1, jsonb_build_object('from_stage_id',$2::uuid,'to_stage_id',$3::uuid), '{}'::jsonb, $4)",
      [lead, ETAPA_COMUM_A, ETAPA_COMUM_B, ORG],
    );
    expect(await eventosDe(lead)).toHaveLength(1);
  });

  it("os hooks são no-op quando o funil não tem binding (função de decisão)", async () => {
    const { rows } = await pool.query(
      "select green.fn_is_green_pipeline($1,$2) g, green.fn_is_green_pipeline($1,$3) c",
      [ORG, FUNIL_GREEN, FUNIL_COMUM],
    );
    expect(rows[0]).toEqual({ g: true, c: false });
  });
});

describe("S12 — service_role sem contexto", () => {
  it("lead Green recusa fechado (42501); header inválido também; lead comum segue", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const semContexto = await recusa(mover(lead, ETAPA_B, { papel: "service_role" }));
    expect(semContexto.code).toBe("42501");
    expect(semContexto.message).toBe("green_mutation_context_required");
    expect(semContexto.detail).toBe("missing");

    const semSource = await recusa(
      mover(lead, ETAPA_B, {
        papel: "service_role",
        contexto: { v: 1, actor: { kind: "system" } },
      }),
    );
    expect(semSource.detail).toBe("source");
    const semActor = await recusa(
      mover(lead, ETAPA_B, { papel: "service_role", contexto: { v: 1, source: "x" } }),
    );
    expect(semActor.detail).toBe("actor_required");
    const lixo = await recusa(
      mover(lead, ETAPA_B, { papel: "service_role", contexto: "isto-nao-e-base64-de-json" }),
    );
    expect(lixo.detail).toBe("undecodable_header");
    const pii = await recusa(
      mover(lead, ETAPA_B, {
        papel: "service_role",
        contexto: { v: 1, source: "x", actor: { kind: "system" }, phone: "+55" },
      }),
    );
    expect(pii.detail).toBe("unknown_key");

    expect(await etapaDe(lead)).toBe(ETAPA_A);
    expect(await eventosDe(lead)).toHaveLength(0);

    // INSERT privilegiado em funil Green também exige contexto
    const insercao = await recusa(
      request(
        { papel: "service_role" },
        "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'x')",
        [ORG, FUNIL_GREEN, ETAPA_A],
      ),
    );
    expect(insercao.code).toBe("42501");

    // conexão pg direta (sem request): o GUC transacional é o transporte
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('green.mutation_context', $1, true)", [
        JSON.stringify({ v: 1, source: "worker_pg", actor: { kind: "system", id: "worker" } }),
      ]);
      await client.query("update crm_leads set stage_id=$2 where id=$1", [lead, ETAPA_B]);
      await client.query("commit");
    } finally {
      client.release();
    }
    const [e] = await eventosDe(lead);
    expect(e!.metadata).toMatchObject({
      caller: "direct",
      source: "worker_pg",
      actor: { kind: "system", id: "worker" },
    });
    // e sem o GUC a conexão direta também é recusada em lead Green
    const direta = await recusa(
      pool.query("update crm_leads set stage_id=$2 where id=$1", [lead, ETAPA_C]),
    );
    expect(direta.code).toBe("42501");
  });
});

describe("S13 — concorrência de contexto no banco", () => {
  it("duas transações intercaladas com contextos diferentes: nenhum evento recebe o contexto da outra", async () => {
    const leadA = await novoLead(FUNIL_GREEN, ETAPA_A);
    const leadB = await novoLead(FUNIL_GREEN, ETAPA_A);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      await comoRequest(a, {
        papel: "service_role",
        contexto: {
          v: 1,
          source: "ctx_a",
          request_id: "req-a",
          actor: { kind: "api_token", id: "tok-a" },
        },
      });
      await comoRequest(b, {
        papel: "service_role",
        contexto: {
          v: 1,
          source: "ctx_b",
          request_id: "req-b",
          actor: { kind: "ai_agent", id: "run-b" },
        },
      });
      await a.query("update crm_leads set stage_id=$2 where id=$1", [leadA, ETAPA_B]);
      await b.query("update crm_leads set stage_id=$2 where id=$1", [leadB, ETAPA_B]);
      await b.query("commit");
      await a.query("commit");
    } finally {
      a.release();
      b.release();
    }
    expect((await eventosDe(leadA))[0]!.metadata).toMatchObject({
      source: "ctx_a",
      request_id: "req-a",
      actor: { kind: "api_token", id: "tok-a" },
    });
    expect((await eventosDe(leadB))[0]!.metadata).toMatchObject({
      source: "ctx_b",
      request_id: "req-b",
      actor: { kind: "ai_agent", id: "run-b" },
    });
  });
});

describe("S14 — idempotency metadata", () => {
  it("idempotency_key é preservada no evento; NÃO há exactly-once (o replay gera segundo evento)", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const chave = randomUUID();
    const ctx: Request = {
      papel: "service_role",
      contexto: {
        v: 1,
        source: "mcp",
        idempotency_key: chave,
        correlation_id: chave,
        actor: { kind: "api_token", id: TOKEN },
      },
    };
    await mover(lead, ETAPA_B, ctx);
    expect((await eventosDe(lead))[0]!.metadata).toMatchObject({
      idempotency_key: chave,
      correlation_id: chave,
    });
    // replay honesto: a boundary não deduplica — isso é o próximo EV (ledger durável)
    await mover(lead, ETAPA_A, ctx);
    expect(await eventosDe(lead)).toHaveLength(2);
  });
});

describe("guarda de binding de etapa (BEFORE)", () => {
  it("etapa de outro funil é recusada para lead Green, antes de qualquer evento", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const erro = await recusa(mover(lead, ETAPA_COMUM_B, { papel: "authenticated", sub: GERENTE }));
    expect(erro.message).toBe("green_stage_not_bound");
    expect(await etapaDe(lead)).toBe(ETAPA_A);
    expect(await eventosDe(lead)).toHaveLength(0);
  });
});
