/**
 * SPIKE-GREEN-01.3 — identidade por binding e selagem do lifecycle (DESCARTÁVEL).
 *
 * Contrato definitivo: todo lead que EFETIVAMENTE tocar o domínio Green deixa uma
 * identidade histórica não reciclável. Entradas: INSERT já em Green, UPDATE comum →
 * Green, pipeline que vira Green por binding, lead que já existia no pipeline no
 * momento do binding. UUID de lead que NUNCA tocou Green não é protegido (política
 * documentada; não se amplia em silêncio).
 *
 *   B   binding registra a identidade dos leads existentes (RED na v1.2: ADV-01)
 *   R   reuso A–E depois do binding (mesma org, outra org, org removida)
 *   D   DELETE defensivo: nunca deixa UUID Green reutilizável
 *   C   concorrência binding × INSERT / DELETE / movimento / binding / retry
 *   O   oracle: a recusa é indistinguível entre origens
 *   Z   cerca cross-org: foto de TODA tabela com organization_id + green.* (ADV-03)
 *
 * Mesmo arquivo contra a v1.2 (`bc727cb`) e a v1.3: só muda o código sob teste.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 16,
});
afterAll(() => pool.end());

/* ── requests no formato do PostgREST (mesmo harness do lifecycle v1.2) ────── */
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

const CONTEXTO_DONO = JSON.stringify({
  v: 1,
  source: "fixture",
  actor: { kind: "system", id: "fixture" },
});

/** Escrita do DONO (fixture), com o contexto Green pelo GUC de conexão direta. */
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

/** Transação do dono ABERTA, para escolher a ordem de commit nos cenários de corrida. */
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
  );

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
  contato: string;
  funilGreen: string;
  etapaG1: string;
  funilComum: string;
  etapaC1: string;
}
async function tenant(): Promise<Tenant> {
  const t: Tenant = {
    org: randomUUID(),
    nome: `Org ${randomUUID().slice(0, 8)}`,
    admin: randomUUID(),
    contato: randomUUID(),
    funilGreen: randomUUID(),
    etapaG1: randomUUID(),
    funilComum: randomUUID(),
    etapaC1: randomUUID(),
  };
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    t.admin,
    `adm-${t.admin}@v13.test`,
  ]);
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [t.org, `v13-${t.org}`, t.nome],
  );
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin',now())",
    [t.admin, t.org],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,'Maria',$3)",
    [t.contato, t.org, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
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
       ($1,$2,$3,'G1','stage-g1',1000), ($4,$2,$5,'C1','stage-c1',1000)`,
    [t.etapaG1, t.org, t.funilGreen, t.etapaC1, t.funilComum],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [t.org, t.funilGreen],
  );
  return t;
}

interface Funil {
  id: string;
  etapa: string;
}
/** Funil COMUM novo (ainda sem binding), com `n` leads comuns dentro. */
async function funilComLeads(t: Tenant, n: number): Promise<Funil & { leads: string[] }> {
  const id = randomUUID();
  const etapa = randomUUID();
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug, is_default) values ($1,$2,'Novo',$3,false)",
    [id, t.org, `novo-${id.slice(0, 8)}`],
  );
  await pool.query(
    "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'N1','stage-n1',1000)",
    [etapa, t.org, id],
  );
  const leads: string[] = [];
  if (n > 0) {
    const { rows } = await comoDono(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id)
         select $1,$2,$3,'L'||g,$4 from generate_series(1,$5::int) g returning id`,
      [t.org, id, etapa, t.contato, n],
    );
    for (const r of rows) leads.push(r.id as string);
  }
  return { id, etapa, leads };
}
const ligar = (t: Tenant, funil: string) =>
  pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [t.org, funil],
  );
const novoLeadComoDono = async (t: Tenant, funil: string, etapa: string, id?: string) =>
  (
    await comoDono(
      "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values (coalesce($5::uuid, gen_random_uuid()),$1,$2,$3,'Negócio',$4) returning id",
      [t.org, funil, etapa, t.contato, id ?? null],
    )
  ).rows[0].id as string;

