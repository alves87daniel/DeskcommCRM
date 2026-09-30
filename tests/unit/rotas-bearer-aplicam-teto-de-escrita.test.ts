import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TETO DE ESCRITA: toda rota que aceita Bearer via `resolveAuthDual` PRECISA
 * chamar `tetoDeEscritaDoToken` (#1999).
 *
 * `PUBLIC_PATHS` tira essas rotas do estrangulamento a montante (o `proxy.ts`
 * global só reconhece cookie), então *o que não for contado na rota não é
 * contado em lugar nenhum* (`lib/api/auth-dual.ts:159`). As 4 irmãs
 * (`messages`, `drafts`, `leads`, `agenda`) já aplicam; estas 4 aqui estavam
 * sem o limitador — uma integração por token em laço numa delas não atravessa
 * o teto de escrita por token nem por organização, derrubando o número real
 * (WhatsApp bane por VOLUME).
 *
 * O teste é uma varredura do arquivo-fonte, não uma execução do route handler:
 * o que se fixa é o CONTRATO de que o limitador está no caminho de escrita da
 * rota. Rota nova que chame `resolveAuthDual` sem o teto entra na lista viva
 * abaixo e reprova até ganhar o limitador.
 */
const RAIZ = process.cwd();

/** Caminhos RELATIVOS das rotas Bearer (resolveAuthDual) que devem aplicar o teto. */
const ROTAS_COM_TETO = [
  "app/api/v1/conversations/[id]/drafts/consume/route.ts",
  "app/api/v1/conversations/open-with-contact/route.ts",
  "app/api/v1/conversations/[id]/media/route.ts",
  "app/api/v1/conversations/[id]/notes/media/route.ts",
] as const;

const caminho = (rel: string) => path.join(RAIZ, rel);

describe("rotas Bearer aplicam teto de escrita", () => {
  it.each([...ROTAS_COM_TETO])("%s aplica tetoDeEscritaDoToken", (rel) => {
    const fonte = readFileSync(caminho(rel), "utf8");

    expect(fonte, `${rel} deveria importar tetoDeEscritaDoToken`)
      .toContain("tetoDeEscritaDoToken");
    expect(fonte, `${rel} deveria chamar tetoDeEscritaDoToken com o recurso`)
      .toMatch(/await tetoDeEscritaDoToken\(authz, "[^"]+", requestId\)/);
  });

  it("a lista das 4 rotas tem exatamente as 4 que hoje aplicam o teto (controle de vacuidade)", () => {
    // Controle positivo: o teste não pode ficar verde por varrer nada. Se a
    // lista esvaziar ou um caminho voltar a não existir, reprova.
    expect(ROTAS_COM_TETO.length).toBe(4);
    for (const rel of ROTAS_COM_TETO) {
      const fonte = readFileSync(caminho(rel), "utf8");
      expect(
        fonte.includes("resolveAuthDual") && fonte.includes("tetoDeEscritaDoToken("),
        `${rel} deve continuar sendo rota Bearer com teto`,
      ).toBe(true);
    }
  });
});