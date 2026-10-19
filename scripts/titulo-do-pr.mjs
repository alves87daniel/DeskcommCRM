#!/usr/bin/env node
/**
 * Confere o título de PR e de issue contra a Emenda de 18/10/2026 de
 * `docs/green/governance/CONECTORGREEN-VOCABULARY-AND-NAMING.md` (issue #25).
 *
 *   PR:    Área - Ação ou objetivo - #N - Tipo SIGLA   e o corpo traz `Closes #N`
 *   Issue: Área - Ação ou objetivo - Tipo SIGLA        (sem #N: a issue É o N)
 *
 * Lê o evento que o GitHub Actions entrega (`GITHUB_EVENT_NAME` e
 * `GITHUB_EVENT_PATH`) e sai 1 com a explicação em português quando o título
 * foge do padrão. Sem dependência nenhuma, de propósito: o workflow roda com o
 * `node` do runner, sem `pnpm install`, e um check de título não pode custar
 * mais fila que a suíte.
 *
 * Isentos: PR e issue de bot (Dependabot, app Claude) e o PR de release, que o
 * `release.yml` abre com o título `Release X.Y.Z` a partir de `release/*` do
 * próprio repositório.
 */
import { readFileSync } from "node:fs";

/** Seção 4.1 do vocabulário: as 14 áreas ratificadas, pelo nome humano. */
const AREAS = [
  "Fundação",
  "Comercial",
  "Produtos",
  "Expansão",
  "Ingestão",
  "Aquisição",
  "Automações",
  "WhatsApp",
  "Dados",
  "Métricas",
  "Integrações",
  "Acesso",
  "Infraestrutura",
  "Segurança",
];

/** Seção 5 do vocabulário: os 7 tipos de trabalho. */
const TIPOS = ["FEAT", "FIX", "SPIKE", "AUDIT", "DOC", "OPS", "MIG"];

/** Regra 3 da Emenda: o título nunca começa pelo nome do projeto. */
const PROJETOS = ["ConectorGreen", "DeskcommCRM", "Deskcomm"];

const BOTS = ["dependabot[bot]", "claude[bot]"];

const FORMATO_PR = "Área - Ação ou objetivo - #N - Tipo SIGLA";
const FORMATO_ISSUE = "Área - Ação ou objetivo - Tipo SIGLA";
const EXEMPLO_PR = "Fundação - Regras de revisão para o Codex no AGENTS.md - #23 - Tipo DOC";
const EXEMPLO_ISSUE = "Fundação - Check automático do título do PR - Tipo OPS";

/**
 * Os problemas do título, um por frase. Lista vazia é título válido.
 *
 * @param {string} titulo
 * @param {"pr" | "issue"} alvo
 * @returns {string[]}
 */
