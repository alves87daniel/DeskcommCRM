/**
 * CG-COM-01 — a seção "Expansão comercial" do dossiê e o diálogo da nova oportunidade.
 *
 * Componentes reais com `apiClient` falso. O que se prova:
 *
 *   RELAÇÃO    a origem e as expansões aparecem com link, produto, funil, etapa e situação; a
 *              oportunidade sem acesso aparece sem título; sem relação e sem como criar, a seção
 *              não existe;
 *   CRIAÇÃO    só negócio ganho e com contato, só agent+, só com funil Green de destino; o
 *              formulário começa com o primeiro funil, a primeira etapa, o produto sugerido e o
 *              título do negócio; o envio fala SÓ com `POST /expansion` (nunca move, clona ou
 *              troca o produto do negócio ganho);
 *   REPETIÇÃO  reenviar no mesmo diálogo leva a MESMA `Idempotency-Key`; reabrir gera outra; a
 *              resposta "já existia" é dita como tal.
 */
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  sucesso: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: h.get, patch: h.patch, post: h.post },
}));
vi.mock("sonner", () => ({ toast: { success: h.sucesso, error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

import { ExpansaoDoNegocio } from "@/components/green/ExpansaoDoNegocio";
import { chaveExpansao } from "@/hooks/green/useExpansao";
import type { ExpansaoDaOportunidade, OportunidadeRelacionada } from "@/lib/green/expansao/schemas";

const LEAD = "e1111111-1111-4111-8111-111111111111";
const ORIGEM = "e0000000-0000-4000-8000-000000000000";
const NOVA = "e2222222-2222-4222-8222-222222222222";
const FUNIL_EXP = "f2222222-2222-4222-8222-222222222222";
const FUNIL_CONEXAO = "f1111111-1111-4111-8111-111111111111";
const ETAPA_NOVO = "51111111-1111-4111-8111-111111111111";
const ETAPA_PROPOSTA = "52222222-2222-4222-8222-222222222222";
const ETAPA_CONEXAO = "53333333-3333-4333-8333-333333333333";
const ALFA = { id: "a1111111-1111-4111-8111-111111111111", name: "Produto Alfa", is_active: true };
const BETA = { id: "a2222222-2222-4222-8222-222222222222", name: "Produto Beta", is_active: true };
const VELHO = {
  id: "a3333333-3333-4333-8333-333333333333",
  name: "Produto Velho",
  is_active: false,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const relacao = (extra: Partial<OportunidadeRelacionada> = {}): OportunidadeRelacionada => ({
  lead_id: NOVA,
  visible: true,
  title: "Maria - Expansão",
  status: "open",
  pipeline_name: "Expansão",
  stage_name: "Novo",
  product: BETA,
  linked_at: "2026-10-08T10:00:00Z",
  ...extra,
});

function expansao(extra: Partial<ExpansaoDaOportunidade> = {}): ExpansaoDaOportunidade {
  return {
    lead_id: LEAD,
    lead_status: "won",
    eligibility: { eligible: true, reason: null },
    can_create: true,
    origin: null,
    expansions: [],
    destinations: [
      {
        pipeline_id: FUNIL_EXP,
        name: "Expansão",
        stages: [
          { id: ETAPA_NOVO, name: "Novo" },
          { id: ETAPA_PROPOSTA, name: "Proposta" },
        ],
      },
      {
        pipeline_id: FUNIL_CONEXAO,
        name: "ConexãoGreen",
        stages: [{ id: ETAPA_CONEXAO, name: "Contato" }],
      },
    ],
    suggested_product_id: ALFA.id,
    ...extra,
  };
}

/** Roteia o `apiClient.get` pelas URLs que a seção realmente chama. */
function servidor(dados: ExpansaoDaOportunidade | Error) {
  h.get.mockImplementation(async (url: string) => {
    if (url === `/api/v1/leads/${LEAD}/expansion`) {
      if (dados instanceof Error) throw dados;
      return { data: dados };
    }
    if (url.startsWith("/api/v1/green/products")) {
      return { data: [ALFA, BETA, VELHO].filter((p) => p.is_active) };
    }
    throw new Error(`rota inesperada: ${url}`);
  });
}

function renderizar(podeCriar = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <ExpansaoDoNegocio
        leadId={LEAD}
        tituloDoNegocio="Maria - Conta de luz"
        podeCriar={podeCriar}
      />
    </QueryClientProvider>,
  );
  /** A leitura da relação TERMINOU (com dado ou com erro): só então "não há seção" prova algo. */
  const leituraTerminou = () =>
    waitFor(() =>
      expect(["success", "error"]).toContain(qc.getQueryState(chaveExpansao(LEAD))?.status),
    );
  return { ...r, leituraTerminou };
}

const criado = (created = true) => ({
  data: {
    created,
    lead: {
      id: NOVA,
      pipeline_id: FUNIL_EXP,
      stage_id: ETAPA_NOVO,
      status: "open",
      contact_id: "c",
    },
    link_id: "l",
    origin_lead_id: LEAD,
  },
});

async function abrirDialogo() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Nova oportunidade de expansão" }),
  );
  return screen.findByRole("dialog");
}

beforeEach(() => {
  h.get.mockReset();
  h.patch.mockReset();
  h.post.mockReset();
  h.sucesso.mockReset();
});
afterEach(cleanup);

/* ── relação ──────────────────────────────────────────────────────────────── */
describe("dossiê · relação entre oportunidades", () => {
  it("expansão: mostra de qual negócio nasceu, com link para ele", async () => {
    servidor(
      expansao({
        lead_status: "open",
        eligibility: { eligible: false, reason: "not_won" },
        can_create: false,
        destinations: [],
        origin: relacao({
          lead_id: ORIGEM,
          title: "Maria - Conta de luz",
          status: "won",
          product: ALFA,
        }),
      }),
    );
    renderizar();
    const origem = await screen.findByTestId("origem-comercial");
    expect(within(origem).getByText("Nasceu como expansão do negócio")).toBeInTheDocument();
    const link = within(origem).getByRole("link", { name: "Maria - Conta de luz" });
    expect(link).toHaveAttribute("href", `/app/leads/${ORIGEM}`);
    expect(within(origem).getByText("Ganho")).toBeInTheDocument();
    // negócio aberto não oferece criar expansão
    expect(screen.queryByRole("button", { name: "Nova oportunidade de expansão" })).toBeNull();
  });

  it("negócio ganho: lista as expansões com produto, funil, etapa e situação", async () => {
    servidor(
      expansao({
        expansions: [
          relacao(),
          relacao({
            lead_id: "e3333333-3333-4333-8333-333333333333",
            title: "Maria - Licença",
            status: "lost",
            product: VELHO,
            stage_name: "Perdido",
          }),
        ],
      }),
    );
    renderizar();
    const lista = await screen.findByTestId("expansoes");
    const itens = within(lista).getAllByTestId("relacao");
    expect(itens).toHaveLength(2);
    expect(within(itens[0]!).getByRole("link", { name: "Maria - Expansão" })).toHaveAttribute(
      "href",
      `/app/leads/${NOVA}`,
    );
    expect(itens[0]).toHaveTextContent("Produto Beta · Expansão · Novo");
    expect(within(itens[0]!).getByText("Aberto")).toBeInTheDocument();
    expect(within(itens[1]!).getByText("Perdido", { selector: "div" })).toBeInTheDocument();
    expect(within(itens[1]!).getByText("Produto inativo")).toBeInTheDocument();
  });

  it("oportunidade relacionada sem acesso aparece sem título", async () => {
    servidor(expansao({ expansions: [relacao({ visible: false, title: null, status: null })] }));
    renderizar();
    expect(await screen.findByTestId("relacao-invisivel")).toHaveTextContent(
      "Negócio relacionado sem acesso para você",
    );
  });

  it("sem relação e sem como criar, a seção não existe (aberto, viewer, falha de leitura)", async () => {
    servidor(
      expansao({
        lead_status: "open",
        eligibility: { eligible: false, reason: "not_won" },
        can_create: false,
      }),
    );
    const aberto = renderizar();
    await aberto.leituraTerminou();
    expect(screen.queryByTestId("expansao-comercial")).toBeNull();
    aberto.unmount();

    servidor(expansao({ can_create: false, destinations: [] }));
    const viewer = renderizar(false);
    await viewer.leituraTerminou();
    expect(screen.queryByTestId("expansao-comercial")).toBeNull();
    viewer.unmount();

    servidor(new Error("falhou"));
    const falha = renderizar();
    await falha.leituraTerminou();
    expect(screen.queryByTestId("expansao-comercial")).toBeNull();
  });

  it("ganho sem funil Green com etapa aberta: explica em vez de oferecer o botão", async () => {
    servidor(expansao({ can_create: false, destinations: [] }));
    renderizar();
    expect(await screen.findByTestId("sem-destino")).toHaveTextContent(
      "Nenhum funil Green com etapa aberta para receber a expansão.",
    );
    expect(screen.queryByRole("button", { name: "Nova oportunidade de expansão" })).toBeNull();
  });
});

/* ── criação ──────────────────────────────────────────────────────────────── */
describe("dossiê · nova oportunidade de expansão", () => {
  it("o formulário começa com o primeiro funil, a primeira etapa, o produto sugerido e o título", async () => {
    servidor(expansao());
    renderizar();
    const dialogo = await abrirDialogo();

    expect(within(dialogo).getByRole("combobox", { name: "Funil" })).toHaveValue(FUNIL_EXP);
    expect(within(dialogo).getByRole("combobox", { name: "Etapa" })).toHaveValue(ETAPA_NOVO);
    const produto = await within(dialogo).findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(produto).toHaveValue(ALFA.id));
    const opcoes = within(produto)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(opcoes).toEqual(["Selecione um produto", "Produto Alfa", "Produto Beta"]);
    expect(within(dialogo).getByLabelText("Título")).toHaveValue("Maria - Conta de luz");
    // não há campo de contato: a expansão reaproveita o contato do negócio ganho
    expect(within(dialogo).queryByLabelText(/contato/i)).toBeNull();
  });

  it("trocar o funil troca as etapas oferecidas e a etapa enviada", async () => {
    servidor(expansao());
    h.post.mockResolvedValue(criado());
    renderizar();
    const dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    await userEvent.selectOptions(
      within(dialogo).getByRole("combobox", { name: "Funil" }),
      FUNIL_CONEXAO,
    );
    const etapa = within(dialogo).getByRole("combobox", { name: "Etapa" });
    expect(etapa).toHaveValue(ETAPA_CONEXAO);
    expect(
      within(etapa)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Contato"]);
    // o <select> controlado MOSTRA a primeira opção mesmo com valor velho: só o corpo prova
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar oportunidade" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(h.post.mock.calls[0]![1]).toMatchObject({
      pipeline_id: FUNIL_CONEXAO,
      stage_id: ETAPA_CONEXAO,
    });
  });

  it("cria: fala SÓ com POST /expansion, com a chave do pedido, e avisa", async () => {
    servidor(expansao());
    h.post.mockResolvedValue(criado());
    renderizar();
    const dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    await userEvent.selectOptions(
      within(dialogo).getByRole("combobox", { name: "Produto" }),
      BETA.id,
    );
    await userEvent.selectOptions(
      within(dialogo).getByRole("combobox", { name: "Etapa" }),
      ETAPA_PROPOSTA,
    );
    const titulo = within(dialogo).getByLabelText("Título");
    await userEvent.clear(titulo);
    await userEvent.type(titulo, "Maria - Segunda unidade");
    await userEvent.type(within(dialogo).getByLabelText("Valor (opcional)"), "1.234,50");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar oportunidade" }));

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, corpo, opts] = h.post.mock.calls[0]!;
    expect(url).toBe(`/api/v1/leads/${LEAD}/expansion`);
    expect(corpo).toEqual({
      pipeline_id: FUNIL_EXP,
      stage_id: ETAPA_PROPOSTA,
      product_id: BETA.id,
      title: "Maria - Segunda unidade",
      value_cents: 123450,
    });
    expect(opts.idempotencyKey).toMatch(UUID);
    expect(h.sucesso).toHaveBeenCalledWith("Oportunidade de expansão criada.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // separação: nada de mover, clonar, ganhar/perder ou trocar o produto do negócio ganho
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("a expansão aberta que já existia é dita como tal", async () => {
    servidor(expansao());
    h.post.mockResolvedValue(criado(false));
    renderizar();
    const dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar oportunidade" }));
    await waitFor(() =>
      expect(h.sucesso).toHaveBeenCalledWith(
        "Já existe uma expansão aberta deste negócio com este produto.",
      ),
    );
  });

  it("reenviar no mesmo diálogo repete a chave; reabrir o diálogo gera outra", async () => {
    servidor(expansao());
    h.post.mockRejectedValueOnce(new Error("rede caiu")).mockResolvedValueOnce(criado());
    renderizar();
    let dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    const enviar = () =>
      userEvent.click(within(dialogo).getByRole("button", { name: "Criar oportunidade" }));
    await enviar();
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(dialogo).getByRole("button", { name: "Criar oportunidade" })).toBeEnabled(),
    );
    await enviar();
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    const [chave1, chave2] = h.post.mock.calls.map((c) => c[2].idempotencyKey);
    expect(chave2).toBe(chave1);

    h.post.mockResolvedValueOnce(criado(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    await enviar();
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(3));
    expect(h.post.mock.calls[2]![2].idempotencyKey).not.toBe(chave1);
  });

  it("valor inválido não envia; título curto desabilita o envio", async () => {
    servidor(expansao());
    renderizar();
    const dialogo = await abrirDialogo();
    await waitFor(() =>
      expect(within(dialogo).getByRole("combobox", { name: "Produto" })).toHaveValue(ALFA.id),
    );
    await userEvent.type(within(dialogo).getByLabelText("Valor (opcional)"), "abc");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar oportunidade" }));
    expect(await within(dialogo).findByText("Valor inválido")).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();

    const titulo = within(dialogo).getByLabelText("Título");
    await userEvent.clear(titulo);
    await userEvent.type(titulo, "x");
    expect(within(dialogo).getByRole("button", { name: "Criar oportunidade" })).toBeDisabled();
  });

  it("produto sugerido fora dos ativos não vem marcado: é preciso escolher", async () => {
    servidor(expansao({ suggested_product_id: null }));
    renderizar();
    const dialogo = await abrirDialogo();
    const produto = await within(dialogo).findByRole("combobox", { name: "Produto" });
    await waitFor(() => expect(within(produto).getAllByRole("option")).toHaveLength(3));
    expect(produto).toHaveValue("");
    expect(within(dialogo).getByRole("button", { name: "Criar oportunidade" })).toBeDisabled();
  });
});
