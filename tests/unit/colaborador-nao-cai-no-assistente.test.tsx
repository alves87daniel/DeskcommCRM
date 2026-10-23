/**
 * QUEM NÃO ADMINISTRA A ORGANIZAÇÃO NÃO CAI NO ASSISTENTE (CG-IAM-01).
 *
 * O gate de `/app` mandava para `/onboarding` TODO membro de uma organização
 * sem `onboarded_at`, qualquer que fosse o papel. Com a guarda das ações do
 * assistente exigindo administrador, isso viraria uma armadilha: o colaborador
 * chegaria a uma tela em que nenhum botão funciona. As duas pontas precisam da
 * MESMA regra (`configuraPeloAssistente`):
 *
 *  - `app/app/layout.tsx` só manda o ADMINISTRADOR para o assistente; os demais
 *    usam o CRM conforme o papel deles, mesmo com a organização por configurar;
 *  - `app/onboarding/layout.tsx` e `app/onboarding/page.tsx` devolvem ao CRM
 *    quem chega lá sem administrar a organização.
 *
 * Executa os Server Components de verdade, no molde de
 * `tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let papel = "admin";
let onboardedAt: string | null = null;

const adminClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { onboarded_at: onboardedAt, status: "active", settings: null },
        }),
      }),
    }),
  }),
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [{ organization_id: "org-1", organization_name: "QA", role: papel }],
  }),
  loadAuthUser: async () => ({
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [{ organization_id: "org-1", organization_name: "QA", role: papel }],
  }),
  resolveActiveOrg: async () => ({
    orgId: "org-1",
    name: "QA",
    role: papel,
    interface_settings: null,
  }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  loadOnboardingState: async () => ({ state: {}, onboardedAt }),
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Central de Teste", logoUrl: null }),
}));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

async function destinoDe(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
}

// O primeiro import do layout de `/app` arrasta a casca inteira (~50 s a frio
// nesta máquina); fora do relógio de cada caso.
beforeAll(async () => {
  await import("@/app/app/layout");
  await import("@/app/onboarding/layout");
  await import("@/app/onboarding/page");
}, 180_000);

beforeEach(() => {
  papel = "admin";
  onboardedAt = null;
});

describe("organização ainda não configurada", () => {
  it("o administrador é mandado para o assistente", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    expect(await destinoDe(() => AppLayout({ children: null }))).toBe("/onboarding");
  });

  for (const role of ["viewer", "agent", "manager"]) {
    it(`${role} usa o CRM — não é mandado para o assistente`, async () => {
      papel = role;
      const { default: AppLayout } = await import("@/app/app/layout");
      expect(
        await destinoDe(() => AppLayout({ children: null })),
        `o ${role} foi mandado para fora do CRM numa organização sem onboarded_at`,
      ).toBeNull();
    });

    it(`${role} que abre /onboarding volta ao CRM`, async () => {
      papel = role;
      const { default: OnboardingIndex } = await import("@/app/onboarding/page");
      const { default: OnboardingLayout } = await import("@/app/onboarding/layout");
      expect(await destinoDe(() => OnboardingIndex())).toBe("/app");
      expect(await destinoDe(() => OnboardingLayout({ children: null }))).toBe("/app");
    });
  }

  it("o administrador que abre /onboarding segue no assistente", async () => {
    const { default: OnboardingIndex } = await import("@/app/onboarding/page");
    const { default: OnboardingLayout } = await import("@/app/onboarding/layout");
    expect(await destinoDe(() => OnboardingIndex())).toMatch(/^\/onboarding\//);
    expect(await destinoDe(() => OnboardingLayout({ children: null }))).toBeNull();
  });
});

describe("organização já configurada", () => {
  it("ninguém é mandado para o assistente", async () => {
    onboardedAt = "2026-10-01T00:00:00Z";
    for (const role of ["viewer", "agent", "manager", "admin"]) {
      papel = role;
      const { default: AppLayout } = await import("@/app/app/layout");
      expect(await destinoDe(() => AppLayout({ children: null })), role).toBeNull();
    }
  });
});
