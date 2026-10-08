/**
 * Configurações → Produtos Green. O catálogo do que a organização vende pelo ConectorGreen.
 *
 * ── O que esta tela NÃO é ────────────────────────────────────────────────────
 *
 * Não é um catálogo de loja: não há preço, estoque, comissão, região, oferta nem combo. É a
 * lista aberta de produtos que uma oportunidade Green pode ter como produto principal.
 * Também não é uma lista de funis: cadastrar um produto não cria funil, e o funil não filtra
 * produto. `catalog_products` (a mercadoria da loja) é outro domínio e não é lido aqui.
 *
 * ── Por que `manager` ────────────────────────────────────────────────────────
 *
 * Mesmo gate do banco (`fn_role_at_least(org, 'manager')` nas policies de `green_products`),
 * sem atalho de platform admin: a tela e o banco dizem a mesma coisa.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { PainelDeProdutosGreen } from "./_painel";

export const metadata = { title: "Produtos Green" };
export const dynamic = "force-dynamic";

export default async function ProdutosGreenPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Produtos Green")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Os produtos que esta organização vende. Cada negócio de um funil Green tem um produto principal; o produto não define o funil e nenhum funil novo nasce de um produto.",
          )}
        </p>
      </header>
      <PainelDeProdutosGreen />
    </div>
  );
}
