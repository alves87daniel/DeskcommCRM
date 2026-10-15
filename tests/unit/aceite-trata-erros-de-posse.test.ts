/**
 * ERRO DE BANCO NA POSSE DO CONVITE NÃO VIRA VÍNCULO NEM SILÊNCIO (CG-IAM-01, FIX).
 *
 * A revisão da CG-IAM-01 achou duas lacunas em `lib/auth/aplicar-convite.ts`:
 *
 * 1. O UPDATE que reivindica a linha descartava `error`. Um erro de banco virava
 *    "não ganhou a linha", o código relia o convite, o via em aberto e seguia
 *    para `fn_accept_team_invite` SEM posse — exatamente a corrida que a posse
 *    existe para fechar, e com a linha ficando Pendente para sempre.
 * 2. A devolução da posse após falha do vínculo não conferia o próprio
 *    resultado. Se ela falhasse, a linha dizia "aceito" por alguém que não
 *    entrou, e o aceite respondia como se tivesse desfeito tudo.
 *
 * Aqui cada falha é injetada no dublê em memória (`tests/helpers/banco-de-convites`),
 * então o que se prova é o comportamento do código diante da resposta do
 * supabase-js, não uma garantia do Postgres. A corrida real com banco segue
 * sem prova (não há transação envolvendo as duas escritas, e este FIX não a
 * inventa).
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/aceite-trata-erros-de-posse.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoDeConvites, type Linha } from "../helpers/banco-de-convites";

const ORG = "33333333-3333-4333-8333-333333333333";
const CONVITE = "22222222-2222-4222-8222-222222222222";
const PESSOA = "11111111-1111-4111-8111-111111111111";
const OUTRA_PESSOA = "44444444-4444-4444-8444-444444444444";

const PAYLOAD = {
  invite_id: CONVITE,
  email: "convidada@example.com",
  organization_id: ORG,
  role: "agent" as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000) - 60,
};

const ERRO_DE_BANCO = { code: "57P01", message: "terminating connection" };

let banco: ReturnType<typeof bancoDeConvites>;
let respostaDoVinculo: { data: unknown; error: unknown };

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => banco.cliente) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";

function convite(campos: Partial<Linha> = {}): Linha {
  return {
    id: CONVITE,
    organization_id: ORG,
    email: PAYLOAD.email,
    role: "agent",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
    ...campos,
  };
}

function montar(linhas: Linha[]) {
  banco = bancoDeConvites(
    { team_invites: linhas },
    {
      rpc: (fn) =>
        fn === "fn_accept_team_invite" ? respostaDoVinculo : { data: null, error: null },
    },
  );
}

type Operacao = "select" | "update";

/**
 * Injeta falhas no dublê por operação em `team_invites`: a N-ésima chamada de
 * `select` ou `update` (contando a partir de 1) responde `erro` em vez de
 * executar. Opcionalmente roda `antes()` logo depois de uma leitura, para
 * simular o que outro processo gravou no meio.
 */
function sabotar(opts: {
  falha?: { op: Operacao; vez: number; erro?: typeof ERRO_DE_BANCO };
  depoisDaLeitura?: (vez: number) => void;
}) {
  const fromOriginal = banco.cliente.from;
  const contagem: Record<Operacao, number> = { select: 0, update: 0 };
  banco.cliente.from = ((tabela: string) => {
    const b = fromOriginal(tabela) as Record<string, unknown>;
    if (tabela !== "team_invites") return b;
    let opAtual: Operacao = "select";
    let vezAtual = 0;
    const selectOriginal = b.select as (...a: unknown[]) => unknown;
    const updateOriginal = b.update as (...a: unknown[]) => unknown;
    b.select = (...a: unknown[]) => {
      if (opAtual === "select" && vezAtual === 0) vezAtual = ++contagem.select;
      return selectOriginal(...a);
    };
    b.update = (...a: unknown[]) => {
      opAtual = "update";
      vezAtual = ++contagem.update;
      return updateOriginal(...a);
    };
    const maybeSingle = b.maybeSingle as () => Promise<{ data: unknown; error: unknown }>;
    b.maybeSingle = async () => {
      const f = opts.falha;
      if (f && f.op === opAtual && f.vez === vezAtual) {
        return { data: null, error: f.erro ?? ERRO_DE_BANCO };
      }
      const r = await maybeSingle();
      if (opAtual === "select") opts.depoisDaLeitura?.(vezAtual);
      return r;
    };
    return b;
  }) as typeof banco.cliente.from;
}

const vinculos = () => banco.rpcs.filter((c) => c.fn === "fn_accept_team_invite");
const linha = () => banco.tabelas.team_invites![0]!;

beforeEach(() => {
  vi.clearAllMocks();
  respostaDoVinculo = { data: { id: "vinculo-1", changed: true }, error: null };
});

