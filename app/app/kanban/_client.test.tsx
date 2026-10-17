import { describe, expect, it } from "vitest";

import { vizinhoAoMover, type FunilDaLista } from "./_client";

const funil = (id: string): FunilDaLista => ({
  id,
  name: id,
  slug: id,
  description: null,
  position: 1000,
  is_default: false,
});

/**
 * A conta do `i - 2` é a única lógica não-óbvia da tela, e ela erra em silêncio:
 * um funil que "sobe" e não sai do lugar parece lentidão, não bug.
 */
describe("vizinhoAoMover", () => {
  const lista = [funil("a"), funil("b"), funil("c"), funil("d")];

  it("subir troca com quem está acima — o novo vizinho de cima é quem estava DUAS casas acima", () => {
    expect(vizinhoAoMover(lista, 2, "subir")).toBe("a");
  });

  it("subir da segunda posição leva ao topo (sem vizinho de cima)", () => {
    expect(vizinhoAoMover(lista, 1, "subir")).toBeNull();
  });

  it("descer põe o funil logo abaixo do vizinho de baixo", () => {
    expect(vizinhoAoMover(lista, 0, "descer")).toBe("b");
  });

  it("descer do penúltimo aponta para o último", () => {
    expect(vizinhoAoMover(lista, 2, "descer")).toBe("d");
  });

  it("não inventa vizinho fora da lista", () => {
    // A tela desabilita as setas nas pontas; se um dia deixar de desabilitar,
    // isto vira `depois_de: null` (topo) em vez de um id inexistente que a rota
    // recusaria com 422.
    expect(vizinhoAoMover(lista, 0, "subir")).toBeNull();
    expect(vizinhoAoMover(lista, 3, "descer")).toBeNull();
  });
});

/**
 * A lista de funis oferece o caminho até o editor de etapas — só para quem
 * pode gerenciar. As mutações da lista (criar, renomear, arquivar) são dublês:
 * o que se mede é a presença do link e o destino dele.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import type { Role } from "@/lib/auth/types";

let papel: Role = "admin";
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ role: papel, cliente_pela_agenda: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/pipelines/usePipelines", () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return { useCriarFunil: mut, useEditarFunil: mut, useArquivarFunil: mut };
});

import { FunisClient } from "./_client";

afterEach(cleanup);

describe("FunisClient — atalho para o editor de etapas", () => {
  it("gerente vê, em cada funil, o link para as etapas daquele funil", () => {
    papel = "manager";
    render(
      <FunisClient funis={[funil("a"), funil("b")]} arquivados={[]} podeGerenciar podeImportar />,
    );
    expect(screen.getByTestId("editar-etapas-a").getAttribute("href")).toBe(
      "/app/settings/tenant/pipelines#etapas-a",
    );
    expect(screen.getByTestId("editar-etapas-b").getAttribute("href")).toBe(
      "/app/settings/tenant/pipelines#etapas-b",
    );
  });

  it("agente vê a lista e abre o funil, mas não vê o link das etapas", () => {
    papel = "agent";
    render(<FunisClient funis={[funil("a")]} arquivados={[]} podeGerenciar={false} podeImportar />);
    expect(screen.getByTestId("abrir-a")).toBeInTheDocument();
    expect(screen.queryByTestId("editar-etapas-a")).toBeNull();
  });
});
