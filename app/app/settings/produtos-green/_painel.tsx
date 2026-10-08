"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CHAVE_PRODUTOS_GREEN, useProdutosGreen } from "@/hooks/green/useProdutosGreen";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  CODIGO_DE_PRODUTO,
  FAMILIA_DE_PRODUTO,
  FAMILIA_PADRAO,
  type ProdutoGreen,
} from "@/lib/green/produto/schemas";

/** Catálogo aberto: lista, cadastra, edita nome/descrição/família e ativa/inativa. Nunca apaga. */
export function PainelDeProdutosGreen(): React.ReactElement {
  const t = useT();
  const qc = useQueryClient();
  const produtos = useProdutosGreen({ incluirInativos: true });
  const [dialogo, setDialogo] = React.useState<{ aberto: boolean; produto: ProdutoGreen | null }>({
    aberto: false,
    produto: null,
  });

  const alternar = useMutation({
    mutationFn: async (p: ProdutoGreen) =>
      apiClient.patch(`/api/v1/green/products/${p.id}`, { is_active: !p.is_active }),
    onError: showApiError,
    onSuccess: (_res, p) => {
      void qc.invalidateQueries({ queryKey: CHAVE_PRODUTOS_GREEN });
      toast.success(p.is_active ? t("Produto inativado.") : t("Produto ativado."));
    },
  });

  if (produtos.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (produtos.isError) {
    // A falha NÃO vira "nenhum produto": convidaria a recadastrar tudo.
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
        {t("Não foi possível carregar os produtos agora. Recarregue a página.")}
      </div>
    );
  }

  const lista = produtos.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex sm:justify-end">
        <Button
          type="button"
          className="w-full sm:w-auto"
          onClick={() => setDialogo({ aberto: true, produto: null })}
        >
          {t("Novo produto")}
        </Button>
      </div>

      {lista.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum produto cadastrado ainda.")}</p>
      ) : (
        <ul className="space-y-2" data-testid="lista-de-produtos-green">
          {lista.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-4 rounded-md border bg-card p-4"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Badge variant={p.is_active ? "default" : "neutral"}>
                    {p.is_active ? t("Ativo") : t("Inativo")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{p.code}</span> · {p.family}
                </p>
                {p.description && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialogo({ aberto: true, produto: p })}
                >
                  {t("Editar")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={alternar.isPending}
                  onClick={() => alternar.mutate(p)}
                >
                  {p.is_active ? t("Inativar") : t("Ativar")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <FormularioDeProduto
        aberto={dialogo.aberto}
        produto={dialogo.produto}
        onOpenChange={(aberto) => setDialogo((d) => ({ ...d, aberto }))}
      />
    </div>
  );
}

interface FormularioProps {
  aberto: boolean;
  produto: ProdutoGreen | null;
  onOpenChange: (aberto: boolean) => void;
}

function FormularioDeProduto({ aberto, produto, onOpenChange }: FormularioProps) {
  const t = useT();
  const qc = useQueryClient();
  const edicao = produto !== null;
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [family, setFamily] = React.useState(FAMILIA_PADRAO);

  /* eslint-disable react-hooks/set-state-in-effect -- o formulário reinicia ao abrir, como TemplateFormDialog */
  React.useEffect(() => {
    if (!aberto) return;
    setCode(produto?.code ?? "");
    setName(produto?.name ?? "");
    setDescription(produto?.description ?? "");
    setFamily(produto?.family ?? FAMILIA_PADRAO);
  }, [aberto, produto]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const salvar = useMutation({
    mutationFn: async () =>
      edicao
        ? apiClient.patch(`/api/v1/green/products/${produto.id}`, {
            name,
            description: description.trim() || null,
            family,
          })
        : apiClient.post("/api/v1/green/products", {
            code,
            name,
            description: description.trim() || undefined,
            family,
          }),
    onError: showApiError,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE_PRODUTOS_GREEN });
      toast.success(edicao ? t("Produto atualizado.") : t("Produto cadastrado."));
      onOpenChange(false);
    },
  });

  const codigoValido = edicao || CODIGO_DE_PRODUTO.test(code);
  const familiaValida = FAMILIA_DE_PRODUTO.test(family);

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edicao ? t("Editar produto") : t("Novo produto")}</DialogTitle>
          <DialogDescription>
            {t("O código identifica o produto de forma estável e não pode ser alterado depois.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (codigoValido && familiaValida) salvar.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="pg-code">{t("Código")}</Label>
            <Input
              id="pg-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="produto_alfa"
              maxLength={63}
              disabled={edicao}
              required
            />
            {!edicao && code !== "" && !codigoValido && (
              <p className="text-xs text-destructive">
                {t("Use letras minúsculas, números e _, começando por letra (2 a 63).")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="pg-name">{t("Nome")}</Label>
            <Input
              id="pg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pg-description">{t("Descrição (opcional)")}</Label>
            <Textarea
              id="pg-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pg-family">{t("Família")}</Label>
            <Input
              id="pg-family"
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              maxLength={63}
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("Agrupa produtos parecidos. Não limita quantos produtos existem.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              type="submit"
              disabled={salvar.isPending || !codigoValido || !familiaValida || !name.trim()}
            >
              {edicao ? t("Salvar") : t("Cadastrar produto")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
