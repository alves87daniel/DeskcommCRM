/**
 * GREEN-CRM-02 — a UI do catálogo e a seção "Produto Green" do dossiê.
 *
 * Componentes reais com `apiClient` falso. O que se prova:
 *
 *   CATÁLOGO   lista (ativos e inativos), cria, inativa; nunca apaga;
 *   DOSSIÊ     renderiza o produto, seleciona, salva, recarrega e continua vendo; produto
 *              inativo já associado aparece sinalizado e fora do seletor; ganho/perdido e
 *              viewer não editam; funil comum = a seção não existe;
 *   SEPARAÇÃO  trocar o produto fala SÓ com /green-context: não toca funil, etapa, etiqueta
 *              nem binding.
 */
import { readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: h.get, patch: h.patch, post: h.post },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

import { ContextoGreenDoNegocio } from "@/components/green/ContextoGreenDoNegocio";
import { PainelDeProdutosGreen } from "@/app/app/settings/produtos-green/_painel";

const LEAD = "e1111111-1111-4111-8111-111111111111";
const ALFA = {
  id: "a1111111-1111-4111-8111-111111111111",
  code: "produto_alfa",
  name: "Produto Alfa",
  family: "generic",
  is_active: true,
};
const BETA = {
  id: "a2222222-2222-4222-8222-222222222222",
  code: "produto_beta",
  name: "Produto Beta",
  family: "generic",
  is_active: true,
};
const VELHO = {
  id: "a3333333-3333-4333-8333-333333333333",
  code: "produto_velho",
  name: "Produto Velho",
  family: "generic",
  is_active: false,
};

const completo = (p: typeof ALFA) => ({
  ...p,
  organization_id: "o1",
  description: null,
  metadata: {},
  created_at: "c",
  updated_at: "u",
});

function contexto(produto: typeof ALFA | null, extra: Record<string, unknown> = {}) {
  return {
    data: {
      lead_id: LEAD,
      lead_status: "open",
      editable: true,
      context: produto
        ? { product_id: produto.id, product: produto, created_at: "c", updated_at: "u" }
        : null,
      ...extra,
    },
  };
}

function renderizar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Roteia o `apiClient.get` pelas URLs que a seção realmente chama. */
function servidor(opts: { ctx: unknown | Error; produtos?: (typeof ALFA)[] }) {
  h.get.mockImplementation(async (url: string) => {
    if (url.includes("/green-context")) {
      if (opts.ctx instanceof Error) throw opts.ctx;
      return opts.ctx;
    }
    if (url.includes("/green/products")) {
      const todos = url.includes("include_inactive=true");
      return { data: (opts.produtos ?? []).filter((p) => todos || p.is_active).map(completo) };
    }
    throw new Error(`rota inesperada: ${url}`);
  });
}

beforeEach(() => {
  h.get.mockReset();
  h.patch.mockReset();
  h.post.mockReset();
});
afterEach(cleanup);

