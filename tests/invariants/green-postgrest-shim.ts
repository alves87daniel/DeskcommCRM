/**
 * SPIKE Green lifecycle (descartável) — dublê de PostgREST sobre `pg`, com o
 * PAPEL da request simulado.
 *
 * O Postgres efêmero do `test:db` não tem PostgREST. Os dublês que já existem
 * (`webhooks-inbound.test.ts`) executam como `postgres` via `docker exec psql`
 * — para a fronteira Green isso é o caller `direct`, que não é o que a produção
 * entrega. Este dublê executa cada chamada como o PostgREST a executa:
 *
 *   begin → set local role <papel> → request.jwt.claims → request.headers →
 *   UMA instrução → commit (rollback no erro)
 *
 * e o header `x-green-mutation-context` sai do MESMO lugar que em produção: o
 * escopo ALS corrente, lido por `initComContextoGreen` no momento da chamada
 * (é o que `fetchDoServidor` faz). Assim o código real (rotas, handlers, libs)
 * roda contra o banco real com triggers reais, e o teste não injeta contexto
 * por fora: quem declara é o seam do código sob teste.
 *
 * Escrita de linhas usa `json_populate_record(set)` — a mesma técnica do
 * PostgREST —, então o tipo de cada coluna vem do banco, não do JS.
 *
 * Fora do contrato: embed (`tabela(colunas)`) devolve `null` (os fixtures que
 * usam este dublê não têm linhas embutidas que importem); método não suportado
 * LANÇA, para o teste nunca ficar verde por um caminho que o dublê não executou.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { initComContextoGreen } from "@/lib/green/mutation-context";

export interface Identidade {
  papel: "service_role" | "authenticated";
  sub?: string;
}

interface ErroPgrst {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}
interface Resposta {
  data: unknown;
  error: ErroPgrst | null;
  count: number | null;
  status: number;
}

/** Uma chamada ao PostgREST: o registro que o teste pode inspecionar. */
export interface ChamadaRegistrada {
  alvo: string;
  op: string;
  contexto: string | null;
}

function headersDaChamada(): Record<string, string> {
  const h: Record<string, string> = { "sb-request-id": randomUUID() };
  const init = initComContextoGreen("http://shim.local/rest/v1", { headers: {} });
  new Headers(init?.headers).forEach((valor, nome) => {
    h[nome] = valor;
  });
  return h;
}

function erroDe(e: unknown): ErroPgrst {
  const d = e as pg.DatabaseError;
  return {
    code: d.code ?? "PGRST000",
    message: d.message ?? String(e),
    details: d.detail ?? null,
    hint: d.hint ?? null,
  };
}

async function naRequest<T>(
  pool: pg.Pool,
  quem: Identidade,
  registro: ChamadaRegistrada[],
  alvo: string,
  op: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const headers = headersDaChamada();
  registro.push({ alvo, op, contexto: headers["x-green-mutation-context"] ?? null });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${quem.papel}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(
        quem.papel === "authenticated"
          ? { sub: quem.sub, role: "authenticated" }
          : { role: "service_role" },
      ),
    ]);
    await c.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(nome: string): string {
  if (!IDENT.test(nome)) throw new Error(`dublê PostgREST: identificador não suportado: ${nome}`);
  return `"${nome}"`;
}

