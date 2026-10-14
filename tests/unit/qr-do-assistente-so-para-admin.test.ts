/**
 * O QR DE PAREAMENTO DO ASSISTENTE É DO ADMINISTRADOR (CG-IAM-01).
 *
 * `GET /api/v1/onboarding/whatsapp/qr` repassa a imagem do QR da sessão WAHA
 * da organização. Quem escaneia esse QR liga o PRÓPRIO WhatsApp ao canal da
 * empresa — um efeito administrativo, o mesmo que o `POST` irmão
 * (`.../whatsapp/session`) já exige de `admin`. Até aqui o `GET` só pedia
 * sessão e organização ativa, então qualquer membro, `viewer` inclusive,
 * pegava o QR enquanto o dono pareava.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const requireRole = vi.fn();
const loadOnboardingChannel = vi.fn(async () => ({
  waha_session_name: "org_x",
  archived_at: null,
}));
const fetchDoWaha = vi.fn(
  async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
);

vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/channels/onboarding-session", () => ({
  loadOnboardingChannel: (...a: unknown[]) => loadOnboardingChannel(...(a as [])),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WAHA_API_BASE_URL = "http://waha.local";
  process.env.WAHA_API_KEY = "chave-de-teste";
  vi.stubGlobal("fetch", fetchDoWaha);
});

describe("GET /api/v1/onboarding/whatsapp/qr", () => {
  it("quem não é administrador não recebe o QR, e o WAHA nem é consultado", async () => {
    requireRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }),
    });
    const { GET } = await import("@/app/api/v1/onboarding/whatsapp/qr/route");

    const res = await GET();

    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "channel_sessions" }),
    );
    expect(loadOnboardingChannel).not.toHaveBeenCalled();
    expect(fetchDoWaha).not.toHaveBeenCalled();
  });

  it("o administrador recebe o QR da organização ATIVA — o par de vacuidade", async () => {
    requireRole.mockResolvedValue({
      ok: true,
      user: { id: "u1" },
      org: { orgId: "org-1", name: "QA", role: "admin" },
    });
    const { GET } = await import("@/app/api/v1/onboarding/whatsapp/qr/route");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(loadOnboardingChannel).toHaveBeenCalledWith(expect.anything(), "org-1");
    expect(fetchDoWaha).toHaveBeenCalledTimes(1);
  });
});
