"use client";
import Link from "next/link";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useContextoGreen, chaveContextoGreen } from "@/hooks/green/useContextoGreen";
import { useProdutosGreen } from "@/hooks/green/useProdutosGreen";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { ContextoGreenDaOportunidade } from "@/lib/green/produto/schemas";

interface Props {
  leadId: string;
  /** `agent`+ grava; o dossiê já sabe o papel de quem está vendo. */
  podeEditar: boolean;
  /** `manager`+ cadastra produtos: só ele recebe o atalho para o catálogo. */
  podeCadastrar?: boolean;
}

/**
 * Seção "Produto Green" do dossiê: o produto principal da oportunidade.
 *
 * - Só aparece em oportunidade de funil Green (a rota responde 404 nos outros e a seção some).
 * - O produto NÃO muda o funil: trocar de produto aqui não move a oportunidade, não cria funil
 *   e não grava etiqueta.
 * - Produto inativo já associado continua visível (com o aviso "inativo"); o seletor só oferece
 *   produtos ativos.
 * - Negócio ganho ou perdido mostra o produto e não deixa trocá-lo.
 */
export function ContextoGreenDoNegocio({
  leadId,
  podeEditar,
  podeCadastrar = false,
}: Props): React.ReactElement | null {
  const t = useT();
  const qc = useQueryClient();
  const contexto = useContextoGreen(leadId);
  const editavel = contexto.data?.editable === true && podeEditar;
  const produtos = useProdutosGreen({ enabled: editavel });
  const atual = contexto.data?.context?.product_id ?? "";
  const [escolhido, setEscolhido] = React.useState<string | null>(null);
  const valor = escolhido ?? atual;

  const salvar = useMutation({
    mutationFn: async (productId: string) =>
      apiClient.patch<{ data: ContextoGreenDaOportunidade }>(
        `/api/v1/leads/${leadId}/green-context`,
        { product_id: productId },
      ),
    onError: showApiError,
    onSuccess: (res) => {
      qc.setQueryData(chaveContextoGreen(leadId), res);
      setEscolhido(null);
      toast.success(t("Produto Green salvo."));
    },
  });

  // Funil comum (404), falha de leitura ou carregando sem dado: o dossiê segue inteiro.
  if (contexto.isError) return null;
  if (contexto.isLoading || !contexto.data) {
    return (
      <div className="border-t border-border pt-3">
        <p className="text-xs text-text-muted">{t("Carregando…")}</p>
      </div>
    );
  }

  const dados = contexto.data;
  const produtoAtual = dados.context?.product ?? null;
  const ativos = produtos.data ?? [];

  return (
    <section className="border-t border-border pt-3" data-testid="contexto-green">
      <h3 className="mb-2 text-xs font-medium tracking-wide text-text-muted uppercase">
        {t("Produto Green")}
      </h3>
      <p className="mb-2 text-xs text-text-muted">
        {t("O que está sendo vendido neste negócio. Trocar o produto não muda o funil.")}
      </p>

      <div className="mb-2 text-sm" data-testid="produto-atual">
        {produtoAtual ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-medium">{produtoAtual.name}</span>
            {!produtoAtual.is_active && <Badge variant="neutral">{t("Produto inativo")}</Badge>}
          </span>
        ) : (
          <span className="text-text-muted">{t("Nenhum produto definido")}</span>
        )}
      </div>

      {!dados.editable && (
        <p className="text-xs text-text-muted">
          {t("Negócio ganho ou perdido: o produto não pode mais ser trocado.")}
        </p>
      )}

      {editavel && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valor) salvar.mutate(valor);
          }}
        >
          {ativos.length === 0 && !produtos.isLoading ? (
            <p className="text-xs text-text-muted">
              {t("Nenhum produto ativo no catálogo.")}{" "}
              {podeCadastrar && (
                <Link href="/app/settings/produtos-green" className="text-accent hover:underline">
                  {t("Cadastrar produtos")}
                </Link>
              )}
            </p>
          ) : (
            <>
              <label className="text-xs text-text-muted" htmlFor={`produto-green-${leadId}`}>
                {t("Produto")}
              </label>
              <select
                id={`produto-green-${leadId}`}
                aria-label={t("Produto")}
                className="rounded-md border border-border bg-background p-2 text-sm"
                value={ativos.some((p) => p.id === valor) ? valor : ""}
                onChange={(e) => setEscolhido(e.target.value)}
                disabled={salvar.isPending}
              >
                <option value="" disabled>
                  {produtoAtual && !produtoAtual.is_active
                    ? t("Escolha um produto ativo")
                    : t("Selecione um produto")}
                </option>
                {ativos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                size="sm"
                className="self-start"
                disabled={salvar.isPending || !valor || valor === atual}
              >
                {t("Salvar produto")}
              </Button>
            </>
          )}
        </form>
      )}
    </section>
  );
}
