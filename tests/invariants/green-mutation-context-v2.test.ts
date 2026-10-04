/**
 * SPIKE Green v2 — invariantes de banco dos gaps da auditoria independente do
 * SPIKE-DESKCOMM-07 (S15 forja do canônico, S16 origem por evento x contato
 * real, S17 oracle cross-tenant, S23 supressor por gêmeo). Arquivo NOVO de
 * propósito: `tests/invariants/**` é congelado (`loop/hooks/freeze-invariants.sh`)
 * e o S1–S14 do v1 (`green-mutation-context.test.ts`) segue intacto.
 *
 * Mesmo harness do v1: o Postgres efêmero não tem PostgREST, então cada
 * request é simulada como o PostgREST a entrega (papel, claims, headers). A
 * travessia HTTP real fica no E2E (`tests/green-e2e/postgrest-real.e2e.ts`).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

/* ── fixtures (UUIDs aleatórios: nada colide com outro arquivo) ─────────────── */
const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const GERENTE = randomUUID();
const OUTRO_GERENTE = randomUUID();
const CONTATO = randomUUID();
const CONTATO_2 = randomUUID();
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const ETAPA_A = randomUUID();
const ETAPA_B = randomUUID();
const ETAPA_C = randomUUID();
const ETAPA_COMUM_A = randomUUID();
const ETAPA_COMUM_B = randomUUID();
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

const mover = (lead: string, para: string, r: Request, de?: string) =>
  request<{ id: string }>(
    r,
    `update crm_leads set stage_id=$2 where id=$1 ${de ? "and stage_id=$3" : ""} returning id`,
    de ? [lead, para, de] : [lead, para],
  );

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
    `insert into contacts (id, organization_id, display_name) values ($1,$2,'Green Contato'), ($3,$2,'Green Contato 2')`,
    [CONTATO, ORG, CONTATO_2],
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

/** `emit_event` chamado POR FORA do produtor canônico, como um chamador PostgREST faria. */
function emitComo(r: Request, lead: string, payload: object, metadata: object) {
  return request<{ id: string }>(
    r,
    "select public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,$3::jsonb,$4) id",
    [lead, JSON.stringify(payload), JSON.stringify(metadata), ORG],
  );
}

async function livroDe(lead: string) {
  const { rows } = await pool.query<{
    id: string;
    from_stage_id: string | null;
    to_stage_id: string;
    request_id: string | null;
    canonical_event_id: string | null;
    legacy_suppressed_at: Date | null;
    legacy_request_id: string | null;
  }>(
    "select id, from_stage_id, to_stage_id, request_id, canonical_event_id, legacy_suppressed_at, legacy_request_id from green.stage_event_ledger where lead_id=$1 order by created_at, id",
    [lead],
  );
  return rows;
}

