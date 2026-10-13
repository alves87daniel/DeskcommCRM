/* eslint-disable @typescript-eslint/no-explicit-any -- corpo de resposta JSON de teste */
/**
 * CG-COM-01 — a rota da expansão pós-ganho (`/api/v1/leads/[id]/expansion`).
 *
 * O banco é um dublê programável (`tests/helpers/duble-expansao.ts`): o contrato real do banco
 * (transação, lock, idempotência sob concorrência, guarda do vínculo, RLS, tenant) é provado em
 * `tests/invariants/green-expansion-commercial-origin.test.ts`. Aqui se prova o que é da rota:
 *
 *   - papel mínimo (viewer lê, agent cria) e guarda de suporte antes do efeito;
 *   - a organização vem da sessão; origem de outra organização é 404;
 *   - validação `.strict()` (nem organização, nem contato, nem status pelo corpo);
 *   - elegibilidade (ganha e com contato) antes de qualquer escrita;
 *   - idempotência: expansão aberta existente volta 200 sem escrever, sem evento e sem auditoria;
 *     a invisível é 409; a `Idempotency-Key` repete a resposta gravada pelo helper real;
 *   - cada recusa nomeada do banco vira a resposta certa;
 *   - criada: 201, `lead.created` no barramento, auditoria `lead.created` + `lead.expansion_created`
 *     e a linha do tempo SÓ na oportunidade nova (a de origem não recebe nada);
 *   - GET mostra origem, expansões, elegibilidade e destinos Green, sem escrever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Origem from "@/lib/atendimento/origem";
import type * as Emissor from "@/lib/leads/activity-emitter";
import { NextRequest } from "next/server";

import {
  dubleExpansao,
  type DubleExpansao,
  type Linha,
  type RespostaRpc,
} from "../helpers/duble-expansao";

const ORG = "a0000000-0000-4000-8000-00000000000a";
const OUTRA_ORG = "b0000000-0000-4000-8000-00000000000b";
const USER = "a0000000-0000-4000-8000-0000000000d1";
const CONTATO = "a0000000-0000-4000-8000-0000000000c1";
const ORIGEM = "a0000000-0000-4000-8000-0000000000e1";
const NOVA = "a0000000-0000-4000-8000-0000000000e2";
const AVO = "a0000000-0000-4000-8000-0000000000e0";
const FUNIL_CONEXAO = "a0000000-0000-4000-8000-0000000000f1";
const FUNIL_EXPANSAO = "a0000000-0000-4000-8000-0000000000f2";
const FUNIL_COMUM = "a0000000-0000-4000-8000-0000000000f3";
const ETAPA_GANHO = "a0000000-0000-4000-8000-0000000000a1";
const ETAPA_ARQUIVADA = "a0000000-0000-4000-8000-0000000000a2";
const ETAPA_NOVO = "a0000000-0000-4000-8000-0000000000a3";
const ETAPA_PROPOSTA = "a0000000-0000-4000-8000-0000000000a4";
const ETAPA_EXP_GANHO = "a0000000-0000-4000-8000-0000000000a5";
const PROD_ALFA = "a0000000-0000-4000-8000-0000000000b1";
const PROD_BETA = "a0000000-0000-4000-8000-0000000000b2";
const LINK = "a0000000-0000-4000-8000-00000000001c";

const RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 4, admin: 5 };
const h = vi.hoisted(() => ({
  papel: "agent" as string,
  db: null as unknown,
  audit: vi.fn(),
  apoio: vi.fn(),
  emitEvent: vi.fn(),
  atividade: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireRole: async (min: string) => {
      if ((RANK[h.papel] ?? 0) < (RANK[min] ?? 99)) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: { code: "forbidden_role", message: "x" } },
            { status: 403 },
          ),
        };
      }
      return {
        ok: true,
        user: { id: "a0000000-0000-4000-8000-0000000000d1", idioma: "pt-BR" },
        org: { orgId: "a0000000-0000-4000-8000-00000000000a", role: h.papel },
      };
    },
  };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.db }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (nome: string, args: Record<string, unknown>) => {
      h.emitEvent(nome, args);
      return Promise.resolve({ data: "evento", error: null });
    },
  }),
}));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: async () => "BRL" }));
vi.mock("@/lib/atendimento/origem", async (original) => ({
  ...(await original<typeof Origem>()),
  observeServiceOrigin: async () => null,
}));
vi.mock("@/lib/leads/activity-emitter", async (original) => ({
  ...(await original<typeof Emissor>()),
  emitLeadActivity: async (_db: unknown, entrada: unknown) => {
    h.atividade(entrada);
    return { ok: true };
  },
}));

import { GET, POST } from "@/app/api/v1/leads/[id]/expansion/route";

/* ── cenário ──────────────────────────────────────────────────────────────── */
const leadLinha = (id: string, extra: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  title: "Maria - Conta de luz",
  status: "won",
  contact_id: CONTATO,
  pipeline_id: FUNIL_CONEXAO,
  stage_id: ETAPA_GANHO,
  ...extra,
});
const etapa = (id: string, pipeline: string, nome: string, pos: number, extra: Linha = {}) => ({
  id,
  organization_id: ORG,
  pipeline_id: pipeline,
  name: nome,
  position: pos,
  is_won: false,
  is_lost: false,
  is_archived: false,
  ...extra,
});

