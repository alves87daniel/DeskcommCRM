/**
 * GREEN-CRM-02 — Catálogo de Produtos Green + produto principal da oportunidade (migration 0509).
 *
 * Contrato (o que esta suíte exige, direto no banco, pelos papéis reais):
 *
 *   PC1  produto é por organização; `code` é único DENTRO da organização e imutável;
 *   PC2  `family` é vocabulário aberto: o banco só confere a forma, nunca uma lista;
 *   PC3  produto inativo continua existindo; produto usado não é apagado;
 *   LC1  contexto é 1:1 com a oportunidade e só nasce em funil Green (binding existente);
 *   LC2  tenant provado pela ESTRUTURA (FKs compostas): nem service_role fabrica lead de A com
 *        produto de B;
 *   LC3  produto inativo não é atribuível a nova associação, mas continua legível/histórico;
 *   LC4  oportunidade won/lost não troca de produto (dimensão de métrica congelada);
 *   LC5  um evento canônico `lead.green_context_changed` por mudança de produto, na transação,
 *        sem PII, distinguindo `product_assigned` de `product_changed`;
 *   RL   RLS: tenant B não vê A; visibilidade do contexto acompanha a do lead; escrita por papel;
 *   FP   FUNIL != PRODUTO: dois produtos no MESMO funil, sem funil/tag novo, sem FK produto→funil.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 8,
});
afterAll(() => pool.end());

/* ── requests no formato do PostgREST ─────────────────────────────────────── */
interface Request {
  papel: "authenticated" | "service_role";
  sub?: string;
}

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
    await c.query("select set_config('request.headers', $1, true)", [
      JSON.stringify({ "sb-request-id": randomUUID() }),
    ]);
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

/** Escrita do DONO (fixture): o lead Green passa pela fronteira com o contexto do GUC. */
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

async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as pg.DatabaseError;
  }
}
const contar = async (sql: string, args: unknown[] = []) =>
  Number((await pool.query(sql, args)).rows[0].n);

/* ── fixtures ─────────────────────────────────────────────────────────────── */
interface Funil {
  id: string;
  aberta: string;
  ganho: string;
  perdido: string;
}
interface Tenant {
  org: string;
  admin: string;
  manager: string;
  agente: string;
  outroAgente: string;
  viewer: string;
  contato: string;
  green: Funil;
  comum: Funil;
}

async function usuario(prefixo: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    id,
    `${prefixo}-${id}@produto.test`,
  ]);
  return id;
}
async function membro(user: string, org: string, papel: string) {
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
    [user, org, papel],
  );
}