const REUSO = "green_lead_id_reuse_forbidden";
const nascerGreen = (t: Tenant, id: string) =>
  request(
    servico(),
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
const estadoDe = async (id: string) =>
  (await pool.query("select state from green.lead_identity where lead_id=$1", [id])).rows[0]
    ?.state ?? "SEM-LINHA";
const contar = async (sql: string, args: unknown[]) =>
  Number((await pool.query(sql, args)).rows[0].n);

/** O invariante que o lifecycle promete: nenhum lead VIVO toca o domínio sem identidade. */
async function leadsGreenSemIdentidade(org: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select l.id
       from public.crm_leads l
      where l.organization_id = $1
        and (exists (select 1 from green.product_pipeline_binding b
                      where b.organization_id = l.organization_id and b.pipeline_id = l.pipeline_id)
             or exists (select 1 from public.crm_stages s
                          join green.product_pipeline_binding b
                            on b.organization_id = s.organization_id and b.pipeline_id = s.pipeline_id
                         where s.id = l.stage_id and s.organization_id = l.organization_id))
        and not exists (select 1 from green.lead_identity i where i.lead_id = l.id)`,
    [org],
  );
  return rows.map((r) => r.id);
}

/* ═══ B — o binding registra a identidade dos leads que já estão no funil ═══ */
describe("B — binding: o pipeline que vira Green registra a identidade dos leads existentes", () => {
  it.each([[0], [1], [150]])("funil com %i lead(s): todos ganham identidade `live` e nenhum buraco", async (n) => {
    const t = await tenant();
    const f = await funilComLeads(t, n);
    for (const id of f.leads) expect(await estadoDe(id)).toBe("SEM-LINHA"); // RED: ninguém tem identidade
    await ligar(t, f.id);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    for (const id of f.leads) expect(await estadoDe(id)).toBe("live");
    expect(
      await contar(
        "select count(*) as n from green.lead_identity where lead_id = any($1::uuid[])",
        [f.leads],
      ),
    ).toBe(n); // sem duplicidade
  });

  it("leads que JÁ tinham identidade (saíram do Green antes) não duplicam nem regridem", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 3);
    // um lead que já foi Green, saiu e vive no funil novo, comum, com identidade `live`
    const velho = randomUUID();
    await nascerGreen(t, velho);
    await request(servico(), "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
      velho,
      f.id,
      f.etapa,
    ]);
    expect(await estadoDe(velho)).toBe("live");
    await ligar(t, f.id);
    expect(await estadoDe(velho)).toBe("live");
    for (const id of f.leads) expect(await estadoDe(id)).toBe("live");
    expect(
      await contar("select count(*) as n from green.lead_identity where lead_id=$1", [velho]),
    ).toBe(1);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
  });

  it("mistura: parte com identidade, parte sem — o conjunto fecha, só uma linha por lead", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 40);
    await pool.query("insert into green.lead_identity (lead_id) select unnest($1::uuid[])", [
      f.leads.slice(0, 15),
    ]);
    await ligar(t, f.id);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(
      await contar(
        "select count(*) as n from green.lead_identity where lead_id = any($1::uuid[])",
        [f.leads],
      ),
    ).toBe(40);
  });

  it("idempotência: apagar o binding e criá-lo de novo não duplica nem regride; o mesmo binding duas vezes é recusado pela PK", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 5);
    await ligar(t, f.id);
    const e = await erroDe(ligar(t, f.id));
    expect(e?.code, veredito(e)).toBe("23505");
    await pool.query("delete from green.product_pipeline_binding where pipeline_id=$1", [f.id]);
    await ligar(t, f.id);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(
      await contar(
        "select count(*) as n from green.lead_identity where lead_id = any($1::uuid[])",
        [f.leads],
      ),
    ).toBe(5);
  });

  it("trocar o pipeline_id de um binding existente também registra os leads do novo funil", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 4);
    await pool.query(
      "update green.product_pipeline_binding set pipeline_id=$2 where organization_id=$1 and pipeline_id=$3",
      [t.org, f.id, t.funilGreen],
    );
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    for (const id of f.leads) expect(await estadoDe(id)).toBe("live");
  });

  it("o binding é atômico: um lead com UUID aposentado no funil recusa o binding inteiro", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 3);
    const x = randomUUID();
    await nascerGreen(t, x);
    await apagar(x);
    await novoLeadComoDono(t, f.id, f.etapa, x); // lead comum com UUID aposentado
    const e = await erroDe(ligar(t, f.id));
    expect(e?.message, veredito(e)).toBe(REUSO);
    expect(
      await contar("select count(*) as n from green.product_pipeline_binding where pipeline_id=$1", [f.id]),
    ).toBe(0);
    for (const id of f.leads) expect(await estadoDe(id)).toBe("SEM-LINHA"); // nada foi registrado
  });

  it("sem PII: a identidade de um lead registrado pelo binding só tem as quatro colunas", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 1);
    await ligar(t, f.id);
    const { rows } = await pool.query(
      "select to_jsonb(i) as linha from green.lead_identity i where lead_id=$1",
      [f.leads[0]],
    );
    expect(Object.keys(rows[0].linha).sort()).toEqual(["first_seen_at", "lead_id", "retired_at", "state"]);
    expect(JSON.stringify(rows[0].linha)).not.toContain(t.org);
  });
});

/* ═══ R — reuso A–E depois do binding ═══════════════════════════════════════ */
describe("R — reuso do UUID de um lead que entrou no Green por binding", () => {
  async function apagadoDepoisDoBinding(t: Tenant): Promise<string> {
    const f = await funilComLeads(t, 2);
    await ligar(t, f.id);
    const x = f.leads[0]!;
    await apagar(x);
    expect(await contar("select count(*) as n from crm_leads where id=$1", [x])).toBe(0);
    return x;
  }

  it("A — INSERT Green com o mesmo UUID: recusado (mesma organização)", async () => {
    const t = await tenant();
    const x = await apagadoDepoisDoBinding(t);
    const e = await erroDe(nascerGreen(t, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
  });

  it("B — lead comum com o mesmo UUID, movido para Green: recusado", async () => {
    const t = await tenant();
    const x = await apagadoDepoisDoBinding(t);
    await novoLeadComoDono(t, t.funilComum, t.etapaC1, x);
    const e = await erroDe(moverParaGreen(t, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
  });

  it("C — outra organização: recusado, com a mesma assinatura da mesma org", async () => {
    const a = await tenant();
    const b = await tenant();
    const outra = await tenant();
    const x = await apagadoDepoisDoBinding(a);
    const y = await apagadoDepoisDoBinding(outra);
    const entre = await erroDe(nascerGreen(b, x));
    const mesma = await erroDe(nascerGreen(outra, y));
    expect(entre?.message, veredito(entre)).toBe(REUSO);
    expect(assinatura(entre)).toBe(assinatura(mesma));
    expect(JSON.stringify({ ...entre })).not.toContain(a.org);
  });

  it("D — organização removida: outra organização não herda o UUID", async () => {
    const a = await tenant();
    const b = await tenant();
    const f = await funilComLeads(a, 2);
    await ligar(a, f.id);
    const x = f.leads[0]!;
    await pool.query("delete from organizations where id=$1", [a.org]); // cascata
    expect(await contar("select count(*) as n from crm_leads where id=$1", [x])).toBe(0);
    const e = await erroDe(nascerGreen(b, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
    await novoLeadComoDono(b, b.funilComum, b.etapaC1, x);
    const e2 = await erroDe(moverParaGreen(b, x));
    expect(e2?.message, veredito(e2)).toBe(REUSO);
  });

  it("E — lead que NUNCA tocou Green: a política documentada se mantém (UUID reutilizável; sem identidade)", async () => {
    const t = await tenant();
    const x = await novoLeadComoDono(t, t.funilComum, t.etapaC1);
    await apagar(x);
    expect(await estadoDe(x)).toBe("SEM-LINHA"); // não foi ampliado em silêncio
    const e = await erroDe(nascerGreen(t, x));
    expect(veredito(e)).toBe("ACEITO");
  });
});

/* ═══ D — DELETE defensivo ══════════════════════════════════════════════════ */
describe("D — DELETE de lead que toca o domínio nunca deixa o UUID reciclável", () => {
  it("identidade perdida por estado inesperado: o DELETE a recria como `retired`", async () => {
    const t = await tenant();
    const x = randomUUID();
    await nascerGreen(t, x);
    await pool.query("delete from green.lead_identity where lead_id=$1", [x]); // estado impossível, forçado
    expect(await estadoDe(x)).toBe("SEM-LINHA");
    await apagar(x);
    expect(await estadoDe(x)).toBe("retired");
    const e = await erroDe(nascerGreen(t, x));
    expect(e?.message, veredito(e)).toBe(REUSO);
  });

  it("idem quando a organização inteira vai embora (cascata) e a identidade estava perdida", async () => {
    const a = await tenant();
    const b = await tenant();
    const x = randomUUID();
    await nascerGreen(a, x);
    await pool.query("delete from green.lead_identity where lead_id=$1", [x]);
    await pool.query("delete from organizations where id=$1", [a.org]);
    // a cascata pode apagar o binding antes do lead; o que a fronteira alcança, ela aposenta
    const e = await erroDe(nascerGreen(b, x));
    console.info(`D2 cascata com identidade perdida: ${veredito(e)} / identidade=${await estadoDe(x)}`);
  });

  it("lead que nunca tocou Green não ganha identidade ao ser apagado (escopo mantido)", async () => {
    const t = await tenant();
    const x = await novoLeadComoDono(t, t.funilComum, t.etapaC1);
    await apagar(x);
    expect(await estadoDe(x)).toBe("SEM-LINHA");
  });

  it("lead com identidade `live` é aposentado, uma linha só", async () => {
    const t = await tenant();
    const x = randomUUID();
    await nascerGreen(t, x);
    await apagar(x);
    expect(await estadoDe(x)).toBe("retired");
    expect(await contar("select count(*) as n from green.lead_identity where lead_id=$1", [x])).toBe(1);
  });
});

/* ═══ C — concorrência: binding × lead ══════════════════════════════════════ */
describe("C — concorrência: nenhum cenário deixa lead Green sem identidade", () => {
  it("binding × INSERT de lead no funil (lead em voo antes do binding)", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 2);
    const c1 = await transacaoDoDono();
    const novo = randomUUID();
    await c1.query(
      "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,$4,'Em voo',$5)",
      [novo, t.org, f.id, f.etapa, t.contato],
    );
    let fim = false;
    const binding = ligar(t, f.id).then(() => (fim = true));
    await esperar(500);
    await c1.query("commit");
    c1.release();
    await binding;
    expect(fim).toBe(true);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(await estadoDe(novo)).toBe("live");
  });

  it("binding × INSERT de lead no funil (binding em voo antes do lead)", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 2);
    const cb = await pool.connect();
    await cb.query("begin");
    await cb.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, f.id],
    );
    const novo = randomUUID();
    const lead = (async () => {
      const c = await transacaoDoDono();
      try {
        await c.query(
          "insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,$4,'Depois',$5)",
          [novo, t.org, f.id, f.etapa, t.contato],
        );
        await c.query("commit");
      } finally {
        c.release();
      }
    })();
    await esperar(500);
    await cb.query("commit");
    cb.release();
    await lead;
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(await estadoDe(novo)).toBe("live");
  });

  it("binding × DELETE (delete em voo antes do binding): o lead apagado era comum; o resto fecha", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 3);
    const c1 = await transacaoDoDono();
    await c1.query("delete from crm_leads where id=$1", [f.leads[0]]);
    const binding = ligar(t, f.id);
    await esperar(500);
    await c1.query("commit");
    c1.release();
    await binding;
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(await contar("select count(*) as n from crm_leads where id=$1", [f.leads[0]])).toBe(0);
  });

  it("binding × DELETE (binding em voo antes do delete): o delete aposenta a identidade que o binding criou", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 3);
    const cb = await pool.connect();
    await cb.query("begin");
    await cb.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, f.id],
    );
    const alvo = f.leads[0]!;
    const del = apagar(alvo);
    await esperar(500);
    await cb.query("commit");
    cb.release();
    await del;
    expect(await estadoDe(alvo)).toBe("retired");
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect((await erroDe(nascerGreen(t, alvo)))?.message).toBe(REUSO);
  });

  it("binding × movimento comum→Green (movimento em voo antes do binding)", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 0);
    const lead = await novoLeadComoDono(t, t.funilComum, t.etapaC1);
    const c1 = await transacaoDoDono();
    await c1.query("update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [lead, f.id, f.etapa]);
    const binding = ligar(t, f.id);
    await esperar(500);
    await c1.query("commit");
    c1.release();
    await binding;
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(await estadoDe(lead)).toBe("live");
  });

  it("binding × movimento comum→Green (binding em voo antes do movimento)", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 0);
    const lead = await novoLeadComoDono(t, t.funilComum, t.etapaC1);
    const cb = await pool.connect();
    await cb.query("begin");
    await cb.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [t.org, f.id],
    );
    const mover = (async () => {
      const c = await transacaoDoDono();
      try {
        await c.query("update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [lead, f.id, f.etapa]);
        await c.query("commit");
      } finally {
        c.release();
      }
    })();
    await esperar(500);
    await cb.query("commit");
    cb.release();
    await mover;
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(await estadoDe(lead)).toBe("live");
  });

  it("dois bindings do MESMO funil em paralelo: um vence, o outro cai na PK; identidades íntegras", async () => {
    const t = await tenant();
    const f = await funilComLeads(t, 20);
    const res = await Promise.allSettled([ligar(t, f.id), ligar(t, f.id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
    expect(
      await contar(
        "select count(*) as n from green.lead_identity where lead_id = any($1::uuid[])",
        [f.leads],
      ),
    ).toBe(20);
  });

  it("dois bindings de funis DIFERENTES em paralelo: ambos fecham", async () => {
    const t = await tenant();
    const [f1, f2] = [await funilComLeads(t, 10), await funilComLeads(t, 10)];
    const res = await Promise.allSettled([ligar(t, f1.id), ligar(t, f2.id)]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await leadsGreenSemIdentidade(t.org)).toEqual([]);
  });

  it("rajadas: binding + INSERTs + movimentos + DELETEs simultâneos (12 rodadas) nunca deixam buraco", async () => {
    for (let rodada = 0; rodada < 12; rodada++) {
      const t = await tenant();
      const f = await funilComLeads(t, 6);
      const comuns = await Promise.all(
        Array.from({ length: 3 }, () => novoLeadComoDono(t, t.funilComum, t.etapaC1)),
      );
      const apagaveis = f.leads.slice(0, 2);
      const ids = Array.from({ length: 4 }, () => randomUUID());
      const tarefas: Array<Promise<unknown>> = [
        ligar(t, f.id),
        ...ids.map((id) => novoLeadComoDono(t, f.id, f.etapa, id)),
        ...comuns.map((id) =>
          comoDono("update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [id, f.id, f.etapa]),
        ),
        ...apagaveis.map((id) => comoDono("delete from crm_leads where id=$1", [id])),
      ];
      const res = await Promise.allSettled(tarefas);
      const falhas = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(falhas.map((r) => String(r.reason?.message)), `rodada ${rodada}`).toEqual([]);
      expect(await leadsGreenSemIdentidade(t.org), `rodada ${rodada}`).toEqual([]);
      // quem foi apagado DEPOIS de o binding ficar visível deixou lápide Green: então está aposentado
      const { rows } = await pool.query<{ lead_id: string }>(
        "select distinct lead_id from green.stage_event_ledger where organization_id=$1 and kind='deleted'",
        [t.org],
      );
      for (const r of rows) expect(await estadoDe(r.lead_id), `rodada ${rodada}`).toBe("retired");
    }
  });
});

/* ═══ O — oracle ════════════════════════════════════════════════════════════ */
describe("O — a recusa por identidade nascida de binding não é oracle", () => {
  it("mesma org × outra org × tenant removido: assinatura de erro idêntica", async () => {
    const a = await tenant();
    const b = await tenant();
    const mesma = await tenant();
    const removida = await tenant();
    const via = async (t: Tenant) => {
      const f = await funilComLeads(t, 1);
      await ligar(t, f.id);
      return f.leads[0]!;
    };
    const xa = await via(a);
    await apagar(xa);
    const xm = await via(mesma);
    await apagar(xm);
    const xr = await via(removida);
    await pool.query("delete from organizations where id=$1", [removida.org]);
    const sigs = [
      assinatura(await erroDe(nascerGreen(mesma, xm))),
      assinatura(await erroDe(nascerGreen(b, xa))),
      assinatura(await erroDe(nascerGreen(b, xr))),
    ];
    expect(new Set(sigs).size).toBe(1);
    expect(JSON.parse(sigs[0]!).message).toBe(REUSO);
  });
});

/* ═══ Z — cerca cross-org ampliada (V12-ADV-03) ═════════════════════════════ */
describe("Z — zona de perigo: a vizinha fica idêntica em TODA tabela com organization_id e em green.*", () => {
  async function semear(t: Tenant) {
    const sessao = randomUUID();
    const conversa = randomUUID();
    await pool.query(
      "insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values ($1,$2,$3,'WORKING',decode('00','hex'))",
      [sessao, t.org, `v13-${sessao}`],
    );
    await pool.query(
      "insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,$4,'open')",
      [conversa, t.org, t.contato, sessao],
    );
    await pool.query(
      "insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, external_id) values ($1,$2,$3,$4,'text','inbound','received','oi',$5)",
      [t.org, conversa, sessao, t.contato, `wa-${randomUUID()}`],
    );
    await pool.query(
      "insert into calendar_appointments (organization_id, contact_id, title, starts_at, ends_at, status) values ($1,$2,'Consulta',now()+interval '2 days',now()+interval '2 days 1 hour','confirmed')",
      [t.org, t.contato],
    );
    await pool.query(
      "insert into orders (organization_id, external_id, external_provider, contact_id, status, total_cents, ordered_at) values ($1,$2,'nuvemshop',$3,'paid',1000,now())",
      [t.org, `ord-${randomUUID()}`, t.contato],
    );
    const green = await novoLeadComoDono(t, t.funilGreen, t.etapaG1);
    await novoLeadComoDono(t, t.funilComum, t.etapaC1);
    await pool.query(
      "insert into crm_proposals (organization_id, lead_id, contact_id, titulo) values ($1,$2,$3,'Proposta')",
      [t.org, green, t.contato],
    );
  }

  /** Foto de TODA tabela de `public` com `organization_id` + o estado `green.*` da organização. */
  async function foto(org: string) {
    const { rows: tabelas } = await pool.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.column_name = 'organization_id' order by 1`,
    );
    const out: Record<string, string> = {};
    for (const { table_name } of tabelas) {
      const { rows } = await pool.query(
        `select count(*)::int as n,
                coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') as h
           from public."${table_name}" x where x.organization_id = $1`,
        [org],
      );
      out[table_name] = `${rows[0].n}:${rows[0].h}`;
    }
    const { rows: g } = await pool.query(
      `select (select count(*) from green.product_pipeline_binding where organization_id = $1)::int as binding,
              (select count(*) from green.lead_birth_provenance where organization_id = $1)::int as proveniencia,
              (select count(*) from green.stage_event_ledger where organization_id = $1)::int as ledger`,
      [org],
    );
    out["green.*"] = JSON.stringify(g[0]);
    return out;
  }

  it("a foto cobre mais que as sete raízes (a cerca anterior não via user_organizations)", async () => {
    const t = await tenant();
    await semear(t);
    const f = await foto(t.org);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(["user_organizations", "crm_pipelines", "channel_sessions", "green.*"]));
    expect(Object.keys(f).length).toBeGreaterThan(50);
  });

  it("RPC da zona de perigo para A: B e C idênticas em toda tabela com organization_id e em green.*", async () => {
    const [a, b, c] = [await tenant(), await tenant(), await tenant()];
    for (const t of [a, b, c]) await semear(t);
    const antesB = await foto(b.org);
    const antesC = await foto(c.org);
    const { rows } = await request<{ r: Record<string, number> }>(
      servico({ source: "settings.danger_zone", actor: { kind: "system", id: a.admin } }),
      "select public.fn_apagar_dados_operacionais_da_org($1) as r",
      [a.org],
    );
    expect(rows[0]!.r).toMatchObject({ messages: 1, conversations: 1, crm_leads: 2, contacts: 1 });
    expect(await foto(b.org)).toEqual(antesB);
    expect(await foto(c.org)).toEqual(antesC);
    // o que não é raiz da zona de perigo continua em A
    expect(await contar("select count(*) as n from user_organizations where organization_id=$1", [a.org])).toBe(1);
  });
});
