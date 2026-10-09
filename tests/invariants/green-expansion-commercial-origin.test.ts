/**
 * CG-COM-01 — Expansão pós-ganho: nova oportunidade a partir de uma oportunidade ganha
 * (migration 0510).
 *
 * Contrato (o que esta suíte exige, direto no banco, pelos papéis reais):
 *
 *   EX   a expansão é uma oportunidade NOVA (id próprio, aberta, `source = expansao`), do MESMO
 *        contato, no funil/etapa pedidos, com o produto pedido e o vínculo
 *        `crm_lead_links (B -> A, commercial_origin)`; tudo numa transação só;
 *   OR   a oportunidade de origem (A) fica intacta: a linha inteira, o contexto, a timeline e os
 *        eventos dela não mudam;
 *   ID   idempotência: uma expansão ABERTA por (origem, produto). Repetir devolve a mesma, sem
 *        escrita; chamadas simultâneas criam uma só; produto diferente ou expansão já encerrada
 *        abrem outra; a existente invisível ao chamador recusa sem revelar a linha;
 *   EL   elegibilidade: origem ganha e com contato; destino Green com etapa aberta; produto
 *        obrigatório, ativo e da organização. Recusa não deixa meia escrita;
 *   TN   isolamento: outra organização não alcança a origem nem o vínculo; o guarda do vínculo
 *        recusa alvo/lead de outra organização para QUALQUER papel;
 *   PM   permissões: viewer não cria; vínculo `commercial_origin` exige agent+, alvo ganho, alvo
 *        `lead`, origem diferente do destino, e é imutável; os outros vínculos não mudam;
 *   EV   eventos: o banco emite só o `lead.green_context_changed` da B (nenhum fato novo sobre A);
 *   SG   as funções novas não são alcançáveis por anon e a de escrita roda com a RLS do chamador.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 12,
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
  segunda: string;
  ganho: string;
  perdido: string;
  arquivada: string;
}
interface Tenant {
  org: string;
  admin: string;
  manager: string;
  agente: string;
  outroAgente: string;
  viewer: string;
  contato: string;
  conexao: Funil;
  expansao: Funil;
  comum: Funil;
  alfa: string;
  beta: string;
  inativo: string;
}

async function usuario(prefixo: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [
    id,
    `${prefixo}-${id}@expansao.test`,
  ]);
  return id;
}
async function membro(user: string, org: string, papel: string) {
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
    [user, org, papel],
  );
}

async function novoFunil(org: string, processo: string | null): Promise<Funil> {
  const id = randomUUID();
  await pool.query(
    "insert into crm_pipelines (id, organization_id, name, slug, is_default) values ($1,$2,$3,$4,false)",
    [id, org, `Funil ${processo ?? "comum"}`, `f-${id.slice(0, 8)}`],
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
  const arquivada = await etapa("Arquivada", 500);
  await pool.query("update crm_stages set is_archived = true where id = $1", [arquivada]);
  const aberta = await etapa("Aberta", 1000);
  const segunda = await etapa("Segunda", 1500);
  const ganho = await etapa("Ganho", 2000, true);
  const perdido = await etapa("Perdido", 3000, false, true);
  if (processo) {
    // `product_key` é chave de PROCESSO (histórica); nada aqui diz qual produto se vende.
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,$3)",
      [org, id, processo],
    );
  }
  return { id, aberta, segunda, ganho, perdido, arquivada };
}

async function produto(org: string, code: string, ativo = true): Promise<string> {
  const { rows } = await pool.query(
    `insert into green_products (organization_id, code, name, is_active)
     values ($1,$2,$3,$4) returning id`,
    [org, code, `Produto ${code}`, ativo],
  );
  return rows[0].id as string;
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
    [org, `ex-${org}`, `Org ${org.slice(0, 8)}`],
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
  const conexao = await novoFunil(org, "conexao_green");
  const expansao = await novoFunil(org, "expansao");
  const comum = await novoFunil(org, null);
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [org]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [comum.id]);
  const alfa = await produto(org, "alfa");
  const beta = await produto(org, "beta");
  const inativo = await produto(org, "velho", false);
  return {
    org,
    admin,
    manager,
    agente,
    outroAgente,
    viewer,
    contato,
    conexao,
    expansao,
    comum,
    alfa,
    beta,
    inativo,
  };
}

async function lead(
  t: Tenant,
  funil: Funil,
  opts: { contato?: string | null; owner?: string | null } = {},
): Promise<string> {
  const { rows } = await comoDono(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id)
     values ($1,$2,$3,'Maria - Conta de luz',$4,$5) returning id`,
    [
      t.org,
      funil.id,
      funil.aberta,
      opts.contato === undefined ? t.contato : opts.contato,
      opts.owner ?? null,
    ],
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

/** A oportunidade de origem: Green, com produto Alfa, GANHA. */
async function origemGanha(t: Tenant, opts: { contato?: string | null } = {}): Promise<string> {
  const a = await lead(t, t.conexao, opts);
  await pool.query(
    "insert into green_lead_context (lead_id, organization_id, product_id) values ($1,$2,$3)",
    [a, t.org, t.alfa],
  );
  await moverPara(a, t.conexao.ganho);
  return a;
}

