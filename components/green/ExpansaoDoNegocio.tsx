"use client";
import Link from "next/link";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useExpansao } from "@/hooks/green/useExpansao";
import { useT } from "@/hooks/i18n/useT";
import type { ExpansaoDaOportunidade, OportunidadeRelacionada } from "@/lib/green/expansao/schemas";

import { NovaExpansaoDialog } from "./NovaExpansaoDialog";

interface Props {
  leadId: string;
  /** O título do negócio de origem: a sugestão inicial do título da expansão. */
  tituloDoNegocio: string;
  /** `agent`+ cria; o dossiê já sabe o papel de quem está vendo (o servidor revalida). */
  podeCriar: boolean;
}

const STATUS: Record<string, { rotulo: string; variante: "default" | "success" | "neutral" }> = {
  open: { rotulo: "Aberto", variante: "default" },
  won: { rotulo: "Ganho", variante: "success" },
  lost: { rotulo: "Perdido", variante: "neutral" },
};

function Relacao({ r }: { r: OportunidadeRelacionada }): React.ReactElement {
  const t = useT();
  if (!r.visible) {
    return (
      <li className="text-xs text-text-muted" data-testid="relacao-invisivel">
        {t("Negócio relacionado sem acesso para você")}
      </li>
    );
  }
  const status = r.status ? STATUS[r.status] : undefined;
  return (
    <li className="flex flex-col gap-1 text-sm" data-testid="relacao">
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link href={`/app/leads/${r.lead_id}`} className="font-medium text-accent hover:underline">
          {r.title}
        </Link>
        {status && <Badge variant={status.variante}>{t(status.rotulo)}</Badge>}
      </span>
      <span className="text-xs text-text-muted">
        {[r.product?.name, r.pipeline_name, r.stage_name].filter(Boolean).join(" · ")}
        {r.product && !r.product.is_active && (
          <Badge variant="neutral" className="ml-2">
            {t("Produto inativo")}
          </Badge>
        )}
      </span>
    </li>
  );
}

/** Há o que mostrar? Sem relação e sem como criar, a seção não existe para este negócio. */
function temConteudo(d: ExpansaoDaOportunidade, podeCriar: boolean): boolean {
  return Boolean(d.origin) || d.expansions.length > 0 || (d.eligibility.eligible && podeCriar);
}

/**
 * Seção "Expansão comercial" do dossiê (CG-COM-01).
 *
 * - Mostra de qual negócio ganho esta oportunidade nasceu e as expansões que nasceram dela, com
 *   produto, funil e etapa de cada uma.
 * - Em negócio GANHO e com contato, quem é `agent`+ abre uma nova oportunidade para o mesmo
 *   contato, num funil Green, com o produto escolhido. O negócio ganho NÃO muda: continua ganho,
 *   no mesmo funil, com o histórico dele.
 * - Negócio sem relação e que não origina expansão não mostra nada (a seção some).
 */
export function ExpansaoDoNegocio({
  leadId,
  tituloDoNegocio,
  podeCriar,
}: Props): React.ReactElement | null {
  const t = useT();
  const expansao = useExpansao(leadId);
  const [dialogoAberto, setDialogoAberto] = React.useState(false);

  // Falha de leitura ou carregando: o dossiê segue inteiro, sem esta seção.
  if (expansao.isError || !expansao.data) return null;
  const d = expansao.data;
  if (!temConteudo(d, podeCriar)) return null;

  return (
    <section className="border-t border-border pt-3" data-testid="expansao-comercial">
      <h3 className="mb-2 text-xs font-medium tracking-wide text-text-muted uppercase">
        {t("Expansão comercial")}
      </h3>

      {d.origin && (
        <div className="mb-3" data-testid="origem-comercial">
          <p className="mb-1 text-xs text-text-muted">{t("Nasceu como expansão do negócio")}</p>
          <ul>
            <Relacao r={d.origin} />
          </ul>
        </div>
      )}

      {d.expansions.length > 0 && (
        <div className="mb-3" data-testid="expansoes">
          <p className="mb-1 text-xs text-text-muted">
            {t("Oportunidades abertas a partir deste negócio")}
          </p>
          <ul className="flex flex-col gap-2">
            {d.expansions.map((r) => (
              <Relacao key={r.lead_id} r={r} />
            ))}
          </ul>
        </div>
      )}

      {d.eligibility.eligible && podeCriar && (
        <>
          <p className="mb-2 text-xs text-text-muted">
            {t(
              "Uma nova venda para este cliente vira uma oportunidade nova. Este negócio continua ganho e não muda de funil.",
            )}
          </p>
          {d.can_create ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDialogoAberto(true)}
            >
              {t("Nova oportunidade de expansão")}
            </Button>
          ) : (
            <p className="text-xs text-text-muted" data-testid="sem-destino">
              {t("Nenhum funil Green com etapa aberta para receber a expansão.")}
            </p>
          )}
        </>
      )}

      {d.can_create && podeCriar && (
        <NovaExpansaoDialog
          open={dialogoAberto}
          onOpenChange={setDialogoAberto}
          leadId={leadId}
          destinos={d.destinations}
          produtoSugerido={d.suggested_product_id}
          tituloSugerido={tituloDoNegocio}
        />
      )}
    </section>
  );
}
