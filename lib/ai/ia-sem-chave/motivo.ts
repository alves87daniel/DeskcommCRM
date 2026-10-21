/**
 * IA DESLIGADA POR FALTA DE CHAVE — o vocabulário, num lugar só.
 *
 * Decisão D3 da ADR-0005 (dono do produto, 21/10/2026): a organização sem
 * credencial de IA ativa e validada não tem IA. O turno do agente não chama
 * provedor nenhum, passa a conversa para a equipe NA HORA e a fila não tenta de
 * novo; a Central mostra UM aviso por organização. Este módulo guarda as
 * constantes que o motor (`lib/agent-engine`), o worker de voz e a tela leem —
 * e é um módulo sem dependência de `pg` para a tela poder importá-lo.
 *
 * O motivo da passagem é um literal do vocabulário FECHADO de
 * `lib/escalacao/passagem.ts` e do CHECK de `passagens_de_atendimento`
 * (migration 0511). Dois caminhos param a IA pelo mesmo motivo (o turno de texto
 * e a ligação de voz), e duas grafias fariam quem filtra por uma achar metade
 * das conversas.
 */

/** `conversations.last_handoff_reason` e `passagens_de_atendimento.motivo_codigo`. */
export const HANDOFF_REASON_SEM_CHAVE = "ia_sem_chave" as const;

/** Título do item da Central — é também a chave de dedup (`kind_e_titulo`). */
export const TITULO_DO_AVISO_DE_IA_SEM_CHAVE = "IA desligada por falta de chave";

export const CORPO_DO_AVISO_DE_IA_SEM_CHAVE =
  "Esta organização não tem chave de IA ativa e validada, então nenhum ponto de IA chama provedor: " +
  "as conversas que chegam vão direto para a equipe. A plataforma não custeia IA. " +
  "Para religar, cadastre a chave em IA › Credenciais.";

/**
 * Primeira linha do resumo que vai ao humano quando a falta de chave interrompe
 * o turno. TEXTO FIXO, e tem de ser: não há chave para chamar modelo nenhum, e
 * gerar este resumo por LLM seria exatamente o que acabou de ser recusado.
 */
export const RESUMO_DO_HANDOFF_POR_FALTA_DE_CHAVE =
  "A IA parou de responder porque esta organização não tem chave de IA ativa e validada — " +
  "o lead NÃO pediu atendimento humano. Assuma a conversa; para devolvê-la ao atendimento " +
  'automático, cadastre a chave em IA › Credenciais e use "Devolver ao automático" no ' +
  "cabeçalho da conversa.";

/** Título do item `handoff` da Central que esta passagem abre. */
export const TITULO_DO_HANDOFF_POR_FALTA_DE_CHAVE =
  "IA desligada por falta de chave — assumir a conversa";