interface Pedido {
  org?: string;
  origem: string;
  funil?: string;
  etapa?: string | null;
  produto?: string | null;
  titulo?: string;
  valor?: number | null;
  moeda?: string | null;
}
interface Resposta {
  created: boolean;
  lead_id: string;
  link_id: string;
}

/** A RPC de escrita, chamada como o PostgREST a chamaria (papel + claims do usuário). */
async function expandir(t: Tenant, quem: string, p: Pedido): Promise<Resposta> {
  const { rows } = await request(
    { papel: "authenticated", sub: quem },
    `select public.fn_crm_create_expansion_opportunity($1,$2,$3,$4,$5,$6,$7,$8) as r`,
    [
      p.org ?? t.org,
      p.origem,
      p.funil ?? t.expansao.id,
      p.etapa === undefined ? t.expansao.aberta : p.etapa,
      p.produto === undefined ? t.beta : p.produto,
      p.titulo ?? "Maria - Expansão",
      p.valor ?? null,
      p.moeda === undefined ? "BRL" : p.moeda,
    ],
  );
  return rows[0].r as Resposta;
}

const leadsDoContato = (contato: string) =>
  contar("select count(*)::int as n from crm_leads where contact_id = $1", [contato]);
const vinculosDe = (origem: string) =>
  contar(
    `select count(*)::int as n from crm_lead_links
      where target_kind = 'lead' and target_id = $1 and link_kind = 'commercial_origin'`,
    [origem],
  );
const linhaDe = async (id: string) =>
  (await pool.query("select to_jsonb(l) as j from crm_leads l where l.id = $1", [id])).rows[0]
    ?.j as Record<string, unknown> | undefined;

