/**
 * O check de título (issue #25): `scripts/titulo-do-pr.mjs`, rodado pelo
 * `.github/workflows/titulo-do-pr.yml`.
 *
 * O script é exercitado como o workflow o roda — `node` com um evento do GitHub
 * Actions em arquivo —, e não por import: o que importa é o exit code e a
 * mensagem que o autor do PR vai ler.
 *
 * As listas de área e de tipo são conferidas contra as TABELAS do vocabulário
 * (seções 4.1 e 5), não contra uma cópia aqui. Área nova aprovada no documento
 * e esquecida no script reprova este teste, e vice-versa.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const SCRIPT = join(RAIZ, "scripts/titulo-do-pr.mjs");
const VOCABULARIO = readFileSync(
  join(RAIZ, "docs/green/governance/CONECTORGREEN-VOCABULARY-AND-NAMING.md"),
  "utf8",
);
const REPO = { full_name: "alves87daniel/DeskcommCRM" };
const DIR = mkdtempSync(join(tmpdir(), "titulo-do-pr-"));
let n = 0;

function rodar(evento: "pull_request" | "issues", payload: unknown) {
  const arquivo = join(DIR, `evento-${n++}.json`);
  writeFileSync(arquivo, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, GITHUB_EVENT_NAME: evento, GITHUB_EVENT_PATH: arquivo },
    encoding: "utf8",
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

function pr(
  title: string,
  body: string | null,
  extra: { login?: string; ref?: string; headRepo?: string } = {},
) {
  return rodar("pull_request", {
    repository: REPO,
    pull_request: {
      title,
      body,
      user: { login: extra.login ?? "alves87daniel" },
      head: { ref: extra.ref ?? "docs/x", repo: { full_name: extra.headRepo ?? REPO.full_name } },
    },
  });
}

function issue(title: string, login = "alves87daniel") {
  return rodar("issues", { repository: REPO, issue: { title, body: "", user: { login } } });
}

/** Primeira coluna de crase de uma tabela markdown, entre dois títulos de seção. */
function colunaDaTabela(inicio: string, fim: string, coluna: number): string[] {
  const trecho = VOCABULARIO.slice(VOCABULARIO.indexOf(inicio), VOCABULARIO.indexOf(fim));
  return trecho
    .split("\n")
    .filter((l) => /^\| `/.test(l))
    .map((l) => l.split("|")[coluna]!.trim().replace(/`/g, ""));
}

const AREAS = colunaDaTabela("### 4.1", "### 4.2", 2);
const TIPOS = colunaDaTabela("## 5. Tipos de trabalho", "## 6. Identificação", 1);

describe("check de título — o instrumento está vivo", () => {
  it("lê as 14 áreas e os 7 tipos do vocabulário", () => {
    // Controle positivo: um recorte que parou de casar devolveria listas vazias,
    // e os `it.each` abaixo passariam por vacuidade.
    expect(AREAS).toHaveLength(14);
    expect(AREAS).toContain("Fundação");
    expect(TIPOS).toEqual(["FEAT", "FIX", "SPIKE", "AUDIT", "DOC", "OPS", "MIG"]);
  });
});

