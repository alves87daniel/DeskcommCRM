/**
 * SPIKE-GREEN-01.2 (descartável) — o `x-request-id` do cliente nunca é confiável.
 *
 * LIFE-ADV-02 (AUDIT-GREEN-01.1): o gate de sessão, o gate de token e a zona de
 * perigo copiavam o `x-request-id` que o CLIENTE mandou para `request_id` /
 * `correlation_id` do contexto Green. Num writer privilegiado o banco confia no
 * contexto do backend, então o valor do cliente virava `metadata.green.trusted`,
 * e `causadoPorRegra()` (anti-loop) lia `rule:forjado` como "causado por regra".
 *
 * A regra desta spike: a confiança vem da ORIGEM, não do formato. O
 * `request_id` confiável é gerado no servidor, dentro do gate; o que o cliente
 * mandou só pode existir como `client_request_id` (advisory). Nenhum teste
 * aqui depende de o valor "parecer UUID".
 *
 * Mesmo arquivo para a v1 (`3ac8fa7`) e para a v1.2: só muda o código sob teste.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentGreenMutationContext,
  runGreenRequestBoundary,
  serializeGreenMutationContext,
  type GreenMutationContextV1,
} from "@/lib/green/mutation-context";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => null),
  resolveActiveOrg: vi.fn(async () => null),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ session: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { validateBearerToken } from "@/lib/mcp/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG = "22222222-2222-4222-8222-222222222222";

/** O que um cliente HTTP pode pôr no header. */
const CABECALHOS: Array<[string, string | undefined]> = [
  ["sem header", undefined],
  ["UUID", randomUUID()],
  ["arbitrário", "abc-123"],
  ["rule:*", "rule:forjado-pelo-humano"],
  ["automation", "automation"],
  ["muito grande (5000 caracteres)", "x".repeat(5000)],
  ["fora do charset do contrato", "rule:a b<script>é"],
];

/** A única sanitização permitida ao valor do cliente (advisory). */
const sanear = (v: string) => v.slice(0, 128).replace(/[^A-Za-z0-9_.:-]/g, "_");

type Via = "sessão (requireRole)" | "token (resolveAuthDual)";