/* ═══════════════════════════ criação ════════════════════════════════════════ */
describe("EX · a expansão é uma oportunidade nova do mesmo contato", () => {
  it("EX1 agent cria B no funil/etapa/produto pedidos, ligada a A por commercial_origin", async () => {
    const t = await tenant();
    const a = await origemGanha(t);

    const r = await expandir(t, t.agente, { origem: a, valor: 15000 });

    expect(r.created).toBe(true);
    expect(r.lead_id).not.toBe(a);
    const b = (
      await pool.query(
        `select organization_id, pipeline_id, stage_id, contact_id, status, closed_at, source, title,
                value_cents, currency, owner_user_id, owner_agent_id, owner_kind, created_by_user_id,
                retomado_de_lead_id, external_id, tags
           from crm_leads where id = $1`,
        [r.lead_id],
      )
    ).rows[0];
    expect(b).toMatchObject({
      organization_id: t.org,
      pipeline_id: t.expansao.id,
      stage_id: t.expansao.aberta,
      contact_id: t.contato,
      status: "open",
      closed_at: null,
      source: "expansao",
      title: "Maria - Expansão",
      currency: "BRL",
      owner_user_id: null,
      owner_agent_id: null,
      owner_kind: null,
      created_by_user_id: t.agente,
      // os campos históricos recusados como relação NÃO são usados
      retomado_de_lead_id: null,
      external_id: null,
      tags: [],
    });
    expect(Number(b.value_cents)).toBe(15000);

    const ctx = await pool.query("select product_id from green_lead_context where lead_id = $1", [
      r.lead_id,
    ]);
    expect(ctx.rows[0].product_id).toBe(t.beta);

    const link = await pool.query(
      `select id, organization_id, lead_id, target_kind, target_id, link_kind, metadata, created_by_user_id
         from crm_lead_links where id = $1`,
      [r.link_id],
    );
    expect(link.rows[0]).toMatchObject({
      organization_id: t.org,
      lead_id: r.lead_id,
      target_kind: "lead",
      target_id: a,
      link_kind: "commercial_origin",
      created_by_user_id: t.agente,
    });
    expect(link.rows[0].metadata).toEqual({
      reason: "expansion",
      created_via: "manual",
      product_id: t.beta,
    });
    // o contato não foi duplicado
    expect(
      await contar("select count(*)::int as n from contacts where organization_id = $1", [t.org]),
    ).toBe(1);
  });

  it("EX2 sem etapa informada, B entra na primeira etapa aberta (não arquivada) do funil destino", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const r = await expandir(t, t.agente, { origem: a, etapa: null });
    const b = await linhaDe(r.lead_id);
    expect(b?.stage_id).toBe(t.expansao.aberta);
  });

  it("EX3 o produto de B pode ser o mesmo de A e B pode ficar no mesmo funil de A", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const r = await expandir(t, t.agente, {
      origem: a,
      funil: t.conexao.id,
      etapa: t.conexao.segunda,
      produto: t.alfa,
    });
    expect(r.created).toBe(true);
    const b = await linhaDe(r.lead_id);
    expect(b?.pipeline_id).toBe(t.conexao.id);
    expect(b?.stage_id).toBe(t.conexao.segunda);
  });
});

describe("OR · a oportunidade de origem fica intacta", () => {
  it("OR1 a linha de A, o contexto de A, a timeline de A e os eventos de A não mudam", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const antes = await linhaDe(a);
    const ctxAntes = (
      await pool.query("select to_jsonb(c) as j from green_lead_context c where lead_id = $1", [a])
    ).rows[0].j;
    const atividades = () =>
      contar("select count(*)::int as n from crm_lead_activities where lead_id = $1", [a]);
    const eventos = () =>
      contar(
        "select count(*)::int as n from event_log where entity_id = $1 or payload->>'lead_id' = $1::text",
        [a],
      );
    const [atvAntes, evtAntes] = [await atividades(), await eventos()];

    await expandir(t, t.agente, { origem: a });
    await expandir(t, t.agente, { origem: a, produto: t.alfa });

    expect(await linhaDe(a)).toEqual(antes);
    expect(antes?.status).toBe("won");
    expect(antes?.pipeline_id).toBe(t.conexao.id);
    expect(
      (
        await pool.query("select to_jsonb(c) as j from green_lead_context c where lead_id = $1", [
          a,
        ])
      ).rows[0].j,
    ).toEqual(ctxAntes);
    expect(await atividades()).toBe(atvAntes);
    expect(await eventos()).toBe(evtAntes);
  });
});

