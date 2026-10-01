/**
 * SPIKE-GREEN-01 — Lead Lifecycle: INSERT + DELETE + tombstone (DESCARTÁVEL).
 *
 * Invariantes de banco do ciclo de vida de uma Opportunity Green: nascimento
 * por caminho privilegiado (EV-01B), zona de perigo (apagamento multi-etapa),
 * lápide `lead.deleted`, DELETE privilegiado sem contexto e cascata de
 * organização. Arquivo NOVO: os invariantes v1/v2/v3 não são reescritos.
 *
 * Cada caso descreve o CONTRATO do lifecycle. Rodado contra a v3
 * (`43494c930`), os casos que representam defeito falham pelo motivo do
 * defeito — a matriz RED está em `docs/spike/GREEN-LEAD-LIFECYCLE-V1.md`.
 * Por isso o arquivo não depende de coluna, tabela ou função que só exista no
 * lifecycle: o que é novo é lido por `to_regclass`/`to_jsonb`, e a diferença
 * aparece na asserção, não num "does not exist".
 *
 * O código sob teste é o REAL — `garantirLeadDaConversa`, a rota
 * `webhooks/in/[token]`, a server action da zona de perigo — executado contra
 * o banco real por `green-postgrest-shim.ts`, que faz cada chamada como o
 * PostgREST a faz (papel, claims, headers) e tira o header Green do escopo ALS
 * corrente, como o `fetchDoServidor`. O teste não injeta contexto: quem o
 * declara (ou não) é o seam do código.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clientePostgrest, type ChamadaRegistrada } from "./green-postgrest-shim";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-zona-de-perigo-0001" }),
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));
const sessao = vi.hoisted(() => ({ userId: "", orgId: "", role: "admin", platform: false }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: sessao.userId,
    is_platform_admin: sessao.platform,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: sessao.orgId, name: "Org", role: sessao.role })),
  mfaEmDivida: vi.fn(async () => false),
}));
const auditados = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditados.push(e);
  }),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { apagarDadosOperacionaisDaOrganizacao } from "@/app/actions/settings/apagarDadosOperacionaisDaOrganizacao";
import { apagarDadosOperacionaisDaOrg } from "@/lib/settings/apagar-dados-operacionais";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { POST as webhookIn } from "@/app/api/v1/webhooks/in/[token]/route";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

/** Toda chamada que o código real fez ao "PostgREST" neste teste. */
const chamadas: ChamadaRegistrada[] = [];
const admin = () => clientePostgrest(pool, { papel: "service_role" }, chamadas);

beforeAll(() => {
  vi.mocked(createAdminClient).mockImplementation(admin);
});
beforeEach(() => {
  chamadas.length = 0;
  auditados.length = 0;
});
afterAll(() => pool.end());

/* ── requests simuladas no formato do PostgREST (mesmo harness da v3) ───────── */
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

const servicoSemContexto: Request = { papel: "service_role" };
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

/* ── fixtures: um tenant por caso (a zona de perigo esvazia o tenant inteiro) ─ */
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

