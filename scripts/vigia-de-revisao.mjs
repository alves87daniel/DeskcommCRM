#!/usr/bin/env node
/**
 * Vigia de revisão (issue #47): o PR com apontamento P0 ou P1 ABERTO da revisão
 * automática não sai verde.
 *
 * Lê as conversas de revisão do PR (GraphQL `reviewThreads`), fica com as que
 * NÃO estão resolvidas e procura o selo de prioridade no começo do primeiro
 * comentário de cada uma. O selo é o que o Codex publica, medido nos PRs
 * #42, #43 e #44 deste repositório (P1, P2) e em PRs públicos (P0, P3):
 *
 *   **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Título
 *
 * A identidade do selo é o texto alternativo `P<n> Badge`, não a cor: P0 sai
 * `red`, P1 `orange`, P2 `yellow`, P3 `lightgrey`, e a cor é estética. Quem revisa
 * sem gerar esse selo (o Claude, um humano) marca a prioridade em texto puro no
 * começo do comentário: `**P1**`, `[P1]` ou `P1:`.
 *
 *   P0, P1 abertos → o check sai 1, cada um vira anotação no arquivo, e UM
 *                    comentário no PR menciona quem decide o merge.
 *   P2, P3 abertos → só informação: aparecem no log e no comentário, nunca reprovam.
 *
 * O comentário é um só por PR, achado pelo marcador `<!-- vigia-de-revisao ... -->`
 * e escrito pelo `github-actions[bot]`. Edição no GitHub não notifica menção; por
 * isso, quando surge um P0/P1 que o comentário ainda não listava, o comentário
 * antigo é apagado e um novo é criado no lugar — continua um só, e a menção chega.
 * Quando nada mudou, ele é só editado (ou deixado como está).
 *
 * Resolver uma conversa NÃO dispara workflow nenhum (o Actions não tem evento de
 * conversa resolvida). Rodar de novo: comentar `/vigia` no PR
 * (`.github/workflows/vigia-de-revisao-de-novo.yml`) ou "Re-run" no check.
 *
 * Sem dependência nenhuma, como `scripts/titulo-do-pr.mjs`: roda com o `node` do
 * runner e o `fetch` nativo. Os endereços da API vêm de `GITHUB_API_URL` e
 * `GITHUB_GRAPHQL_URL`, que o Actions preenche, e é por eles que o teste
 * (`tests/unit/vigia-de-revisao.test.ts`) aponta o script para um GitHub de mentira.
 */
import { appendFileSync, readFileSync } from "node:fs";

const MARCADOR = "<!-- vigia-de-revisao";
const AUTOR_DO_COMENTARIO = "github-actions[bot]";
const BLOQUEIAM = new Set([0, 1]);

/**
 * A prioridade declarada no começo do comentário, ou `null` sem selo.
 *
 * Só o COMEÇO conta: um selo citado no meio do texto ("o Codex marcou isto como
 * ![P1 Badge](...)") não é a prioridade deste comentário.
 *
 * @param {string | null | undefined} corpo
 * @returns {number | null}
 */
function prioridade(corpo) {
  const t = (corpo ?? "").replace(/^﻿/, "");
  // Selo do Codex: imagem com alt `P<n> Badge`, dentro de negrito e <sub>.
  const selo = t.match(/^(?:\s|\*\*|<sub>)*!\[P([0-3]) Badge\]\([^)\s]*\)/);
  if (selo) return Number(selo[1]);
  // Marca em texto puro, para quem revisa sem gerar o selo.
  const texto = t.match(/^\s*(?:\*\*P([0-3])\*\*|\[P([0-3])\]|P([0-3]):)/);
  if (texto) return Number(texto[1] ?? texto[2] ?? texto[3]);
  return null;
}

/**
 * A primeira linha legível do comentário, sem o selo e sem a marcação dele.
 *
 * @param {string | null | undefined} corpo
 * @returns {string}
 */
