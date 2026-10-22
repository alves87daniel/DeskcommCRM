/**
 * O PAINEL ALCANÇA A PILHA ANTIGA — o furo do "botão que não controla nada".
 *
 * Três pontos do registro (`sentiment_classify`, `bot_respond` e o ensaio de
 * agente) resolviam modelo pela pilha antiga, que não conhecia
 * `ai_purpose_bindings`. A tela os OFERECIA, aceitava a escolha e dizia
 * "salvo" — e nenhuma chamada a respeitava.
 *
 * ═══ A ESCADA TEM DOIS DEGRAUS, E NENHUM É O `.env` (ADR-0005) ═══
 *
 * Até 2026-10 este arquivo provava um terceiro degrau: "sem binding e sem
 * credencial da organização, vale a chave da instalação" (`origem: "padrao"`,
 * via `resolveLanguageModel`). Era a conta de UMA pessoa pagando o clima, a
 * resposta automática e o cartão do Jev de TODAS as organizações do servidor.
 * A decisão do dono do produto apagou o degrau; os casos abaixo provam que,
 * sem credencial da organização, a resposta é `null` — o ponto fica sem IA, com
 * aviso — e nunca outra chave.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
const credenciais = vi.hoisted(() => ({ linha: null as Record<string, unknown> | null }));
const organizacao = vi.hoisted(() => ({ settings: { llm: { provider: "openai" } } as unknown }));

/**
 * Dublê do PostgREST com as DUAS terminações que o resolvedor usa: `maybeSingle`
 * (binding, organização, credencial escolhida) e o `await` direto da cadeia
 * (`credencialMaisRecente`, que lê a lista para contar e ordenar).
 */
function montarAdmin(
  opts: {
    org?: unknown;
    credencial?: Record<string, unknown> | null;
    binding?: Record<string, unknown> | null;
    espiao?: { tabelas: string[]; filtros: string[] };
    catalogo?: Array<Record<string, unknown>> | "falha";
  } = {},
) {
  return () => ({
    from: (tabela: string) => {
      opts.espiao?.tabelas.push(tabela);
      const filtros: Record<string, unknown> = {};
      const doCatalogo = () =>
        opts.catalogo === undefined || opts.catalogo === "falha"
          ? []
          : opts.catalogo.filter(
              (m) => m.provider === filtros.provider && (filtros.model_id === undefined || m.model_id === filtros.model_id),
            );
      const erro = opts.catalogo === "falha" && tabela === "ai_models" ? { message: "relation does not exist" } : null;
      const linhaDeCredencial = () =>
        opts.credencial === undefined ? credenciais.linha : opts.credencial;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filtros[col] = val;
          opts.espiao?.filtros.push(`${col}=${String(val)}`);
          return chain;
        },
        not: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          error: erro,
          data:
            tabela === "ai_purpose_bindings"
              ? (opts.binding === undefined ? bindings.linha : opts.binding)
              : tabela === "organizations"
                ? { settings: opts.org === undefined ? organizacao.settings : opts.org }
                : tabela === "ai_models"
                  ? (doCatalogo()[0] ?? null)
                  : linhaDeCredencial(),
        }),
        then: (ok: (r: { data: unknown; error: unknown }) => void) =>
          ok(
            tabela === "ai_models"
              ? { data: doCatalogo(), error: erro }
              : { data: linhaDeCredencial() ? [{ id: "cred-1", label: "x", ...linhaDeCredencial() }] : [], error: null },
          ),
      };
      return chain;
    },
  });
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: montarAdmin() }));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");

const ORG = "33333333-3333-4333-8333-333333333333";
const CRED = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };

beforeEach(() => {
  bindings.linha = null;
  credenciais.linha = null;
  organizacao.settings = { llm: { provider: "openai" } };
});

describe("sem binding e sem credencial da organização, o ponto fica SEM IA", () => {
  it("devolve null — nunca a chave de outra conta (ADR-0005)", async () => {
    // A recíproca de tudo abaixo: sem ela, um resolvedor que sempre ignorasse o
    // binding passaria em metade deste arquivo.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-da-instalacao");
    vi.stubEnv("OPENAI_API_KEY", "sk-da-instalacao");
    try {
      const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
      expect(r).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a resposta não carrega a origem 'padrao' — o vocabulário é só binding ou credencial da organização", async () => {
    credenciais.linha = CRED;
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "openai/gpt-5-mini");
    expect(["binding", "credencial_da_organizacao"]).toContain(r?.origem);
  });
});