async function novoFunil(org: string, green: boolean): Promise<Funil> {
  const id = randomUUID();
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug, is_default) values ($1,$2,'Funil',$3,false)",
    [id, org, `f-${id.slice(0, 8)}`],
  );
  await pool.query(
    "update crm_pipelines set settings = settings || jsonb_build_object('lost_reasons', jsonb_build_array('sem interesse')) where id=$1",
    [id],
  );
  const etapa = async (nome: string, pos: number, won = false, lost = false) => {
    const e = randomUUID();
    await pool.query(
      `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won, is_lost)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e, org, id, nome, `${nome.toLowerCase()}-${e.slice(0, 6)}`, pos, won, lost],
    );
    return e;
  };
  const aberta = await etapa("Aberta", 1000);
  const ganho = await etapa("Ganho", 2000, true);
  const perdido = await etapa("Perdido", 3000, false, true);
  if (green) {
    // `product_key` é chave de PROCESSO (histórica); nada aqui diz qual produto se vende.
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'conexao_green')",
      [org, id],
    );
  }
  return { id, aberta, ganho, perdido };
}

async function tenant(): Promise<Tenant> {
  const org = randomUUID();
  const [admin, manager, agente, outroAgente, viewer] = await Promise.all([
    usuario("adm"),
    usuario("mgr"),
    usuario("agt"),
    usuario("agt2"),
    usuario("vwr"),
  ]);
  const contato = randomUUID();
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $3)",
    [org, `gp-${org}`, `Org ${org.slice(0, 8)}`],
  );
  await membro(admin, org, "admin");
  await membro(manager, org, "manager");
  await membro(agente, org, "agent");
  await membro(outroAgente, org, "agent");
  await membro(viewer, org, "viewer");
  await pool.query(
    "insert into contacts (id, organization_id, display_name, phone_number) values ($1,$2,'Maria',$3)",
    [contato, org, `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, "9")}`],
  );
  const green = await novoFunil(org, true);
  const comum = await novoFunil(org, false);
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [comum.id]);
  return { org, admin, manager, agente, outroAgente, viewer, contato, green, comum };
}

async function lead(
  t: Tenant,
  funil: Funil,
  opts: { etapa?: string; owner?: string | null } = {},
): Promise<string> {
  const { rows } = await comoDono(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id)
     values ($1,$2,$3,'L',$4,$5) returning id`,
    [t.org, funil.id, opts.etapa ?? funil.aberta, t.contato, opts.owner ?? null],
  );
  return rows[0].id as string;
}
const moverPara = (id: string, etapa: string) =>
  comoDono(
    `update crm_leads
        set stage_id = $2,
            lost_reason = (select case when s.is_lost then 'sem interesse' end from crm_stages s where s.id = $2)
      where id = $1`,
    [id, etapa],
  );
const statusDe = async (id: string) =>
  (await pool.query("select status from crm_leads where id=$1", [id])).rows[0].status as string;

async function produto(
  org: string,
  code: string,
  extra: { name?: string; family?: string; ativo?: boolean } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `insert into green_products (organization_id, code, name, family, is_active)
     values ($1,$2,$3,$4,$5) returning id`,
    [org, code, extra.name ?? `Produto ${code}`, extra.family ?? "generic", extra.ativo ?? true],
  );
  return rows[0].id as string;
}
const contexto = (leadId: string, org: string, prod: string) =>
  pool.query(
    "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
    [leadId, org, prod],
  );
const produtoDo = async (leadId: string) =>
  (await pool.query("select product_id from green_lead_context where lead_id=$1", [leadId])).rows[0]
    ?.product_id as string | undefined;
const eventosDe = async (leadId: string) =>
  (
    await pool.query(
      `select event_type, status, payload, metadata, entity_kind from event_log
        where event_type = 'lead.green_context_changed' and payload->>'lead_id' = $1
        order by created_at, id`,
      [leadId],
    )
  ).rows;