async function contextoDepoisDoGate(
  via: Via,
  requestId: string | undefined,
): Promise<GreenMutationContextV1 | undefined> {
  return runGreenRequestBoundary(async () => {
    if (via === "token (resolveAuthDual)") {
      vi.mocked(validateBearerToken).mockResolvedValue({
        organizationId: ORG,
        scopes: ["mcp:read", "mcp:write"],
        role: "agent",
        actor: { type: "api_token", id: "tok-1" },
        apiTokenId: "tok-1",
      } as never);
      await resolveAuthDual(
        new NextRequest("http://localhost/api/v1/leads", {
          method: "POST",
          headers: { authorization: "Bearer dsk_abc" },
        }),
        { requestId: requestId as string, resource: "leads", role: "agent", scope: "mcp:write" },
      );
    } else {
      await requireRole("viewer", { requestId });
    }
    return currentGreenMutationContext();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each<Via>(["sessão (requireRole)", "token (resolveAuthDual)"])(
  "LIFE-ADV-02 — gate de %s",
  (via) => {
    describe.each(CABECALHOS)("x-request-id: %s", (_nome, cliente) => {
      it("o contexto existe e o request_id confiável é gerado no servidor", async () => {
        const ctx = await contextoDepoisDoGate(via, cliente);
        // header gigante/estranho não pode DERRUBAR o contexto (fail-closed em Green)
        expect(ctx).toBeDefined();
        expect(ctx!.request_id).toMatch(UUID);
        if (cliente !== undefined) expect(ctx!.request_id).not.toBe(cliente);
        expect(ctx!.request_id!.startsWith("rule:")).toBe(false);
        expect(ctx!.correlation_id).toBe(ctx!.request_id);
      });

      it("o valor do cliente só sobrevive como advisory (`client_request_id`), saneado", async () => {
        const ctx = await contextoDepoisDoGate(via, cliente);
        expect(ctx).toBeDefined();
        const bruto = ctx as unknown as Record<string, unknown>;
        if (cliente === undefined) {
          expect(bruto.client_request_id).toBeUndefined();
        } else {
          expect(bruto.client_request_id).toBe(sanear(cliente));
        }
        // o contexto serializa (o banco o aceita): o header do cliente não vira DoS
        expect(() => serializeGreenMutationContext(ctx!)).not.toThrow();
      });
    });

    it("chamadas simultâneas: cada requisição vê só o próprio valor e o próprio id do servidor", async () => {
      const entradas = Array.from({ length: 24 }, (_, i) => `rule:cliente-${i}`);
      const ctxs = await Promise.all(entradas.map((h) => contextoDepoisDoGate(via, h)));
      const ids = new Set<string>();
      ctxs.forEach((ctx, i) => {
        const bruto = ctx as unknown as Record<string, unknown>;
        expect(bruto.client_request_id).toBe(entradas[i]);
        expect(ctx!.request_id).toMatch(UUID);
        ids.add(ctx!.request_id!);
      });
      expect(ids.size).toBe(entradas.length);
    });
  },
);

/**
 * Cerca estrutural: todo arquivo de produção que declara contexto Green só pode
 * pôr em `request_id`/`correlation_id` (a) o id de regra do motor de automação
 * ou (b) um id gerado no servidor. Um valor que veio de header/variável de
 * requisição é exatamente o defeito da auditoria. A prova de comportamento está
 * acima e no banco; isto impede o próximo seam de reabrir o buraco.
 */
describe("LIFE-ADV-02 — nenhum seam de produção põe valor do cliente em request_id confiável", () => {
  const RAIZ = join(__dirname, "..", "..");
  const PASTAS = ["app", "lib", "workers"];

  function arquivos(dir: string, out: string[] = []): string[] {
    for (const nome of readdirSync(dir)) {
      if (nome === "node_modules" || nome === ".next") continue;
      const p = join(dir, nome);
      const s = statSync(p);
      if (s.isDirectory()) arquivos(p, out);
      else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) out.push(p);
    }
    return out;
  }

  const ORIGEM_PERMITIDA = /^(`rule:\$\{[^}]+\}`|novoRequestIdDoServidor\(\)|requestIdDoServidor)$/;

  /**
   * Valores que a revisão desta spike confirmou como gerados no servidor (nunca
   * lidos de header). Chave: `arquivo|valor`. Entrada nova aqui é decisão de
   * revisão, não conveniência.
   */
  const REVISADOS: Record<string, string> = {
    "lib/ai/runtime/tools.ts|input.ctx.requestId": "id da run do agente (`run.id`)",
    "lib/ai/runtime/handoff.ts|input.runId": "id da run do agente",
    "lib/leads/nascimento-do-lead.ts|conversationId": "id da conversa, dado do banco",
    "lib/event-log/dispatcher.ts|correlacao ?? row.id": "correlação já confiável herdada do evento",
    "lib/prospecting/store.ts|`prospecting:${id}`": "id da campanha, dado do banco",
    "app/api/v1/webhooks/in/[token]/route.ts|requestId":
      "`randomUUID()` na primeira linha do handler",
    "lib/mcp/server.ts|requestId": "`randomUUID()` em app/api/mcp/route.ts; único chamador",
  };

  /** Texto do argumento do primeiro nível de cada chamada `nome(...)`. */
  function argumentosDe(src: string, nomes: string[]): string[] {
    const out: string[] = [];
    for (const nome of nomes) {
      const re = new RegExp(`\\b${nome}\\s*\\(`, "g");
      for (const m of src.matchAll(re)) {
        let i = m.index! + m[0].length;
        let nivel = 1;
        const ini = i;
        while (i < src.length && nivel > 0) {
          const c = src[i++];
          if (c === "(") nivel++;
          else if (c === ")") nivel--;
        }
        out.push(src.slice(ini, i - 1));
      }
    }
    return out;
  }

  it("só `rule:<id>` do motor, id do servidor ou valor revisado", () => {
    const violacoes: string[] = [];
    for (const pasta of PASTAS) {
      for (const arq of arquivos(join(RAIZ, pasta))) {
        const src = readFileSync(arq, "utf8");
        if (!/from\s+["']@\/lib\/green\/mutation-context["']/.test(src)) continue;
        const rel = relative(RAIZ, arq).replaceAll("\\", "/");
        if (rel === "lib/green/mutation-context.ts") continue;
        const args = argumentosDe(src, [
          "withGreenMutationContext",
          "withGreenSystemRoot",
          "abrirContextoGreenDaRequisicao",
          "vincular",
        ]);
        for (const arg of args) {
          for (const m of arg.matchAll(/\b(request_id|correlation_id)\s*:\s*(`[^`]*`|[^,}\n]+)/g)) {
            const valor = m[2]!.trim();
            if (ORIGEM_PERMITIDA.test(valor)) continue;
            if (REVISADOS[`${rel}|${valor}`]) continue;
            violacoes.push(`${rel}: ${m[1]}: ${valor}`);
          }
        }
      }
    }
    expect(violacoes).toEqual([]);
  });
});
