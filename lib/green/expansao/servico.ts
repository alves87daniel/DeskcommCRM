/**
 * CG-COM-01 — leitura da expansão pós-ganho e tradução das recusas do banco.
 *
 * A ESCRITA não mora aqui: é `expandirLeadHandler` (`app/api/v1/leads/_handler.ts`), ao lado da
 * retomada, porque o rastro de nascimento (`lead.created` + auditoria) é o mesmo de todo lead. A
 * integridade (origem ganha, destino Green, idempotência, vínculo, tenant) é do banco
 * (migration 0510); este módulo só LÊ o que existe e dá nome às recusas.
 *
 * O cliente recebido é o da SESSÃO do operador (RLS ligada): o que ele não enxerga não aparece, e
 * o vínculo para uma oportunidade invisível aparece como `visible = false`, sem título nem
 * status. A organização vem do chamador (sessão), nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ALVO_DO_VINCULO_DE_ORIGEM,
  VINCULO_DE_ORIGEM_COMERCIAL,
  type DestinoDaExpansao,
  type ExpansaoDaOportunidade,
  type MotivoDeInelegibilidade,
  type OportunidadeRelacionada,
  type ProdutoDaRelacao,
} from "./schemas";

type Db = Pick<SupabaseClient, "from" | "rpc">;

interface ErroDeBanco {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

/* ── elegibilidade ───────────────────────────────────────────────────────── */

/** Só oportunidade ganha e com contato origina expansão (o contato é reaproveitado). */
export function elegibilidadeDaOrigem(lead: { status: string; contact_id: string | null }): {
  eligible: boolean;
  reason: MotivoDeInelegibilidade | null;
} {
  if (lead.status !== "won") return { eligible: false, reason: "not_won" };
  if (!lead.contact_id) return { eligible: false, reason: "without_contact" };
  return { eligible: true, reason: null };
}

/* ── recusas do banco ────────────────────────────────────────────────────── */

export type FalhaDaExpansao =
  | "origem_nao_encontrada"
  | "origem_nao_ganha"
  | "origem_sem_contato"
  | "destino_nao_green"
  | "etapa_indisponivel"
  | "produto_nao_encontrado"
  | "produto_inativo"
  | "dados_invalidos"
  | "expansao_aberta_invisivel"
  | "sem_permissao"
  | "interno";

/** Erros nomeados da 0510 (e da 0509, no produto) -> falha de domínio. O resto é interno. */
export function falhaDaExpansao(e: ErroDeBanco | null): FalhaDaExpansao {
  const texto = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (texto.includes("expansion_origin_not_found")) return "origem_nao_encontrada";
  if (texto.includes("expansion_origin_not_won")) return "origem_nao_ganha";
  if (texto.includes("expansion_origin_without_contact")) return "origem_sem_contato";
  if (texto.includes("expansion_destination_not_green")) return "destino_nao_green";
  if (texto.includes("expansion_stage_unavailable")) return "etapa_indisponivel";
  if (texto.includes("expansion_already_open")) return "expansao_aberta_invisivel";
  if (
    texto.includes("expansion_product_required") ||
    texto.includes("expansion_title_invalid") ||
    texto.includes("expansion_currency_invalid") ||
    texto.includes("expansion_value_invalid")
  ) {
    return "dados_invalidos";
  }
  if (texto.includes("green_product_inactive")) return "produto_inativo";
  if (e?.code === "23503" && texto.includes("green_lead_context_product_fkey")) {
    return "produto_nao_encontrado";
  }
  if (e?.code === "42501") return "sem_permissao";
  return "interno";
}

/* ── expansão aberta existente ───────────────────────────────────────────── */

export type ExpansaoExistente =
  | { tipo: "nenhuma" }
  | { tipo: "visivel"; leadId: string }
  | { tipo: "invisivel" }
  | { tipo: "erro" };

/**
 * A expansão ABERTA desta origem com este produto, se houver (`fn_crm_open_expansion_of`). É a
 * resposta idempotente da criação; a escrita repete a pergunta sob lock, então isto é só o atalho
 * que evita validar de novo o que já foi criado.
 */
