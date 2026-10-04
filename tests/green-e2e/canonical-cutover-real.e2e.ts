/**
 * SPIKE-GREEN-03 (descartável) — Canonical Event Cutover pelo SERVIDOR NEXT REAL e pelo POSTGREST REAL.
 *
 *   C  servidor Next real (Node 22): as rotas humanas que movem etapa (Kanban, lote, ganhar,
 *      perder, clonar, arquivar etapa), a automação drenada pelo tick real, e concorrência.
 *      Cada uma: quantos fatos de etapa nasceram (canônico × legado), o livro-razão, e o lead
 *      comum como controle.
 *   P  PostgREST direto: PATCH de sessão e `rpc/emit_event` com e sem escopo.
 *
 * Este arquivo NÃO importa código do app: tudo passa por HTTP. O `pg` direto só monta fixtures e
 * lê o resultado. Mesmo arquivo contra a base (servidor + banco 0507) e a spike (0508).
 *
 * ─── Como rodar (só ambiente local; nenhuma credencial no Git) ──────────────
 *   GREEN_E2E_SUPABASE_URL, GREEN_E2E_ANON_KEY, GREEN_E2E_SERVICE_ROLE_KEY, GREEN_E2E_DB_URL,
 *   GREEN_E2E_NEXT_URL lidas do stack por tooling; `vitest run -c vitest.green-e2e.config.ts
 *   tests/green-e2e/canonical-cutover-real.e2e.ts`. Sem as variáveis a suíte se declara pulada.
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
const sufixo = ORG.slice(0, 8);
const FUNIL = { GREEN: randomUUID(), COMUM: randomUUID() };
const ETAPA = {
  G1: randomUUID(),
  G2: randomUUID(),
  G3: randomUUID(),
  G4: randomUUID(), // arquivada no C7
  GW: randomUUID(),
  GL: randomUUID(),
  C1: randomUUID(),
  C2: randomUUID(),
  CW: randomUUID(),
  CL: randomUUID(),
};
const CONTATO = randomUUID();
const REGRA = randomUUID();

interface Pessoa {
  id: string;
  jwt: string;
  cookie: string;
}
let ADMIN: Pessoa;

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://x@127.0.0.1:1/x", max: 6 });

async function novosLeads(funil: string, etapa: string, n: number): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "e2e_fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await client.query<{ id: string }>(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id)
         select $1,$2,$3,'Cutover E2E '||g,$4 from generate_series(1,$5::int) g returning id`,
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

async function pessoa(papel: string): Promise<Pessoa> {
  const email = `green-co-${randomUUID().slice(0, 8)}@spike.test`;
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
  await pool.query(
    "insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3,now())",
    [id, ORG, papel],
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
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", origin: STACK.next, cookie: init.quem.cookie },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** `rpc/emit_event` direto no PostgREST com a sessão de usuário, com ou sem o header de escopo. */
async function emitirDireto(lead: string, payload: Record<string, unknown>, escopo?: string) {
  const r = await fetch(`${STACK.url}/rest/v1/rpc/emit_event`, {
    method: "POST",
    headers: {
      apikey: STACK.anon,
      authorization: `Bearer ${ADMIN.jwt}`,
      "content-type": "application/json",
      ...(escopo ? { "x-green-scope-id": escopo } : {}),
    },
    body: JSON.stringify({
      p_event_type: "lead.stage_changed",
      p_entity_kind: "crm_lead",
      p_entity_id: lead,
      p_payload: payload,
      p_metadata: { source: "e2e-direto" },
      p_organization_id: ORG,
    }),
  });
  return { status: r.status, id: (await r.json()) as string | null };
}

const leadDe = async (id: string) =>
  (
    await pool.query(
      `select pipeline_id, stage_id, status,
              to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') updated_at
         from crm_leads where id=$1`,
      [id],
    )
  ).rows[0] as
    { pipeline_id: string; stage_id: string; status: string; updated_at: string } | undefined;

interface Fato {
  id: string;
  event_type: string;
  status: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & { green?: { trusted?: Record<string, unknown> } };
  canonico: boolean;
}
async function fatos(lead: string): Promise<Fato[]> {
  const { rows } = await pool.query<Fato>(
    `select id, event_type, status, payload, metadata,
            coalesce(metadata->>'green_canonical','') = 'true' canonico
       from event_log where entity_id=$1 and entity_kind in ('crm_lead','lead') order by created_at, id`,
    [lead],
  );
  return rows;
}
const deEtapa = async (lead: string) =>
  (await fatos(lead)).filter((f) => f.event_type === "lead.stage_changed");
