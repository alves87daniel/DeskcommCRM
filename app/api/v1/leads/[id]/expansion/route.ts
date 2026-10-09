import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/leads/[id]/expansion — a relação comercial da oportunidade (CG-COM-01).
 * POST /api/v1/leads/[id]/expansion — abre uma EXPANSÃO a partir desta oportunidade ganha.
 *
 * GET (viewer+): de qual oportunidade esta nasceu (`origin`), quais nasceram dela
 * (`expansions`), se ela origina expansão (`eligibility`: ganha e com contato) e, para quem
 * pode criar (agent+), os funis Green com etapa aberta (`destinations`) e o produto sugerido.
 * Só leitura: nunca escreve.
 *
 * POST (agent+): cria uma oportunidade NOVA, do MESMO contato, no funil Green e com o produto
 * escolhidos, ligada a esta por `crm_lead_links (commercial_origin)`. Esta oportunidade NÃO é
 * tocada: continua ganha, no mesmo funil, com o histórico intacto. A escrita é
 * `expandirLeadHandler` (oportunidade + produto + vínculo numa transação, migration 0510).
 *
 *   201 `{ created: true, lead, link_id, origin_lead_id }` — expansão criada;
 *   200 `{ created: false, lead, ... }` — já havia expansão ABERTA desta origem com este produto
 *       (idempotente: nada é escrito, nenhum evento, nenhuma auditoria);
 *   `Idempotency-Key: <uuid>` opcional: a mesma chave com o mesmo corpo devolve a resposta
 *       gravada (`lib/api/idempotency.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { expandirLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { criarExpansaoSchema, type ResultadoDaExpansao } from "@/lib/green/expansao/schemas";
import { lerExpansaoDaOportunidade } from "@/lib/green/expansao/servico";
// A rota declara a boundary de requisição do MutationContext, como as outras que gravam
// oportunidade (clone, move, win, lose).
import { runGreenRequestBoundary } from "@/lib/green/mutation-context";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const ENDPOINT_IDEMPOTENCIA = "/api/v1/leads/{id}/expansion";
const idValido = (id: string) => z.string().uuid().safeParse(id).success;

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  if (!idValido(id)) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const supabase = await createClient();
  const r = await lerExpansaoDaOportunidade(supabase, authz.org.orgId, id, {
    // informativo (a escrita revalida papel na rota e na RLS): só quem cria vê os destinos
    podeCriar: roleAtLeast(authz.org.role, "agent"),
  });
  switch (r.tipo) {
    case "ok":
      return ok(r.expansao, { requestId });
    case "lead_nao_encontrado":
      return fail("not_found", t("Lead não encontrado."), 404, { requestId });
    default:
      return fail("internal_error", t("Erro ao ler as oportunidades relacionadas."), 500, {
        requestId,
      });
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return runGreenRequestBoundary(() => handlePOST(req, ctx));
}

async function handlePOST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  // spec 13 §4: escrita é agent+ (viewer é read-only), a mesma régua da criação de lead.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  if (!idValido(id)) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_failed", t("Idempotency-Key deve ser UUID"), 400, { requestId });
  }

  const parsed = criarExpansaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const handlerCtx: HandlerCtx = {
    // A organização vem da SESSÃO, nunca do corpo (o schema é `.strict()`).
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };
  const executar = async () => {
    const resultado = await expandirLeadHandler(supabase, handlerCtx, id, parsed.data);
    return { resposta: resultado, status: resultado.created ? 201 : 200 } as const;
  };

  try {
    if (chave === null) {
      const { resposta, status } = await executar();
      return ok(resposta, { requestId, status });
    }
    const desfecho = await comIdempotencia<ResultadoDaExpansao>({
      db: supabase,
      organizationId: authz.org.orgId,
      endpoint: ENDPOINT_IDEMPOTENCIA,
      chave,
      corpo: { lead_id: id, ...parsed.data },
      executar,
    });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }
    // o recibo guarda o status da primeira execução: 201 (criou) ou 200 (já existia)
    return ok(desfecho.resposta, { requestId, status: desfecho.status === 201 ? 201 : 200 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
