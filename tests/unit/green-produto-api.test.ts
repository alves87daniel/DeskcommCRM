/* eslint-disable @typescript-eslint/no-explicit-any -- corpo de resposta JSON de teste */
/**
 * GREEN-CRM-02 — as rotas do catálogo de produtos Green e do produto principal da oportunidade.
 *
 * O banco é um dublê programável (`tests/helpers/duble-green-produto.ts`): o contrato real do
 * banco (RLS, FKs compostas, triggers, evento) é provado em
 * `tests/invariants/green-product-catalog.test.ts`. Aqui se prova o que é da rota:
 *
 *   - papel mínimo (viewer lê, manager cadastra, agent grava o contexto);
 *   - a organização vem da sessão, nunca do corpo (cross-tenant fecha em 404/422);
 *   - validação (code inválido, `code` imutável, chave desconhecida);
 *   - cada erro nomeado da 0509 vira a resposta certa;
 *   - GET sem contexto é 200 vazio e NÃO escreve; funil comum é 404 nomeado;
 *   - a API audita e NÃO emite evento (o evento é do banco).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  dubleGreen,
  type DubleGreen,
  type OpcoesDoDubleGreen,
} from "../helpers/duble-green-produto";

const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const LEAD = "a0000000-0000-4000-8000-0000000000e1";
const PROD_ALFA = "a0000000-0000-4000-8000-0000000000a1";
const PROD_BETA = "a0000000-0000-4000-8000-0000000000a2";
const PROD_VELHO = "a0000000-0000-4000-8000-0000000000a3";
const PROD_DE_B = "b0000000-0000-4000-8000-0000000000b9";

const RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };
const h = vi.hoisted(() => ({
  papel: "manager" as string,
  orgId: "a0000000-0000-4000-8000-00000000000a" as string,
  db: null as unknown,
  audit: vi.fn(),
  apoio: vi.fn(),
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
        org: { orgId: h.orgId, role: h.papel },
      };
    },
  };
});
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.db }));

import { GET as listarProdutos, POST as criarProduto } from "@/app/api/v1/green/products/route";
import { PATCH as editarProduto } from "@/app/api/v1/green/products/[id]/route";
import {
  GET as lerContexto,
  PATCH as salvarContexto,
} from "@/app/api/v1/leads/[id]/green-context/route";

const produto = (id: string, org: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: org,
  code: `code_${id.slice(-2)}`,
  name: `Produto ${id.slice(-2)}`,
  description: null,
  family: "generic",
  is_active: true,
  metadata: {},
  created_at: "2026-10-07T12:00:00Z",
  updated_at: "2026-10-07T12:00:00Z",
  ...extra,
});
const lead = (extra: Record<string, unknown> = {}) => ({
  id: LEAD,
  organization_id: ORG_A,
  status: "open",
  ...extra,
});

function cenario(opts: OpcoesDoDubleGreen = {}): DubleGreen {
  const d = dubleGreen(opts);
  h.db = d.db;
  return d;
}
const req = (url: string, metodo: string, corpo?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: metodo,
    ...(corpo === undefined
      ? {}
      : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });
const ctxLead = (id = LEAD) => ({ params: Promise.resolve({ id }) });
const corpoDe = async (r: Response) => (await r.json()) as { data?: any; error?: { code: string } };

beforeEach(() => {
  h.papel = "manager";
  h.orgId = ORG_A;
  h.apoio.mockReset().mockResolvedValue(null);
  h.audit.mockReset();
});

/* ── catálogo ─────────────────────────────────────────────────────────────── */
describe("GET /green/products", () => {
  it("lista só os ativos da organização da sessão; viewer lê", async () => {
    h.papel = "viewer";
    cenario({
      produtos: [
        produto(PROD_ALFA, ORG_A),
        produto(PROD_VELHO, ORG_A, { is_active: false }),
        produto(PROD_DE_B, ORG_B),
      ],
    });
    const r = await listarProdutos(req("/api/v1/green/products", "GET"));
    expect(r.status).toBe(200);
    const { data } = await corpoDe(r);
    expect(data.map((p: any) => p.id)).toEqual([PROD_ALFA]);
  });

  it("include_inactive é de manager+: manager vê inativos, agent leva 403", async () => {
    cenario({
      produtos: [produto(PROD_ALFA, ORG_A), produto(PROD_VELHO, ORG_A, { is_active: false })],
    });
    const m = await listarProdutos(req("/api/v1/green/products?include_inactive=true", "GET"));
    expect((await corpoDe(m)).data).toHaveLength(2);
    h.papel = "agent";
    const a = await listarProdutos(req("/api/v1/green/products?include_inactive=true", "GET"));
    expect(a.status).toBe(403);
  });

  it("outro tenant não enxerga nada da organização A", async () => {
    h.orgId = ORG_B;
    cenario({ produtos: [produto(PROD_ALFA, ORG_A)] });
    const r = await listarProdutos(req("/api/v1/green/products", "GET"));
    expect((await corpoDe(r)).data).toEqual([]);
  });
});

