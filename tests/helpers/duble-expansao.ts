/**
 * Dublê em memória do que a rota da expansão pós-ganho lê e escreve (CG-COM-01).
 *
 * Reproduz a forma do supabase-js que a rota usa (`from().select().eq().in().gt().order()
 * .limit().maybeSingle()`, `insert`, `update`, `rpc`). A RLS, os triggers e a RPC de escrita NÃO
 * são reimplementados aqui: quem prova o contrato do banco é
 * `tests/invariants/green-expansion-commercial-origin.test.ts`. O teste PROGRAMA o desfecho das
 * RPCs (`rpcs`), para provar que a rota chama o banco certo e traduz cada recusa nomeada.
 *
 * `idempotency_keys` tem a unicidade real (organização + chave + endpoint), para que a
 * `Idempotency-Key` seja provada pelo helper real (`lib/api/idempotency.ts`), não por um mock.
 */
export type Linha = Record<string, unknown>;
export interface ErroPg {
  code?: string;
  message: string;
  details?: string;
}
export type RespostaRpc = { data: unknown; error: ErroPg | null };

export interface DubleExpansao {
  db: {
    from: (tabela: string) => unknown;
    rpc: (nome: string, args: Record<string, unknown>) => Promise<RespostaRpc>;
  };
  tabelas: Record<string, Linha[]>;
  escritas: { tabela: string; operacao: "insert" | "update"; valores: Linha }[];
  chamadas: { nome: string; args: Record<string, unknown> }[];
}

const UNICAS: Record<string, string[]> = {
  idempotency_keys: ["organization_id", "key", "endpoint"],
};

export function dubleExpansao(opts: {
  tabelas?: Record<string, Linha[]>;
  rpcs?: Record<string, (args: Record<string, unknown>) => RespostaRpc>;
}): DubleExpansao {
  const tabelas: Record<string, Linha[]> = { ...(opts.tabelas ?? {}) };
  const escritas: DubleExpansao["escritas"] = [];
  const chamadas: DubleExpansao["chamadas"] = [];
  const linhasDe = (t: string) => (tabelas[t] ??= []);

  const projetar = (linha: Linha, colunas: string) => {
    if (colunas.trim() === "*") return { ...linha };
    const out: Linha = {};
    for (const c of colunas.split(",").map((x) => x.trim())) out[c] = linha[c];
    return out;
  };

  function consulta(tabela: string) {
    type Filtro = (l: Linha) => boolean;
    const filtros: Filtro[] = [];
    let colunas = "*";
    let modo: "select" | "insert" | "update" = "select";
    let valores: Linha = {};
    const ordens: { c: string; asc: boolean }[] = [];
    let limite: number | null = null;

    const casam = () => linhasDe(tabela).filter((l) => filtros.every((f) => f(l)));

    const executar = (): { data: Linha[] | null; error: ErroPg | null } => {
      if (modo === "select") {
        let rows = casam();
        // ordem ESTÁVEL por chave, do último critério para o primeiro; número compara como
        // número (`position` 500 vem antes de 1000), o resto como texto
        const comparar = (x: unknown, y: unknown) =>
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x ?? "").localeCompare(String(y ?? ""));
        for (const o of [...ordens].reverse()) {
          rows = [...rows].sort((a, b) => comparar(a[o.c], b[o.c]) * (o.asc ? 1 : -1));
        }
        if (limite !== null) rows = rows.slice(0, limite);
        return { data: rows.map((l) => projetar(l, colunas)), error: null };
      }
      escritas.push({ tabela, operacao: modo, valores });
      if (modo === "insert") {
        const chave = UNICAS[tabela];
        if (chave && linhasDe(tabela).some((l) => chave.every((c) => l[c] === valores[c]))) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const nova = { id: `${tabela}-${linhasDe(tabela).length + 1}`, ...valores };
        linhasDe(tabela).push(nova);
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
        filtros.push((l) => l[c] === v);
        return cadeia;
      },
      in: (c: string, vs: unknown[]) => {
        filtros.push((l) => vs.includes(l[c]));
        return cadeia;
      },
      gt: (c: string, v: string) => {
        filtros.push((l) => String(l[c]) > v);
        return cadeia;
      },
      order: (c: string, o?: { ascending?: boolean }) => {
        ordens.push({ c, asc: o?.ascending !== false });
        return cadeia;
      },
      limit: (n: number) => {
        limite = n;
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
      maybeSingle: async () => {
        const r = executar();
        if (r.error) return { data: null, error: r.error };
        const rows = r.data ?? [];
        if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const r = executar();
        const rows = r.data ?? [];
        return {
          data: rows[0] ?? null,
          error: r.error ?? (rows[0] ? null : { message: "0 rows" }),
        };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(resolve, reject),
    };
    return cadeia;
  }

  return {
    tabelas,
    escritas,
    chamadas,
    db: {
      from: (tabela: string) => consulta(tabela),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chamadas.push({ nome, args });
        const f = opts.rpcs?.[nome];
        if (!f) return { data: null, error: { message: `rpc inesperada: ${nome}` } };
        return f(args);
      },
    },
  };
}
