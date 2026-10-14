import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { proximoPasso } from "@/lib/onboarding/passos";
import { configuraPeloAssistente } from "@/lib/onboarding/quem-configura";
import { modoDoOnboarding } from "@/lib/onboarding/modo";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * O roteador do wizard. A ORDEM não mora mais aqui: mora em
 * `lib/onboarding/passos.ts`, junto com os rótulos e o resumo final — eram três
 * listas independentes que discordavam, e a divergência aparecia como um passo
 * "Loja" fantasma no indicador de toda instalação pelo kit.
 */
export default async function OnboardingIndex() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Sem organização o onboarding não tem o que mostrar — mas mandar para
  // `/login` fechava o círculo: quem entrasse de novo voltaria para cá. A saída
  // é a tela que CRIA a organização que falta.
  if (!activeOrg) redirect("/get-started");
  // Mesma regra do layout (CG-IAM-01): layout e página renderizam em paralelo.
  if (!configuraPeloAssistente(activeOrg.role)) redirect("/app");

  const { state, onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) redirect("/app/inbox");

  const passo = proximoPasso(state, {
    lojaLigada: env.NUVEMSHOP_ENABLED,
    modo: modoDoOnboarding(),
  });
  redirect(passo ? `/onboarding/${passo.segmento}` : "/onboarding/done");
}
