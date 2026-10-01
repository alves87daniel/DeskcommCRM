import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reset dos dados de ATENDIMENTO de uma organização — o motor da "Zona de
 * perigo" de Configurações › Organização.
 *
 * Extraído da contribuição de @maugarciasa (PR #556). O original delegava tudo
 * a uma RPC `fn_apagar_dados_operacionais_da_organizacao` que **não existia em
 * lugar nenhum do repositório** — nem em `supabase/migrations/`, nem no
 * `baseline.sql`. Aqui o apagamento é feito pelo próprio app, o que evita criar
 * uma `security definer` nova em `public` cujo ÚNICO parâmetro de seleção de
 * linha é a organização — exatamente a forma que a doutrina de migrations
 * (cabeçalho da 0167) descreve como porta de adulteração.
 *
 * ── Por que a ORDEM é código e não estilo ────────────────────────────────────
 * Três FKs para `contacts` são ON DELETE RESTRICT (medido no baseline aplicado:
 * `messages.contact_id`, `conversations.contact_id`,
 * `calendar_appointments.contact_id`). Apagar `contacts` antes deles devolve
 * 23503 e o reset morre pela metade. O resto do grafo é CASCADE ou SET NULL, e
 * o Postgres cuida — por isso a lista abaixo é curta de propósito: ela é o
 * conjunto MÍNIMO de raízes, não a lista de tudo que some.
 *
 * O que some junto, por CASCADE (não precisa estar na lista, e não deve):
 *   de `conversations` → agent_cases, conversation_notes,
 *     conversation_assignment_events, demanda_conversas, messages
 *   de `contacts` → demandas, lead_state, lead_state_transitions,
 *     lead_checkpoints, lead_notes, followup_enrollments, send_ledger,
 *     job_queue, cron_jobs, before_send_traces, contact_field_proposals
 *   de `crm_leads` → crm_lead_activities, crm_lead_links, crm_lead_scores,
 *     crm_lead_risk_states, crm_lead_reactivations
 *
 * O que SOBREVIVE de propósito (e é o ponto da feature): usuários, convites,
 * a organização e suas configurações, funis e etapas, agentes de IA e suas
 * credenciais, canais de WhatsApp, tokens de API, `api_audit_log` (append-only)
 * e `lgpd_requests` (registro legal — a FK para contato é SET NULL).
 */

/** Uma raiz do apagamento: a tabela e por que ela vem nesta posição. */
interface Raiz {
  readonly tabela: TabelaOperacional;
  readonly porque: string;
}

export type TabelaOperacional =
  | "messages"
  | "conversations"
  | "calendar_appointments"
  | "orders"
  // D10: `crm_proposals` tem FK SET NULL (não mais CASCADE) para lead e
  // contato — sem raiz própria aqui, uma proposta enviada ficaria órfã PARA
  // SEMPRE num reset "total" da organização, e o PDF dela continuaria
  // ocupando o bucket sem nenhuma linha apontando pra ele.
  | "crm_proposals"
  | "crm_leads"
  | "contacts";

/**
 * A ordem é a do apagamento e é significativa: quem tem FK RESTRICT para
 * `contacts` precisa sair antes dele.
 */
export const RAIZES_DO_APAGAMENTO: readonly Raiz[] = [
  { tabela: "messages", porque: "FK RESTRICT para contacts" },
  { tabela: "conversations", porque: "FK RESTRICT para contacts" },
  { tabela: "calendar_appointments", porque: "FK RESTRICT para contacts" },
  { tabela: "orders", porque: "FK SET NULL para contacts; ninguém a referencia" },
  { tabela: "crm_proposals", porque: "FK SET NULL para contacts e crm_leads (D10) — raiz própria" },
  { tabela: "crm_leads", porque: "FK SET NULL para contacts" },
  { tabela: "contacts", porque: "a raiz do grafo — sempre por último" },
] as const;

export type ContagensApagadas = Record<TabelaOperacional, number>;

export interface FalhaAoApagar {
  /**
   * SPIKE Green lifecycle: o apagamento é UMA transação
   * (`fn_apagar_dados_operacionais_da_org`), então a falha é da transação
   * inteira — nenhuma tabela ficou pela metade para ser nomeada aqui. A causa
   * está em `mensagem`.
   */
  readonly tabela: TabelaOperacional | "transacao";
  readonly mensagem: string;
}

export type ResultadoDoApagamento =
  | { readonly ok: true; readonly counts: ContagensApagadas; readonly pdfsRemovidos: number }
  | { readonly ok: false; readonly falha: FalhaAoApagar; readonly counts: ContagensApagadas; readonly pdfsRemovidos: number };

function contagensZeradas(): ContagensApagadas {
  return {
    messages: 0,
    conversations: 0,
    calendar_appointments: 0,
    orders: 0,
    crm_proposals: 0,
    crm_leads: 0,
    contacts: 0,
  };
}

/**
 * Apaga, NA ORDEM, os dados de atendimento de UMA organização.
 *
 * Todo DELETE carrega `.eq("organization_id", organizationId)` — o client aqui
 * é o de service role, que bypassa RLS, então o filtro é a única coisa que
 * separa uma organização da vizinha. `organizationId` tem de vir da sessão
 * (`resolveActiveOrg`), NUNCA do corpo da requisição.
 *
 * SPIKE Green lifecycle (SPIKE-GREEN-01): os sete DELETE saem numa transação
 * só, pela RPC `fn_apagar_dados_operacionais_da_org` (SECURITY INVOKER, só
 * `service_role`, mesma ordem de `RAIZES_DO_APAGAMENTO`, e o mesmo filtro de
 * organização em cada DELETE). Antes eram sete requests PostgREST: com uma
 * Opportunity Green na org, mensagens, conversas, agenda, pedidos e propostas
 * já tinham sido apagados quando a fronteira recusava `crm_leads` — perda
 * irreversível, e o retry recusava de novo no mesmo ponto. Agora qualquer
 * recusa desfaz tudo, e repetir converge. Precedente do upstream para a mesma
 * classe: `fn_apagar_contato_com_historico` (migration 0488, #752). Quem chama
 * declara o contexto Green da operação (a action); o header viaja na própria
 * request da RPC.
 */
export async function apagarDadosOperacionaisDaOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDoApagamento> {
  const counts = contagensZeradas();

  const { data, error } = await client.rpc("fn_apagar_dados_operacionais_da_org", {
    p_org: organizationId,
  });
  if (error) {
    return {
      ok: false,
      falha: { tabela: "transacao", mensagem: error.message },
      counts,
      pdfsRemovidos: 0,
    };
  }
  const apagadas = (data ?? {}) as Partial<Record<TabelaOperacional, number>>;
  for (const { tabela } of RAIZES_DO_APAGAMENTO) {
    counts[tabela] = Number(apagadas[tabela] ?? 0);
  }

  // D10: os PDFs de proposta (bucket `propostas`, path `<org>/<id>.pdf` —
  // lib/propostas/storage.ts) não têm FK nenhuma que os apague sozinhos; o
  // reset "total" só está completo quando a pasta da organização some junto
  // com as linhas de `crm_proposals` apagadas acima. O contador de numeração
  // (`crm_proposal_counters`) NÃO é tocado por este reset — a organização
  // pode zerar o atendimento e continuar numerando propostas de onde parou.
  // `storage.list()` pagina em 100 por padrão (storage-js) — sem o laço,
  // qualquer organização com mais de 100 propostas ficava com PDFs órfãos
  // no bucket depois do reset. Sempre lista do zero: cada `remove()` já tira
  // do bucket os arquivos que acabaram de ser listados, então a próxima
  // chamada devolve o lote seguinte na mesma posição — não precisa (nem pode
  // confiar em) offset, que uma listagem que muda debaixo do pé tornaria
  // instável.
  let pdfsRemovidos = 0;
  const LOTE = 100;
  for (;;) {
    const { data: arquivos, error: listErr } = await client.storage
      .from("propostas")
      .list(organizationId, { limit: LOTE });
    if (listErr || !arquivos || arquivos.length === 0) break;

    const { error: removeErr } = await client.storage
      .from("propostas")
      .remove(arquivos.map((a) => `${organizationId}/${a.name}`));
    if (removeErr) break;
    pdfsRemovidos += arquivos.length;

    if (arquivos.length < LOTE) break;
  }

  return { ok: true, counts, pdfsRemovidos };
}
