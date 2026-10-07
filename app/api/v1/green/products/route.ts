import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/green/products — catálogo de produtos Green da organização ativa.
 *      Por padrão só os ATIVOS (é o que o seletor da oportunidade oferece);
 *      `?include_inactive=true` (manager+) traz também os inativos, para a tela de configuração.
 * POST /api/v1/green/products — cadastra um produto (manager+).
 *
 * A organização vem da sessão (`requireRole`), nunca do corpo. O produto é independente de
 * funil e de tag: nada aqui cria funil, move oportunidade ou grava etiqueta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { criarProdutoSchema } from "@/lib/green/produto/schemas";
import { criarProduto, listarProdutos } from "@/lib/green/produto/servico";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "green_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const incluirInativos = req.nextUrl.searchParams.get("include_inactive") === "true";
  if (incluirInativos && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden_role", t("Só manager+ vê produtos inativos."), 403, { requestId });
  }

  const supabase = await createClient();
  const r = await listarProdutos(supabase, org.orgId, { incluirInativos });
  if (!r.ok) return fail("internal_error", t("Erro ao listar produtos."), 500, { requestId });
  return ok(r.produtos, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "green_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarProdutoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const r = await criarProduto(supabase, org.orgId, parsed.data);
  if (!r.ok) {
    if (r.falha === "codigo_duplicado") {
      return fail("green_product_code_taken", t("Já existe um produto com este código."), 409, {
        requestId,
      });
    }
    if (r.falha === "sem_permissao") {
      return fail("forbidden_role", t("Sem permissão para cadastrar produtos."), 403, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao cadastrar produto."), 500, { requestId });
  }

  void audit({
    action: "green.product.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "green_product",
    resourceId: r.produto.id,
    requestId,
    metadata: { code: r.produto.code, family: r.produto.family },
  });
  return ok(r.produto, { requestId, status: 201 });
}
