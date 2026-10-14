/**
 * O ACEITE REIVINDICA A LINHA DO CONVITE ANTES DE CRIAR O VÍNCULO (CG-IAM-01).
 *
 * `aplicarConvite` lia `team_invites`, chamava `fn_accept_team_invite` e só
 * DEPOIS fechava o convite. Uma revogação gravada entre a leitura e o vínculo
 * passava: a pessoa virava membro, e a tela de Equipe mostrava o convite como
 * "revogado" — o administrador acreditando ter cancelado um acesso que existia.
 *
 * O contrato agora é de posse: o aceite marca `accepted_at`/`accepted_by` só
 * onde `revoked_at` ainda é nulo, e só cria o vínculo se ganhou a linha. Quem
 * revoga depois disso encontra o convite aceito (a revogação também só escreve
 * onde `accepted_at` é nulo) e responde 409. Se o banco recusar o vínculo, a
 * posse é devolvida.
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

let banco: ReturnType<typeof bancoDeConvites>;
let respostaDoVinculo: { data: unknown; error: unknown };

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => banco.cliente) }));

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

const vinculos = () => banco.rpcs.filter((c) => c.fn === "fn_accept_team_invite");

beforeEach(() => {
  vi.clearAllMocks();
  respostaDoVinculo = { data: { id: "vinculo-1", changed: true }, error: null };
});

describe("aceite de convite com linha em team_invites", () => {
  it("convite em aberto: a linha é reivindicada pela pessoa e o vínculo nasce", async () => {
    montar([convite()]);

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: true, membershipId: "vinculo-1", mudou: true });
    expect(vinculos()).toHaveLength(1);
    expect(banco.tabelas.team_invites![0]).toMatchObject({ accepted_by: PESSOA });
    expect(banco.tabelas.team_invites![0]!.accepted_at).not.toBeNull();
  });

  it("⭐ revogação gravada DEPOIS da leitura e ANTES do vínculo não vira acesso", async () => {
    montar([convite()]);
    // A corrida: o administrador revoga no instante seguinte à leitura da linha.
    const fromOriginal = banco.cliente.from;
    let leituras = 0;
    banco.cliente.from = ((tabela: string) => {
      const b = fromOriginal(tabela) as Record<string, unknown>;
      if (tabela !== "team_invites") return b;
      const maybeSingle = b.maybeSingle as () => Promise<{ data: unknown }>;
      b.maybeSingle = async () => {
        const r = await maybeSingle();
        if (leituras++ === 0) banco.tabelas.team_invites![0]!.revoked_at = new Date().toISOString();
        return r;
      };
      return b;
    }) as typeof banco.cliente.from;

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r, "a revogação no meio do aceite virou vínculo").toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
    expect(vinculos(), "fn_accept_team_invite foi chamada para um convite revogado").toHaveLength(
      0,
    );
    expect(banco.tabelas.team_invites![0]!.accepted_at).toBeNull();
  });

  it("aceite repetido pela MESMA pessoa é idempotente", async () => {
    montar([convite()]);
    expect((await aplicarConvite({ userId: PESSOA, payload: PAYLOAD })).ok).toBe(true);

    respostaDoVinculo = { data: { id: "vinculo-1", changed: false }, error: null };
    const segundo = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(segundo).toEqual({ ok: true, membershipId: "vinculo-1", mudou: false });
    expect(banco.tabelas.team_invites![0]).toMatchObject({ accepted_by: PESSOA });
  });

  it("convite já aceito por OUTRA pessoa não serve a mais ninguém", async () => {
    montar([convite({ accepted_at: new Date().toISOString(), accepted_by: OUTRA_PESSOA })]);

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(vinculos()).toHaveLength(0);
  });

  it("o banco recusou o vínculo (42501): a posse da linha é devolvida", async () => {
    montar([convite()]);
    respostaDoVinculo = { data: null, error: { code: "42501", message: "invite_revoked" } };

    const r = await aplicarConvite({ userId: PESSOA, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(banco.tabelas.team_invites![0]).toMatchObject({ accepted_at: null, accepted_by: null });
  });

  it("convite revogado antes de tudo: nem reivindica, nem vincula", async () => {
    montar([convite({ revoked_at: new Date().toISOString() })]);

    expect(await aplicarConvite({ userId: PESSOA, payload: PAYLOAD })).toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
    expect(vinculos()).toHaveLength(0);
    expect(banco.escritas.filter((e) => e.tabela === "team_invites")).toHaveLength(0);
  });

  it("convite SEM linha (emitido antes da 0238) segue o fluxo legado", async () => {
    montar([]);

    expect((await aplicarConvite({ userId: PESSOA, payload: PAYLOAD })).ok).toBe(true);
    expect(vinculos()).toHaveLength(1);
  });
});
