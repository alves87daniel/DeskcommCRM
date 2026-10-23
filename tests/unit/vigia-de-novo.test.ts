/**
 * O atalho `/vigia` (issue #55): `scripts/vigia-de-novo.mjs`, rodado pelo
 * `.github/workflows/vigia-de-revisao-de-novo.yml`.
 *
 * Como em `tests/unit/vigia-de-revisao.test.ts`, o script roda como o workflow o
 * roda — `node` com um evento em arquivo — contra um GitHub de mentira em
 * `127.0.0.1` (`GITHUB_API_URL`). Mede-se o que importa: se a nova execução foi
 * pedida, qual reação o comentário recebeu e o que o log diz.
 *
 * Os dois defeitos de 21/10 entram como casos reais:
 *   - PR #53: o corpo que o GitHub recebeu de uma sessão no Git Bash foi
 *     `C:/Program Files/Git/vigia` (o MSYS reescreveu `/vigia` como caminho).
 *   - PR #34: a branch era anterior ao vigia; não havia execução para o commit,
 *     e o aviso ficava só no log.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/vigia-de-novo.mjs");
const DIR = mkdtempSync(join(tmpdir(), "vigia-de-novo-"));
const REPO = "alves87daniel/DeskcommCRM";
const PR = 77;
const HEAD = "c5efeed0123456789abcdef0123456789abcdef0";
const COMENTARIO = 9001;
const WF = "vigia-de-revisao.yml";

const estado = {
  /** A última execução do vigia para o commit do PR, ou null. */
  execucao: null as null | { id: number; status: string },
  /** A branch do PR tem o arquivo do vigia? */
  temWorkflow: true,
  rerunFalha: false,
  log: [] as string[],
  reacoes: [] as string[],
};

function ler(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });
}

let servidor: Server;
let base = "";