export async function expansaoAbertaDe(
  db: Db,
  origemId: string,
  produtoId: string,
): Promise<ExpansaoExistente> {
  const { data, error } = await db.rpc("fn_crm_open_expansion_of", {
    p_origin_lead_id: origemId,
    p_product_id: produtoId,
  });
  if (error) return { tipo: "erro" };
  const linha = (data as { lead_id: string | null; visible: boolean }[] | null)?.[0];
  if (!linha) return { tipo: "nenhuma" };
  if (!linha.visible || !linha.lead_id) return { tipo: "invisivel" };
  return { tipo: "visivel", leadId: linha.lead_id };
}

/* ── leitura das relações ────────────────────────────────────────────────── */

export type LeituraDaExpansao =
  | { tipo: "ok"; expansao: ExpansaoDaOportunidade }
  | { tipo: "lead_nao_encontrado" }
  | { tipo: "erro" };

interface LeadLido {
  id: string;
  title: string;
  status: string;
  pipeline_id: string;
  stage_id: string;
}
interface VinculoLido {
  lead_id: string;
  target_id: string;
  created_at: string;
}

/** Nomes por id de uma tabela da organização (funil, etapa, produto). Vazio = nada a ler. */
async function porId<T extends { id: string }>(
  db: Db,
  tabela: string,
  colunas: string,
  orgId: string,
  ids: string[],
): Promise<Map<string, T> | null> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return new Map();
  const { data, error } = await db
    .from(tabela)
    .select(colunas)
    .eq("organization_id", orgId)
    .in("id", unicos);
  if (error) return null;
  return new Map(((data ?? []) as unknown as T[]).map((l) => [l.id, l]));
}

/** Os funis Green da organização com as etapas abertas (destinos possíveis da expansão). */
export async function destinosDaExpansao(
  db: Db,
  orgId: string,
): Promise<DestinoDaExpansao[] | null> {
  const { data: ids, error } = await db.rpc("fn_green_pipeline_ids", { p_org: orgId });
  if (error) return null;
  const funisGreen = ((ids ?? []) as unknown[]).map(String);
  if (funisGreen.length === 0) return [];

  const funis = await db
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", funisGreen)
    .order("name", { ascending: true });
  if (funis.error) return null;
  const etapas = await db
    .from("crm_stages")
    .select("id, name, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", orgId)
    .in("pipeline_id", funisGreen)
    .order("position", { ascending: true });
  if (etapas.error) return null;

  const abertas = (
    (etapas.data ?? []) as unknown as {
      id: string;
      name: string;
      pipeline_id: string;
      is_won: boolean | null;
      is_lost: boolean | null;
      is_archived: boolean | null;
    }[]
  ).filter((e) => !e.is_won && !e.is_lost && !e.is_archived);

  return ((funis.data ?? []) as unknown as { id: string; name: string }[])
    .map((f) => ({
      pipeline_id: f.id,
      name: f.name,
      stages: abertas
        .filter((e) => e.pipeline_id === f.id)
        .map((e) => ({ id: e.id, name: e.name })),
    }))
    .filter((d) => d.stages.length > 0);
}

/**
 * Somente leitura. O que o dossiê precisa para mostrar a relação entre oportunidades e, quando
 * cabe, oferecer a expansão: de onde esta nasceu, o que nasceu dela, se ela origina expansão e
 * para quais funis.
 */