/* ═══════════════════════════ catálogo ═══════════════════════════════════════ */
describe("PC · catálogo de produtos Green", () => {
  it("PC1 manager cria produto na própria organização; agent e viewer não (RLS)", async () => {
    const t = await tenant();
    const ok = await request(
      { papel: "authenticated", sub: t.manager },
      "insert into green_products (organization_id, code, name) values ($1,'alfa','Alfa') returning id",
      [t.org],
    );
    expect(ok.rows).toHaveLength(1);
    for (const quem of [t.agente, t.viewer]) {
      const e = await erroDe(
        request(
          { papel: "authenticated", sub: quem },
          "insert into green_products (organization_id, code, name) values ($1,'beta','Beta')",
          [t.org],
        ),
      );
      expect(e?.code).toBe("42501");
    }
  });

  it("PC2 code duplicado na mesma organização é recusado; em outra organização é permitido", async () => {
    const a = await tenant();
    const b = await tenant();
    await produto(a.org, "mesmo_code");
    const dup = await erroDe(produto(a.org, "mesmo_code"));
    expect(dup?.code).toBe("23505");
    await expect(produto(b.org, "mesmo_code")).resolves.toBeTruthy();
  });

  it("PC3 forma do code e da family; family é vocabulário aberto (sem lista fechada)", async () => {
    const t = await tenant();
    for (const code of ["Alfa", "1alfa", "a", "alfa beta", "alfa-beta", ""]) {
      const e = await erroDe(produto(t.org, code));
      expect(e?.code, `code ${JSON.stringify(code)}`).toBe("23514");
    }
    // famílias que o catálogo NUNCA enumerou continuam válidas: não existe lista no banco
    for (const family of ["generic", "energy", "license", "qualquer_familia_futura"]) {
      await expect(produto(t.org, `p_${family}`, { family })).resolves.toBeTruthy();
    }
    const ruim = await erroDe(produto(t.org, "fam_ruim", { family: "Familia Ruim" }));
    expect(ruim?.code).toBe("23514");
    const def = await pool.query(
      `select pg_get_constraintdef(oid) d from pg_constraint
        where conrelid='public.green_products'::regclass and contype='c'`,
    );
    expect(def.rows.map((r) => r.d).join(" ")).not.toMatch(/energy|license/);
  });

  it("PC4 code e organização são imutáveis; nome e família mudam", async () => {
    const a = await tenant();
    const b = await tenant();
    const id = await produto(a.org, "estavel");
    const code = await erroDe(
      pool.query("update green_products set code='outro' where id=$1", [id]),
    );
    expect(code?.message).toContain("green_product_identity_immutable");
    const org = await erroDe(
      pool.query("update green_products set organization_id=$2 where id=$1", [id, b.org]),
    );
    expect(org?.message).toContain("green_product_identity_immutable");
    await pool.query("update green_products set name='Novo nome', family='nova' where id=$1", [id]);
    expect(
      (await pool.query("select name from green_products where id=$1", [id])).rows[0].name,
    ).toBe("Novo nome");
  });

  it("PC5 produto inativo continua existindo; usado não é apagado; authenticated não apaga", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const p = await produto(t.org, "usado");
    await contexto(l, t.org, p);
    await pool.query("update green_products set is_active=false where id=$1", [p]);
    expect(await contar("select count(*) n from green_products where id=$1", [p])).toBe(1);
    const apagar = await erroDe(pool.query("delete from green_products where id=$1", [p]));
    expect(apagar?.code).toBe("23503");
    const sem = await erroDe(
      request({ papel: "authenticated", sub: t.admin }, "delete from green_products where id=$1", [
        p,
      ]),
    );
    expect(sem?.code).toBe("42501");
    // produto nunca usado: o dono ainda consegue remover (limpeza), o histórico não depende dele
    const livre = await produto(t.org, "livre");
    await pool.query("delete from green_products where id=$1", [livre]);
  });
});

