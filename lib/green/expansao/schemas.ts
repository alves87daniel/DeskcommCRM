/**
 * CG-COM-01 — contrato da expansão pós-ganho: uma oportunidade NOVA, do mesmo contato, aberta a
 * partir de uma oportunidade ganha e ligada a ela por vínculo de origem comercial.
 *
 * Um schema só, lido pela tela E pela rota. Quem decide de verdade é o banco
 * (`fn_crm_create_expansion_opportunity` e o guarda do vínculo, migration 0510); este schema só
 * dá a mensagem clara antes de chegar nele.
 *
 * `.strict()`: o corpo não carrega organização, contato, origem nem status. A organização vem da
 * sessão, o contato vem da oportunidade de origem, e a expansão nasce sempre aberta.
 */
import { z } from "zod";

/**
 * O `link_kind` do vínculo em `crm_lead_links`. Coluna de vocabulário ABERTO (sem CHECK), como o
 * `scheduled` da agenda: quem escreve ou lê o vínculo usa esta constante, nunca a string solta.
 */
export const VINCULO_DE_ORIGEM_COMERCIAL = "commercial_origin" as const;
/** O `target_kind` do vínculo: a origem comercial é sempre outra oportunidade. */
export const ALVO_DO_VINCULO_DE_ORIGEM = "lead" as const;
/** A origem de entrada (`crm_leads.source`) da oportunidade de expansão. */
export const ORIGEM_DA_EXPANSAO = "expansao" as const;

export const criarExpansaoSchema = z
  .object({
    pipeline_id: z.string().uuid(),
    /** Sem etapa, a expansão entra na primeira etapa aberta do funil escolhido. */
    stage_id: z.string().uuid().nullish(),
    product_id: z.string().uuid(),
    title: z.string().trim().min(2).max(200),
    value_cents: z.number().int().nonnegative().nullish(),
  })
  .strict();
export type CriarExpansaoInput = z.infer<typeof criarExpansaoSchema>;

/** O produto como a relação o mostra (inclusive quando já está inativo). */
export interface ProdutoDaRelacao {
  id: string;
  name: string;
  is_active: boolean;
}

/**
 * Uma oportunidade do outro lado do vínculo. `visible = false` quando a RLS do operador não a
 * mostra: o vínculo existe, mas o que ela é não aparece.
 */
export interface OportunidadeRelacionada {
  lead_id: string;
  visible: boolean;
  title: string | null;
  status: string | null;
  pipeline_name: string | null;
  stage_name: string | null;
  product: ProdutoDaRelacao | null;
  /** Quando o vínculo nasceu. */
  linked_at: string;
}

export interface EtapaDeDestino {
  id: string;
  name: string;
}

/** Um funil Green que pode receber a expansão, com as etapas abertas em ordem. */
export interface DestinoDaExpansao {
  pipeline_id: string;
  name: string;
  stages: EtapaDeDestino[];
}

export type MotivoDeInelegibilidade = "not_won" | "without_contact";

export interface ExpansaoDaOportunidade {
  lead_id: string;
  lead_status: string;
  /** Só oportunidade ganha e com contato origina expansão. */
  eligibility: { eligible: boolean; reason: MotivoDeInelegibilidade | null };
  /**
   * A organização tem ao menos um funil Green (com binding). Falso numa instalação sem Green: a
   * tela não oferece nem explica a expansão. Só é medido para quem pode criar e em negócio
   * elegível; nos outros casos é `false`.
   */
  green_available: boolean;
  /** Elegível, operador `agent`+ e ao menos um funil Green com etapa aberta. */
  can_create: boolean;
  /** De qual oportunidade esta nasceu (se for uma expansão). */
  origin: OportunidadeRelacionada | null;
  /** As expansões que nasceram desta (as que o operador enxerga). */
  expansions: OportunidadeRelacionada[];
  /** Vazio quando o operador não pode criar. */
  destinations: DestinoDaExpansao[];
  /** O produto desta oportunidade, se ativo: a sugestão inicial do formulário. */
  suggested_product_id: string | null;
}

/**
 * A oportunidade na resposta da criação: SÓ ids e estado. A resposta do POST é gravada como
 * recibo de idempotência (`idempotency_keys`, fora da cascata de LGPD); o título do negócio
 * costuma ser o nome do cliente e não vai para lá. Quem precisa do resto lê o lead pelo id.
 */
export interface LeadDaExpansao {
  id: string;
  pipeline_id: string;
  stage_id: string;
  status: string;
  contact_id: string | null;
}
export const COLUNAS_DO_LEAD_DA_EXPANSAO = "id, pipeline_id, stage_id, status, contact_id";

/** A resposta da criação: `created = false` quando a expansão aberta já existia. */
export interface ResultadoDaExpansao {
  created: boolean;
  lead: LeadDaExpansao;
  link_id: string | null;
  origin_lead_id: string;
}