describe("título de PR", () => {
  it("aceita o padrão com Closes #N", () => {
    const r = pr(
      "Fundação - Regras de revisão para o Codex no AGENTS.md - #23 - Tipo DOC",
      "Closes #23\n\ntexto",
    );
    expect(r.saida).toContain("no padrão");
    expect(r.status).toBe(0);
  });

  it.each(AREAS)("aceita a área aprovada %s", (area) => {
    expect(pr(`${area} - Algo - #1 - Tipo FIX`, "Closes #1").status).toBe(0);
  });

  it.each(TIPOS)("aceita o tipo aprovado %s", (tipo) => {
    expect(pr(`Fundação - Algo - #1 - Tipo ${tipo}`, "Closes #1").status).toBe(0);
  });

  it.each([
    ["área fora da lista", "Governança - Algo - #1 - Tipo DOC", "não é uma das 14 aprovadas"],
    [
      "nome do projeto no começo",
      "ConectorGreen - Algo - #1 - Tipo DOC",
      "começa pelo nome do projeto",
    ],
    ["sem #N", "Fundação - Algo - Tipo DOC", "o formato pede 4"],
    ["#N fora do lugar", "Fundação - Algo - 23 - Tipo DOC", "não é o número da issue"],
    ["tipo fora da lista", "Fundação - Algo - #1 - Tipo CHORE", "não é um dos 7 aprovados"],
    ["tipo sem a palavra Tipo", "Fundação - Algo - #1 - DOC", 'na forma "Tipo SIGLA"'],
    ["travessão", "Fundação — Algo — #1 — Tipo DOC", "travessão"],
    ["colchetes", "[Fundação] - Algo - #1 - Tipo DOC", "colchetes"],
    ["conventional commit", "docs(agents): regras de revisão", "o formato pede 4"],
  ])("reprova %s", (_caso, titulo, trecho) => {
    const r = pr(titulo, "Closes #1");
    expect(r.status).toBe(1);
    expect(r.saida).toContain(trecho);
    expect(r.saida).toContain("Formato esperado: Área - Ação ou objetivo - #N - Tipo SIGLA");
    expect(r.saida).toContain("::error title=Título do PR fora do padrão::");
  });

  it("reprova corpo sem Closes #N", () => {
    const r = pr("Fundação - Algo - #23 - Tipo DOC", "Refs #23");
    expect(r.status).toBe(1);
    expect(r.saida).toContain('não traz "Closes #23"');
  });

  it("reprova Closes de outro número, inclusive prefixo dele", () => {
    expect(pr("Fundação - Algo - #23 - Tipo DOC", "Closes #24").status).toBe(1);
    expect(pr("Fundação - Algo - #23 - Tipo DOC", "Closes #234").status).toBe(1);
  });

  it("reprova corpo vazio", () => {
    expect(pr("Fundação - Algo - #23 - Tipo DOC", null).status).toBe(1);
  });
});

describe("título de issue", () => {
  it("aceita Área - Ação - Tipo SIGLA", () => {
    const r = issue("Fundação - Check automático do título do PR - Tipo OPS");
    expect(r.saida).toContain("no padrão");
    expect(r.status).toBe(0);
  });

  it.each([
    ["sem Tipo", "Fundação - Check automático do título do PR", "o formato pede 3"],
    ["com #N", "Fundação - Algo - #25 - Tipo OPS", "traz #N"],
    ["área fora da lista", "Governança - Algo - Tipo OPS", "não é uma das 14 aprovadas"],
    ["tipo fora da lista", "Fundação - Algo - Tipo TEST", "não é um dos 7 aprovados"],
  ])("reprova %s", (_caso, titulo, trecho) => {
    const r = issue(titulo);
    expect(r.status).toBe(1);
    expect(r.saida).toContain(trecho);
    expect(r.saida).toContain("Formato esperado: Área - Ação ou objetivo - Tipo SIGLA");
  });
});

describe("isenções", () => {
  it.each(["dependabot[bot]", "claude[bot]"])("isenta o bot %s em PR e em issue", (login) => {
    const r = pr("Bump next from 16.0.0 to 16.0.1", null, { login });
    expect(r.status).toBe(0);
    expect(r.saida).toContain("Isento: autor é bot");
    expect(issue("qualquer coisa", login).status).toBe(0);
  });

  it("isenta o PR de release do release.yml", () => {
    const r = pr("Release 1.42.0", null, { ref: "release/1.42.0" });
    expect(r.status).toBe(0);
    expect(r.saida).toContain("PR de release");
  });

  it("não isenta 'Release X.Y.Z' vindo de fork, nem fora de release/*", () => {
    expect(
      pr("Release 1.42.0", null, { ref: "release/1.42.0", headRepo: "outro/fork" }).status,
    ).toBe(1);
    expect(pr("Release 1.42.0", null, { ref: "feat/x" }).status).toBe(1);
  });

  it("não isenta pessoa cujo login só parece bot", () => {
    expect(pr("Algo", null, { login: "dependabot" }).status).toBe(1);
  });
});

describe("o workflow", () => {
  const yml = readFileSync(join(RAIZ, ".github/workflows/titulo-do-pr.yml"), "utf8");

  it("roda este script, em PR e em issue, inclusive ao editar o título", () => {
    expect(yml).toMatch(/run: node scripts\/titulo-do-pr\.mjs\s*$/m);
    expect(yml).toMatch(/pull_request:\n\s+types: \[opened, edited, reopened, synchronize\]/);
    expect(yml).toMatch(/issues:\n\s+types: \[opened, edited, reopened\]/);
  });

  it("fixa toda action por SHA de 40 caracteres", () => {
    const usos = [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(usos.length).toBeGreaterThan(0);
    for (const u of usos) expect(u, `action não fixada por SHA: ${u}`).toMatch(/@[0-9a-f]{40}$/);
  });
});