async function livro(lead: string) {
  const { rows } = await pool.query<{ l: Record<string, unknown> }>(
    "select to_jsonb(l) l from green.stage_event_ledger l where lead_id=$1 order by created_at, id",
    [lead],
  );
  return rows.map((r) => r.l);
}
/** O que a rota do quadro grava no audit: a testemunha do `request_id` daquela requisição. */
async function requestIdDoAudit(lead: string, acao: string) {
  const { rows } = await pool.query<{ request_id: string }>(
    "select request_id from api_audit_log where resource_id=$1 and action=$2 order by created_at desc limit 1",
    [lead, acao],
  );
  return rows[0]?.request_id;
}
const resumo = async (lead: string) => {
  const fs = await deEtapa(lead);
  return {
    canonicos: fs.filter((f) => f.canonico).length,
    legados: fs.filter((f) => !f.canonico).length,
  };
};

beforeAll(async () => {
  if (!TEM_STACK) return;
  await pool.query(
    "insert into organizations (id, slug, legal_name, display_name) values ($1,$2,'Cutover E2E','Cutover E2E')",
    [ORG, `green-co-${sufixo}`],
  );
  await pool.query(
    "insert into contacts (id, organization_id, display_name) values ($1,$2,'Cutover E2E')",
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default) values
       ($1,$3,'Green','green-co-${sufixo}',false), ($2,$3,'Comum','comum-co-${sufixo}',false)`,
    [FUNIL.GREEN, FUNIL.COMUM, ORG],
  );
  await pool.query("update crm_pipelines set is_default=false where organization_id=$1", [ORG]);
  await pool.query("update crm_pipelines set is_default=true where id=$1", [FUNIL.COMUM]);
  const etapas: [string, string, string, number, boolean, boolean][] = [
    [ETAPA.G1, FUNIL.GREEN, "g1", 1000, false, false],
    [ETAPA.G2, FUNIL.GREEN, "g2", 2000, false, false],
    [ETAPA.G3, FUNIL.GREEN, "g3", 3000, false, false],
    [ETAPA.G4, FUNIL.GREEN, "g4", 4000, false, false],
    [ETAPA.GW, FUNIL.GREEN, "gw", 8000, true, false],
    [ETAPA.GL, FUNIL.GREEN, "gl", 9000, false, true],
    [ETAPA.C1, FUNIL.COMUM, "c1", 1000, false, false],
    [ETAPA.C2, FUNIL.COMUM, "c2", 2000, false, false],
    [ETAPA.CW, FUNIL.COMUM, "cw", 8000, true, false],
    [ETAPA.CL, FUNIL.COMUM, "cl", 9000, false, true],
  ];
  for (const [id, funil, slug, pos, ganho, perda] of etapas)
    await pool.query(
      "insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won, is_lost) values ($1,$2,$3,$4,$4,$5,$6,$7)",
      [id, ORG, funil, slug, pos, ganho, perda],
    );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia')",
    [ORG, FUNIL.GREEN],
  );
  ADMIN = await pessoa("admin");
  await new Promise((r) => setTimeout(r, 3000)); // PGRST303 "JWT issued at future" logo após o login
});

afterAll(async () => {
  if (TEM_STACK)
    await pool.query("update automation_rules set is_active=false where id=$1", [REGRA]);
  await pool.end();
});

describe.skipIf(!TEM_STACK)("Canonical Event Cutover — servidor Next real e PostgREST real", () => {
  const kanban = async (id: string, para: string, posicao = 1000) => {
    const atual = await leadDe(id);
    return next(`/api/v1/leads/${id}/move`, {
      quem: ADMIN,
      body: { stage_id: para, position_in_stage: posicao, expected_updated_at: atual!.updated_at },
    });
  };

  it("C1 — Kanban em lead Green: 1 canônico com a sessão, 0 legado; o livro-razão guarda o escopo da requisição", async () => {
    const [id] = await novosLeads(FUNIL.GREEN, ETAPA.G1, 1);
    expect((await kanban(id!, ETAPA.G2)).status).toBe(200);
    expect(await resumo(id!)).toEqual({ canonicos: 1, legados: 0 });
    const [c] = await deEtapa(id!);
    expect(c!.metadata.green?.trusted).toMatchObject({
      caller: "user",
      actor: { kind: "user", id: ADMIN.id },
    });
    const [linha] = await livro(id!);
    expect(linha!.legacy_suppressed_at ?? null).toBeNull();
    expect(linha!.scope_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("C2 — Kanban reordenando lead Green na mesma etapa: nenhum fato de etapa (decisão GREEN-03)", async () => {
    const [id] = await novosLeads(FUNIL.GREEN, ETAPA.G1, 1);
    expect((await kanban(id!, ETAPA.G1, 4242)).status).toBe(200);
    expect(await resumo(id!)).toEqual({ canonicos: 0, legados: 0 });
  });

  it("C3 — controle: Kanban em lead comum continua emitindo o legado da rota (mover e reordenar), sem canônico", async () => {
    const [id] = await novosLeads(FUNIL.COMUM, ETAPA.C1, 1);
    expect((await kanban(id!, ETAPA.C2)).status).toBe(200);
    const rid = await requestIdDoAudit(id!, "lead.moved");
    expect((await kanban(id!, ETAPA.C2, 4242)).status).toBe(200);
    const fs = await deEtapa(id!);
    expect(fs.map((f) => f.canonico)).toEqual([false, false]);
    expect(fs[0]!.payload).toMatchObject({ from_stage_id: ETAPA.C1, to_stage_id: ETAPA.C2 });
    expect(fs[0]!.metadata).toMatchObject({ actor_user_id: ADMIN.id });
    expect(rid).toBeTruthy();
    expect(fs[0]!.metadata.request_id).toBe(rid);
    expect(fs[0]!.metadata).not.toHaveProperty("green");
    expect(fs[1]!.payload).toMatchObject({ from_stage_id: ETAPA.C2, to_stage_id: ETAPA.C2 });
    expect(await livro(id!)).toHaveLength(0);
  });

  it("C4 — lote pela rota: N canônicos e 0 legado no Green; N legados no comum", async () => {
    const verdes = await novosLeads(FUNIL.GREEN, ETAPA.G1, 3);
    const comuns = await novosLeads(FUNIL.COMUM, ETAPA.C1, 2);
    const a = await next("/api/v1/leads/bulk", {
      quem: ADMIN,
      body: { action: "move", lead_ids: verdes, params: { stage_id: ETAPA.G3 } },
    });
    const b = await next("/api/v1/leads/bulk", {
      quem: ADMIN,
      body: { action: "move", lead_ids: comuns, params: { stage_id: ETAPA.C2 } },
    });
    expect([a.status, b.status]).toEqual([200, 200]);
    for (const id of verdes) expect(await resumo(id)).toEqual({ canonicos: 1, legados: 0 });
    for (const id of comuns) expect(await resumo(id)).toEqual({ canonicos: 0, legados: 1 });
  });

  it("C5 — ganhar e perder pela rota em lead Green: 1 canônico de etapa + `lead.won`/`lead.lost`, 0 legado", async () => {
    const [g, p] = await novosLeads(FUNIL.GREEN, ETAPA.G2, 2);
    expect((await next(`/api/v1/leads/${g}/win`, { quem: ADMIN, body: {} })).status).toBe(200);
    expect(
      (await next(`/api/v1/leads/${p}/lose`, { quem: ADMIN, body: { lost_reason: "price" } }))
        .status,
    ).toBe(200);
    expect(await resumo(g!)).toEqual({ canonicos: 1, legados: 0 });
    expect(await resumo(p!)).toEqual({ canonicos: 1, legados: 0 });
    expect((await fatos(g!)).filter((f) => f.event_type === "lead.won")).toHaveLength(1);
    expect((await fatos(p!)).filter((f) => f.event_type === "lead.lost")).toHaveLength(1);
  });

  it("C6 — clonar lead Green para o funil comum: a origem fecha com 1 canônico + `lead.lost`; o clone nasce com 1 `lead.created`", async () => {
    const [id] = await novosLeads(FUNIL.GREEN, ETAPA.G2, 1);
    const r = await next(`/api/v1/leads/${id}/clone`, {
      quem: ADMIN,
      body: { pipeline_id: FUNIL.COMUM, stage_id: ETAPA.C1 },
    });
    expect(r.status).toBe(201);
    const clone = ((await r.json()) as { data: { lead: { id: string } } }).data.lead.id;
    expect(await resumo(id!)).toEqual({ canonicos: 1, legados: 0 });
    expect((await fatos(id!)).filter((f) => f.event_type === "lead.lost")).toHaveLength(1);
    expect((await fatos(clone)).filter((f) => f.event_type === "lead.created")).toHaveLength(1);
    expect(await resumo(clone)).toEqual({ canonicos: 0, legados: 0 });
  });

  it("C7 — arquivar etapa Green com destino pela rota: 1 canônico por card, 0 legado", async () => {
    const leads = await novosLeads(FUNIL.GREEN, ETAPA.G4, 2);
    const r = await next(
      `/api/v1/pipelines/${FUNIL.GREEN}/stages/${ETAPA.G4}?destino=${ETAPA.G1}`,
      {
        method: "DELETE",
        quem: ADMIN,
      },
    );
    expect(r.status).toBe(200);
    for (const id of leads) expect(await resumo(id)).toEqual({ canonicos: 1, legados: 0 });
  });

  it("C8 — automação pelo tick real: o movimento humano dispara a regra UMA vez; o canônico da regra não reexecuta nada; 0 legado", async () => {
    const [id] = await novosLeads(FUNIL.GREEN, ETAPA.G1, 1);
    await pool.query(
      "insert into automation_rules (id, organization_id, name, trigger_event, conditions, actions, is_active) values ($1,$2,'Cutover E2E','lead.stage_changed',$3::jsonb,$4::jsonb,true)",
      [
        REGRA,
        ORG,
        JSON.stringify([{ field: "event.to_stage_id", op: "eq", value: ETAPA.G2 }]),
        JSON.stringify([
          { type: "create_or_move_lead", config: { pipeline_id: FUNIL.GREEN, stage_id: ETAPA.G3 } },
        ]),
      ],
    );
    expect((await kanban(id!, ETAPA.G2)).status).toBe(200);
    const prazo = Date.now() + 120_000;
    for (;;) {
      const t = await next("/api/v1/system/relogio/tick", { quem: ADMIN });
      expect(t.status).toBe(200);
      const fs = await deEtapa(id!);
      if (fs.length >= 2 && fs.every((f) => f.status === "done" || f.status === "dead")) break;
      if (Date.now() > prazo) throw new Error("o tick não drenou os eventos no prazo");
      await new Promise((r) => setTimeout(r, 1500));
    }
    await next("/api/v1/system/relogio/tick", { quem: ADMIN });
    expect((await leadDe(id!))!.stage_id).toBe(ETAPA.G3);
    const fs = await deEtapa(id!);
    expect(fs.map((f) => f.canonico)).toEqual([true, true]);
    expect(fs[1]!.metadata.green?.trusted).toMatchObject({
      source: "automation",
      request_id: `rule:${REGRA}`,
      causation_event_id: fs[0]!.id,
    });
    // só as execuções sobre os fatos DESTE lead (o tick também drena o canônico pendente de
    // outros casos deste arquivo que pararam na mesma etapa)
    const { rows } = await pool.query<{ event_id: string; status: string }>(
      `select r.event_id, r.status from automation_rule_runs r
        where r.rule_id=$1 and r.event_id in (select e.id from event_log e where e.entity_id=$2)
        order by r.created_at`,
      [REGRA, id],
    );
    expect(rows).toEqual([{ event_id: fs[0]!.id, status: "success" }]);
  });

  it("C9 — concorrência pela rota: 12 movimentos em 6 leads Green ao mesmo tempo, cada mudança comitada é 1 fato, 0 legado", async () => {
    const leads = await novosLeads(FUNIL.GREEN, ETAPA.G1, 6);
    const respostas = await Promise.all(
      leads.flatMap((id) => [kanban(id, ETAPA.G2), kanban(id, ETAPA.G3)]),
    );
    expect(respostas.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    for (const id of leads) {
      const l = await livro(id);
      expect(await resumo(id)).toEqual({ canonicos: l.length, legados: 0 });
      expect(l.length).toBeGreaterThan(0);
    }
  });

  it("P1 — PostgREST direto: PATCH de sessão em lead Green é 1 canônico; relato sem escopo não nasce; com escopo inventado grava (AUTO-GAP-01); comum sem escopo grava", async () => {
    const [g] = await novosLeads(FUNIL.GREEN, ETAPA.G1, 1);
    const [c] = await novosLeads(FUNIL.COMUM, ETAPA.C1, 1);
    const patch = await fetch(`${STACK.url}/rest/v1/crm_leads?id=eq.${g}`, {
      method: "PATCH",
      headers: {
        apikey: STACK.anon,
        authorization: `Bearer ${ADMIN.jwt}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({ stage_id: ETAPA.G2 }),
    });
    expect(patch.status).toBe(204);
    expect(await resumo(g!)).toEqual({ canonicos: 1, legados: 0 });
    const semEscopo = await emitirDireto(g!, { from_stage_id: ETAPA.G1, to_stage_id: ETAPA.G2 });
    expect(semEscopo).toEqual({ status: 200, id: null });
    expect(await resumo(g!)).toEqual({ canonicos: 1, legados: 0 });
    const inventado = await emitirDireto(
      g!,
      { from_stage_id: ETAPA.G2, to_stage_id: ETAPA.G3 },
      randomUUID(),
    );
    expect(inventado.status).toBe(200);
    expect(inventado.id).not.toBeNull();
    const comum = await emitirDireto(c!, { from_stage_id: ETAPA.C1, to_stage_id: ETAPA.C2 });
    expect(comum.status).toBe(200);
    expect(comum.id).not.toBeNull();
  });
});
