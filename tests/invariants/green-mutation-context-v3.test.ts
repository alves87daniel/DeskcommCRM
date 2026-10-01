/**
 * SPIKE Green v3 — contraexemplos da AUDIT-DESKCOMM-08.2 como invariantes de
 * banco (V3-R01…R06 + ADV-09). Arquivo NOVO de propósito: os invariantes do v1
 * (`green-mutation-context.test.ts`) e do v2 (`green-mutation-context-v2.test.ts`)
 * não são reescritos aqui.
 *
 * Cada caso descreve o CONTRATO v3. Rodado contra o baseline da v2, cada um dos
 * que representam achado confirmado falha pelo motivo do achado (matriz RED no
 * relatório `docs/spike/GREEN-MUTATION-CONTEXT-V3.md`). Por isso o arquivo não
 * lê coluna nem função que só exista na v3: livro-razão e eventos são lidos por
 * `to_jsonb`, e a diferença aparece na asserção, não num "does not exist".
 *
 * Mesmo harness do v1/v2: o Postgres efêmero não tem PostgREST, então cada
 * request é simulada como o PostgREST a entrega (papel, claims, headers). A
 * travessia HTTP real fica no E2E (`tests/green-e2e/`).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

/* ── fixtures ───────────────────────────────────────────────────────────────── */
const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const GERENTE = randomUUID();
const ATACANTE = randomUUID(); // membro SÓ da outra org
const CONTATO = randomUUID();
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const ETAPA_A = randomUUID();
const ETAPA_B = randomUUID();
const ETAPA_C = randomUUID();
const ETAPA_COMUM_A = randomUUID();
const ETAPA_COMUM_B = randomUUID();
// a outra org: o funil e a etapa do próprio atacante
const FUNIL_DO_ATACANTE = randomUUID();
const ETAPA_DO_ATACANTE = randomUUID();
const CONTATO_DO_ATACANTE = randomUUID();

type Papel = "authenticated" | "service_role";
interface Request {
  papel: Papel;
  sub?: string;
  contexto?: Record<string, unknown>;
}

function b64(ctx: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(ctx), "utf8").toString("base64");
}

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
  if (r.contexto !== undefined) headers["x-green-mutation-context"] = b64(r.contexto);
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

/** O erro da escrita, ou `null` quando ela passou — para comparar veredito, não só recusar. */
async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as pg.DatabaseError;
  }
}
const veredito = (e: pg.DatabaseError | null) => (e ? `${e.code} ${e.message}` : "ACEITO");

const humano: Request = { papel: "authenticated", sub: GERENTE };
const atacante: Request = { papel: "authenticated", sub: ATACANTE };
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

async function novoLead(funil: string, etapa: string, r: Request = humano): Promise<string> {
  const { rows } = await request<{ id: string }>(
    r,
    "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio',$4) returning id",
    [ORG, funil, etapa, CONTATO],
  );
  return rows[0]!.id;
}

async function lead(id: string): Promise<{ pipeline_id: string; stage_id: string } | undefined> {
  return (await pool.query("select pipeline_id, stage_id from crm_leads where id=$1", [id])).rows[0];
}

interface Envelope {
  v: number;
  trusted: Record<string, unknown>;
  advisory: Record<string, unknown>;
}
interface Evento {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & { green: Envelope };
}
/** Todos os eventos da entidade, de qualquer tipo, na ordem em que nasceram. */
async function eventosDe(id: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select id, event_type, payload, metadata from event_log where entity_kind='crm_lead' and entity_id=$1 order by created_at, id",
    [id],
  );
  return rows;
}
const canonicos = async (id: string) =>
  (await eventosDe(id)).filter((e) => e.metadata.green_canonical === true);

async function livroDe(id: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query<{ l: Record<string, unknown> }>(
    "select to_jsonb(l) l from green.stage_event_ledger l where lead_id=$1 order by created_at, id",
    [id],
  );
  return rows.map((r) => r.l);
}

