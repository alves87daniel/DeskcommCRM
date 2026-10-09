"use client";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { chaveExpansao } from "@/hooks/green/useExpansao";
import { useProdutosGreen } from "@/hooks/green/useProdutosGreen";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type {
  CriarExpansaoInput,
  DestinoDaExpansao,
  ResultadoDaExpansao,
} from "@/lib/green/expansao/schemas";
import { parseReaisToCents } from "@/lib/money";
import { randomId } from "@/lib/random-id";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  /** Funis Green com etapa aberta (o servidor já filtrou). */
  destinos: DestinoDaExpansao[];
  /** O produto do negócio ganho, se ativo. */
  produtoSugerido: string | null;
  tituloSugerido: string;
}

const SELECT =
  "w-full rounded-md border border-border bg-background p-2 text-sm disabled:opacity-60";

/**
 * "Nova oportunidade de expansão" — a tela de `POST /api/v1/leads/[id]/expansion`.
 *
 * Escolhe o funil Green, a etapa, o produto, o título e (opcionalmente) o valor da oportunidade
 * nova. O contato é o do negócio ganho: não há campo de contato, porque a expansão nunca cria
 * outro. Um envio repetido (duplo clique, rede lenta) leva a MESMA `Idempotency-Key` e recebe a
 * mesma resposta; se já existir expansão aberta deste negócio com o produto escolhido, o servidor
 * devolve ela em vez de criar outra, e a tela diz isso.
 */
export function NovaExpansaoDialog({
  open,
  onOpenChange,
  leadId,
  destinos,
  produtoSugerido,
  tituloSugerido,
}: Props): React.ReactElement {
  const t = useT();
  const qc = useQueryClient();
  const produtos = useProdutosGreen({ enabled: open });
  const ativos = produtos.data ?? [];

  const inicial = React.useCallback(
    () => ({
      funil: destinos[0]?.pipeline_id ?? "",
      etapa: destinos[0]?.stages[0]?.id ?? "",
      produto: produtoSugerido ?? "",
      titulo: tituloSugerido,
      valor: "",
      // uma chave por abertura do diálogo: o reenvio do MESMO pedido é replay, não duplicata
      chave: randomId(),
    }),
    [destinos, produtoSugerido, tituloSugerido],
  );
  const [form, setForm] = React.useState(inicial);
  const [erroDoValor, setErroDoValor] = React.useState<string | null>(null);
  // Recomeça só quando o diálogo ABRE: um refetch da relação com o diálogo aberto não pode apagar
  // o que a pessoa digitou nem trocar a chave do pedido.
  const abertoAntes = React.useRef(open);
  React.useEffect(() => {
    if (open && !abertoAntes.current) {
      setForm(inicial());
      setErroDoValor(null);
    }
    abertoAntes.current = open;
  }, [open, inicial]);

  const destino = destinos.find((d) => d.pipeline_id === form.funil);
  const produtoValido = ativos.some((p) => p.id === form.produto);

  const criar = useMutation({
    mutationFn: async (corpo: CriarExpansaoInput) =>
      apiClient.post<{ data: ResultadoDaExpansao }>(`/api/v1/leads/${leadId}/expansion`, corpo, {
        idempotencyKey: form.chave,
      }),
    onError: showApiError,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: chaveExpansao(leadId) });
      // a oportunidade nova aparece no quadro do funil dela
      void qc.invalidateQueries({ queryKey: ["board"] });
      toast.success(
        res.data.created
          ? t("Oportunidade de expansão criada.")
          : t("Já existe uma expansão aberta deste negócio com este produto."),
      );
      onOpenChange(false);
    },
  });

  const enviar = () => {
    if (!destino || !produtoValido || criar.isPending) return;
    let valor: number | null = null;
    if (form.valor.trim()) {
      valor = parseReaisToCents(form.valor);
      if (valor === null) {
        setErroDoValor(t("Valor inválido"));
        return;
      }
    }
    setErroDoValor(null);
    criar.mutate({
      pipeline_id: form.funil,
      stage_id: form.etapa || null,
      product_id: form.produto,
      title: form.titulo.trim(),
      ...(valor !== null ? { value_cents: valor } : {}),
    });
  };

  const tituloValido = form.titulo.trim().length >= 2;
  const semProduto = ativos.length === 0 && !produtos.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Nova oportunidade de expansão")}</DialogTitle>
          <DialogDescription>
            {t(
              "Cria uma nova oportunidade para o mesmo contato, ligada a este negócio. Este negócio continua ganho, no mesmo funil, com o histórico intacto.",
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enviar();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`expansao-funil-${leadId}`}>{t("Funil")}</Label>
            <select
              id={`expansao-funil-${leadId}`}
              className={SELECT}
              value={form.funil}
              disabled={criar.isPending}
              onChange={(e) => {
                const novo = destinos.find((d) => d.pipeline_id === e.target.value);
                setForm((f) => ({
                  ...f,
                  funil: e.target.value,
                  etapa: novo?.stages[0]?.id ?? "",
                }));
              }}
            >
              {destinos.map((d) => (
                <option key={d.pipeline_id} value={d.pipeline_id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`expansao-etapa-${leadId}`}>{t("Etapa")}</Label>
            <select
              id={`expansao-etapa-${leadId}`}
              className={SELECT}
              value={form.etapa}
              disabled={criar.isPending}
              onChange={(e) => setForm((f) => ({ ...f, etapa: e.target.value }))}
            >
              {(destino?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`expansao-produto-${leadId}`}>{t("Produto")}</Label>
            {semProduto ? (
              <p className="text-xs text-text-muted">{t("Nenhum produto ativo no catálogo.")}</p>
            ) : (
              <select
                id={`expansao-produto-${leadId}`}
                className={SELECT}
                value={produtoValido ? form.produto : ""}
                disabled={criar.isPending}
                onChange={(e) => setForm((f) => ({ ...f, produto: e.target.value }))}
              >
                <option value="" disabled>
                  {t("Selecione um produto")}
                </option>
                {ativos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`expansao-titulo-${leadId}`}>{t("Título")}</Label>
            <Input
              id={`expansao-titulo-${leadId}`}
              value={form.titulo}
              maxLength={200}
              disabled={criar.isPending}
              onChange={(e) => setForm((f) => ({ ...f, titulo: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`expansao-valor-${leadId}`}>{t("Valor (opcional)")}</Label>
            <Input
              id={`expansao-valor-${leadId}`}
              inputMode="decimal"
              value={form.valor}
              disabled={criar.isPending}
              onChange={(e) => setForm((f) => ({ ...f, valor: e.target.value }))}
            />
            {erroDoValor && <p className="text-xs text-error-fg">{erroDoValor}</p>}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={criar.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button
              type="submit"
              disabled={
                !destino || !form.etapa || !produtoValido || !tituloValido || criar.isPending
              }
            >
              {criar.isPending ? t("Salvando...") : t("Criar oportunidade")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
