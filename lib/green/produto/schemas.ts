/**
 * GREEN-CRM-02 — contrato do catálogo de produtos Green e do produto principal da oportunidade.
 *
 * Um schema só, lido pela tela E pelas rotas. As regras de FORMA espelham os CHECKs de
 * `green_products` (migration 0509); quem decide de verdade é o banco, estes schemas só dão a
 * mensagem clara antes de chegar nele.
 *
 * `family` é vocabulário ABERTO: aqui só se confere a forma. Não existe lista de famílias,
 * porque a família nunca define quantos produtos existem.
 */
import { z } from "zod";

export const CODIGO_DE_PRODUTO = /^[a-z][a-z0-9_]{1,62}$/;
export const FAMILIA_DE_PRODUTO = /^[a-z][a-z0-9_]{0,62}$/;
export const FAMILIA_PADRAO = "generic";

const codigo = z
  .string()
  .trim()
  .regex(CODIGO_DE_PRODUTO, "Use letras minúsculas, números e _, começando por letra (2 a 63).");
const nome = z.string().trim().min(1).max(120);
const descricao = z.string().trim().max(1000);
const familia = z.string().trim().regex(FAMILIA_DE_PRODUTO);
const metadata = z.record(z.string(), z.unknown());

export const criarProdutoSchema = z
  .object({
    code: codigo,
    name: nome,
    description: descricao.nullish().transform((v) => (v ? v : null)),
    family: familia.default(FAMILIA_PADRAO),
    metadata: metadata.default({}),
  })
  .strict();
export type CriarProdutoInput = z.infer<typeof criarProdutoSchema>;

/**
 * `code` NÃO está aqui, de propósito: é o identificador estável do produto. `.strict()` faz o
 * corpo com `code` virar 422, em vez de o campo ser descartado em silêncio.
 */
export const atualizarProdutoSchema = z
  .object({
    name: nome,
    description: descricao.nullable(),
    family: familia,
    is_active: z.boolean(),
    metadata,
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type AtualizarProdutoInput = z.infer<typeof atualizarProdutoSchema>;

/** Só o que o operador edita hoje no contexto: o produto principal. */
export const salvarContextoSchema = z.object({ product_id: z.string().uuid() }).strict();
export type SalvarContextoInput = z.infer<typeof salvarContextoSchema>;

export interface ProdutoGreen {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  family: string;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** O produto como a oportunidade o enxerga (inclusive quando já está inativo). */
export type ProdutoDoContexto = Pick<ProdutoGreen, "id" | "code" | "name" | "family" | "is_active">;

export interface ContextoGreen {
  product_id: string;
  product: ProdutoDoContexto | null;
  created_at: string;
  updated_at: string;
}

export interface ContextoGreenDaOportunidade {
  lead_id: string;
  /** `open` é o único estado em que o produto pode ser trocado. */
  lead_status: string;
  editable: boolean;
  /** `null` = a oportunidade Green ainda não tem produto (nada foi gravado). */
  context: ContextoGreen | null;
}

export const COLUNAS_DO_PRODUTO =
  "id, organization_id, code, name, description, family, is_active, metadata, created_at, updated_at";