describe("com binding, o painel manda", () => {
  it("usa o modelo e o provedor escolhidos na tela", async () => {
    bindings.linha = {
      provider: "openrouter",
      credential_id: "cred-1",
      model_id: "meta-llama/llama-3.3-70b-instruct",
      base_url: null,
    };
    credenciais.linha = CRED;

    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("binding");
    expect(r?.modelId).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  it("o modelo do binding é o que vai para o log de custo", async () => {
    // `modelId` alimenta a linha de ai_invocations. Reportar a constante padrão
    // faria a conta do mês atribuir o gasto ao modelo errado.
    bindings.linha = { provider: "openai", credential_id: "cred-1", model_id: "gpt-5-mini", base_url: null };
    credenciais.linha = CRED;
    const r = await resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-sonnet-5");
    expect(r?.modelId).toBe("gpt-5-mini");
  });
});

describe("o binding quebrado deixa o ponto SEM IA — nunca em outra chave", () => {
  it("binding sem credencial utilizável devolve null", async () => {
    // Credencial revogada depois de configurada: antes caía na chave da
    // instalação, e a conta de outra pessoa assumia em silêncio.
    bindings.linha = { provider: "openai", credential_id: "cred-que-sumiu", model_id: "gpt-5-mini", base_url: null };
    credenciais.linha = null;
    expect(await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("provider desconhecido devolve null, não outro provedor", async () => {
    // Fallback silencioso para um provedor VIZINHO mandaria a chave de um para
    // o endpoint de outro — a forma exata do defeito do PR #151.
    bindings.linha = { provider: "provedor-que-nao-existe", credential_id: "cred-1", model_id: "x/y", base_url: null };
    credenciais.linha = CRED;
    expect(await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("binding sem credencial NENHUMA (null) devolve null — a 'chave da instalação' não existe mais", async () => {
    bindings.linha = { provider: "anthropic", credential_id: null, model_id: "claude-haiku-4-5", base_url: null };
    expect(await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("cada ponto lê o SEU binding", () => {
  it("a consulta é escopada por organização e por ponto", async () => {
    const espiao = { tabelas: [] as string[], filtros: [] as string[] };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: montarAdmin({ espiao }) }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    await mod.resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5");
    expect(espiao.tabelas).toContain("ai_purpose_bindings");
    expect(espiao.filtros).toContain(`organization_id=${ORG}`);
    expect(espiao.filtros).toContain("purpose=bot_respond");
  });
});

describe("sem binding, a credencial da organização manda", () => {
  it("usa a credencial ativa do provider da organização", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ org: { llm: { provider: "openrouter" } }, credencial: CRED }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    const r = await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("credencial_da_organizacao");
    // O modelo é o do call site — trocá-lo pelo `default_model` da org faria o
    // classificador barato virar o modelo de conversa da organização.
    expect(r?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("a credencial é buscada escopada por organização e pelo provider da org", async () => {
    // Sem os dois filtros, a credencial de uma organização serviria a outra —
    // ou a chave de um provedor iria para o endpoint de outro (PR #151).
    const espiao = { tabelas: [] as string[], filtros: [] as string[] };
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ org: { llm: { provider: "openrouter" } }, credencial: CRED, espiao }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(espiao.tabelas).toContain("ai_provider_credentials");
    expect(espiao.filtros).toContain(`organization_id=${ORG}`);
    expect(espiao.filtros).toContain("provider=openrouter");
  });

  it("organização sem credencial do próprio provider fica sem IA (null)", async () => {
    // A recíproca: sem ela, um resolvedor que SEMPRE dissesse "credencial da
    // organização" passaria nos dois testes acima.
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ org: { llm: { provider: "openrouter" } }, credencial: null }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    expect(await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });
});

/**
 * O PAR PROVIDER+MODELO NÃO SE CRUZA — a lição do PR #151, no degrau da
 * organização. A credencial traz o PROVIDER junto; aplicá-la a um id que
 * pertence a outro provedor mandaria a chave de um para o endpoint do outro.
 * Quando o id não serve ao provider da organização, a resposta é `null` (ou o
 * padrão da organização, quando o chamador pediu) — nunca a chave da instalação.
 */
describe("a credencial da organização só vale para modelo que o provider dela executa", () => {
  async function com(provider: string) {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ org: { llm: { provider } }, credencial: CRED }),
    }));
    vi.resetModules();
    return import("@/lib/ai/gateway-binding");
  }

  it("id de OUTRO provedor não usa a credencial da organização — e sem outro degrau, é null", async () => {
    const mod = await com("anthropic");
    expect(await mod.resolverModeloDoPonto("bot_respond", ORG, "openai/gpt-5-mini")).toBeNull();
  });

  it("id do PRÓPRIO provedor entra sem o prefixo, que é nome de rota e não de modelo", async () => {
    const mod = await com("anthropic");
    const r = await mod.resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect((r?.model as { modelId?: string }).modelId).toBe("claude-haiku-4-5");
  });

  it("na OpenRouter o id canônico passa inteiro — lá o prefixo É a rota", async () => {
    const mod = await com("openrouter");
    const r = await mod.resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect((r?.model as { modelId?: string }).modelId).toBe("anthropic/claude-haiku-4-5");
  });
});

/**
 * O clima pede um id da Anthropic. Numa empresa que atende pela OpenAI sem
 * modelo escolhido para ele, a credencial dela não executa esse id, e o
 * resolvedor devolvia `null`: clima mudo. Quem pede a queda recebe o padrão da
 * organização (provedor E modelo de `settings.llm`), com a credencial DELA; quem
 * não pede — o agente que responde o cliente — segue recebendo `null`.
 */
describe("naFaltaUsarOPadraoDaOrganizacao", () => {
  async function importar(credencial: Record<string, unknown> | null = CRED) {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({
        org: { llm: { provider: "openai", default_model: "gpt-5.6-terra" } },
        credencial,
        catalogo: [{ provider: "openai", model_id: "gpt-5.6-terra", is_default_for_provider: true, supports_tools: true, input_price_per_million_cents: 250, output_price_per_million_cents: 1000 }],
      }),
    }));
    vi.resetModules();
    return import("@/lib/ai/gateway-binding");
  }

  it("sem a opção, o id de outro provedor devolve null (controle)", async () => {
    const mod = await importar();
    expect(await mod.resolverModeloDoPonto("bot_respond", ORG, "anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("com a opção, usa o padrão da organização com a credencial dela", async () => {
    const mod = await importar();
    const r = await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5", {
      naFaltaUsarOPadraoDaOrganizacao: true,
    });
    expect(r?.origem).toBe("credencial_da_organizacao");
    expect(r?.modelId).toBe("openai/gpt-5.6-terra");
    expect((r?.model as { modelId?: string }).modelId).toBe("gpt-5.6-terra");
  });

  it("com a opção mas SEM credencial do provedor do padrão: null, nunca a chave da instalação", async () => {
    const mod = await importar(null);
    expect(
      await mod.resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5", {
        naFaltaUsarOPadraoDaOrganizacao: true,
      }),
    ).toBeNull();
  });
});

/**
 * O PAR QUE A INSTALAÇÃO GRAVOU PELA METADE — conserto na leitura.
 *
 * O gatilho `fn_seed_org_llm_defaults` semeia o par da Anthropic, e o
 * instalador trocava só o `provider`: `{openai, claude-sonnet-5}`. Montado como
 * `openai/claude-sonnet-5`, o id ia à OpenAI, que não o conhece — em todo ponto
 * que cai no padrão da empresa. Instalações que já têm o par quebrado não
 * recebem migration de dados; é a leitura que troca o modelo pelo do catálogo
 * daquele provedor, e só quando o gravado não é dele.
 */
describe("o padrão da organização com o par (provedor, modelo) incoerente", () => {
  const CATALOGO_OPENAI = [
    { provider: "openai", model_id: "gpt-5-mini", supports_tools: true, input_price_per_million_cents: 25, output_price_per_million_cents: 200 },
    {
      provider: "openai",
      model_id: "gpt-5.6-terra",
      is_default_for_provider: true,
      supports_tools: true,
      input_price_per_million_cents: 250,
      output_price_per_million_cents: 1000,
    },
  ];
  const PEDIDO = "anthropic/claude-haiku-4-5";

  async function resolver(llm: Record<string, unknown>, catalogo: Array<Record<string, unknown>> | "falha") {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: montarAdmin({ org: { llm }, credencial: CRED, catalogo }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/ai/gateway-binding");
    return mod.resolverModeloDoPonto("sentiment_classify", ORG, PEDIDO, { naFaltaUsarOPadraoDaOrganizacao: true });
  }

  it("{openai, claude-sonnet-5} resolve o curado da OpenAI, não o id da Anthropic", async () => {
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5.6-terra");
    expect((r?.model as { modelId?: string }).modelId).toBe("gpt-5.6-terra");
  });

  it("par coerente passa intacto, mesmo quando não é o curado", async () => {
    const r = await resolver({ provider: "openai", default_model: "gpt-5-mini" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5-mini");
  });

  it("o id gravado com o prefixo do próprio provedor é conferido sem ele", async () => {
    const r = await resolver({ provider: "openai", default_model: "openai/gpt-5-mini" }, CATALOGO_OPENAI);
    expect(r?.modelId).toBe("openai/gpt-5-mini");
  });

  it("catálogo vazio do provedor mantém o de antes", async () => {
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, []);
    expect(r?.modelId).toBe("openai/claude-sonnet-5");
  });

  it("catálogo ilegível mantém o de antes, sem lançar", async () => {
    const r = await resolver({ provider: "openai", default_model: "claude-sonnet-5" }, "falha");
    expect(r?.modelId).toBe("openai/claude-sonnet-5");
  });
});
