import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/green/products/[id] — edita nome, descrição, família, metadata e `is_active`.
 *
 * `code` é o identificador estável do produto: o schema é `.strict()`, então um corpo com
 * `code` vira 422 (em vez de ser descartado em silêncio) e o banco ainda recusa a troca.
 * Inativar NÃO apaga: o produto continua existindo para as oportunidades que já o usam.
 * Não há DELETE de propósito.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { atualizarProdutoSchema } from "@/lib/green/produto/schemas";
import { atualizarProduto } from "@/lib/green/produto/servico";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "green_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  // id malformado é "não existe": nunca chega ao banco como erro de sintaxe
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  const parsed = atualizarProdutoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const r = await atualizarProduto(supabase, org.orgId, id, parsed.data);
  if (!r.ok) {
    if (r.falha === "nao_encontrado") {
      return fail("not_found", t("Produto não encontrado."), 404, { requestId });
    }
    if (r.falha === "sem_permissao") {
      return fail("forbidden_role", t("Sem permissão para editar produtos."), 403, { requestId });
    }
    return fail("internal_error", t("Erro ao atualizar produto."), 500, { requestId });
  }

  void audit({
    action: "green.product.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "green_product",
    resourceId: r.produto.id,
    requestId,
    metadata: {
      fields: Object.keys(parsed.data),
      ...(parsed.data.is_active !== undefined ? { is_active: parsed.data.is_active } : {}),
    },
  });
  return ok(r.produto, { requestId });
}