beforeAll(async () => {
  servidor = createServer(async (req, res) => {
    const corpo = await ler(req);
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, dado: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(dado === undefined ? "" : JSON.stringify(dado));
    };
    estado.log.push(`${req.method} ${url.pathname}${url.search}`);

    if (req.method === "GET" && url.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json(200, { number: PR, head: { sha: HEAD, ref: "docs/x" } });
    }
    if (req.method === "GET" && url.pathname === `/repos/${REPO}/actions/workflows/${WF}/runs`) {
      const doHead = url.searchParams.get("head_sha") === HEAD;
      return json(200, {
        workflow_runs: doHead && estado.execucao ? [estado.execucao] : [],
      });
    }
    if (
      req.method === "GET" &&
      url.pathname === `/repos/${REPO}/contents/.github/workflows/${WF}`
    ) {
      return estado.temWorkflow ? json(200, { name: WF }) : json(404, { message: "Not Found" });
    }
    const rerun = url.pathname.match(new RegExp(`^/repos/${REPO}/actions/runs/(\\d+)/rerun$`));
    if (req.method === "POST" && rerun) {
      return estado.rerunFalha ? json(403, { message: "Forbidden" }) : json(201, {});
    }
    if (
      req.method === "POST" &&
      url.pathname === `/repos/${REPO}/issues/comments/${COMENTARIO}/reactions`
    ) {
      estado.reacoes.push(JSON.parse(corpo).content);
      return json(201, {});
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(() => servidor.close());

beforeEach(() => {
  estado.execucao = { id: 555, status: "completed" };
  estado.temWorkflow = true;
  estado.rerunFalha = false;
  estado.log = [];
  estado.reacoes = [];
});

let n = 0;
function rodar(
  body: string,
  emPr = true,
): Promise<{ status: number | null; saida: string; reruns: string[] }> {
  const evento = join(DIR, `evento-${n++}.json`);
  writeFileSync(
    evento,
    JSON.stringify({
      issue: { number: PR, ...(emPr ? { pull_request: { url: "x" } } : {}) },
      comment: { id: COMENTARIO, body, author_association: "OWNER" },
    }),
  );
  return new Promise((ok) => {
    const filho = spawn(process.execPath, [SCRIPT], {
      // No CI o processo já traz GITHUB_* de verdade: cada um que o script lê é
      // sobrescrito, e o resumo do passo é zerado.
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: evento,
        GITHUB_TOKEN: "token-de-teste",
        GITHUB_REPOSITORY: REPO,
        GITHUB_API_URL: base,
      },
    });
    let saida = "";
    filho.stdout.on("data", (c) => (saida += c));
    filho.stderr.on("data", (c) => (saida += c));
    filho.on("close", (status) =>
      ok({ status, saida, reruns: estado.log.filter((l) => l.endsWith("/rerun")) }),
    );
  });
}

const ACEITOS: [string, string][] = [
  ["digitado na tela do GitHub (corpo real do #34)", "/vigia\r\n"],
  ["deformado pelo Git Bash (corpo real do #53)", "C:/Program Files/Git/vigia"],
  ["outra instalação do Git", "D:/Tools/Git/vigia"],
  ["com espaço antes e texto depois", "  /vigia por favor"],
];

describe("/vigia — o filtro do workflow não barra o comando antes do script", () => {
  // O defeito de 21/10 estava no `if:` do job: `startsWith(body, '/vigia')`
  // pulava o corpo deformado sem que o script chegasse a rodar. O filtro de
  // texto do `if:` é lido do YAML, e todo corpo que o script aceita tem que
  // passar por ele.
  const yml = readFileSync(
    join(process.cwd(), ".github/workflows/vigia-de-revisao-de-novo.yml"),
    "utf8",
  );
  const condicao = yml.match(/^ {4}if: (.+)$/m)?.[1] ?? "";

  it("o instrumento está vivo: lê a condição do job e o filtro de texto dela", () => {
    expect(condicao).toContain("github.event.issue.pull_request");
    expect(condicao).not.toContain("startsWith(github.event.comment.body");
    expect(condicao).toMatch(/contains\(github\.event\.comment\.body, '[^']+'\)/);
  });

  it.each(ACEITOS)("%s passa pelo filtro do `if:`", (_nome, body) => {
    const termo = condicao.match(/contains\(github\.event\.comment\.body, '([^']+)'\)/)![1]!;
    // `contains` das expressões do Actions não diferencia maiúsculas.
    expect(body.toLowerCase()).toContain(termo.toLowerCase());
  });
});

describe("/vigia — o comando é reconhecido", () => {
  it.each(ACEITOS)("%s: pede nova execução e reage com 🚀", async (_nome, body) => {
    const r = await rodar(body);
    expect(r.status).toBe(0);
    expect(r.reruns).toEqual([`POST /repos/${REPO}/actions/runs/555/rerun`]);
    expect(estado.reacoes).toEqual(["rocket"]);
    expect(r.saida).toContain("rodando de novo para c5efeed (execução 555)");
  });

  it.each([
    ["no meio do texto", "Corrigi; agora comento /vigia"],
    ["palavra maior", "/vigiar"],
    ["na segunda linha", "obrigado\n/vigia"],
    ["citado entre crases", "`/vigia`"],
  ])("não é o comando (%s): nenhuma chamada à API", async (_nome, body) => {
    const r = await rodar(body);
    expect(r.status).toBe(0);
    expect(r.saida).toContain("não começa com /vigia");
    expect(estado.log).toEqual([]);
  });

  it("comentário em issue, não em PR: nada a fazer", async () => {
    const r = await rodar("/vigia", false);
    expect(r.saida).toContain("não em PR");
    expect(estado.log).toEqual([]);
  });
});

describe("/vigia — sempre responde no comentário", () => {
  it("execução em andamento: não pede outra, reage com 👀", async () => {
    estado.execucao = { id: 555, status: "in_progress" };
    const r = await rodar("/vigia");
    expect(r.status).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(estado.reacoes).toEqual(["eyes"]);
  });

  it("branch anterior ao vigia (o caso do #34): diz para trazer a main e reage com 😕", async () => {
    estado.execucao = null;
    estado.temWorkflow = false;
    const r = await rodar("/vigia\r\n");
    expect(r.status).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(estado.reacoes).toEqual(["confused"]);
    expect(r.saida).toContain("::warning title=/vigia sem efeito::");
    expect(r.saida).toContain("é anterior ao vigia");
    expect(r.saida).toContain("git merge origin/main");
    expect(estado.log).toContain(`GET /repos/${REPO}/contents/.github/workflows/${WF}?ref=${HEAD}`);
  });

  it("branch com o vigia mas sem execução ainda: pede um push e reage com 😕", async () => {
    estado.execucao = null;
    const r = await rodar("/vigia");
    expect(estado.reacoes).toEqual(["confused"]);
    expect(r.saida).toContain("Faça um push no PR para criar a primeira.");
    expect(r.saida).not.toContain("é anterior ao vigia");
  });

  it("a nova execução recusada pela API: job vermelho e reação 😕", async () => {
    estado.rerunFalha = true;
    const r = await rodar("/vigia");
    expect(r.status).toBe(1);
    expect(estado.reacoes).toEqual(["confused"]);
    expect(r.saida).toContain("::error title=/vigia não rodou de novo::HTTP 403");
  });

  it("procura a execução pelo commit ATUAL do PR", async () => {
    await rodar("/vigia");
    expect(estado.log).toContain(
      `GET /repos/${REPO}/actions/workflows/${WF}/runs?head_sha=${HEAD}&per_page=1`,
    );
  });
});
