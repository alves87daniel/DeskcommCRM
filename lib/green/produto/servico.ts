/**
 * GREEN-CRM-02 — a fronteira Green de produto: catálogo + produto principal da oportunidade.
 *
 * As rotas só autenticam, validam a forma e traduzem o resultado em HTTP. Tudo o que decide
 * está aqui ou no banco:
 *
 *   - quem decide a INTEGRIDADE (tenant, 1:1, elegibilidade Green, produto inativo, lead fechado)
 *     é o banco (triggers e FKs compostas da 0509). Este serviço as lê por erro nomeado e não as
 *     reimplementa como única barreira; as checagens prévias existem para dar uma resposta clara.
 *   - o EVENTO `lead.green_context_changed` é produzido pelo banco, na transação. O serviço NÃO
 *     emite evento (um produtor por fato).
 *
 * O cliente recebido é o da SESSÃO do operador (RLS ligada). Nenhuma função aqui usa service role.
 * A organização vem do chamador (resolvida de fonte confiável), nunca do corpo da requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  COLUNAS_DO_PRODUTO,
  type AtualizarProdutoInput,
  type ContextoGreenDaOportunidade,
  type CriarProdutoInput,
  type ProdutoDoContexto,
  type ProdutoGreen,
} from "./schemas";

type Db = Pick<SupabaseClient, "from" | "rpc">;
interface ErroDeBanco {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export type FalhaDeProduto = "codigo_duplicado" | "nao_encontrado" | "sem_permissao" | "interno";

export type ResultadoProduto =
  { ok: true; produto: ProdutoGreen } | { ok: false; falha: FalhaDeProduto };

function falhaDeProduto(e: ErroDeBanco | null): FalhaDeProduto {
  if (e?.code === "23505") return "codigo_duplicado";
  if (e?.code === "42501") return "sem_permissao";
  return "interno";
}

/* ── catálogo ────────────────────────────────────────────────────────────── */

export async function listarProdutos(
  db: Db,
  orgId: string,
  opts: { incluirInativos: boolean },
): Promise<{ ok: true; produtos: ProdutoGreen[] } | { ok: false }> {
  let q = db
    .from("green_products")
    .select(COLUNAS_DO_PRODUTO)
    .eq("organization_id", orgId)
    .order("name", { ascending: true });
  if (!opts.incluirInativos) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) return { ok: false };
  return { ok: true, produtos: (data ?? []) as unknown as ProdutoGreen[] };
}

export async function criarProduto(
  db: Db,
  orgId: string,
  input: CriarProdutoInput,
): Promise<ResultadoProduto> {
  const { data, error } = await db
    .from("green_products")
    .insert({
      organization_id: orgId,
      code: input.code,
      name: input.name,
      description: input.description,
      family: input.family,
      metadata: input.metadata,
    })
    .select(COLUNAS_DO_PRODUTO)
    .single();
  if (error || !data) return { ok: false, falha: falhaDeProduto(error) };
  return { ok: true, produto: data as unknown as ProdutoGreen };
}

export async function atualizarProduto(
  db: Db,
  orgId: string,
  id: string,
  patch: AtualizarProdutoInput,
): Promise<ResultadoProduto> {
  const { data, error } = await db
    .from("green_products")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();
  if (error) return { ok: false, falha: falhaDeProduto(error) };
  // 0 linhas = não existe OU a RLS não deixa ver/escrever: a mesma resposta nos dois casos
  if (!data) return { ok: false, falha: "nao_encontrado" };
  return { ok: true, produto: data as unknown as ProdutoGreen };
}

/* ── contexto da oportunidade ────────────────────────────────────────────── */

export type LeituraDoContexto =
  | { tipo: "ok"; contexto: ContextoGreenDaOportunidade }
  | { tipo: "lead_nao_encontrado" }
  | { tipo: "nao_aplicavel" }
  | { tipo: "erro" };

interface LeadResumo {
  id: string;
  status: string;
}

/**
 * Lê a oportunidade pela RLS do operador: lead inexistente, de outra organização e invisível
 * respondem igual (`lead_nao_encontrado`). Funil sem binding Green = `nao_aplicavel`.
 */
async function lerLeadGreen(
  db: Db,
  orgId: string,
  leadId: string,
): Promise<
  | { tipo: "ok"; lead: LeadResumo }
  | { tipo: "lead_nao_encontrado" }
  | { tipo: "nao_aplicavel" }
  | { tipo: "erro" }
> {
  const { data: lead, error } = await db
    .from("crm_leads")
    .select("id, status")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return { tipo: "erro" };
  if (!lead) return { tipo: "lead_nao_encontrado" };

  const { data: elegivel, error: errElegivel } = await db.rpc("fn_green_lead_eligible", {
    p_lead: leadId,
  });
  if (errElegivel) return { tipo: "erro" };
  if (elegivel !== true) return { tipo: "nao_aplicavel" };
  return { tipo: "ok", lead: lead as unknown as LeadResumo };
}