/* ═══════════════════════════ idempotência ═══════════════════════════════════ */
describe("ID · uma expansão aberta por (origem, produto)", () => {
  it("ID1 repetir a mesma operação devolve a MESMA oportunidade, sem nenhuma escrita", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const primeira = await expandir(t, t.agente, { origem: a });
    const eventos = () =>
      contar("select count(*)::int as n from event_log where organization_id = $1", [t.org]);
    const [leads, links, evts] = [
      await leadsDoContato(t.contato),
      await vinculosDe(a),
      await eventos(),
    ];

    // outro funil, outra etapa, outro título: a chave é origem + produto
    const segunda = await expandir(t, t.manager, {
      origem: a,
      funil: t.conexao.id,
      etapa: t.conexao.segunda,
      titulo: "Outro título",
    });

    expect(segunda).toEqual({
      created: false,
      lead_id: primeira.lead_id,
      link_id: primeira.link_id,
    });
    expect(await leadsDoContato(t.contato)).toBe(leads);
    expect(await vinculosDe(a)).toBe(links);
    expect(await eventos()).toBe(evts);
  });

  it("ID2 cinco chamadas simultâneas criam UMA expansão", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const respostas = await Promise.all(
      Array.from({ length: 5 }, () => expandir(t, t.agente, { origem: a })),
    );
    expect(new Set(respostas.map((r) => r.lead_id)).size).toBe(1);
    expect(respostas.filter((r) => r.created)).toHaveLength(1);
    expect(await vinculosDe(a)).toBe(1);
    expect(await leadsDoContato(t.contato)).toBe(2);
  });

  it("ID3 produto diferente abre outra expansão da mesma origem", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const b1 = await expandir(t, t.agente, { origem: a, produto: t.beta });
    const b2 = await expandir(t, t.agente, { origem: a, produto: t.alfa });
    expect(b2.created).toBe(true);
    expect(b2.lead_id).not.toBe(b1.lead_id);
    expect(await vinculosDe(a)).toBe(2);
  });

  it("ID4 expansão já encerrada não bloqueia uma nova com o mesmo produto", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const b1 = await expandir(t, t.agente, { origem: a });
    await moverPara(b1.lead_id, t.expansao.perdido);
    const b2 = await expandir(t, t.agente, { origem: a });
    expect(b2.created).toBe(true);
    expect(b2.lead_id).not.toBe(b1.lead_id);
    expect(await vinculosDe(a)).toBe(2);
  });

  it("ID5 expansão aberta invisível ao chamador recusa (sem criar e sem devolver a linha)", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const b1 = await expandir(t, t.manager, { origem: a });
    // a expansão passa a ser de outro atendente: no modo padrão o agente não a enxerga
    await comoDono("update crm_leads set owner_user_id = $2, owner_kind = 'user' where id = $1", [
      b1.lead_id,
      t.outroAgente,
    ]);
    const e = await erroDe(expandir(t, t.agente, { origem: a }));
    expect(e?.message).toContain("expansion_already_open");
    expect(e?.message).not.toContain(b1.lead_id);
    expect(await vinculosDe(a)).toBe(1);
  });
});