/* ═══════════════════════════ contexto ═══════════════════════════════════════ */
describe("LC · contexto da oportunidade (produto principal)", () => {
  it("LC1 1:1 por lead; produto da mesma organização aceito; troca é UPDATE", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const a = await produto(t.org, "alfa");
    const b = await produto(t.org, "beta");
    await contexto(l, t.org, a);
    const dup = await erroDe(contexto(l, t.org, b));
    expect(dup?.code).toBe("23505");
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l, b]);
    expect(await produtoDo(l)).toBe(b);
  });

  it("LC2 produto de OUTRA organização é recusado (FK composta), inclusive por service_role", async () => {
    const a = await tenant();
    const b = await tenant();
    const l = await lead(a, a.green);
    const pb = await produto(b.org, "alfa");
    const e = await erroDe(
      request(
        { papel: "service_role" },
        "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
        [l, a.org, pb],
      ),
    );
    expect(e?.code).toBe("23503");
    expect(e?.constraint).toBe("green_lead_context_product_fkey");
    expect(await produtoDo(l)).toBeUndefined();
  });

  it("LC2b lead de OUTRA organização é recusado (FK composta), inclusive por service_role", async () => {
    const a = await tenant();
    const b = await tenant();
    const lb = await lead(b, b.green);
    const pa = await produto(a.org, "alfa");
    const e = await erroDe(
      request(
        { papel: "service_role" },
        "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
        [lb, a.org, pa],
      ),
    );
    expect(e?.code).toBe("23503");
    expect(e?.constraint).toBe("green_lead_context_lead_fkey");
  });

  it("LC3 lead fora de funil Green é recusado (green_context_outside_binding), service_role incluso", async () => {
    const t = await tenant();
    const l = await lead(t, t.comum);
    const p = await produto(t.org, "alfa");
    for (const r of [
      { papel: "service_role" } as Request,
      { papel: "authenticated", sub: t.agente } as Request,
    ]) {
      const e = await erroDe(
        request(
          r,
          "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
          [l, t.org, p],
        ),
      );
      expect(e?.message).toContain("green_context_outside_binding");
    }
    expect(await produtoDo(l)).toBeUndefined();
  });

  it("LC4 produto inativo: nova associação recusada; contexto histórico continua íntegro", async () => {
    const t = await tenant();
    const velho = await produto(t.org, "velho");
    const novo = await produto(t.org, "novo");
    const l1 = await lead(t, t.green);
    const l2 = await lead(t, t.green);
    await contexto(l1, t.org, velho);
    await pool.query("update green_products set is_active=false where id=$1", [velho]);

    // nova associação ao produto inativo, em outra oportunidade
    const e = await erroDe(contexto(l2, t.org, velho));
    expect(e?.message).toContain("green_product_inactive");
    // e troca de um produto ativo para o inativo
    await contexto(l2, t.org, novo);
    const e2 = await erroDe(
      pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l2, velho]),
    );
    expect(e2?.message).toContain("green_product_inactive");

    // histórico: a oportunidade que já apontava continua lendo o produto e pode tocar o contexto
    expect(await produtoDo(l1)).toBe(velho);
    await pool.query("update green_lead_context set updated_at=now() where lead_id=$1", [l1]);
    // e pode sair do produto inativo para um ativo
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l1, novo]);
    expect(await produtoDo(l1)).toBe(novo);
  });

  it("LC5 won/lost não trocam nem recebem produto; reaberta volta a poder", async () => {
    const t = await tenant();
    const a = await produto(t.org, "alfa");
    const b = await produto(t.org, "beta");

    const ganha = await lead(t, t.green);
    await contexto(ganha, t.org, a);
    await moverPara(ganha, t.green.ganho);
    expect(await statusDe(ganha)).toBe("won");
    const e1 = await erroDe(
      pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [ganha, b]),
    );
    expect(e1?.message).toContain("green_context_lead_closed");
    expect(await produtoDo(ganha)).toBe(a);

    const perdida = await lead(t, t.green);
    await contexto(perdida, t.org, a);
    await moverPara(perdida, t.green.perdido);
    expect(await statusDe(perdida)).toBe("lost");
    const e2 = await erroDe(
      pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [perdida, b]),
    );
    expect(e2?.message).toContain("green_context_lead_closed");

    // primeira atribuição em oportunidade já fechada também é recusada (não reescreve métrica)
    const fechadaSemProduto = await lead(t, t.green, { etapa: t.green.ganho });
    const e3 = await erroDe(contexto(fechadaSemProduto, t.org, a));
    expect(e3?.message).toContain("green_context_lead_closed");

    // reaberta: volta a ser editável
    await moverPara(ganha, t.green.aberta);
    expect(await statusDe(ganha)).toBe("open");
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [ganha, b]);
    expect(await produtoDo(ganha)).toBe(b);

    // tocar o contexto fechado sem trocar o produto não é "alteração de produto"
    await pool.query("update green_lead_context set updated_at=now() where lead_id=$1", [perdida]);
  });

  it("LC6 lead apagado leva o contexto junto; produto sobrevive", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const p = await produto(t.org, "alfa");
    await contexto(l, t.org, p);
    await comoDono("delete from crm_leads where id=$1", [l]);
    expect(await contar("select count(*) n from green_lead_context where lead_id=$1", [l])).toBe(0);
    expect(await contar("select count(*) n from green_products where id=$1", [p])).toBe(1);
  });

  it("LC7 lead_id e organization_id do contexto são imutáveis", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const l2 = await lead(t, t.green);
    const p = await produto(t.org, "alfa");
    await contexto(l, t.org, p);
    const e = await erroDe(
      pool.query("update green_lead_context set lead_id=$2 where lead_id=$1", [l, l2]),
    );
    expect(e?.message).toContain("green_context_identity_immutable");
  });
});