function primeiraLinha(corpo) {
  const linha =
    (corpo ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const limpa = linha
    .replace(/!\[P[0-3] Badge\]\([^)]*\)/g, "")
    .replace(/<\/?sub>/g, "")
    .replace(/^\s*(?:\*\*P[0-3]\*\*|\[P[0-3]\]|P[0-3]:)/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return limpa.length > 160 ? `${limpa.slice(0, 157)}...` : limpa;
}

/**
 * @param {string} url
 * @param {string} token
 * @param {RequestInit} [init]
 */
async function chamar(url, token, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "vigia-de-revisao",
    },
  });
  const texto = await r.text();
  if (!r.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} → HTTP ${r.status}: ${texto.slice(0, 300)}`);
  }
  return texto ? JSON.parse(texto) : null;
}

const CONSULTA = `query($dono: String!, $nome: String!, $pr: Int!, $cursor: String) {
  repository(owner: $dono, name: $nome) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 1) { nodes { url body author { login } } }
        }
      }
    }
  }
}`;

/** Todas as conversas de revisão do PR, página por página. */
async function conversas(graphql, token, dono, nome, pr) {
  const todas = [];
  let cursor = null;
  for (;;) {
    const r = await chamar(graphql, token, {
      method: "POST",
      body: JSON.stringify({ query: CONSULTA, variables: { dono, nome, pr, cursor } }),
    });
    if (r?.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(r.errors).slice(0, 300)}`);
    const pagina = r?.data?.repository?.pullRequest?.reviewThreads;
    if (!pagina) throw new Error(`GraphQL sem reviewThreads para o PR #${pr}.`);
    todas.push(...pagina.nodes);
    if (!pagina.pageInfo.hasNextPage) return todas;
    cursor = pagina.pageInfo.endCursor;
  }
}

/**
 * @param {any[]} lista
 * @returns {{ id: string, p: number, path: string, url: string, linha: string, autor: string, desatualizada: boolean }[]}
 */
function apontamentosAbertos(lista) {
  return lista
    .filter((c) => !c.isResolved)
    .map((c) => {
      const raiz = c.comments?.nodes?.[0];
      return {
        id: c.id,
        p: prioridade(raiz?.body),
        path: c.path ?? "(sem arquivo)",
        url: raiz?.url ?? "",
        linha: primeiraLinha(raiz?.body),
        autor: raiz?.author?.login ?? "?",
        desatualizada: Boolean(c.isOutdated),
      };
    })
    .filter((a) => a.p !== null)
    .sort((a, b) => a.p - b.p);
}

function item(a) {
  const velho = a.desatualizada ? " _(trecho já mudou; a conversa segue aberta)_" : "";
  return `- **P${a.p}** · [\`${a.path}\`](${a.url}) · ${a.linha}${velho}`;
}

function corpoDoComentario({ bloqueantes, informativos, mencionar, sha }) {
  const ids = bloqueantes.map((a) => a.id).join(",");
  const linhas = [`${MARCADOR} ids=${ids} -->`];
  if (bloqueantes.length > 0) {
    const n = bloqueantes.length;
    linhas.push(
      `${mencionar ? `@${mencionar}, ` : ""}este PR tem **${n} apontamento${n > 1 ? "s" : ""} P0/P1 aberto${n > 1 ? "s" : ""}** ` +
        "na revisão automática. O check `vigia-de-revisao` está vermelho: o merge espera.",
      "",
      ...bloqueantes.map(item),
    );
  } else {
    linhas.push(
      "Nenhum apontamento P0/P1 aberto na revisão automática. O check `vigia-de-revisao` está verde.",
    );
  }
  if (informativos.length > 0) {
    linhas.push(
      "",
      "Abertos que não reprovam (P2/P3, só informação):",
      "",
      ...informativos.map(item),
    );
  }
  linhas.push(
    "",
    `<sub>Conferido no commit \`${sha.slice(0, 7)}\`. Corrigiu? Resolva a conversa no GitHub e comente ` +
      "`/vigia` neste PR para conferir de novo: resolver uma conversa não dispara o check sozinho.</sub>",
  );
  return linhas.join("\n");
}

/** Os ids de P0/P1 que o comentário já listava. */
function idsListados(corpo) {
  const m = (corpo ?? "").match(/<!-- vigia-de-revisao ids=([^ ]*) -->/);
  return new Set(m && m[1] ? m[1].split(",") : []);
}

/**
 * Um comentário só por PR: cria, edita, ou troca (apaga e cria) quando surgiu
 * P0/P1 novo, para a menção notificar.
 */