/* ═══════════════════════════ elegibilidade ══════════════════════════════════ */
describe("EL · elegibilidade da origem, do destino e do produto", () => {
  it("EL1 origem aberta ou perdida não gera expansão", async () => {
    const t = await tenant();
    const aberta = await lead(t, t.conexao);
    const perdida = await lead(t, t.conexao);
    await moverPara(perdida, t.conexao.perdido);
    for (const origem of [aberta, perdida]) {
      const e = await erroDe(expandir(t, t.agente, { origem }));
      expect(e?.message).toContain("expansion_origin_not_won");
    }
    expect(await leadsDoContato(t.contato)).toBe(2);
  });

  it("EL2 origem ganha sem contato não gera expansão (não há contato para reutilizar)", async () => {
    const t = await tenant();
    const a = await origemGanha(t, { contato: null });
    const e = await erroDe(expandir(t, t.agente, { origem: a }));
    expect(e?.message).toContain("expansion_origin_without_contact");
  });

  it("EL3 destino em funil sem binding Green é recusado e nada é gravado", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const e = await erroDe(
      expandir(t, t.agente, { origem: a, funil: t.comum.id, etapa: t.comum.aberta }),
    );
    expect(e?.message).toContain("expansion_destination_not_green");
    expect(await leadsDoContato(t.contato)).toBe(1);
  });

  it("EL4 etapa de outro funil, de ganho, de perda ou arquivada é recusada", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    for (const etapa of [
      t.conexao.aberta,
      t.expansao.ganho,
      t.expansao.perdido,
      t.expansao.arquivada,
    ]) {
      const e = await erroDe(expandir(t, t.agente, { origem: a, etapa }));
      expect(e?.message).toContain("expansion_stage_unavailable");
    }
    expect(await leadsDoContato(t.contato)).toBe(1);
  });

  it("EL5 produto obrigatório; inativo ou de outra organização é recusado sem meia escrita", async () => {
    const t = await tenant();
    const outra = await tenant();
    const a = await origemGanha(t);

    const semProduto = await erroDe(expandir(t, t.agente, { origem: a, produto: null }));
    expect(semProduto?.message).toContain("expansion_product_required");

    const inativo = await erroDe(expandir(t, t.agente, { origem: a, produto: t.inativo }));
    expect(inativo?.message).toContain("green_product_inactive");

    const deFora = await erroDe(expandir(t, t.agente, { origem: a, produto: outra.alfa }));
    expect(deFora?.code).toBe("23503");
    expect(deFora?.message).toContain("green_lead_context_product_fkey");

    // a oportunidade B não sobrou de nenhuma tentativa
    expect(await leadsDoContato(t.contato)).toBe(1);
    expect(await vinculosDe(a)).toBe(0);
  });

  it("EL6 título e moeda são validados", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    for (const titulo of ["", " x ", "y".repeat(201)]) {
      const e = await erroDe(expandir(t, t.agente, { origem: a, titulo }));
      expect(e?.message).toContain("expansion_title_invalid");
    }
    for (const moeda of [null, "brl", "REAL"]) {
      const e = await erroDe(expandir(t, t.agente, { origem: a, moeda }));
      expect(e?.message).toContain("expansion_currency_invalid");
    }
    const negativo = await erroDe(expandir(t, t.agente, { origem: a, valor: -1 }));
    expect(negativo?.message).toContain("expansion_value_invalid");
    expect(await leadsDoContato(t.contato)).toBe(1);
  });
});

/* ═══════════════════════════ isolamento ═════════════════════════════════════ */
describe("TN · isolamento entre organizações", () => {
  it("TN1 membro de outra organização não alcança a origem (mesma recusa de inexistente)", async () => {
    const t = await tenant();
    const outra = await tenant();
    const a = await origemGanha(t);

    const deFora = await erroDe(expandir(outra, outra.agente, { origem: a, org: outra.org }));
    expect(deFora?.message).toContain("expansion_origin_not_found");
    const inexistente = await erroDe(expandir(t, t.agente, { origem: randomUUID() }));
    expect(inexistente?.message).toContain("expansion_origin_not_found");
    expect(await vinculosDe(a)).toBe(0);
  });

  it("TN2 a organização pedida tem de ser a da origem, mesmo para quem é membro das duas", async () => {
    const t = await tenant();
    const outra = await tenant();
    await membro(t.agente, outra.org, "agent");
    const a = await origemGanha(t);
    const e = await erroDe(
      expandir(t, t.agente, {
        origem: a,
        org: outra.org,
        funil: outra.expansao.id,
        etapa: outra.expansao.aberta,
        produto: outra.beta,
      }),
    );
    expect(e?.message).toContain("expansion_origin_not_found");
    expect(await leadsDoContato(outra.contato)).toBe(0);
  });

  it("TN3 o guarda recusa vínculo entre organizações para qualquer papel, inclusive service_role", async () => {
    const t = await tenant();
    const outra = await tenant();
    const a = await origemGanha(t);
    const bDeFora = await lead(outra, outra.expansao);

    for (const [org, leadId, alvo] of [
      [outra.org, bDeFora, a], // alvo de outra organização
      [t.org, bDeFora, a], // lead de outra organização
    ] as const) {
      const e = await erroDe(
        request(
          { papel: "service_role" },
          `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
           values ($1,$2,'lead',$3,'commercial_origin')`,
          [org, leadId, alvo],
        ),
      );
      expect(e?.message).toContain("commercial_origin_tenant_mismatch");
    }
    // alvo inexistente: a MESMA recusa
    const b = await lead(t, t.expansao);
    const e = await erroDe(
      request(
        { papel: "service_role" },
        `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
         values ($1,$2,'lead',$3,'commercial_origin')`,
        [t.org, b, randomUUID()],
      ),
    );
    expect(e?.message).toContain("commercial_origin_tenant_mismatch");
  });

  it("TN4 outra organização não lê o vínculo nem a expansão", async () => {
    const t = await tenant();
    const outra = await tenant();
    const a = await origemGanha(t);
    const r = await expandir(t, t.agente, { origem: a });
    for (const quem of [outra.admin, outra.agente]) {
      const links = await request(
        { papel: "authenticated", sub: quem },
        "select id from crm_lead_links where id = $1 or target_id = $2",
        [r.link_id, a],
      );
      expect(links.rows).toHaveLength(0);
      const leads = await request(
        { papel: "authenticated", sub: quem },
        "select id from crm_leads where id = $1",
        [r.lead_id],
      );
      expect(leads.rows).toHaveLength(0);
    }
  });
});