interface Opcoes {
  leads?: Linha[];
  links?: Linha[];
  contextos?: Linha[];
  funilSettings?: Record<string, unknown>;
  /** O que `fn_green_pipeline_ids` devolve (padrão: ConexãoGreen e Expansão). */
  funisGreen?: string[];
  aberta?: () => RespostaRpc;
  criar?: (args: Record<string, unknown>) => RespostaRpc;
}

function cenario(o: Opcoes = {}): DubleExpansao {
  const d = dubleExpansao({
    tabelas: {
      crm_leads: o.leads ?? [leadLinha(ORIGEM)],
      crm_lead_links: o.links ?? [],
      green_lead_context: o.contextos ?? [
        { lead_id: ORIGEM, organization_id: ORG, product_id: PROD_ALFA },
      ],
      green_products: [
        { id: PROD_ALFA, organization_id: ORG, name: "Produto Alfa", is_active: true },
        { id: PROD_BETA, organization_id: ORG, name: "Produto Beta", is_active: true },
      ],
      crm_pipelines: [
        { id: FUNIL_CONEXAO, organization_id: ORG, name: "ConexãoGreen", settings: {} },
        {
          id: FUNIL_EXPANSAO,
          organization_id: ORG,
          name: "Expansão",
          settings: o.funilSettings ?? {},
        },
        { id: FUNIL_COMUM, organization_id: ORG, name: "Comum", settings: {} },
      ],
      crm_stages: [
        etapa(ETAPA_GANHO, FUNIL_CONEXAO, "Ganho", 2000, { is_won: true }),
        etapa(ETAPA_ARQUIVADA, FUNIL_EXPANSAO, "Velha", 500, { is_archived: true }),
        etapa(ETAPA_NOVO, FUNIL_EXPANSAO, "Novo", 1000),
        etapa(ETAPA_PROPOSTA, FUNIL_EXPANSAO, "Proposta", 1500),
        etapa(ETAPA_EXP_GANHO, FUNIL_EXPANSAO, "Ganho", 2000, { is_won: true }),
      ],
      idempotency_keys: [],
    },
    rpcs: {
      fn_crm_open_expansion_of: () => (o.aberta ?? (() => ({ data: [], error: null })))(),
      fn_green_pipeline_ids: () => ({
        data: o.funisGreen ?? [FUNIL_CONEXAO, FUNIL_EXPANSAO],
        error: null,
      }),
      fn_crm_create_expansion_opportunity: (args) => {
        if (o.criar) return o.criar(args);
        // o banco cria B, o contexto e o vínculo (provado nos invariantes); aqui só o resultado
        d.tabelas.crm_leads!.push(
          leadLinha(NOVA, {
            title: args.p_title,
            status: "open",
            pipeline_id: args.p_pipeline_id,
            stage_id: args.p_stage_id,
            source: "expansao",
          }),
        );
        return { data: { created: true, lead_id: NOVA, link_id: LINK }, error: null };
      },
    },
  });
  h.db = d.db;
  return d;
}

