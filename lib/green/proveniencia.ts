/**
 * SPIKE Green v3 (descartável) — leitura da proveniência de um evento.
 *
 * A metadata de um evento canônico Green (migration 0502) separa dois
 * namespaces:
 *
 *   metadata.green.trusted   derivado pelo banco (caller, ator de `auth.uid()`,
 *                            `source=user_session`) ou, em writer privilegiado,
 *                            o contexto validado que o backend enviou;
 *   metadata.green.advisory  o que uma sessão humana mandou no header —
 *                            observabilidade, nunca controle.
 *
 * Este módulo é o ÚNICO caminho por onde um consumidor de controle (anti-loop
 * da automação, correlação herdada pelo dispatcher, attribution futura) lê a
 * proveniência. Ele não tem função que devolva `advisory` misturado: quem
 * quiser o advisory para log pede por nome (`advisoryDoEvento`) e recebe um
 * tipo diferente. É o que torna o engano difícil — não uma convenção.
 */

export interface ProvenienciaGreenConfiavel {
  caller: string;
  actor?: { kind: string; id?: string; agent_id?: string; api_token_id?: string };
  source?: string;
  request_id?: string;
  correlation_id?: string;
  causation_event_id?: string;
  idempotency_key?: string;
  source_job_id?: string;
}

/** Marca de tipo: um advisory nunca é atribuível a `ProvenienciaGreenConfiavel`. */
export type AdvisoryGreen = Readonly<Record<string, string>> & { readonly __advisory: true };

type Metadata = Record<string, unknown> | null | undefined;

const CAMPOS = [
  "source",
  "request_id",
  "correlation_id",
  "causation_event_id",
  "idempotency_key",
  "source_job_id",
] as const;

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

export function ehCanonicoGreen(metadata: Metadata): boolean {
  return metadata?.green_canonical === true;
}

/**
 * A proveniência CONFIÁVEL de um evento canônico Green; `undefined` para
 * qualquer outro evento (a metadata de um evento comum é de quem o emitiu).
 *
 * Canônico da v2 (sem envelope): os campos do topo só eram confiáveis quando o
 * chamador era privilegiado; de sessão humana, só `caller` e `actor`.
 */
export function provenienciaConfiavel(metadata: Metadata): ProvenienciaGreenConfiavel | undefined {
  if (!metadata || !ehCanonicoGreen(metadata)) return undefined;
  const trusted = objeto(objeto(metadata.green)?.trusted);
  const fonte = trusted ?? metadata;
  const caller = typeof fonte.caller === "string" ? fonte.caller : "unknown";
  const out: ProvenienciaGreenConfiavel = { caller };
  const actor = objeto(fonte.actor);
  if (actor && typeof actor.kind === "string") out.actor = actor as ProvenienciaGreenConfiavel["actor"];
  if (!trusted && caller === "user") return out;
  for (const campo of CAMPOS) {
    const valor = fonte[campo];
    if (typeof valor === "string") out[campo] = valor;
  }
  return out;
}

/** O que a sessão humana mandou no header — para log e diagnóstico, nunca para decidir. */
export function advisoryDoEvento(metadata: Metadata): AdvisoryGreen | undefined {
  if (!metadata || !ehCanonicoGreen(metadata)) return undefined;
  const advisory = objeto(objeto(metadata.green)?.advisory);
  if (!advisory) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(advisory)) if (typeof v === "string") out[k] = v;
  return out as AdvisoryGreen;
}

/**
 * Anti-loop da automação: este evento foi causado por uma regra?
 *
 * Canônico Green: decide SÓ a proveniência confiável — a regra roda como writer
 * privilegiado com `source=automation` e `request_id=rule:<id>`. Um humano que
 * mande `request_id=rule:*` no header fica em advisory e não desliga nada
 * (AUDIT-08.2, ADV-04). Evento não canônico: a régua do upstream, intacta.
 */
export function causadoPorRegra(metadata: Metadata): boolean {
  if (ehCanonicoGreen(metadata)) {
    const trusted = provenienciaConfiavel(metadata);
    if (!trusted || trusted.caller === "user") return false;
    return trusted.source === "automation" || (trusted.request_id ?? "").startsWith("rule:");
  }
  const requestId = metadata?.request_id;
  return (
    Boolean(metadata?.caused_by_rule) ||
    (typeof requestId === "string" && requestId.startsWith("rule:"))
  );
}