describe("S15 — a marca canônica não é forjável", () => {
  it("o trigger real continua emitindo: 1 evento, e o livro-razão prova o produtor", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [e] = await eventosDe(lead);
    expect(e!.metadata.green_canonical).toBe(true);
    const livro = await livroDe(lead);
    expect(livro).toHaveLength(1);
    expect(livro[0]).toMatchObject({
      from_stage_id: ETAPA_A,
      to_stage_id: ETAPA_B,
      canonical_event_id: e!.id,
    });
  });

  it("authenticated chamando emit_event com green_canonical=true é recusado (42501) e nada nasce", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const payload = {
      pipeline_id: FUNIL_GREEN,
      from_stage_id: ETAPA_A,
      to_stage_id: ETAPA_B,
      status: "open",
    };
    const humano: Request = { papel: "authenticated", sub: GERENTE };
    for (const metadata of [
      { green_canonical: true },
      { green_context_version: 1 },
      { green_canonical: "true", caller: "user" },
    ]) {
      const erro = await recusa(emitComo(humano, lead, payload, metadata));
      expect(erro.code).toBe("42501");
      expect(erro.message).toBe("green_canonical_reserved");
    }
    // nem para lead não-Green: a marca é reservada ao produtor, ponto
    const comum = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    const erroComum = await recusa(
      emitComo(
        humano,
        comum,
        { from_stage_id: ETAPA_COMUM_A, to_stage_id: ETAPA_COMUM_B },
        { green_canonical: true },
      ),
    );
    expect(erroComum.message).toBe("green_canonical_reserved");
    expect(await eventosDe(lead)).toHaveLength(0);
    expect(await eventosDe(comum)).toHaveLength(0);
    expect(await etapaDe(lead)).toBe(ETAPA_A);
  });

  it("service_role fora do produtor também não forja: nem por emit_event, nem por INSERT, nem pelo GUC da prova", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const payload = JSON.stringify({
      pipeline_id: FUNIL_GREEN,
      from_stage_id: ETAPA_A,
      to_stage_id: ETAPA_B,
      status: "open",
    });
    const servico: Request = { papel: "service_role" };
    const viaRpc = await recusa(
      emitComo(servico, lead, JSON.parse(payload), { green_canonical: true }),
    );
    expect(viaRpc.message).toBe("green_canonical_reserved");
    const viaInsert = await recusa(
      request(
        servico,
        "insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata) values ($1,'lead.stage_changed','crm_lead',$2,$3::jsonb,jsonb_build_object('green_canonical',true))",
        [ORG, lead, payload],
      ),
    );
    expect(viaInsert.message).toBe("green_canonical_reserved");

    // GUC da prova apontando para um id inventado…
    const inventado = await recusa(
      request(
        servico,
        "select set_config('green.canonical_proof', gen_random_uuid()::text, true), public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,jsonb_build_object('green_canonical',true),$3)",
        [lead, payload, ORG],
      ),
    );
    expect(inventado.message).toBe("green_canonical_reserved");
    // …ou para a linha REAL de uma mutação já commitada (outra transação, já carimbada)
    const real = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(real, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [linha] = await livroDe(real);
    const reaproveitada = await recusa(
      request(
        servico,
        "select set_config('green.canonical_proof', $4, true), public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,jsonb_build_object('green_canonical',true),$3)",
        [real, payload, ORG, linha!.id],
      ),
    );
    expect(reaproveitada.message).toBe("green_canonical_reserved");
    expect(await eventosDe(lead)).toHaveLength(0);
    expect(await eventosDe(real)).toHaveLength(1);
  });

  it("a marca é imutável depois de nascer: nem acrescentada a um evento comum, nem retirada do canônico", async () => {
    const comum = await novoLead(FUNIL_COMUM, ETAPA_COMUM_A);
    const { rows } = await emitComo(
      { papel: "service_role" },
      comum,
      { from_stage_id: ETAPA_COMUM_A, to_stage_id: ETAPA_COMUM_B },
      {},
    );
    const acrescentar = await recusa(
      request(
        { papel: "service_role" },
        "update event_log set metadata = metadata || jsonb_build_object('green_canonical', true) where id=$1",
        [rows[0]!.id],
      ),
    );
    expect(acrescentar.message).toBe("green_canonical_immutable");

    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [e] = await eventosDe(lead);
    const retirar = await recusa(
      request(
        { papel: "service_role" },
        "update event_log set metadata = metadata - 'green_canonical' where id=$1",
        [e!.id],
      ),
    );
    expect(retirar.message).toBe("green_canonical_immutable");
    // o drain continua mexendo no que é dele (status/consumed_by), sem tocar no metadata
    await request(
      { papel: "service_role" },
      "update event_log set status='done', consumed_by=array['x'] where id=$1",
      [e!.id],
    );
  });
});

