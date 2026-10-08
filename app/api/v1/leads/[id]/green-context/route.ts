import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/leads/[id]/green-context — o produto principal da oportunidade Green.
 * PATCH /api/v1/leads/[id]/green-context — atribui ou troca o produto principal.
 *
 * GET sem contexto responde 200 com `context: null` (não é erro e NÃO cria linha). Oportunidade
 * fora de funil Green responde 404 `green_context_not_applicable`.
 *
 * PATCH: o primeiro save cria o contexto; os seguintes trocam o produto. Exige `agent` e a
 * visibilidade do lead (RLS do operador); a oportunidade precisa estar `open` e o produto
 * precisa ser ativo e da organização. Pedir o produto que já está lá é idempotente (200, sem
 * escrita, sem evento). O evento `lead.green_context_changed` é emitido pelo BANCO, na transação:
 * esta rota só audita.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { salvarContextoSchema } from "@/lib/green/produto/schemas";
import {
  lerContextoDaOportunidade,
  salvarContextoDaOportunidade,
  type FalhaDoContexto,
} from "@/lib/green/produto/servico";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const idValido = (id: string) => z.string().uuid().safeParse(id).success;

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await ctx.params;

  if (!idValido(id)) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const supabase = await createClient();
  const r = await lerContextoDaOportunidade(supabase, org.orgId, id);
  switch (r.tipo) {
    case "ok":
      return ok(r.contexto, { requestId });
    case "lead_nao_encontrado":
      return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
    case "nao_aplicavel":
      return fail(
        "green_context_not_applicable",
        t("Este negócio não está num funil Green."),
        404,
        { requestId },
      );
    default:
      return fail("internal_error", t("Erro ao ler o contexto Green."), 500, { requestId });
  }
}

function respostaDeFalha(
  falha: FalhaDoContexto,
  t: (texto: string) => string,
  requestId: string,
): Response {
  switch (falha) {
    case "lead_nao_encontrado":
      return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
    case "nao_aplicavel":
      return fail(
        "green_context_outside_binding",
        t("Este negócio não está num funil Green."),
        422,
        { requestId },
      );
    case "produto_nao_encontrado":
      return fail("green_product_not_found", t("Produto não encontrado."), 422, { requestId });
    case "produto_inativo":
      return fail(
        "green_product_inactive",
        t("Este produto está inativo e não pode ser atribuído."),
        422,
        { requestId },
      );
    case "oportunidade_fechada":
      return fail(
        "green_context_lead_closed",
        t("Negócio ganho ou perdido não troca de produto."),
        409,
        { requestId },
      );
    case "sem_permissao":
      return fail("forbidden_role", t("Sem permissão para alterar este negócio."), 403, {
        requestId,
      });
    default:
      return fail("internal_error", t("Erro ao salvar o contexto Green."), 500, { requestId });
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await ctx.params;

  if (!idValido(id)) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const parsed = salvarContextoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const r = await salvarContextoDaOportunidade(supabase, org.orgId, id, parsed.data.product_id);
  if (!r.ok) return respostaDeFalha(r.falha, t, requestId);

  if (r.mudanca !== "unchanged") {
    void audit({
      action: "green.lead_context.updated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "crm_lead",
      resourceId: id,
      requestId,
      metadata: {
        change: r.mudanca,
        product_id: parsed.data.product_id,
        previous_product_id: r.produto_anterior,
      },
    });
  }
  return ok(r.contexto, { requestId });
}
