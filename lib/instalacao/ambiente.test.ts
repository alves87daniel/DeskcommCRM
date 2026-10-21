/**
 * O que a instalação já trouxe — e o que o produto NÃO pode fingir que sabe.
 *
 * Este leitor existe para o onboarding parar de perguntar o que o instalador já
 * perguntou. Errar para o lado otimista aqui é caro: dizer "chave configurada"
 * quando não há chave produz a frase mais perigosa do produto — a que tranquiliza
 * enquanto o funcionário está mudo.
 *
 * Desde a ADR-0005 ele não responde NADA sobre chave de IA: a chave é credencial
 * da organização, no banco, e um leitor síncrono do `.env` não tem como
 * responder por ela. Os casos sobre `chavesDeProvedor`/`gateway` saíram junto
 * com os campos.
 */
import { describe, expect, it } from "vitest";

import {
  lerAmbiente,
  nomeAindaEhPlaceholder,
  NOME_PLACEHOLDER_DA_INSTALACAO,
} from "@/lib/instalacao/ambiente";

describe("lerAmbiente", () => {
  it("não responde sobre chave de IA — nem quando o .env tem uma (ADR-0005)", () => {
    const a = lerAmbiente({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-proj-x",
      OPENROUTER_API_KEY: "sk-or-x",
      AI_GATEWAY_API_KEY: "gw-x",
    });
    // A forma do retrato é fechada: campo novo sobre chave de IA aqui seria a
    // volta da "chave da instalação" por outro nome.
    expect(Object.keys(a).sort()).toEqual(["email", "transporteDeWhatsapp"]);
    expect(JSON.stringify(a)).not.toMatch(/sk-|gw-x|API_KEY/);
  });

  it("ambiente vazio não inventa nada", () => {
    const a = lerAmbiente({});
    expect(a.email).toBe(false);
    expect(a.transporteDeWhatsapp).toEqual({ apontado: false, comChave: false });
  });

  // O caso do placeholder mudou de arquivo: ele precisa nomear as VARIÁVEIS do
  // transporte, e esse nome só pode viver dentro de `lib/channels/` — ver
  // `lib/channels/transporte.test.ts`.

  it("e-mail configurado é o que decide se o convite sai de verdade", () => {
    // Falso em toda instalação pelo kit hoje: o `install.sh` não coleta essa
    // chave. É por isso que o passo de convites precisa tratar o link manual
    // como caminho NORMAL, e não como exceção.
    expect(lerAmbiente({}).email).toBe(false);
    expect(lerAmbiente({ RESEND_API_KEY: "re_x" }).email).toBe(true);
    // O outro transporte conta igual: quem preencheu só o SMTP tem e-mail, e
    // ler apenas a chave do serviço externo o chamaria de não configurado.
    expect(lerAmbiente({ SMTP_HOST: "smtp.revenda.com.br" }).email).toBe(true);
  });

  it("variável VAZIA é ausente — é o contrato do .env do projeto", () => {
    expect(lerAmbiente({ RESEND_API_KEY: "   " }).email).toBe(false);
  });
});

describe("nomeAindaEhPlaceholder", () => {
  it("reconhece a organização que o instalador batizou", () => {
    // O `install.sh` nunca pergunta o nome do negócio: toda instalação nasce
    // "Minha Empresa", e esse texto aparece no cabeçalho do wizard.
    expect(nomeAindaEhPlaceholder({ slug: "minha-empresa", display_name: "Qualquer" })).toBe(true);
    expect(nomeAindaEhPlaceholder({ slug: "outro", display_name: NOME_PLACEHOLDER_DA_INSTALACAO })).toBe(
      true,
    );
  });

  it("não acusa quem já deu um nome ao negócio", () => {
    expect(nomeAindaEhPlaceholder({ slug: "clinica-vida", display_name: "Clínica Vida" })).toBe(
      false,
    );
    expect(nomeAindaEhPlaceholder({ slug: null, display_name: null })).toBe(false);
  });
});