async function publicar({ api, token, repo, pr, corpo, bloqueantes }) {
  const nossos = [];
  for (let pagina = 1; ; pagina++) {
    const lote = await chamar(
      `${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${pagina}`,
      token,
    );
    nossos.push(
      ...lote.filter((c) => c.user?.login === AUTOR_DO_COMENTARIO && c.body?.startsWith(MARCADOR)),
    );
    if (lote.length < 100) break;
  }
  const [atual, ...sobra] = nossos;
  for (const c of sobra) {
    await chamar(`${api}/repos/${repo}/issues/comments/${c.id}`, token, { method: "DELETE" });
  }

  if (!atual) {
    if (bloqueantes.length === 0) return "nenhum comentário (não há P0/P1 e nunca houve)";
    await chamar(`${api}/repos/${repo}/issues/${pr}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body: corpo }),
    });
    return "comentário criado";
  }

  const antes = idsListados(atual.body);
  const novo = bloqueantes.some((a) => !antes.has(a.id));
  if (novo) {
    await chamar(`${api}/repos/${repo}/issues/comments/${atual.id}`, token, { method: "DELETE" });
    await chamar(`${api}/repos/${repo}/issues/${pr}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body: corpo }),
    });
    return "comentário trocado (P0/P1 novo: a menção notifica)";
  }
  if (atual.body === corpo) return "comentário já estava em dia";
  await chamar(`${api}/repos/${repo}/issues/comments/${atual.id}`, token, {
    method: "PATCH",
    body: JSON.stringify({ body: corpo }),
  });
  return "comentário editado";
}

async function main() {
  const caminho = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!caminho || !token || !repo) {
    console.error("GITHUB_EVENT_PATH, GITHUB_TOKEN e GITHUB_REPOSITORY são obrigatórios.");
    process.exit(2);
  }
  const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const graphql = process.env.GITHUB_GRAPHQL_URL ?? `${api}/graphql`;
  const mencionar = (process.env.VIGIA_MENCIONAR ?? "").replace(/^@/, "").trim();

  const payload = JSON.parse(readFileSync(caminho, "utf8"));
  const pr = payload.pull_request?.number;
  const sha = payload.pull_request?.head?.sha ?? "";
  if (!pr) {
    console.error(`O evento "${process.env.GITHUB_EVENT_NAME}" não traz pull_request.`);
    process.exit(2);
  }
  const [dono, nome] = repo.split("/");

  // Falha ao LER fecha o check: sem a lista, verde seria palpite.
  let abertos;
  try {
    abertos = apontamentosAbertos(await conversas(graphql, token, dono, nome, pr));
  } catch (e) {
    console.log(`::error title=Vigia de revisão sem leitura::${e.message}`);
    process.exit(2);
  }
  const bloqueantes = abertos.filter((a) => BLOQUEIAM.has(a.p));
  const informativos = abertos.filter((a) => !BLOQUEIAM.has(a.p));

  for (const a of bloqueantes) {
    console.log(`::error file=${a.path},title=P${a.p} aberto na revisão::${a.linha} (${a.url})`);
  }
  console.log(
    [
      `PR #${pr}: ${bloqueantes.length} P0/P1 aberto(s), ${informativos.length} P2/P3 aberto(s).`,
      ...bloqueantes.map((a) => `  BLOQUEIA  P${a.p}  ${a.path}  ${a.url}\n            ${a.linha}`),
      ...informativos.map(
        (a) => `  info      P${a.p}  ${a.path}  ${a.url}\n            ${a.linha}`,
      ),
    ].join("\n"),
  );

  const corpo = corpoDoComentario({ bloqueantes, informativos, mencionar, sha });
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${corpo.split("\n").slice(1).join("\n")}\n`);
    } catch {
      // o resumo é cortesia; o log e o exit code são a autoridade
    }
  }

  // Falha ao ESCREVER o comentário não muda o veredito: o check já diz o que importa.
  // (PR de fork recebe token só de leitura e cai aqui.)
  try {
    console.log(await publicar({ api, token, repo, pr, corpo, bloqueantes }));
  } catch (e) {
    console.log(`::warning title=Vigia de revisão não comentou::${e.message}`);
  }

  if (bloqueantes.length > 0) {
    console.log(
      "\nCorrija, resolva a conversa no GitHub e comente /vigia no PR para conferir de novo.",
    );
    process.exit(1);
  }
}

await main();
