/**
 * ONBOARDING SIMPLIFICADO POR CONFIGURAÇÃO DA INSTALAÇÃO (CG-IAM-01).
 *
 * O assistente herdado exige, em ordem, WhatsApp, inteligência artificial,
 * funil e o ensaio do agente antes de liberar o CRM. Para o licenciado do
 * ConectorGreen isso trava o primeiro acesso em serviços que ainda não existem
 * para ele. `ONBOARDING_MODE=simplificado` reduz o percurso obrigatório ao
 * mínimo do administrador — o negócio (nome e fuso) — com a equipe como passo
 * opcional; o resto continua acessível depois, nas Configurações.
 *
 * O contrato aprovado, medido aqui:
 *  - sem a variável (ou com valor irreconhecível) vale o HERDADO, intacto;
 *  - o simplificado nunca exige WhatsApp, IA, funil nem ensaio;
 *  - o fim do assistente não afirma o que não foi feito;
 *  - `onboarded_at` segue significando "o administrador concluiu a configuração
 *    inicial" — não promete estrutura Green que não existe.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { interpretarModoDoOnboarding } from "@/lib/onboarding/modo";
import { passosVisiveis, proximoPasso, resumoDoOnboarding } from "@/lib/onboarding/passos";
import type { OnboardingState } from "@/lib/schemas/onboarding";

const HERDADO = ["welcome", "connect-whatsapp", "setup-ai", "funil", "testar", "invite-team"];

describe("a configuração da instalação", () => {
  it("vazia ou ausente vale o assistente herdado", () => {
    expect(interpretarModoDoOnboarding(undefined)).toBe("herdado");
    expect(interpretarModoDoOnboarding("")).toBe("herdado");
    expect(interpretarModoDoOnboarding("herdado")).toBe("herdado");
  });

  it("`simplificado` liga o percurso enxuto, sem depender de caixa e espaços", () => {
    expect(interpretarModoDoOnboarding("simplificado")).toBe("simplificado");
    expect(interpretarModoDoOnboarding("  Simplificado ")).toBe("simplificado");
  });

  it("valor irreconhecível não derruba nada: vale o herdado", () => {
    expect(() => interpretarModoDoOnboarding("simplified")).not.toThrow();
    expect(interpretarModoDoOnboarding("simplified")).toBe("herdado");
    expect(interpretarModoDoOnboarding("rapido")).toBe("herdado");
  });
});

describe("os passos de cada modo", () => {
  it("sem modo declarado, os passos são exatamente os de antes", () => {
    expect(passosVisiveis({ lojaLigada: false }).map((p) => p.segmento)).toEqual(HERDADO);
    expect(passosVisiveis({ lojaLigada: false, modo: "herdado" }).map((p) => p.segmento)).toEqual(
      HERDADO,
    );
  });

  it("simplificado: só o negócio e a equipe — nem WhatsApp, nem IA, nem funil, nem ensaio", () => {
    for (const lojaLigada of [false, true]) {
      expect(passosVisiveis({ lojaLigada, modo: "simplificado" }).map((p) => p.segmento)).toEqual([
        "welcome",
        "invite-team",
      ]);
    }
  });

  it("simplificado: depois do negócio vem a equipe, e depois dela o fim", () => {
    const ctx = { lojaLigada: false, modo: "simplificado" as const };
    expect(proximoPasso({}, ctx)?.segmento).toBe("welcome");

    const comNegocio: OnboardingState = {
      welcome: {
        accepted_at: "2026-10-14T00:00:00Z",
        timezone: "America/Sao_Paulo",
        display_name: "Licenciada",
      },
    };
    expect(proximoPasso(comNegocio, ctx)?.segmento).toBe("invite-team");
    expect(
      proximoPasso({ ...comNegocio, team: { invites_sent: 0, skipped: true } }, ctx),
    ).toBeNull();
  });

  it("simplificado: o resumo final não cobra o que o percurso não ofereceu", () => {
    const itens = resumoDoOnboarding({}, { lojaLigada: false, modo: "simplificado" });
    expect(itens.map((i) => i.segmento)).toEqual(["welcome", "invite-team"]);
  });
});

describe("o fim do assistente simplificado", () => {
  it("não diz que o funcionário foi treinado — diz onde configurar depois", async () => {
    const { DoneClient } = await import("@/app/onboarding/done/_client");
    render(
      <DoneClient
        itens={resumoDoOnboarding(
          {
            welcome: {
              accepted_at: "x",
              timezone: "America/Sao_Paulo",
              display_name: "Licenciada",
            },
          },
          { lojaLigada: false, modo: "simplificado" },
        )}
        pecas={[]}
        noAr={false}
        modo="simplificado"
      />,
    );

    const tela = document.body.textContent ?? "";
    expect(tela).not.toMatch(/treinado|rascunho|publicado/i);
    expect(tela).toMatch(/WhatsApp, inteligência artificial e funis/);
    expect(screen.getByRole("button", { name: "Começar a usar" })).toBeTruthy();
  });
});

const h = vi.hoisted(() => ({ modo: "simplificado", estado: {} as OnboardingState }));

vi.mock("@/app/actions/onboarding/finishOnboarding", () => ({ finishOnboarding: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u1", idioma: "pt-BR", support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", name: "Licenciada", role: "admin" }),
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  loadOnboardingState: async () => ({ state: h.estado, onboardedAt: null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/onboarding/modo", async (original) => ({
  ...(await original<typeof ModoReal>()),
  modoDoOnboarding: () => h.modo,
}));
import type * as ModoReal from "@/lib/onboarding/modo";

describe("o roteador do assistente obedece ao modo da instalação", () => {
  beforeEach(() => {
    h.estado = {
      welcome: { accepted_at: "x", timezone: "America/Sao_Paulo", display_name: "Licenciada" },
    };
  });

  async function destino(): Promise<string> {
    const { default: OnboardingIndex } = await import("@/app/onboarding/page");
    try {
      await OnboardingIndex();
    } catch (e) {
      return (e as Error).message.replace(/^REDIRECT:/, "");
    }
    throw new Error("o roteador não redirecionou");
  }

  it("simplificado: depois do negócio, a equipe — o WhatsApp não é cobrado", async () => {
    h.modo = "simplificado";
    expect(await destino()).toBe("/onboarding/invite-team");
  });

  it("herdado: depois do negócio, o WhatsApp, como sempre", async () => {
    h.modo = "herdado";
    expect(await destino()).toBe("/onboarding/connect-whatsapp");
  });
});