describe("S16 — service_origin.kind=event tem de ser do contato REAL do evento", () => {
  const automacao = (eventId: string, contato: string): Request => ({
    papel: "service_role",
    contexto: {
      v: 1,
      source: "automation",
      request_id: `rule:${REGRA}`,
      causation_event_id: eventId,
      actor: { kind: "webhook_source", id: REGRA },
      service_origin: {
        kind: "event",
        event_id: eventId,
        organization_id: ORG,
        contact_id: contato,
      },
    },
  });

  it("evento E do contato A declarado como do contato B (mesma org) é recusado; a régua canônica concorda", async () => {
    // E pertence ao contato A: é o lead.stage_changed canônico do lead do CONTATO
    const leadA = await novoLead(FUNIL_GREEN, ETAPA_A, CONTATO);
    await mover(leadA, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    const [E] = await eventosDe(leadA);
    // o lead escrito é do contato B e o contexto declara contato B — só o evento é de A
    const leadB = await novoLead(FUNIL_GREEN, ETAPA_A, CONTATO_2);
    const erro = await recusa(mover(leadB, ETAPA_B, automacao(E!.id, CONTATO_2)));
    expect(erro.code).toBe("23503");
    expect(erro.message).toBe("green_service_origin_contact_mismatch");
    expect(await etapaDe(leadB)).toBe(ETAPA_A);
    expect(await eventosDe(leadB)).toHaveLength(0);

    // a função canônica do Deskcomm (`fn_service_event_origin`) dá o MESMO veredito de escopo
    const canonico = await recusa(
      pool.query("select public.fn_service_event_origin($1,$2,$3)", [ORG, E!.id, CONTATO_2]),
    );
    expect(canonico.code).toBe("23503");
    expect(canonico.message).toBe("service_scope_mismatch");

    // controle positivo: o mesmo evento, para um lead do contato A, passa
    await mover(leadA, ETAPA_C, automacao(E!.id, CONTATO));
    expect(await etapaDe(leadA)).toBe(ETAPA_C);
    expect((await eventosDe(leadA)).at(-1)!.payload.service_origin).toEqual({
      kind: "event",
      event_id: E!.id,
      organization_id: ORG,
      contact_id: CONTATO,
    });
  });

  it("contact.tag_added, cadeia de origem, tipo sem âncora e evento inexistente seguem a régua canônica", async () => {
    const leadB = await novoLead(FUNIL_GREEN, ETAPA_A, CONTATO_2);
    const evento = async (tipo: string, entidade: string, id: string, payload: object = {}) =>
      (
        await pool.query<{ id: string }>(
          "insert into event_log (organization_id, event_type, entity_kind, entity_id, payload) values ($1,$2,$3,$4,$5::jsonb) returning id",
          [ORG, tipo, entidade, id, JSON.stringify(payload)],
        )
      ).rows[0]!.id;

    // tag no contato A → não ancora o contato B; tag no contato B → ancora
    const tagDeA = await evento("contact.tag_added", "contact", CONTATO);
    expect((await recusa(mover(leadB, ETAPA_B, automacao(tagDeA, CONTATO_2)))).message).toBe(
      "green_service_origin_contact_mismatch",
    );
    const tagDeB = await evento("contact.tag_added", "contact", CONTATO_2);
    await mover(leadB, ETAPA_B, automacao(tagDeB, CONTATO_2));
    expect(await etapaDe(leadB)).toBe(ETAPA_B);

    // cadeia: evento do contato B cuja PRÓPRIA origem aponta para um evento do contato A
    const encadeado = await evento("contact.tag_added", "contact", CONTATO_2, {
      service_origin: {
        kind: "event",
        event_id: tagDeA,
        organization_id: ORG,
        contact_id: CONTATO_2,
      },
    });
    expect((await recusa(mover(leadB, ETAPA_C, automacao(encadeado, CONTATO_2)))).message).toBe(
      "green_service_origin_contact_mismatch",
    );
    const canonicoCadeia = await recusa(
      pool.query("select public.fn_service_event_origin($1,$2,$3)", [ORG, encadeado, CONTATO_2]),
    );
    expect(canonicoCadeia.message).toBe("service_scope_mismatch");

    // tipo que a régua canônica não ancora → recusa explícita, nunca aceite silencioso
    const semAncora = await evento("lead.updated", "crm_lead", leadB);
    expect((await recusa(mover(leadB, ETAPA_C, automacao(semAncora, CONTATO_2)))).message).toBe(
      "green_service_origin_unsupported",
    );
    const canonicoSemAncora = await recusa(
      pool.query("select public.fn_service_event_origin($1,$2,$3)", [ORG, semAncora, CONTATO_2]),
    );
    expect(canonicoSemAncora.message).toBe("service_event_origin_unsupported");

    // evento inexistente
    expect((await recusa(mover(leadB, ETAPA_C, automacao(randomUUID(), CONTATO_2)))).message).toBe(
      "green_service_origin_event_not_found",
    );
    expect(await etapaDe(leadB)).toBe(ETAPA_B);
  });

  it("catraca: a projeção Green ancora EXATAMENTE os tipos que a função canônica ancora", async () => {
    const { rows } = await pool.query<{ canonica: string; green: string }>(
      "select pg_get_functiondef('public.fn_service_event_origin(uuid,uuid,uuid,uuid)'::regprocedure) canonica, pg_get_functiondef('green.fn_assert_event_origin_contact(uuid,uuid,uuid)'::regprocedure) green",
    );
    const pares = (sql: string) => {
      const out = new Set<string>();
      const re =
        /e\.event_type\s*(?:in\s*\(([^)]*)\)|=\s*'([^']+)')\s*and\s*e\.entity_kind\s*=\s*'([^']+)'/gi;
      for (const m of sql.matchAll(re)) {
        const tipos = m[1] ? [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]!) : [m[2]!];
        for (const t of tipos) out.add(`${t}@${m[3]}`);
      }
      return [...out].sort();
    };
    const canonica = pares(rows[0]!.canonica);
    expect(canonica.length).toBeGreaterThanOrEqual(4);
    expect(pares(rows[0]!.green)).toEqual(canonica);
  });
});

