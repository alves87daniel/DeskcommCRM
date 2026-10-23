/**
 * 0512 — O NÚMERO DE ENTRADA SÓ SE RESOLVE NO SERVIDOR (issue #65, item 3 da #36).
 *
 * `fn_resolve_inbound_number(text)` é `security definer`: lê `phone_numbers`
 * ignorando a RLS e devolve organização, modo de roteamento, agente e
 * atendente de reserva do número discado. Não confere a organização de quem
 * chama — nem tem como, porque o único chamador legítimo é o worker de voz,
 * com o cliente admin (`service_role`).
 *
 * A 0347 revogou `EXECUTE` de `public` e `anon`, mas o grant a `authenticated`
 * vem do `ALTER DEFAULT PRIVILEGES` do baseline e ficou. Pelo PostgREST,
 * qualquer usuário logado de qualquer tenant chamava a função e descobria a
 * organização e o agente de um número de outro tenant. O primeiro caso abaixo
 * mede exatamente isso, com um usuário que não é membro de organização nenhuma.
 *
 * Mede também os outros dois pedaços do mesmo porte (upstream `b31ff5ce8`):
 *   · nenhuma função de `public` fora de extensão fica sem `search_path` fixo;
 *   · `rls_auto_enable()`, que o Supabase cria em projeto novo com EXECUTE para
 *     `authenticated`, perde esse grant quando a migration roda.
 *
 * Previsão escrita antes de rodar (sabotagem): sem o bloco da 0512 no
 * baseline, caem o caso do usuário de fora (devolve a organização em vez de
 * 42501), o de privilégio de `authenticated` e o de `search_path`. O controle
 * do `service_role` e o de `anon` seguem verdes, porque a 0347 já os deixava
 * certos.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "05120000-0000-4000-8000-000000000001";
const NUMERO = "+5511990512000";
/** Usuário logado sem vínculo com organização nenhuma: o "outro tenant". */
const DE_FORA = "05120000-1111-4000-8000-000000000001";
const ASSINATURA = "public.fn_resolve_inbound_number(text)";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20261022120000_0512_numero_de_entrada_so_do_servidor.sql",
);

function booleano(consulta: string): boolean {
  const cru = sql(consulta).split("\n").pop();
  if (cru === "t" || cru === "true") return true;
  if (cru === "f" || cru === "false") return false;
  throw new Error(`INSTRUMENTO: o psql não devolveu um booleano: ${JSON.stringify(cru)}`);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, display_name, legal_name)
      values ('${ORG}', 'org-0512-invariante', 'Org 0512', 'Org 0512 Ltda')
      on conflict (id) do nothing;
    insert into public.phone_numbers (organization_id, number, trunk_endpoint)
      values ('${ORG}', '${NUMERO}', 'sip:0512@invariant.test')
      on conflict (number) do nothing;
  `);
});

describe("0512 — fn_resolve_inbound_number é só do servidor", () => {
  it("usuário logado de fora NÃO resolve o número de outro tenant", () => {
    // sem a 0512 isto devolve a organização do número — era o vazamento
    let saida = "";
    let motivo = "";
    try {
      saida = sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${DE_FORA}"}', false);
        select organization_id from public.fn_resolve_inbound_number('${NUMERO}');
      `);
    } catch (err) {
      motivo = motivoDoErro(err);
    }
    expect(saida).not.toContain(ORG);
    expect(motivo).toMatch(/permission denied for function fn_resolve_inbound_number/);
  });

  it("authenticated não tem EXECUTE", () => {
    expect(
      booleano(`select has_function_privilege('authenticated', '${ASSINATURA}', 'EXECUTE')::text`),
    ).toBe(false);
  });

  it("anon não tem EXECUTE", () => {
    expect(
      booleano(`select has_function_privilege('anon', '${ASSINATURA}', 'EXECUTE')::text`),
    ).toBe(false);
  });

  it("CONTROLE POSITIVO: o service_role (worker de voz) resolve o número", () => {
    const saida = sql(`
      set role service_role;
      select organization_id from public.fn_resolve_inbound_number('${NUMERO}');
    `);
    expect(saida.split("\n").pop()).toBe(ORG);
  });
});

describe("0512 — search_path fixo em toda função de public", () => {
  it("nenhuma função de public fora de extensão fica sem search_path", () => {
    const semSearchPath = sql(`
      select p.oid::regprocedure::text
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind in ('f', 'p')
         and not exists (
           select 1 from pg_depend d
            where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
         )
         and not exists (
           select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'
         )
       order by 1;
    `);
    expect(semSearchPath.split("\n").filter(Boolean)).toEqual([]);
  });
});

describe("0512 — rls_auto_enable criada pelo Supabase perde o EXECUTE de authenticated", () => {
  it("a migration revoga o grant quando a função existe", () => {
    sql(`
      create or replace function public.rls_auto_enable() returns void
        language sql set search_path = '' as $$ select $$;
      grant execute on function public.rls_auto_enable() to authenticated;
    `);
    try {
      expect(
        booleano(
          `select has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')::text`,
        ),
      ).toBe(true);
      // reaplicar a migration também prova que ela é idempotente sobre o baseline
      sql(readFileSync(MIGRATION, "utf8"));
      expect(
        booleano(
          `select has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')::text`,
        ),
      ).toBe(false);
    } finally {
      sql(`drop function if exists public.rls_auto_enable();`);
    }
  });
});
