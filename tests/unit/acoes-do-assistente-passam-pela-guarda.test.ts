/**
 * TODA AÇÃO DO ASSISTENTE PASSA PELA GUARDA (CG-IAM-01).
 *
 * `tests/unit/assistente-so-o-admin-configura.test.ts` mede a recusa ação por
 * ação — mas só das ações que existem hoje. Um arquivo `"use server"` expõe
 * TODO export como endpoint, e foi exatamente assim que `dadosDoPasso` virou
 * porta: uma função de leitura, chamada só pela página, que qualquer navegador
 * alcançava com o `orgId` de outra empresa. Esta cerca lê
 * `app/actions/onboarding/` e reprova export assíncrono que não chame
 * `requireOnboardingCtx()` — a ação nova nasce guardada ou o CI reprova.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PASTA = join(process.cwd(), "app/actions/onboarding");

/** Os exports assíncronos de um módulo e o corpo de cada um (até o próximo export). */
function exportsSemGuarda(fonte: string): string[] {
  const partes = fonte.split(/^export async function /m).slice(1);
  return partes
    .filter((corpo) => !/\brequireOnboardingCtx\(\)/.test(corpo))
    .map((corpo) => corpo.slice(0, corpo.indexOf("(")));
}

describe("ações do assistente", () => {
  const arquivos = readdirSync(PASTA).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "_shared.ts",
  );

  it("a pasta tem as ações que a cerca diz vigiar", () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(8);
  });

  for (const arquivo of arquivos) {
    it(`${arquivo}: todo export assíncrono chama requireOnboardingCtx()`, () => {
      const fonte = readFileSync(join(PASTA, arquivo), "utf8");
      expect(fonte.startsWith('"use server"'), `${arquivo} deixou de ser "use server"?`).toBe(true);
      expect(exportsSemGuarda(fonte), `${arquivo} expõe action sem a guarda do assistente`).toEqual(
        [],
      );
    });
  }

  it("a sonda reconhece a ação sem guarda — senão o verde acima não prova nada", () => {
    const fonte = [
      '"use server";',
      "export async function guardada() { const ctx = await requireOnboardingCtx(); }",
      "export async function dadosDoPasso(orgId: string) { return ler(orgId); }",
    ].join("\n");
    expect(exportsSemGuarda(fonte)).toEqual(["dadosDoPasso"]);
  });
});
