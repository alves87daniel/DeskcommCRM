import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * O ESCOPO DO TURNO NÃO TIRA A FERRAMENTA DO CONTEXTO GREEN (issue #46).
 *
 * O fork envolve a chamada do handler em `lib/ai/runtime/tools.ts` com
 * `withGreenMutationContext` (origem `agent_runtime`, ator do agente). O porte
 * do escopo do turno (#2158 e seguintes, no upstream) trocou exatamente essa
 * linha para passar `contatoDoTurno` no ctx do handler. Este teste prende as
 * duas coisas juntas, na mesma chamada:
 *
 *   - o handler recebe `ctx.contatoDoTurno` quando o turno tem contato, e não
 *     recebe quando não tem;
 *   - o handler roda DENTRO do contexto Green, com a origem, o request_id e o
 *     ator que o executor monta, nos dois casos, em leitura e em escrita.
 *
 * Se o porte voltar a chamar `def.handler(...)` fora do envelope, ou o envelope
 * voltar a receber o ctx sem o contato do turno, um dos casos fica vermelho.
 */

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { getToolByName } = await import("@/lib/mcp/tools");
const { currentGreenMutationContext } = await import("@/lib/green/mutation-context");
const { MODULOS_OPCIONAIS } = await import("@/lib/instalacao/modulos");
const { CAPACIDADES_DA_ORGANIZACAO } = await import("@/lib/organizacao/capacidades");

const ORG = "11111111-1111-4111-8111-111111111111";
const DO_TURNO = "22222222-2222-4222-8222-222222222222";
const FUNIL = "77777777-7777-4777-8777-777777777777";
const AGENTE = "88888888-8888-4888-8888-888888888888";
const TOKEN = "99999999-9999-4999-8999-999999999999";
const PEDIDO = "aaaaaaaa-0000-4000-8000-00000000000a";

type Linha = Record<string, unknown>;

/** Dublê mínimo: devolve o contato do turno como dono de tudo que for consultado. */
function bancoFalso() {
  const from = () => {
    const linha = { id: DO_TURNO, organization_id: ORG, contact_id: DO_TURNO };
    const alvo: Record<string, unknown> = {
      maybeSingle: () => Promise.resolve({ data: linha, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [linha], error: null }).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, { get: (t, p: string) => (p in t ? t[p] : () => cadeia) });
    return cadeia;
  };
  return { from };
}

async function executar(nome: string, args: Linha, contatoDoTurno?: string) {
  const def = getToolByName(nome)!;
  const visto: { ctx?: Linha; green?: Linha } = {};
  const handler = vi.spyOn(def, "handler").mockImplementation((async (_args: unknown, ctx: Linha) => {
    visto.ctx = ctx;
    visto.green = currentGreenMutationContext() as Linha | undefined;
    return { ok: true };
  }) as never);
  const supabase = bancoFalso();
  const ator = { type: "ai_agent", id: AGENTE, role: "ai_operator" };
  const ferramentas = pickToolsFromMcp({
    toolIds: [nome],
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: TOKEN },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: TOKEN, requestId: PEDIDO, supabase },
    supabase,
    pipelineIds: [FUNIL],
    modulosLigados: MODULOS_OPCIONAIS,
    capacidadesLigadas: CAPACIDADES_DA_ORGANIZACAO,
    handoffToolEnabled: true,
    proposalAiDraftEnabled: true,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
  await ferramentas[nome]!.execute!(args, { toolCallId: "c1", messages: [] } as never);
  const chamou = handler.mock.calls.length > 0;
  handler.mockRestore();
  return { chamou, ...visto };
}

function esperaContextoGreen(green: Linha | undefined) {
  expect(green, "o handler rodou fora do contexto Green").toBeDefined();
  expect(green).toMatchObject({
    source: "agent_runtime",
    request_id: PEDIDO,
    actor: { kind: "ai_agent", id: AGENTE, api_token_id: TOKEN },
  });
}

afterEach(() => vi.restoreAllMocks());

const CASOS = [
  { tipo: "leitura", nome: "crm_get_contact", args: { contact_id: DO_TURNO } },
  { tipo: "escrita", nome: "crm_schedule_followup", args: { contact_id: DO_TURNO } },
] as const;

describe("com contato do turno, o handler recebe o contato e roda no contexto Green", () => {
  it.each(CASOS)("$tipo ($nome)", async ({ nome, args }) => {
    const r = await executar(nome, { ...args }, DO_TURNO);

    expect(r.chamou, "a ponte recusou uma chamada sobre o próprio contato do turno").toBe(true);
    expect(r.ctx?.contatoDoTurno).toBe(DO_TURNO);
    esperaContextoGreen(r.green);
  });
});

describe("sem contato do turno, nada muda: ctx de antes e o mesmo contexto Green", () => {
  it.each(CASOS)("$tipo ($nome)", async ({ nome, args }) => {
    const r = await executar(nome, { ...args });

    expect(r.chamou).toBe(true);
    expect(r.ctx && "contatoDoTurno" in r.ctx).toBe(false);
    esperaContextoGreen(r.green);
  });
});