async function lerProdutoDoContexto(db: Db, orgId: string, productId: string) {
  const { data, error } = await db
    .from("green_products")
    .select("id, code, name, family, is_active")
    .eq("id", productId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return { erro: true as const };
  return { erro: false as const, produto: (data as unknown as ProdutoDoContexto | null) ?? null };
}

/** Somente leitura: nunca cria linha por efeito colateral. */
export async function lerContextoDaOportunidade(
  db: Db,
  orgId: string,
  leadId: string,
): Promise<LeituraDoContexto> {
  const lead = await lerLeadGreen(db, orgId, leadId);
  if (lead.tipo !== "ok") return lead;

  const { data: ctx, error } = await db
    .from("green_lead_context")
    .select("product_id, created_at, updated_at")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return { tipo: "erro" };

  const base = {
    lead_id: leadId,
    lead_status: lead.lead.status,
    editable: lead.lead.status === "open",
  };
  if (!ctx) return { tipo: "ok", contexto: { ...base, context: null } };

  const linha = ctx as unknown as { product_id: string; created_at: string; updated_at: string };
  const produto = await lerProdutoDoContexto(db, orgId, linha.product_id);
  if (produto.erro) return { tipo: "erro" };
  return {
    tipo: "ok",
    contexto: {
      ...base,
      context: {
        product_id: linha.product_id,
        product: produto.produto,
        created_at: linha.created_at,
        updated_at: linha.updated_at,
      },
    },
  };
}

export type FalhaDoContexto =
  | "lead_nao_encontrado"
  | "nao_aplicavel"
  | "produto_nao_encontrado"
  | "produto_inativo"
  | "oportunidade_fechada"
  | "sem_permissao"
  | "interno";

export type ResultadoDoContexto =
  | {
      ok: true;
      /** `unchanged` = o produto pedido já era o da oportunidade (nada foi gravado). */
      mudanca: "product_assigned" | "product_changed" | "unchanged";
      produto_anterior: string | null;
      contexto: ContextoGreenDaOportunidade;
    }
  | { ok: false; falha: FalhaDoContexto };

/** Erros nomeados da 0509 -> falha de domínio. Qualquer outra coisa é erro interno. */
function falhaDoContexto(e: ErroDeBanco | null): FalhaDoContexto {
  const texto = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (texto.includes("green_context_outside_binding")) return "nao_aplicavel";
  if (texto.includes("green_product_inactive")) return "produto_inativo";
  if (texto.includes("green_context_lead_closed")) return "oportunidade_fechada";
  if (e?.code === "23503" && texto.includes("green_lead_context_product_fkey")) {
    return "produto_nao_encontrado";
  }
  if (e?.code === "23503" && texto.includes("green_lead_context_lead_fkey")) {
    return "lead_nao_encontrado";
  }
  if (e?.code === "42501") return "sem_permissao";
  return "interno";
}

/**
 * Primeiro save cria o contexto; os seguintes trocam o produto. A oportunidade precisa estar
 * `open` (won/lost congelam a dimensão de produto) e o produto precisa estar ativo e ser da
 * organização. As três regras são do banco; as checagens daqui só antecipam a mensagem.
 */
export async function salvarContextoDaOportunidade(
  db: Db,
  orgId: string,
  leadId: string,
  productId: string,
): Promise<ResultadoDoContexto> {
  const lead = await lerLeadGreen(db, orgId, leadId);
  if (lead.tipo === "lead_nao_encontrado") return { ok: false, falha: "lead_nao_encontrado" };
  if (lead.tipo === "nao_aplicavel") return { ok: false, falha: "nao_aplicavel" };
  if (lead.tipo === "erro") return { ok: false, falha: "interno" };

  const atual = await db
    .from("green_lead_context")
    .select("product_id")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (atual.error) return { ok: false, falha: "interno" };
  const anterior = (atual.data as { product_id: string } | null)?.product_id ?? null;

  // Pedir o produto que já é o da oportunidade é idempotente, mesmo fechada ou com produto inativo.
  if (anterior === productId) return concluir(db, orgId, leadId, "unchanged", anterior);

  if (lead.lead.status !== "open") return { ok: false, falha: "oportunidade_fechada" };

  const produto = await lerProdutoDoContexto(db, orgId, productId);
  if (produto.erro) return { ok: false, falha: "interno" };
  if (!produto.produto) return { ok: false, falha: "produto_nao_encontrado" };
  if (!produto.produto.is_active) return { ok: false, falha: "produto_inativo" };

  let erro: ErroDeBanco | null = null;
  if (anterior === null) {
    const r = await db
      .from("green_lead_context")
      .insert({ lead_id: leadId, organization_id: orgId, product_id: productId });
    erro = r.error;
    // corrida: outro save criou o contexto entre a leitura e o INSERT -> vira troca
    if (erro?.code === "23505") {
      const r2 = await db
        .from("green_lead_context")
        .update({ product_id: productId })
        .eq("lead_id", leadId)
        .eq("organization_id", orgId);
      erro = r2.error;
    }
  } else {
    const r = await db
      .from("green_lead_context")
      .update({ product_id: productId })
      .eq("lead_id", leadId)
      .eq("organization_id", orgId);
    erro = r.error;
  }
  if (erro) return { ok: false, falha: falhaDoContexto(erro) };

  const feito = await concluir(
    db,
    orgId,
    leadId,
    anterior === null ? "product_assigned" : "product_changed",
    anterior,
  );
  // UPDATE barrado pela RLS afeta 0 linhas sem erro: só vale como sucesso se o produto gravou
  if (feito.ok && feito.contexto.context?.product_id !== productId) {
    return { ok: false, falha: "sem_permissao" };
  }
  return feito;
}

async function concluir(
  db: Db,
  orgId: string,
  leadId: string,
  mudanca: "product_assigned" | "product_changed" | "unchanged",
  anterior: string | null,
): Promise<ResultadoDoContexto> {
  const lido = await lerContextoDaOportunidade(db, orgId, leadId);
  if (lido.tipo !== "ok") return { ok: false, falha: "interno" };
  return { ok: true, mudanca, produto_anterior: anterior, contexto: lido.contexto };
}
