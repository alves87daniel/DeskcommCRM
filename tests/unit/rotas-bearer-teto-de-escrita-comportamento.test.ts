import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TETO DE ESCRITA, medido pelo comportamento (issue #38, item 5 da triagem #36).
 *
 * A irmã `rotas-bearer-aplicam-teto-de-escrita.test.ts` varre o código-fonte.
 * Esta chama o POST de cada rota com um token cuja cota acabou e confere a
 * resposta: 429 com `Retry-After`, o balde certo consultado e nenhum efeito
 * (nem cliente admin, nem a função de domínio). O helper `tetoDeEscritaDoToken`
 * roda DE VERDADE; só o contador (`checkRateLimit`) é dublê, para o teste
 * decidir quando a cota acabou.
 *
 * Sem o teto na rota, o contador nunca é consultado e o POST segue para o
 * efeito: o caso fica vermelho.
 */

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONV = "aaaaaaaa-1111-4000-8000-000000000001";
const TOKEN_ID = "aaaaaaaa-2222-4000-8000-000000000002";

const via = { atual: "token" as "token" | "session" };

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("a rota tocou o banco antes do teto");
  }),
}));
vi.mock("@/lib/inbox/rascunho-sugerido", () => ({ consumirRascunho: vi.fn() }));
vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: vi.fn(),
}));
vi.mock("@/lib/api/auth-dual", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api/auth-dual")>();
  return {
    ...real,
    resolveAuthDual: vi.fn(async () => ({
      ok: true,
      organizationId: ORG,
      actor: { type: "user", id: TOKEN_ID },
      supabase: new Proxy(
        {},
        {
          get() {
            throw new Error("a rota tocou o banco antes do teto");
          },
        },
      ),
      idioma: "pt-BR",
      via: via.atual,
      apiTokenId: TOKEN_ID,
    })),
  };
});

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { consumirRascunho } from "@/lib/inbox/rascunho-sugerido";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { POST as consumirPost } from "@/app/api/v1/conversations/[id]/drafts/consume/route";
import { POST as abrirPost } from "@/app/api/v1/conversations/open-with-contact/route";
import { POST as midiaPost } from "@/app/api/v1/conversations/[id]/media/route";
import { POST as midiaDaNotaPost } from "@/app/api/v1/conversations/[id]/notes/media/route";

const contexto = { params: Promise.resolve({ id: CONV }) };

function req(caminho: string): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method: "POST",
    headers: { authorization: "Bearer dsk_teste", "content-type": "application/json" },
    body: JSON.stringify({ draft_id: CONV, contact_id: CONV }),
  });
}

const ROTAS = [
  {
    nome: "drafts/consume",
    recurso: "drafts.consume",
    chamar: () => consumirPost(req(`/api/v1/conversations/${CONV}/drafts/consume`), contexto),
  },
  {
    nome: "open-with-contact",
    recurso: "conversations.open",
    chamar: () => abrirPost(req("/api/v1/conversations/open-with-contact")),
  },
  {
    nome: "conversations/[id]/media",
    recurso: "conversation_media",
    chamar: () => midiaPost(req(`/api/v1/conversations/${CONV}/media`), contexto),
  },
  {
    nome: "conversations/[id]/notes/media",
    recurso: "conversation_notes",
    chamar: () => midiaDaNotaPost(req(`/api/v1/conversations/${CONV}/notes/media`), contexto),
  },
] as const;

function nenhumEfeito() {
  expect(createAdminClient).not.toHaveBeenCalled();
  expect(consumirRascunho).not.toHaveBeenCalled();
  expect(openSharedContactConversation).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  via.atual = "token";
});

describe("rotas Bearer recusam com 429 quando a cota do token acaba", () => {
  it.each(ROTAS)("$nome: teto por token esgotado", async ({ recurso, chamar }) => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const resposta = await chamar();

    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBeTruthy();
    expect(checkRateLimit).toHaveBeenCalledWith(`${recurso}:tok:${TOKEN_ID}`, expect.any(Number), expect.any(Number));
    nenhumEfeito();
  });

  it.each(ROTAS)("$nome: teto da organização esgotado", async ({ recurso, chamar }) => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true } as never)
      .mockResolvedValueOnce({ allowed: false } as never);

    const resposta = await chamar();

    expect(resposta.status).toBe(429);
    expect(checkRateLimit).toHaveBeenLastCalledWith(`${recurso}:org:${ORG}`, expect.any(Number), expect.any(Number));
    nenhumEfeito();
  });
});

describe("controle: pela sessão o teto não é consultado", () => {
  it.each(ROTAS)("$nome: sessão não gasta cota", async ({ chamar }) => {
    via.atual = "session";
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    // A rota segue para o efeito e esbarra no dublê do banco; o que se mede
    // aqui é só que o contador não foi tocado.
    const resposta = await chamar().catch(() => null);

    expect(resposta?.status).not.toBe(429);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