beforeAll(async () => {
  await pool.query(`insert into auth.users (id, email) values ($1, $2), ($3, $4)`, [
    GERENTE,
    `green-${GERENTE}@invariant.test`,
    ATACANTE,
    `green-${ATACANTE}@invariant.test`,
  ]);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Green Spike', 'Green Spike'), ($3, $4, 'Outra', 'Outra')`,
    [ORG, `green-${ORG}`, OUTRA_ORG, `outra-${OUTRA_ORG}`],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'manager',now()), ($3,$4,'manager',now())`,
    [GERENTE, ORG, ATACANTE, OUTRA_ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name) values ($1,$2,'Green Contato'), ($3,$4,'Contato do atacante')`,
    [CONTATO, ORG, CONTATO_DO_ATACANTE, OUTRA_ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1,$2,'Green','green-${FUNIL_GREEN.slice(0, 8)}'), ($3,$2,'Comum','comum-${FUNIL_COMUM.slice(0, 8)}'),
       ($4,$5,'Do atacante','atq-${FUNIL_DO_ATACANTE.slice(0, 8)}')`,
    [FUNIL_GREEN, ORG, FUNIL_COMUM, FUNIL_DO_ATACANTE, OUTRA_ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$2,$3,'A','etapa-a',1000), ($4,$2,$3,'B','etapa-b',2000), ($5,$2,$3,'C','etapa-c',3000),
       ($6,$2,$7,'A','etapa-a',1000), ($8,$2,$7,'B','etapa-b',2000),
       ($9,$10,$11,'A','etapa-a',1000)`,
    [
      ETAPA_A,
      ORG,
      FUNIL_GREEN,
      ETAPA_B,
      ETAPA_C,
      ETAPA_COMUM_A,
      FUNIL_COMUM,
      ETAPA_COMUM_B,
      ETAPA_DO_ATACANTE,
      OUTRA_ORG,
      FUNIL_DO_ATACANTE,
    ],
  );
  await pool.query(
    `insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')`,
    [ORG, FUNIL_GREEN],
  );
});
afterAll(() => pool.end());

/* ═══ V3-R01 — ADV-01: a fronteira vale na entrada, na permanência E na saída ═══ */
describe("V3-R01 — saída Green → não-Green passa pelo contrato Green", () => {
  const sair = (id: string, r: Request) =>
    request(r, "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
      id,
      FUNIL_COMUM,
      ETAPA_COMUM_B,
    ]);

  it("writer privilegiado SEM contexto não tira a Opportunity do funil Green (fail-closed, como na entrada)", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const e = await erroDe(sair(id, servicoSemContexto));
    expect(veredito(e)).toBe("42501 green_mutation_context_required");
    expect(await lead(id)).toEqual({ pipeline_id: FUNIL_GREEN, stage_id: ETAPA_A });
    expect(await eventosDe(id)).toHaveLength(0);
  });

  it("humano tirando do Green é canonizado: 1 lead.stage_changed com os dois funis e a transição `exit`", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_B);
    await sair(id, humano);
    expect(await lead(id)).toEqual({ pipeline_id: FUNIL_COMUM, stage_id: ETAPA_COMUM_B });
    const eventos = await canonicos(id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.event_type).toBe("lead.stage_changed");
    expect(eventos[0]!.payload).toMatchObject({
      from_pipeline_id: FUNIL_GREEN,
      pipeline_id: FUNIL_COMUM,
      from_stage_id: ETAPA_B,
      to_stage_id: ETAPA_COMUM_B,
      green_transition: "exit",
    });
    expect(eventos[0]!.metadata).toMatchObject({
      caller: "user",
      actor: { kind: "user", id: GERENTE },
    });
    expect(await livroDe(id)).toHaveLength(1);
  });

  it("writer privilegiado COM contexto sai do Green canonizado, com a proveniência do contexto", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const r = servico({ request_id: "req-saida" });
    await sair(id, r);
    const [e] = await canonicos(id);
    expect(e!.payload).toMatchObject({ green_transition: "exit", from_pipeline_id: FUNIL_GREEN });
    expect(e!.metadata).toMatchObject({ caller: "service_role", request_id: "req-saida" });
  });

  it("sair só trocando `pipeline_id` (etapa Green num funil comum) é incoerência de binding, recusada", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const e = await erroDe(
      request(humano, "update crm_leads set pipeline_id=$2 where id=$1", [id, FUNIL_COMUM]),
    );
    expect(veredito(e)).toBe("23503 green_stage_not_bound");
    expect(await lead(id)).toEqual({ pipeline_id: FUNIL_GREEN, stage_id: ETAPA_A });
  });

  it("entrada (não-Green → Green) continua guardada e passa a declarar a transição `enter`", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    const entrar = (r: Request) =>
      request(r, "update crm_leads set pipeline_id=$2, stage_id=$3 where id=$1", [
        id,
        FUNIL_GREEN,
        ETAPA_A,
      ]);
    expect(veredito(await erroDe(entrar(servicoSemContexto)))).toBe(
      "42501 green_mutation_context_required",
    );
    await entrar(humano);
    const [e] = await canonicos(id);
    expect(e!.payload).toMatchObject({
      from_pipeline_id: FUNIL_COMUM,
      pipeline_id: FUNIL_GREEN,
      green_transition: "enter",
    });
  });

  it("permanência (etapa dentro do Green) declara `stay`; lead não-Green segue sem canônico e sem contexto", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(humano, "update crm_leads set stage_id=$2 where id=$1", [id, ETAPA_B]);
    const [e] = await canonicos(id);
    expect(e!.payload).toMatchObject({ green_transition: "stay", pipeline_id: FUNIL_GREEN });

    const comum = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    await request(servicoSemContexto, "update crm_leads set stage_id=$2 where id=$1", [
      comum,
      ETAPA_COMUM_B,
    ]);
    expect((await lead(comum))!.stage_id).toBe(ETAPA_COMUM_B);
    expect(await canonicos(comum)).toHaveLength(0);
    expect(await livroDe(comum)).toHaveLength(0);
  });
});

