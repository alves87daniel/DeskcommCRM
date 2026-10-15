/**
 * O cabeçalho do quadro oferece o caminho até o editor de etapas — para quem
 * pode usá-lo. Os miolos do quadro (colunas, filtros, lote, diálogo de lead)
 * têm testes próprios e aqui viram dublês: o que se mede é só o cabeçalho.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/lib/auth/types";

let papel: Role = "admin";
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ role: papel }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/pipelines/p1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({
    data: {
      pipeline: { id: "p1", name: "Energia Solar", slug: "energia-solar", settings: {} },
      stages: [],
      leads: [],
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: () => <div data-testid="quadro" />,
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));

import { PipelinePageClient } from "./_client";

describe("PipelinePageClient — atalho para o editor de etapas", () => {
  it("administrador tem o link no cabeçalho, apontando para as etapas DESTE funil", () => {
    papel = "admin";
    render(<PipelinePageClient pipelineId="p1" initialName="Energia Solar" role="admin" />);
    const link = screen.getByTestId("editar-etapas-p1");
    expect(link.getAttribute("href")).toBe("/app/settings/tenant/pipelines#etapas-p1");
    // O quadro continua ali — o link é acréscimo, não troca de tela.
    expect(screen.getByTestId("quadro")).toBeInTheDocument();
  });

  it("agente abre o mesmo quadro sem o link", () => {
    papel = "agent";
    render(<PipelinePageClient pipelineId="p1" initialName="Energia Solar" role="agent" />);
    expect(screen.getByTestId("quadro")).toBeInTheDocument();
    expect(screen.queryByTestId("editar-etapas-p1")).toBeNull();
  });
});
