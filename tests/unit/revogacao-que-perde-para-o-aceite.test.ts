/**
 * A REVOGAÇÃO QUE PERDE A CORRIDA PARA O ACEITE NÃO DIZ "REVOGADO" (CG-IAM-01).
 *
 * O aceite passou a tomar posse da linha antes de criar o vínculo
 * (`lib/auth/aplicar-convite.ts`), e a revogação só escreve onde `accepted_at`
 * é nulo. Uma das duas ganha. Mas `POST /api/v1/team/invites/[id]/revoke`
 * lia a linha, escrevia sem conferir se alguma linha mudou e respondia
 * `revoked_at` — além de auditar `member.invite_revoked`. Se o aceite ganhasse
 * entre a leitura e a escrita, o administrador ouvia "revogado" sobre uma
 * pessoa que acabara de entrar, e o rastro registrava um ato que não existiu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { bancoDeConvites } from "../helpers/banco-de-convites";

const ORG = "33333333-3333-4333-8333-333333333333";
const CONVITE = "22222222-2222-4222-8222-222222222222";

let banco: ReturnType<typeof bancoDeConvites>;

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: ORG, name: "QA", role: "admin" },
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => banco.cliente) }));

import { audit } from "@/lib/audit";
import { POST } from "@/app/api/v1/team/invites/[id]/revoke/route";

function montar(aceitaNoMeio: boolean) {
  banco = bancoDeConvites({
    team_invites: [
      {
        id: CONVITE,
        organization_id: ORG,
        email: "pessoa@example.com",
        role: "agent",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        accepted_at: null,
        revoked_at: null,
      },
    ],
  });
  if (!aceitaNoMeio) return;
  // O aceite toma posse da linha logo depois de a rota lê-la.
  const fromOriginal = banco.cliente.from;
  banco.cliente.from = ((tabela: string) => {
    const b = fromOriginal(tabela) as Record<string, unknown>;
    const maybeSingle = b.maybeSingle as () => Promise<unknown>;
    b.maybeSingle = async () => {
      const r = await maybeSingle();
      Object.assign(banco.tabelas.team_invites![0]!, {
        accepted_at: new Date().toISOString(),
        accepted_by: "44444444-4444-4444-8444-444444444444",
      });
      return r;
    };
    return b;
  }) as typeof banco.cliente.from;
}

const revogar = () =>
  POST(
    new NextRequest(`http://localhost/api/v1/team/invites/${CONVITE}/revoke`, { method: "POST" }),
    {
      params: Promise.resolve({ id: CONVITE }),
    },
  );

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/team/invites/[id]/revoke", () => {
  it("o aceite ganhou a linha no meio: 409, sem dizer revogado e sem auditar revogação", async () => {
    montar(true);

    const res = await revogar();

    expect(res.status).toBe(409);
    expect(banco.tabelas.team_invites![0]!.revoked_at).toBeNull();
    expect(
      vi.mocked(audit).mock.calls.some((c) => c[0].action === "member.invite_revoked"),
      "auditou uma revogação que não aconteceu",
    ).toBe(false);
  });

  it("convite em aberto é revogado — o par de vacuidade", async () => {
    montar(false);

    const res = await revogar();

    expect(res.status).toBe(200);
    expect(banco.tabelas.team_invites![0]!.revoked_at).not.toBeNull();
    expect(vi.mocked(audit).mock.calls.some((c) => c[0].action === "member.invite_revoked")).toBe(
      true,
    );
  });
});
