"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ProdutoGreen } from "@/lib/green/produto/schemas";

export const CHAVE_PRODUTOS_GREEN = ["green", "products"] as const;

/**
 * Catálogo de produtos Green da organização ativa. Por padrão só os ATIVOS (o que o seletor
 * da oportunidade oferece); a tela de configuração pede também os inativos (manager+).
 */
export function useProdutosGreen(opts: { incluirInativos?: boolean; enabled?: boolean } = {}) {
  const incluirInativos = opts.incluirInativos === true;
  return useQuery({
    queryKey: [...CHAVE_PRODUTOS_GREEN, incluirInativos ? "todos" : "ativos"],
    enabled: opts.enabled ?? true,
    queryFn: async () =>
      apiClient.get<{ data: ProdutoGreen[] }>(
        `/api/v1/green/products${incluirInativos ? "?include_inactive=true" : ""}`,
      ),
    staleTime: 30_000,
    select: (res) => res.data,
  });
}