/* ═══ V3-R02 — ADV-01: DELETE de entidade Green não é invisível ═══════════════ */
describe("V3-R02 — DELETE de Opportunity Green: contexto exigido e lápide canônica", () => {
  it("writer privilegiado SEM contexto não apaga Opportunity Green", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const e = await erroDe(request(servicoSemContexto, "delete from crm_leads where id=$1", [id]));
    expect(veredito(e)).toBe("42501 green_mutation_context_required");
    expect(await lead(id)).toBeDefined();
  });

  it("humano apagando deixa a lápide: 1 `lead.deleted` canônico com ator e último estado", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_B);
    await request(humano, "delete from crm_leads where id=$1", [id]);
    expect(await lead(id)).toBeUndefined();
    const eventos = await canonicos(id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.event_type).toBe("lead.deleted");
    expect(eventos[0]!.payload).toMatchObject({
      pipeline_id: FUNIL_GREEN,
      from_stage_id: ETAPA_B,
      green_transition: "delete",
    });
    expect(eventos[0]!.metadata).toMatchObject({
      caller: "user",
      actor: { kind: "user", id: GERENTE },
    });
    const livro = await livroDe(id);
    expect(livro).toHaveLength(1);
    expect(livro[0]!.canonical_event_id).toBe(eventos[0]!.id);
  });

  it("writer privilegiado COM contexto apaga e a lápide carrega a proveniência", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(servico({ request_id: "req-delete" }), "delete from crm_leads where id=$1", [id]);
    const [e] = await canonicos(id);
    expect(e!.event_type).toBe("lead.deleted");
    expect(e!.metadata).toMatchObject({ caller: "service_role", request_id: "req-delete" });
  });

  it("a lápide não é forjável: `lead.deleted` com a marca canônica por fora do produtor é recusado", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const e = await erroDe(
      request(
        servicoSemContexto,
        "select public.emit_event('lead.deleted','crm_lead',$1,'{}'::jsonb,jsonb_build_object('green_canonical',true),$2)",
        [id, ORG],
      ),
    );
    expect(veredito(e)).toBe("42501 green_canonical_reserved");
  });

  it("controle: DELETE de lead não-Green segue como no upstream (sem contexto, sem evento)", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    await request(servicoSemContexto, "delete from crm_leads where id=$1", [id]);
    expect(await lead(id)).toBeUndefined();
    expect(await eventosDe(id)).toHaveLength(0);
  });

  it("controle: apagar a ORGANIZAÇÃO inteira (cascata) não é barrado pela fronteira", async () => {
    const org = randomUUID();
    const funil = randomUUID();
    const etapa = randomUUID();
    await pool.query(
      "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Some','Some')",
      [org, `some-${org}`],
    );
    await pool.query(
      "insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'G','funil-g')",
      [funil, org],
    );
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'A','etapa-a',1000)",
      [etapa, org, funil],
    );
    // funil comum de controle, para medir o que o upstream já faz com a cascata
    const orgComum = randomUUID();
    const funilComum = randomUUID();
    const etapaComum = randomUUID();
    await pool.query(
      "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Some','Some')",
      [orgComum, `some-${orgComum}`],
    );
    await pool.query(
      "insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'C','funil-c')",
      [funilComum, orgComum],
    );
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'A','etapa-a',1000)",
      [etapaComum, orgComum, funilComum],
    );
    // o lead nasce ANTES do binding: fixture de dono, sem passar pela fronteira
    await pool.query(
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'x'), ($4,$5,$6,'y')",
      [org, funil, etapa, orgComum, funilComum, etapaComum],
    );
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [org, funil],
    );
    // a org Green tem um canônico de verdade: a cascata passa pela fronteira de
    // crm_leads E pelo guard de imutabilidade de event_log
    const etapaB = randomUUID();
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'B','etapa-b',2000)",
      [etapaB, org, funil],
    );
    const dono = await pool.connect();
    try {
      await dono.query("begin");
      await dono.query("select set_config('green.mutation_context', $1, true)", [
        JSON.stringify({ v: 1, source: "fixture", actor: { kind: "system", id: "fixture" } }),
      ]);
      await dono.query("update crm_leads set stage_id=$2 where organization_id=$1", [org, etapaB]);
      await dono.query("commit");
    } finally {
      dono.release();
    }
    const canonicosDaOrg = async () =>
      (
        await pool.query(
          "select count(*)::int n from event_log where organization_id=$1 and metadata ? 'green_canonical'",
          [org],
        )
      ).rows[0].n as number;
    expect(await canonicosDaOrg()).toBe(1);

    const apagar = (o: string) =>
      erroDe(request(servicoSemContexto, "delete from organizations where id=$1", [o]));
    // o veredito da org Green é o MESMO da org comum — e a exclusão do tenant passa
    const vereditoComum = veredito(await apagar(orgComum));
    expect(veredito(await apagar(org))).toBe(vereditoComum);
    expect(vereditoComum).toBe("ACEITO");
    expect(await canonicosDaOrg()).toBe(0);
    expect((await pool.query("select 1 from crm_leads where organization_id=$1", [org])).rowCount).toBe(0);
  });
});