const req = (corpo?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/v1/leads/${ORIGEM}/expansion`, {
    method: corpo === undefined ? "GET" : "POST",
    ...(corpo === undefined
      ? {}
      : {
          body: JSON.stringify(corpo),
          headers: { "content-type": "application/json", ...headers },
        }),
  });
const ctx = (id = ORIGEM) => ({ params: Promise.resolve({ id }) });
const corpoDe = async (r: Response) => (await r.json()) as { data?: any; error?: { code: string } };
const PEDIDO = { pipeline_id: FUNIL_EXPANSAO, product_id: PROD_BETA, title: "Maria - Expansão" };
const criou = (d: DubleExpansao) =>
  d.chamadas.filter((c) => c.nome === "fn_crm_create_expansion_opportunity");

beforeEach(() => {
  h.papel = "agent";
  h.apoio.mockReset().mockResolvedValue(null);
  h.audit.mockReset();
  h.emitEvent.mockReset();
  h.atividade.mockReset();
});

/* ── POST: criação ────────────────────────────────────────────────────────── */
describe("POST /leads/[id]/expansion — criação", () => {
  it("cria: 201, RPC com a organização da sessão, primeira etapa aberta e moeda da organização", async () => {
    const d = cenario();
    const r = await POST(req({ ...PEDIDO, value_cents: 9900 }), ctx());
    const corpo = await corpoDe(r);

    expect(r.status).toBe(201);
    expect(corpo.data).toMatchObject({ created: true, link_id: LINK, origin_lead_id: ORIGEM });
    // só ids e estado: a resposta vira recibo de idempotência, e o título é o nome do cliente
    expect(corpo.data.lead).toEqual({
      id: NOVA,
      pipeline_id: FUNIL_EXPANSAO,
      stage_id: ETAPA_NOVO,
      status: "open",
      contact_id: CONTATO,
    });
    expect(criou(d)).toHaveLength(1);
    expect(criou(d)[0]!.args).toEqual({
      p_organization_id: ORG,
      p_origin_lead_id: ORIGEM,
      p_pipeline_id: FUNIL_EXPANSAO,
      // sem etapa pedida: a primeira ABERTA (a arquivada e a de ganho ficam de fora)
      p_stage_id: ETAPA_NOVO,
      p_product_id: PROD_BETA,
      p_title: "Maria - Expansão",
      p_value_cents: 9900,
      p_currency: "BRL",
    });
  });

  it("o rastro de nascimento é o de todo lead: lead.created no barramento e na auditoria", async () => {
    cenario();
    await POST(req({ ...PEDIDO, stage_id: ETAPA_PROPOSTA }), ctx());

    const eventos = h.emitEvent.mock.calls.filter(([nome]) => nome === "emit_event");
    expect(eventos).toHaveLength(1);
    expect(eventos[0]![1]).toMatchObject({
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: NOVA,
      p_organization_id: ORG,
    });
    const acoes = h.audit.mock.calls.map(([a]) => a.action);
    expect(acoes).toEqual(["lead.created", "lead.expansion_created"]);
    expect(h.audit.mock.calls[1]![0]).toMatchObject({
      action: "lead.expansion_created",
      actorUserId: USER,
      organizationId: ORG,
      resourceType: "crm_lead",
      resourceId: NOVA,
      metadata: {
        origin_lead_id: ORIGEM,
        link_id: LINK,
        product_id: PROD_BETA,
        pipeline_id: FUNIL_EXPANSAO,
        stage_id: ETAPA_PROPOSTA,
        reason: "expansion",
      },
    });
  });

  it("a linha do tempo é só da NOVA; a de origem não recebe atividade", async () => {
    cenario();
    await POST(req(PEDIDO), ctx());
    expect(h.atividade).toHaveBeenCalledTimes(1);
    expect(h.atividade.mock.calls[0]![0]).toMatchObject({
      leadId: NOVA,
      type: "opened_as_expansion",
      sourceId: ORIGEM,
      contactId: CONTATO,
      payload: { origin_lead_id: ORIGEM, product_id: PROD_BETA },
    });
    expect(h.atividade.mock.calls.some(([a]) => a.leadId === ORIGEM)).toBe(false);
  });

  it("a rota nunca escreve direto em crm_leads, crm_lead_links nem green_lead_context", async () => {
    const d = cenario();
    await POST(req(PEDIDO), ctx());
    expect(
      d.escritas.filter((e) =>
        ["crm_leads", "crm_lead_links", "green_lead_context"].includes(e.tabela),
      ),
    ).toEqual([]);
  });
});

/* ── POST: idempotência ───────────────────────────────────────────────────── */
describe("POST /leads/[id]/expansion — idempotência", () => {
  it("expansão aberta existente (visível): 200 com ela, sem RPC de escrita, evento ou auditoria", async () => {
    const d = cenario({
      leads: [leadLinha(ORIGEM), leadLinha(NOVA, { status: "open", pipeline_id: FUNIL_EXPANSAO })],
      links: [
        {
          id: LINK,
          organization_id: ORG,
          lead_id: NOVA,
          target_kind: "lead",
          target_id: ORIGEM,
          link_kind: "commercial_origin",
        },
      ],
      aberta: () => ({ data: [{ lead_id: NOVA, visible: true }], error: null }),
    });
    const r = await POST(req(PEDIDO), ctx());
    const corpo = await corpoDe(r);
    expect(r.status).toBe(200);
    expect(corpo.data).toMatchObject({ created: false, link_id: LINK, lead: { id: NOVA } });
    expect(criou(d)).toHaveLength(0);
    expect(h.emitEvent).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.atividade).not.toHaveBeenCalled();
  });

  it("expansão aberta que o operador não enxerga: 409 expansion_already_open, sem criar", async () => {
    const d = cenario({
      aberta: () => ({ data: [{ lead_id: null, visible: false }], error: null }),
    });
    const r = await POST(req(PEDIDO), ctx());
    expect(r.status).toBe(409);
    expect((await corpoDe(r)).error?.code).toBe("expansion_already_open");
    expect(criou(d)).toHaveLength(0);
  });

  it("corrida perdida (a RPC devolve created=false): 200 com a existente, sem evento nem auditoria", async () => {
    const d = cenario({
      leads: [leadLinha(ORIGEM), leadLinha(NOVA, { status: "open" })],
      criar: () => ({ data: { created: false, lead_id: NOVA, link_id: LINK }, error: null }),
    });
    const r = await POST(req(PEDIDO), ctx());
    expect(r.status).toBe(200);
    expect((await corpoDe(r)).data).toMatchObject({ created: false, lead: { id: NOVA } });
    expect(criou(d)).toHaveLength(1);
    expect(h.emitEvent).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("Idempotency-Key: a mesma chave e o mesmo corpo repetem a resposta gravada sem reexecutar", async () => {
    const d = cenario();
    const chave = { "Idempotency-Key": "c0000000-0000-4000-8000-0000000000aa" };
    const r1 = await POST(req(PEDIDO, chave), ctx());
    const r2 = await POST(req(PEDIDO, chave), ctx());
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await corpoDe(r2)).data).toEqual((await corpoDe(r1)).data);
    expect(criou(d)).toHaveLength(1);
    // o recibo gravado não carrega o título (nome do cliente)
    expect(JSON.stringify(d.tabelas.idempotency_keys)).not.toContain("Maria");

    const r3 = await POST(req({ ...PEDIDO, title: "Outro título" }, chave), ctx());
    expect(r3.status).toBe(409);
    expect((await corpoDe(r3)).error?.code).toBe("idempotency_conflict");
  });

  it("Idempotency-Key que não é UUID é recusada antes de tudo", async () => {
    const d = cenario();
    const r = await POST(req(PEDIDO, { "Idempotency-Key": "abc" }), ctx());
    expect(r.status).toBe(400);
    expect(criou(d)).toHaveLength(0);
  });
});

/* ── POST: recusas ────────────────────────────────────────────────────────── */
describe("POST /leads/[id]/expansion — permissões, validação e recusas", () => {
  it("viewer: 403; sessão de suporte somente leitura: a guarda responde antes de tudo", async () => {
    h.papel = "viewer";
    const d = cenario();
    expect((await POST(req(PEDIDO), ctx())).status).toBe(403);

    h.papel = "agent";
    h.apoio.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await POST(req(PEDIDO), ctx())).status).toBe(403);
    expect(criou(d)).toHaveLength(0);
  });

  it("corpo `.strict()`: organização, contato, status ou responsável no corpo; produto ausente; título e valor inválidos", async () => {
    const d = cenario();
    for (const corpo of [
      { ...PEDIDO, organization_id: OUTRA_ORG },
      { ...PEDIDO, contact_id: CONTATO },
      { ...PEDIDO, status: "won" },
      // o responsável é decidido no banco (quem cria), nunca pelo corpo
      { ...PEDIDO, owner_user_id: USER },
      { ...PEDIDO, owner_agent_id: USER },
      { pipeline_id: FUNIL_EXPANSAO, title: "Maria" },
      { ...PEDIDO, title: "x" },
      { ...PEDIDO, value_cents: -1 },
    ]) {
      const r = await POST(req(corpo), ctx());
      expect(r.status, JSON.stringify(corpo)).toBe(422);
      expect((await corpoDe(r)).error?.code).toBe("validation_failed");
    }
    expect(criou(d)).toHaveLength(0);
  });

  it("origem de outra organização ou inexistente: 404; id malformado: 404", async () => {
    const d = cenario({ leads: [leadLinha(ORIGEM, { organization_id: OUTRA_ORG })] });
    expect((await POST(req(PEDIDO), ctx())).status).toBe(404);
    expect((await POST(req(PEDIDO), ctx("nao-e-uuid"))).status).toBe(404);
    expect(criou(d)).toHaveLength(0);
  });

  it("origem aberta, perdida ou sem contato: 422 nomeado, sem tocar no banco de escrita", async () => {
    for (const [extra, codigo] of [
      [{ status: "open" }, "expansion_origin_not_won"],
      [{ status: "lost" }, "expansion_origin_not_won"],
      [{ contact_id: null }, "expansion_origin_without_contact"],
    ] as const) {
      const d = cenario({ leads: [leadLinha(ORIGEM, extra)] });
      const r = await POST(req(PEDIDO), ctx());
      expect(r.status).toBe(422);
      expect((await corpoDe(r)).error?.code).toBe(codigo);
      expect(d.chamadas).toEqual([]);
    }
  });

  it("etapa com campo obrigatório: 422 required_fields_missing antes da RPC", async () => {
    const d = cenario({
      funilSettings: {
        fields: [
          {
            key: "consumo",
            label: "Consumo médio",
            type: "text",
            obrigatorio_em: { etapas: [ETAPA_NOVO] },
          },
        ],
      },
    });
    const r = await POST(req(PEDIDO), ctx());
    const corpo = await corpoDe(r);
    expect(r.status, JSON.stringify(corpo)).toBe(422);
    expect(corpo.error?.code).toBe("required_fields_missing");
    expect(criou(d)).toHaveLength(0);
  });

  it.each([
    ["expansion_destination_not_green", "23514", 422, "expansion_destination_not_green"],
    ["expansion_stage_unavailable", "23514", 422, "expansion_stage_unavailable"],
    ["expansion_origin_not_won", "23514", 422, "expansion_origin_not_won"],
    ["expansion_origin_not_found", "P0002", 404, "not_found"],
    ["green_product_inactive", "23514", 422, "green_product_inactive"],
    [
      'insert or update on table "green_lead_context" violates foreign key constraint "green_lead_context_product_fkey"',
      "23503",
      422,
      "green_product_not_found",
    ],
    ["expansion_already_open", "23505", 409, "expansion_already_open"],
    [
      'new row violates row-level security policy for table "crm_leads"',
      "42501",
      403,
      "forbidden_role",
    ],
    ["expansion_title_invalid", "23514", 422, "validation_failed"],
    ["algo inesperado", "XX000", 500, "internal_error"],
  ])("recusa do banco %s -> %s %s", async (mensagem, code, status, codigo) => {
    cenario({ criar: () => ({ data: null, error: { code, message: mensagem } }) });
    const r = await POST(req(PEDIDO), ctx());
    expect(r.status).toBe(status);
    expect((await corpoDe(r)).error?.code).toBe(codigo);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.emitEvent).not.toHaveBeenCalled();
  });
});

/* ── GET ──────────────────────────────────────────────────────────────────── */
describe("GET /leads/[id]/expansion", () => {
  const relacionado = (): Opcoes => ({
    leads: [
      leadLinha(AVO, { title: "Maria - Primeira venda" }),
      leadLinha(ORIGEM),
      leadLinha(NOVA, {
        title: "Maria - Expansão",
        status: "open",
        pipeline_id: FUNIL_EXPANSAO,
        stage_id: ETAPA_NOVO,
      }),
    ],
    links: [
      {
        id: "l1",
        organization_id: ORG,
        lead_id: ORIGEM,
        target_kind: "lead",
        target_id: AVO,
        link_kind: "commercial_origin",
        created_at: "2026-10-01T10:00:00Z",
      },
      {
        id: "l2",
        organization_id: ORG,
        lead_id: NOVA,
        target_kind: "lead",
        target_id: ORIGEM,
        link_kind: "commercial_origin",
        created_at: "2026-10-08T10:00:00Z",
      },
      // vínculo de agenda: não é relação comercial
      {
        id: "l3",
        organization_id: ORG,
        lead_id: ORIGEM,
        target_kind: "appointment",
        target_id: "x",
        link_kind: "scheduled",
        created_at: "2026-10-02T10:00:00Z",
      },
    ],
    contextos: [
      { lead_id: ORIGEM, organization_id: ORG, product_id: PROD_ALFA },
      { lead_id: NOVA, organization_id: ORG, product_id: PROD_BETA },
    ],
  });

  it("agent: origem, expansões com funil/etapa/produto, elegível e destinos Green com etapas abertas", async () => {
    const d = cenario(relacionado());
    const r = await GET(req(), ctx());
    const corpo = await corpoDe(r);
    expect(r.status).toBe(200);
    expect(corpo.data).toMatchObject({
      lead_id: ORIGEM,
      lead_status: "won",
      eligibility: { eligible: true, reason: null },
      can_create: true,
      suggested_product_id: PROD_ALFA,
      origin: { lead_id: AVO, visible: true, title: "Maria - Primeira venda", status: "won" },
      expansions: [
        {
          lead_id: NOVA,
          visible: true,
          title: "Maria - Expansão",
          status: "open",
          pipeline_name: "Expansão",
          stage_name: "Novo",
          product: { id: PROD_BETA, name: "Produto Beta", is_active: true },
        },
      ],
    });
    // o funil comum (sem binding) não é destino; o ConexãoGreen não tem etapa aberta no dublê
    expect(corpo.data.destinations).toEqual([
      {
        pipeline_id: FUNIL_EXPANSAO,
        name: "Expansão",
        stages: [
          { id: ETAPA_NOVO, name: "Novo" },
          { id: ETAPA_PROPOSTA, name: "Proposta" },
        ],
      },
    ]);
    expect(d.escritas).toEqual([]);
    expect(criou(d)).toHaveLength(0);
  });

  it("viewer lê a relação, mas não recebe destinos nem pode criar", async () => {
    h.papel = "viewer";
    const d = cenario(relacionado());
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data).toMatchObject({ can_create: false, destinations: [] });
    expect(corpo.data.expansions).toHaveLength(1);
    expect(d.chamadas.some((c) => c.nome === "fn_green_pipeline_ids")).toBe(false);
  });

  it("oportunidade de origem invisível: o vínculo aparece sem título nem status", async () => {
    const o = relacionado();
    o.leads = o.leads!.filter((l) => l.id !== AVO);
    cenario(o);
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data.origin).toEqual({
      lead_id: AVO,
      visible: false,
      title: null,
      status: null,
      pipeline_name: null,
      stage_name: null,
      product: null,
      linked_at: "2026-10-01T10:00:00Z",
    });
  });

  it("oportunidade aberta não é elegível; sem contato também não", async () => {
    cenario({ leads: [leadLinha(ORIGEM, { status: "open" })] });
    let corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data).toMatchObject({
      eligibility: { eligible: false, reason: "not_won" },
      can_create: false,
      destinations: [],
      origin: null,
      expansions: [],
    });
    cenario({ leads: [leadLinha(ORIGEM, { contact_id: null })] });
    corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data.eligibility).toEqual({ eligible: false, reason: "without_contact" });
  });

  it("funil Green sem etapa aberta: Green disponível, mas não há como criar", async () => {
    const d = cenario();
    d.tabelas.crm_stages = d.tabelas.crm_stages!.filter((e) => e.pipeline_id !== FUNIL_EXPANSAO);
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data).toMatchObject({
      green_available: true,
      can_create: false,
      destinations: [],
    });
  });

  it("organização sem funil Green (Deskcomm puro): green_available falso, nada a oferecer", async () => {
    cenario({ funisGreen: [] });
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data).toMatchObject({
      eligibility: { eligible: true, reason: null },
      green_available: false,
      can_create: false,
      destinations: [],
    });
  });

  it("com funil Green e etapa aberta, green_available e can_create verdadeiros", async () => {
    cenario();
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data).toMatchObject({ green_available: true, can_create: true });
  });

  it("produto da origem inativo não é sugerido", async () => {
    const d = cenario();
    d.tabelas.green_products!.find((p) => p.id === PROD_ALFA)!.is_active = false;
    const corpo = await corpoDe(await GET(req(), ctx()));
    expect(corpo.data.suggested_product_id).toBeNull();
  });

  it("lead de outra organização ou inexistente: 404", async () => {
    cenario({ leads: [leadLinha(ORIGEM, { organization_id: OUTRA_ORG })] });
    expect((await GET(req(), ctx())).status).toBe(404);
    expect((await GET(req(), ctx("nao-e-uuid"))).status).toBe(404);
  });
});