describe("S17 — oracle cross-tenant fechado", () => {
  const FUNIL_OUTRA = randomUUID();
  const ETAPA_OUTRA = randomUUID();
  beforeAll(async () => {
    await pool.query(
      `insert into crm_pipelines (id, organization_id, name, slug) values ($1,$2,'Green B','green-b-${FUNIL_OUTRA.slice(0, 8)}')`,
      [FUNIL_OUTRA, OUTRA_ORG],
    );
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,'A','etapa-a',1000)",
      [ETAPA_OUTRA, OUTRA_ORG, FUNIL_OUTRA],
    );
    await pool.query(
      "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
      [OUTRA_ORG, FUNIL_OUTRA],
    );
  });

  it("tenant A não consulta o binding de B — nem o próprio: os helpers não são API de authenticated", async () => {
    const humano: Request = { papel: "authenticated", sub: GERENTE };
    const sondas: [string, unknown[]][] = [
      ["select green.fn_is_green_pipeline($1,$2)", [OUTRA_ORG, FUNIL_OUTRA]],
      ["select green.fn_is_green_pipeline($1,$2)", [ORG, FUNIL_GREEN]],
      ["select green.fn_mutation_context()", []],
      ["select green.fn_assert_service_origin('{}'::jsonb,$1,$2)", [OUTRA_ORG, CONTATO]],
      ["select green.fn_assert_event_origin_contact($1,$2,$3)", [OUTRA_ORG, randomUUID(), CONTATO]],
      ["select count(*) from green.product_pipeline_binding", []],
      ["select count(*) from green.stage_event_ledger", []],
    ];
    for (const [sql, args] of sondas) {
      const erro = await recusa(request(humano, sql, args));
      expect(erro.code, sql).toBe("42501");
    }
  });

  it("anon permanece sem acesso", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      const erro = await recusa(
        client.query("select green.fn_is_green_pipeline($1,$2)", [OUTRA_ORG, FUNIL_OUTRA]),
      );
      expect(erro.code).toBe("42501");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("os triggers do tenant A continuam funcionando, e o service_role legítimo continua consultando", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, { papel: "authenticated", sub: GERENTE });
    expect(await eventosDe(lead)).toHaveLength(1);
    const { rows } = await request<{ g: boolean; b: boolean; c: boolean }>(
      { papel: "service_role" },
      "select green.fn_is_green_pipeline($1,$2) g, green.fn_is_green_pipeline($3,$4) b, green.fn_is_green_pipeline($1,$5) c",
      [ORG, FUNIL_GREEN, OUTRA_ORG, FUNIL_OUTRA, FUNIL_COMUM],
    );
    expect(rows[0]).toEqual({ g: true, b: true, c: false });
  });
});

