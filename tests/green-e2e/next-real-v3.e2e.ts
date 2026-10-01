/**
 * SPIKE Green v3 (descartável) — E2E pelo SERVIDOR NEXT REAL.
 *
 *   cliente HTTP → servidor Next (processo próprio, Node 22) → route handler real
 *   → auth real (cookies de sessão GoTrue / Bearer `dsk_`) → client Supabase
 *   → Kong/PostgREST → Postgres → trigger Green → event_log
 *
 * Este arquivo NÃO importa código do app: tudo o que ele exercita passa por
 * HTTP — o servidor Next (`GREEN_E2E_NEXT_URL`) ou o PostgREST do stack local.
 * O `pg` direto só monta fixtures e lê o resultado. Por isso o MESMO arquivo
 * roda contra o servidor da v2 e o da v3 (prova v2 FAIL → v3 PASS): o que muda
 * entre as duas corridas é só o código servido e a migration aplicada.
 *
 * ─── Como rodar (só ambiente local; nenhuma credencial no Git) ──────────────
 *   1. stack Supabase local com o `supabase/baseline.sql` aplicado;
 *   2. servidor Next deste checkout de pé, em Node 22, apontando para o stack;
 *   3. variáveis lidas do stack por tooling (nunca coladas à mão):
 *        GREEN_E2E_SUPABASE_URL, GREEN_E2E_ANON_KEY, GREEN_E2E_SERVICE_ROLE_KEY,
 *        GREEN_E2E_DB_URL, GREEN_E2E_NEXT_URL
 *   4. `vitest run -c vitest.green-e2e.config.ts tests/green-e2e/next-real-v3.e2e.ts`
 *
 * Sem as variáveis a suíte se declara pulada (nunca "verde por omissão").
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

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

/* ── fixtures ─────────────────────────────────────────────────────────────── */
const ORG = randomUUID(); // org principal (Green + comum)
const ORG_AUTO = randomUUID(); // org só da automação (a regra não enxerga os outros cenários)
const ORG_ALHEIA = randomUUID(); // org do atacante
const FUNIL_GREEN = randomUUID();
const FUNIL_COMUM = randomUUID();
const FUNIL_AUTO = randomUUID();
const FUNIL_ALHEIO = randomUUID();
const ETAPA = {
  A: randomUUID(),
  B: randomUUID(),
  C: randomUUID(),
  SOLICITADO: randomUUID(),
  AGENDADO: randomUUID(),
  COMUM_A: randomUUID(),
  COMUM_B: randomUUID(),
  AUTO_A: randomUUID(),
  AUTO_B: randomUUID(),
  AUTO_C: randomUUID(),
  ALHEIA: randomUUID(),
};
const REGRA = randomUUID();
const TIPO = randomUUID();
const sufixo = ORG.slice(0, 8);

interface Pessoa {
  id: string;
  jwt: string;
  cookie: string;
}
let ADMIN: Pessoa; // admin da ORG
let ADMIN_AUTO: Pessoa; // admin da ORG_AUTO (é quem bate o relógio)
let ATACANTE: Pessoa; // agent da ORG_ALHEIA

const pool = new pg.Pool({ connectionString: STACK.db || "postgresql://x@127.0.0.1:1/x", max: 4 });

/** Lead criado como fixture por conexão direta (caller=direct ⇒ GUC de contexto). */
async function novoLead(org: string, funil: string, etapa: string, contato: string | null = null) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('green.mutation_context', $1, true)", [
      JSON.stringify({ v: 1, source: "e2e_fixture", actor: { kind: "system", id: "fixture" } }),
    ]);
    const { rows } = await client.query<{ id: string }>(
      "insert into crm_leads (organization_id, pipeline_id, stage_id, title, contact_id) values ($1,$2,$3,'Negócio E2E v3',$4) returning id",
      [org, funil, etapa, contato],
    );
    await client.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
async function novoContato(org: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts (id, organization_id, display_name) values ($1,$2,'E2E v3')", [
    id,
    org,
  ]);
  return id;
}
const lead = async (id: string) =>
  (await pool.query("select pipeline_id, stage_id, updated_at from crm_leads where id=$1", [id]))
    .rows[0] as { pipeline_id: string; stage_id: string; updated_at: Date } | undefined;