describe("POST /green/products", () => {
  const corpo = { code: "produto_alfa", name: "Produto Alfa", family: "qualquer_familia" };

  it("manager cria (201), com a organização da SESSÃO, e audita", async () => {
    const d = cenario();
    const r = await criarProduto(
      req("/api/v1/green/products", "POST", { ...corpo, organization_id: ORG_B } as unknown),
    );
    // organization_id no corpo é chave desconhecida: o schema é estrito
    expect(r.status).toBe(422);

    const ok = await criarProduto(req("/api/v1/green/products", "POST", corpo));
    expect(ok.status).toBe(201);
    expect(d.produtos).toHaveLength(1);
    expect(d.produtos[0]).toMatchObject({
      organization_id: ORG_A,
      code: "produto_alfa",
      family: "qualquer_familia",
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "green.product.created", organizationId: ORG_A }),
    );
  });

  it("agent e viewer não cadastram (403), sem escrever", async () => {
    for (const papel of ["agent", "viewer"]) {
      h.papel = papel;
      const d = cenario();
      const r = await criarProduto(req("/api/v1/green/products", "POST", corpo));
      expect(r.status).toBe(403);
      expect(d.escritas).toHaveLength(0);
    }
  });

  it("code inválido e family inválida são 422", async () => {
    cenario();
    for (const ruim of [
      { ...corpo, code: "Alfa" },
      { ...corpo, code: "1alfa" },
      { ...corpo, code: "a" },
      { ...corpo, code: "alfa beta" },
      { ...corpo, family: "Familia Ruim" },
      { ...corpo, name: "   " },
    ]) {
      const r = await criarProduto(req("/api/v1/green/products", "POST", ruim));
      expect(r.status, JSON.stringify(ruim)).toBe(422);
    }
  });

  it("code duplicado na organização é 409 nomeado", async () => {
    cenario({ produtos: [produto(PROD_ALFA, ORG_A, { code: "produto_alfa" })] });
    const r = await criarProduto(req("/api/v1/green/products", "POST", corpo));
    expect(r.status).toBe(409);
    expect((await corpoDe(r)).error?.code).toBe("green_product_code_taken");
  });

  it("suporte em modo leitura não escreve", async () => {
    const d = cenario();
    const { NextResponse } = await import("next/server");
    h.apoio.mockResolvedValue(
      NextResponse.json({ error: { code: "support_read_only" } }, { status: 403 }),
    );
    const r = await criarProduto(req("/api/v1/green/products", "POST", corpo));
    expect(r.status).toBe(403);
    expect(d.escritas).toHaveLength(0);
  });
});

describe("PATCH /green/products/[id]", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("edita nome/família e inativa; audita; nunca apaga", async () => {
    const d = cenario({ produtos: [produto(PROD_ALFA, ORG_A)] });
    const r = await editarProduto(
      req(`/api/v1/green/products/${PROD_ALFA}`, "PATCH", { name: "Novo", is_active: false }),
      ctx(PROD_ALFA),
    );
    expect(r.status).toBe(200);
    expect(d.produtos[0]).toMatchObject({ name: "Novo", is_active: false });
    expect(d.produtos).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "green.product.updated",
        metadata: expect.objectContaining({ is_active: false }),
      }),
    );
  });

  it("code é identificador estável: tentar trocá-lo é 422 e não grava", async () => {
    const d = cenario({ produtos: [produto(PROD_ALFA, ORG_A)] });
    const r = await editarProduto(
      req(`/api/v1/green/products/${PROD_ALFA}`, "PATCH", { code: "outro_code" }),
      ctx(PROD_ALFA),
    );
    expect(r.status).toBe(422);
    expect(d.escritas).toHaveLength(0);
  });

  it("produto inexistente, id malformado e produto de OUTRA organização dão 404", async () => {
    cenario({ produtos: [produto(PROD_DE_B, ORG_B)] });
    for (const id of ["a0000000-0000-4000-8000-0000000000ff", "nao-e-uuid", PROD_DE_B]) {
      const r = await editarProduto(
        req(`/api/v1/green/products/${id}`, "PATCH", { name: "X" }),
        ctx(id),
      );
      expect(r.status, id).toBe(404);
    }
  });

  it("agent leva 403; corpo vazio é 422", async () => {
    cenario({ produtos: [produto(PROD_ALFA, ORG_A)] });
    h.papel = "agent";
    expect((await editarProduto(req("/x", "PATCH", { name: "X" }), ctx(PROD_ALFA))).status).toBe(
      403,
    );
    h.papel = "manager";
    expect((await editarProduto(req("/x", "PATCH", {}), ctx(PROD_ALFA))).status).toBe(422);
  });
});

