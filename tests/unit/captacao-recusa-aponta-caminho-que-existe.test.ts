import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import { MOTIVO_DA_RECUSA_LABEL } from "@/lib/webhooks/captacao";

/**
 * A recusa `assinatura_indecifravel` diz ao operador como voltar a receber
 * leads (issue #37). A tela de fontes não regrava o segredo de uma fonte que já
 * existe, então mandar "cadastrar a assinatura de novo" apontaria para um botão
 * que não existe. O caminho que existe hoje é criar uma fonte nova, trocar o
 * endereço no formulário e excluir a antiga.
 *
 * Este teste prende o texto a esse caminho: cada degrau citado na mensagem
 * precisa existir na navegação ou na tela de webhooks. Se um rótulo mudar, ou
 * se a mensagem voltar a prometer algo que a tela não faz, fica vermelho.
 */
const RAIZ = process.cwd();
const ler = (rel: string) => readFileSync(path.join(RAIZ, rel), "utf8");

const mensagem = MOTIVO_DA_RECUSA_LABEL.assinatura_indecifravel;

describe("a recusa por segredo ilegível aponta um caminho que existe", () => {
  it("cita Webhooks › Receber dados, e o item Webhooks está na navegação", () => {
    expect(mensagem).toContain("Webhooks › Receber dados");
    expect(NAV_CATALOG.some((item) => item.href === "/app/webhooks" && item.label === "Webhooks")).toBe(true);
  });

  it("a aba Receber dados, o botão Nova fonte e o Excluir fonte existem na tela", () => {
    expect(ler("app/app/webhooks/_components/WebhooksClient.tsx")).toContain('t("Receber dados")');
    expect(ler("app/app/webhooks/_components/SourcesTab.tsx")).toContain('t("Nova fonte")');
    expect(ler("app/app/webhooks/_components/SourceDetail.tsx")).toContain('t("Excluir fonte")');
    expect(mensagem).toMatch(/Crie uma fonte nova/);
    expect(mensagem).toMatch(/exclua esta fonte/);
  });

  it("não promete regravar a assinatura pela tela", () => {
    expect(mensagem).not.toMatch(/cadastre a assinatura|recadastre/i);
  });
});
