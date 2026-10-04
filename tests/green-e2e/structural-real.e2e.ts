/**
 * SPIKE-GREEN-02 (descartável) — Structural Boundary pelo PostgREST REAL e pelo SERVIDOR NEXT REAL.
 *
 *   P  PostgREST direto (JWT de sessão real do GoTrue, ou service_role): os ataques estruturais
 *      que nenhum writer do app faz, mas que a API expõe; e os embeds por nome de FK, que a 0507
 *      troca por FKs compostas com o mesmo nome.
 *   N  servidor Next real: os fluxos estruturais que EXISTEM por rota (arquivar etapa com
 *      destino, excluir funil de vez, editar etapa, ler funis e o resumo de CRM do contato).
 *
 * Este arquivo NÃO importa código do app: tudo passa por HTTP. O `pg` direto só monta fixtures e
 * lê o resultado.
 *
 * ─── Como rodar (só ambiente local; nenhuma credencial no Git) ──────────────
 *   variáveis lidas do stack por tooling (nunca coladas à mão): GREEN_E2E_SUPABASE_URL,
 *   GREEN_E2E_ANON_KEY, GREEN_E2E_SERVICE_ROLE_KEY, GREEN_E2E_DB_URL, GREEN_E2E_NEXT_URL;
 *   `vitest run -c vitest.green-e2e.config.ts tests/green-e2e/structural-real.e2e.ts`.
 *   Sem as variáveis a suíte se declara pulada (nunca "verde por omissão").
 */
import { randomBytes, randomUUID } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STACK = {
  url: process.env.GREEN_E2E_SUPABASE_URL ?? "",
  anon: process.env.GREEN_E2E_ANON_KEY ?? "",
  service: process.env.GREEN_E2E_SERVICE_ROLE_KEY ?? "",
  db: process.env.GREEN_E2E_DB_URL ?? "",
  next: process.env.GREEN_E2E_NEXT_URL ?? "",
};
const TEM_STACK = Boolean(STACK.url && STACK.anon && STACK.service && STACK.db && STACK.next);

const ORG = randomUUID();
const ORG_B = randomUUID();
const sufixo = ORG.slice(0, 8);
const FUNIL = {
  GREEN: randomUUID(),
  GREEN_VAZIO: randomUUID(),
  COMUM: randomUUID(),
  B_GREEN: randomUUID(),
  B_COMUM: randomUUID(),
};
const ETAPA = {
  G1: randomUUID(),
  G2: randomUUID(),
  G3: randomUUID(),
  V1: randomUUID(),
  C1: randomUUID(),
  C2: randomUUID(),
  C3: randomUUID(),
  BG1: randomUUID(),
  BC1: randomUUID(),
};
const CONTATO = randomUUID();

interface Pessoa {
  id: string;
  jwt: string;
  cookie: string;
}
let ADMIN: Pessoa; // admin da ORG
let DUPLO: Pessoa; // admin da ORG e da ORG_B

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://x@127.0.0.1:1/x", max: 4 });