interface Envelope {
  v: number;
  trusted: Record<string, unknown>;
  advisory: Record<string, unknown>;
}
interface Evento {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> & { green?: Envelope };
  status: string;
  consumed_by: string[];
}
async function eventosDe(id: string): Promise<Evento[]> {
  const { rows } = await pool.query<Evento>(
    "select id, event_type, payload, metadata, status, consumed_by from event_log where entity_kind='crm_lead' and entity_id=$1 and event_type in ('lead.stage_changed','lead.deleted') order by created_at, id",
    [id],
  );
  return rows;
}
const canonicos = async (id: string) =>
  (await eventosDe(id)).filter((e) => e.metadata.green_canonical === true);

/* ── HTTP ─────────────────────────────────────────────────────────────────── */
async function pessoa(org: string, papel: string): Promise<Pessoa> {
  const email = `green-v3-${randomUUID().slice(0, 8)}@spike.test`;
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
    [id, org, papel],
  );
  const anon = createClient(STACK.url, STACK.anon, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) throw error ?? new Error("sem sessão");
  // os cookies `sb-deskcomm-auth*` que o browser mandaria, gerados pelo próprio @supabase/ssr
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

/** Requisição ao SERVIDOR NEXT real, com a sessão (cookies) ou um Bearer. */
function next(
  caminho: string,
  init: { method?: string; body?: unknown; quem?: Pessoa; bearer?: string } = {},
): Promise<Response> {
  return fetch(`${STACK.next}${caminho}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: STACK.next,
      ...(init.quem ? { cookie: init.quem.cookie } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Requisição DIRETA ao PostgREST (o caminho que nenhum writer do app cobre). */
function rest(
  caminho: string,
  init: { method: string; body?: unknown; jwt: string; apikey?: string; contexto?: object },
): Promise<Response> {
  return fetch(`${STACK.url}/rest/v1/${caminho}`, {
    method: init.method,
    headers: {
      apikey: init.apikey ?? STACK.anon,
      authorization: `Bearer ${init.jwt}`,
      "content-type": "application/json",
      prefer: "return=minimal",
      ...(init.contexto
        ? {
            "x-green-mutation-context": Buffer.from(JSON.stringify(init.contexto)).toString("base64"),
          }
        : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const vereditoRest = async (r: Response) => {
  if (r.ok) return `${r.status}`;
  const j = (await r.json().catch(() => ({}))) as { code?: string; message?: string };
  return `${r.status} ${j.code} ${j.message}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
  if (!TEM_STACK) return;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1,$2,'Green v3','Green v3'), ($3,$4,'Green v3 auto','Green v3 auto'), ($5,$6,'Alheia','Alheia')`,
    [ORG, `gv3-${sufixo}`, ORG_AUTO, `gv3-auto-${sufixo}`, ORG_ALHEIA, `gv3-alheia-${sufixo}`],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values
       ($1,$2,'Green','green-${sufixo}'), ($3,$2,'Comum','comum-${sufixo}'),
       ($4,$5,'Green auto','green-auto-${sufixo}'), ($6,$7,'Alheio','alheio-${sufixo}')`,
    [FUNIL_GREEN, ORG, FUNIL_COMUM, FUNIL_AUTO, ORG_AUTO, FUNIL_ALHEIO, ORG_ALHEIA],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$8,$9,'A','etapa-a',1000), ($2,$8,$9,'B','etapa-b',2000), ($3,$8,$9,'C','etapa-c',3000),
       ($4,$8,$9,'Agendamento solicitado','agendamento-solicitado',4000), ($5,$8,$9,'Agendado','agendado',5000),
       ($6,$8,$10,'A','etapa-a',1000), ($7,$8,$10,'B','etapa-b',2000)`,
    [
      ETAPA.A,
      ETAPA.B,
      ETAPA.C,
      ETAPA.SOLICITADO,
      ETAPA.AGENDADO,
      ETAPA.COMUM_A,
      ETAPA.COMUM_B,
      ORG,
      FUNIL_GREEN,
      FUNIL_COMUM,
    ],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
       ($1,$4,$5,'A','etapa-a',1000), ($2,$4,$5,'B','etapa-b',2000), ($3,$4,$5,'C','etapa-c',3000),
       ($6,$7,$8,'A','etapa-a',1000)`,
    [ETAPA.AUTO_A, ETAPA.AUTO_B, ETAPA.AUTO_C, ORG_AUTO, FUNIL_AUTO, ETAPA.ALHEIA, ORG_ALHEIA, FUNIL_ALHEIO],
  );
  await pool.query(
    "insert into green.product_pipeline_binding (organization_id, pipeline_id, product_key) values ($1,$2,'energia'), ($3,$4,'energia')",
    [ORG, FUNIL_GREEN, ORG_AUTO, FUNIL_AUTO],
  );
  ADMIN = await pessoa(ORG, "admin");
  ADMIN_AUTO = await pessoa(ORG_AUTO, "admin");
  ATACANTE = await pessoa(ORG_ALHEIA, "agent");
  await pool.query(
    "insert into automation_rules (id, organization_id, name, trigger_event, is_active, conditions, actions) values ($1,$2,'E2E v3 move para C','lead.stage_changed',true,'[]'::jsonb,$3::jsonb)",
    [
      REGRA,
      ORG_AUTO,
      JSON.stringify([
        { type: "create_or_move_lead", config: { pipeline_id: FUNIL_AUTO, stage_id: ETAPA.AUTO_C } },
      ]),
    ],
  );
  // o servidor Next precisa estar de pé (e não é este processo)
  const vivo = await fetch(`${STACK.next}/api/v1/leads/${randomUUID()}/move`, { method: "POST" }).catch(
    () => null,
  );
  if (!vivo) throw new Error(`servidor Next fora do ar em ${STACK.next}`);
});