/* ═══ V3-R03 — ADV-02: o guard não é oracle cross-tenant antes da RLS ══════════ */
describe("V3-R03 — oracle cross-tenant: Green e comum são indistinguíveis para quem não é da org", () => {
  /** O ataque da auditoria: INSERT com `organization_id` de OUTRA org e etapa do próprio atacante. */
  const sondaInsert = (funil: string, etapa: string = ETAPA_DO_ATACANTE, org: string = ORG) =>
    erroDe(
      request(
        atacante,
        "insert into crm_leads (organization_id, pipeline_id, stage_id, title) values ($1,$2,$3,'sonda')",
        [org, funil, etapa],
      ),
    );

  it("INSERT na org alheia: funil Green estrangeiro ≡ funil comum estrangeiro (mesmo código, mesma mensagem)", async () => {
    const green = veredito(await sondaInsert(FUNIL_GREEN));
    const comum = veredito(await sondaInsert(FUNIL_COMUM));
    expect(green).toBe(comum);
    expect(green).not.toContain("green_");
    expect(green).toContain("row-level security");
  });

  it("o binding etapa↔funil de outra org também não vaza: etapa certa, errada ou inexistente dão o mesmo veredito", async () => {
    const certa = veredito(await sondaInsert(FUNIL_GREEN, ETAPA_A));
    const errada = veredito(await sondaInsert(FUNIL_GREEN, ETAPA_COMUM_A));
    const inexistente = veredito(await sondaInsert(FUNIL_GREEN, randomUUID()));
    const funilInexistente = veredito(await sondaInsert(randomUUID(), ETAPA_A));
    expect(new Set([certa, errada, inexistente, funilInexistente]).size).toBe(1);
    expect(certa).not.toContain("green_");
  });

  it("UPDATE do PRÓPRIO lead para a org alheia (OLD org → NEW org): Green ≡ comum", async () => {
    const { rows } = await request<{ id: string }>(
      atacante,
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'meu',$4) returning id",
      [OUTRA_ORG, FUNIL_DO_ATACANTE, ETAPA_DO_ATACANTE, CONTATO_DO_ATACANTE],
    );
    const meu = rows[0]!.id;
    const sonda = (funil: string, etapa: string) =>
      erroDe(
        request(
          atacante,
          "update crm_leads set organization_id=$2, pipeline_id=$3, stage_id=$4 where id=$1",
          [meu, ORG, funil, etapa],
        ),
      );
    const green = veredito(await sonda(FUNIL_GREEN, ETAPA_DO_ATACANTE));
    const comum = veredito(await sonda(FUNIL_COMUM, ETAPA_DO_ATACANTE));
    const greenEtapaCerta = veredito(await sonda(FUNIL_GREEN, ETAPA_A));
    expect(green).toBe(comum);
    expect(greenEtapaCerta).toBe(comum);
    expect(green).not.toContain("green_");

    // sem contato (para a guarda upstream de contato não responder antes): quem decide é a RLS
    await request(atacante, "update crm_leads set contact_id=null where id=$1", [meu]);
    const greenSemContato = veredito(await sonda(FUNIL_GREEN, ETAPA_DO_ATACANTE));
    const comumSemContato = veredito(await sonda(FUNIL_COMUM, ETAPA_DO_ATACANTE));
    expect(greenSemContato).toBe(comumSemContato);
    expect(greenSemContato).not.toContain("green_");
  });

  it("UPDATE/DELETE de lead Green alheio: a RLS filtra antes; 0 linhas, nenhum erro Green, nada muda", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const u = await request(atacante, "update crm_leads set stage_id=$2 where id=$1", [id, ETAPA_B]);
    const d = await request(atacante, "delete from crm_leads where id=$1", [id]);
    expect([u.rowCount, d.rowCount]).toEqual([0, 0]);
    expect(await lead(id)).toEqual({ pipeline_id: FUNIL_GREEN, stage_id: ETAPA_A });
    expect(await eventosDe(id)).toHaveLength(0);
  });

  it("dentro da PRÓPRIA org o contrato Green continua explícito; IDs inexistentes caem na FK, não num erro Green", async () => {
    // membro da org: binding de etapa segue recusado com o erro Green (não é oracle: ele é da org)
    const e = await erroDe(novoLead(FUNIL_GREEN, ETAPA_COMUM_A));
    expect(veredito(e)).toBe("23503 green_stage_not_bound");
    const semFunil = await erroDe(novoLead(randomUUID(), ETAPA_A));
    const semEtapa = await erroDe(novoLead(FUNIL_COMUM, randomUUID()));
    for (const erro of [semFunil, semEtapa]) {
      expect(erro?.code).toBe("23503");
      expect(erro?.message).not.toContain("green_");
    }
  });
});

