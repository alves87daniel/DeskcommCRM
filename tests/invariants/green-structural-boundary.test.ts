/**
 * SPIKE-GREEN-02 — Structural Boundary: pipelines, stages, binding e organização (DESCARTÁVEL).
 *
 * A fronteira de `crm_leads` (0502-0506) protege a mutação que ENTRA, FICA, SAI ou APAGA um
 * lead Green. Mas "o que é Green" é decidido também pela estrutura ao redor do lead: funil,
 * etapa, binding e organização. Esta suíte ataca a estrutura direto no banco, pelos papéis
 * reais (PostgREST simulado: `authenticated` com JWT, `service_role` com e sem contexto) e pelo
 * dono (migração administrativa).
 *
 * Contrato (o que esta suíte exige):
 *
 *   ST1  nenhum lead que toca o domínio fica com etapa fora do funil/organização dele;
 *   ST2  nenhum lead vivo que toca o domínio fica sem identidade `live`;
 *   ST3  etapa, binding e lead nunca apontam para estrutura de OUTRA organização;
 *   ST4  etapa de funil Green não muda de funil, e etapa nenhuma entra em funil Green por UPDATE;
 *   ST5  funil e etapa não trocam de organização;
 *   ST6  binding só nasce sobre estrutura coerente; a remoção é auditada com o que ela solta;
 *   ST7  toda recusa é atômica (nada parcial) e acontece na fronteira certa, sem oracle.
 *
 * Famílias: A-N (ataques do pedido), X (cross-tenant), AT (atomicidade), C (concorrência),
 * EV (eventos), O (cascata de organização), U (upgrade 0506 → 0507).
 *
 * Mesmo arquivo contra a base (`bcfbafee`, 0506) e a spike (0507): só muda o código sob teste.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 16,
});
afterAll(() => pool.end());

/** Diagnóstico (só com GREEN_STRUCT_DIAG_OUT): o que cada ataque deixou no banco. */
const DIAG_OUT = process.env.GREEN_STRUCT_DIAG_OUT;
const diagnostico: Record<string, unknown>[] = [];
afterAll(() => {
  if (DIAG_OUT) writeFileSync(DIAG_OUT, JSON.stringify(diagnostico, null, 2));
});

/* ── requests no formato do PostgREST (mesmo harness do lifecycle v1.3) ───────── */
interface Request {
  papel: "authenticated" | "service_role";
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

/** Abre a transação de uma request e devolve o client (para escolher a ordem de commit). */
async function requestAberta(r: Request): Promise<pg.PoolClient> {
  const c = await pool.connect();
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
  return c;
}

const CONTEXTO_DONO = JSON.stringify({
  v: 1,
  source: "fixture",
  actor: { kind: "system", id: "fixture" },
});

/** Escrita do DONO (fixture / migração administrativa), com o contexto Green pelo GUC. */
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
async function transacaoDoDono(): Promise<pg.PoolClient> {
  const c = await pool.connect();
  await c.query("begin");
  await c.query("select set_config('green.mutation_context', $1, true)", [CONTEXTO_DONO]);
  return c;
}
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as pg.DatabaseError;
  }
}
const veredito = (e: pg.DatabaseError | null) => (e ? `${e.code} ${e.message}` : "ACEITO");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Assinatura completa do erro, com os UUIDs que o PRÓPRIO atacante mandou normalizados. */
const assinatura = (e: pg.DatabaseError | null) =>
  JSON.stringify(
    e
      ? {
          code: e.code,
          message: e.message,
          detail: e.detail ?? null,
          hint: e.hint ?? null,
          where: e.where ?? null,
          schema: e.schema ?? null,
          table: e.table ?? null,
          column: e.column ?? null,
          constraint: e.constraint ?? null,
          severity: e.severity ?? null,
        }
      : null,
  ).replace(UUID_RE, "<uuid>");

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
const servicoSemContexto: Request = { papel: "service_role" };

const RELOCACAO = "green_stage_relocation_forbidden";
const TENANT = "green_structure_tenant_immutable";
const BINDING_INVALIDO = "green_binding_structure_invalid";
const LEGADO = "green_structural_legacy_violation";
const NAO_VINCULADA = "green_stage_not_bound";

/* ── fixtures ─────────────────────────────────────────────────────────────── */
interface Funil {
  id: string;
  etapas: string[];
}
interface Tenant {
  org: string;
  admin: string; // admin da org (≥ manager): escreve estrutura pela RLS
  agente: string; // agent: escreve lead, não escreve estrutura
  contato: string;
  green: Funil; // funil com binding
  comum: Funil;
}

async function usuario(prefixo: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    id,
    `${prefixo}-${id}@estrutura.test`,
  ]);
  return id;
}
async function membro(user: string, org: string, papel: string) {
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
    [user, org, papel],
  );
}

async function novoFunil(
  org: string,
  opts: { green?: boolean; etapas?: number } = {},
): Promise<Funil> {
  const id = randomUUID();
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug, is_default) values ($1,$2,'Funil',$3,false)",
    [id, org, `f-${id.slice(0, 8)}`],
  );
  const etapas: string[] = [];
  for (let i = 0; i < (opts.etapas ?? 2); i++) {
    const e = randomUUID();
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,$4,$5,$6)",
      [e, org, id, `E${i + 1}`, `e${i + 1}-${e.slice(0, 6)}`, 1000 * (i + 1)],
    );
    etapas.push(e);
  }
  if (opts.green) {
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [org, id],
    );
  }
  return { id, etapas };
}

async function tenant(): Promise<Tenant> {
  const org = randomUUID();
  const admin = await usuario("adm");
  const agente = await usuario("agt");
  const contato = randomUUID();
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [org, `st-${org}`, `Org ${org.slice(0, 8)}`],
  );
  await membro(admin, org, "admin");
  await membro(agente, org, "agent");
  await pool.query(
    "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,'Maria',$3)",
    [contato, org, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
  );
  const green = await novoFunil(org, { green: true });
  const comum = await novoFunil(org);
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [comum.id]);
  return { org, admin, agente, contato, green, comum };
}

/** Usuário admin em DUAS organizações: a RLS de escrita estrutural aceita as duas pontas. */
async function duplo(a: Tenant, b: Tenant): Promise<string> {
  const u = await usuario("duplo");
  await membro(u, a.org, "admin");
  await membro(u, b.org, "admin");
  return u;
}

const manager = (t: Tenant): Request => ({ papel: "authenticated", sub: t.admin });