afterAll(async () => {
  if (TEM_STACK) await pool.query("update automation_rules set is_active=false where id=$1", [REGRA]);
  await pool.end();
});

describe.skipIf(!TEM_STACK)("E2E servidor Next real — Green Mutation Boundary v3", () => {
  /* ═══ boundary humana pelo framework real ═══════════════════════════════════ */
  const moverPeloKanban = async (id: string, para: string, quem: Pessoa = ADMIN) => {
    const atual = await lead(id);
    return next(`/api/v1/leads/${id}/move`, {
      quem,
      body: {
        stage_id: para,
        position_in_stage: 1000,
        expected_updated_at: atual!.updated_at.toISOString(),
      },
    });
  };

  it("N1 — Kanban pela rota real: ator = sessão, origem derivada, request da rota só como advisory", async () => {
    const id = await novoLead(ORG, FUNIL_GREEN, ETAPA.A);
    const res = await moverPeloKanban(id, ETAPA.B);
    expect(res.status).toBe(200);
    expect((await lead(id))!.stage_id).toBe(ETAPA.B);
    // 1 canônico e nada mais: o gêmeo legado da rota foi suprimido
    const eventos = await eventosDe(id);
    expect(eventos).toHaveLength(1);
    const [e] = eventos;
    expect(e!.metadata.green_canonical).toBe(true);
    expect(e!.metadata.green!.trusted).toEqual({
      caller: "user",
      actor: { kind: "user", id: ADMIN.id },
      source: "user_session",
    });
    // a boundary da rota entregou o contexto da requisição — como advisory
    expect(e!.metadata.green!.advisory.source).toBe("http_session");
    expect(e!.metadata.green!.advisory.request_id).toMatch(UUID);
    expect(e!.metadata.green!.advisory.correlation_id).toBe(e!.metadata.green!.advisory.request_id);
    expect(res.headers.get("x-request-id")).toBe(e!.metadata.green!.advisory.request_id);
    // no topo, nenhum campo de controle vindo do header
    expect(e!.metadata).not.toHaveProperty("request_id");
    expect(e!.metadata.source).toBe("user_session");
  });

  it("N2 — requisições humanas concorrentes no servidor real: cada canônico carrega o request da SUA requisição", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => novoLead(ORG, FUNIL_GREEN, ETAPA.A)));
    // duas rajadas no mesmo processo/keep-alive: a segunda não pode herdar da primeira
    for (const destino of [ETAPA.B, ETAPA.C]) {
      const respostas = await Promise.all(ids.map((id) => moverPeloKanban(id, destino)));
      expect(respostas.map((r) => r.status)).toEqual(ids.map(() => 200));
      const vistos = new Set<string>();
      for (const [i, id] of ids.entries()) {
        const eventos = await canonicos(id);
        const e = eventos.at(-1)!;
        expect(e.payload.to_stage_id).toBe(destino);
        const rid = e.metadata.green!.advisory.request_id as string;
        expect(rid).toBe(respostas[i]!.headers.get("x-request-id"));
        expect(e.metadata.green!.trusted.actor).toEqual({ kind: "user", id: ADMIN.id });
        vistos.add(rid);
      }
      expect(vistos.size).toBe(ids.length);
    }
  });

  it("N3 — tokens concorrentes (agenda por Bearer): o ator do token A nunca aparece na mutação de B", async () => {
    await pool.query(
      "insert into calendar_event_types (id, organization_id, name, slug) values ($1,$2,'Visita','visita-e2e-v3')",
      [TIPO, ORG],
    );
    const casos = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const token = { id: randomUUID(), plain: `dsk_e2e_${randomBytes(18).toString("hex")}` };
        await pool.query(
          "insert into api_tokens (id, organization_id, created_by, name, prefix, token_hash, scopes) values ($1,$2,$3,'e2e v3',$4,$5,$6::jsonb)",
          [
            token.id,
            ORG,
            ADMIN.id,
            token.plain.slice(0, 12),
            createHash("sha256").update(token.plain).digest(),
            JSON.stringify(["mcp:read", "mcp:write", "role:ai_operator"]),
          ],
        );
        const contato = await novoContato(ORG);
        const id = await novoLead(ORG, FUNIL_GREEN, ETAPA.SOLICITADO, contato);
        const compromisso = randomUUID();
        await pool.query(
          "insert into calendar_appointments (id, organization_id, title, starts_at, ends_at, status, contact_id, event_type_id, owner_user_id, time_zone) values ($1,$2,'Visita E2E v3', now() + interval '2 days', now() + interval '2 days 30 minutes','pending',$3,$4,$5,'America/Sao_Paulo')",
          [compromisso, ORG, contato, TIPO, ADMIN.id],
        );
        return { token, id, compromisso };
      }),
    );
    const respostas = await Promise.all(
      casos.map((c) =>
        next("/api/v1/agenda/agendamentos", {
          method: "PATCH",
          bearer: c.token.plain,
          body: { id: c.compromisso, status: "confirmed" },
        }),
      ),
    );
    expect(respostas.map((r) => r.status)).toEqual(casos.map(() => 200));
    const requests = new Set<string>();
    for (const [i, c] of casos.entries()) {
      expect((await lead(c.id))!.stage_id).toBe(ETAPA.AGENDADO);
      const eventos = await canonicos(c.id);
      expect(eventos).toHaveLength(1);
      const trusted = eventos[0]!.metadata.green!.trusted;
      expect(trusted).toMatchObject({
        caller: "service_role",
        source: "http_token",
        actor: { kind: "api_token", id: c.token.id, api_token_id: c.token.id },
      });
      expect(trusted.request_id).toBe(respostas[i]!.headers.get("x-request-id"));
      expect(eventos[0]!.metadata.green!.advisory).toEqual({});
      requests.add(trusted.request_id as string);
    }
    expect(requests.size).toBe(casos.length);
  });

  /* ═══ ADV-01 — saída e DELETE ═══════════════════════════════════════════════ */
  it("N4 — PATCH direto no PostgREST tirando a Opportunity do Green: canonizado como `exit`", async () => {
    const id = await novoLead(ORG, FUNIL_GREEN, ETAPA.A);
    const r = await rest(`crm_leads?id=eq.${id}`, {
      method: "PATCH",
      jwt: ADMIN.jwt,
      body: { pipeline_id: FUNIL_COMUM, stage_id: ETAPA.COMUM_A },
    });
    expect(r.status).toBe(204);
    expect(await lead(id)).toMatchObject({ pipeline_id: FUNIL_COMUM, stage_id: ETAPA.COMUM_A });
    const eventos = await canonicos(id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toMatchObject({
      from_pipeline_id: FUNIL_GREEN,
      pipeline_id: FUNIL_COMUM,
      green_transition: "exit",
    });
    // service_role sem contexto, pelo PostgREST: a saída é recusada
    const outro = await novoLead(ORG, FUNIL_GREEN, ETAPA.A);
    const semContexto = await rest(`crm_leads?id=eq.${outro}`, {
      method: "PATCH",
      jwt: STACK.service,
      apikey: STACK.service,
      body: { pipeline_id: FUNIL_COMUM, stage_id: ETAPA.COMUM_A },
    });
    expect(await vereditoRest(semContexto)).toContain("green_mutation_context_required");
    expect((await lead(outro))!.pipeline_id).toBe(FUNIL_GREEN);
  });

  it("N5 — exclusão em lote pela rota real: a Opportunity Green deixa uma lápide canônica", async () => {
    const id = await novoLead(ORG, FUNIL_GREEN, ETAPA.B);
    const res = await next("/api/v1/leads/bulk", {
      quem: ADMIN,
      body: { action: "delete", lead_ids: [id] },
    });
    expect(res.status).toBe(200);
    expect(await lead(id)).toBeUndefined();
    const eventos = await canonicos(id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.event_type).toBe("lead.deleted");
    expect(eventos[0]!.payload).toMatchObject({ from_stage_id: ETAPA.B, green_transition: "delete" });
    expect(eventos[0]!.metadata.green!.trusted).toEqual({
      caller: "user",
      actor: { kind: "user", id: ADMIN.id },
      source: "user_session",
    });
    expect(eventos[0]!.metadata.green!.advisory.request_id).toBe(res.headers.get("x-request-id"));
  });

  /* ═══ ADV-09 — lote entre funis pela rota real ══════════════════════════════ */
  it("N6 — lote pela rota real não põe etapa Green em lead não-Green", async () => {
    const id = await novoLead(ORG, FUNIL_COMUM, ETAPA.COMUM_A);
    await next("/api/v1/leads/bulk", {
      quem: ADMIN,
      body: { action: "move", lead_ids: [id], params: { stage_id: ETAPA.B } },
    });
    expect(await lead(id)).toMatchObject({ pipeline_id: FUNIL_COMUM, stage_id: ETAPA.COMUM_A });
    expect(await eventosDe(id)).toHaveLength(0);
  });

  /* ═══ ADV-02 — oracle cross-tenant ══════════════════════════════════════════ */
  it("N7 — oracle cross-tenant por HTTP: funil Green estrangeiro ≡ funil comum estrangeiro", async () => {
    const sonda = async (funil: string, etapa: string) =>
      vereditoRest(
        await rest("crm_leads", {
          method: "POST",
          jwt: ATACANTE.jwt,
          body: { organization_id: ORG, pipeline_id: funil, stage_id: etapa, title: "sonda" },
        }),
      );
    const green = await sonda(FUNIL_GREEN, ETAPA.ALHEIA);
    const comum = await sonda(FUNIL_COMUM, ETAPA.ALHEIA);
    const greenEtapaCerta = await sonda(FUNIL_GREEN, ETAPA.A);
    expect(green).toBe(comum);
    expect(greenEtapaCerta).toBe(comum);
    expect(green).not.toContain("green_");
    expect(green).toContain("row-level security");
  });

  /* ═══ ADV-03 — canônico imutável ════════════════════════════════════════════ */
  it("N8 — service_role pelo PostgREST não reescreve nem apaga o canônico; o consumer segue mexendo no que é dele", async () => {
    const id = await novoLead(ORG, FUNIL_GREEN, ETAPA.A);
    await moverPeloKanban(id, ETAPA.B);
    const [e] = await canonicos(id);
    const comoServico = (method: string, body?: unknown) =>
      rest(`event_log?id=eq.${e!.id}`, { method, jwt: STACK.service, apikey: STACK.service, body });
    const reescrita = await vereditoRest(
      await comoServico("PATCH", {
        metadata: { ...e!.metadata, actor: { kind: "system", id: "forjado" }, caller: "service_role" },
        payload: { ...e!.payload, to_stage_id: ETAPA.C },
      }),
    );
    expect(reescrita).toContain("green_canonical_immutable");
    const exclusao = await vereditoRest(await comoServico("DELETE"));
    expect(exclusao).toContain("green_canonical_immutable");
    const [depois] = await canonicos(id);
    expect(depois!.metadata).toEqual(e!.metadata);
    expect(depois!.payload).toEqual(e!.payload);
    expect((await comoServico("PATCH", { status: "done", consumed_by: ["x"] })).status).toBe(204);
  });

  /* ═══ ADV-04 + ADV-05 — advisory forjado e tick do relógio pelo servidor real ═ */
  it("N9 — `request_id=rule:*` forjado não desliga a automação; o tick disparado por sessão admin não vira causa da mutação", async () => {
    const contatoControle = await novoContato(ORG_AUTO);
    const contatoForjado = await novoContato(ORG_AUTO);
    const controle = await novoLead(ORG_AUTO, FUNIL_AUTO, ETAPA.AUTO_A, contatoControle);
    const forjado = await novoLead(ORG_AUTO, FUNIL_AUTO, ETAPA.AUTO_A, contatoForjado);
    const patch = (id: string, contexto?: object) =>
      rest(`crm_leads?id=eq.${id}`, {
        method: "PATCH",
        jwt: ADMIN_AUTO.jwt,
        body: { stage_id: ETAPA.AUTO_B },
        contexto,
      });
    expect((await patch(controle)).status).toBe(204);
    expect(
      (await patch(forjado, { v: 1, source: "automation", request_id: "rule:qualquer" })).status,
    ).toBe(204);

    // a sessão ADMIN bate o relógio pelo servidor real, até o drain consumir os dois eventos
    const ticks: string[] = [];
    const prazo = Date.now() + 90_000;
    for (;;) {
      const res = await next("/api/v1/system/relogio/tick", { quem: ADMIN_AUTO });
      expect(res.status).toBe(200);
      ticks.push(res.headers.get("x-request-id") ?? "");
      const [a, b] = [await eventosDe(controle), await eventosDe(forjado)];
      const drenado = (es: Evento[]) => es.every((e) => e.status === "done" || e.status === "dead");
      if (drenado(a) && drenado(b) && a.length && b.length) break;
      if (Date.now() > prazo) throw new Error("o tick não drenou os eventos no prazo");
      await new Promise((r) => setTimeout(r, 1500));
    }

    // os DOIS leads foram levados a C pela regra: o request_id forjado não desligou nada
    expect((await lead(controle))!.stage_id).toBe(ETAPA.AUTO_C);
    expect((await lead(forjado))!.stage_id).toBe(ETAPA.AUTO_C);

    for (const id of [controle, forjado]) {
      const eventos = await canonicos(id);
      expect(eventos).toHaveLength(2);
      const [humano, daRegra] = eventos;
      // o canônico que a regra causou: proveniência de sistema, causa = o evento, nada do admin
      expect(daRegra!.metadata.green!.trusted).toMatchObject({
        caller: "service_role",
        source: "automation",
        request_id: `rule:${REGRA}`,
        causation_event_id: humano!.id,
        actor: { kind: "webhook_source", id: REGRA },
      });
      const texto = JSON.stringify(daRegra!.metadata);
      expect(texto).not.toContain(ADMIN_AUTO.id);
      for (const t of ticks.filter(Boolean)) expect(texto).not.toContain(t);
      // e o anti-loop continua de pé: o evento da regra não gerou um terceiro
      expect(daRegra!.status).toBe("done");
    }
    const [doForjado] = await canonicos(forjado);
    expect(doForjado!.metadata.green!.advisory).toMatchObject({ request_id: "rule:qualquer" });
    expect(doForjado!.metadata).not.toHaveProperty("request_id");
  });
});
