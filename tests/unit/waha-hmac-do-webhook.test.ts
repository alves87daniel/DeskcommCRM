import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O WAHA NUNCA ASSINOU AS ENTREGAS DE WEBHOOK.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O compose entregava o segredo ao contêiner do WAHA em `WHATSAPP_HOOK_HMAC`.
 * Esse nome não existe na documentação do WAHA (events#hmac-authentication): o
 * certo é `WHATSAPP_HOOK_HMAC_KEY`. O WAHA ignorava a variável em silêncio e
 * mandava toda entrega sem `X-Webhook-Hmac` — medido no upstream, 3.692
 * entregas em 7 dias, nenhuma assinada (commit `12a413903`, #2268).
 *
 * Nada aparecia errado: com `WAHA_WEBHOOK_REQUIRE_SIGNATURE` desligado o app
 * aceita evento sem assinatura. O sintoma só vinha ao ligar a exigência, que
 * cortava toda a entrada de mensagens com `401 signature_required` — então a
 * verificação forte era inutilizável e a única defesa do webhook global ficava
 * sendo o bloqueio no proxy (issue #40, triagem #39).
 *
 * ─── O que este teste segura ────────────────────────────────────────────────
 *
 * Que o serviço `waha` de cada compose entregue `WAHA_HMAC_SECRET` no nome que
 * o WAHA lê, e que o nome antigo não volte por cópia de um bloco velho.
 */

const COMPOSES = ["docker-compose.prod.yml", "docker-compose.yml", "docker-compose.local.yml"];

/** As linhas do serviço `waha`, do cabeçalho até o próximo serviço. */
function blocoDoWaha(yaml: string): string[] {
  const linhas = yaml.split("\n");
  const inicio = linhas.findIndex((l) => /^ {2}waha:\s*$/.test(l));
  if (inicio === -1) return [];
  const fim = linhas.findIndex((l, i) => i > inicio && /^\S|^ {2}\S/.test(l));
  return linhas.slice(inicio + 1, fim === -1 ? undefined : fim);
}

/** Só as linhas que valem como YAML — comentário não configura nada. */
function semComentarios(linhas: string[]): string[] {
  return linhas.filter((l) => !/^\s*#/.test(l));
}

describe("o segredo do webhook chega ao WAHA no nome que ele lê", () => {
  it.each(COMPOSES)("%s tem um serviço waha com environment", (arquivo) => {
    // Guarda do instrumento: sem o bloco, as asserções abaixo passariam vazias.
    const bloco = blocoDoWaha(readFileSync(arquivo, "utf8"));
    expect(bloco.length).toBeGreaterThan(0);
    expect(bloco.some((l) => /^\s+environment:\s*$/.test(l))).toBe(true);
  });

  it.each(COMPOSES)("%s entrega WAHA_HMAC_SECRET em WHATSAPP_HOOK_HMAC_KEY", (arquivo) => {
    const linhas = semComentarios(blocoDoWaha(readFileSync(arquivo, "utf8")));
    expect(linhas.map((l) => l.trim())).toContain("WHATSAPP_HOOK_HMAC_KEY: ${WAHA_HMAC_SECRET}");
  });

  it.each(COMPOSES)("%s não usa o nome antigo WHATSAPP_HOOK_HMAC", (arquivo) => {
    const linhas = semComentarios(blocoDoWaha(readFileSync(arquivo, "utf8")));
    expect(linhas.filter((l) => /^\s*WHATSAPP_HOOK_HMAC\s*:/.test(l))).toEqual([]);
  });
});