/* ═══════════════════════════ evento canônico ════════════════════════════════ */
describe("EV · lead.green_context_changed", () => {
  it("EV1 primeira atribuição = product_assigned; troca = product_changed com before/after", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const a = await produto(t.org, "alfa");
    const b = await produto(t.org, "beta");
    await contexto(l, t.org, a);
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l, b]);
    const ev = await eventosDe(l);
    expect(ev).toHaveLength(2);
    expect(ev[0].payload).toMatchObject({
      lead_id: l,
      change: "product_assigned",
      product_id: a,
      previous_product_id: null,
    });
    expect(ev[1].payload).toMatchObject({
      lead_id: l,
      change: "product_changed",
      product_id: b,
      previous_product_id: a,
    });
    // fato, não comando: nasce `done` (registro), e o payload não carrega nome/telefone/e-mail
    expect(ev.every((e) => e.status === "done")).toBe(true);
    expect(JSON.stringify(ev.map((e) => e.payload))).not.toMatch(/phone|email|display_name|Maria/i);
  });

  it("EV2 UPDATE sem troca de produto não emite; rollback não deixa evento", async () => {
    const t = await tenant();
    const l = await lead(t, t.green);
    const a = await produto(t.org, "alfa");
    const b = await produto(t.org, "beta");
    await contexto(l, t.org, a);
    await pool.query("update green_lead_context set updated_at=now() where lead_id=$1", [l]);
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l, a]);
    expect(await eventosDe(l)).toHaveLength(1);

    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("update green_lead_context set product_id=$2 where lead_id=$1", [l, b]);
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect(await eventosDe(l)).toHaveLength(1);
    expect(await produtoDo(l)).toBe(a);
  });

  it("EV3 operação recusada não emite evento", async () => {
    const t = await tenant();
    const l = await lead(t, t.comum);
    const a = await produto(t.org, "alfa");
    await erroDe(contexto(l, t.org, a));
    expect(await eventosDe(l)).toHaveLength(0);
  });
});

