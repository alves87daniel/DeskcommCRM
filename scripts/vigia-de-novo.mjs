#!/usr/bin/env node
/**
 * O atalho `/vigia` (issue #55): roda de novo o check `vigia-de-revisao` no
 * commit atual do PR e responde no próprio comentário.
 *
 * Rodado por `.github/workflows/vigia-de-revisao-de-novo.yml` no evento
 * `issue_comment`. Por que rodar de novo em vez de conferir aqui: um workflow de
 * `issue_comment` roda no commit da branch padrão, e o check que ele produzisse
 * ficaria pendurado na `main`, não no PR.
 *
 * Os dois defeitos medidos em 21/10, que este script fecha:
 *
 *   - O comando chegava deformado. Uma sessão no Git Bash do Windows que posta
 *     `/vigia` com o `gh` tem o argumento reescrito como caminho pelo MSYS, e o
 *     GitHub recebe `C:/Program Files/Git/vigia` (PR #53, duas vezes). As duas
 *     formas valem aqui.
 *   - Nada acontecia à vista. Sem execução do vigia para o commit do PR (branch
 *     anterior ao vigia, PR #34), o aviso ficava só no log do job. Agora toda
 *     tentativa reage no comentário: 🚀 rodou de novo, 👀 já estava rodando,
 *     😕 não havia o que rodar (o motivo vai no resumo do job e no log).
 *
 * Sem dependência nenhuma, como `scripts/vigia-de-revisao.mjs`. O endereço da API
 * vem de `GITHUB_API_URL`, e é por ele que `tests/unit/vigia-de-novo.test.ts`
 * aponta o script para um GitHub de mentira.
 */
import { appendFileSync, readFileSync } from "node:fs";

const WORKFLOW = "vigia-de-revisao.yml";

/**
 * O comentário é o comando `/vigia`?
 *
 * Só a primeira linha, e só no começo dela: "comente /vigia depois" não é o
 * comando. A forma `<unidade>:/…/vigia` é a que o MSYS produz a partir de `/vigia`.
 *
 * @param {string | null | undefined} corpo
 */
function ehComando(corpo) {
  const linha =
    (corpo ?? "")
      .replace(/^\uFEFF/, "")
      .trimStart()
      .split(/\r?\n/)[0] ?? "";
  return /^(?:[A-Za-z]:\/.*?)?\/vigia(?:\s|$)/.test(linha);
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
      "user-agent": "vigia-de-novo",
    },
  });
  const texto = await r.text();
  return { status: r.status, dado: texto ? JSON.parse(texto) : null };
}

function resumo(texto) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${texto}\n`);
  } catch {
    // o resumo é cortesia; o log é a autoridade
  }
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
  const payload = JSON.parse(readFileSync(caminho, "utf8"));
  const comentario = payload.comment;
  const pr = payload.issue?.number;

  if (!payload.issue?.pull_request) {
    console.log("Comentário em issue, não em PR: nada a fazer.");
    return;
  }
  if (!ehComando(comentario?.body)) {
    console.log("O comentário não começa com /vigia: nada a fazer.");
    return;
  }

  const reagir = async (content) => {
    const r = await chamar(
      `${api}/repos/${repo}/issues/comments/${comentario.id}/reactions`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
    if (r.status >= 300) {
      console.log(`::warning title=/vigia sem reação::HTTP ${r.status} ao reagir com ${content}.`);
    }
  };
  /** Não havia o que rodar: diz por quê e reage com 😕. */
  const semNada = async (motivo) => {
    console.log(`::warning title=/vigia sem efeito::${motivo}`);
    resumo(`**/vigia no PR #${pr}: nada rodou.** ${motivo}`);
    await reagir("confused");
  };

  const pull = await chamar(`${api}/repos/${repo}/pulls/${pr}`, token);
  if (pull.status !== 200) {
    console.log(`::error title=/vigia sem leitura::HTTP ${pull.status} ao ler o PR #${pr}.`);
    await reagir("confused");
    process.exit(1);
  }
  const head = pull.dado.head.sha;
  const curto = head.slice(0, 7);

  const runs = await chamar(
    `${api}/repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${head}&per_page=1`,
    token,
  );
  if (runs.status !== 200) {
    console.log(`::error title=/vigia sem leitura::HTTP ${runs.status} ao listar as execuções.`);
    await reagir("confused");
    process.exit(1);
  }
  const ultima = runs.dado.workflow_runs?.[0];

  if (!ultima) {
    // Um evento de PR usa os workflows da PRÓPRIA branch: sem o arquivo lá, o
    // vigia nunca rodou neste PR, e nenhum push vai mudar isso sem trazer a main.
    const arquivo = await chamar(
      `${api}/repos/${repo}/contents/.github/workflows/${WORKFLOW}?ref=${head}`,
      token,
    );
    if (arquivo.status === 404) {
      await semNada(
        `A branch do PR (commit ${curto}) é anterior ao vigia e não tem ` +
          `.github/workflows/${WORKFLOW}. Traga a main para a branch (git merge origin/main) ` +
          "e faça push: o push já roda o check.",
      );
    } else {
      await semNada(
        `Ainda não há execução do vigia para o commit ${curto}. Faça um push no PR para criar a primeira.`,
      );
    }
    return;
  }

  if (ultima.status !== "completed") {
    console.log(
      `A execução ${ultima.id} do vigia para ${curto} já está em andamento (${ultima.status}); ela lê as conversas de agora.`,
    );
    await reagir("eyes");
    return;
  }

  const rerun = await chamar(`${api}/repos/${repo}/actions/runs/${ultima.id}/rerun`, token, {
    method: "POST",
  });
  if (rerun.status >= 300) {
    console.log(
      `::error title=/vigia não rodou de novo::HTTP ${rerun.status} ao pedir nova execução de ${ultima.id}.`,
    );
    await reagir("confused");
    process.exit(1);
  }
  console.log(`Vigia de revisão rodando de novo para ${curto} (execução ${ultima.id}).`);
  resumo(`/vigia no PR #${pr}: execução ${ultima.id} rodando de novo para \`${curto}\`.`);
  await reagir("rocket");
}

await main();