export async function lerExpansaoDaOportunidade(
  db: Db,
  orgId: string,
  leadId: string,
  opts: { podeCriar: boolean },
): Promise<LeituraDaExpansao> {
  const { data: leadBruto, error: leadErr } = await db
    .from("crm_leads")
    .select("id, status, contact_id")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return { tipo: "erro" };
  if (!leadBruto) return { tipo: "lead_nao_encontrado" };
  const lead = leadBruto as unknown as { id: string; status: string; contact_id: string | null };

  const vinculos = () =>
    db
      .from("crm_lead_links")
      .select("lead_id, target_id, created_at")
      .eq("organization_id", orgId)
      .eq("target_kind", ALVO_DO_VINCULO_DE_ORIGEM)
      .eq("link_kind", VINCULO_DE_ORIGEM_COMERCIAL);
  const [deOrigem, deExpansao] = await Promise.all([
    // a origem desta oportunidade (se ela for uma expansão). A RPC grava uma só; um vínculo a
    // mais, gravado à mão, não derruba a leitura: vale o primeiro
    vinculos()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    // as expansões que nasceram dela
    vinculos().eq("target_id", leadId).order("created_at", { ascending: true }),
  ]);
  if (deOrigem.error || deExpansao.error) return { tipo: "erro" };
  const origemVinculo = deOrigem.data as unknown as VinculoLido | null;
  const expansoesVinculo = (deExpansao.data ?? []) as unknown as VinculoLido[];

  const relacionadas = [
    ...(origemVinculo ? [origemVinculo.target_id] : []),
    ...expansoesVinculo.map((v) => v.lead_id),
  ];
  const leads = await porId<LeadLido>(
    db,
    "crm_leads",
    "id, title, status, pipeline_id, stage_id",
    orgId,
    relacionadas,
  );
  if (!leads) return { tipo: "erro" };

  const contextos = await (async () => {
    const ids = [leadId, ...leads.keys()];
    const { data, error } = await db
      .from("green_lead_context")
      .select("lead_id, product_id")
      .eq("organization_id", orgId)
      .in("lead_id", ids);
    if (error) return null;
    return new Map(
      ((data ?? []) as unknown as { lead_id: string; product_id: string }[]).map((c) => [
        c.lead_id,
        c.product_id,
      ]),
    );
  })();
  if (!contextos) return { tipo: "erro" };

  const visiveis = [...leads.values()];
  const [funis, etapas, produtos] = await Promise.all([
    porId<{ id: string; name: string }>(
      db,
      "crm_pipelines",
      "id, name",
      orgId,
      visiveis.map((l) => l.pipeline_id),
    ),
    porId<{ id: string; name: string }>(
      db,
      "crm_stages",
      "id, name",
      orgId,
      visiveis.map((l) => l.stage_id),
    ),
    porId<ProdutoDaRelacao>(db, "green_products", "id, name, is_active", orgId, [
      ...contextos.values(),
    ]),
  ]);
  if (!funis || !etapas || !produtos) return { tipo: "erro" };

  const relacao = (id: string, linkedAt: string): OportunidadeRelacionada => {
    const l = leads.get(id);
    if (!l) {
      return {
        lead_id: id,
        visible: false,
        title: null,
        status: null,
        pipeline_name: null,
        stage_name: null,
        product: null,
        linked_at: linkedAt,
      };
    }
    const produtoId = contextos.get(id);
    return {
      lead_id: id,
      visible: true,
      title: l.title,
      status: l.status,
      pipeline_name: funis.get(l.pipeline_id)?.name ?? null,
      stage_name: etapas.get(l.stage_id)?.name ?? null,
      product: (produtoId && produtos.get(produtoId)) || null,
      linked_at: linkedAt,
    };
  };

  const eligibility = elegibilidadeDaOrigem(lead);
  let destinations: DestinoDaExpansao[] = [];
  if (eligibility.eligible && opts.podeCriar) {
    const lidos = await destinosDaExpansao(db, orgId);
    if (!lidos) return { tipo: "erro" };
    destinations = lidos;
  }

  // o produto desta oportunidade já entrou na leitura (`contextos` inclui o próprio lead)
  const produtoProprio = contextos.get(leadId);
  const sugerido = produtoProprio ? produtos.get(produtoProprio) : undefined;
  const suggested_product_id = sugerido?.is_active ? sugerido.id : null;

  return {
    tipo: "ok",
    expansao: {
      lead_id: leadId,
      lead_status: lead.status,
      eligibility,
      can_create: eligibility.eligible && opts.podeCriar && destinations.length > 0,
      origin: origemVinculo ? relacao(origemVinculo.target_id, origemVinculo.created_at) : null,
      expansions: expansoesVinculo.map((v) => relacao(v.lead_id, v.created_at)),
      destinations,
      suggested_product_id,
    },
  };
}