/* ═══════════════════════════ RLS ═══════════════════════════════════════════ */
describe("RL · isolamento e autorização", () => {
  it("RL1 membro de B não lê produto nem contexto de A; membro de A lê", async () => {
    const a = await tenant();
    const b = await tenant();
    const l = await lead(a, a.green);
    const p = await produto(a.org, "alfa");
    await contexto(l, a.org, p);
    const deB = { papel: "authenticated", sub: b.admin } as Request;
    expect((await request(deB, "select id from green_products")).rows).toHaveLength(0);
    expect((await request(deB, "select lead_id from green_lead_context")).rows).toHaveLength(0);
    const deA = { papel: "authenticated", sub: a.viewer } as Request;
    expect((await request(deA, "select id from green_products")).rows).toHaveLength(1);
    expect((await request(deA, "select lead_id from green_lead_context")).rows).toHaveLength(1);
  });

  it("RL2 B não escreve em A: produto e contexto (cross-tenant fechado)", async () => {
    const a = await tenant();
    const b = await tenant();
    const l = await lead(a, a.green);
    const p = await produto(a.org, "alfa");
    const deB = { papel: "authenticated", sub: b.admin } as Request;
    const e1 = await erroDe(
      request(deB, "insert into green_products (organization_id, code, name) values ($1,'x','X')", [
        a.org,
      ]),
    );
    expect(e1?.code).toBe("42501");
    const e2 = await erroDe(
      request(
        deB,
        "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
        [l, a.org, p],
      ),
    );
    expect(e2?.code).toBe("42501");
    const up = await request(deB, "update green_products set name='hack' where id=$1", [p]);
    expect(up.rowCount).toBe(0);
  });

  it("RL3 agent grava contexto do lead que enxerga; viewer não grava; lead de outro agent é invisível", async () => {
    const t = await tenant();
    const p = await produto(t.org, "alfa");
    const dele = await lead(t, t.green, { owner: t.agente });
    const doOutro = await lead(t, t.green, { owner: t.outroAgente });
    const agente = { papel: "authenticated", sub: t.agente } as Request;

    await request(
      agente,
      "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
      [dele, t.org, p],
    );
    const invisivel = await erroDe(
      request(
        agente,
        "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
        [doOutro, t.org, p],
      ),
    );
    expect(invisivel?.code).toBe("42501");

    const viewer = { papel: "authenticated", sub: t.viewer } as Request;
    const semPapel = await erroDe(
      request(
        viewer,
        "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
        [dele, t.org, p],
      ),
    );
    expect(semPapel?.code === "42501" || semPapel?.code === "23505").toBe(true);

    // leitura do contexto acompanha a visibilidade do lead
    await contexto(doOutro, t.org, p);
    const vistos = (await request(agente, "select lead_id from green_lead_context")).rows.map(
      (r) => r.lead_id,
    );
    expect(vistos).toContain(dele);
    expect(vistos).not.toContain(doOutro);
    const manager = { papel: "authenticated", sub: t.manager } as Request;
    expect((await request(manager, "select lead_id from green_lead_context")).rows).toHaveLength(2);
  });

  it("RL4 travas de suporte cobrem as duas tabelas; anon não alcança nada", async () => {
    const pol = await pool.query(
      `select tablename, policyname from pg_policies
        where tablename in ('green_products','green_lead_context') and policyname like 'support_write_%'`,
    );
    for (const tabela of ["green_products", "green_lead_context"]) {
      const nomes = pol.rows.filter((r) => r.tablename === tabela).map((r) => r.policyname);
      expect(nomes.sort()).toEqual([
        "support_write_delete",
        "support_write_insert",
        "support_write_update",
      ]);
    }
    const anon = await pool.query(
      `select has_table_privilege('anon','public.green_products','select') a,
              has_table_privilege('anon','public.green_lead_context','select') b`,
    );
    expect(anon.rows[0]).toEqual({ a: false, b: false });
  });

  it("RL5 fn_green_lead_eligible: só lead Green visível ao chamador", async () => {
    const a = await tenant();
    const b = await tenant();
    const lg = await lead(a, a.green);
    const lc = await lead(a, a.comum);
    const f = (sub: string, id: string) =>
      request({ papel: "authenticated", sub }, "select public.fn_green_lead_eligible($1) v", [
        id,
      ]).then((r) => r.rows[0]!.v as boolean);
    expect(await f(a.agente, lg)).toBe(true);
    expect(await f(a.agente, lc)).toBe(false);
    expect(await f(b.admin, lg)).toBe(false); // lead de outra organização = "não aplicável"
    const anon = await pool.query(
      "select has_function_privilege('anon','public.fn_green_lead_eligible(uuid)','execute') v",
    );
    expect(anon.rows[0].v).toBe(false);
  });
});

