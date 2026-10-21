/**
 * UM AVISO POR ORGANIZAÇÃO: "IA desligada por falta de chave".
 *
 * ADR-0005, D3: a Central mostra um único aviso por organização, não um por
 * conversa. Antes, cada conversa sem chave virava cinco tentativas da fila e um
 * `job_dead` crítico — N conversas, N alertas, e nenhum deles dizia o que fazer.
 * Aqui a dedup é por TÍTULO aberto (`kind_e_titulo`), a mesma de
 * `avisarFaltaDeSaldo`: enquanto houver um aberto, a rajada de conversas não
 * cria outro. `kind='other'` sem referência, e não um kind próprio: kind novo
 * exige reconstruir o CHECK de `agent_inbox_items.kind` (migration + bloco do
 * baseline), o custo que `pacing/aviso-de-janela.ts` recusou pelo mesmo motivo.
 *
 * Duas portas para o mesmo item: o motor e o worker do agente falam `pg`; o
 * worker de voz fala Supabase. As duas gravam o MESMO título, então a ligação
 * recusada e o turno recusado contam como um aviso só.
 *
 * Fire-and-forget na intenção: falhar ao avisar não pode derrubar quem avisa.
 * A versão `pg` deixa o erro subir para o chamador decidir (o motor loga e
 * segue); a versão Supabase engole, porque o worker de voz não tem fila para
 * reprocessar.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";

import { CORPO_DO_AVISO_DE_IA_SEM_CHAVE, TITULO_DO_AVISO_DE_IA_SEM_CHAVE } from "./motivo";

export async function avisarIaDesligadaPorFaltaDeChave(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<void> {
  const { rows } = await db.query<{ locale: string | null }>(
    "select locale from organizations where id = $1",
    [organizationId],
  );
  const idioma = normalizarIdioma(rows[0]?.locale ?? null);
  await insertInboxItem(
    db,
    organizationId,
    {
      kind: "other",
      severity: "critical",
      title: traduzir(TITULO_DO_AVISO_DE_IA_SEM_CHAVE, idioma),
      body: traduzir(CORPO_DO_AVISO_DE_IA_SEM_CHAVE, idioma),
    },
    "kind_e_titulo",
  );
}

export async function avisarIaDesligadaPorFaltaDeChaveViaSupabase(
  admin: SupabaseClient,
  organizationId: string,
): Promise<void> {
  try {
    // Admin client bypassa RLS: filtro por organização programático (anti-pattern 10).
    const { data: org } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", organizationId)
      .maybeSingle();
    const idioma = normalizarIdioma((org as { locale?: string | null } | null)?.locale ?? null);
    const title = traduzir(TITULO_DO_AVISO_DE_IA_SEM_CHAVE, idioma);
    const { data: aberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "other")
      .eq("status", "open")
      .eq("title", title)
      .limit(1)
      .maybeSingle();
    if (aberto) return;
    await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "other",
      severity: "critical",
      title,
      body: traduzir(CORPO_DO_AVISO_DE_IA_SEM_CHAVE, idioma),
    });
  } catch {
    // O aviso não pode derrubar a recusa que o motivou.
  }
}