/* ═══ V3-R04 — ADV-03: o canônico emitido é registro histórico imutável ════════ */
describe("V3-R04 — evento canônico: write-once, com allowlist do consumer", () => {
  async function canonicoNovo(): Promise<{ lead: string; evento: Evento }> {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(humano, "update crm_leads set stage_id=$2 where id=$1", [id, ETAPA_B]);
    const [evento] = await canonicos(id);
    return { lead: id, evento: evento! };
  }
  const linha = async (id: string) =>
    (await pool.query("select to_jsonb(e) e from event_log e where id=$1", [id])).rows[0]?.e as
      | Record<string, unknown>
      | undefined;

  const ataques: [string, string, (lead: string) => unknown[]][] = [
    [
      "trocar actor/caller/request_id (metadata)",
      `metadata = metadata || jsonb_build_object('actor', jsonb_build_object('kind','system','id','forjado'), 'caller','service_role', 'request_id','rule:forjado')`,
      () => [],
    ],
    ["acrescentar campo à metadata", `metadata = metadata || '{"extra":1}'::jsonb`, () => []],
    ["remover campo da metadata", `metadata = metadata - 'actor'`, () => []],
    ["retirar a marca", `metadata = metadata - 'green_canonical'`, () => []],
    ["trocar provenance (source)", `metadata = jsonb_set(metadata, '{source}', '"automation"')`, () => []],
    ["alterar payload", `payload = payload || jsonb_build_object('to_stage_id', '${ETAPA_C}')`, () => []],
    ["realocar para outro lead (entity_id)", `entity_id = gen_random_uuid()`, () => []],
    ["realocar para outra org (organization_id)", `organization_id = '${OUTRA_ORG}'`, () => []],
    ["trocar o tipo do evento", `event_type = 'lead.updated'`, () => []],
    ["trocar entity_kind", `entity_kind = 'contact'`, () => []],
    ["reescrever created_at", `created_at = now() - interval '1 day'`, () => []],
  ];

  it.each(ataques)("service_role não consegue %s", async (_nome, set) => {
    const { evento } = await canonicoNovo();
    const antes = await linha(evento.id);
    const e = await erroDe(
      request(servicoSemContexto, `update event_log set ${set} where id=$1`, [evento.id]),
    );
    expect(veredito(e)).toBe("42501 green_canonical_immutable");
    expect(await linha(evento.id)).toEqual(antes);
  });

  it("service_role não apaga o canônico; o livro-razão nunca aponta para o nada", async () => {
    const { lead: id, evento } = await canonicoNovo();
    const e = await erroDe(request(servicoSemContexto, "delete from event_log where id=$1", [evento.id]));
    expect(veredito(e)).toBe("42501 green_canonical_immutable");
    expect(await linha(evento.id)).toBeDefined();
    expect((await livroDe(id))[0]!.canonical_event_id).toBe(evento.id);
  });

  it("allowlist do consumer: status, consumed_by, attempts, last_error, next_attempt_at e updated_at continuam mutáveis", async () => {
    const { evento } = await canonicoNovo();
    await request(
      servicoSemContexto,
      "update event_log set status='processing', updated_at=now() where id=$1",
      [evento.id],
    );
    await request(
      servicoSemContexto,
      "update event_log set status='pending', attempts=attempts+1, last_error='x', next_attempt_at=now(), consumed_by=array['automation-rules'] where id=$1",
      [evento.id],
    );
    await request(
      servicoSemContexto,
      "update event_log set status='done', consumed_by=array['automation-rules','outro'] where id=$1",
      [evento.id],
    );
    const depois = await linha(evento.id);
    expect(depois).toMatchObject({ status: "done", attempts: 1, last_error: "x" });
    expect(depois!.metadata).toEqual(evento.metadata);
    expect(depois!.payload).toEqual(evento.payload);
  });

  it("controle: evento NÃO canônico segue mutável e apagável como no upstream", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    const { rows } = await request<{ id: string }>(
      servicoSemContexto,
      "select public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,'{}'::jsonb,$3) id",
      [id, JSON.stringify({ from_stage_id: ETAPA_COMUM_A, to_stage_id: ETAPA_COMUM_B }), ORG],
    );
    await request(
      servicoSemContexto,
      `update event_log set metadata = metadata || '{"outcome":"ok"}'::jsonb, payload = payload || '{"x":1}'::jsonb where id=$1`,
      [rows[0]!.id],
    );
    await request(servicoSemContexto, "delete from event_log where id=$1", [rows[0]!.id]);
    expect(await linha(rows[0]!.id)).toBeUndefined();
  });
});