describe("erro de banco ao reivindicar a posse do convite", () => {
  it("⭐ 1. UPDATE de posse com erro: nada de vínculo, resposta é internal_error", async () => {
    montar([convite()]);
    sabotar({ falha: { op: "update", vez: 1 } });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r, "um erro de banco na posse virou aceite sem posse").toEqual({
      ok: false,
      motivo: "internal_error",
    });
    expect(vinculos(), "fn_accept_team_invite foi chamada sem a posse confirmada").toHaveLength(0);
    expect(linha()).toMatchObject({ accepted_at: null, accepted_by: null });
  });

  it("2. UPDATE de posse sem linha correspondente (sumiu no meio): recusa, sem vínculo", async () => {
    montar([convite()]);
    // A linha existia na leitura e não existe mais quando o UPDATE chega:
    // nenhuma linha casa, a releitura não acha nada.
    sabotar({
      depoisDaLeitura: (vez) => {
        if (vez === 1) banco.tabelas.team_invites!.length = 0;
      },
    });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(vinculos()).toHaveLength(0);
  });

  it("2b. a releitura após perder a linha falha: internal_error, não o fluxo legado", async () => {
    montar([convite()]);
    // Primeiro UPDATE não casa (revogado no meio); a releitura cai com erro.
    // Sem tratar `error`, `data` nulo parecia "linha sumiu" e recusava — por
    // sorte. Com a leitura inicial errando, parecia "convite legado" e PASSAVA.
    sabotar({
      falha: { op: "select", vez: 2 },
      depoisDaLeitura: (vez) => {
        if (vez === 1) linha().revoked_at = new Date().toISOString();
      },
    });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(vinculos()).toHaveLength(0);
  });

  it("2c. a leitura INICIAL da linha falha: internal_error, nunca o fluxo legado sem linha", async () => {
    montar([convite({ revoked_at: new Date().toISOString() })]);
    sabotar({ falha: { op: "select", vez: 1 } });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(
      r,
      "erro ao ler team_invites foi tratado como 'convite sem linha' e um convite revogado seguiu",
    ).toEqual({ ok: false, motivo: "internal_error" });
    expect(vinculos()).toHaveLength(0);
  });

  it("5. aceite concorrente com revogação: o UPDATE não casa, a releitura diz revogado, recusa", async () => {
    montar([convite()]);
    sabotar({
      depoisDaLeitura: (vez) => {
        if (vez === 1) linha().revoked_at = new Date().toISOString();
      },
    });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(vinculos()).toHaveLength(0);
    expect(linha().accepted_at).toBeNull();
  });

  it("6. repetição legítima: o UPDATE não casa porque a MESMA pessoa já tem a posse, e o aceite segue", async () => {
    montar([convite()]);
    sabotar({
      depoisDaLeitura: (vez) => {
        if (vez === 1) {
          linha().accepted_at = new Date().toISOString();
          linha().accepted_by = PESSOA;
        }
      },
    });
    respostaDoVinculo = { data: { id: "vinculo-1", changed: false }, error: null };

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: true, membershipId: "vinculo-1", mudou: false });
    expect(vinculos()).toHaveLength(1);
    expect(linha()).toMatchObject({ accepted_by: PESSOA });
  });

  it("7. o UPDATE não casa porque OUTRA pessoa levou a linha no meio: recusa", async () => {
    montar([convite()]);
    sabotar({
      depoisDaLeitura: (vez) => {
        if (vez === 1) {
          linha().accepted_at = new Date().toISOString();
          linha().accepted_by = OUTRA_PESSOA;
        }
      },
    });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(vinculos()).toHaveLength(0);
    expect(linha()).toMatchObject({ accepted_by: OUTRA_PESSOA });
  });
});

describe("falha do vínculo depois da posse", () => {
  it("3. o banco falhou ao criar o vínculo (não 42501): internal_error e a posse volta, conferida", async () => {
    montar([convite()]);
    respostaDoVinculo = { data: null, error: ERRO_DE_BANCO };

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(linha()).toMatchObject({ accepted_at: null, accepted_by: null });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("⭐ 4. a devolução da posse falha: internal_error (mesmo com 42501) e o estado incerto fica registrado", async () => {
    montar([convite()]);
    respostaDoVinculo = { data: null, error: { code: "42501", message: "invite_revoked" } };
    // Posse (1º update) passa; a devolução (2º update) cai.
    sabotar({ falha: { op: "update", vez: 2 } });

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(
      r,
      "a devolução da posse falhou e o aceite respondeu como se tivesse desfeito tudo",
    ).toEqual({ ok: false, motivo: "internal_error" });
    // O que ficou no banco: a linha segue "aceita" por quem não entrou. É o
    // estado incerto que o log precisa denunciar, com o que o operador precisa
    // para consertar à mão — e sem token.
    expect(linha()).toMatchObject({ accepted_by: PESSOA });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(logger.error).mock.calls[0]![1] as Record<string, unknown>;
    expect(ctx).toMatchObject({ invite_id: CONVITE, organization_id: ORG, user_id: PESSOA });
  });

  it("4b. a devolução não casa linha nenhuma (alguém mexeu na posse no meio): também é estado incerto", async () => {
    montar([convite()]);
    respostaDoVinculo = { data: null, error: ERRO_DE_BANCO };
    sabotar({
      depoisDaLeitura: () => undefined,
    });
    // Entre a posse e a devolução, a posse foi parar em outra pessoa (por
    // exemplo, correção manual). A devolução, filtrada por `accepted_by`,
    // não casa nada e não pode dizer que desfez.
    const rpcOriginal = banco.cliente.rpc;
    banco.cliente.rpc = (async (fn: string, args: Record<string, unknown>) => {
      const r = await rpcOriginal(fn, args);
      linha().accepted_by = OUTRA_PESSOA;
      return r;
    }) as typeof banco.cliente.rpc;

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
