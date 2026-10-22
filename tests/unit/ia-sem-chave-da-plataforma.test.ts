/**
 * A CERCA DA ADR-0005: NENHUM CÓDIGO DE PRODUTO LÊ CHAVE DE IA DO AMBIENTE.
 *
 * A plataforma não custeia IA. A chave de todo ponto de IA sai de
 * `ai_provider_credentials` da organização, ativa e validada; sem ela, o
 * recurso fica desligado para aquela organização, com aviso na tela. As
 * variáveis `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` e
 * `AI_GATEWAY_API_KEY` seguem DECLARADAS em `lib/env.ts` e `lib/agent-engine/env.ts`
 * — para scripts locais — e é só ali que o nome delas pode aparecer.
 *
 * Por que uma cerca, e não só os testes de comportamento: cinco resolvedores
 * independentes chegaram ao `.env` por cinco caminhos diferentes, cada um com
 * uma boa razão local (issue #32). O próximo degrau vai nascer com uma razão
 * igualmente boa, num arquivo que nenhum teste de comportamento olha. Esta
 * varredura olha TODOS, de uma vez, e reprova antes de a razão ser lida.
 *
 * O que é medido, em cada arquivo de `app|lib|workers|hooks|components` fora
 * da allowlist, na ÁRVORE SINTÁTICA (comentário não é nó — mencionar a
 * variável num comentário é permitido e inevitável):
 *
 *   1. leitura de chave do ambiente: `process.env.X`, `env.X`, `process.env["X"]`
 *      — e, mais largo, QUALQUER ocorrência do nome `X` como identificador ou
 *      string: uma tabela `{ anthropic: "ANTHROPIC_API_KEY" }` lida por
 *      `process.env[tabela[p]]` é a mesma leitura por outra porta
 *      (`lib/instalacao/ambiente.ts` fazia exatamente isso);
 *   2. os identificadores que davam nome ao fallback: `chave_da_instalacao`,
 *      `chaveDePlataforma`, `padraoDaInstalacao`, `PlatformKeys` — como
 *      identificador ou como string (os tipos-união os escreviam como string)
 *      — e a origem `"padrao"` do resolvedor da pilha antiga.
 *
 * A allowlist SÓ ENCOLHE: ela é a lista escrita abaixo, e crescer é editar
 * este arquivo — com a razão ao lado, para quem revisa.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PASTAS = ["app", "lib", "workers", "hooks", "components"];
const FORA = new Set(["node_modules", ".next", "dist"]);

/**
 * Onde o NOME das variáveis pode aparecer. Só declaração de schema para
 * scripts locais; nenhum dos dois lê a chave para atender organização.
 */
export const ALLOWLIST = new Set<string>(["lib/env.ts", "lib/agent-engine/env.ts"]);

const CHAVES_DE_IA = /^(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|AI_GATEWAY_API_KEY|TRANSCRIPTION_API_KEY|GOOGLE_[A-Z_]*API_KEY)$/;
const IDENTIFICADORES_DO_FALLBACK = new Set([
  "chave_da_instalacao",
  "chaveDePlataforma",
  "padraoDaInstalacao",
  "PlatformKeys",
]);

export interface Violacao {
  regra: "leitura_de_chave_do_ambiente" | "nome_de_chave_de_ia" | "identificador_do_fallback" | "origem_padrao";
  texto: string;
  linha: number;
}

function textoDoNome(node: ts.Node): string | null {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

/** O nó é o `X` de `env.X` / `process.env.X` / `env["X"]` / `process.env["X"]`? */
function lidoDoEnv(node: ts.Node): boolean {
  const pai = node.parent;
  if (!pai) return false;
  const objeto = ts.isPropertyAccessExpression(pai) && pai.name === node
    ? pai.expression
    : ts.isElementAccessExpression(pai) && pai.argumentExpression === node
      ? pai.expression
      : null;
  if (objeto === null) return false;
  if (ts.isIdentifier(objeto)) return objeto.text === "env";
  return ts.isPropertyAccessExpression(objeto) && objeto.name.text === "env";
}

export function violacoes(fonte: string, arquivo = "x.ts"): Violacao[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true, arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Violacao[] = [];
  const linhaDe = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visitar = (node: ts.Node) => {
    const texto = textoDoNome(node);
    if (texto !== null) {
      if (CHAVES_DE_IA.test(texto)) {
        out.push({
          regra: lidoDoEnv(node) ? "leitura_de_chave_do_ambiente" : "nome_de_chave_de_ia",
          texto,
          linha: linhaDe(node),
        });
      } else if (IDENTIFICADORES_DO_FALLBACK.has(texto)) {
        out.push({ regra: "identificador_do_fallback", texto, linha: linhaDe(node) });
      } else if (
        texto === "padrao" &&
        ts.isStringLiteralLike(node) &&
        node.parent &&
        ts.isPropertyAssignment(node.parent) &&
        node.parent.initializer === node &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.name.text === "origem"
      ) {
        out.push({ regra: "origem_padrao", texto: 'origem: "padrao"', linha: linhaDe(node) });
      }
    }
    ts.forEachChild(node, visitar);
  };
  visitar(sf);
  return out;
}

function* arquivosDeProduto(dir: string): Generator<string> {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (FORA.has(entrada.name) || entrada.name.startsWith(".")) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      yield* arquivosDeProduto(caminho);
      continue;
    }
    if (!/\.tsx?$/.test(entrada.name)) continue;
    if (/\.test\.tsx?$/.test(entrada.name)) continue;
    if (!statSync(caminho).isFile()) continue;
    yield relative(RAIZ, caminho).replaceAll(sep, "/");
  }
}

