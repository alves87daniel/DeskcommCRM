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
 * O CICLO DE VIDA (item 20 da #33): o aviso FECHA quando a organização passa a
 * ter uma credencial utilizável — a validação em segundo plano de quem cadastra
 * ou rotaciona (`lib/ai/credenciais/guardar.ts`), a revalidação pela tela e o
 * instalador chamam `fecharAvisoDeIaSemChave*` — e REABRE sozinho se ela voltar
 * a faltar: a dedup só enxerga os abertos, então o próximo turno recusado cria
 * um aviso novo. O estado fica guardado nas linhas (`resolved` é histórico, não
 * apagamento), e nunca há dois abertos para a mesma organização.
 *
 * Duas portas para o mesmo item: o motor e o worker do agente falam `pg`; o
 * worker de voz e as rotas de credencial falam Supabase. As duas gravam o MESMO
 * título, então a ligação recusada e o turno recusado contam como um aviso só —
 * e o fechamento olha o título em TODOS os idiomas, porque o título é gravado
 * já traduzido no idioma da organização.
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
import { IDIOMAS, normalizarIdioma } from "@/lib/i18n/idiomas";

import { CORPO_DO_AVISO_DE_IA_SEM_CHAVE, TITULO_DO_AVISO_DE_IA_SEM_CHAVE } from "./motivo";

/**
 * O título como ele é gravado em cada idioma da instalação. É por esta lista que
 * o fechamento acha o aviso: a organização em espanhol gravou o título em
 * espanhol, e um fechamento que só procurasse o português nunca o fecharia.
 */
export const TITULOS_DO_AVISO_DE_IA_SEM_CHAVE: readonly string[] = Array.from(
  new Set(IDIOMAS.map((idioma) => traduzir(TITULO_DO_AVISO_DE_IA_SEM_CHAVE, idioma))),
);

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

/**
 * Fecha o aviso aberto da organização (todos os idiomas). Idempotente: sem
 * aviso aberto, não faz nada. Lança em erro de banco — quem chama decide.
 */
export async function fecharAvisoDeIaSemChave(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<void> {
  await db.query(
    `update agent_inbox_items set status = 'resolved'
      where organization_id = $1 and kind = 'other' and status = 'open'
        and title = any($2::text[])`,
    [organizationId, TITULOS_DO_AVISO_DE_IA_SEM_CHAVE],
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

/**
 * A porta Supabase do fechamento — a das rotas de credencial e da validação em
 * segundo plano. Engole erro: fechar um aviso é consequência, nunca pode
 * derrubar o cadastro que o motivou. Filtro por organização programático
 * (admin client bypassa RLS, anti-pattern 10).
 */
export async function fecharAvisoDeIaSemChaveViaSupabase(
  admin: SupabaseClient,
  organizationId: string,
): Promise<void> {
  try {
    await admin
      .from("agent_inbox_items")
      .update({ status: "resolved" })
      .eq("organization_id", organizationId)
      .eq("kind", "other")
      .eq("status", "open")
      .in("title", [...TITULOS_DO_AVISO_DE_IA_SEM_CHAVE]);
  } catch {
    // Consequência, não causa: ver acima.
  }
}