/* ═══════════════════════════ permissões ═════════════════════════════════════ */
describe("PM · permissões e integridade do vínculo", () => {
  it("PM1 viewer não cria expansão; agent, manager e admin criam", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const e = await erroDe(expandir(t, t.viewer, { origem: a }));
    expect(e?.code).toBe("42501");
    expect(await leadsDoContato(t.contato)).toBe(1);

    const produtos = [t.beta, t.alfa];
    for (const [i, quem] of [t.agente, t.admin].entries()) {
      const r = await expandir(t, quem, { origem: a, produto: produtos[i] });
      expect(r.created).toBe(true);
    }
  });

  it("PM2 vínculo commercial_origin direto exige agent+, alvo lead ganho e origem diferente do destino", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const aberta = await lead(t, t.conexao);
    const b = await lead(t, t.expansao);
    const inserir = (quem: string, alvo: string, kind = "lead", leadId = b) =>
      request(
        { papel: "authenticated", sub: quem },
        `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
         values ($1,$2,$3,$4,'commercial_origin')`,
        [t.org, leadId, kind, alvo],
      );

    expect((await erroDe(inserir(t.viewer, a)))?.message).toContain("commercial_origin_forbidden");
    expect((await erroDe(inserir(t.agente, aberta)))?.message).toContain(
      "commercial_origin_origin_not_won",
    );
    expect((await erroDe(inserir(t.agente, t.contato, "contact")))?.message).toContain(
      "commercial_origin_target_not_lead",
    );
    expect((await erroDe(inserir(t.agente, a, "lead", a)))?.message).toContain(
      "commercial_origin_self_reference",
    );
    // o caminho válido continua aberto
    expect(await erroDe(inserir(t.agente, a))).toBeNull();
  });

  it("PM3 o vínculo commercial_origin é imutável para todo papel", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const outraOrigem = await origemGanha(t);
    const r = await expandir(t, t.agente, { origem: a });
    for (const [papel, sub] of [
      ["authenticated", t.admin],
      ["service_role", undefined],
    ] as const) {
      for (const set of [
        "target_id = '" + outraOrigem + "'",
        "metadata = '{}'::jsonb",
        "link_kind = 'scheduled'",
      ]) {
        const e = await erroDe(
          request({ papel, sub }, `update crm_lead_links set ${set} where id = $1`, [r.link_id]),
        );
        expect(e?.message).toContain("commercial_origin_immutable");
      }
    }
  });

  it("PM4 os outros vínculos não passam pelo guarda (agenda continua gravando em lead aberto)", async () => {
    const t = await tenant();
    const aberto = await lead(t, t.comum);
    const out = await request(
      { papel: "authenticated", sub: t.viewer },
      `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
       values ($1,$2,'appointment',$3,'scheduled') returning id`,
      [t.org, aberto, randomUUID()],
    );
    expect(out.rows).toHaveLength(1);
  });
});