describe("S23 — supressor v2: só o gêmeo da mutação canonizada some", () => {
  const humano: Request = { papel: "authenticated", sub: GERENTE };
  const comRequest = (requestId: string): Request => ({
    ...humano,
    contexto: { v: 1, source: "http_session", request_id: requestId },
  });

  // CONTRATO GREEN-03 (0508): o supressor temporal saiu. O gêmeo é reconhecido pelo ESCOPO de
  // execução do servidor (`x-green-scope-id`), e um relato SEM escopo de lead Green não é fato
  // nenhum — nem gêmeo nem "segundo evento". Estes casos mandam o legado sem escopo (transporte
  // antigo / PostgREST direto); o livro-razão não registra mais o gêmeo (`legacy_*` é histórico).
  // O "evento legítimo que não pode ser engolido" agora é o relato de OUTRO escopo, provado em
  // `green-canonical-event-cutover.test.ts` (S1, S4, S13), com o gêmeo por escopo (S2-S8).
  it("o gêmeo legado some (e fica registrado no livro-razão); um segundo lead.stage_changed igual NÃO é engolido", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const requestId = randomUUID();
    await mover(lead, ETAPA_B, comRequest(requestId));
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B },
      { request_id: requestId, actor_user_id: GERENTE },
    );
    expect(await eventosDe(lead)).toHaveLength(1);
    const [linha] = await livroDe(lead);
    // CONTRATO GREEN-03: o livro-razão não guarda mais o gêmeo (era `not.toBeNull()` / `requestId`)
    expect(linha!.legacy_suppressed_at).toBeNull();
    expect(linha!.legacy_request_id).toBeNull();

    // CONTRATO GREEN-03: um segundo relato sem escopo também não nasce (era: passa, 2 eventos)
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B },
      { request_id: randomUUID() },
    );
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.metadata).toHaveProperty("green_canonical");
  });

  // CONTRATO GREEN-03: em lead Green, reordenação não é fato de etapa e relato sem escopo de uma
  // transição que nenhum UPDATE fez não é fato (eram 2 eventos; agora 0). Lead comum segue o
  // upstream (`green-canonical-event-cutover.test.ts`, COM-1 e S11).
  it("reordenação (mesma etapa) e transição nunca canonizada passam como no upstream", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    // reordenar: o UPDATE não muda a etapa, não há canônico — o evento da rota nasce
    await request(humano, "update crm_leads set position_in_stage=42 where id=$1", [lead]);
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_A, to_stage_id: ETAPA_A, position_in_stage: 42 },
      { request_id: randomUUID() },
    );
    // transição que nenhum UPDATE fez
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_B, to_stage_id: ETAPA_C },
      { request_id: randomUUID() },
    );
    const eventos = await eventosDe(lead);
    expect(eventos).toHaveLength(0);
    expect(await livroDe(lead)).toHaveLength(0);
  });

  // CONTRATO GREEN-03: sem janela, o gêmeo atrasado não vira segundo fato (eram 2 eventos). Era o
  // defeito S3 medido na 0507.
  it("o gêmeo atrasado além da janela passa (não há mais o que deduplicar)", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    await mover(lead, ETAPA_B, humano);
    await pool.query(
      "update green.stage_event_ledger set created_at = now() - interval '10 minutes' where lead_id=$1",
      [lead],
    );
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B },
      { request_id: randomUUID() },
    );
    expect(await eventosDe(lead)).toHaveLength(1);
  });

  // CONTRATO v3 (AUDIT-08.2, ADV-04 / GAP-SUPPRESSOR-V3): o v2 afirmava que o
  // `request_id` do header de uma sessão HUMANA escolhia a linha do livro-razão.
  // Esse valor é advisory (o caller o escolhe) e deixou de decidir: mutação humana
  // não tem request_id confiável, o gêmeo casa por (lead, transição, janela) com a
  // mais recente ainda sem gêmeo. A contagem — o que o supressor protege — é a
  // mesma. O desempate por request_id CONFIÁVEL (writer privilegiado) é provado
  // em `green-mutation-context-v3.test.ts`.
  it("gêmeos de mutações HUMANAS repetidas: o request_id do header não escolhe linha; casa a mais recente sem gêmeo", async () => {
    const lead = await novoLead(FUNIL_GREEN, ETAPA_A);
    const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()];
    await mover(lead, ETAPA_B, comRequest(r1));
    await mover(lead, ETAPA_A, comRequest(r2));
    await mover(lead, ETAPA_B, comRequest(r3));
    const { rows: livro0 } = await pool.query<{ id: string; advisory_request_id: string }>(
      "select id, advisory_request_id from green.stage_event_ledger where lead_id=$1 order by created_at, id",
      [lead],
    );
    expect(livro0.map((l) => l.advisory_request_id)).toEqual([r1, r2, r3]);
    expect((await livroDe(lead)).every((l) => l.request_id === null)).toBe(true);
    // o gêmeo do PRIMEIRO A→B chega depois do terceiro
    await emitComo(
      humano,
      lead,
      { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B },
      { request_id: r1 },
    );
    // CONTRATO GREEN-03: não há mais "casar a linha mais recente" — o livro-razão não registra o
    // gêmeo (eram as asserções de `legacy_request_id`/`legacy_suppressed_at` por linha). O que o
    // supressor protegia, a contagem, continua: 3 mutações, 3 fatos.
    await emitComo(humano, lead, { from_stage_id: ETAPA_A, to_stage_id: ETAPA_B }, {});
    const livro = await livroDe(lead);
    expect(livro.every((l) => l.legacy_suppressed_at === null)).toBe(true);
    expect(await eventosDe(lead)).toHaveLength(3);
  });
});
