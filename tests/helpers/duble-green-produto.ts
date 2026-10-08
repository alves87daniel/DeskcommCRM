/**
 * Dublê em memória do que a fronteira Green de produto lê e escreve (GREEN-CRM-02).
 *
 * Reproduz só o que as rotas tocam: `green_products`, `green_lead_context`, `crm_leads` e a RPC
 * `fn_green_lead_eligible`, com filtros `eq`, `order`, `insert`, `update`, `select`/`single`/
 * `maybeSingle`. A RLS e os triggers do banco NÃO são reimplementados aqui: quem prova o
 * contrato do banco é `tests/invariants/green-product-catalog.test.ts`. O dublê deixa o teste
 * ESCOLHER o desfecho do banco (`falhas`), para provar que a rota traduz cada erro nomeado da
 * 0509 na resposta certa.
 */
import { randomUUID } from "node:crypto";

export type Linha = Record<string, unknown>;
export interface ErroPg {
  code?: string;
  message: string;
  details?: string;
}

export interface OpcoesDoDubleGreen {
  produtos?: Linha[];
  contextos?: Linha[];
  leads?: Linha[];
  /** Ids de lead que a RPC `fn_green_lead_eligible` considera de funil Green. */
  leadsGreen?: string[];
  /** Erro a devolver na próxima escrita da tabela/operação (consumido na 1ª vez). */
  falhas?: Partial<
    Record<`${"green_products" | "green_lead_context"}.${"insert" | "update"}`, ErroPg>
  >;
}

export interface DubleGreen {
  db: {
    from: (tabela: string) => unknown;
    rpc: (nome: string, args: Record<string, unknown>) => unknown;
  };
  produtos: Linha[];
  contextos: Linha[];
  escritas: { tabela: string; operacao: "insert" | "update"; valores: Linha }[];
  rpcs: { nome: string; args: Record<string, unknown> }[];
}

export function dubleGreen(opts: OpcoesDoDubleGreen = {}): DubleGreen {
  const produtos = opts.produtos ?? [];
  const contextos = opts.contextos ?? [];
  const leads = opts.leads ?? [];
  const falhas = { ...(opts.falhas ?? {}) };
  const escritas: DubleGreen["escritas"] = [];
  const rpcs: DubleGreen["rpcs"] = [];
  const tabelas: Record<string, Linha[]> = {
    green_products: produtos,
    green_lead_context: contextos,
    crm_leads: leads,
  };

  const projetar = (linha: Linha, colunas: string) => {
    if (colunas.trim() === "*") return { ...linha };
    const out: Linha = {};
    for (const c of colunas.split(",").map((x) => x.trim())) out[c] = linha[c];
    return out;
  };

  function consulta(tabela: string) {
    const filtros: [string, unknown][] = [];
    let colunas = "*";
    let modo: "select" | "insert" | "update" = "select";
    let valores: Linha = {};
    let ordem: string | null = null;

    const casam = () => tabelas[tabela]!.filter((l) => filtros.every(([c, v]) => l[c] === v));

    const executar = (): { data: unknown; error: ErroPg | null } => {
      if (modo === "select") {
        let rows = casam();
        if (ordem)
          rows = [...rows].sort((a, b) => String(a[ordem!]).localeCompare(String(b[ordem!])));
        return { data: rows.map((l) => projetar(l, colunas)), error: null };
      }
      const chave = `${tabela}.${modo}` as keyof typeof falhas;
      escritas.push({ tabela, operacao: modo, valores });
      const falha = falhas[chave];
      if (falha) {
        delete falhas[chave];
        return { data: null, error: falha };
      }
      if (modo === "insert") {
        if (tabela === "green_products") {
          const dup = produtos.some(
            (p) => p.organization_id === valores.organization_id && p.code === valores.code,
          );
          if (dup) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        if (
          tabela === "green_lead_context" &&
          contextos.some((c) => c.lead_id === valores.lead_id)
        ) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const nova: Linha = {
          id: tabela === "green_products" ? randomUUID() : undefined,
          is_active: true,
          created_at: "2026-10-07T12:00:00Z",
          updated_at: "2026-10-07T12:00:00Z",
          ...valores,
        };
        tabelas[tabela]!.push(nova);
        return { data: [projetar(nova, colunas)], error: null };
      }
      const alvos = casam();
      for (const a of alvos) Object.assign(a, valores);
      return { data: alvos.map((l) => projetar(l, colunas)), error: null };
    };

    const cadeia: Record<string, unknown> = {
      select: (c = "*") => {
        colunas = c;
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return cadeia;
      },
      order: (c: string) => {
        ordem = c;
        return cadeia;
      },
      insert: (v: Linha) => {
        modo = "insert";
        valores = v;
        return cadeia;
      },
      update: (v: Linha) => {
        modo = "update";
        valores = v;
        return cadeia;
      },
      single: async () => {
        const r = executar();
        const rows = (r.data as Linha[] | null) ?? [];
        return {
          data: rows[0] ?? null,
          error: r.error ?? (rows[0] ? null : { message: "0 rows" }),
        };
      },
      maybeSingle: async () => {
        const r = executar();
        const rows = (r.data as Linha[] | null) ?? [];
        return { data: rows[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(resolve, reject),
    };
    return cadeia;
  }

  return {
    produtos,
    contextos,
    escritas,
    rpcs,
    db: {
      from: (tabela: string) => consulta(tabela),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        rpcs.push({ nome, args });
        if (nome === "fn_green_lead_eligible") {
          return { data: (opts.leadsGreen ?? []).includes(String(args.p_lead)), error: null };
        }
        return { data: null, error: { message: `rpc inesperada: ${nome}` } };
      },
    },
  };
}
