/**
 * ESCOLHER OPENROUTER NO INSTALADOR NÃO PODE SER UMA PERGUNTA DECORATIVA.
 *
 * O `install.sh` passou a oferecer OpenRouter como PRIMEIRA opção de "qual IA
 * vai atender". A partir daí, cada lugar que só conhece anthropic/openai vira
 * um buraco na instalação que aceitou o convite — e os buracos são mudos, que é
 * o que os torna caros:
 *
 *  - (histórico) `resolveOrgLlmConfig` não tinha ramo de fallback de env para
 *    openrouter. O ramo entrou e SAIU de novo: a ADR-0005 apagou todo degrau de
 *    chave do ambiente, e quem guarda isso é
 *    `lib/agent-engine/edge/llm/credentials.test.ts` e a cerca
 *    `tests/unit/ia-sem-chave-da-plataforma.test.ts`.
 *  - `modelCapabilities('openrouter', 'openai/gpt-4o')` devolvia
 *    `{image:false}`, porque a capacidade era do PROVEDOR e num roteador ela é
 *    do MODELO. O comprovante do cliente virava marcador e o aviso afirmava "o
 *    modelo openai/gpt-4o não enxerga imagens" — falso, e gravado para o
 *    operador ler.
 *  - `lib/env.ts` avisava no boot que a IA ia ficar muda por falta de chave —
 *    numa instalação em que ela não ia ficar.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  capacidadeEhConhecida,
  modelCapabilities,
} from "@/lib/agent-engine/edge/llm/capabilities";

describe("capacidade num roteador é do MODELO, não do provedor", () => {
  it("o instrumento distingue os providers conhecidos (controle positivo)", () => {
    expect(modelCapabilities("anthropic", "claude-sonnet-4-6").image).toBe(true);
    expect(modelCapabilities("provedor-que-nao-existe", "qualquer").image).toBe(false);
  });

  it("openrouter + modelo de fabricante com visão enxerga imagem", () => {
    expect(
      modelCapabilities("openrouter", "openai/gpt-4o").image,
      "o comprovante do cliente virava marcador, e o aviso afirmava que o gpt-4o não enxerga imagens",
    ).toBe(true);
    expect(modelCapabilities("openrouter", "anthropic/claude-sonnet-4-6").image).toBe(true);
  });

  it("openrouter + fabricante desconhecido continua conservador", () => {
    // Conservador é o desfecho certo aqui: mandar imagem para um modelo que não
    // a aceita quebra o turno inteiro. O que muda é o que se DIZ sobre isso.
    expect(modelCapabilities("openrouter", "fabricante-x/modelo-y").image).toBe(false);
  });

  it("'não sei' é distinguível de 'não consegue'", () => {
    // Sem esta distinção, o aviso ao operador afirma uma limitação que ninguém
    // verificou — e ele vai trocar de modelo por causa de uma frase inventada.
    expect(capacidadeEhConhecida("openrouter", "openai/gpt-4o")).toBe(true);
    expect(capacidadeEhConhecida("openrouter", "fabricante-x/modelo-y")).toBe(false);
    expect(capacidadeEhConhecida("anthropic", "claude-sonnet-4-6")).toBe(true);
  });

  it("embedding/tts continuam rebaixados mesmo num fabricante capaz", () => {
    expect(modelCapabilities("openrouter", "openai/text-embedding-3-small").image).toBe(false);
  });
});

// O aviso de boot sobre chave de IA no `.env` saiu com a ADR-0005: a chave é
// credencial da organização, e o boot não tem o que avisar.

describe("o worker de mídia obedece ao painel", () => {
  it("lê o binding de visao_de_imagem antes de resolver o modelo", () => {
    // O ponto é editável na tela (sem `fixo`, fora dos governados pelo agente
    // publicado). Enquanto o worker resolvia só pela config da org, a tela
    // aceitava a escolha, dizia "salvo", gravava a linha — e a descrição de
    // imagem seguia no modelo padrão. É a classe de defeito que o próprio
    // `gateway-binding.ts` declara ter vindo matar.
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    expect(fonte).toMatch(/lerBindingDoPonto\(\s*admin,\s*row\.organization_id,\s*"visao_de_imagem"\s*\)/);
    expect(fonte).toContain("ai_purpose_bindings");
  });

  // A chave da OpenRouter não é mais passada ao seam pelo `.env` (ADR-0005): o
  // seam a lê da credencial da organização, e a cerca
  // `tests/unit/ia-sem-chave-da-plataforma.test.ts` reprova a volta.
});

describe("o instalador grava o provedor escolhido no banco", () => {
  it("o install.sh atualiza settings.llm.provider quando não é anthropic", () => {
    // `fn_seed_org_llm_defaults` semeia 'anthropic' fixo. Sem esta atualização,
    // a pergunta "qual IA vai atender" não muda nada para o agent-engine.
    const fonte = readFileSync("hostgator-setup-kit/install.sh", "utf8");
    expect(fonte).toMatch(/jsonb_set\(\s*\n?\s*coalesce\(settings, '\{\}'::jsonb\), '\{llm,provider\}'/);
    expect(fonte).toContain("${AI_PROVIDER}");
  });

  it("o bootstrap-owner faz o mesmo (é o caminho do e2e e da doc)", () => {
    const fonte = readFileSync("scripts/bootstrap-owner.ts", "utf8");
    expect(fonte).toContain("aplicarProvedorEscolhido");
    expect(fonte).toMatch(/process\.env\.AI_PROVIDER/);
  });

  it("e os dois gravam o MODELO do provedor escolhido, não só o provedor", () => {
    // Trocar só o provider deixava `{openai, claude-sonnet-5}`: o gatilho semeia
    // o par da Anthropic, e o id dela ia à OpenAI. A escolha em si é provada em
    // `lib/ai/agents/escolher-modelo.test.ts`; aqui, que os dois a usam.
    const bootstrap = readFileSync("scripts/bootstrap-owner.ts", "utf8");
    expect(bootstrap).toMatch(/escolherModeloNoCatalogo\(admin, escolhido\)/);
    expect(bootstrap).toMatch(/default_model: modelo/);
    const instalador = readFileSync("hostgator-setup-kit/install.sh", "utf8");
    expect(instalador).toMatch(/'\{llm,default_model\}'/);
  });
});
