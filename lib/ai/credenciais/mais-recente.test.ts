/**
 * TROCA DE CHAVE: a nova vale, a antiga não (ADR-0005, D2).
 *
 * O cenário que fazia quatro resolvedores errarem: a pessoa revoga a chave
 * antiga no provedor, cadastra a nova pela tela, e a antiga segue `is_active`
 * e validada no banco (ninguém a desativou). Quem pegava "a mais antiga" (voz,
 * embeddings), "sem ordem" (primeira publicação) ou "crescente" (prospecção)
 * continuava usando a revogada, enquanto o turno do agente já respondia pela
 * nova. Este arquivo prova o resolvedor único: ele PEDE a ordem decrescente e,
 * com a ordem aplicada, devolve a nova.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: ({ ciphertext }: { ciphertext: unknown }) => String(ciphertext),
}));

import { credencialMaisRecente } from "@/lib/ai/credenciais/mais-recente";

type Linha = Record<string, unknown>;

/**
 * Dublê do PostgREST que APLICA os filtros e a ordem pedidos — sem isso, um
 * resolvedor que ignorasse a ordem passaria igual, e o teste mediria o array
 * de fixture em vez do código.
 */
function admin(linhas: Linha[], opts: { erro?: boolean } = {}) {
  const pedidos: string[] = [];
  return {
    pedidos,
    client: {
      from: (tabela: string) => {
        pedidos.push(`from:${tabela}`);
        const filtros: Array<(l: Linha) => boolean> = [];
        const ordens: Array<{ coluna: string; ascending: boolean }> = [];
        const chain = {
          select: () => chain,
          eq: (c: string, v: unknown) => {
            filtros.push((l) => l[c] === v);
            pedidos.push(`eq:${c}=${String(v)}`);
            return chain;
          },
          not: (c: string, _op: string, v: unknown) => {
            filtros.push((l) => l[c] !== v);
            return chain;
          },
          order: (coluna: string, o: { ascending: boolean }) => {
            ordens.push({ coluna, ascending: o.ascending });
            pedidos.push(`order:${coluna}:${o.ascending ? "asc" : "desc"}`);
            return chain;
          },
          then: (ok: (r: { data: unknown; error: unknown }) => void) => {
            if (opts.erro) return ok({ data: null, error: { message: "falha" } });
            const achadas = linhas.filter((l) => filtros.every((f) => f(l)));
            achadas.sort((a, b) => {
              for (const o of ordens) {
                const x = String(a[o.coluna]);
                const y = String(b[o.coluna]);
                if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
              }
              return 0;
            });
            return ok({ data: achadas, error: null });
          },
        };
        return chain;
      },
    } as never,
  };
}

const ORG = "11111111-1111-4111-8111-111111111111";

function cred(over: Linha): Linha {
  return {
    id: "cred-a",
    organization_id: ORG,
    provider: "openai",
    label: "antiga",
    is_active: true,
    validated_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    api_key_encrypted: "chave-antiga",
    api_key_iv: "iv",
    api_key_tag: "tag",
    ...over,
  };
}

describe("credencialMaisRecente", () => {
  it("troca de chave: a nova vence, a antiga (ainda ativa e validada no banco) não é escolhida", async () => {
    const { client } = admin([
      cred({}),
      cred({ id: "cred-b", label: "nova", created_at: "2026-10-20T00:00:00Z", api_key_encrypted: "chave-nova" }),
    ]);
    const r = await credencialMaisRecente(client, ORG, "openai");
    expect(r).toMatchObject({ id: "cred-b", label: "nova", apiKey: "chave-nova", quantas: 2 });
  });

  it("pede ao banco a ordem decrescente por created_at e por id — nunca confia na ordem física", async () => {
    const { client, pedidos } = admin([cred({})]);
    await credencialMaisRecente(client, ORG, "openai");
    expect(pedidos).toContain("order:created_at:desc");
    expect(pedidos).toContain("order:id:desc");
  });

  it("duas chaves no mesmo instante: desempate pelo id, estável entre chamadas", async () => {
    const linhas = [
      cred({ id: "cred-a", api_key_encrypted: "a" }),
      cred({ id: "cred-z", api_key_encrypted: "z" }),
    ];
    const primeira = await credencialMaisRecente(admin(linhas).client, ORG, "openai");
    const segunda = await credencialMaisRecente(admin([...linhas].reverse()).client, ORG, "openai");
    expect(primeira?.id).toBe("cred-z");
    expect(segunda?.id).toBe("cred-z");
  });

  it("só ativa E validada, só desta organização, só deste provedor", async () => {
    const { client } = admin([
      cred({ id: "inativa", is_active: false, created_at: "2099-01-01T00:00:00Z" }),
      cred({ id: "nao-validada", validated_at: null, created_at: "2099-01-01T00:00:00Z" }),
      cred({ id: "de-outra-org", organization_id: "outra", created_at: "2099-01-01T00:00:00Z" }),
      cred({ id: "de-outro-provedor", provider: "anthropic", created_at: "2099-01-01T00:00:00Z" }),
      cred({ id: "a-certa", api_key_encrypted: "certa" }),
    ]);
    const r = await credencialMaisRecente(client, ORG, "openai");
    expect(r).toMatchObject({ id: "a-certa", apiKey: "certa", quantas: 1 });
  });

  it("sem credencial devolve null — e null é 'sem chave', nunca licença para outra chave", async () => {
    expect(await credencialMaisRecente(admin([]).client, ORG, "openai")).toBeNull();
  });

  it("leitura que falha devolve null, sem lançar", async () => {
    expect(await credencialMaisRecente(admin([cred({})], { erro: true }).client, ORG, "openai")).toBeNull();
  });
});