/* ═══════════════════════════ eventos ════════════════════════════════════════ */
describe("EV · fatos do banco", () => {
  it("EV1 o banco emite só o produto atribuído de B; nenhum fato novo sobre A", async () => {
    const t = await tenant();
    const a = await origemGanha(t);
    const desde = (await pool.query("select clock_timestamp() as t")).rows[0].t;
    const r = await expandir(t, t.agente, { origem: a });

    const novos = (
      await pool.query(
        `select event_type, entity_id, payload from event_log
          where organization_id = $1 and created_at >= $2 order by created_at, id`,
        [t.org, desde],
      )
    ).rows;
    const contexto = novos.filter((e) => e.event_type === "lead.green_context_changed");
    expect(contexto).toHaveLength(1);
    expect(contexto[0].payload).toMatchObject({
      lead_id: r.lead_id,
      change: "product_assigned",
      product_id: t.beta,
      previous_product_id: null,
      changed_by: t.agente,
    });
    expect(novos.some((e) => e.entity_id === a || e.payload?.lead_id === a)).toBe(false);
    // nenhum tipo de evento novo nasceu desta entrega
    expect(novos.map((e) => e.event_type).filter((x) => x.includes("expansion"))).toEqual([]);
  });
});

/* ═══════════════════════════ superfície ═════════════════════════════════════ */
describe("SG · superfície das funções novas", () => {
  const FUNCOES = [
    "fn_crm_create_expansion_opportunity",
    "fn_crm_open_expansion_of",
    "fn_green_pipeline_ids",
  ];

  it("SG1 anon e PUBLIC não executam; authenticated e service_role executam", async () => {
    const { rows } = await pool.query(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                       where x.grantee = 0 and x.privilege_type = 'EXECUTE') as publico
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`,
      [FUNCOES],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...FUNCOES].sort());
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ anon: false, auth: true, svc: true, publico: false });
    }
  });

  it("SG2 a escrita roda com a RLS do chamador (invoker); as leituras definer fixam search_path", async () => {
    const { rows } = await pool.query(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`,
      [FUNCOES],
    );
    const porNome = Object.fromEntries(rows.map((r) => [r.proname, r]));
    expect(porNome.fn_crm_create_expansion_opportunity.prosecdef).toBe(false);
    for (const nome of ["fn_crm_open_expansion_of", "fn_green_pipeline_ids"]) {
      expect(porNome[nome].prosecdef).toBe(true);
      expect(porNome[nome].proconfig).toContain('search_path=""');
    }
  });

  it("SG3 fn_green_pipeline_ids devolve os funis Green da organização só a quem é membro", async () => {
    const t = await tenant();
    const outra = await tenant();
    const ler = (quem: string, org: string) =>
      request(
        { papel: "authenticated", sub: quem },
        "select id from public.fn_green_pipeline_ids($1) as id order by id",
        [org],
      );
    const meus = (await ler(t.viewer, t.org)).rows.map((r) => r.id).sort();
    expect(meus).toEqual([t.conexao.id, t.expansao.id].sort());
    expect((await ler(outra.admin, t.org)).rows).toHaveLength(0);
  });

  it("SG4 fn_crm_open_expansion_of só responde pela origem visível e não revela expansão invisível", async () => {
    const t = await tenant();
    const outra = await tenant();
    const a = await origemGanha(t);
    const r = await expandir(t, t.manager, { origem: a });
    const ler = async (quem: string) =>
      (
        await request(
          { papel: "authenticated", sub: quem },
          "select lead_id, visible from public.fn_crm_open_expansion_of($1, $2)",
          [a, t.beta],
        )
      ).rows;
    expect(await ler(t.viewer)).toEqual([{ lead_id: r.lead_id, visible: true }]);
    expect(await ler(outra.admin)).toEqual([]);
    await comoDono("update crm_leads set owner_user_id = $2, owner_kind = 'user' where id = $1", [
      r.lead_id,
      t.outroAgente,
    ]);
    // existe, mas o agente não a enxerga: a resposta diz só isso, sem o id
    expect(await ler(t.agente)).toEqual([{ lead_id: null, visible: false }]);
    // produto sem expansão aberta: nenhuma linha
    expect(
      (
        await request(
          { papel: "authenticated", sub: t.viewer },
          "select lead_id from public.fn_crm_open_expansion_of($1, $2)",
          [a, t.alfa],
        )
      ).rows,
    ).toEqual([]);
  });
});
