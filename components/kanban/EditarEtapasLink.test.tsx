/**
 * O atalho para o editor de etapas — quem o VÊ e para onde ele LEVA.
 *
 * O editor (`/app/settings/tenant/pipelines`) já existia com tudo: criar,
 * renomear, reordenar, marcar ganho/perda, arquivar. O que faltava era caminho:
 * a página não tem entrada de menu e nem a lista de funis nem o quadro
 * apontavam para ela (CG-OPS-01, diagnóstico de 2026-10-15: zero acessos à
 * página numa sessão inteira de testes manuais). Este link é só o caminho.
 *
 * A regra de quem vê é a MESMA da página e das rotas de etapa
 * (`requireRole("manager")`): esconder o link de `viewer`/`agent` não é
 * permissão nova, é não prometer uma porta que o servidor fecharia com 403.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/lib/auth/types";

let papel: Role | null = "admin";
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => (papel ? { role: papel } : null),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// O editor importa o cliente da API e o toast só para as mutações; aqui ele
// entra apenas pela âncora exportada, sem rede.
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { ancoraDasEtapas } from "@/app/app/settings/tenant/pipelines/_stages";
import { EditarEtapasLink, rotaDasEtapas } from "./EditarEtapasLink";

const PIPE = "11111111-1111-4111-8111-111111111111";

describe("rotaDasEtapas", () => {
  it("aponta para a âncora que o editor de etapas realmente renderiza", () => {
    // Se a âncora do editor mudar de nome, este teste é o que avisa que o
    // atalho passou a abrir a página no topo, longe do funil pedido.
    expect(rotaDasEtapas(PIPE)).toBe(`/app/settings/tenant/pipelines#${ancoraDasEtapas(PIPE)}`);
  });
});

describe("EditarEtapasLink", () => {
  it("administrador vê o link e ele leva ao editor do funil pedido", () => {
    papel = "admin";
    render(<EditarEtapasLink pipelineId={PIPE} />);
    const link = screen.getByTestId(`editar-etapas-${PIPE}`);
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(rotaDasEtapas(PIPE));
    expect(link).toHaveTextContent("Editar etapas");
  });

  it("gerente também vê: é o corte da rota PATCH/POST de etapas", () => {
    papel = "manager";
    render(<EditarEtapasLink pipelineId={PIPE} />);
    expect(screen.getByTestId(`editar-etapas-${PIPE}`)).toBeInTheDocument();
  });

  it.each<Role>(["agent", "viewer", "ai_operator"])(
    "%s não vê o link (a página responderia 403)",
    (r) => {
      papel = r;
      render(<EditarEtapasLink pipelineId={PIPE} />);
      expect(screen.queryByTestId(`editar-etapas-${PIPE}`)).toBeNull();
    },
  );

  it("sem organização ativa não há link", () => {
    papel = null;
    render(<EditarEtapasLink pipelineId={PIPE} />);
    expect(screen.queryByTestId(`editar-etapas-${PIPE}`)).toBeNull();
  });
});
