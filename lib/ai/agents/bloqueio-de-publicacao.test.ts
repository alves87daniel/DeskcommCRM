import { describe, expect, it } from "vitest";

import { bloqueioDePublicacao, type EntradaDoBloqueio } from "./bloqueio-de-publicacao";

/** Um agente pronto para publicar: credencial da organização validada, número no ar. */
function pronto(over: Partial<EntradaDoBloqueio> = {}): EntradaDoBloqueio {
  return {
    temRascunhoVigente: true,
    formularioValido: true,
    alteracoesNaoSalvas: false,
    provedor: "anthropic",
    chave: { estadoDaCredencialDaOrg: "validated" },
    numero: { estado: "WORKING" },
    ...over,
  };
}

describe("bloqueioDePublicacao", () => {
  it("não bloqueia quando tudo está no lugar", () => {
    expect(bloqueioDePublicacao(pronto())).toBeNull();
  });

  // ─── A chave é SEMPRE da organização (ADR-0005) ──────────────────────────
  //
  // A opção "a chave desta instalação" saiu da tela junto com a chave da
  // instalação. Sem uma linha de credencial da organização casando com a
  // escolha, o motivo é "sem chave" — não existe mais o caso em que o `.env`
  // responde por ela.
  it("sem credencial da organização escolhida, bloqueia com sem_chave", () => {
    expect(
      bloqueioDePublicacao(pronto({ chave: { estadoDaCredencialDaOrg: null } })),
    ).toEqual({ codigo: "sem_chave", provedor: "anthropic" });
  });

  it("a entrada não tem como dizer 'use a chave da instalação' — o tipo não aceita", () => {
    // @ts-expect-error — `daInstalacao` saiu com a ADR-0005; voltar é reprovado pelo compilador.
    const entrada: EntradaDoBloqueio = pronto({ chave: { daInstalacao: true, estadoDaCredencialDaOrg: null } });
    expect(entrada).toBeTruthy();
  });

  // ─── Número é requisito de ATENDER, não de rascunhar ─────────────────────
  it("bloqueia a publicação — e só ela — quando nenhum número foi escolhido", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: null } }))).toEqual({
      codigo: "sem_numero",
    });
  });

  it("bloqueia número que não está conectado, dizendo o estado", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: "SCAN_QR_CODE" } }))).toEqual({
      codigo: "numero_desconectado",
      estado: "SCAN_QR_CODE",
    });
  });

  it("aceita o estado do canal em minúsculas — é o mesmo estado", () => {
    expect(bloqueioDePublicacao(pronto({ numero: { estado: "working" } }))).toBeNull();
  });

  // ─── Credencial da organização ───────────────────────────────────────────
  it.each(["validating", "unvalidated", "invalid", "inactive"] as const)(
    "recusa credencial da org no estado %s",
    (estado) => {
      expect(
        bloqueioDePublicacao(pronto({ chave: { estadoDaCredencialDaOrg: estado } })),
      ).toEqual({ codigo: "chave_nao_utilizavel", provedor: "anthropic", estado });
    },
  );

  it("aceita credencial da org validada", () => {
    expect(
      bloqueioDePublicacao(pronto({ chave: { estadoDaCredencialDaOrg: "validated" } })),
    ).toBeNull();
  });

  // ─── Ordem: a dica do botão é UMA frase ─────────────────────────────────
  it("reporta o motivo de fora para dentro — rascunho antes de chave e número", () => {
    const tudoErrado = pronto({
      temRascunhoVigente: false,
      formularioValido: false,
      alteracoesNaoSalvas: true,
      chave: { estadoDaCredencialDaOrg: null },
      numero: { estado: null },
    });
    expect(bloqueioDePublicacao(tudoErrado)).toEqual({ codigo: "sem_rascunho" });
    expect(bloqueioDePublicacao({ ...tudoErrado, temRascunhoVigente: true })).toEqual({
      codigo: "formulario_invalido",
    });
    expect(
      bloqueioDePublicacao({
        ...tudoErrado,
        temRascunhoVigente: true,
        formularioValido: true,
      }),
    ).toEqual({ codigo: "alteracoes_nao_salvas" });
    expect(
      bloqueioDePublicacao({
        ...tudoErrado,
        temRascunhoVigente: true,
        formularioValido: true,
        alteracoesNaoSalvas: false,
      }),
    ).toEqual({ codigo: "sem_chave", provedor: "anthropic" });
  });
});