/* ═══ V3-R05 / V3-R06 — ADV-04: trusted × advisory ═════════════════════════════ */
describe("V3-R05/R06 — o que o caller controla nunca ocupa o lugar do que o sistema deriva", () => {
  const CAUSA = randomUUID();
  const forjado = {
    v: 1,
    source: "automation",
    request_id: "rule:qualquer",
    correlation_id: "rule:qualquer",
    causation_event_id: CAUSA,
    idempotency_key: "chave-de-outro",
    source_job_id: "job-forjado",
  };
  const CAMPOS_DE_CONTROLE = [
    "request_id",
    "correlation_id",
    "causation_event_id",
    "idempotency_key",
    "source_job_id",
  ];

  it("V3-R05: `request_id=rule:*` forjado por humano não chega a nenhum campo de controle do canônico", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request({ ...humano, contexto: forjado }, "update crm_leads set stage_id=$2 where id=$1", [
      id,
      ETAPA_B,
    ]);
    const [e] = await canonicos(id);
    // o que o motor de automação lê hoje (`metadata.request_id`, `metadata.caused_by_rule`)
    expect(e!.metadata.request_id).toBeUndefined();
    expect(e!.metadata.caused_by_rule).toBeUndefined();
    for (const campo of CAMPOS_DE_CONTROLE) expect(e!.metadata[campo], campo).toBeUndefined();
    // a origem confiável é derivada do canal real, nunca escolhida pelo cliente
    expect(e!.metadata.source).toBe("user_session");
  });

  it("V3-R06: humano — trusted é só o que o banco deriva; tudo o que veio no header fica em advisory", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request({ ...humano, contexto: forjado }, "update crm_leads set stage_id=$2 where id=$1", [
      id,
      ETAPA_B,
    ]);
    const [e] = await canonicos(id);
    expect(e!.metadata.green).toEqual({
      v: 2,
      trusted: {
        caller: "user",
        actor: { kind: "user", id: GERENTE },
        source: "user_session",
      },
      advisory: {
        source: "automation",
        request_id: "rule:qualquer",
        correlation_id: "rule:qualquer",
        causation_event_id: CAUSA,
        idempotency_key: "chave-de-outro",
        source_job_id: "job-forjado",
      },
    });
    expect(e!.metadata).toMatchObject({
      caller: "user",
      actor: { kind: "user", id: GERENTE },
      actor_user_id: GERENTE,
    });
  });

  it("V3-R06: humano tentando declarar ator/origem no header continua ignorado (actor = auth.uid())", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(
      {
        ...humano,
        contexto: { v: 1, source: "mcp", actor: { kind: "system", id: "forjado" } },
      },
      "update crm_leads set stage_id=$2 where id=$1",
      [id, ETAPA_B],
    );
    const [e] = await canonicos(id);
    expect(e!.metadata.green.trusted).toEqual({
      caller: "user",
      actor: { kind: "user", id: GERENTE },
      source: "user_session",
    });
    expect(e!.metadata.green.advisory).toEqual({ source: "mcp" });
  });

  it("V3-R06: backend (service_role) — o contexto validado é trusted, advisory fica vazio, e só trusted aparece no topo", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const REGRA = randomUUID();
    await request(
      {
        papel: "service_role",
        contexto: {
          v: 1,
          source: "automation",
          request_id: `rule:${REGRA}`,
          correlation_id: "corr-1",
          idempotency_key: "idem-1",
          source_job_id: "job-1",
          actor: { kind: "webhook_source", id: REGRA },
        },
      },
      "update crm_leads set stage_id=$2 where id=$1",
      [id, ETAPA_B],
    );
    const [e] = await canonicos(id);
    const trusted = {
      caller: "service_role",
      actor: { kind: "webhook_source", id: REGRA },
      source: "automation",
      request_id: `rule:${REGRA}`,
      correlation_id: "corr-1",
      idempotency_key: "idem-1",
      source_job_id: "job-1",
    };
    expect(e!.metadata.green).toEqual({ v: 2, trusted, advisory: {} });
    expect(e!.metadata).toMatchObject(trusted);
  });

  it("V3-R06: o livro-razão guarda o request_id confiável separado do advisory", async () => {
    const h = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request({ ...humano, contexto: forjado }, "update crm_leads set stage_id=$2 where id=$1", [
      h,
      ETAPA_B,
    ]);
    expect((await livroDe(h))[0]).toMatchObject({
      request_id: null,
      advisory_request_id: "rule:qualquer",
    });
    const s = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(servico({ request_id: "req-confiavel" }), "update crm_leads set stage_id=$2 where id=$1", [
      s,
      ETAPA_B,
    ]);
    expect((await livroDe(s))[0]).toMatchObject({
      request_id: "req-confiavel",
      advisory_request_id: null,
    });
  });
});