/** Leads pelo DONO (fixture): Green passa pela fronteira com o contexto do GUC. */
async function leads(t: Tenant, funil: string, etapa: string, n: number): Promise<string[]> {
  if (n === 0) return [];
  const { rows } = await comoDono(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id)
       select $1,$2,$3,'L'||g,$4 from generate_series(1,$5::int) g returning id`,
    [t.org, funil, etapa, t.contato, n],
  );
  return rows.map((r) => r.id as string);
}
const lead1 = async (t: Tenant, funil: string, etapa: string) =>
  (await leads(t, funil, etapa, 1))[0]!;

const contar = async (sql: string, args: unknown[]) =>
  Number((await pool.query(sql, args)).rows[0].n);
const etapaDe = async (id: string) =>
  (await pool.query("select organization_id, pipeline_id from crm_stages where id=$1", [id]))
    .rows[0] as { organization_id: string; pipeline_id: string } | undefined;
const funilDe = async (id: string) =>
  (await pool.query("select organization_id from crm_pipelines where id=$1", [id])).rows[0]
    ?.organization_id as string | undefined;
const estadoDe = async (id: string) =>
  (await pool.query("select state from green.lead_identity where lead_id=$1", [id])).rows[0]
    ?.state ?? "SEM-LINHA";
const bindingExiste = async (org: string, funil: string) =>
  (await contar(
    "select count(*) n from green.product_pipeline_binding where organization_id=$1 and pipeline_id=$2",
    [org, funil],
  )) === 1;

/**
 * As estruturas IMPOSSÍVEIS do contrato, nas organizações dadas. Vazio = estrutura íntegra.
 * Consulta como dono, por cima da RLS (é o auditor, não um papel de API).
 */
async function estruturaImpossivel(orgs: string[]): Promise<Record<string, string[]>> {
  const q = async (sql: string) =>
    (await pool.query<{ id: string }>(sql, [orgs])).rows.map((r) => r.id);
  return {
    // ST1: lead no domínio Green com etapa fora do funil/organização dele
    greenIncoerente: await q(
      `select l.id::text id from crm_leads l
        where l.organization_id = any($1::uuid[])
          and green.fn_lead_touches_green(l.organization_id, l.pipeline_id, l.stage_id)
          and not exists (select 1 from crm_stages s
                           where s.id = l.stage_id and s.pipeline_id = l.pipeline_id
                             and s.organization_id = l.organization_id)`,
    ),
    // ST2: lead vivo no domínio sem identidade `live`
    greenSemIdentidade: await q(
      `select l.id::text id from crm_leads l
        where l.organization_id = any($1::uuid[])
          and green.fn_lead_touches_green(l.organization_id, l.pipeline_id, l.stage_id)
          and not exists (select 1 from green.lead_identity i where i.lead_id = l.id and i.state = 'live')`,
    ),
    // ST3: etapa num funil de outra organização
    etapaEmFunilAlheio: await q(
      `select s.id::text id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
        where (s.organization_id = any($1::uuid[]) or p.organization_id = any($1::uuid[]))
          and p.organization_id <> s.organization_id`,
    ),
    // ST3: binding de uma organização sobre funil de outra
    bindingEmFunilAlheio: await q(
      `select b.pipeline_id::text id from green.product_pipeline_binding b
         join crm_pipelines p on p.id = b.pipeline_id
        where (b.organization_id = any($1::uuid[]) or p.organization_id = any($1::uuid[]))
          and p.organization_id <> b.organization_id`,
    ),
    // ST3: lead apontando para funil/etapa de outra organização
    leadEmEstruturaAlheia: await q(
      `select l.id::text id from crm_leads l
         join crm_pipelines p on p.id = l.pipeline_id
         join crm_stages s on s.id = l.stage_id
        where (l.organization_id = any($1::uuid[]) or p.organization_id = any($1::uuid[])
               or s.organization_id = any($1::uuid[]))
          and (p.organization_id <> l.organization_id or s.organization_id <> l.organization_id)`,
    ),
  };
}
const INTEGRA = {
  greenIncoerente: [],
  greenSemIdentidade: [],
  etapaEmFunilAlheio: [],
  bindingEmFunilAlheio: [],
  leadEmEstruturaAlheia: [],
};

/** Foto das organizações: md5 das linhas inteiras de toda tabela estrutural e do rastro Green. */
async function foto(orgs: string[]): Promise<Record<string, string>> {
  const md5 = (from: string, ordem: string) =>
    `select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by ${ordem}), '')) h from ${from}`;
  const consultas: Record<string, string> = {
    crm_pipelines: md5("crm_pipelines x where x.organization_id = any($1::uuid[])", "x.id"),
    crm_stages: md5("crm_stages x where x.organization_id = any($1::uuid[])", "x.id"),
    crm_leads: md5("crm_leads x where x.organization_id = any($1::uuid[])", "x.id"),
    binding: md5(
      "green.product_pipeline_binding x where x.organization_id = any($1::uuid[])",
      "x.pipeline_id",
    ),
    lead_identity: md5(
      "green.lead_identity x where x.lead_id in (select id from crm_leads where organization_id = any($1::uuid[]))",
      "x.lead_id",
    ),
    ledger: md5("green.stage_event_ledger x where x.organization_id = any($1::uuid[])", "x.id"),
    event_log: md5("event_log x where x.organization_id = any($1::uuid[])", "x.id"),
  };
  const out: Record<string, string> = {};
  for (const [k, sql] of Object.entries(consultas))
    out[k] = (await pool.query<{ h: string }>(sql, [orgs])).rows[0]!.h;
  return out;
}

const eventosDaOrg = (org: string) =>
  contar("select count(*) n from event_log where organization_id=$1", [org]);

/** Recusa estrutural: erro esperado E nenhuma mudança em nenhuma tabela (sem estado parcial). */
async function esperaRecusa(
  orgs: string[],
  ataque: () => Promise<unknown>,
  mensagem: string | { code: string; semGreen: true },
): Promise<pg.DatabaseError> {
  const antes = await foto(orgs);
  const e = await erroDe(ataque());
  if (DIAG_OUT) {
    const depois = await foto(orgs);
    diagnostico.push({
      caso: expect.getState().currentTestName ?? "?",
      veredito: veredito(e),
      tabelas_mudadas: Object.keys(antes).filter((k) => antes[k] !== depois[k]),
      estrutura: Object.fromEntries(
        Object.entries(await estruturaImpossivel(orgs)).map(([k, v]) => [k, v.length]),
      ),
    });
  }
  if (typeof mensagem === "string") expect(veredito(e)).toContain(mensagem);
  else {
    expect(e?.code, veredito(e)).toBe(mensagem.code);
    expect(e?.message ?? "").not.toContain("green_");
  }
  expect(await foto(orgs)).toEqual(antes);
  expect(await estruturaImpossivel(orgs)).toEqual(INTEGRA);
  return e!;
}

const relocar = (r: Request, etapa: string, funil: string) =>
  request(r, "update crm_stages set pipeline_id=$2 where id=$1", [etapa, funil]);

/* ═══ A/B/C — etapa realocada entre funis (ST4) ══════════════════════════════ */
describe("A — etapa COMUM com leads movida para funil Green", () => {
  it("manager pelo PostgREST: recusado, nada muda (base: os leads entram no Green sem identidade e incoerentes)", async () => {
    const t = await tenant();
    const ls = await leads(t, t.comum.id, t.comum.etapas[0]!, 3);
    await esperaRecusa(
      [t.org],
      () => relocar(manager(t), t.comum.etapas[0]!, t.green.id),
      RELOCACAO,
    );
    for (const id of ls) expect(await estadoDe(id)).toBe("SEM-LINHA");
  });

  it("service_role sem contexto: recusado, nada muda", async () => {
    const t = await tenant();
    await leads(t, t.comum.id, t.comum.etapas[0]!, 3);
    await esperaRecusa(
      [t.org],
      () => relocar(servicoSemContexto, t.comum.etapas[0]!, t.green.id),
      RELOCACAO,
    );
  });

  it("service_role COM contexto válido: o contexto não autoriza realocar estrutura Green", async () => {
    const t = await tenant();
    await leads(t, t.comum.id, t.comum.etapas[0]!, 2);
    await esperaRecusa(
      [t.org],
      () => relocar(servico(), t.comum.etapas[0]!, t.green.id),
      RELOCACAO,
    );
  });

  it("etapa comum VAZIA também não entra em funil Green por UPDATE (não é operação do produto)", async () => {
    const t = await tenant();
    await esperaRecusa(
      [t.org],
      () => relocar(manager(t), t.comum.etapas[1]!, t.green.id),
      RELOCACAO,
    );
  });
});

describe("B — etapa Green com leads movida para funil comum", () => {
  it("manager: recusado (base: leads Green ficam com etapa de outro funil)", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 3);
    await esperaRecusa(
      [t.org],
      () => relocar(manager(t), t.green.etapas[0]!, t.comum.id),
      RELOCACAO,
    );
  });

  it("service_role sem contexto: recusado", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 3);
    await esperaRecusa(
      [t.org],
      () => relocar(servicoSemContexto, t.green.etapas[0]!, t.comum.id),
      RELOCACAO,
    );
  });

  it("etapa Green VAZIA também não sai do funil Green por UPDATE", async () => {
    const t = await tenant();
    await esperaRecusa(
      [t.org],
      () => relocar(manager(t), t.green.etapas[1]!, t.comum.id),
      RELOCACAO,
    );
  });
});

describe("C — etapa Green movida para OUTRO funil Green", () => {
  it("com leads: recusado (base: leads do funil 1 com etapa do funil 2)", async () => {
    const t = await tenant();
    const g2 = await novoFunil(t.org, { green: true });
    await leads(t, t.green.id, t.green.etapas[0]!, 2);
    await esperaRecusa([t.org], () => relocar(manager(t), t.green.etapas[0]!, g2.id), RELOCACAO);
  });
});

/* ═══ D/I — troca de organização (ST3, ST5) ═══════════════════════════════════ */
describe("D — etapa entre organizações", () => {
  it("etapa → funil de OUTRA org (manager só da própria): recusado na FK, igual a funil inexistente", async () => {
    const a = await tenant();
    const b = await tenant();
    await leads(a, a.comum.id, a.comum.etapas[0]!, 2);
    const eGreen = await esperaRecusa(
      [a.org, b.org],
      () => relocar(manager(a), a.comum.etapas[0]!, b.green.id),
      { code: "23503", semGreen: true },
    );
    const eComum = await erroDe(relocar(manager(a), a.comum.etapas[0]!, b.comum.id));
    const eNada = await erroDe(relocar(manager(a), a.comum.etapas[0]!, randomUUID()));
    expect(assinatura(eGreen)).toBe(assinatura(eComum));
    expect(assinatura(eGreen)).toBe(assinatura(eNada));
  });

  it("etapa troca de organização junto com o funil (admin das duas): recusado", async () => {
    const a = await tenant();
    const b = await tenant();
    const u = await duplo(a, b);
    await leads(a, a.comum.id, a.comum.etapas[0]!, 2);
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(
          { papel: "authenticated", sub: u },
          "update crm_stages set organization_id=$2, pipeline_id=$3 where id=$1",
          [a.comum.etapas[0], b.org, b.comum.id],
        ),
      TENANT,
    );
  });

  it("só o organization_id da etapa muda (funil fica): recusado", async () => {
    const a = await tenant();
    const b = await tenant();
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_stages set organization_id=$2 where id=$1", [
          a.comum.etapas[1],
          b.org,
        ]),
      TENANT,
    );
  });
});

describe("I — funil troca de organização", () => {
  it("funil Green com binding, etapas e leads (admin das duas pelo PostgREST): recusado", async () => {
    const a = await tenant();
    const b = await tenant();
    const u = await duplo(a, b);
    await leads(a, a.green.id, a.green.etapas[0]!, 3);
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(
          { papel: "authenticated", sub: u },
          "update crm_pipelines set organization_id=$2 where id=$1",
          [a.green.id, b.org],
        ),
      TENANT,
    );
  });

  it("funil comum (não padrão) com etapas e leads (service_role): recusado", async () => {
    const a = await tenant();
    const b = await tenant();
    const c = await novoFunil(a.org); // o padrão esbarraria em uniq_crm_pipelines_org_default
    await leads(a, c.id, c.etapas[0]!, 2);
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_pipelines set organization_id=$2 where id=$1", [
          c.id,
          b.org,
        ]),
      TENANT,
    );
  });

  it("funil vazio (sem etapa, lead ou binding) também não troca de tenant: estrutura não muda de dono", async () => {
    const a = await tenant();
    const b = await tenant();
    const vazio = randomUUID();
    await pool.query(
      "insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'Vazio',$3)",
      [vazio, a.org, `v-${vazio.slice(0, 8)}`],
    );
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_pipelines set organization_id=$2 where id=$1", [
          vazio,
          b.org,
        ]),
      TENANT,
    );
    expect(await funilDe(vazio)).toBe(a.org);
  });
});

/* ═══ E/F — o próprio lead deixa etapa e funil incompatíveis (fronteira de crm_leads) ═══ */
describe("E/F — mismatch pelo lead (controle: a fronteira de crm_leads já recusa)", () => {
  it("E — lead Green troca só o pipeline_id (etapa Green fica): green_stage_not_bound", async () => {
    const t = await tenant();
    const id = await lead1(t, t.green.id, t.green.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () => request(servico(), "update crm_leads set pipeline_id=$2 where id=$1", [id, t.comum.id]),
      NAO_VINCULADA,
    );
  });

  it("E — lead comum troca só o pipeline_id para o Green: green_stage_not_bound", async () => {
    const t = await tenant();
    const id = await lead1(t, t.comum.id, t.comum.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () =>
        request(manager(t), "update crm_leads set pipeline_id=$2 where id=$1", [id, t.green.id]),
      NAO_VINCULADA,
    );
  });

  it("F — lead Green troca só o stage_id para etapa comum: green_stage_not_bound", async () => {
    const t = await tenant();
    const id = await lead1(t, t.green.id, t.green.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () =>
        request(servico(), "update crm_leads set stage_id=$2 where id=$1", [id, t.comum.etapas[0]]),
      NAO_VINCULADA,
    );
  });

  it("F — lead comum troca só o stage_id para etapa Green: green_stage_not_bound", async () => {
    const t = await tenant();
    const id = await lead1(t, t.comum.id, t.comum.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () =>
        request(manager(t), "update crm_leads set stage_id=$2 where id=$1", [
          id,
          t.green.etapas[0],
        ]),
      NAO_VINCULADA,
    );
  });

  it("F — UPSTREAM medido: lead comum com etapa de OUTRO funil comum é aceito (o lote do produto faz isso)", async () => {
    const t = await tenant();
    const c2 = await novoFunil(t.org);
    const id = await lead1(t, t.comum.id, t.comum.etapas[0]!);
    const e = await erroDe(
      request(manager(t), "update crm_leads set stage_id=$2 where id=$1", [id, c2.etapas[0]]),
    );
    expect(e, veredito(e)).toBeNull();
    // fora do domínio: nada Green fica impossível
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });
});

/* ═══ G — binding sobre estrutura (ST6) ═══════════════════════════════════════ */
describe("G — binding sobre funil que já tem leads/etapas", () => {
  const ligar = (org: string, funil: string) =>
    pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [org, funil],
    );

  it("controle: funil coerente com leads → binding aceito, todos `live`", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    const ls = await leads(t, f.id, f.etapas[0]!, 5);
    await ligar(t.org, f.id);
    for (const id of ls) expect(await estadoDe(id)).toBe("live");
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("lead do funil com etapa de OUTRO funil: binding recusado, nenhuma identidade (base: lead Green incoerente)", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    const ok = await leads(t, f.id, f.etapas[0]!, 3);
    const torto = await lead1(t, f.id, t.comum.etapas[0]!); // comum: o upstream aceita
    await esperaRecusa([t.org], () => ligar(t.org, f.id), BINDING_INVALIDO);
    expect(await bindingExiste(t.org, f.id)).toBe(false);
    for (const id of [...ok, torto]) expect(await estadoDe(id)).toBe("SEM-LINHA");
  });

  it("lead de OUTRO funil com etapa deste: binding recusado (base: o lead entra no Green pela etapa)", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    const torto = await lead1(t, t.comum.id, f.etapas[0]!);
    await esperaRecusa([t.org], () => ligar(t.org, f.id), BINDING_INVALIDO);
    expect(await estadoDe(torto)).toBe("SEM-LINHA");
  });

  it("re-apontar binding existente para funil incoerente: recusado, binding antigo intacto", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    await lead1(t, f.id, t.comum.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () =>
        pool.query(
          "update green.product_pipeline_binding set pipeline_id=$2 where organization_id=$1 and pipeline_id=$3",
          [t.org, f.id, t.green.id],
        ),
      BINDING_INVALIDO,
    );
    expect(await bindingExiste(t.org, t.green.id)).toBe(true);
  });

  it("binding de uma org sobre funil de OUTRA org (dono): recusado na FK", async () => {
    const a = await tenant();
    const b = await tenant();
    await leads(b, b.comum.id, b.comum.etapas[0]!, 2);
    await esperaRecusa([a.org, b.org], () => ligar(a.org, b.comum.id), {
      code: "23503",
      semGreen: true,
    });
  });

  it("papéis de API não escrevem binding (controle): authenticated e service_role 42501", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    for (const r of [manager(t), servicoSemContexto]) {
      const e = await erroDe(
        request(
          r,
          "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'x')",
          [t.org, f.id],
        ),
      );
      expect(e?.code, veredito(e)).toBe("42501");
    }
  });
});

/* ═══ H — remoção / troca de binding (ST6): contrato explícito ═════════════════ */
describe("H — remoção de binding: migração administrativa, auditada, sem perder identidade", () => {
  const auditoria = async (funil: string) =>
    (
      await pool.query(
        "select organization_id, metadata from api_audit_log where action='green.binding_removed' and resource_id=$1 order by created_at",
        [funil],
      )
    ).rows as { organization_id: string | null; metadata: Record<string, unknown> }[];

  it("DELETE do binding com N leads: auditoria diz quantos leads saíram; identidades seguem `live`", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 4);
    const eventos = await eventosDaOrg(t.org);
    await pool.query("delete from green.product_pipeline_binding where pipeline_id=$1", [
      t.green.id,
    ]);
    const [a] = await auditoria(t.green.id);
    expect(a?.organization_id).toBe(t.org);
    expect(a?.metadata).toMatchObject({
      released_leads: 4,
      operation: "delete",
      org_deleted: false,
    });
    for (const id of ls) expect(await estadoDe(id)).toBe("live");
    expect(await eventosDaOrg(t.org)).toBe(eventos); // saída estrutural não emite evento (GREEN-03)
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("UPDATE que re-aponta o binding: a saída do funil antigo também é auditada (base: silenciosa)", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 3);
    const novo = await novoFunil(t.org);
    await pool.query(
      "update green.product_pipeline_binding set pipeline_id=$2 where organization_id=$1 and pipeline_id=$3",
      [t.org, novo.id, t.green.id],
    );
    const [a] = await auditoria(t.green.id);
    expect(a?.metadata).toMatchObject({
      released_leads: 3,
      operation: "update",
      new_pipeline_id: novo.id,
    });
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("lead solto pela remoção continua com UUID não reciclável (controle do lifecycle)", async () => {
    const t = await tenant();
    const [id] = await leads(t, t.green.id, t.green.etapas[0]!, 1);
    await pool.query("delete from green.product_pipeline_binding where pipeline_id=$1", [
      t.green.id,
    ]);
    await request(servico(), "delete from crm_leads where id=$1", [id]);
    expect(await estadoDe(id!)).toBe("retired");
    const e = await erroDe(
      comoDono(
        "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,$4,'x')",
        [id, t.org, t.comum.id, t.comum.etapas[0]],
      ),
    );
    expect(e, veredito(e)).toBeNull(); // comum com UUID aposentado: aceito (v1.3, binding atômico)
    // o funil original deixou de ser Green: a reentrada é medida num funil Green novo
    const g3 = await novoFunil(t.org);
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, g3.id],
    );
    const e2 = await erroDe(
      request(servico(), "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
        id,
        g3.id,
        g3.etapas[0],
      ]),
    );
    expect(veredito(e2)).toContain("green_lead_id_reuse_forbidden");
  });

  it("papéis de API não apagam nem re-apontam binding (controle)", async () => {
    const t = await tenant();
    for (const r of [manager(t), servicoSemContexto]) {
      const d = await erroDe(
        request(r, "delete from green.product_pipeline_binding where pipeline_id=$1", [t.green.id]),
      );
      expect(d?.code, veredito(d)).toBe("42501");
    }
    expect(await bindingExiste(t.org, t.green.id)).toBe(true);
  });
});

/* ═══ J/K — DELETE e arquivamento de etapa e funil (S7) ════════════════════════ */
describe("J — DELETE / arquivamento de etapa usada por Green", () => {
  it("DELETE de etapa com leads Green: RESTRICT, nada muda (controle)", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 2);
    await esperaRecusa(
      [t.org],
      () => request(manager(t), "delete from crm_stages where id=$1", [t.green.etapas[0]]),
      { code: "23503", semGreen: true },
    );
  });

  it("arquivar com destino (o que a rota e o MCP fazem): move os leads pela fronteira e arquiva", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 3);
    await request(
      servico(),
      "update crm_leads set stage_id=$2 where organization_id=$3 and stage_id=$1",
      [t.green.etapas[0], t.green.etapas[1], t.org],
    );
    await request(manager(t), "update crm_stages set is_archived=true where id=$1", [
      t.green.etapas[0],
    ]);
    expect(
      await contar(
        "select count(*) n from event_log where event_type='lead.stage_changed' and entity_id = any($1::uuid[]) and metadata->>'green_canonical'='true'",
        [ls],
      ),
    ).toBe(3);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("arquivar etapa COM leads Green sem mover (configuração): leads seguem coerentes, nada Green muda", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 2);
    await request(manager(t), "update crm_stages set is_archived=true where id=$1", [
      t.green.etapas[0],
    ]);
    for (const id of ls) expect(await estadoDe(id)).toBe("live");
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("DELETE de etapa Green VAZIA: configuração, aceito", async () => {
    const t = await tenant();
    await request(manager(t), "delete from crm_stages where id=$1", [t.green.etapas[1]]);
    expect(await etapaDe(t.green.etapas[1]!)).toBeUndefined();
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });
});

describe("K — DELETE / arquivamento de funil Green", () => {
  it("DELETE de funil Green com leads: RESTRICT, binding e etapas intactos (controle)", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 2);
    await esperaRecusa(
      [t.org],
      () => request(manager(t), "delete from crm_pipelines where id=$1", [t.green.id]),
      { code: "23503", semGreen: true },
    );
    expect(await bindingExiste(t.org, t.green.id)).toBe(true);
  });

  it("DELETE de funil Green VAZIO: cascata leva etapas e binding, auditada com 0 leads soltos", async () => {
    const t = await tenant();
    await request(manager(t), "delete from crm_pipelines where id=$1", [t.green.id]);
    expect(await bindingExiste(t.org, t.green.id)).toBe(false);
    expect(
      await contar("select count(*) n from crm_stages where pipeline_id=$1", [t.green.id]),
    ).toBe(0);
    const { rows } = await pool.query(
      "select metadata from api_audit_log where action='green.binding_removed' and resource_id=$1",
      [t.green.id],
    );
    expect(rows[0]?.metadata).toMatchObject({ released_leads: 0, operation: "delete" });
  });

  it("lead com etapa do funil Green mas pipeline de outro funil não pode existir; a cascata não deixa órfão", async () => {
    const t = await tenant();
    // a única forma de um lead apontar para a etapa sem estar no funil é ser recusado pela fronteira
    const e = await erroDe(lead1(t, t.comum.id, t.green.etapas[0]!));
    expect(veredito(e)).toContain(NAO_VINCULADA);
    await request(manager(t), "delete from crm_pipelines where id=$1", [t.green.id]);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("arquivar funil Green com leads (o que a rota faz por padrão): configuração, leads seguem Green e coerentes", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 2);
    await request(manager(t), "update crm_pipelines set is_archived=true where id=$1", [
      t.green.id,
    ]);
    for (const id of ls) expect(await estadoDe(id)).toBe("live");
    expect(await bindingExiste(t.org, t.green.id)).toBe(true);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });
});

/* ═══ L/M — papéis: PostgREST de usuário e service_role sem contexto ═══════════ */
describe("L/M — papéis", () => {
  it("L — agent (não manager) tentando realocar etapa: a RLS filtra, 0 linhas, nenhum erro Green", async () => {
    const t = await tenant();
    const r = await request(
      { papel: "authenticated", sub: t.agente },
      "update crm_stages set pipeline_id=$2 where id=$1",
      [t.green.etapas[0], t.comum.id],
    );
    expect(r.rowCount).toBe(0);
    expect((await etapaDe(t.green.etapas[0]!))?.pipeline_id).toBe(t.green.id);
  });

  it("L — manager de OUTRA org tentando realocar etapa Green alheia: 0 linhas, indistinguível de etapa comum alheia", async () => {
    const a = await tenant();
    const b = await tenant();
    const g = await request(manager(b), "update crm_stages set pipeline_id=$2 where id=$1", [
      a.green.etapas[0],
      a.comum.id,
    ]);
    const c = await request(manager(b), "update crm_stages set pipeline_id=$2 where id=$1", [
      a.comum.etapas[0],
      a.green.id,
    ]);
    expect([g.rowCount, c.rowCount]).toEqual([0, 0]);
    expect(await estruturaImpossivel([a.org, b.org])).toEqual(INTEGRA);
  });

  it("M — service_role sem contexto: toda realocação Green e troca de tenant recusadas (contexto não é a regra)", async () => {
    const a = await tenant();
    const b = await tenant();
    await leads(a, a.green.id, a.green.etapas[0]!, 1);
    await esperaRecusa(
      [a.org],
      () => relocar(servicoSemContexto, a.green.etapas[0]!, a.comum.id),
      RELOCACAO,
    );
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_pipelines set organization_id=$2 where id=$1", [
          a.green.id,
          b.org,
        ]),
      TENANT,
    );
  });
});

/* ═══ N — operações legítimas (controle: base e spike iguais) ═════════════════ */
describe("N — operações legítimas do produto continuam funcionando", () => {
  it("renomear, recolorir, reordenar e marcar etapa Green (manager): aceito, sem evento, leads intactos", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 2);
    const eventos = await eventosDaOrg(t.org);
    await request(
      manager(t),
      "update crm_stages set name='Nova', color='#112233', position=5000, win_probability=40, avisar_na_central=true where id=$1",
      [t.green.etapas[0]],
    );
    expect(await eventosDaOrg(t.org)).toBe(eventos);
    for (const id of ls) expect(await estadoDe(id)).toBe("live");
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("criar etapa nova em funil Green e funil novo (manager): aceito", async () => {
    const t = await tenant();
    await request(
      manager(t),
      "insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1,$2,'Nova','nova-x',9000)",
      [t.org, t.green.id],
    );
    await request(
      manager(t),
      "insert into crm_pipelines (organization_id, name, slug) values ($1,'Outro','outro-x')",
      [t.org],
    );
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("etapa comum (com leads comuns) realocada entre funis COMUNS: upstream preservado, nada Green", async () => {
    const t = await tenant();
    const c2 = await novoFunil(t.org);
    await leads(t, t.comum.id, t.comum.etapas[0]!, 2);
    const e = await erroDe(relocar(servicoSemContexto, t.comum.etapas[0]!, c2.id));
    expect(e, veredito(e)).toBeNull();
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("RPC do onboarding troca as etapas de um funil Green VAZIO (service_role): aceito, coerente", async () => {
    const t = await tenant();
    const { rows } = await request(
      servicoSemContexto,
      "select public.fn_aplicar_quadro_do_onboarding($1,$2,'Energia','energia-x',$3::jsonb) as r",
      [
        t.org,
        t.green.id,
        JSON.stringify([
          { nome: "Contato", slug: "contato", position: 1000 },
          { nome: "Fechado", slug: "fechado", position: 2000, is_won: true },
        ]),
      ],
    );
    expect(rows[0]!.r).toMatchObject({ ok: true, etapas: 2 });
    expect(await bindingExiste(t.org, t.green.id)).toBe(true);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("organização nova semeia o funil padrão coerente", async () => {
    const org = randomUUID();
    await pool.query(
      "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Nova','Nova')",
      [org, `nova-${org}`],
    );
    expect(await contar("select count(*) n from crm_stages where organization_id=$1", [org])).toBe(
      8,
    );
    expect(await estruturaImpossivel([org])).toEqual(INTEGRA);
  });

  it("no-op de organização (`organization_id = organization_id`, travas do suporte): aceito", async () => {
    const t = await tenant();
    await request(
      servicoSemContexto,
      "update crm_pipelines set organization_id=organization_id where id=$1",
      [t.green.id],
    );
    await request(
      servicoSemContexto,
      "update crm_stages set organization_id=organization_id, pipeline_id=pipeline_id where id=$1",
      [t.green.etapas[0]],
    );
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });
});

/* ═══ X — cross-tenant (ST3, ST7) ═════════════════════════════════════════════ */
describe("X — cross-tenant: estrutura de B inalcançável e indistinguível para A", () => {
  it("X1 — etapa da org A criada dentro de funil da B: Green ≡ comum ≡ inexistente, sem erro Green", async () => {
    const a = await tenant();
    const b = await tenant();
    const sonda = (funil: string) =>
      erroDe(
        request(
          manager(a),
          "insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1,$2,'X',$3,1)",
          [a.org, funil, `x-${randomUUID().slice(0, 8)}`],
        ),
      );
    const antes = await foto([a.org, b.org]);
    const [g, c, n] = [await sonda(b.green.id), await sonda(b.comum.id), await sonda(randomUUID())];
    expect(g?.code, veredito(g)).toBe("23503");
    expect(assinatura(g)).toBe(assinatura(c));
    expect(assinatura(g)).toBe(assinatura(n));
    expect(g?.message).not.toContain("green_");
    expect(await foto([a.org, b.org])).toEqual(antes);
  });

  it("X3 — lead da org A usando funil+etapa da B: Green ≡ comum ≡ inexistente; nada é gravado", async () => {
    const a = await tenant();
    const b = await tenant();
    const sonda = (funil: string, etapa: string) =>
      erroDe(
        request(
          manager(a),
          "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'sonda')",
          [a.org, funil, etapa],
        ),
      );
    const antes = await foto([a.org, b.org]);
    const g = await sonda(b.green.id, b.green.etapas[0]!);
    const c = await sonda(b.comum.id, b.comum.etapas[0]!);
    const n = await sonda(randomUUID(), randomUUID());
    expect(g?.code, veredito(g)).toBe("23503");
    expect(assinatura(g)).toBe(assinatura(c));
    expect(assinatura(g)).toBe(assinatura(n));
    expect(await foto([a.org, b.org])).toEqual(antes);
  });

  it("X3b — lead da A no PRÓPRIO funil com etapa da B (Green/comum/inexistente): mesma recusa", async () => {
    const a = await tenant();
    const b = await tenant();
    const sonda = (etapa: string) =>
      erroDe(
        request(
          manager(a),
          "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'sonda')",
          [a.org, a.comum.id, etapa],
        ),
      );
    const [g, c, n] = [
      await sonda(b.green.etapas[0]!),
      await sonda(b.comum.etapas[0]!),
      await sonda(randomUUID()),
    ];
    expect(g?.code, veredito(g)).toBe("23503");
    expect(assinatura(g)).toBe(assinatura(c));
    expect(assinatura(g)).toBe(assinatura(n));
  });

  it("X3c — UPDATE do próprio lead para etapa da B: mesma recusa que etapa inexistente", async () => {
    const a = await tenant();
    const b = await tenant();
    const id = await lead1(a, a.comum.id, a.comum.etapas[0]!);
    const sonda = (etapa: string) =>
      erroDe(request(manager(a), "update crm_leads set stage_id=$2 where id=$1", [id, etapa]));
    const [g, n] = [await sonda(b.green.etapas[0]!), await sonda(randomUUID())];
    expect(g?.code, veredito(g)).toBe("23503");
    expect(assinatura(g)).toBe(assinatura(n));
    expect(await estruturaImpossivel([a.org, b.org])).toEqual(INTEGRA);
  });

  it("X4 — service_role realocando estrutura entre tenants: etapa → funil da B e funil → org B recusados", async () => {
    const a = await tenant();
    const b = await tenant();
    await esperaRecusa(
      [a.org, b.org],
      () => relocar(servicoSemContexto, a.comum.etapas[1]!, b.comum.id),
      {
        code: "23503",
        semGreen: true,
      },
    );
    const c = await novoFunil(a.org);
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_pipelines set organization_id=$2 where id=$1", [
          c.id,
          b.org,
        ]),
      TENANT,
    );
  });

  it("X5 — A não lê estrutura nem binding da B (RLS e schema green fechados)", async () => {
    const a = await tenant();
    const b = await tenant();
    const s = await request(manager(a), "select id from crm_stages where organization_id=$1", [
      b.org,
    ]);
    const p = await request(manager(a), "select id from crm_pipelines where organization_id=$1", [
      b.org,
    ]);
    expect([s.rowCount, p.rowCount]).toEqual([0, 0]);
    const e = await erroDe(request(manager(a), "select * from green.product_pipeline_binding"));
    expect(e?.code, veredito(e)).toBe("42501");
  });

  it("X6 — a B segue dona da própria estrutura: depois das sondas da A, apagar etapa vazia da B funciona", async () => {
    const a = await tenant();
    const b = await tenant();
    await erroDe(
      request(
        manager(a),
        "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'sonda')",
        [a.org, b.green.id, b.green.etapas[1]],
      ),
    );
    const e = await erroDe(
      request(manager(b), "delete from crm_stages where id=$1", [b.green.etapas[1]]),
    );
    expect(e, veredito(e)).toBeNull();
  });
});

/* ═══ AT — atomicidade: tudo ou nada em operação multi-lead ═══════════════════ */
describe("AT — atomicidade de operações estruturais multi-lead", () => {
  it("AT1 — binding com 500 leads coerentes: 500 `live`, numa transação", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    const ls = await leads(t, f.id, f.etapas[0]!, 500);
    const t0 = Date.now();
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, f.id],
    );
    const ms = Date.now() - t0;
    expect(
      await contar(
        "select count(*) n from green.lead_identity where state='live' and lead_id = any($1::uuid[])",
        [ls],
      ),
    ).toBe(500);
    expect(ms).toBeLessThan(8000); // cabe no teto de statement do PostgREST
  }, 60_000);

  it("AT2 — binding com 499 coerentes + 1 incoerente: recusado inteiro, 0 identidades", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    const ls = await leads(t, f.id, f.etapas[0]!, 499);
    await lead1(t, f.id, t.comum.etapas[0]!);
    await esperaRecusa(
      [t.org],
      () =>
        pool.query(
          "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
          [t.org, f.id],
        ),
      BINDING_INVALIDO,
    );
    expect(
      await contar("select count(*) n from green.lead_identity where lead_id = any($1::uuid[])", [
        ls,
      ]),
    ).toBe(0);
  }, 60_000);

  it("AT3 — etapa Green com 500 leads realocada: recusada inteira, nada muda", async () => {
    const t = await tenant();
    await leads(t, t.green.id, t.green.etapas[0]!, 500);
    await esperaRecusa(
      [t.org],
      () => relocar(manager(t), t.green.etapas[0]!, t.comum.id),
      RELOCACAO,
    );
  }, 60_000);

  it("AT4 — arquivamento com destino de 500 leads Green numa instrução, 1 destino inválido: nenhum move", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 500);
    await esperaRecusa(
      [t.org],
      () =>
        request(
          servico(),
          "update crm_leads set stage_id = case when id=$4 then $5::uuid else $2::uuid end where organization_id=$3 and stage_id=$1",
          [t.green.etapas[0], t.green.etapas[1], t.org, ls[250], t.comum.etapas[0]],
        ),
      NAO_VINCULADA,
    );
  }, 60_000);

  it("AT5 — funil Green com 500 leads trocando de organização: recusado inteiro", async () => {
    const a = await tenant();
    const b = await tenant();
    await leads(a, a.green.id, a.green.etapas[0]!, 500);
    await esperaRecusa(
      [a.org, b.org],
      () =>
        request(servicoSemContexto, "update crm_pipelines set organization_id=$2 where id=$1", [
          a.green.id,
          b.org,
        ]),
      TENANT,
    );
  }, 60_000);

  it("AT6 — remoção de binding com 500 leads: uma linha de auditoria com 500, todos seguem `live`", async () => {
    const t = await tenant();
    const ls = await leads(t, t.green.id, t.green.etapas[0]!, 500);
    await pool.query("delete from green.product_pipeline_binding where pipeline_id=$1", [
      t.green.id,
    ]);
    const { rows } = await pool.query(
      "select metadata from api_audit_log where action='green.binding_removed' and resource_id=$1",
      [t.green.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ released_leads: 500 });
    expect(
      await contar(
        "select count(*) n from green.lead_identity where state='live' and lead_id = any($1::uuid[])",
        [ls],
      ),
    ).toBe(500);
  }, 60_000);
});

/* ═══ C — concorrência: nenhum commit deixa estrutura impossível ═══════════════ */
describe("C — concorrência", () => {
  const ligarEm = (c: pg.PoolClient, org: string, funil: string) =>
    c.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [org, funil],
    );

  it("C1 — realocar etapa para Green × INSERT de lead nela (lead em voo antes): o lead fica comum e íntegro", async () => {
    const t = await tenant();
    const c1 = await transacaoDoDono();
    const novo = randomUUID();
    await c1.query(
      "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,$4,'Em voo')",
      [novo, t.org, t.comum.id, t.comum.etapas[0]],
    );
    const reloc = erroDe(relocar(servicoSemContexto, t.comum.etapas[0]!, t.green.id));
    await esperar(400);
    await c1.query("commit");
    c1.release();
    const e = await reloc;
    expect(veredito(e)).toContain(RELOCACAO);
    expect(await etapaDe(t.comum.etapas[0]!)).toMatchObject({ pipeline_id: t.comum.id });
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C2a — realocar etapa comum→comum (em voo) × binding do funil de destino: o binding espera e recusa", async () => {
    const t = await tenant();
    const destino = await novoFunil(t.org);
    await leads(t, t.comum.id, t.comum.etapas[0]!, 3);
    const c1 = await requestAberta(servicoSemContexto);
    await c1.query("update crm_stages set pipeline_id=$2 where id=$1", [
      t.comum.etapas[0],
      destino.id,
    ]);
    const cb = await pool.connect();
    const binding = erroDe(ligarEm(cb, t.org, destino.id));
    await esperar(400);
    await c1.query("commit");
    c1.release();
    const e = await binding;
    cb.release();
    expect(veredito(e)).toContain(BINDING_INVALIDO);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C2b — binding do destino (em voo) × realocar etapa comum para ele: a realocação espera e recusa", async () => {
    const t = await tenant();
    const destino = await novoFunil(t.org);
    await leads(t, t.comum.id, t.comum.etapas[0]!, 3);
    const cb = await pool.connect();
    await cb.query("begin");
    await ligarEm(cb, t.org, destino.id);
    const reloc = erroDe(relocar(servicoSemContexto, t.comum.etapas[0]!, destino.id));
    await esperar(400);
    await cb.query("commit");
    cb.release();
    const e = await reloc;
    expect(veredito(e)).toContain(RELOCACAO);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C3a — lead comum indo para etapa de outro funil (em voo) × binding desse funil: binding recusa", async () => {
    const t = await tenant();
    const x = await novoFunil(t.org);
    const id = await lead1(t, t.comum.id, t.comum.etapas[0]!);
    const c1 = await transacaoDoDono();
    await c1.query("update crm_leads set stage_id=$2 where id=$1", [id, x.etapas[0]]);
    const binding = erroDe(
      pool.query(
        "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
        [t.org, x.id],
      ),
    );
    await esperar(400);
    await c1.query("commit");
    c1.release();
    expect(veredito(await binding)).toContain(BINDING_INVALIDO);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C3b — binding (em voo) × lead comum indo para etapa do funil: o lead espera e a fronteira recusa", async () => {
    const t = await tenant();
    const x = await novoFunil(t.org);
    const id = await lead1(t, t.comum.id, t.comum.etapas[0]!);
    const cb = await pool.connect();
    await cb.query("begin");
    await ligarEm(cb, t.org, x.id);
    const move = erroDe(
      request(servico(), "update crm_leads set stage_id=$2 where id=$1", [id, x.etapas[0]]),
    );
    await esperar(400);
    await cb.query("commit");
    cb.release();
    expect(veredito(await move)).toContain(NAO_VINCULADA);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C4 — DELETE de etapa × lead entrando nela (as duas ordens): FK serializa, nada órfão", async () => {
    const t = await tenant();
    // ordem 1: delete em voo, depois o lead
    const c1 = await requestAberta(manager(t));
    await c1.query("delete from crm_stages where id=$1", [t.green.etapas[1]]);
    const id = await lead1(t, t.green.id, t.green.etapas[0]!);
    const move = erroDe(
      request(servico(), "update crm_leads set stage_id=$2 where id=$1", [id, t.green.etapas[1]]),
    );
    await esperar(300);
    await c1.query("commit");
    c1.release();
    expect((await move)?.code).toBe("23503");
    // ordem 2: lead em voo, depois o delete
    const etapa = randomUUID();
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'E9','e9-x',9000)",
      [etapa, t.org, t.green.id],
    );
    const c2 = await requestAberta(servico());
    await c2.query("update crm_leads set stage_id=$2 where id=$1", [id, etapa]);
    const del = erroDe(request(manager(t), "delete from crm_stages where id=$1", [etapa]));
    await esperar(300);
    await c2.query("commit");
    c2.release();
    expect((await del)?.code).toBe("23503");
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C5 — DELETE de funil × binding dele (as duas ordens): nada órfão", async () => {
    const t = await tenant();
    const f1 = await novoFunil(t.org);
    const c1 = await requestAberta(manager(t));
    await c1.query("delete from crm_pipelines where id=$1", [f1.id]);
    const b1 = erroDe(
      pool.query(
        "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
        [t.org, f1.id],
      ),
    );
    await esperar(300);
    await c1.query("commit");
    c1.release();
    expect((await b1)?.code).toBe("23503");

    const f2 = await novoFunil(t.org);
    const cb = await pool.connect();
    await cb.query("begin");
    await ligarEm(cb, t.org, f2.id);
    const del = erroDe(request(manager(t), "delete from crm_pipelines where id=$1", [f2.id]));
    await esperar(300);
    await cb.query("commit");
    cb.release();
    expect(await del).toBeNull();
    expect(await bindingExiste(t.org, f2.id)).toBe(false);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C6 — duas realocações comuns→X (em voo) × binding de X: o binding espera as duas e recusa", async () => {
    const t = await tenant();
    const x = await novoFunil(t.org);
    const c3 = await novoFunil(t.org);
    await leads(t, t.comum.id, t.comum.etapas[0]!, 2);
    await leads(t, c3.id, c3.etapas[0]!, 2);
    const r1 = await requestAberta(servicoSemContexto);
    await r1.query("update crm_stages set pipeline_id=$2 where id=$1", [t.comum.etapas[0], x.id]);
    const r2 = await requestAberta(servicoSemContexto);
    await r2.query("update crm_stages set pipeline_id=$2 where id=$1", [c3.etapas[0], x.id]);
    const binding = erroDe(
      pool.query(
        "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
        [t.org, x.id],
      ),
    );
    await esperar(300);
    await r1.query("commit");
    r1.release();
    await esperar(200);
    await r2.query("commit");
    r2.release();
    expect(veredito(await binding)).toContain(BINDING_INVALIDO);
    expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
  });

  it("C7 — rajadas: realocações, bindings, leads tortos, movimentos e DELETEs simultâneos nunca deixam estrutura impossível", async () => {
    const t = await tenant();
    for (let rodada = 0; rodada < 8; rodada++) {
      const alvo = await novoFunil(t.org);
      const outro = await novoFunil(t.org);
      const ls = await leads(t, outro.id, outro.etapas[0]!, 3);
      const ops: Promise<unknown>[] = [
        erroDe(relocar(servicoSemContexto, outro.etapas[0]!, alvo.id)),
        erroDe(
          pool.query(
            "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
            [t.org, alvo.id],
          ),
        ),
        erroDe(comoDono("update crm_leads set stage_id=$2 where id=$1", [ls[0], alvo.etapas[0]])),
        erroDe(
          comoDono("update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
            ls[1],
            alvo.id,
            alvo.etapas[1],
          ]),
        ),
        erroDe(request(servico(), "delete from crm_leads where id=$1", [ls[2]])),
        erroDe(relocar(servicoSemContexto, alvo.etapas[1]!, outro.id)),
        erroDe(request(manager(t), "delete from crm_stages where id=$1", [outro.etapas[1]])),
      ];
      await Promise.all(ops);
      expect(await estruturaImpossivel([t.org])).toEqual(INTEGRA);
    }
  }, 120_000);
});

/* ═══ EV — eventos de mutação estrutural (classificação para GREEN-03) ═════════ */
describe("EV — eventos: estrutura não emite; o lead que se move pela fronteira emite", () => {
  it("binding novo com leads: identidade sim, evento canônico de entrada não (medido; GREEN-03)", async () => {
    const t = await tenant();
    const f = await novoFunil(t.org);
    await leads(t, f.id, f.etapas[0]!, 3);
    const antes = await eventosDaOrg(t.org);
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, f.id],
    );
    expect(await eventosDaOrg(t.org)).toBe(antes);
  });

  it("configuração estrutural (criar/arquivar/apagar etapa vazia, arquivar funil) não emite evento", async () => {
    const t = await tenant();
    const antes = await eventosDaOrg(t.org);
    await request(manager(t), "update crm_stages set is_archived=true where id=$1", [
      t.green.etapas[1],
    ]);
    await request(manager(t), "delete from crm_stages where id=$1", [t.comum.etapas[1]]);
    await request(manager(t), "update crm_pipelines set is_archived=true where id=$1", [
      t.green.id,
    ]);
    expect(await eventosDaOrg(t.org)).toBe(antes);
  });
});

/* ═══ O — cascata de organização (sem reabrir a zona de perigo) ═══════════════ */
describe("O — cascata de organização com estrutura Green", () => {
  it("apagar a org leva funis, etapas, binding e leads; identidades aposentadas; vizinha idêntica; auditoria sem contagem", async () => {
    const a = await tenant();
    const b = await tenant();
    const ls = await leads(a, a.green.id, a.green.etapas[0]!, 3);
    await leads(b, b.green.id, b.green.etapas[0]!, 2);
    const vizinha = await foto([b.org]);
    await request(servicoSemContexto, "delete from organizations where id=$1", [a.org]);
    for (const tabela of [
      "crm_pipelines",
      "crm_stages",
      "crm_leads",
      "green.product_pipeline_binding",
    ])
      expect(
        await contar(`select count(*) n from ${tabela} where organization_id=$1`, [a.org]),
      ).toBe(0);
    for (const id of ls) expect(await estadoDe(id)).toBe("retired");
    expect(await foto([b.org])).toEqual(vizinha);
    const { rows } = await pool.query(
      "select metadata from api_audit_log where action='green.binding_removed' and metadata->>'organization_id'=$1",
      [a.org],
    );
    expect(rows[0]?.metadata).toMatchObject({ org_deleted: true, released_leads: null });
    expect(await estruturaImpossivel([b.org])).toEqual(INTEGRA);
  });
});

/* ═══ U — upgrade 0506 → 0507 com dados estruturais reais ═════════════════════ */
describe("U — upgrade 0506 → 0507", () => {
  const MIG = (arq: string) =>
    readFileSync(join(process.cwd(), "supabase/migrations", arq), "utf8");
  const M0503 = MIG("20261001120000_0503_spike_green_lead_lifecycle.sql");
  const M0507 = () => MIG("20261004090000_0507_spike_green_structural_boundary.sql");

  function funcao(sql: string, nome: string): string {
    const ini = sql.indexOf(`create or replace function ${nome}(`);
    const fim = sql.indexOf("end $$;", ini) + "end $$;".length;
    if (ini < 0 || fim < ini) throw new Error(`função ${nome} não encontrada`);
    return sql.slice(ini, fim);
  }

  /** Rebaixa o banco ao estado da 0506 (FKs simples, sem guardas estruturais, auditoria da 0503). */
  async function rebaixarPara0506() {
    await pool.query(`
      drop trigger if exists trg_green_structure_stage on public.crm_stages;
      drop trigger if exists trg_green_structure_pipeline on public.crm_pipelines;
      drop trigger if exists trg_green_binding_structure on green.product_pipeline_binding;
      drop trigger if exists trg_green_binding_repointed_audit on green.product_pipeline_binding;
      drop function if exists green.fn_structure_stage_guard();
      drop function if exists green.fn_structure_pipeline_guard();
      drop function if exists green.fn_binding_structure_check();
      alter table public.crm_leads drop constraint if exists crm_leads_pipeline_id_fkey;
      alter table public.crm_leads drop constraint if exists crm_leads_stage_id_fkey;
      alter table public.crm_stages drop constraint if exists crm_stages_pipeline_id_fkey;
      alter table green.product_pipeline_binding drop constraint if exists product_pipeline_binding_pipeline_id_fkey;
      drop index if exists public.uniq_crm_pipelines_id_org;
      drop index if exists public.uniq_crm_stages_id_org;
      alter table public.crm_leads add constraint crm_leads_pipeline_id_fkey foreign key (pipeline_id) references public.crm_pipelines(id) on delete restrict;
      alter table public.crm_leads add constraint crm_leads_stage_id_fkey foreign key (stage_id) references public.crm_stages(id) on delete restrict;
      alter table public.crm_stages add constraint crm_stages_pipeline_id_fkey foreign key (pipeline_id) references public.crm_pipelines(id) on delete cascade;
      alter table green.product_pipeline_binding add constraint product_pipeline_binding_pipeline_id_fkey foreign key (pipeline_id) references public.crm_pipelines(id) on delete cascade;
    `);
    await pool.query(funcao(M0503, "green.fn_binding_removed_audit"));
  }

  const colunasDaFk = async (tabela: string, nome: string) =>
    (
      await pool.query<{ n: number; validada: boolean }>(
        "select cardinality(conkey) n, convalidated validada from pg_constraint where conname=$1 and conrelid=$2::regclass",
        [nome, tabela],
      )
    ).rows[0];

  it("estado 0506 com histórico estrutural → 0507 duas vezes: FKs compostas validadas, dados idênticos, ataques recusados", async () => {
    await rebaixarPara0506();
    const a = await tenant();
    const b = await tenant();
    const g = await leads(a, a.green.id, a.green.etapas[0]!, 4);
    await leads(a, a.comum.id, a.comum.etapas[0]!, 3);
    const c2 = await novoFunil(a.org);
    const torto = await lead1(a, a.comum.id, c2.etapas[0]!); // lead comum torto (o lote do produto faz isso)
    await request(manager(a), "update crm_stages set is_archived=true where id=$1", [
      a.comum.etapas[1],
    ]);
    await leads(b, b.green.id, b.green.etapas[0]!, 2);
    const antes = await foto([a.org, b.org]);

    const m = M0507();
    await pool.query(m);
    const e2 = await erroDe(pool.query(m));
    expect(e2, e2?.message).toBeNull();

    expect(await foto([a.org, b.org])).toEqual(antes);
    for (const [tabela, nome] of [
      ["public.crm_leads", "crm_leads_pipeline_id_fkey"],
      ["public.crm_leads", "crm_leads_stage_id_fkey"],
      ["public.crm_stages", "crm_stages_pipeline_id_fkey"],
      ["green.product_pipeline_binding", "product_pipeline_binding_pipeline_id_fkey"],
    ] as const)
      expect(await colunasDaFk(tabela, nome)).toEqual({ n: 2, validada: true });
    for (const id of g) expect(await estadoDe(id)).toBe("live");
    expect(await estadoDe(torto)).toBe("SEM-LINHA");
    expect(await estruturaImpossivel([a.org, b.org])).toEqual(INTEGRA);

    // as guardas estão de pé depois do upgrade
    expect(veredito(await erroDe(relocar(manager(a), a.green.etapas[0]!, a.comum.id)))).toContain(
      RELOCACAO,
    );
    const binding = await erroDe(
      pool.query(
        "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
        [a.org, a.comum.id],
      ),
    );
    expect(veredito(binding)).toContain(BINDING_INVALIDO); // o lead torto está no funil comum
  }, 60_000);

  it("estado 0506 com estrutura IMPOSSÍVEL herdada: a 0507 recusa explicitamente e não aplica nada", async () => {
    await rebaixarPara0506();
    const a = await tenant();
    const b = await tenant();
    await leads(a, a.green.id, a.green.etapas[0]!, 2);
    // o que a base deixava: etapa Green com leads movida para funil comum, e etapa em funil alheio
    await pool.query("update crm_stages set pipeline_id=$2 where id=$1", [
      a.green.etapas[0],
      a.comum.id,
    ]);
    await pool.query("update crm_stages set pipeline_id=$2 where id=$1", [
      a.comum.etapas[1],
      b.comum.id,
    ]);
    const antes = await foto([a.org, b.org]);
    const e = await erroDe(pool.query(M0507()));
    expect(veredito(e)).toContain(LEGADO);
    expect(JSON.parse(e?.detail ?? "{}")).toMatchObject({
      green_incoerente: 2,
      etapa_em_funil_alheio: 1,
    });
    expect(await foto([a.org, b.org])).toEqual(antes);
    expect(await colunasDaFk("public.crm_stages", "crm_stages_pipeline_id_fkey")).toEqual({
      n: 1,
      validada: true,
    });
    // o dono corrige a estrutura e a 0507 passa
    await pool.query("update crm_stages set pipeline_id=$2 where id=$1", [
      a.green.etapas[0],
      a.green.id,
    ]);
    await pool.query("update crm_stages set pipeline_id=$2 where id=$1", [
      a.comum.etapas[1],
      a.comum.id,
    ]);
    const ok = await erroDe(pool.query(M0507()));
    expect(ok, ok?.message).toBeNull();
  }, 60_000);
});
