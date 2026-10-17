"use client";
import Link from "next/link";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { Funnel } from "@/lib/ui/icons";

/**
 * O caminho até o editor de etapas de UM funil.
 *
 * O editor (`/app/settings/tenant/pipelines`, seção `#etapas-<id>`) já faz
 * tudo — criar, renomear, reordenar, marcar ganho/perda, arquivar — mas mora
 * atrás de "Ver tudo em CRM", sem entrada de menu, e nem a lista de funis nem
 * o quadro apontavam para ele. Quem criava um funil ganhava quatro colunas
 * fixas e concluía que não dava para mudá-las (CG-OPS-01, 2026-10-15).
 *
 * Este componente NÃO reimplementa nada do editor: é um link. A âncora é a
 * mesma que `_stages.tsx` renderiza (`ancoraDasEtapas`); o teste confere.
 */
export const rotaDasEtapas = (pipelineId: string) =>
  `/app/settings/tenant/pipelines#etapas-${pipelineId}`;

/**
 * Só `manager`+ vê o link — o MESMO corte da página (`ROLE_RANK.manager`, com
 * `redirect("/403")` abaixo disso) e das rotas de etapa (`requireRole("manager")`).
 * Esconder de `viewer`/`agent` não é permissão nova: é não prometer uma porta
 * que o servidor fecha. A autorização de verdade continua lá.
 */
export function EditarEtapasLink({
  pipelineId,
  className,
}: {
  pipelineId: string;
  className?: string;
}) {
  const t = useT();
  const role = useActiveOrg()?.role;
  if (!role || ROLE_RANK[role] < ROLE_RANK.manager) return null;
  return (
    <Link
      href={rotaDasEtapas(pipelineId)}
      className={className}
      data-testid={`editar-etapas-${pipelineId}`}
    >
      <Funnel size={16} className="mr-1" aria-hidden /> {t("Editar etapas")}
    </Link>
  );
}