describe("cerca: nenhum código de produto lê chave de IA do ambiente (ADR-0005)", () => {
  const arquivos = PASTAS.flatMap((p) => [...arquivosDeProduto(join(RAIZ, p))]);

  it("a varredura alcança o produto (guarda de vacuidade)", () => {
    expect(arquivos.length).toBeGreaterThan(500);
    expect(arquivos).toContain("lib/agent-engine/edge/llm/credentials.ts");
    expect(arquivos).toContain("lib/ai/gateway-binding.ts");
    expect(arquivos).toContain("workers/media-derive-worker.ts");
    expect(arquivos).toContain("workers/voice-agent/index.ts");
  });

  it("a allowlist só tem quem declara o schema — e os dois existem", () => {
    expect([...ALLOWLIST].sort()).toEqual(["lib/agent-engine/env.ts", "lib/env.ts"]);
    for (const a of ALLOWLIST) expect(statSync(join(RAIZ, a)).isFile()).toBe(true);
  });

  it("fora da allowlist, nenhum arquivo lê, nomeia ou cai na chave da instalação", () => {
    const acusados: string[] = [];
    for (const arquivo of arquivos) {
      if (ALLOWLIST.has(arquivo)) continue;
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      for (const v of violacoes(fonte, arquivo)) {
        acusados.push(`${arquivo}:${v.linha} [${v.regra}] ${v.texto}`);
      }
    }
    expect(
      acusados,
      "A plataforma não custeia IA (ADR-0005). A chave sai só de ai_provider_credentials da organização; " +
        "sem ela o recurso fica desligado com aviso. Se a leitura é de um script local, ele não mora em " +
        "app|lib|workers|hooks|components.",
    ).toEqual([]);
  });

  // ─── Controles: o detector enxerga a própria régua ───────────────────────
  it("controle positivo: cada forma de leitura e cada identificador do fallback são acusados", () => {
    const fixture = [
      `const a = process.env.OPENAI_API_KEY;`,
      `const b = env.ANTHROPIC_API_KEY;`,
      `const c = process.env["OPENROUTER_API_KEY"];`,
      `const d = env['AI_GATEWAY_API_KEY'];`,
      `const e = process.env.GOOGLE_GENERATIVE_AI_API_KEY;`,
      `const nomes = { anthropic: "ANTHROPIC_API_KEY" }; const f = process.env[nomes.anthropic];`,
      `const g = origem === 'chave_da_instalacao';`,
      `export function chaveDePlataforma(p: string) { return null; }`,
      `const h = await padraoDaInstalacao(() => null, "x");`,
      `export interface PlatformKeys { anthropic: boolean }`,
      `return { model, modelId, origem: "padrao" };`,
      "const sql = `select ${TRANSCRIPTION_API_KEY} from x`;",
    ].join("\n");
    const regras = violacoes(fixture).map((v) => v.regra);
    expect(regras.filter((r) => r === "leitura_de_chave_do_ambiente")).toHaveLength(5);
    expect(regras.filter((r) => r === "nome_de_chave_de_ia")).toHaveLength(2);
    expect(regras.filter((r) => r === "identificador_do_fallback")).toHaveLength(4);
    expect(regras.filter((r) => r === "origem_padrao")).toHaveLength(1);
  });

  it("controle positivo: a volta do ramo de env em credentials.ts é acusada", () => {
    // A sabotagem registrada no PR: reintroduzir UM ramo no resolvedor.
    const fonte = readFileSync(join(RAIZ, "lib/agent-engine/edge/llm/credentials.ts"), "utf8");
    const sabotado = fonte.replace(
      "throw new LlmNotConfiguredError();",
      "if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) { return { apiKey: process.env.ANTHROPIC_API_KEY, origemDaChave: 'chave_da_instalacao' } as never; }\n    throw new LlmNotConfiguredError();",
    );
    expect(sabotado).not.toBe(fonte);
    expect(violacoes(fonte, "credentials.ts")).toEqual([]);
    const regras = violacoes(sabotado, "credentials.ts").map((v) => v.regra);
    expect(regras).toContain("leitura_de_chave_do_ambiente");
    expect(regras).toContain("identificador_do_fallback");
  });

  it("controle negativo: comentário e nome parecido não acusam", () => {
    const fixture = [
      `// até 2026-10 lia process.env.OPENAI_API_KEY aqui`,
      `/* chave_da_instalacao era o rótulo; padraoDaInstalacao o degrau */`,
      `const transcricao = env.TRANSCRIPTION_MODEL;`,
      `const resend = env.RESEND_API_KEY;`,
      `const modo = modoDeCadastroDaInstalacao();`,
      `const origem = { origem: "binding" };`,
      "const msg = `sem chave: ${provider}`;",
    ].join("\n");
    expect(violacoes(fixture)).toEqual([]);
  });

  it("controle negativo: JSX também é varrido sem falso positivo", () => {
    expect(violacoes(`export function X() { return <p>{t("sem chave")}</p>; }`, "x.tsx")).toEqual([]);
    expect(violacoes(`export function X() { const k = process.env.OPENAI_API_KEY; return <p>{k}</p>; }`, "x.tsx")).toHaveLength(1);
  });
});