function problemasDoTitulo(titulo, alvo) {
  const t = titulo.trim();
  const problemas = [];

  if (/[—–]/.test(t))
    problemas.push(
      "usa travessão (—) ou meia-risca (–); o separador é hífen simples com espaços ( - ).",
    );
  if (/[[\]]/.test(t)) problemas.push("usa colchetes; o título não leva colchetes.");
  const projeto = PROJETOS.find((p) => t.toLowerCase().startsWith(p.toLowerCase()));
  if (projeto)
    problemas.push(`começa pelo nome do projeto (${projeto}); o primeiro bloco é a área.`);

  const blocos = t.split(" - ").map((b) => b.trim());
  const minimo = alvo === "pr" ? 4 : 3;
  if (blocos.length < minimo) {
    problemas.push(`tem ${blocos.length} bloco(s) separados por " - "; o formato pede ${minimo}.`);
    return problemas;
  }

  const area = blocos[0];
  if (!AREAS.includes(area)) {
    problemas.push(`a área "${area}" não é uma das 14 aprovadas: ${AREAS.join(", ")}.`);
  }

  const tipo = blocos[blocos.length - 1];
  const m = tipo.match(/^Tipo ([A-Z]+)$/);
  if (!m) {
    problemas.push(`o último bloco "${tipo}" não está na forma "Tipo SIGLA".`);
  } else if (!TIPOS.includes(m[1])) {
    problemas.push(`o tipo "${m[1]}" não é um dos 7 aprovados: ${TIPOS.join(", ")}.`);
  }

  const meio = alvo === "pr" ? blocos.slice(1, -2) : blocos.slice(1, -1);
  if (meio.join(" - ").trim() === "") problemas.push("falta a ação ou objetivo no segundo bloco.");

  if (alvo === "pr") {
    const id = blocos[blocos.length - 2];
    if (!/^#\d+$/.test(id))
      problemas.push(`o penúltimo bloco "${id}" não é o número da issue (#N).`);
  } else if (meio.some((b) => /^#\d+$/.test(b))) {
    problemas.push("traz #N; o número só vai no título do PR, porque a issue já é o N.");
  }

  return problemas;
}

/**
 * O corpo do PR fecha a issue do título?
 *
 * @param {string} titulo
 * @param {string | null | undefined} corpo
 * @returns {string[]}
 */
function problemasDoCorpo(titulo, corpo) {
  const id = titulo
    .trim()
    .split(" - ")
    .map((b) => b.trim())
    .at(-2);
  if (!id || !/^#\d+$/.test(id)) return []; // o título já reprovou por isso
  const fecha = new RegExp(`(^|\\s)closes ${id}(?!\\d)`, "i");
  return fecha.test(corpo ?? "")
    ? []
    : [`o corpo não traz "Closes ${id}", com o mesmo número do título.`];
}

/**
 * Por que este evento não é conferido, ou `null` se é.
 *
 * @param {string} evento
 * @param {any} payload
 * @returns {string | null}
 */
function isencao(evento, payload) {
  const item = evento === "issues" ? payload.issue : payload.pull_request;
  const autor = item?.user?.login;
  if (BOTS.includes(autor)) return `autor é bot (${autor})`;
  if (evento !== "issues") {
    const head = payload.pull_request?.head;
    const daqui = head?.repo?.full_name === payload.repository?.full_name;
    if (
      daqui &&
      head?.ref?.startsWith("release/") &&
      /^Release \d+\.\d+\.\d+$/.test(item.title.trim())
    ) {
      return "PR de release aberto pelo release.yml";
    }
  }
  return null;
}

function main() {
  const evento = process.env.GITHUB_EVENT_NAME ?? "";
  const caminho = process.env.GITHUB_EVENT_PATH;
  if (!caminho) {
    console.error("GITHUB_EVENT_PATH ausente: este script lê o evento do GitHub Actions.");
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(caminho, "utf8"));
  const alvo = evento === "issues" ? "issue" : "pr";
  const item = alvo === "issue" ? payload.issue : payload.pull_request;
  if (!item) {
    console.error(`O evento "${evento}" não traz ${alvo === "issue" ? "issue" : "pull_request"}.`);
    process.exit(2);
  }

  const motivo = isencao(evento, payload);
  if (motivo) {
    console.log(`Isento: ${motivo}. Título não conferido: "${item.title}".`);
    return;
  }

  const problemas = problemasDoTitulo(item.title, alvo);
  if (alvo === "pr") problemas.push(...problemasDoCorpo(item.title, item.body));

  const nome = alvo === "pr" ? "do PR" : "da issue";
  if (problemas.length === 0) {
    console.log(`Título ${nome} no padrão: "${item.title}".`);
    return;
  }

  const formato = alvo === "pr" ? FORMATO_PR : FORMATO_ISSUE;
  const exemplo = alvo === "pr" ? EXEMPLO_PR : EXEMPLO_ISSUE;
  console.log(`::error title=Título ${nome} fora do padrão::${problemas.join(" ")}`);
  console.log(
    [
      `Título ${nome} fora do padrão: "${item.title}"`,
      "",
      ...problemas.map((p) => `  - ${p}`),
      "",
      `Formato esperado: ${formato}`,
      `Exemplo:          ${exemplo}`,
      ...(alvo === "pr" ? ["E o corpo do PR traz: Closes #N"] : []),
      "",
      "Régua: docs/green/governance/CONECTORGREEN-VOCABULARY-AND-NAMING.md (Emenda de 18/10/2026).",
      `Corrija o título ${nome}; o check roda de novo ao editar.`,
    ].join("\n"),
  );
  process.exit(1);
}

main();
