/**
 * O vigia de revisão (issue #47): `scripts/vigia-de-revisao.mjs`, rodado pelo
 * `.github/workflows/vigia-de-revisao.yml`.
 *
 * Como em `tests/unit/titulo-do-pr.test.ts`, o script é exercitado como o
 * workflow o roda — `node` com um evento do GitHub Actions em arquivo —, e não
 * por import. A diferença é que este script fala com a API: o teste sobe um
 * GitHub de mentira em `127.0.0.1` e aponta `GITHUB_API_URL` e
 * `GITHUB_GRAPHQL_URL` para ele. Assim se mede o que importa — o exit code, o
 * log que o autor do PR lê e o que de fato foi escrito no PR (quantos
 * comentários, criados, editados ou trocados).
 *
 * As amostras de selo são primeiras linhas REAIS de comentários do Codex:
 * P1 e P2 dos PRs #42, #43 e #44 deste repositório; P0 e P3, que este
 * repositório ainda não recebeu, de PRs públicos (chatwoot/chatwoot#14196 e
 * yoda-digital/mcp-gitlab-server#103). As cores (red, orange, yellow,
 * lightgrey) vêm de lá, e o detector não depende delas.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/vigia-de-revisao.mjs");
const DIR = mkdtempSync(join(tmpdir(), "vigia-de-revisao-"));
const REPO = "alves87daniel/DeskcommCRM";
const PR = 99;

const AMOSTRA = {
  P0: "**<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)</sub></sub>  Restore ContactInbox params handling in create flow**\n\nWhen the create flow runs...",
  P1: "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Classify the forced secret reset as requiring action**\n\nOn an existing VPS whose saved webhook secret...",
  P2: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Include rate-limit metadata in the new 429 responses**\n\nWhen a token or organization exhausts its quota...",
  P3: "**<sub><sub>![P3 Badge](https://img.shields.io/badge/P3-lightgrey?style=flat)</sub></sub>  Don't promise structuredContent on text-only tools**\n\nThe tool descriptions...",
  semSelo: "## Unused variable, import, function or class\nUnused variable `x`.",
  outroRobo:
    "![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)\n\nConsider extracting this.",
  seloNoMeio:
    "Concordo com o Codex, que marcou isto como ![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat) no outro PR.",
};

// ---- o GitHub de mentira ----------------------------------------------------

interface Conversa {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  path: string;
  body: string;
}
interface Comentario {
  id: number;
  body: string;
  user: { login: string };
}

const estado = {
  conversas: [] as Conversa[],
  comentarios: [] as Comentario[],
  proximoId: 1,
  log: [] as string[],
  graphqlQuebrado: false,
  escritaProibida: false,
};

function novaConversa(id: string, body: string, extra: Partial<Conversa> = {}): Conversa {
  return { id, body, isResolved: false, path: `lib/${id}.ts`, ...extra };
}

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
    estado.log.push(`${req.method} ${url.pathname}`);

    if (req.method === "POST" && url.pathname === "/graphql") {
      if (estado.graphqlQuebrado) return json(502, { message: "Bad Gateway" });
      const { variables } = JSON.parse(corpo);
      const inicio = variables.cursor ? Number(variables.cursor) : 0;
      const pagina = estado.conversas.slice(inicio, inicio + 100);
      const fim = inicio + pagina.length;
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: fim < estado.conversas.length, endCursor: String(fim) },
                nodes: pagina.map((c) => ({
                  id: c.id,
                  isResolved: c.isResolved,
                  isOutdated: c.isOutdated ?? false,
                  path: c.path,
                  comments: {
                    nodes: [
                      {
                        url: `https://github.com/${REPO}/pull/${PR}#discussion_${c.id}`,
                        body: c.body,
                        author: { login: "chatgpt-codex-connector" },
                      },
                    ],
                  },
                })),
              },
            },
          },
        },
      });
    }

    const lista = url.pathname === `/repos/${REPO}/issues/${PR}/comments`;
    const um = url.pathname.match(new RegExp(`^/repos/${REPO}/issues/comments/(\\d+)$`));
    if (req.method !== "GET" && estado.escritaProibida && (lista || um)) {
      return json(403, { message: "Resource not accessible by integration" });
    }
    if (lista && req.method === "GET") {
      const pagina = Number(url.searchParams.get("page") ?? "1");
      return json(200, estado.comentarios.slice((pagina - 1) * 100, pagina * 100));
    }
    if (lista && req.method === "POST") {
      const c = {
        id: estado.proximoId++,
        body: JSON.parse(corpo).body,
        user: { login: "github-actions[bot]" },
      };
      estado.comentarios.push(c);
      return json(201, c);
    }
    if (um && req.method === "PATCH") {
      const c = estado.comentarios.find((x) => x.id === Number(um[1]))!;
      c.body = JSON.parse(corpo).body;
      return json(200, c);
    }
    if (um && req.method === "DELETE") {
      estado.comentarios = estado.comentarios.filter((x) => x.id !== Number(um[1]));
      return json(204, undefined);
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(() => servidor.close());

beforeEach(() => {
  estado.conversas = [];
  estado.comentarios = [];
  estado.proximoId = 1;
  estado.log = [];
  estado.graphqlQuebrado = false;
  estado.escritaProibida = false;
});

let n = 0;
function rodar(): Promise<{ status: number | null; saida: string }> {
  const evento = join(DIR, `evento-${n++}.json`);
  writeFileSync(
    evento,
    JSON.stringify({ pull_request: { number: PR, head: { sha: "abcdef1234567890" } } }),
  );
  return new Promise((ok) => {
    const filho = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: evento,
        GITHUB_TOKEN: "token-de-teste",
        GITHUB_REPOSITORY: REPO,
        GITHUB_API_URL: base,
        GITHUB_GRAPHQL_URL: `${base}/graphql`,
        VIGIA_MENCIONAR: "alves87daniel",
      },
    });
    let saida = "";
    filho.stdout.on("data", (c) => (saida += c));
    filho.stderr.on("data", (c) => (saida += c));
    filho.on("close", (status) => ok({ status, saida }));
  });
}

const escritas = () => estado.log.filter((l) => !l.startsWith("GET") && !l.includes("graphql"));

// ---- o detector -------------------------------------------------------------

describe("vigia de revisão — o detector lê o selo real", () => {
  it("o instrumento está vivo: cada amostra real é lida na prioridade dela", async () => {
    // Controle positivo: se o detector ficar cego, nenhuma amostra aparece no log
    // e os casos "passa" abaixo passariam por vacuidade.
    estado.conversas = (["P0", "P1", "P2", "P3"] as const).map((p) => novaConversa(p, AMOSTRA[p]));
    const r = await rodar();
    expect(r.saida).toContain("2 P0/P1 aberto(s), 2 P2/P3 aberto(s).");
    expect(r.saida).toMatch(/BLOQUEIA {2}P0 {2}lib\/P0\.ts/);
    expect(r.saida).toMatch(/BLOQUEIA {2}P1 {2}lib\/P1\.ts/);
    expect(r.saida).toMatch(/info {6}P2 {2}lib\/P2\.ts/);
    expect(r.saida).toMatch(/info {6}P3 {2}lib\/P3\.ts/);
  });

  it.each(["P0", "P1"] as const)("%s aberto reprova e vira anotação no arquivo", async (p) => {
    estado.conversas = [novaConversa(p, AMOSTRA[p])];
    const r = await rodar();
    expect(r.status).toBe(1);
    expect(r.saida).toContain(`::error file=lib/${p}.ts,title=${p} aberto na revisão::`);
    expect(r.saida).toContain(`#discussion_${p}`);
  });

  it("a primeira linha listada é o título do apontamento, sem o selo nem a marcação", async () => {
    estado.conversas = [novaConversa("P1", AMOSTRA.P1)];
    const r = await rodar();
    expect(r.saida).toContain("            Classify the forced secret reset as requiring action\n");
    expect(r.saida).not.toMatch(/BLOQUEIA.*\n.*(<sub>|\*\*|Badge)/);
  });

  it.each(["P2", "P3"] as const)(
    "%s aberto nunca reprova: aparece só como informação",
    async (p) => {
      estado.conversas = [novaConversa(p, AMOSTRA[p])];
      const r = await rodar();
      expect(r.status).toBe(0);
      expect(r.saida).toContain(`info      ${p}`);
      expect(r.saida).not.toContain("::error");
    },
  );

  it.each(["semSelo", "outroRobo", "seloNoMeio"] as const)(
    "comentário sem selo no começo (%s) não conta",
    async (k) => {
      estado.conversas = [novaConversa("x", AMOSTRA[k])];
      const r = await rodar();
      expect(r.status).toBe(0);
      expect(r.saida).toContain("0 P0/P1 aberto(s), 0 P2/P3 aberto(s).");
    },
  );

  it.each([
    ["**P1** Falta o filtro de organização", 1],
    ["[P0] Bearer gravado em texto claro", 1],
    ["P1: getSession() no handler", 1],
    ["**P2** Nome confuso", 0],
    ["P1 is the label I would give this, but it is fine", 0],
  ])("marca em texto puro para quem revisa sem o selo: %j → exit %i", async (corpo, exit) => {
    estado.conversas = [novaConversa("t", corpo)];
    expect((await rodar()).status).toBe(exit);
  });

  it("conversa resolvida não conta, mesmo P0", async () => {
    estado.conversas = [
      novaConversa("P0", AMOSTRA.P0, { isResolved: true }),
      novaConversa("P1", AMOSTRA.P1, { isResolved: true }),
    ];
    const r = await rodar();
    expect(r.status).toBe(0);
    expect(r.saida).toContain("0 P0/P1 aberto(s)");
  });

  it("conversa desatualizada mas aberta continua reprovando — só resolver libera", async () => {
    estado.conversas = [novaConversa("P1", AMOSTRA.P1, { isOutdated: true })];
    expect((await rodar()).status).toBe(1);
  });

  it("lê todas as páginas: um P1 na conversa 101 reprova", async () => {
    estado.conversas = [
      ...Array.from({ length: 100 }, (_, i) => novaConversa(`c${i}`, AMOSTRA.P2)),
      novaConversa("P1", AMOSTRA.P1),
    ];
    const r = await rodar();
    expect(r.status).toBe(1);
    expect(r.saida).toContain("1 P0/P1 aberto(s), 100 P2/P3 aberto(s).");
  });

  it("sem conseguir ler as conversas, o check fecha (exit 2), nunca passa verde", async () => {
    estado.graphqlQuebrado = true;
    const r = await rodar();
    expect(r.status).toBe(2);
    expect(r.saida).toContain("::error title=Vigia de revisão sem leitura::");
  });
});

// ---- o comentário único -------------------------------------------------------

describe("vigia de revisão — um comentário só, que avisa", () => {
  it("sem P0/P1 e sem histórico, não comenta nada", async () => {
    estado.conversas = [novaConversa("P2", AMOSTRA.P2)];
    expect((await rodar()).status).toBe(0);
    expect(estado.comentarios).toEqual([]);
    expect(escritas()).toEqual([]);
  });

  it("com P1, cria um comentário que menciona quem decide o merge e lista o apontamento", async () => {
    estado.conversas = [novaConversa("P1", AMOSTRA.P1), novaConversa("P3", AMOSTRA.P3)];
    await rodar();
    expect(estado.comentarios).toHaveLength(1);
    const corpo = estado.comentarios[0]!.body;
    expect(corpo.startsWith("<!-- vigia-de-revisao ids=P1 -->")).toBe(true);
    expect(corpo).toContain("@alves87daniel");
    expect(corpo).toContain(
      "- **P1** · [`lib/P1.ts`](https://github.com/alves87daniel/DeskcommCRM/pull/99#discussion_P1) · Classify the forced secret reset as requiring action",
    );
    expect(corpo).toContain("- **P3** · [`lib/P3.ts`]");
    expect(corpo).toContain("`/vigia`");
  });

  it("rodadas seguintes não empilham: mesmo estado não escreve, P0 novo troca, tudo resolvido edita", async () => {
    estado.conversas = [novaConversa("P1", AMOSTRA.P1)];
    await rodar();
    expect(estado.comentarios).toHaveLength(1);

    // Mesma rodada de novo (outro evento, nada mudou): nenhuma escrita.
    estado.log = [];
    expect((await rodar()).saida).toContain("comentário já estava em dia");
    expect(escritas()).toEqual([]);

    // P1 que já estava listado ficou desatualizado: edita, sem trocar.
    estado.conversas[0]!.isOutdated = true;
    estado.log = [];
    expect((await rodar()).saida).toContain("comentário editado");
    expect(escritas()).toEqual([`PATCH /repos/${REPO}/issues/comments/1`]);

    // P0 novo: apaga e cria (a edição não notificaria a menção). Continua um só.
    estado.conversas.push(novaConversa("P0", AMOSTRA.P0));
    estado.log = [];
    expect((await rodar()).saida).toContain("comentário trocado");
    expect(escritas()).toEqual([
      `DELETE /repos/${REPO}/issues/comments/1`,
      `POST /repos/${REPO}/issues/${PR}/comments`,
    ]);
    expect(estado.comentarios).toHaveLength(1);
    expect(estado.comentarios[0]!.body.startsWith("<!-- vigia-de-revisao ids=P0,P1 -->")).toBe(
      true,
    );

    // Tudo resolvido: o mesmo comentário passa a dizer verde, sem mencionar ninguém.
    for (const c of estado.conversas) c.isResolved = true;
    const r = await rodar();
    expect(r.status).toBe(0);
    expect(estado.comentarios).toHaveLength(1);
    expect(estado.comentarios[0]!.body).toContain("Nenhum apontamento P0/P1 aberto");
    expect(estado.comentarios[0]!.body).not.toContain("@alves87daniel");
  });

  it("não edita comentário de outra pessoa que copiou o marcador", async () => {
    estado.comentarios = [
      { id: 50, body: "<!-- vigia-de-revisao ids=P1 --> cópia", user: { login: "alguem" } },
    ];
    estado.proximoId = 51;
    estado.conversas = [novaConversa("P1", AMOSTRA.P1)];
    await rodar();
    expect(estado.comentarios.map((c) => c.id)).toEqual([50, 51]);
    expect(estado.comentarios[0]!.body).toBe("<!-- vigia-de-revisao ids=P1 --> cópia");
  });

  it("sem permissão de escrita (PR de fork), avisa e mantém o veredito", async () => {
    estado.escritaProibida = true;
    estado.conversas = [novaConversa("P1", AMOSTRA.P1)];
    const r = await rodar();
    expect(r.status).toBe(1);
    expect(r.saida).toContain("::warning title=Vigia de revisão não comentou::");
  });
});
