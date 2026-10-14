/**
 * O CONVITE DO ASSISTENTE É RASTREÁVEL E REVOGÁVEL (CG-IAM-01).
 *
 * `sendOnboardingInvites` assinava o token sozinho: sem linha em `team_invites`,
 * sem `iat`, sem `invited_by`. A tela de Equipe não o listava, e — o que pesa —
 * `aplicarConvite` só sabe que um convite morreu pela LINHA: sem ela, o
 * convite do assistente era irrevogável pelas 24 h do token. Agora o assistente
 * emite pela trilha canônica (`emitirConvite`), a mesma de
 * `POST /api/v1/team/invite`.
 *
 * O que se mede aqui é o CONTRATO de ponta a ponta: o `invite_id` dentro do
 * link é o `id` da linha, e revogar essa linha fecha o aceite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SaidaReal from "@/lib/branding/saida";

import { bancoDeConvites, type Linha } from "../helpers/banco-de-convites";

const ORG = "22222222-2222-4222-8222-222222222222";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MEMBRO = "33333333-3333-4333-8333-333333333333";

let banco: ReturnType<typeof bancoDeConvites>;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: ADMIN,
    email: "dona@licenciada.example",
    full_name: "Dona",
    support: null,
    organizations: [],
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Licenciada", role: "admin" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => banco.cliente) }));
vi.mock("@/lib/email/roteador", () => ({
  // Instalação sem e-mail: o link volta para quem convidou — e é por ele que
  // o teste lê o token que a pessoa receberia.
  sendEmail: vi.fn(async () => ({ ok: false, error: "not_configured" })),
}));
vi.mock("@/lib/branding/saida", async (original) => ({
  ...(await original<typeof SaidaReal>()),
  marcaDaSaida: vi.fn(async () => ({
    nome: "Central de Teste",
    logoUrl: null,
    accent: "#000000",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  })),
}));

import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/roteador";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";

function tokenDo(link: string): string {
  return link.split("/team/accept-invite/")[1]!;
}

function montar(convitesExistentes: Linha[] = []) {
  banco = bancoDeConvites(
    {
      organizations: [{ id: ORG, onboarding_state: {}, onboarded_at: null }],
      user_organizations: [
        { organization_id: ORG, user_id: ADMIN, role: "admin", revoked_at: null },
        { organization_id: ORG, user_id: MEMBRO, role: "viewer", revoked_at: null },
      ],
      team_invites: convitesExistentes,
    },
    {
      usuarios: { [ADMIN]: "dona@licenciada.example", [MEMBRO]: "membro@licenciada.example" },
      rpc: (fn) =>
        fn === "fn_accept_team_invite"
          ? { data: { id: "vinculo-novo", changed: true }, error: null }
          : { data: null, error: null },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  montar();
});

describe("convite emitido pelo assistente", () => {
  it("nasce como LINHA em team_invites, e o invite_id do link é o id dela", async () => {
    const r = await sendOnboardingInvites({
      invitations: [{ email: "Vendedora@Licenciada.example", role: "agent" }],
    });

    expect(r.ok, JSON.stringify(r)).toBe(true);
    const linhas = banco.tabelas.team_invites!;
    expect(linhas, "o convite do assistente não deixou rastro em team_invites").toHaveLength(1);
    const linha = linhas[0]!;
    expect(linha).toMatchObject({
      organization_id: ORG,
      email: "vendedora@licenciada.example",
      role: "agent",
      invited_by: ADMIN,
      accepted_at: null,
      revoked_at: null,
    });

    const link = (r as { undelivered?: { accept_url: string }[] }).undelivered![0]!.accept_url;
    const payload = verifyInviteToken(tokenDo(link));
    expect(payload, "o link devolvido não traz um token válido").not.toBeNull();
    expect(payload!.invite_id, "o token aponta para um convite que não é a linha gravada").toBe(
      linha.id,
    );
    expect(payload!.organization_id).toBe(ORG);
    // O token canônico carrega quem convidou e quando — é o que deixa o banco
    // recusar um convite anterior a uma revogação de vínculo.
    expect(payload!.invited_by).toBe(ADMIN);
    expect(typeof payload!.iat).toBe("number");
  });

  it("REVOGAR a linha fecha o aceite do link que já saiu", async () => {
    const r = await sendOnboardingInvites({
      invitations: [{ email: "vendedora@licenciada.example", role: "manager" }],
    });
    const link = (r as { undelivered?: { accept_url: string }[] }).undelivered![0]!.accept_url;
    const payload = verifyInviteToken(tokenDo(link))!;

    // O que `POST /api/v1/team/invites/[id]/revoke` grava.
    banco.tabelas.team_invites![0]!.revoked_at = new Date().toISOString();

    const aceite = await aplicarConvite({
      userId: "44444444-4444-4444-8444-444444444444",
      payload,
    });
    expect(aceite, "um convite do assistente revogado virou vínculo").toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
    expect(banco.rpcs.filter((c) => c.fn === "fn_accept_team_invite")).toHaveLength(0);
  });

  it("quem JÁ é membro ativo não é reconvidado — nem promovido por um convite novo", async () => {
    const r = await sendOnboardingInvites({
      invitations: [
        { email: "membro@licenciada.example", role: "admin" },
        { email: "nova@licenciada.example", role: "agent" },
      ],
    });

    expect(r.ok).toBe(true);
    expect((r as { already_member?: string[] }).already_member).toEqual([
      "membro@licenciada.example",
    ]);
    expect(banco.tabelas.team_invites!.map((l) => l.email)).toEqual(["nova@licenciada.example"]);
    expect(vi.mocked(sendEmail).mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual([
      "nova@licenciada.example",
    ]);
    // O vínculo do membro segue com o papel que tinha.
    expect(banco.tabelas.user_organizations!.find((u) => u.user_id === MEMBRO)!.role).toBe(
      "viewer",
    );
  });

  it("reconvidar um e-mail com convite em aberto RENOVA a mesma linha", async () => {
    const existente = {
      id: "55555555-5555-4555-8555-555555555555",
      organization_id: ORG,
      email: "vendedora@licenciada.example",
      role: "agent",
      invited_by: ADMIN,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      resend_count: 0,
      accepted_at: null,
      revoked_at: null,
    };
    montar([existente]);

    const r = await sendOnboardingInvites({
      invitations: [{ email: "vendedora@licenciada.example", role: "agent" }],
    });

    expect(r.ok).toBe(true);
    expect(banco.tabelas.team_invites).toHaveLength(1);
    expect(banco.tabelas.team_invites![0]!.resend_count).toBe(1);
    const link = (r as { undelivered?: { accept_url: string }[] }).undelivered![0]!.accept_url;
    expect(verifyInviteToken(tokenDo(link))!.invite_id).toBe(existente.id);
  });

  it("o rastro diz que o convite saiu do assistente", async () => {
    await sendOnboardingInvites({
      invitations: [{ email: "nova@licenciada.example", role: "agent" }],
    });

    const convidou = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action === "member.invited");
    expect(convidou, "member.invited não foi auditado").toBeDefined();
    expect(convidou!.organizationId).toBe(ORG);
    expect(convidou!.metadata).toMatchObject({ source: "onboarding", role: "agent" });
  });

  it("tudo entregue e ninguém pulado: segue para o próximo passo", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, via: "smtp" } as never);
    await expect(
      sendOnboardingInvites({ invitations: [{ email: "nova@licenciada.example", role: "agent" }] }),
    ).rejects.toThrow("REDIRECT:/onboarding");
    expect(banco.tabelas.team_invites).toHaveLength(1);
  });
});
