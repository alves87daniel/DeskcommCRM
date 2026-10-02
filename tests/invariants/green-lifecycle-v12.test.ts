/**
 * SPIKE-GREEN-01.2 — correções da AUDIT-GREEN-01.1 (DESCARTÁVEL).
 *
 * Três achados, três famílias de caso. Arquivo NOVO: nenhum teste da v1/v2/v3 ou
 * do lifecycle v1 é reescrito. Mesmo arquivo contra a v1 (`3ac8fa7`) e a v1.2.
 *
 *   R2  LIFE-ADV-02  o `x-request-id` do cliente nunca vira `trusted.request_id`
 *                    (e `causadoPorRegra` não é influenciado);
 *   R3  LIFE-ADV-03  o UUID de uma Opportunity Green NÃO é reciclável: depois de
 *                    participar do lifecycle, não representa outro lead;
 *   R4  LIFE-ADV-04  a zona de perigo isola por organização, provado pelo
 *                    COMPORTAMENTO (as sete raízes populadas em A e B; B intacta
 *                    byte a byte), e não pela leitura do texto SQL.
 *
 * Código sob teste REAL contra o banco real (`green-postgrest-shim.ts`): a server
 * action da zona de perigo roda sob `AsyncLocalStorage` com o header `x-request-id`
 * de cada caso, como o Next a executa.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clientePostgrest, type ChamadaRegistrada } from "./green-postgrest-shim";

import type { AsyncLocalStorage } from "node:async_hooks";

interface Cenario {
  userId: string;
  orgId: string;
  requestId: string | null;
}
const gancho = vi.hoisted(() => ({ als: null as null | AsyncLocalStorage<Cenario> }));
const cenario = () => {
  const c = gancho.als?.getStore();
  if (!c) throw new Error("ação chamada fora de um cenário (use `apagarComo`)");
  return c;
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => {
    const id = cenario().requestId;
    return new Headers(id === null ? {} : { "x-request-id": id });
  },
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: cenario().userId,
    is_platform_admin: false,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: cenario().orgId, name: "Org", role: "admin" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { createAdminClient } from "@/lib/supabase/admin";
import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
import { causadoPorRegra } from "@/lib/green/proveniencia";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 8,
});
const chamadas: ChamadaRegistrada[] = [];
const admin = () => clientePostgrest(pool, { papel: "service_role" }, chamadas);

beforeAll(async () => {
  const { AsyncLocalStorage: ALS } = await import("node:async_hooks");
  gancho.als = new ALS<Cenario>();
  vi.mocked(createAdminClient).mockImplementation(admin);
});
beforeEach(() => {
  chamadas.length = 0;
});
afterAll(() => pool.end());

/* ── requests no formato do PostgREST (mesmo harness do lifecycle v1) ─────── */
type Papel = "authenticated" | "service_role";
interface Request {
  papel: Papel;
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

const servico = (extra: Record<string, unknown> = {}): Request => ({
  papel: "service_role",
  contexto: {
    v: 1,
    source: "mcp",
    request_id: `req-${randomUUID()}`,
    actor: { kind: "api_token", id: "tok-1", api_token_id: "tok-1" },
    ...extra,
  },
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */
interface Tenant {
  org: string;
  nome: string;
  admin: string;
  sessaoCanal: string;
  contato: string;
  conversa: string;
  funilGreen: string;
  etapaG1: string;
  etapaG2: string;
  funilComum: string;
  etapaC1: string;
}

async function tenant(): Promise<Tenant> {
  const t: Tenant = {
    org: randomUUID(),
    nome: `Org ${randomUUID().slice(0, 8)}`,
    admin: randomUUID(),
    sessaoCanal: randomUUID(),
    contato: randomUUID(),
    conversa: randomUUID(),
    funilGreen: randomUUID(),
    etapaG1: randomUUID(),
    etapaG2: randomUUID(),
    funilComum: randomUUID(),
    etapaC1: randomUUID(),
  };
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    t.admin,
    `adm-${t.admin}@v12.test`,
  ]);
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [t.org, `v12-${t.org}`, t.nome],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin',now())",
    [t.admin, t.org],
  );
  await pool.query(
    "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
    [t.sessaoCanal, t.org, `v12-${t.sessaoCanal}`],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,'Maria Green',$3)",
    [t.contato, t.org, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
  );
  await pool.query(
    "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')",
    [t.conversa, t.org, t.contato, t.sessaoCanal],
  );
  await pool.query(
    "insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, external_id) values ($1,$2,$3,$4,'text','inbound','received','oi',$5)",
    [t.org, t.conversa, t.sessaoCanal, t.contato, `wa-${randomUUID()}`],
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
       ($1,$2,$3,'G1','g1',1000), ($4,$2,$3,'G2','g2',2000), ($5,$2,$6,'C1','c1',1000)`,
    [t.etapaG1, t.org, t.funilGreen, t.etapaG2, t.etapaC1, t.funilComum],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [t.org, t.funilGreen],
  );
  return t;
}

async function leadComoDono(t: Tenant, funil: string, etapa: string, id?: string) {
  const { rows } = await comoDono(
    "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values (coalesce($5::uuid, gen_random_uuid()),$1,$2,$3,'Negócio',$4) returning id",
    [t.org, funil, etapa, t.contato, id ?? null],
  );
  return rows[0].id as string;
}

const contar = async (sql: string, args: unknown[]) =>
  Number((await pool.query(sql, args)).rows[0].n);

interface Evento {
  metadata: Record<string, unknown>;
}
async function lapidesDe(id: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select metadata from event_log where entity_kind='crm_lead' and entity_id=$1 and event_type='lead.deleted' order by created_at, id",
    [id],
  );
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sanear = (v: string) => v.slice(0, 128).replace(/[^A-Za-z0-9_.:-]/g, "_");

/* ═══ R2 — LIFE-ADV-02: o x-request-id do cliente não é confiável ═══════════ */
describe("R2 — LIFE-ADV-02: `x-request-id` do cliente nunca vira `trusted.request_id`", () => {
  const apagarComo = (t: Tenant, requestId: string | null) =>
    gancho.als!.run({ userId: t.admin, orgId: t.org, requestId }, () =>
      apagarDadosOperacionaisDaOrganizacao({ confirmNome: t.nome }),
    );

  const CABECALHOS: Array<[string, string | null]> = [
    ["sem header", null],
    ["UUID", randomUUID()],
    ["arbitrário", "abc-123"],
    ["rule:*", "rule:forjado-pelo-humano"],
    ["automation", "automation"],
    ["muito grande (5000 caracteres)", "x".repeat(5000)],
  ];

  it.each(CABECALHOS)(
    "zona de perigo com x-request-id %s: a lápide tem id de servidor, o anti-loop não é influenciado",
    async (_nome, cliente) => {
      const t = await tenant();
      const lead = await leadComoDono(t, t.funilGreen, t.etapaG1);
      const r = await apagarComo(t, cliente);
      expect(r).toMatchObject({ ok: true });

      const [lapide] = await lapidesDe(lead);
      expect(lapide).toBeDefined();
      const green = lapide!.metadata.green as {
        trusted: Record<string, unknown>;
        advisory: Record<string, unknown>;
      };

      // a confiança vem da origem: id gerado no servidor, qualquer que seja o header
      expect(String(green.trusted.request_id)).toMatch(UUID);
      if (cliente !== null) expect(green.trusted.request_id).not.toBe(cliente);
      expect(String(lapide!.metadata.request_id)).toMatch(UUID);
      // o anti-loop (`causadoPorRegra`) não é influenciado pelo cliente
      expect(causadoPorRegra(lapide!.metadata)).toBe(false);
      // o valor do cliente continua correlacionável, só como advisory
      if (cliente !== null) {
        expect(green.advisory.client_request_id).toBe(sanear(cliente));
        // advisory nunca aparece no topo da metadata (o topo é só trusted)
        expect(JSON.stringify(lapide!.metadata.request_id)).not.toContain(sanear(cliente));
      }
      const { rows } = await pool.query(
        "select request_id, advisory_request_id from green.stage_event_ledger where lead_id=$1 and kind='deleted'",
        [lead],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].request_id).toMatch(UUID);
      if (cliente !== null) expect(rows[0].advisory_request_id).toBe(sanear(cliente));
    },
  );

  it("C1 — `x-request-id: rule:forjado-pelo-humano` NÃO faz o anti-loop ler o apagamento como causado por regra", async () => {
    const t = await tenant();
    const lead = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await apagarComo(t, "rule:forjado-pelo-humano");
    const [lapide] = await lapidesDe(lead);
    const green = lapide!.metadata.green as { trusted: Record<string, unknown> };
    // as duas leituras que o defeito da auditoria afetava, isoladas de qualquer outra asserção
    expect(green.trusted.request_id).not.toBe("rule:forjado-pelo-humano");
    expect(causadoPorRegra(lapide!.metadata)).toBe(false);
  });

  it("chamadas simultâneas com headers forjados diferentes: cada lápide tem o próprio id de servidor e nenhuma é lida como regra", async () => {
    const tenants = await Promise.all([tenant(), tenant(), tenant(), tenant()]);
    const leads = await Promise.all(
      tenants.map((t) => leadComoDono(t, t.funilGreen, t.etapaG1)),
    );
    const forjados = tenants.map((_, i) => `rule:forjado-${i}`);
    await Promise.all(tenants.map((t, i) => apagarComo(t, forjados[i]!)));
    const ids = new Set<string>();
    for (const [i, lead] of leads.entries()) {
      const [lapide] = await lapidesDe(lead);
      const green = lapide!.metadata.green as { trusted: Record<string, unknown> };
      expect(green.trusted.request_id).toMatch(UUID);
      expect(causadoPorRegra(lapide!.metadata)).toBe(false);
      expect((lapide!.metadata.green as { advisory: Record<string, unknown> }).advisory.client_request_id).toBe(
        forjados[i],
      );
      ids.add(String(green.trusted.request_id));
    }
    expect(ids.size).toBe(tenants.length);
  });

  it("controle (backend): `rule:<id>` ENVIADO PELO BACKEND (motor de automação) continua sendo causa de regra", async () => {
    const t = await tenant();
    const lead = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await request(
      servico({
        source: "automation",
        request_id: `rule:${randomUUID()}`,
        actor: { kind: "system", id: "motor" },
      }),
      "delete from crm_leads where id=$1",
      [lead],
    );
    const [lapide] = await lapidesDe(lead);
    expect(causadoPorRegra(lapide!.metadata)).toBe(true);
  });

  it("controle (humano): sessão humana com `request_id=rule:*` no header continua só em advisory", async () => {
    const t = await tenant();
    const lead = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await request(
      {
        papel: "authenticated",
        sub: t.admin,
        contexto: { v: 1, source: "kanban", request_id: "rule:forjado", actor: { kind: "system", id: "x" } },
      },
      "delete from crm_leads where id=$1",
      [lead],
    );
    const [lapide] = await lapidesDe(lead);
    expect(causadoPorRegra(lapide!.metadata)).toBe(false);
    const green = lapide!.metadata.green as { trusted: Record<string, unknown> };
    expect(green.trusted.request_id).toBeUndefined();
  });
});

/* ═══ R3 — LIFE-ADV-03: o UUID de lead Green não é reciclável ═══════════════ */
describe("R3 — LIFE-ADV-03: UUID de uma Opportunity Green não pode representar outro lead", () => {
  const REUSO = "green_lead_id_reuse_forbidden";
  const SEM_VAZAMENTO = ["tok-historico-zzz", "mcp-historico-zzz"];

  const nascerGreen = (t: Tenant, id: string, extra: Record<string, unknown> = {}) =>
    request(
      servico({
        source: "mcp-historico-zzz",
        actor: { kind: "api_token", id: "tok-historico-zzz", api_token_id: "tok-historico-zzz" },
        ...extra,
      }),
      "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,$4,'Green',$5) returning id",
      [id, t.org, t.funilGreen, t.etapaG1, t.contato],
    );
  const apagar = (id: string) => request(servico(), "delete from crm_leads where id=$1", [id]);
  const moverParaGreen = (t: Tenant, id: string) =>
    request(servico(), "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
      id,
      t.funilGreen,
      t.etapaG1,
    ]);
  const nascimentos = (id: string) =>
    contar("select count(*) as n from green.lead_birth_provenance where lead_id=$1", [id]);
  const pipelineDe = async (id: string) =>
    (await pool.query("select pipeline_id from crm_leads where id=$1", [id])).rows[0]?.pipeline_id;

  async function historico(t: Tenant): Promise<string> {
    const x = randomUUID();
    await nascerGreen(t, x);
    await apagar(x);
    expect(await contar("select count(*) as n from crm_leads where id=$1", [x])).toBe(0);
    return x;
  }

  it("Caso A — INSERT Green com UUID histórico: recusa de DOMÍNIO, não a PK acidental da proveniência", async () => {
    const t = await tenant();
    const x = await historico(t);
    const e = await erroDe(nascerGreen(t, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
    expect(e?.constraint ?? null).toBeNull(); // não é `lead_birth_provenance_pkey`
    expect(await contar("select count(*) as n from crm_leads where id=$1", [x])).toBe(0);
    expect(await nascimentos(x)).toBe(1); // continua uma vida só
  });

  it("Caso B — lead COMUM com o UUID histórico, movido para o Green: recusado; não herda a proveniência antiga", async () => {
    const t = await tenant();
    const x = await historico(t);
    await leadComoDono(t, t.funilComum, t.etapaC1, x); // funil comum: permitido
    const e = await erroDe(moverParaGreen(t, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
    expect(await pipelineDe(x)).toBe(t.funilComum); // a transação inteira desfez
    expect(await nascimentos(x)).toBe(1);
    // e nenhum evento canônico novo de entrada para esse id
    expect(
      await contar(
        "select count(*) as n from green.stage_event_ledger where lead_id=$1 and kind='stage_changed'",
        [x],
      ),
    ).toBe(0);
  });

  it("Caso C — outra organização reutiliza o UUID: recusado, igual à mesma org, sem vazar org/ator/origem histórica", async () => {
    const a = await tenant();
    const b = await tenant();
    const x = await historico(a);
    await leadComoDono(b, b.funilComum, b.etapaC1, x);
    const mesmaOrg = await tenant();
    const y = await historico(mesmaOrg);
    await leadComoDono(mesmaOrg, mesmaOrg.funilComum, mesmaOrg.etapaC1, y);

    const entreOrgs = await erroDe(moverParaGreen(b, x));
    const naMesma = await erroDe(moverParaGreen(mesmaOrg, y));
    expect(entreOrgs?.message, veredito(entreOrgs)).toBe(REUSO);
    // sem oracle: a resposta é a mesma, qualquer que seja a org do histórico
    expect(veredito(entreOrgs)).toBe(veredito(naMesma));
    const tudo = JSON.stringify({ ...entreOrgs });
    for (const segredo of [a.org, a.admin, ...SEM_VAZAMENTO]) expect(tudo).not.toContain(segredo);
    expect(await pipelineDe(x)).toBe(b.funilComum);
    expect(await nascimentos(x)).toBe(1);
  });

  it("Caso C' — INSERT Green cross-tenant com UUID histórico: recusado sem vazamento", async () => {
    const a = await tenant();
    const b = await tenant();
    const x = await historico(a);
    const e = await erroDe(nascerGreen(b, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
    const tudo = JSON.stringify({ ...e });
    for (const segredo of [a.org, a.admin, ...SEM_VAZAMENTO]) expect(tudo).not.toContain(segredo);
  });

  it("Caso D — UUID nunca usado: permitido (INSERT Green e comum→Green)", async () => {
    const t = await tenant();
    const y = randomUUID();
    expect(veredito(await erroDe(nascerGreen(t, y)))).toBe("ACEITO");
    expect(await nascimentos(y)).toBe(1);
    const z = await leadComoDono(t, t.funilComum, t.etapaC1);
    expect(veredito(await erroDe(moverParaGreen(t, z)))).toBe("ACEITO");
    expect(await pipelineDe(z)).toBe(t.funilGreen);
  });

  it("Caso E — o MESMO lead continua a vida: muda de etapa, sai e volta ao Green", async () => {
    const t = await tenant();
    const y = randomUUID();
    await nascerGreen(t, y);
    const e1 = await erroDe(
      request(servico(), "update crm_leads set stage_id=$2 where id=$1", [y, t.etapaG2]),
    );
    expect(veredito(e1)).toBe("ACEITO");
    const e2 = await erroDe(
      request(servico(), "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
        y,
        t.funilComum,
        t.etapaC1,
      ]),
    );
    expect(veredito(e2)).toBe("ACEITO"); // saída
    const e3 = await erroDe(moverParaGreen(t, y));
    expect(veredito(e3)).toBe("ACEITO"); // reentrada do MESMO lead
    expect(await nascimentos(y)).toBe(1);
  });

  it("lead que SAIU do Green e foi apagado no funil comum também aposenta o UUID", async () => {
    const t = await tenant();
    const y = randomUUID();
    await nascerGreen(t, y);
    await request(servico(), "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
      y,
      t.funilComum,
      t.etapaC1,
    ]);
    await request(servico(), "delete from crm_leads where id=$1", [y]); // apagado FORA do Green
    await leadComoDono(t, t.funilComum, t.etapaC1, y);
    const e = await erroDe(moverParaGreen(t, y));
    expect(e?.message, veredito(e)).toBe(REUSO);
  });

  it("lead que ENTROU no Green por UPDATE (nasceu comum) e foi apagado também aposenta o UUID", async () => {
    const t = await tenant();
    const y = await leadComoDono(t, t.funilComum, t.etapaC1);
    await moverParaGreen(t, y);
    await apagar(y);
    await leadComoDono(t, t.funilComum, t.etapaC1, y);
    const e = await erroDe(moverParaGreen(t, y));
    expect(e?.message, veredito(e)).toBe(REUSO);
  });

  it("cascata da organização não devolve o UUID: o histórico sobrevive à exclusão do tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const x = randomUUID();
    await nascerGreen(a, x);
    await pool.query("delete from organizations where id=$1", [a.org]); // cascata
    expect(await contar("select count(*) as n from crm_leads where id=$1", [x])).toBe(0);
    await leadComoDono(b, b.funilComum, b.etapaC1, x);
    const e = await erroDe(moverParaGreen(b, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
    const e2 = await erroDe(nascerGreen(b, x));
    expect(e2?.message, veredito(e2)).toBe(REUSO);
  });

  it("o registro de identidade não guarda PII nem ator/origem: só o necessário para detectar reuso", async () => {
    const t = await tenant();
    const x = await historico(t);
    const { rows } = await pool.query("select to_jsonb(i) as linha from green.lead_identity i where lead_id=$1", [x]);
    expect(rows).toHaveLength(1);
    const colunas = Object.keys(rows[0].linha).sort();
    expect(colunas).toEqual(["first_seen_at", "lead_id", "retired_at", "state"]);
    expect(JSON.stringify(rows[0].linha)).not.toContain(t.org);
  });

  it("papéis de API não alcançam o registro de identidade (não escrevem nem leem)", async () => {
    const t = await tenant();
    const x = await historico(t);
    for (const papel of ["authenticated", "anon"] as const) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${papel}`);
        const e = await erroDe(c.query("select * from green.lead_identity"));
        expect(e?.code, papel).toBe("42501");
        await c.query("rollback");
      } finally {
        c.release();
      }
    }
    const e = await erroDe(
      request({ papel: "service_role" }, "update green.lead_identity set state='live' where lead_id=$1", [x]),
    );
    expect(e?.code).toBe("42501"); // nem service_role reabilita um UUID aposentado
  });
});

