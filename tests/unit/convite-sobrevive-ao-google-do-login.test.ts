/**
 * O CONVITE SOBREVIVE À ENTRADA COM GOOGLE INICIADA EM `/login` (CG-IAM-01).
 *
 * O convidado sem sessão vê, na tela de aceite, "Fazer login" →
 * `/login?next=/team/accept-invite/<token>`. Ali o botão do Google mandava só o
 * `next`; a volta (`/auth/callback`) lia o convite apenas do parâmetro
 * `convite`, e quem ainda não tinha conta caía em `ensureTenantForUser`: uma
 * EMPRESA NOVA com a pessoa como `admin`, em vez do vínculo na organização que
 * a convidou. E quem já tinha vínculo e chegava com `convite` explícito (o
 * Google do cadastro) era levado ao `/app`, com o convite esquecido.
 *
 * O convite agora é lido também do `next` — só na forma exata da tela de
 * aceite — nas duas metades do OAuth, e passa pelas MESMAS provas de sempre
 * (`decidirConviteDoSignup`: assinatura e e-mail confirmado; `aplicarConvite`:
 * a linha e a revogação). Os casos usam token assinado de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { signInviteToken } from "@/lib/auth/invite-token";

const APP = "http://localhost:3000";
const ORG_DO_CONVITE = "33333333-3333-4333-8333-333333333333";
const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "convidada@example.com" };

const h = vi.hoisted(() => ({
  troca: vi.fn(),
  fatores: vi.fn(),
  oauth: vi.fn(),
  estadoGoogle: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession: h.troca, mfa: { listFactors: h.fatores } },
  })),
  createClientDeEntradaComGoogle: vi.fn(async () => ({ auth: { signInWithOAuth: h.oauth } })),
}));
vi.mock("@/lib/auth/provedor-google", () => ({ estadoDoProvedorGoogle: h.estadoGoogle }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({
  ensureTenantForUser: vi.fn(async () => ({ provisioned: true })),
  vinculoAtivo: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: vi.fn(async () => false) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Central de Teste" })),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { ensureTenantForUser, vinculoAtivo } from "@/lib/auth/provision";
import { conviteDoDestino, urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";
import { signInWithGoogle } from "@/app/actions/auth/signInWithGoogle";
import { GET } from "@/app/auth/callback/route";

function convite(email = USUARIO.email): string {
  const agora = Math.floor(Date.now() / 1000);
  return signInviteToken({
    invite_id: "22222222-2222-4222-8222-222222222222",
    email,
    organization_id: ORG_DO_CONVITE,
    role: "agent",
    exp: agora + 3600,
    iat: agora,
  });
}

const aceite = (token: string) => `/team/accept-invite/${token}`;

function volta(params: Record<string, string>) {
  return GET(
    new NextRequest(`${APP}/auth/callback?${new URLSearchParams({ code: "abc", ...params })}`),
  );
}

/** O destino prometido: 302 (tela pública) ou a ponte same-origin (tela autenticada). */
async function destino(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (location) {
    const url = new URL(location);
    return url.pathname + url.search;
  }
  const script = (await res.clone().text()).match(/<script>(.*?)<\/script>/)![1]!;
  return JSON.parse(
    script.replace(/^window\.location\.replace\(/, "").replace(/\);$/, ""),
  ) as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.troca.mockResolvedValue({ data: { user: USUARIO }, error: null });
  h.fatores.mockResolvedValue({ data: { totp: [] } });
  h.estadoGoogle.mockResolvedValue("ligado");
  h.oauth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2" }, error: null });
  vi.mocked(vinculoAtivo).mockResolvedValue(null);
  vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
});

describe("o convite que só existe no `next` da tela de login", () => {
  it("é reconhecido só na forma exata da tela de aceite", () => {
    const t = convite();
    expect(conviteDoDestino(aceite(t))).toBe(t);
    expect(conviteDoDestino("/app/inbox")).toBeNull();
    expect(conviteDoDestino(`/team/accept-invite/${t}/extra`)).toBeNull();
    expect(conviteDoDestino("/team/accept-invite/../../app")).toBeNull();
    expect(conviteDoDestino(`https://evil.example/team/accept-invite/${t}`)).toBeNull();
    expect(conviteDoDestino(null)).toBeNull();
  });

  it("a ida leva o convite na URL de retorno, junto com o next", () => {
    const t = convite();
    const url = new URL(urlDeRetornoDoGoogle(APP, { next: aceite(t) }));
    expect(url.searchParams.get("convite")).toBe(t);
    expect(url.searchParams.get("next")).toBe(aceite(t));
  });

  it("o botão do /login (só `next`) monta o redirect do Google com o convite", async () => {
    const t = convite();
    await expect(signInWithGoogle({ next: aceite(t) })).rejects.toThrow(
      "REDIRECT:https://accounts.google.com",
    );

    const { redirectTo } = h.oauth.mock.calls[0]![0].options as { redirectTo: string };
    expect(new URL(redirectTo).searchParams.get("convite")).toBe(t);
  });
});

