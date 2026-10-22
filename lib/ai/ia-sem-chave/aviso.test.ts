/**
 * O CICLO DE VIDA DO AVISO "IA desligada por falta de chave" (ADR-0005, D3 —
 * item 20 da #33): um só aberto por organização; fecha quando a credencial
 * chega; reabre, como linha NOVA, se a chave voltar a faltar — e a história
 * fica (o fechado não some).
 *
 * O banco é um dublê que interpreta só o SQL que estas funções emitem: a dedup
 * por título aberto do `insertInboxItem`, e o `update ... set status =
 * 'resolved'` do fechamento. Se o SQL mudar de forma, o dublê devolve nada e o
 * caso cai — alto, e não como um verde que não mediu.
 */
import { describe, expect, it } from "vitest";

import {
  avisarIaDesligadaPorFaltaDeChave,
  fecharAvisoDeIaSemChave,
  fecharAvisoDeIaSemChaveViaSupabase,
  TITULOS_DO_AVISO_DE_IA_SEM_CHAVE,
} from "./aviso";
import { TITULO_DO_AVISO_DE_IA_SEM_CHAVE } from "./motivo";

const ORG = "11111111-1111-4111-8111-111111111111";

interface Linha {
  organization_id: string;
  kind: string;
  title: string;
  status: "open" | "resolved";
}

function bancoFalso(locale: string | null = "pt-BR") {
  const linhas: Linha[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select locale from organizations")) return { rows: [{ locale }] };
    if (sql.includes("insert into agent_inbox_items")) {
      const [organization_id, kind, , title] = params as [string, string, string, string];
      const aberto = linhas.some(
        (l) => l.organization_id === organization_id && l.kind === kind && l.title === title && l.status === "open",
      );
      if (aberto) return { rows: [] };
      const nova: Linha = { organization_id, kind, title, status: "open" };
      linhas.push(nova);
      return { rows: [nova] };
    }
    if (sql.includes("update agent_inbox_items set status = 'resolved'")) {
      const [organization_id, titulos] = params as [string, string[]];
      for (const l of linhas) {
        if (l.organization_id === organization_id && l.kind === "other" && l.status === "open" && titulos.includes(l.title)) {
          l.status = "resolved";
        }
      }
      return { rows: [] };
    }
    throw new Error(`SQL que o dublê não conhece: ${sql.slice(0, 60)}`);
  };
  return { linhas, db: { query } as never };
}

describe("o aviso de IA sem chave — um por organização, fecha com a credencial, reabre sem ela", () => {
  it("N conversas sem chave abrem UM aviso", async () => {
    const { linhas, db } = bancoFalso();
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ title: TITULO_DO_AVISO_DE_IA_SEM_CHAVE, status: "open" });
  });

  it("a credencial cadastrada FECHA o aviso; sem aviso aberto, fechar não faz nada", async () => {
    const { linhas, db } = bancoFalso();
    await fecharAvisoDeIaSemChave(db, ORG); // nada aberto: idempotente
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await fecharAvisoDeIaSemChave(db, ORG);
    expect(linhas.map((l) => l.status)).toEqual(["resolved"]);
  });

  it("a chave que volta a faltar REABRE — linha nova, e a fechada fica como história", async () => {
    const { linhas, db } = bancoFalso();
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await fecharAvisoDeIaSemChave(db, ORG);
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    expect(linhas.map((l) => l.status)).toEqual(["resolved", "open"]);
  });

  it("o fechamento acha o título gravado em espanhol — a organização em es não fica com o aviso preso", async () => {
    const { linhas, db } = bancoFalso("es");
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    expect(linhas[0]!.title).not.toBe(TITULO_DO_AVISO_DE_IA_SEM_CHAVE); // gravado traduzido
    expect(TITULOS_DO_AVISO_DE_IA_SEM_CHAVE).toContain(linhas[0]!.title);
    await fecharAvisoDeIaSemChave(db, ORG);
    expect(linhas[0]!.status).toBe("resolved");
  });

  it("o fechamento NÃO encosta no aviso de outra organização nem em item de outro título", async () => {
    const { linhas, db } = bancoFalso();
    const OUTRA = "22222222-2222-4222-8222-222222222222";
    await avisarIaDesligadaPorFaltaDeChave(db, ORG);
    await avisarIaDesligadaPorFaltaDeChave(db, OUTRA);
    linhas.push({ organization_id: ORG, kind: "other", title: "Outro aviso qualquer", status: "open" });
    await fecharAvisoDeIaSemChave(db, ORG);
    expect(linhas.map((l) => `${l.organization_id === ORG ? "org" : "outra"}:${l.title === TITULO_DO_AVISO_DE_IA_SEM_CHAVE ? "aviso" : "outro"}:${l.status}`)).toEqual([
      "org:aviso:resolved",
      "outra:aviso:open",
      "org:outro:open",
    ]);
  });

  it("a porta Supabase fecha pelos MESMOS filtros (organização, kind, aberto, todos os títulos)", async () => {
    const filtros: Array<[string, unknown]> = [];
    let patch: unknown = null;
    const cadeia = {
      update: (p: unknown) => {
        patch = p;
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return cadeia;
      },
      in: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return Promise.resolve({ data: null, error: null });
      },
    };
    const admin = { from: (t: string) => (t === "agent_inbox_items" ? cadeia : null) } as never;
    await fecharAvisoDeIaSemChaveViaSupabase(admin, ORG);
    expect(patch).toEqual({ status: "resolved" });
    expect(filtros).toEqual([
      ["organization_id", ORG],
      ["kind", "other"],
      ["status", "open"],
      ["title", [...TITULOS_DO_AVISO_DE_IA_SEM_CHAVE]],
    ]);
  });
});