/* ═══ ADV-09 — binding por etapa, decidido na fronteira (sem tocar o writer) ═══ */
describe("ADV-09 — etapa e funil efetivo têm de concordar sempre que a mutação toca o domínio Green", () => {
  it("lote: lead NÃO-Green não recebe etapa Green (`fn_mover_leads_em_lote` intacta; a fronteira recusa)", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    const e = await erroDe(
      request(humano, "select * from public.fn_mover_leads_em_lote($1,$2,$3)", [ORG, [id], ETAPA_B]),
    );
    expect(veredito(e)).toBe("23503 green_stage_not_bound");
    expect(await lead(id)).toEqual({ pipeline_id: FUNIL_COMUM, stage_id: ETAPA_COMUM_A });
  });

  it("UPDATE direto: lead não-Green → etapa Green sem trocar de funil é recusado, para humano e para service_role", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    for (const r of [humano, servico(), servicoSemContexto]) {
      const e = await erroDe(request(r, "update crm_leads set stage_id=$2 where id=$1", [id, ETAPA_A]));
      expect(veredito(e)).toBe("23503 green_stage_not_bound");
    }
    expect((await lead(id))!.stage_id).toBe(ETAPA_COMUM_A);
  });

  it("INSERT: lead em funil comum com etapa Green é recusado", async () => {
    const e = await erroDe(novoLead(FUNIL_COMUM, ETAPA_A));
    expect(veredito(e)).toBe("23503 green_stage_not_bound");
  });

  it("controle: o lote dentro do funil Green segue funcionando, 1 canônico por lead", async () => {
    const a = await novoLead(FUNIL_GREEN, ETAPA_A);
    const b = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(humano, "select * from public.fn_mover_leads_em_lote($1,$2,$3)", [ORG, [a, b], ETAPA_C]);
    for (const id of [a, b]) {
      expect((await lead(id))!.stage_id).toBe(ETAPA_C);
      expect(await canonicos(id)).toHaveLength(1);
    }
  });

  it("controle: lote e UPDATE entre etapas de funis COMUNS seguem como no upstream (a fronteira não opina)", async () => {
    const id = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    await request(humano, "select * from public.fn_mover_leads_em_lote($1,$2,$3)", [ORG, [id], ETAPA_COMUM_B]);
    expect((await lead(id))!.stage_id).toBe(ETAPA_COMUM_B);
    expect(await canonicos(id)).toHaveLength(0);
  });
});