async function tenant(opts: { greenPadrao: boolean }): Promise<Tenant> {
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
    `adm-${t.admin}@lifecycle.test`,
  ]);
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [t.org, `lc-${t.org}`, t.nome],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin',now())",
    [t.admin, t.org],
  );
  await pool.query(
    "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
    [t.sessaoCanal, t.org, `lc-${t.sessaoCanal}`],
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
  // a organização pode nascer com funil padrão semeado: o padrão é ESTE funil
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [t.org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [
    opts.greenPadrao ? t.funilGreen : t.funilComum,
  ]);
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

async function leadComoDono(
  t: Tenant,
  funil: string,
  etapa: string,
  contato: string | null = t.contato,
) {
  const { rows } = await comoDono(
    "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio',$4) returning id",
    [t.org, funil, etapa, contato],
  );
  return rows[0].id as string;
}

const contar = async (sql: string, args: unknown[]) =>
  Number((await pool.query(sql, args)).rows[0].n);
const daOrg = (tabela: string, org: string) =>
  contar(`select count(*) as n from public.${tabela} where organization_id=$1`, [org]);

interface Evento {
  id: string;
  event_type: string;
  status: string;
  consumed_by: string[];
  attempts: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
async function lapidesDe(id: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select id, event_type, status, consumed_by, attempts, payload, metadata from event_log where entity_kind='crm_lead' and entity_id=$1 and event_type='lead.deleted' order by created_at, id",
    [id],
  );
  return rows;
}

/**
 * O registro de nascimento Green. Lido por `to_regclass` + `to_jsonb`: na v3 a
 * estrutura não existe e a resposta é "nenhum registro" — a falha aparece na
 * asserção, não num erro de relação inexistente.
 */
async function nascimentoDe(leadId: string): Promise<Array<Record<string, unknown>>> {
  const existe = (
    await pool.query("select to_regclass('green.lead_birth_provenance') is not null as e")
  ).rows[0].e;
  if (!existe) return [];
  const { rows } = await pool.query<{ l: Record<string, unknown> }>(
    "select to_jsonb(l) l from green.lead_birth_provenance l where lead_id=$1 order by created_at",
    [leadId],
  );
  return rows.map((r) => r.l);
}

/* ═══ L1 — EV-01B: nascimento Green por caminho privilegiado ════════════════ */
describe("L1 — EV-01B: nascimento Green por caminho privilegiado", () => {
  it("WAHA/Meta/Zernio (`garantirLeadDaConversa`, client de serviço): a conversa vira lead no funil Green, com proveniência confiável", async () => {
    const t = await tenant({ greenPadrao: true });
    const r = await garantirLeadDaConversa(admin(), {
      organizationId: t.org,
      contactId: t.contato,
      conversationId: t.conversa,
      nomeDoContato: "Maria Green",
    });
    expect(r).toMatchObject({ criado: true, pipelineId: t.funilGreen, stageId: t.etapaG1 });
    const lead = (
      await pool.query(
        "select id, pipeline_id from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
        [t.org, t.contato],
      )
    ).rows;
    expect(lead).toHaveLength(1);
    const [nasc] = await nascimentoDe(lead[0].id);
    expect(nasc).toMatchObject({
      organization_id: t.org,
      pipeline_id: t.funilGreen,
      stage_id: t.etapaG1,
      caller: "service_role",
      trusted: {
        caller: "service_role",
        actor: { kind: "webhook_source", id: "canal-inbound" },
        source: "canal.ingest",
      },
    });
  });

  it("voice-agent (mesma chamada que `workers/voice-agent/index.ts` faz): a ligação vira lead no funil Green", async () => {
    const t = await tenant({ greenPadrao: true });
    const chamada = randomUUID(); // `voice_calls.id` faz as vezes de conversa
    const r = await garantirLeadDaConversa(admin(), {
      organizationId: t.org,
      contactId: t.contato,
      conversationId: chamada,
      nomeDoContato: null,
      origem: { rotulo: "chamada", source: "voip", motivo: "primeira ligação recebida" },
    });
    expect(r).toMatchObject({ criado: true, pipelineId: t.funilGreen });
    if (!r.criado) return;
    expect(await nascimentoDe(r.leadId)).toHaveLength(1);
  });

  it("idempotência do nascimento: a segunda mensagem não cria segundo lead nem segundo registro", async () => {
    const t = await tenant({ greenPadrao: true });
    const dados = {
      organizationId: t.org,
      contactId: t.contato,
      conversationId: t.conversa,
      nomeDoContato: "Maria",
    };
    const r1 = await garantirLeadDaConversa(admin(), dados);
    const r2 = await garantirLeadDaConversa(admin(), dados);
    expect(r1.criado).toBe(true);
    expect(r2).toEqual({ criado: false, motivo: "ja_existe" });
    expect(
      await contar(
        "select count(*) as n from crm_leads where organization_id=$1 and contact_id=$2",
        [t.org, t.contato],
      ),
    ).toBe(1);
    if (!r1.criado) return;
    expect(await nascimentoDe(r1.leadId)).toHaveLength(1);
  });

  it("webhook-in (`webhooks/in/[token]`, client de serviço): o envio vira lead no funil Green configurado na fonte", async () => {
    const t = await tenant({ greenPadrao: false });
    const fonte = randomUUID();
    const token = `lc-whin-${randomUUID()}`;
    await pool.query(
      "insert into webhook_sources (id, organization_id, name, path_token, default_pipeline_id, default_stage_id) values ($1,$2,'Fonte Green',$3,$4,$5)",
      [fonte, t.org, token, t.funilGreen, t.etapaG1],
    );
    const telefone = `119${String(Math.floor(Math.random() * 1e8)).padStart(8, "1")}`;
    const res = await webhookIn(
      new NextRequest(`http://localhost/api/v1/webhooks/in/${token}`, {
        method: "POST",
        body: JSON.stringify({ nome: "Ana Webhook", telefone }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);
    const leadId = ((await res.json()) as { data: { lead_id: string } }).data.lead_id;
    const [nasc] = await nascimentoDe(leadId);
    expect(nasc).toMatchObject({
      pipeline_id: t.funilGreen,
      trusted: { actor: { kind: "webhook_source", id: fonte }, source: "webhook.in" },
    });
  });

  it("contato/conversa parcialmente criado: o contato que o webhook-in cria não fica sem lead (o contrato da fonte exige lead)", async () => {
    const t = await tenant({ greenPadrao: false });
    const token = `lc-whin-${randomUUID()}`;
    await pool.query(
      "insert into webhook_sources (organization_id, name, path_token, default_pipeline_id, default_stage_id) values ($1,'Fonte Green',$2,$3,$4)",
      [t.org, token, t.funilGreen, t.etapaG1],
    );
    const telefone = `119${String(Math.floor(Math.random() * 1e8)).padStart(8, "2")}`;
    const envio = () =>
      webhookIn(
        new NextRequest(`http://localhost/api/v1/webhooks/in/${token}`, {
          method: "POST",
          body: JSON.stringify({ nome: "Bia Webhook", telefone }),
          headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ token }) },
      );
    // o remetente reenvia o mesmo cadastro: o estado tem de convergir
    await envio();
    await envio();
    const orfaos = await contar(
      "select count(*) as n from contacts c where c.organization_id=$1 and c.source='webhook' and not exists (select 1 from crm_leads l where l.contact_id=c.id)",
      [t.org],
    );
    expect(orfaos).toBe(0);
  });

  it("controle: writer privilegiado SEM contexto continua recusado (`42501`) e não deixa lead nem registro", async () => {
    const t = await tenant({ greenPadrao: true });
    const e = await erroDe(
      request(
        servicoSemContexto,
        "select public.fn_nascer_lead_da_conversa(p_org=>$1, p_contact=>$2, p_pipeline=>$3, p_stage=>$4, p_title=>'x', p_source=>'whatsapp')",
        [t.org, t.contato, t.funilGreen, t.etapaG1],
      ),
    );
    expect(veredito(e)).toBe("42501 green_mutation_context_required");
    expect(await daOrg("crm_leads", t.org)).toBe(0);
  });

  it("writer privilegiado COM contexto: o nascimento grava a proveniência confiável na MESMA transação", async () => {
    const t = await tenant({ greenPadrao: true });
    const r = servico({ request_id: "req-nascimento-1" });
    const { rows } = await request<{ id: string }>(
      r,
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'MCP',$4) returning id",
      [t.org, t.funilGreen, t.etapaG1, t.contato],
    );
    const [nasc] = await nascimentoDe(rows[0]!.id);
    expect(nasc).toMatchObject({
      caller: "service_role",
      trusted: {
        caller: "service_role",
        source: "mcp",
        request_id: "req-nascimento-1",
        actor: { kind: "api_token", id: "tok-1" },
      },
      advisory: {},
    });
  });

  it("humano: o nascimento registra actor = auth.uid(); o que veio no header fica em advisory", async () => {
    const t = await tenant({ greenPadrao: true });
    const humano: Request = {
      papel: "authenticated",
      sub: t.admin,
      contexto: {
        v: 1,
        source: "kanban",
        request_id: "rule:forjado",
        actor: { kind: "system", id: "eu" },
      },
    };
    const { rows } = await request<{ id: string }>(
      humano,
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Manual',$4) returning id",
      [t.org, t.funilGreen, t.etapaG1, t.contato],
    );
    const [nasc] = await nascimentoDe(rows[0]!.id);
    expect(nasc).toMatchObject({
      caller: "user",
      trusted: { caller: "user", actor: { kind: "user", id: t.admin }, source: "user_session" },
      advisory: { source: "kanban", request_id: "rule:forjado" },
    });
    expect((nasc!.trusted as Record<string, unknown>).request_id).toBeUndefined();
  });

  it("controle: nascimento fora do Green não exige contexto nem deixa registro Green", async () => {
    const t = await tenant({ greenPadrao: false });
    const { rows } = await request<{ id: string }>(
      servicoSemContexto,
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Comum',$4) returning id",
      [t.org, t.funilComum, t.etapaC1, t.contato],
    );
    expect(rows).toHaveLength(1);
    expect(await nascimentoDe(rows[0]!.id)).toHaveLength(0);
  });

  it("controle: nenhum papel de API escreve no registro de nascimento (só o produtor, dono)", async () => {
    const t = await tenant({ greenPadrao: true });
    const id = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const antes = await nascimentoDe(id);
    for (const r of [servicoSemContexto, { papel: "authenticated", sub: t.admin } as Request]) {
      for (const sql of [
        "update green.lead_birth_provenance set caller='forjado' where lead_id=$1",
        "delete from green.lead_birth_provenance where lead_id=$1",
        "insert into green.lead_birth_provenance (organization_id, lead_id) values ((select organization_id from crm_leads where id=$1), $1)",
      ]) {
        expect(await erroDe(request(r, sql, [id]))).not.toBeNull();
      }
    }
    expect(await nascimentoDe(id)).toEqual(antes);
  });
});

/* ═══ L2 — zona de perigo com lead Green ════════════════════════════════════ */
describe("L2 — zona de perigo (`apagarDadosOperacionaisDaOrganizacao`) com lead Green", () => {
  async function prepararZona(t: Tenant, comGreen = true) {
    const green = comGreen ? await leadComoDono(t, t.funilGreen, t.etapaG2) : null;
    const comum = await leadComoDono(t, t.funilComum, t.etapaC1);
    sessao.userId = t.admin;
    sessao.orgId = t.org;
    sessao.role = "admin";
    sessao.platform = false;
    return { green, comum };
  }
  const acao = (t: Tenant) => apagarDadosOperacionaisDaOrganizacao({ confirmNome: t.nome });

  it("a action termina: dados operacionais somem, cada Opportunity Green deixa lápide com o ator da sessão, a outra org fica intacta", async () => {
    const t = await tenant({ greenPadrao: false });
    const vizinha = await tenant({ greenPadrao: false });
    const leadVizinho = await leadComoDono(vizinha, vizinha.funilGreen, vizinha.etapaG1);
    const { green } = await prepararZona(t);

    const r = await acao(t);
    expect(r).toMatchObject({ ok: true });
    for (const tabela of ["messages", "conversations", "crm_leads", "contacts"]) {
      expect(await daOrg(tabela, t.org), tabela).toBe(0);
    }
    const [lapide] = await lapidesDe(green!);
    expect(lapide).toBeDefined();
    expect(lapide!.metadata).toMatchObject({
      green_canonical: true,
      caller: "service_role",
      actor: { kind: "system", id: t.admin },
      source: "settings.danger_zone",
    });
    // o vizinho não perdeu nada
    expect(await daOrg("messages", vizinha.org)).toBe(1);
    expect(await daOrg("contacts", vizinha.org)).toBe(1);
    expect((await pool.query("select 1 from crm_leads where id=$1", [leadVizinho])).rowCount).toBe(
      1,
    );
  });

  it("retry converge: a segunda execução termina e não encontra nada (idempotente)", async () => {
    const t = await tenant({ greenPadrao: false });
    await prepararZona(t);
    await acao(t);
    const r2 = await acao(t);
    expect(r2).toMatchObject({ ok: true });
    if (!r2.ok) return;
    expect(Object.values(r2.counts).every((n) => n === 0)).toBe(true);
    expect(await daOrg("crm_leads", t.org)).toBe(0);
    expect(await daOrg("contacts", t.org)).toBe(0);
  });

  it("DELETE service-role SEM contexto (chamador que esquece a declaração): recusa atômica, nada irreversível acontece", async () => {
    const t = await tenant({ greenPadrao: false });
    const { green, comum } = await prepararZona(t);
    const antes = {
      messages: await daOrg("messages", t.org),
      conversations: await daOrg("conversations", t.org),
    };

    // a lib chamada direto, fora da action: o client de serviço sem escopo Green
    const r = await apagarDadosOperacionaisDaOrg(admin(), t.org);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.falha.mensagem).toContain("green_mutation_context_required");
    // perda irreversível: o que foi apagado ANTES da recusa
    expect(await daOrg("messages", t.org)).toBe(antes.messages);
    expect(await daOrg("conversations", t.org)).toBe(antes.conversations);
    expect(
      (await pool.query("select id from crm_leads where id = any($1)", [[green, comum]])).rowCount,
    ).toBe(2);
    expect(await daOrg("contacts", t.org)).toBe(1);
    expect(await lapidesDe(green!)).toHaveLength(0);
  });

  it("falha NÃO-Green no meio (FK RESTRICT para contacts que a rotina não conhece) também não deixa estado parcial; removida a trava, converge", async () => {
    // sem lead Green: isola a atomicidade do apagamento do contrato Green
    const t = await tenant({ greenPadrao: false });
    await prepararZona(t, false);
    await pool.query(
      "create table if not exists public.zz_spike_trava (contact_id uuid not null references public.contacts(id) on delete restrict)",
    );
    await pool.query("insert into public.zz_spike_trava values ($1)", [t.contato]);

    const r = await acao(t);
    expect(r).toMatchObject({ ok: false, error: "db_error" });
    expect(await daOrg("messages", t.org)).toBe(1);
    expect(await daOrg("conversations", t.org)).toBe(1);
    expect(await daOrg("crm_leads", t.org)).toBe(1);

    await pool.query("delete from public.zz_spike_trava where contact_id=$1", [t.contato]);
    expect(await acao(t)).toMatchObject({ ok: true });
    expect(await daOrg("contacts", t.org)).toBe(0);
  });

  it("controle: papel de API não alcança apagamento em massa de outra org pela porta de serviço", async () => {
    const t = await tenant({ greenPadrao: false });
    const atacante = await tenant({ greenPadrao: false });
    await prepararZona(t);
    const e = await erroDe(
      request(
        { papel: "authenticated", sub: atacante.admin },
        "select public.fn_apagar_dados_operacionais_da_org($1)",
        [t.org],
      ),
    );
    expect(e).not.toBeNull();
    expect(await daOrg("messages", t.org)).toBe(1);
    expect(await daOrg("crm_leads", t.org)).toBe(2);
  });
});

/* ═══ L3 — lápide `lead.deleted` ═══════════════════════════════════════════ */
describe("L3 — a lápide `lead.deleted` é registro-fato, não fila", () => {
  it("DELETE humano de lead Green: a lápide nasce `done`, sem consumidor reivindicado, sem tentativas", async () => {
    const t = await tenant({ greenPadrao: false });
    const id = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await request({ papel: "authenticated", sub: t.admin }, "delete from crm_leads where id=$1", [
      id,
    ]);
    const [lapide] = await lapidesDe(id);
    expect(lapide).toMatchObject({ status: "done", consumed_by: [], attempts: 0 });
  });

  it("o banco declara `lead.deleted` como registro (`fn_event_log_e_registro`) — o mesmo mecanismo da 0239", async () => {
    const { rows } = await pool.query("select public.fn_event_log_e_registro('lead.deleted') as r");
    expect(rows[0].r).toBe(true);
  });

  it("backlog × histórico: depois de exclusões humana, de serviço e em lote, nenhuma lápide fica `pending`", async () => {
    const t = await tenant({ greenPadrao: false });
    const a = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const b = await leadComoDono(t, t.funilGreen, t.etapaG2);
    const c = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await request({ papel: "authenticated", sub: t.admin }, "delete from crm_leads where id=$1", [
      a,
    ]);
    await request(servico(), "delete from crm_leads where id=$1", [b]);
    await request(
      { papel: "authenticated", sub: t.admin },
      "delete from crm_leads where id = any($1)",
      [[c]],
    );
    const pendentes = await contar(
      "select count(*) as n from event_log where organization_id=$1 and event_type='lead.deleted' and status='pending'",
      [t.org],
    );
    expect(
      await contar(
        "select count(*) as n from event_log where organization_id=$1 and event_type='lead.deleted'",
        [t.org],
      ),
    ).toBe(3);
    expect(pendentes).toBe(0);
  });

  it("controle: a lápide continua write-once e 1:1 com a exclusão (repetir o DELETE não gera segunda)", async () => {
    const t = await tenant({ greenPadrao: false });
    const id = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const humano: Request = { papel: "authenticated", sub: t.admin };
    await request(humano, "delete from crm_leads where id=$1", [id]);
    const r2 = await request(humano, "delete from crm_leads where id=$1", [id]);
    expect(r2.rowCount).toBe(0);
    const lapides = await lapidesDe(id);
    expect(lapides).toHaveLength(1);
    const e = await erroDe(
      request(servicoSemContexto, "update event_log set payload = '{}'::jsonb where id=$1", [
        lapides[0]!.id,
      ]),
    );
    expect(veredito(e)).toBe("42501 green_canonical_immutable");
  });
});

/* ═══ DELETE privilegiado e cascatas ═══════════════════════════════════════ */
describe("DELETE privilegiado sem contexto e cascatas", () => {
  it("controle: DELETE de serviço SEM contexto num lote misto (Green + comum) é tudo-ou-nada", async () => {
    const t = await tenant({ greenPadrao: false });
    const green = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const comum = await leadComoDono(t, t.funilComum, t.etapaC1);
    const e = await erroDe(
      request(servicoSemContexto, "delete from crm_leads where organization_id=$1", [t.org]),
    );
    expect(veredito(e)).toBe("42501 green_mutation_context_required");
    expect(
      (await pool.query("select id from crm_leads where id = any($1)", [[green, comum]])).rowCount,
    ).toBe(2);
  });

  async function orgComHistoricoGreen() {
    const t = await tenant({ greenPadrao: false });
    const id = await leadComoDono(t, t.funilGreen, t.etapaG1);
    await request(
      { papel: "authenticated", sub: t.admin },
      "update crm_leads set stage_id=$2 where id=$1",
      [id, t.etapaG2],
    );
    return { t, id };
  }
  const residuoGreen = async (org: string) => {
    const tabelas = (
      await pool.query<{ t: string }>(
        "select format('%I.%I', table_schema, table_name) t from information_schema.columns where table_schema='green' and column_name='organization_id'",
      )
    ).rows.map((r) => r.t);
    let n = 0;
    for (const tabela of tabelas)
      n += await contar(`select count(*) as n from ${tabela} where organization_id=$1`, [org]);
    return n;
  };

  it("cascata de organização (service_role): nenhum resíduo Green sobrevive ao tenant — livro-razão incluído", async () => {
    const { t } = await orgComHistoricoGreen();
    expect(await residuoGreen(t.org)).toBeGreaterThan(0);
    await request(servicoSemContexto, "delete from organizations where id=$1", [t.org]);
    expect(await residuoGreen(t.org)).toBe(0);
  });

  it("cascata de organização (platform admin pelo PostgREST): fica um registro auditável, sem PII, de que o domínio Green da org foi apagado e por quem", async () => {
    const { t } = await orgComHistoricoGreen();
    const plataforma = randomUUID();
    await pool.query("insert into auth.users (id, email) values ($1,$2)", [
      plataforma,
      `pa-${plataforma}@lifecycle.test`,
    ]);
    await pool.query(
      "insert into platform_admins (user_id, granted_by, reason) values ($1,$1,'spike lifecycle')",
      [plataforma],
    );
    await request(
      { papel: "authenticated", sub: plataforma },
      "delete from organizations where id=$1",
      [t.org],
    );
    expect((await pool.query("select 1 from organizations where id=$1", [t.org])).rowCount).toBe(0);

    const { rows } = await pool.query(
      "select action, organization_id, actor_user_id, resource_id, metadata from api_audit_log where metadata->>'organization_id' = $1::text and action like 'green.%'",
      [t.org],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "green.binding_removed",
      actor_user_id: plataforma,
      resource_id: t.funilGreen,
      metadata: {
        organization_id: t.org,
        pipeline_id: t.funilGreen,
        product_key: "energia",
        org_deleted: true,
        caller: "user",
      },
    });
    // sem PII: nada de nome, telefone ou título
    expect(JSON.stringify(rows[0].metadata)).not.toMatch(/Maria|\+55|Negócio/);
  });

  it("DIAGNÓSTICO (gap medido, sem correção nesta spike): apagar o contato com histórico desliga a Opportunity Green do contato sem nenhum registro Green", async () => {
    const t = await tenant({ greenPadrao: false });
    const id = await leadComoDono(t, t.funilGreen, t.etapaG1);
    const eventosAntes = await contar("select count(*) as n from event_log where entity_id=$1", [
      id,
    ]);
    const { rows } = await request(
      { papel: "authenticated", sub: t.admin },
      "select public.fn_apagar_contato_com_historico(p_contact_id => $1, p_organization_id => $2) as ok",
      [t.contato, t.org],
    );
    expect(rows[0]!.ok).toBe(true);
    // medido, NÃO afirmado como correto: o lead sobrevive sem contato (FK SET
    // NULL) e a fronteira Green não vê a mudança, porque ela só olha
    // etapa/funil/organização. É o mesmo comportamento na v3 e no lifecycle.
    expect(
      (await pool.query("select contact_id from crm_leads where id=$1", [id])).rows[0],
    ).toEqual({ contact_id: null });
    expect(await contar("select count(*) as n from event_log where entity_id=$1", [id])).toBe(
      eventosAntes,
    );
  });
});