/** `a, b:c, emb(x,y), d!inner(z)` → lista SQL. Embed vira `null`. */
function colunas(sel: string): string {
  if (sel.trim() === "*" || sel.trim() === "") return "*";
  const partes: string[] = [];
  let prof = 0;
  let atual = "";
  for (const ch of sel) {
    if (ch === "(") prof++;
    if (ch === ")") prof--;
    if (ch === "," && prof === 0) {
      partes.push(atual.trim());
      atual = "";
    } else atual += ch;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes
    .map((p) => {
      if (p.includes("(")) {
        const nome = p.slice(0, p.indexOf("(")).split("!")[0]!.split(":")[0]!.trim();
        return `null::jsonb as ${ident(nome)}`;
      }
      if (p === "*") return "*";
      const [alias, col] = p.includes(":") ? p.split(":") : [p, p];
      return col === alias
        ? ident(col!.trim())
        : `${ident(col!.trim())} as ${ident(alias!.trim())}`;
    })
    .join(", ");
}

type Filtro = { sql: (n: () => string) => string; valores: unknown[] };

class Consulta implements PromiseLike<Resposta> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private sel = "*";
  private retorno: string | null = null;
  private valores: unknown = null;
  private onConflict: string | null = null;
  private ignorarDuplicados = false;
  private filtros: Filtro[] = [];
  private ordens: string[] = [];
  private lim: number | null = null;
  private contagem = false;
  private soCabecalho = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly quem: Identidade,
    private readonly registro: ChamadaRegistrada[],
    private readonly tabela: string,
  ) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (this.op === "select") this.sel = cols;
    else this.retorno = cols;
    if (opts?.count) this.contagem = true;
    if (opts?.head) this.soCabecalho = true;
    return this;
  }
  insert(v: unknown, opts?: { count?: string }): this {
    this.op = "insert";
    this.valores = v;
    if (opts?.count) this.contagem = true;
    return this;
  }
  upsert(v: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.valores = v;
    this.onConflict = opts?.onConflict ?? null;
    this.ignorarDuplicados = opts?.ignoreDuplicates ?? false;
    return this;
  }
  update(v: Record<string, unknown>, opts?: { count?: string }): this {
    this.op = "update";
    this.valores = v;
    if (opts?.count) this.contagem = true;
    return this;
  }
  delete(opts?: { count?: string }): this {
    this.op = "delete";
    if (opts?.count) this.contagem = true;
    return this;
  }

  private filtro(
    f: (col: string, n: () => string) => string,
    col: string,
    valores: unknown[],
  ): this {
    this.filtros.push({ sql: (n) => f(ident(col), n), valores });
    return this;
  }
  eq(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} = ${n()}`, c, [v]);
  }
  neq(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} is distinct from ${n()}`, c, [v]);
  }
  gt(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} > ${n()}`, c, [v]);
  }
  gte(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} >= ${n()}`, c, [v]);
  }
  lt(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} < ${n()}`, c, [v]);
  }
  lte(c: string, v: unknown) {
    return this.filtro((col, n) => `${col} <= ${n()}`, c, [v]);
  }
  in(c: string, v: unknown[]) {
    return this.filtro((col, n) => `${col} = any(${n()})`, c, [v]);
  }
  is(c: string, v: null | boolean) {
    const lit = v === null ? "null" : v ? "true" : "false";
    this.filtros.push({ sql: () => `${ident(c)} is ${lit}`, valores: [] });
    return this;
  }
  not(c: string, op: string, v: unknown) {
    if (op !== "is" || v !== null) throw new Error(`dublê PostgREST: not(${op}) não suportado`);
    this.filtros.push({ sql: () => `${ident(c)} is not null`, valores: [] });
    return this;
  }
  order(c: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? "desc" : "asc";
    const nulls =
      opts?.nullsFirst === undefined ? "" : opts.nullsFirst ? " nulls first" : " nulls last";
    this.ordens.push(`${ident(c)} ${dir}${nulls}`);
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    return this;
  }

  private where(args: unknown[]): string {
    if (!this.filtros.length) return "";
    const partes = this.filtros.map((f) => {
      for (const v of f.valores) args.push(v);
      // cada filtro tem no máximo um valor: o dele é o último empurrado
      return f.sql(() => `$${args.length}`);
    });
    return ` where ${partes.join(" and ")}`;
  }

  private sql(): { texto: string; args: unknown[] } {
    const args: unknown[] = [];
    const t = `public.${ident(this.tabela)}`;
    if (this.op === "select") {
      let q = `select ${colunas(this.sel)} from ${t}${this.where(args)}`;
      if (this.ordens.length) q += ` order by ${this.ordens.join(", ")}`;
      if (this.lim !== null) q += ` limit ${this.lim}`;
      return { texto: q, args };
    }
    const ret = this.retorno === null ? "" : ` returning ${colunas(this.retorno)}`;
    if (this.op === "insert" || this.op === "upsert") {
      const linhas = Array.isArray(this.valores) ? this.valores : [this.valores];
      const cols = [...new Set(linhas.flatMap((l) => Object.keys(l as object)))];
      args.push(JSON.stringify(linhas));
      const lista = cols.map(ident).join(", ");
      let q = `insert into ${t} (${lista}) select ${lista} from json_populate_recordset(null::${t}, $1::json)`;
      if (this.op === "upsert") {
        const alvo = (this.onConflict ?? "id")
          .split(",")
          .map((c) => ident(c.trim()))
          .join(", ");
        q += this.ignorarDuplicados
          ? ` on conflict (${alvo}) do nothing`
          : ` on conflict (${alvo}) do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
      }
      return { texto: q + ret, args };
    }
    if (this.op === "update") {
      const cols = Object.keys(this.valores as object);
      args.push(JSON.stringify(this.valores));
      const lista = cols.map(ident).join(", ");
      const q = `update ${t} set (${lista}) = (select ${lista} from json_populate_record(null::${t}, $1::json))${this.where(args)}`;
      return { texto: q + ret, args };
    }
    return { texto: `delete from ${t}${this.where(args)}${ret}`, args };
  }

  async executar(): Promise<Resposta> {
    try {
      return await naRequest(
        this.pool,
        this.quem,
        this.registro,
        this.tabela,
        this.op,
        async (c) => {
          const { texto, args } = this.sql();
          if (this.op === "select") {
            const r = await c.query<{ j: unknown[]; n: string }>(
              `select coalesce(json_agg(t), '[]') as j, count(*) as n from (${texto}) t`,
              args,
            );
            const linhas = r.rows[0]!.j;
            return {
              data: this.soCabecalho ? null : linhas,
              error: null,
              count: this.contagem ? Number(r.rows[0]!.n) : null,
              status: 200,
            };
          }
          const comRetorno = this.retorno !== null;
          const textoComRetorno = comRetorno ? texto : `${texto} returning 1`;
          const r = await c.query<{ j: unknown[]; n: string }>(
            `with w as (${textoComRetorno}) select coalesce(json_agg(w), '[]') as j, count(*) as n from w`,
            args,
          );
          return {
            data: comRetorno ? r.rows[0]!.j : null,
            error: null,
            count: this.contagem ? Number(r.rows[0]!.n) : null,
            status: this.op === "insert" ? 201 : 200,
          };
        },
      );
    } catch (e) {
      return { data: null, error: erroDe(e), count: null, status: 400 };
    }
  }

  then<A = Resposta, B = never>(
    ok?: ((v: Resposta) => A | PromiseLike<A>) | null,
    falha?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.executar().then(ok, falha);
  }

  async maybeSingle(): Promise<Resposta> {
    const r = await this.executar();
    if (r.error) return r;
    const linhas = (r.data as unknown[] | null) ?? [];
    if (linhas.length > 1)
      return {
        data: null,
        error: {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: null,
          hint: null,
        },
        count: r.count,
        status: 406,
      };
    return { ...r, data: linhas[0] ?? null };
  }

  async single(): Promise<Resposta> {
    const r = await this.executar();
    if (r.error) return r;
    const linhas = (r.data as unknown[] | null) ?? [];
    if (linhas.length !== 1)
      return {
        data: null,
        error: {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: null,
          hint: null,
        },
        count: r.count,
        status: 406,
      };
    return { ...r, data: linhas[0] };
  }
}

