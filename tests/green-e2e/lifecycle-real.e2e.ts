/**
 * SPIKE-GREEN-01 (descartável) — E2E PostgREST REAL do lifecycle.
 *
 *   código real (server action / lib) → createAdminClient real → fetchDoServidor
 *   (header Green do escopo ALS) → HTTP → Kong/PostgREST do stack local →
 *   Postgres → trigger `green.fn_crm_lead_boundary` → event_log
 *
 * O mesmo arquivo roda com o stack na v3 (0502) e depois da 0503: as asserções
 * comparam um RETRATO inteiro (contagens por tabela antes/depois, resultado da
 * action, retry), então na v3 a falha imprime exatamente o que foi apagado
 * antes da recusa, onde parou e o que sobrou — a evidência da zona de perigo.
 *
 * `pg` só monta fixtures e lê o resultado. Nenhuma credencial no Git: as
 * variáveis `GREEN_E2E_*` são exportadas por tooling a partir do stack local
 * (ver o cabeçalho de `tests/green-e2e/postgrest-real.e2e.ts`). Sem elas, pula.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-e2e-zona-de-perigo" }),
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));
const sessao = vi.hoisted(() => ({ userId: "", orgId: "" }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: sessao.userId, is_platform_admin: false, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: sessao.orgId, name: "Org", role: "admin" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { apagarDadosOperacionaisDaOrg } from "@/lib/settings/apagar-dados-operacionais";
import { createAdminClient } from "@/lib/supabase/admin";

const STACK = {
  url: process.env.GREEN_E2E_SUPABASE_URL ?? "",
  service: process.env.GREEN_E2E_SERVICE_ROLE_KEY ?? "",
  db: process.env.GREEN_E2E_DB_URL ?? "",
};
const TEM_STACK = Boolean(STACK.url && STACK.service && STACK.db);
const d = TEM_STACK ? describe : describe.skip;

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://127.0.0.1:1/x", max: 4 });
afterAll(() => pool.end());

interface Tenant {
  org: string;
  nome: string;
  admin: string;
  contato: string;
  conversa: string;
  funilGreen: string;
  etapaG1: string;
  funilComum: string;
  etapaC1: string;
}

async function tenant(greenPadrao: boolean): Promise<Tenant> {
  const t: Tenant = {
    org: randomUUID(),
    nome: `E2E Lifecycle ${randomUUID().slice(0, 8)}`,
    admin: randomUUID(),
    contato: randomUUID(),
    conversa: randomUUID(),
    funilGreen: randomUUID(),
    etapaG1: randomUUID(),
    funilComum: randomUUID(),
    etapaC1: randomUUID(),
  };
  const sessaoCanal = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1,$2)", [
    t.admin,
    `lc-${t.admin}@spike.test`,
  ]);
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,$3,$3)",
    [t.org, `lc-e2e-${t.org}`, t.nome],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin',now())",
    [t.admin, t.org],
  );
  await pool.query(
    "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
    [sessaoCanal, t.org, `lc-e2e-${sessaoCanal}`],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,'Cliente E2E',$3)",
    [t.contato, t.org, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "7")}`],
  );
  await pool.query(
    "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')",
    [t.conversa, t.org, t.contato, sessaoCanal],
  );
  await pool.query(
    "insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, external_id) values ($1,$2,$3,$4,'text','inbound','received','oi',$5)",
    [t.org, t.conversa, sessaoCanal, t.contato, `wa-${randomUUID()}`],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default) values
       ($1,$2,'Green','green-${t.funilGreen.slice(0, 8)}',false), ($3,$2,'Comum','comum-${t.funilComum.slice(0, 8)}',false)`,
    [t.funilGreen, t.org, t.funilComum],
  );
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [t.org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [
    greenPadrao ? t.funilGreen : t.funilComum,
  ]);
  await pool.query(
    "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'G1','g1',1000), ($4,$2,$5,'C1','c1',1000)",
    [t.etapaG1, t.org, t.funilGreen, t.etapaC1, t.funilComum],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [t.org, t.funilGreen],
  );
  return t;
}

async function leadComoDono(t: Tenant, funil: string, etapa: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await c.query(
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio E2E',$4) returning id",
      [t.org, funil, etapa, t.contato],
    );
    await c.query("commit");
    return rows[0].id as string;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function retrato(org: string, green: string, comum: string) {
  const n = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].n);
  return {
    messages: await n("select count(*) n from messages where organization_id=$1", [org]),
    conversations: await n("select count(*) n from conversations where organization_id=$1", [org]),
    lead_green: await n("select count(*) n from crm_leads where id=$1", [green]),
    lead_comum: await n("select count(*) n from crm_leads where id=$1", [comum]),
    contacts: await n("select count(*) n from contacts where organization_id=$1", [org]),
    lapides_done: await n(
      "select count(*) n from event_log where entity_id=$1 and event_type='lead.deleted' and status='done'",
      [green],
    ),
  };
}
const ZERADO = {
  messages: 0,
  conversations: 0,
  lead_green: 0,
  lead_comum: 0,
  contacts: 0,
  lapides_done: 1,
};

d("E2E lifecycle — PostgREST real", () => {
  beforeAll(async () => {
    // o PostgREST recém-recarregado pode estar com o cache de schema velho
    await pool.query("notify pgrst, 'reload schema'");
    await new Promise((r) => setTimeout(r, 1500));
  });

  it("L2 zona de perigo pela action real: termina, converge no retry e deixa lápide `done` (retrato antes/depois)", async () => {
    const t = await tenant(false);
    const green = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const comum = await leadComoDono(t, t.funilComum, t.etapaC1);
    sessao.userId = t.admin;
    sessao.orgId = t.org;

    const antes = await retrato(t.org, green, comum);
    const r1 = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: t.nome });
    const depois1 = await retrato(t.org, green, comum);
    const r2 = await apagarDadosOperacionaisDaOrganizacao({ confirmNome: t.nome });
    const depois2 = await retrato(t.org, green, comum);

    expect(antes).toEqual({
      messages: 1,
      conversations: 1,
      lead_green: 1,
      lead_comum: 1,
      contacts: 1,
      lapides_done: 0,
    });
    expect({
      r1: r1.ok ? "ok" : `${r1.error}: ${String(r1.details)}`,
      depois1,
      r2: r2.ok ? "ok" : `${r2.error}: ${String(r2.details)}`,
      depois2,
    }).toEqual({ r1: "ok", depois1: ZERADO, r2: "ok", depois2: ZERADO });
  });

  it("L2 DELETE de serviço SEM contexto pela lib: a recusa não deixa perda irreversível (retrato antes/depois)", async () => {
    const t = await tenant(false);
    const green = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const comum = await leadComoDono(t, t.funilComum, t.etapaC1);
    const antes = await retrato(t.org, green, comum);
    const r = await apagarDadosOperacionaisDaOrg(createAdminClient(), t.org);
    const depois = await retrato(t.org, green, comum);
    expect({ ok: r.ok, falha: r.ok ? null : r.falha.mensagem, depois }).toEqual({
      ok: false,
      falha: expect.stringContaining("green_mutation_context_required"),
      depois: antes,
    });
  });

  it("L1 canal (WAHA/Meta/Zernio/voz) pelo PostgREST real: a conversa vira lead Green com proveniência", async () => {
    const t = await tenant(true);
    const r = await garantirLeadDaConversa(createAdminClient(), {
      organizationId: t.org,
      contactId: t.contato,
      conversationId: t.conversa,
      nomeDoContato: "Cliente E2E",
    });
    expect(r).toMatchObject({ criado: true, pipelineId: t.funilGreen });
    if (!r.criado) return;
    const existe = (
      await pool.query("select to_regclass('green.lead_birth_provenance') is not null e")
    ).rows[0].e;
    const nasc = existe
      ? (
          await pool.query(
            "select caller, trusted from green.lead_birth_provenance where lead_id=$1",
            [r.leadId],
          )
        ).rows
      : [];
    expect(nasc).toEqual([
      {
        caller: "service_role",
        trusted: expect.objectContaining({
          source: "canal.ingest",
          actor: { kind: "webhook_source", id: "canal-inbound" },
        }),
      },
    ]);
  });

  it("L3 estoque do stack: nenhuma lápide `lead.deleted` fica `pending` (nem as que a v3 deixou)", async () => {
    const { rows } = await pool.query(
      "select status, count(*)::int n from event_log where event_type='lead.deleted' group by status order by status",
    );
    expect(rows.filter((r) => r.status === "pending")).toEqual([]);
  });
});
