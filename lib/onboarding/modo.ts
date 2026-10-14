/**
 * QUAL ASSISTENTE DE CONFIGURAÇÃO ESTA INSTALAÇÃO OFERECE (CG-IAM-01).
 *
 * `herdado` é o assistente de sempre: boas-vindas, WhatsApp, IA, funil, ensaio
 * do agente e equipe. `simplificado` é o primeiro acesso do licenciado: só o
 * negócio (nome e fuso), com a equipe como passo opcional — WhatsApp, IA e
 * funis ficam acessíveis depois, nas Configurações, e não travam o CRM.
 *
 * A escolha é da INSTALAÇÃO (`ONBOARDING_MODE` no `.env`), não da organização:
 * quem decide o pacote é quem opera a instalação. Ela só alcança organizações
 * ainda não configuradas — o gate de `/app` e o assistente leem `onboarded_at`,
 * que nenhuma das duas trilhas reescreve depois de carimbado.
 *
 * Nunca lança: o valor vem de arquivo escrito à mão, e `lib/env.ts` roda no
 * import do Next. Irreconhecível vale `herdado`, com um aviso no log.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export type ModoDoOnboarding = "herdado" | "simplificado";

let avisado = false;

export function interpretarModoDoOnboarding(bruto: string | undefined | null): ModoDoOnboarding {
  const valor = (bruto ?? "").trim().toLowerCase();
  if (valor === "simplificado") return "simplificado";
  if (valor !== "" && valor !== "herdado" && !avisado) {
    avisado = true;
    logger.warn(
      "assistente de configuração: ONBOARDING_MODE não é 'herdado' nem 'simplificado'; vale 'herdado'",
      { ONBOARDING_MODE: valor },
    );
  }
  return "herdado";
}

/** O modo em vigor nesta instalação. */
export function modoDoOnboarding(): ModoDoOnboarding {
  return interpretarModoDoOnboarding(env.ONBOARDING_MODE);
}