describe("a volta do Google com convite", () => {
  it("⭐ conta nova vinda de /login?next=<aceite>: vínculo na organização do convite, sem empresa nova", async () => {
    const t = convite();
    const res = await volta({ next: aceite(t) });

    expect(
      vi.mocked(ensureTenantForUser),
      "o convidado ganhou uma organização própria",
    ).not.toHaveBeenCalled();
    expect(vi.mocked(aplicarConvite)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USUARIO.id,
        payload: expect.objectContaining({ organization_id: ORG_DO_CONVITE }),
      }),
    );
    expect(await destino(res)).toBe("/app");
  });

  it("conta nova, convite REVOGADO: sem vínculo e sem empresa — a tela de aceite explica", async () => {
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });
    const t = convite();
    const res = await volta({ next: aceite(t) });

    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(await destino(res)).toBe(aceite(t));
    expect(
      res.headers.get("location"),
      "302 na cadeia do Google não leva o cookie Strict",
    ).toBeNull();
  });

  it("conta nova, convite com assinatura inválida: recusa, sem empresa", async () => {
    const t = convite();
    const adulterado = `${t.slice(0, -2)}xx`;
    const res = await volta({ next: aceite(adulterado) });

    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(await destino(res)).toBe("/login?error=convite_invalido");
  });

  it("conta nova, convite emitido para OUTRO e-mail: recusa, sem vínculo nem empresa", async () => {
    const res = await volta({ next: aceite(convite("outra@example.com")) });

    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(await destino(res)).toBe("/login?error=convite_invalido");
  });

  it("usuário JÁ existente com convite explícito: vai para o aceite, não para o /app", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    const t = convite();
    const res = await volta({ convite: t });

    expect(await destino(res)).toBe(aceite(t));
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("usuário já existente pelo /login?next=<aceite>: o destino continua sendo o aceite", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    const t = convite();
    expect(await destino(await volta({ next: aceite(t) }))).toBe(aceite(t));
  });

  // A tela de aceite é pública, mas lê a sessão (`getUser()`) para decidir entre
  // "Fazer login" e "Aceitar". Um 302 dentro da cadeia que começou no Google é
  // navegação entre sites: o cookie `SameSite=Strict` recém-emitido não vai, a
  // tela mostra "Fazer login" e o Google de novo fecha o laço. Só a ponte
  // same-origin entrega a sessão (a mesma razão da #1646).
  it("usuário já existente com convite: o aceite chega pela ponte, não por 302", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    const entradas: Record<string, string>[] = [
      { convite: convite() },
      { next: aceite(convite()) },
    ];
    for (const params of entradas) {
      const res = await volta(params);
      expect(res.headers.get("location"), JSON.stringify(params)).toBeNull();
      expect(await destino(res)).toMatch(/^\/team\/accept-invite\//);
    }
  });

  it("usuário já existente com convite ilegível: o convite é ignorado e ele entra", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    expect(await destino(await volta({ convite: "lixo" }))).toBe("/app");
  });

  it("usuário com verificação em duas etapas e convite: a prova do fator leva ao aceite", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    h.fatores.mockResolvedValue({ data: { totp: [{ id: "f1", status: "verified" }] } });
    const t = convite();
    const res = await volta({ convite: t });

    const url = new URL(res.headers.get("location")!);
    expect(url.pathname).toBe("/login/mfa");
    expect(url.searchParams.get("next")).toBe(aceite(t));
  });
});

describe("a volta do Google sem convite segue como sempre", () => {
  it("conta nova: ganha a própria organização e vai ao assistente", async () => {
    const res = await volta({});
    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledTimes(1);
    expect(await destino(res)).toBe("/onboarding/welcome");
  });

  it("usuário existente: entra no destino pedido", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    expect(await destino(await volta({ next: "/app/leads" }))).toBe("/app/leads");
  });

  it("next externo não vira redirect para fora", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("99999999-9999-4999-8999-999999999999");
    expect(await destino(await volta({ next: "https://evil.example" }))).toBe("/app");
  });
});
