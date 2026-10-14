/**
 * O CONVITE DO TITULAR, NA CRIAÇÃO DA ORGANIZAÇÃO PELA PLATAFORMA, É
 * RASTREÁVEL E REVOGÁVEL (CG-IAM-01).
 *
 * `POST /api/v1/admin/tenants` cria a organização (`fn_create_tenant_with_owner`,
 * recibo idempotente com `invite_id` e `issued_at`) e convida o titular como
 * `admin`. O convite saía por `issueInvite` direto: token sem linha em
 * `team_invites`, fora da tela de Equipe e irrevogável pelas 24 h do token —
 * justamente o convite de maior poder da instalação.
 *
 * Agora a linha nasce com o `id` do RECIBO. Isso preserva o que a rota já
 * garantia: o replay com a mesma `Idempotency-Key` devolve o MESMO link, sem
 * segundo e-mail e sem segunda linha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SaidaReal from "@/lib/branding/saida";
import { NextRequest } from "next/server";

import { bancoDeConvites } from "../helpers/banco-de-convites";

const ATOR = "a2180000-0000-4000-8000-000000000001";
const ORG = "a2180000-0000-4000-8000-000000000002";
const CHAVE = "a2180000-0000-4000-8000-000000000003";
const CONVITE = "a2180000-0000-4000-8000-000000000004";
const EMITIDO_EM = Math.floor(Date.now() / 1000) - 10;

let banco: ReturnType<typeof bancoDeConvites>;
let criada = true;

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(async () => ({
    user: {
      id: ATOR,
      email: "plataforma@example.test",
      user_metadata: { full_name: "Plataforma" },
    },
    platformAdmin: { scope: "full" },
  })),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => banco.cliente) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, via: "smtp" })),
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

import { sendEmail } from "@/lib/email/roteador";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { POST } from "@/app/api/v1/admin/tenants/route";

function pedido(ownerEmail = "titular@licenciada.example") {
  return new NextRequest("http://localhost/api/v1/admin/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": CHAVE },
    body: JSON.stringify({
      display_name: "Licenciada",
      slug: "licenciada",
      owner_email: ownerEmail,
    }),
  });
}

async function convidar(ownerEmail?: string) {
  const res = await POST(pedido(ownerEmail));
  expect(res.status).toBe(201);
  return (await res.json()).data as {
    owner_invitation: { accept_url: string; invite_id: string; email_dispatched: boolean } | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  criada = true;
  banco = bancoDeConvites(
    { team_invites: [] },
    {
      rpc: (fn) =>
        fn === "fn_create_tenant_with_owner"
          ? {
              data: {
                id: ORG,
                slug: "licenciada",
                display_name: "Licenciada",
                created: criada,
                invite_id: CONVITE,
                issued_at: EMITIDO_EM,
              },
              error: null,
            }
          : { data: { id: "vinculo", changed: true }, error: null },
    },
  );
});

describe("convite do titular na criação da organização", () => {
  it("nasce como linha em team_invites com o id do recibo — e é esse id que viaja no link", async () => {
    const r = await convidar();

    expect(banco.tabelas.team_invites).toHaveLength(1);
    expect(banco.tabelas.team_invites![0]).toMatchObject({
      id: CONVITE,
      organization_id: ORG,
      email: "titular@licenciada.example",
      role: "admin",
      invited_by: ATOR,
      revoked_at: null,
    });
    const token = r.owner_invitation!.accept_url.split("/team/accept-invite/")[1]!;
    expect(verifyInviteToken(token)!.invite_id).toBe(CONVITE);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
  });

  it("replay com a mesma chave: o mesmo link, sem segunda linha e sem segundo e-mail", async () => {
    const primeiro = await convidar();
    criada = false;
    const segundo = await convidar();

    expect(segundo.owner_invitation!.accept_url).toBe(primeiro.owner_invitation!.accept_url);
    expect(banco.tabelas.team_invites).toHaveLength(1);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
  });

  it("revogar o convite do titular fecha o aceite do link que já saiu", async () => {
    const r = await convidar();
    banco.tabelas.team_invites![0]!.revoked_at = new Date().toISOString();

    const token = r.owner_invitation!.accept_url.split("/team/accept-invite/")[1]!;
    const aceite = await aplicarConvite({
      userId: "a2180000-0000-4000-8000-000000000009",
      payload: verifyInviteToken(token)!,
    });

    expect(aceite).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(banco.rpcs.filter((c) => c.fn === "fn_accept_team_invite")).toHaveLength(0);
  });

  it("o próprio criador como titular: nenhum convite, nenhuma linha", async () => {
    const r = await convidar("plataforma@example.test");

    expect(r.owner_invitation).toBeNull();
    expect(banco.tabelas.team_invites).toHaveLength(0);
  });
});