describe("dossiê · Produto Green", () => {
  it("oportunidade sem produto: mostra o vazio e oferece só os produtos ATIVOS", async () => {
    servidor({ ctx: contexto(null), produtos: [ALFA, BETA, VELHO] });
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);

    expect(await screen.findByText("Nenhum produto definido")).toBeInTheDocument();
    const seletor = await screen.findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(within(seletor).getAllByRole("option").length).toBeGreaterThan(1));
    const opcoes = within(seletor)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(opcoes).toContain("Produto Alfa");
    expect(opcoes).toContain("Produto Beta");
    expect(opcoes).not.toContain("Produto Velho");
  });

  it("seleciona, salva e mostra o produto salvo; o PATCH leva só o product_id", async () => {
    servidor({ ctx: contexto(null), produtos: [ALFA, BETA] });
    h.patch.mockResolvedValue(contexto(BETA));
    const user = userEvent.setup();
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);

    const seletor = await screen.findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(within(seletor).getAllByRole("option").length).toBeGreaterThan(2));
    expect(screen.getByRole("button", { name: "Salvar produto" })).toBeDisabled();
    await user.selectOptions(seletor, BETA.id);
    await user.click(screen.getByRole("button", { name: "Salvar produto" }));

    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/green-context`, {
        product_id: BETA.id,
      }),
    );
    expect(await screen.findByTestId("produto-atual")).toHaveTextContent("Produto Beta");
  });

  it("recarregar a página (cache novo) continua mostrando o produto persistido", async () => {
    servidor({ ctx: contexto(ALFA), produtos: [ALFA, BETA] });
    const primeira = renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);
    expect(await screen.findByTestId("produto-atual")).toHaveTextContent("Produto Alfa");
    primeira.unmount();

    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);
    expect(await screen.findByTestId("produto-atual")).toHaveTextContent("Produto Alfa");
  });

  it("produto INATIVO já associado aparece sinalizado e não é opção do seletor", async () => {
    servidor({ ctx: contexto(VELHO), produtos: [ALFA, VELHO] });
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);

    const atual = await screen.findByTestId("produto-atual");
    expect(atual).toHaveTextContent("Produto Velho");
    expect(atual).toHaveTextContent("Produto inativo");
    const seletor = await screen.findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(within(seletor).getAllByRole("option").length).toBeGreaterThan(1));
    const opcoes = within(seletor)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(opcoes).not.toContain("Produto Velho");
    expect(opcoes).toContain("Produto Alfa");
  });

  it("negócio ganho ou perdido: mostra o produto e NÃO oferece trocar", async () => {
    servidor({
      ctx: contexto(ALFA, { lead_status: "won", editable: false }),
      produtos: [ALFA, BETA],
    });
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);

    expect(await screen.findByTestId("produto-atual")).toHaveTextContent("Produto Alfa");
    expect(screen.getByText(/não pode mais ser trocado/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar produto" })).not.toBeInTheDocument();
  });

  it("viewer vê o produto, sem formulário", async () => {
    servidor({ ctx: contexto(ALFA), produtos: [ALFA] });
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar={false} />);
    expect(await screen.findByTestId("produto-atual")).toHaveTextContent("Produto Alfa");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("funil comum (404): a seção não existe", async () => {
    servidor({
      ctx: new ApiError(404, "green_context_not_applicable", undefined, "req-1"),
    });
    const { container } = renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);
    await waitFor(() => expect(h.get).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('[data-testid="contexto-green"]')).toBeNull(),
    );
    expect(screen.queryByText("Produto Green")).not.toBeInTheDocument();
  });

  it("catálogo vazio: pede para cadastrar (manager) e não quebra", async () => {
    servidor({ ctx: contexto(null), produtos: [] });
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar podeCadastrar />);
    expect(await screen.findByText(/Nenhum produto ativo no catálogo/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cadastrar produtos" })).toHaveAttribute(
      "href",
      "/app/settings/produtos-green",
    );
  });
});

describe("FUNIL != PRODUTO · a UI não mexe em funil, etapa, etiqueta nem binding", () => {
  it("trocar de produto fala só com /green-context", async () => {
    servidor({ ctx: contexto(ALFA), produtos: [ALFA, BETA] });
    h.patch.mockResolvedValue(contexto(BETA));
    const user = userEvent.setup();
    renderizar(<ContextoGreenDoNegocio leadId={LEAD} podeEditar />);

    const seletor = await screen.findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(within(seletor).getAllByRole("option").length).toBeGreaterThan(2));
    await user.selectOptions(seletor, BETA.id);
    await user.click(screen.getByRole("button", { name: "Salvar produto" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));

    const urls = [...h.get.mock.calls, ...h.patch.mock.calls, ...h.post.mock.calls].map((c) =>
      String(c[0]),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, url).toMatch(/\/green-context$|\/green\/products/);
      expect(url).not.toMatch(/pipeline|stage|tag|binding|move/i);
    }
    expect(h.post).not.toHaveBeenCalled();
  });

  it("o componente não importa nada de funil, etapa, etiqueta ou binding", () => {
    for (const arquivo of [
      "components/green/ContextoGreenDoNegocio.tsx",
      "app/app/settings/produtos-green/_painel.tsx",
      "hooks/green/useContextoGreen.ts",
      "hooks/green/useProdutosGreen.ts",
    ]) {
      const imports = readFileSync(arquivo, "utf8")
        .split("\n")
        .filter((l) => /^\s*import\b/.test(l))
        .join("\n");
      expect(imports, arquivo).not.toMatch(
        /pipeline|stage|etapa|funil|tags?\b|binding|catalog_products|catalogo/i,
      );
    }
  });

  it("o dossiê MONTA a seção, entre o contato e a linha do tempo", () => {
    const fonte = readFileSync("components/kanban/LeadDossier.tsx", "utf8");
    expect(fonte).toMatch(/<ContextoGreenDoNegocio\s+leadId=\{lead\.id\}/);
    expect(fonte.indexOf("<ContextoGreenDoNegocio")).toBeGreaterThan(
      fonte.indexOf("<ContatoDoNegocio"),
    );
    expect(fonte.indexOf("<ContextoGreenDoNegocio")).toBeLessThan(fonte.indexOf("<LeadTimeline"));
  });
});

describe("catálogo · tela de Produtos Green", () => {
  it("lista ativos e inativos (o pedido inclui os inativos) e mostra o estado", async () => {
    servidor({ ctx: new Error("n/a"), produtos: [ALFA, VELHO] });
    renderizar(<PainelDeProdutosGreen />);
    const lista = await screen.findByTestId("lista-de-produtos-green");
    expect(within(lista).getByText("Produto Alfa")).toBeInTheDocument();
    expect(within(lista).getByText("Produto Velho")).toBeInTheDocument();
    expect(within(lista).getByText("Ativo")).toBeInTheDocument();
    expect(within(lista).getByText("Inativo")).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith("/api/v1/green/products?include_inactive=true");
  });

  it("catálogo vazio é um estado normal, não um erro", async () => {
    servidor({ ctx: new Error("n/a"), produtos: [] });
    renderizar(<PainelDeProdutosGreen />);
    expect(await screen.findByText("Nenhum produto cadastrado ainda.")).toBeInTheDocument();
  });

  it("cria um produto: código estável, nome, família aberta", async () => {
    servidor({ ctx: new Error("n/a"), produtos: [] });
    h.post.mockResolvedValue({ data: completo(ALFA) });
    const user = userEvent.setup();
    renderizar(<PainelDeProdutosGreen />);

    await user.click(await screen.findByRole("button", { name: "Novo produto" }));
    const botao = screen.getByRole("button", { name: "Cadastrar produto" });
    expect(botao).toBeDisabled();

    await user.type(screen.getByLabelText("Código"), "Código Ruim");
    expect(screen.getByText(/Use letras minúsculas/)).toBeInTheDocument();
    expect(botao).toBeDisabled();

    await user.clear(screen.getByLabelText("Código"));
    await user.type(screen.getByLabelText("Código"), "produto_gama");
    await user.type(screen.getByLabelText("Nome"), "Produto Gama");
    const familia = screen.getByLabelText("Família");
    await user.clear(familia);
    await user.type(familia, "familia_nova");
    await user.click(botao);

    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith("/api/v1/green/products", {
        code: "produto_gama",
        name: "Produto Gama",
        description: undefined,
        family: "familia_nova",
      }),
    );
  });

  it("edição não deixa trocar o código e não envia o código", async () => {
    servidor({ ctx: new Error("n/a"), produtos: [ALFA] });
    h.patch.mockResolvedValue({ data: completo(ALFA) });
    const user = userEvent.setup();
    renderizar(<PainelDeProdutosGreen />);

    await user.click(await screen.findByRole("button", { name: "Editar" }));
    expect(screen.getByLabelText("Código")).toBeDisabled();
    const nome = screen.getByLabelText("Nome");
    await user.clear(nome);
    await user.type(nome, "Alfa Renovado");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));
    const [url, corpo] = h.patch.mock.calls[0]!;
    expect(url).toBe(`/api/v1/green/products/${ALFA.id}`);
    expect(corpo).toEqual({ name: "Alfa Renovado", description: null, family: "generic" });
    expect(corpo).not.toHaveProperty("code");
  });

  it("inativa sem apagar: PATCH is_active=false, nenhum DELETE no cliente", async () => {
    servidor({ ctx: new Error("n/a"), produtos: [ALFA] });
    h.patch.mockResolvedValue({ data: completo({ ...ALFA, is_active: false }) });
    const user = userEvent.setup();
    renderizar(<PainelDeProdutosGreen />);

    await user.click(await screen.findByRole("button", { name: "Inativar" }));
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(`/api/v1/green/products/${ALFA.id}`, {
        is_active: false,
      }),
    );
    expect(readFileSync("app/app/settings/produtos-green/_painel.tsx", "utf8")).not.toMatch(
      /\.delete\(/,
    );
  });
});