/* ═══ ADV-07 — controle de não-regressão do supressor sob os namespaces novos ══ */
describe("ADV-07 (controle) — o supressor do gêmeo não piora com a separação trusted/advisory", () => {
  const emit = (r: Request, id: string, payload: object, metadata: object) =>
    request<{ id: string | null }>(
      r,
      "select public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,$3::jsonb,$4) id",
      [id, JSON.stringify(payload), JSON.stringify(metadata), ORG],
    );

  it("o gêmeo legado da mutação canonizada continua sumindo; o segundo evento igual continua passando", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    await request(humano, "update crm_leads set stage_id=$2 where id=$1", [id, ETAPA_B]);
    const gemeo = await emit(humano, id, { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B }, { request_id: "r1" });
    expect(gemeo.rows[0]!.id).toBeNull();
    const segundo = await emit(humano, id, { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B }, { request_id: "r2" });
    expect(segundo.rows[0]!.id).not.toBeNull();
    expect(await eventosDe(id)).toHaveLength(2);
  });

  it("request_id CONFIÁVEL (writer privilegiado) ainda escolhe a linha certa; o advisory humano não escolhe", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_A);
    const mover = (r: Request, para: string) =>
      request(r, "update crm_leads set stage_id=$2 where id=$1", [id, para]);
    await mover(servico({ request_id: "req-1" }), ETAPA_B);
    await mover(servico({ request_id: "req-2" }), ETAPA_A);
    await mover(servico({ request_id: "req-3" }), ETAPA_B);
    // o gêmeo da PRIMEIRA A→B chega depois da terceira: casa pela chave confiável
    await emit(servicoSemContexto, id, { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B }, { request_id: "req-1" });
    let livro = await livroDe(id);
    expect(livro.find((l) => l.request_id === "req-1")!.legacy_suppressed_at).not.toBeNull();
    expect(livro.find((l) => l.request_id === "req-3")!.legacy_suppressed_at).toBeNull();

    // mutações humanas com request_id no header: o livro não o trata como chave
    const h = await novoLead(FUNIL_GREEN, ETAPA_A);
    const comHeader = (rid: string): Request => ({
      ...humano,
      contexto: { v: 1, source: "http_session", request_id: rid },
    });
    await request(comHeader("h-1"), "update crm_leads set stage_id=$2 where id=$1", [h, ETAPA_B]);
    await request(comHeader("h-2"), "update crm_leads set stage_id=$2 where id=$1", [h, ETAPA_A]);
    await request(comHeader("h-3"), "update crm_leads set stage_id=$2 where id=$1", [h, ETAPA_B]);
    await emit(humano, h, { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B }, { request_id: "h-1" });
    livro = await livroDe(h);
    // GAP-SUPPRESSOR-V3: sem chave confiável, casa a mais recente (h-3), não a "sua" (h-1)
    expect(livro.find((l) => l.advisory_request_id === "h-3")!.legacy_suppressed_at).not.toBeNull();
    expect(livro.find((l) => l.advisory_request_id === "h-1")!.legacy_suppressed_at).toBeNull();
    expect(await eventosDe(h)).toHaveLength(3);
  });

  it("a lápide de DELETE nunca é gêmeo: um lead.stage_changed legado não casa com linha de exclusão", async () => {
    const id = await novoLead(FUNIL_GREEN, ETAPA_B);
    await request(humano, "delete from crm_leads where id=$1", [id]);
    const livro = await livroDe(id);
    expect(livro).toHaveLength(1);
    expect(livro[0]!.legacy_suppressed_at).toBeNull();
    expect(livro[0]!.kind).toBe("deleted");
  });
});
