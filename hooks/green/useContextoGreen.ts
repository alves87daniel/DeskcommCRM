"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ContextoGreenDaOportunidade } from "@/lib/green/produto/schemas";

export const chaveContextoGreen = (leadId: string) => ["green", "lead-context", leadId] as const;

/**
 * Produto principal da oportunidade. 404 (`green_context_not_applicable`) quer dizer "o funil
 * não é Green": a seção some, não é erro de tela. Sem contexto gravado volta 200 com
 * `context: null`.
 */
export function useContextoGreen(leadId: string) {
  return useQuery({
    queryKey: chaveContextoGreen(leadId),
    queryFn: async () =>
      apiClient.get<{ data: ContextoGreenDaOportunidade }>(`/api/v1/leads/${leadId}/green-context`),
    retry: false,
    select: (res) => res.data,
  });
}