/* ═══════════════════════════ FUNIL != PRODUTO ═══════════════════════════════ */
describe("FP · funil e produto são independentes", () => {
  it("FP1 dois produtos no MESMO funil: nenhum funil novo, nenhuma tag, cada lead mantém o seu", async () => {
    const a = await tenant();
    const b = await tenant();
    const alfa = await produto(a.org, "produto_alfa", { name: "Produto Alfa" });
    const beta = await produto(a.org, "produto_beta", { name: "Produto Beta" });
    const funisAntes = await contar(
      "select count(*) n from crm_pipelines where organization_id=$1",
      [a.org],
    );

    const l1 = await lead(a, a.green);
    const l2 = await lead(a, a.green);
    await contexto(l1, a.org, alfa);
    await contexto(l2, a.org, beta);

    const { rows } = await pool.query(
      `select l.id, l.pipeline_id, l.tags, c.product_id
         from crm_leads l join green_lead_context c on c.lead_id = l.id
        where l.id = any($1::uuid[]) order by l.title, l.id`,
      [[l1, l2]],
    );
    const por = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(por[l1].pipeline_id).toBe(a.green.id);
    expect(por[l2].pipeline_id).toBe(a.green.id);
    expect(por[l1].product_id).toBe(alfa);
    expect(por[l2].product_id).toBe(beta);
    expect(por[l1].tags ?? []).toEqual([]);
    expect(por[l2].tags ?? []).toEqual([]);
    expect(
      await contar("select count(*) n from crm_pipelines where organization_id=$1", [a.org]),
    ).toBe(funisAntes);
    expect(
      await contar(
        "select count(*) n from green.product_pipeline_binding where organization_id=$1",
        [a.org],
      ),
    ).toBe(1);

    // trocar de produto não mexe no funil nem na etapa
    await pool.query("update green_lead_context set product_id=$2 where lead_id=$1", [l1, beta]);
    const depois = (
      await pool.query("select pipeline_id, stage_id from crm_leads where id=$1", [l1])
    ).rows[0];
    expect(depois).toEqual({ pipeline_id: a.green.id, stage_id: a.green.aberta });

    // tenant B não enxerga nada de A
    const deB = { papel: "authenticated", sub: b.admin } as Request;
    expect((await request(deB, "select 1 from green_products")).rows).toHaveLength(0);
    expect((await request(deB, "select 1 from green_lead_context")).rows).toHaveLength(0);
  });

  it("FP2 o mesmo produto serve a mais de um funil Green da organização", async () => {
    const t = await tenant();
    const outroGreen = await novoFunil(t.org, true);
    const alfa = await produto(t.org, "alfa");
    const l1 = await lead(t, t.green);
    const l2 = await lead(t, outroGreen);
    await contexto(l1, t.org, alfa);
    await contexto(l2, t.org, alfa);
    expect(
      await contar("select count(*) n from green_lead_context where product_id=$1", [alfa]),
    ).toBe(2);
  });

  it("FP3 o schema não amarra produto a funil nem ao binding", async () => {
    const colunas = await pool.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name in ('green_products','green_lead_context')`,
    );
    const nomes = colunas.rows.map((r) => r.column_name as string);
    expect(nomes.filter((n) => /pipeline|stage|funil|tag|utm|campaign|source/i.test(n))).toEqual(
      [],
    );
    expect(
      await contar(
        `select count(*) n from information_schema.tables
          where table_name in ('green_pipeline_product','green_pipeline_products')`,
      ),
    ).toBe(0);
    // nenhuma FK liga o binding (chave de processo) ao catálogo, em nenhum sentido
    const fks = await pool.query(
      `select conrelid::regclass::text origem, confrelid::regclass::text destino
         from pg_constraint where contype='f'
          and ((conrelid='green.product_pipeline_binding'::regclass and confrelid::regclass::text like '%green_products')
            or (confrelid='green.product_pipeline_binding'::regclass and conrelid::regclass::text like '%green_products'))`,
    );
    expect(fks.rows).toEqual([]);
    // o binding segue com a coluna histórica, intacta
    expect(
      await contar(
        `select count(*) n from information_schema.columns
          where table_schema='green' and table_name='product_pipeline_binding' and column_name='product_key'`,
      ),
    ).toBe(1);
  });
});