async function novosLeads(funil: string, etapa: string, n: number): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "e2e_fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await client.query<{ id: string }>(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id)
         select $1,$2,$3,'Estrutura E2E '||g,$4 from generate_series(1,$5::int) g returning id`,
      [ORG, funil, etapa, CONTATO, n],
    );
    await client.query("commit");
    return rows.map((r) => r.id);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function pessoa(orgs: string[], papel: string): Promise<Pessoa> {
  const email = `green-st-${randomUUID().slice(0, 8)}@spike.test`;
  const senha = `e2e-${randomBytes(12).toString("hex")}`;
  const r = await fetch(`${STACK.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: STACK.service,
      authorization: `Bearer ${STACK.service}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: senha, email_confirm: true }),
  });
  if (!r.ok) throw new Error(`GoTrue admin: ${r.status}`);
  const id = ((await r.json()) as { id: string }).id;
  for (const org of orgs)
    await pool.query(
      "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
      [id, org, papel],
    );
  const anon = createClient(STACK.url, STACK.anon, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) throw error ?? new Error("sem sessão");
  const gerados = new Map<string, string>();
  const ssr = createServerClient(STACK.url, STACK.anon, {
    cookies: {
      getAll: () => [...gerados].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => gerados.set(name, value)),
    },
    cookieOptions: { name: "sb-deskcomm-auth", sameSite: "strict", path: "/" },
  });
  const set = await ssr.auth.setSession(data.session);
  if (set.error) throw set.error;
  return {
    id,
    jwt: data.session.access_token,
    cookie: [...gerados].map(([n, v]) => `${n}=${v}`).join("; "),
  };
}

function next(
  caminho: string,
  init: { method?: string; body?: unknown; quem: Pessoa },
): Promise<Response> {
  return fetch(`${STACK.next}${caminho}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: STACK.next,
      cookie: init.quem.cookie,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Requisição DIRETA ao PostgREST: sessão de usuário (JWT) ou service_role. */
function rest(
  caminho: string,
  init: { method: string; body?: unknown; jwt: string; apikey?: string },
): Promise<Response> {
  return fetch(`${STACK.url}/rest/v1/${caminho}`, {
    method: init.method,
    headers: {
      apikey: init.apikey ?? STACK.anon,
      authorization: `Bearer ${init.jwt}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const comoServico = (caminho: string, init: { method: string; body?: unknown }) =>
  rest(caminho, { ...init, jwt: STACK.service, apikey: STACK.service });

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Status + corpo do PostgREST, com os UUIDs que o próprio atacante mandou normalizados. */
const resposta = async (r: Response) =>
  `${r.status} ${(await r.text()).replace(UUID_RE, "<uuid>")}`;

const etapa = async (id: string) =>
  (
    await pool.query(
      "select organization_id, pipeline_id, is_archived, name from crm_stages where id=$1",
      [id],
    )
  ).rows[0] as
    | { organization_id: string; pipeline_id: string; is_archived: boolean; name: string }
    | undefined;
const funilOrg = async (id: string) =>
  (await pool.query("select organization_id from crm_pipelines where id=$1", [id])).rows[0]
    ?.organization_id as string | undefined;

/** As estruturas impossíveis do contrato nas duas orgs do teste (vazio = íntegra). */
async function impossiveis(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select (
        (select count(*) from crm_leads l
          where l.organization_id = any($1::uuid[])
            and green.fn_lead_touches_green(l.organization_id, l.pipeline_id, l.stage_id)
            and (not exists (select 1 from crm_stages s where s.id = l.stage_id
                               and s.pipeline_id = l.pipeline_id and s.organization_id = l.organization_id)
                 or not exists (select 1 from green.lead_identity i where i.lead_id = l.id and i.state = 'live')))
      + (select count(*) from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
          where (s.organization_id = any($1::uuid[]) or p.organization_id = any($1::uuid[]))
            and p.organization_id <> s.organization_id)
      + (select count(*) from crm_leads l join crm_stages s on s.id = l.stage_id
          where l.organization_id = any($1::uuid[]) and s.organization_id <> l.organization_id)
     )::text n`,
    [[ORG, ORG_B]],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!TEM_STACK) return;
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Estrutura E2E','Estrutura E2E'),($3,$4,'Estrutura B','Estrutura B')",
    [ORG, `green-st-${sufixo}`, ORG_B, `green-st-b-${sufixo}`],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name) values ($1,$2,'Estrutura E2E')",
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1,$6,'Green','green-${sufixo}'), ($2,$6,'Green vazio','green-vazio-${sufixo}'),
       ($3,$6,'Comum','comum-${sufixo}'), ($4,$7,'Green B','green-b-${sufixo}'),
       ($5,$7,'Comum B','comum-b-${sufixo}')`,
    [FUNIL.GREEN, FUNIL.GREEN_VAZIO, FUNIL.COMUM, FUNIL.B_GREEN, FUNIL.B_COMUM, ORG, ORG_B],
  );
  const etapas: [string, string, string, string, number][] = [
    [ETAPA.G1, ORG, FUNIL.GREEN, "g1", 1000],
    [ETAPA.G2, ORG, FUNIL.GREEN, "g2", 2000],
    [ETAPA.G3, ORG, FUNIL.GREEN, "g3", 3000],
    [ETAPA.V1, ORG, FUNIL.GREEN_VAZIO, "v1", 1000],
    [ETAPA.C1, ORG, FUNIL.COMUM, "c1", 1000],
    [ETAPA.C2, ORG, FUNIL.COMUM, "c2", 2000],
    [ETAPA.C3, ORG, FUNIL.COMUM, "c3", 3000],
    [ETAPA.BG1, ORG_B, FUNIL.B_GREEN, "bg1", 1000],
    [ETAPA.BC1, ORG_B, FUNIL.B_COMUM, "bc1", 1000],
  ];
  for (const [id, org, funil, slug, pos] of etapas)
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ($1,$2,$3,$4,$4,$5)",
      [id, org, funil, slug, pos],
    );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia'),($1,$3,'energia'),($4,$5,'energia')",
    [ORG, FUNIL.GREEN, FUNIL.GREEN_VAZIO, ORG_B, FUNIL.B_GREEN],
  );
  ADMIN = await pessoa([ORG], "admin");
  DUPLO = await pessoa([ORG, ORG_B], "admin");
  await new Promise((r) => setTimeout(r, 3000)); // PGRST303 "JWT issued at future" logo após o login
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!TEM_STACK)("Structural Boundary — PostgREST real", () => {
  it("P1 — manager move etapa Green com leads para funil comum: 400 green_stage_relocation_forbidden, nada muda", async () => {
    await novosLeads(FUNIL.GREEN, ETAPA.G3, 2);
    const r = await rest(`crm_stages?id=eq.${ETAPA.G3}`, {
      method: "PATCH",
      body: { pipeline_id: FUNIL.COMUM },
      jwt: ADMIN.jwt,
    });
    const corpo = await resposta(r);
    expect(corpo).toMatch(/^400 .*"code":"23514".*green_stage_relocation_forbidden/);
    expect((await etapa(ETAPA.G3))?.pipeline_id).toBe(FUNIL.GREEN);
    expect(await impossiveis()).toBe(0);
  });

  it("P2 — manager move etapa comum com leads para funil Green: recusado, leads não entram no Green", async () => {
    await novosLeads(FUNIL.COMUM, ETAPA.C3, 2);
    const r = await rest(`crm_stages?id=eq.${ETAPA.C3}`, {
      method: "PATCH",
      body: { pipeline_id: FUNIL.GREEN },
      jwt: ADMIN.jwt,
    });
    expect(await resposta(r)).toMatch(/^400 .*green_stage_relocation_forbidden/);
    expect((await etapa(ETAPA.C3))?.pipeline_id).toBe(FUNIL.COMUM);
    expect(await impossiveis()).toBe(0);
  });

  it("P3 — admin das duas orgs leva o funil Green para a outra org: 400 green_structure_tenant_immutable", async () => {
    const r = await rest(`crm_pipelines?id=eq.${FUNIL.GREEN}`, {
      method: "PATCH",
      body: { organization_id: ORG_B },
      jwt: DUPLO.jwt,
    });
    expect(await resposta(r)).toMatch(/^400 .*green_structure_tenant_immutable/);
    expect(await funilOrg(FUNIL.GREEN)).toBe(ORG);
  });

  it("P4 — service_role pelo PostgREST: realocação Green e troca de tenant recusadas", async () => {
    const a = await comoServico(`crm_stages?id=eq.${ETAPA.G2}`, {
      method: "PATCH",
      body: { pipeline_id: FUNIL.COMUM },
    });
    expect(await resposta(a)).toMatch(/^400 .*green_stage_relocation_forbidden/);
    const b = await comoServico(`crm_stages?id=eq.${ETAPA.C2}`, {
      method: "PATCH",
      body: { organization_id: ORG_B, pipeline_id: FUNIL.B_COMUM },
    });
    expect(await resposta(b)).toMatch(/^400 .*green_structure_tenant_immutable/);
    expect(await impossiveis()).toBe(0);
  });

  it("P5 — etapa da ORG dentro de funil da ORG_B: Green ≡ comum ≡ inexistente (mesmo status e corpo)", async () => {
    const sonda = (funil: string) =>
      rest("crm_stages", {
        method: "POST",
        body: {
          organization_id: ORG,
          pipeline_id: funil,
          name: "Sonda",
          slug: `sonda-${randomUUID().slice(0, 8)}`,
          position: 1,
        },
        jwt: ADMIN.jwt,
      }).then(resposta);
    const [g, c, n] = [
      await sonda(FUNIL.B_GREEN),
      await sonda(FUNIL.B_COMUM),
      await sonda(randomUUID()),
    ];
    expect(g).toMatch(/^409 .*"code":"23503"/);
    expect(g).toBe(c);
    expect(g).toBe(n);
    expect(g).not.toContain("green_");
  });

  it("P6 — lead da ORG usando funil/etapa da ORG_B: Green ≡ comum ≡ inexistente", async () => {
    const sonda = (funil: string, etp: string) =>
      rest("crm_leads", {
        method: "POST",
        body: { organization_id: ORG, pipeline_id: funil, stage_id: etp, title: "Sonda" },
        jwt: ADMIN.jwt,
      }).then(resposta);
    const [g, c, n] = [
      await sonda(FUNIL.B_GREEN, ETAPA.BG1),
      await sonda(FUNIL.B_COMUM, ETAPA.BC1),
      await sonda(randomUUID(), randomUUID()),
    ];
    expect(g).toMatch(/^409 .*"code":"23503"/);
    expect(g).toBe(c);
    expect(g).toBe(n);
    expect(await impossiveis()).toBe(0);
  });

  it("P7 — embeds por nome de FK seguem funcionando sobre as FKs compostas", async () => {
    const [lead] = await novosLeads(FUNIL.GREEN, ETAPA.G1, 1);
    const r = await fetch(
      `${STACK.url}/rest/v1/crm_leads?select=id,crm_stages!crm_leads_stage_id_fkey(name),crm_pipelines!inner(name,etapas:crm_stages!crm_stages_pipeline_id_fkey(id))&id=eq.${lead}`,
      { headers: { apikey: STACK.anon, authorization: `Bearer ${ADMIN.jwt}` } },
    );
    expect(r.status).toBe(200);
    const [linha] = (await r.json()) as {
      id: string;
      crm_stages: { name: string };
      crm_pipelines: { name: string; etapas: { id: string }[] };
    }[];
    expect(linha?.crm_stages.name).toBe("g1");
    expect(linha?.crm_pipelines.name).toBe("Green");
    expect(linha?.crm_pipelines.etapas.map((e) => e.id).sort()).toEqual(
      [ETAPA.G1, ETAPA.G2, ETAPA.G3].sort(),
    );
    // sem dica: continua havendo UMA relação funil ↔ etapas
    const s = await fetch(
      `${STACK.url}/rest/v1/crm_pipelines?select=id,crm_stages(id)&id=eq.${FUNIL.COMUM}`,
      { headers: { apikey: STACK.anon, authorization: `Bearer ${ADMIN.jwt}` } },
    );
    expect(s.status).toBe(200);
    expect(((await s.json()) as { crm_stages: unknown[] }[])[0]?.crm_stages).toHaveLength(3);
  });
});

describe.skipIf(!TEM_STACK)("Structural Boundary — servidor Next real", () => {
  it("N1 — arquivar etapa Green com destino (rota real): leads movidos pela fronteira, um canônico por card, etapa arquivada", async () => {
    const leads = await novosLeads(FUNIL.GREEN, ETAPA.G1, 3);
    const r = await next(
      `/api/v1/pipelines/${FUNIL.GREEN}/stages/${ETAPA.G1}?destino=${ETAPA.G2}`,
      {
        method: "DELETE",
        quem: ADMIN,
      },
    );
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await etapa(ETAPA.G1))?.is_archived).toBe(true);
    const { rows } = await pool.query(
      `select l.id, l.stage_id,
              (select count(*) from event_log e
                where e.entity_id = l.id and e.event_type = 'lead.stage_changed'
                  and e.metadata->>'green_canonical' = 'true'
                  and e.metadata->'actor'->>'id' = $2)::int canonicos,
              (select count(*) from event_log e
                where e.entity_id = l.id and e.event_type = 'lead.stage_changed')::int todos
         from crm_leads l where l.id = any($1::uuid[])`,
      [leads, ADMIN.id],
    );
    expect(rows).toHaveLength(3);
    // um canônico por card, com o ator da sessão; nenhum legado ao lado
    for (const l of rows) expect(l).toMatchObject({ stage_id: ETAPA.G2, canonicos: 1, todos: 1 });
    expect(await impossiveis()).toBe(0);
  });

  it("N2 — editar etapa pela rota não realoca de funil (o corpo não carrega pipeline_id)", async () => {
    const r = await next(`/api/v1/pipelines/${FUNIL.GREEN}/stages/${ETAPA.G3}`, {
      method: "PATCH",
      body: { name: "Renomeada", pipeline_id: FUNIL.COMUM },
      quem: ADMIN,
    });
    expect([200, 422]).toContain(r.status);
    expect((await etapa(ETAPA.G3))?.pipeline_id).toBe(FUNIL.GREEN);
  });

  it("N3 — excluir de vez o funil Green VAZIO (rota real): cascata leva etapa e binding; auditoria com 0 leads soltos", async () => {
    const r = await next(`/api/v1/pipelines/${FUNIL.GREEN_VAZIO}?definitivo=1`, {
      method: "DELETE",
      quem: ADMIN,
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await etapa(ETAPA.V1)).toBeUndefined();
    const { rows } = await pool.query(
      "select metadata from api_audit_log where action='green.binding_removed' and resource_id=$1",
      [FUNIL.GREEN_VAZIO],
    );
    expect(rows[0]?.metadata).toMatchObject({
      released_leads: 0,
      operation: "delete",
      caller: "user",
    });
  });

  it("N4 — leitura dos funis e resumo de CRM do contato (embeds por nome de FK) pela rota real", async () => {
    const f = await next("/api/v1/pipelines", { quem: ADMIN });
    expect(f.status, await f.clone().text()).toBe(200);
    expect(JSON.stringify(await f.json())).toContain(FUNIL.GREEN); // a listagem não embute etapas
    const s = await next(`/api/v1/contacts/${CONTATO}/crm-summary`, { quem: ADMIN });
    expect(s.status, await s.clone().text()).toBe(200);
    expect(JSON.stringify(await s.json())).toContain("g2");
  });

  it("N5 — controle comum: arquivar etapa comum com destino move os leads sem canônico Green", async () => {
    const leads = await novosLeads(FUNIL.COMUM, ETAPA.C1, 2);
    const r = await next(
      `/api/v1/pipelines/${FUNIL.COMUM}/stages/${ETAPA.C1}?destino=${ETAPA.C2}`,
      {
        method: "DELETE",
        quem: ADMIN,
      },
    );
    expect(r.status, await r.clone().text()).toBe(200);
    const { rows } = await pool.query(
      `select count(*)::int n from event_log
        where entity_id = any($1::uuid[]) and metadata->>'green_canonical' = 'true'`,
      [leads],
    );
    expect(rows[0]!.n).toBe(0);
    expect(
      (
        await pool.query(
          "select count(*)::int n from crm_leads where id = any($1::uuid[]) and stage_id=$2",
          [leads, ETAPA.C2],
        )
      ).rows[0]!.n,
    ).toBe(2);
    expect(await impossiveis()).toBe(0);
  });
});
