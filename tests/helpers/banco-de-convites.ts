/**
 * Dublê em memória do supabase-js para o CICLO DO CONVITE (CG-IAM-01):
 * emissão (`team_invites`), aceite (`fn_accept_team_invite`, `user_organizations`)
 * e o pouco de `organizations` que o assistente lê.
 *
 * Existe porque o contrato que importa atravessa as três peças: o `invite_id`
 * que viaja no token tem de ser o `id` da LINHA, e é essa linha que a revogação
 * marca e o aceite consulta. Um dublê por teste, cada um respondendo só o que o
 * seu arquivo pergunta, deixaria cada metade verde sozinha — e o encontro das
 * duas sem prova.
 *
 * Reproduz as duas restrições de `team_invites` que mudam o desfecho do código
 * (migration 0238): a chave primária e o índice único PARCIAL "um convite em
 * aberto por e-mail por organização". Violação devolve `23505`, como o PostgREST.
 */
import { randomUUID } from "node:crypto";

export type Linha = Record<string, unknown>;

export interface Escrita {
  tabela: string;
  op: "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
}

export interface OpcoesDoBanco {
  /** e-mail de cada `auth.users`, para `auth.admin.getUserById`. */
  usuarios?: Record<string, string>;
  /** Resposta das funções do banco chamadas por `rpc`. */
  rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
}

const DEFAULTS: Record<string, () => Linha> = {
  team_invites: () => ({
    id: randomUUID(),
    interface_settings: { preset: "completa" },
    email_dispatched: false,
    created_at: new Date().toISOString(),
    last_sent_at: new Date().toISOString(),
    resend_count: 0,
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
    revoked_by: null,
  }),
};

function violaUnicidade(tabela: string, linhas: Linha[], nova: Linha, ignorar?: Linha): boolean {
  const outras = linhas.filter((l) => l !== ignorar);
  if (nova.id !== undefined && outras.some((l) => l.id === nova.id)) return true;
  if (tabela !== "team_invites") return false;
  const aberto = (l: Linha) => l.accepted_at == null && l.revoked_at == null;
  return (
    aberto(nova) &&
    outras.some(
      (l) =>
        aberto(l) &&
        l.organization_id === nova.organization_id &&
        String(l.email).toLowerCase() === String(nova.email).toLowerCase(),
    )
  );
}

export function bancoDeConvites(tabelas: Record<string, Linha[]>, opcoes: OpcoesDoBanco = {}) {
  const escritas: Escrita[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];

  const from = (tabela: string) => {
    tabelas[tabela] ??= [];
    const linhas = tabelas[tabela]!;
    let op: "select" | Escrita["op"] = "select";
    let payload: Linha | Linha[] | undefined;
    let devolve = false;
    const filtros: ((l: Linha) => boolean)[] = [];

    const executar = (): {
      data: Linha[] | null;
      error: { code: string; message: string } | null;
    } => {
      const casam = () => linhas.filter((l) => filtros.every((f) => f(l)));
      // Cópias, como o PostgREST: quem lê não segura a linha viva do banco.
      if (op === "select") return { data: casam().map((l) => ({ ...l })), error: null };
      if (op === "insert" || op === "upsert") {
        const novas = (Array.isArray(payload) ? payload : [payload!]).map((p) => ({
          ...(DEFAULTS[tabela]?.() ?? {}),
          ...p,
        }));
        for (const n of novas) {
          if (violaUnicidade(tabela, linhas, n)) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
        }
        linhas.push(...novas);
        escritas.push({ tabela, op, payload });
        return { data: devolve ? novas.map((l) => ({ ...l })) : null, error: null };
      }
      if (op === "update") {
        const alvo = casam();
        for (const l of alvo) {
          const nova = { ...l, ...(payload as Linha) };
          if (violaUnicidade(tabela, linhas, nova, l)) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
        }
        for (const l of alvo) Object.assign(l, payload);
        escritas.push({ tabela, op, payload });
        return { data: devolve ? alvo.map((l) => ({ ...l })) : null, error: null };
      }
      const alvo = casam();
      tabelas[tabela] = linhas.filter((l) => !alvo.includes(l));
      escritas.push({ tabela, op });
      return { data: devolve ? alvo : null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => {
        if (op === "select") return b;
        devolve = true;
        return b;
      },
      insert: (p: Linha | Linha[]) => ((op = "insert"), (payload = p), b),
      upsert: (p: Linha | Linha[]) => ((op = "upsert"), (payload = p), b),
      update: (p: Linha) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), b),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), b),
      is: (c: string, v: unknown) => (
        filtros.push((l) => (v === null ? l[c] == null : l[c] === v)),
        b
      ),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), b),
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const r = executar();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = executar();
        if (r.error) return { data: null, error: r.error };
        const l = r.data?.[0];
        return l
          ? { data: l, error: null }
          : { data: null, error: { code: "PGRST116", message: "0 rows" } };
      },
      then: (ok: (r: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(ok, no),
    };
    return b;
  };

  const cliente = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return opcoes.rpc?.(fn, args) ?? { data: null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: opcoes.usuarios?.[id] ? { id, email: opcoes.usuarios[id] } : null },
          error: null,
        }),
      },
    },
  };

  return { cliente, tabelas, escritas, rpcs };
}