/* ── contexto da oportunidade ─────────────────────────────────────────────── */
describe("GET /leads/[id]/green-context", () => {
  it("devolve o produto, inclusive INATIVO (histórico), e se é editável", async () => {
    cenario({
      leads: [lead()],
      leadsGreen: [LEAD],
      produtos: [produto(PROD_VELHO, ORG_A, { is_active: false, name: "Produto velho" })],
      contextos: [
        {
          lead_id: LEAD,
          organization_id: ORG_A,
          product_id: PROD_VELHO,
          created_at: "c",
          updated_at: "u",
        },
      ],
    });
    h.papel = "viewer";
    const r = await lerContexto(req(`/api/v1/leads/${LEAD}/green-context`, "GET"), ctxLead());
    expect(r.status).toBe(200);
    const { data } = await corpoDe(r);
    expect(data.editable).toBe(true);
    expect(data.context.product).toMatchObject({
      id: PROD_VELHO,
      name: "Produto velho",
      is_active: false,
    });
  });

  it("sem contexto: 200 com context null e NENHUMA escrita", async () => {
    const d = cenario({ leads: [lead()], leadsGreen: [LEAD] });
    const r = await lerContexto(req(`/api/v1/leads/${LEAD}/green-context`, "GET"), ctxLead());
    expect(r.status).toBe(200);
    expect((await corpoDe(r)).data.context).toBeNull();
    expect(d.escritas).toHaveLength(0);
    expect(d.contextos).toHaveLength(0);
  });

  it("negócio ganho/perdido volta editable=false", async () => {
    cenario({ leads: [lead({ status: "won" })], leadsGreen: [LEAD] });
    const r = await lerContexto(req(`/api/v1/leads/${LEAD}/green-context`, "GET"), ctxLead());
    expect((await corpoDe(r)).data.editable).toBe(false);
  });

  it("funil comum = 404 green_context_not_applicable; lead inexistente/de outra org = 404 not_found", async () => {
    cenario({ leads: [lead()], leadsGreen: [] });
    const comum = await lerContexto(req("/x", "GET"), ctxLead());
    expect(comum.status).toBe(404);
    expect((await corpoDe(comum)).error?.code).toBe("green_context_not_applicable");

    cenario({ leads: [lead({ organization_id: ORG_B })], leadsGreen: [LEAD] });
    const alheio = await lerContexto(req("/x", "GET"), ctxLead());
    expect(alheio.status).toBe(404);
    expect((await corpoDe(alheio)).error?.code).toBe("not_found");
    expect((await lerContexto(req("/x", "GET"), ctxLead("nao-e-uuid"))).status).toBe(404);
  });
});