/**
 * Um `SupabaseClient` de faz-de-conta com o papel `quem`, ligado ao `pool`.
 * `registro` recebe uma linha por chamada (alvo, operação e o header Green que
 * a chamada levou) — é a testemunha de QUAL request carregou contexto.
 */
export function clientePostgrest(
  pool: pg.Pool,
  quem: Identidade = { papel: "service_role" },
  registro: ChamadaRegistrada[] = [],
): SupabaseClient {
  const cliente = {
    from: (tabela: string) => new Consulta(pool, quem, registro, tabela),
    rpc: async (fn: string, params: Record<string, unknown> = {}): Promise<Resposta> => {
      try {
        return await naRequest(pool, quem, registro, fn, "rpc", async (c) => {
          const nomes = Object.keys(params);
          const args = nomes.map((n) => {
            const v = params[n];
            return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
          });
          const lista = nomes.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ");
          const r = await c.query(`select * from public.${ident(fn)}(${lista})`, args);
          const escalar = r.fields.length === 1 && r.fields[0]!.name === fn;
          const vazio = escalar && r.fields[0]!.dataTypeID === 2278; // `returns void`
          return {
            data: vazio ? null : escalar ? (r.rows[0]?.[fn] ?? null) : r.rows,
            error: null,
            count: null,
            status: 200,
          };
        });
      } catch (e) {
        return { data: null, error: erroDe(e), count: null, status: 400 };
      }
    },
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
  return cliente as unknown as SupabaseClient;
}
