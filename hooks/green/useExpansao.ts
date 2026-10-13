"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ExpansaoDaOportunidade } from "@/lib/green/expansao/schemas";

export const chaveExpansao = (leadId: string) => ["green", "expansion", leadId] as const;

/**
 * A relação comercial da oportunidade (CG-COM-01): de onde ela nasceu, as expansões que nasceram
 * dela, se ela origina expansão e para quais funis Green. Falha de leitura esconde a seção (o
 * dossiê segue inteiro); não é erro de tela.
 */
export function useExpansao(leadId: string) {
  return useQuery({
    queryKey: chaveExpansao(leadId),
    queryFn: async () =>
      apiClient.get<{ data: ExpansaoDaOportunidade }>(`/api/v1/leads/${leadId}/expansion`),
    retry: false,
    select: (res) => res.data,
  });
}