describe("PATCH /leads/[id]/green-context", () => {
  const base = (extra: OpcoesDoDubleGreen = {}) =>
    cenario({
      leads: [lead()],
      leadsGreen: [LEAD],
      produtos: [
        produto(PROD_ALFA, ORG_A, { name: "Alfa" }),
        produto(PROD_BETA, ORG_A, { name: "Beta" }),
        produto(PROD_VELHO, ORG_A, { is_active: false }),
        produto(PROD_DE_B, ORG_B),
      ],
      ...extra,
    });
  const salvar = (productId: unknown) =>
    salvarContexto(
      req(`/api/v1/leads/${LEAD}/green-context`, "PATCH", { product_id: productId }),
      ctxLead(),
    );

  it("primeiro save cria o contexto; o seguinte troca; audita cada mudança", async () => {
    h.papel = "agent";
    const d = base();
    const r1 = await salvar(PROD_ALFA);
    expect(r1.status).toBe(200);
    expect(d.contextos).toHaveLength(1);
    expect(d.escritas.map((e) => e.operacao)).toEqual(["insert"]);
    expect(h.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "green.lead_context.updated",
        metadata: expect.objectContaining({
          change: "product_assigned",
          previous_product_id: null,
        }),
      }),
    );

    const r2 = await salvar(PROD_BETA);
    expect(r2.status).toBe(200);
    expect(d.contextos).toHaveLength(1);
    expect(d.contextos[0]).toMatchObject({ product_id: PROD_BETA });
    expect(h.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          change: "product_changed",
          previous_product_id: PROD_ALFA,
        }),
      }),
    );
    expect((await corpoDe(r2)).data.context.product.name).toBe("Beta");
  });

  it("repetir o mesmo produto é idempotente: sem escrita, sem auditoria nova", async () => {
    const d = base({
      contextos: [
        {
          lead_id: LEAD,
          organization_id: ORG_A,
          product_id: PROD_ALFA,
          created_at: "c",
          updated_at: "u",
        },
      ],
    });
    const r = await salvar(PROD_ALFA);
    expect(r.status).toBe(200);
    expect(d.escritas).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a rota NÃO emite evento: nada de emit_event/fn_log_event (o produtor é o banco)", async () => {
    const d = base();
    await salvar(PROD_ALFA);
    expect(d.rpcs.length).toBeGreaterThan(0);
    expect(d.rpcs.every((x) => x.nome === "fn_green_lead_eligible")).toBe(true);
    expect(d.rpcs.some((x) => /event/i.test(x.nome))).toBe(false);
    expect(d.escritas.every((e) => e.tabela === "green_lead_context")).toBe(true);
  });

  it("viewer não grava (403); agent grava", async () => {
    h.papel = "viewer";
    const d = base();
    expect((await salvar(PROD_ALFA)).status).toBe(403);
    expect(d.escritas).toHaveLength(0);
  });

  it("produto inexistente e produto de OUTRA organização: a mesma resposta 422", async () => {
    base();
    const sumido = await salvar("a0000000-0000-4000-8000-0000000000ff");
    const alheio = await salvar(PROD_DE_B);
    for (const r of [sumido, alheio]) {
      expect(r.status).toBe(422);
      expect((await corpoDe(r)).error?.code).toBe("green_product_not_found");
    }
  });

  it("produto inativo é recusado para nova associação (422), sem escrever", async () => {
    const d = base();
    const r = await salvar(PROD_VELHO);
    expect(r.status).toBe(422);
    expect((await corpoDe(r)).error?.code).toBe("green_product_inactive");
    expect(d.escritas).toHaveLength(0);
  });

  it("oportunidade ganha/perdida não troca de produto (409), sem escrever", async () => {
    for (const status of ["won", "lost"]) {
      const d = base({ leads: [lead({ status })] });
      const r = await salvar(PROD_ALFA);
      expect(r.status, status).toBe(409);
      expect((await corpoDe(r)).error?.code).toBe("green_context_lead_closed");
      expect(d.escritas).toHaveLength(0);
    }
  });

  it("a recusa do BANCO também vira a resposta certa (corrida: fechou/inativou entre a leitura e a escrita)", async () => {
    const casos: [string, number, string][] = [
      ["green_context_lead_closed", 409, "green_context_lead_closed"],
      ["green_product_inactive", 422, "green_product_inactive"],
      ["green_context_outside_binding", 422, "green_context_outside_binding"],
    ];
    for (const [mensagem, status, codigo] of casos) {
      base({ falhas: { "green_lead_context.insert": { code: "23514", message: mensagem } } });
      const r = await salvar(PROD_ALFA);
      expect(r.status, mensagem).toBe(status);
      expect((await corpoDe(r)).error?.code).toBe(codigo);
    }
    // RLS do banco (policy) sem mensagem nomeada = 403, nunca 500
    base({
      falhas: {
        "green_lead_context.insert": {
          code: "42501",
          message: "new row violates row-level security policy",
        },
      },
    });
    expect((await salvar(PROD_ALFA)).status).toBe(403);
  });

  it("funil comum = 422; lead de outra organização/inexistente = 404", async () => {
    base({ leadsGreen: [] });
    const comum = await salvar(PROD_ALFA);
    expect(comum.status).toBe(422);
    expect((await corpoDe(comum)).error?.code).toBe("green_context_outside_binding");

    base({ leads: [lead({ organization_id: ORG_B })] });
    expect((await salvar(PROD_ALFA)).status).toBe(404);
  });

  it("corpo inválido: sem product_id, não-uuid ou chave extra (organization_id, pipeline_id) é 422", async () => {
    const d = base();
    for (const corpo of [
      {},
      { product_id: "x" },
      { product_id: PROD_ALFA, organization_id: ORG_B },
      { product_id: PROD_ALFA, pipeline_id: LEAD },
    ]) {
      const r = await salvarContexto(req("/x", "PATCH", corpo), ctxLead());
      expect(r.status, JSON.stringify(corpo)).toBe(422);
    }
    expect(d.escritas).toHaveLength(0);
  });
});