/* ═══ R4 — LIFE-ADV-04: a zona de perigo isola por organização (comportamento) ═ */
describe("R4 — LIFE-ADV-04: zona de perigo apaga A e deixa B intacta (as sete raízes, comportamento real)", () => {
  const RAIZES = [
    "messages",
    "conversations",
    "calendar_appointments",
    "orders",
    "crm_proposals",
    "crm_leads",
    "contacts",
  ] as const;

  /** A org inteira nas sete raízes: o `tenant()` já traz contato, conversa e mensagem. */
  async function semearSeteRaizes(t: Tenant) {
    await pool.query(
      "insert into calendar_appointments (organization_id, contact_id, title, starts_at, ends_at, status) values ($1,$2,'Consulta',now()+interval '2 days',now()+interval '2 days 1 hour','confirmed')",
      [t.org, t.contato],
    );
    await pool.query(
      "insert into orders (organization_id, external_id, external_provider, contact_id, status, total_cents, ordered_at) values ($1,$2,'nuvemshop',$3,'paid',1000,now())",
      [t.org, `ord-${randomUUID()}`, t.contato],
    );
    const green = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await leadComoDono(t, t.funilComum, t.etapaC1);
    await pool.query(
      "insert into crm_proposals (organization_id, lead_id, contact_id, titulo) values ($1,$2,$3,'Proposta')",
      [t.org, green, t.contato],
    );
  }

  /** Impressão digital de cada raiz da org: contagem + hash das linhas inteiras. */
  async function retrato(org: string) {
    const out: Record<string, { n: number; hash: string }> = {};
    for (const tabela of RAIZES) {
      const { rows } = await pool.query(
        `select count(*)::int as n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id::text)), '') as hash
           from public.${tabela} x where x.organization_id = $1`,
        [org],
      );
      out[tabela] = rows[0];
    }
    return out;
  }

  const apagarComo = (t: Tenant) =>
    gancho.als!.run({ userId: t.admin, orgId: t.org, requestId: `req-${randomUUID()}` }, () =>
      apagarDadosOperacionaisDaOrganizacao({ confirmNome: t.nome }),
    );

  it("fixture: as sete raízes estão populadas nas duas organizações", async () => {
    const a = await tenant();
    const b = await tenant();
    await semearSeteRaizes(a);
    await semearSeteRaizes(b);
    for (const org of [a.org, b.org]) {
      const r = await retrato(org);
      for (const tabela of RAIZES) expect(r[tabela]!.n, `${tabela} de ${org}`).toBeGreaterThan(0);
    }
  });

  it("pela action real: A inteira sai conforme o contrato, B fica igual byte a byte", async () => {
    const a = await tenant();
    const b = await tenant();
    await semearSeteRaizes(a);
    await semearSeteRaizes(b);
    const antesB = await retrato(b.org);
    const lapidesAntesB = await contar(
      "select count(*) as n from event_log where organization_id=$1 and event_type='lead.deleted'",
      [b.org],
    );

    const r = await apagarComo(a);
    expect(r).toMatchObject({ ok: true });

    const depoisA = await retrato(a.org);
    for (const tabela of RAIZES) expect(depoisA[tabela]!.n, `A.${tabela}`).toBe(0);
    expect(await retrato(b.org)).toEqual(antesB);
    // a lápide do lead Green de A existe; nada novo apareceu para B
    expect(
      await contar(
        "select count(*) as n from event_log where organization_id=$1 and event_type='lead.deleted'",
        [a.org],
      ),
    ).toBe(1);
    expect(
      await contar(
        "select count(*) as n from event_log where organization_id=$1 and event_type='lead.deleted'",
        [b.org],
      ),
    ).toBe(lapidesAntesB);
  });

  it("pela RPC, como service_role com contexto: mesmo contrato", async () => {
    const a = await tenant();
    const b = await tenant();
    await semearSeteRaizes(a);
    await semearSeteRaizes(b);
    const antesB = await retrato(b.org);
    const { rows } = await request<{ r: Record<string, number> }>(
      servico({ source: "settings.danger_zone", actor: { kind: "system", id: a.admin } }),
      "select public.fn_apagar_dados_operacionais_da_org($1) as r",
      [a.org],
    );
    expect(rows[0]!.r).toMatchObject({ messages: 1, conversations: 1, crm_leads: 2, contacts: 1 });
    const depoisA = await retrato(a.org);
    for (const tabela of RAIZES) expect(depoisA[tabela]!.n, `A.${tabela}`).toBe(0);
    expect(await retrato(b.org)).toEqual(antesB);
  });

  it("recusa no meio (lead Green sem contexto): NADA de A foi apagado e B continua intacta — atomicidade E isolamento juntos", async () => {
    const a = await tenant();
    const b = await tenant();
    await semearSeteRaizes(a);
    await semearSeteRaizes(b);
    const antesA = await retrato(a.org);
    const antesB = await retrato(b.org);
    const e = await erroDe(
      request({ papel: "service_role" }, "select public.fn_apagar_dados_operacionais_da_org($1)", [a.org]),
    );
    expect(veredito(e)).toBe("42501 green_mutation_context_required");
    expect(await retrato(a.org)).toEqual(antesA);
    expect(await retrato(b.org)).toEqual(antesB);
  });

  it("três organizações: apagar B não toca A nem C (a vizinha não é só 'a outra')", async () => {
    const [a, b, c] = await Promise.all([tenant(), tenant(), tenant()]);
    for (const t of [a, b, c]) await semearSeteRaizes(t);
    const [antesA, antesC] = [await retrato(a.org), await retrato(c.org)];
    await apagarComo(b);
    expect(await retrato(a.org)).toEqual(antesA);
    expect(await retrato(c.org)).toEqual(antesC);
  });

  it("organização nula é recusada (`22023`)", async () => {
    const e = await erroDe(
      request(servico(), "select public.fn_apagar_dados_operacionais_da_org(null)"),
    );
    expect(e?.code).toBe("22023");
  });
});
