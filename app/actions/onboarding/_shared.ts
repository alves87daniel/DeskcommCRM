/**
 * Shared helpers for onboarding Server Actions: resolve auth + active org +
 * admin client (we use service-role here because we do narrow targeted
 * UPDATEs scoped explicitly by `organization_id` resolved from the validated
 * session — no body-derived ids ever).
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { configuraPeloAssistente } from "@/lib/onboarding/quem-configura";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OnboardingState } from "@/lib/schemas/onboarding";

export class OnboardingError extends Error {
  constructor(
    public readonly code:
      | "auth_required"
      | "no_active_org"
      | "forbidden"
      | "mfa_required"
      | "not_found"
      | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingCtx {
  userId: string;
  orgId: string;
  orgName: string;
  role: string;
  fullName: string | null;
  email: string;
}

/**
 * A guarda de TODA ação do assistente: sessão, acompanhamento, organização
 * ativa e, desde a CG-IAM-01, o PAPEL.
 *
 * Cada ação do assistente tem efeito sobre a organização inteira (nome, funil,
 * agente, chave de IA, convites, conclusão). Até aqui qualquer membro de uma
 * organização sem `onboarded_at` chegava a elas — inclusive `viewer`, e
 * inclusive para emitir convite de `admin`. Agora só passa o administrador da
 * organização ATIVA (`configuraPeloAssistente`), e com a mesma régua de MFA de
 * `requireRole("admin")`: quem tem fator cadastrado prova o fator na sessão.
 *
 * A recusa acontece antes de qualquer cliente service role: quem é barrado não
 * lê nem escreve nada da organização.
 */
export async function requireOnboardingCtx(): Promise<OnboardingCtx> {
  const user = await loadAuthUser();
  if (!user) throw new OnboardingError("auth_required", "Auth required.");
  if (supportWriteError(user.support)) throw new OnboardingError("forbidden", "Acompanhamento somente leitura ou encerrado.");
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) throw new OnboardingError("no_active_org", "Sem organização ativa.");
  if (!configuraPeloAssistente(activeOrg.role)) {
    throw new OnboardingError("forbidden", "Só o administrador da organização configura o assistente.");
  }
  if (await mfaEmDivida()) {
    throw new OnboardingError("mfa_required", "Confirme a verificação em duas etapas.");
  }
  return {
    userId: user.id,
    orgId: activeOrg.orgId,
    orgName: activeOrg.name,
    role: activeOrg.role,
    fullName: user.full_name,
    email: user.email,
  };
}

/**
 * A recusa da guarda dita para quem está na tela. "Sua sessão expirou" para
 * quem só não é administrador mandaria a pessoa entrar de novo e bater no
 * mesmo muro.
 */
export function mensagemDaRecusa(err: OnboardingError): string {
  switch (err.code) {
    case "forbidden":
      return "Só o administrador da organização pode configurar isto.";
    case "mfa_required":
      return "Confirme a verificação em duas etapas e tente de novo.";
    default:
      return "Sua sessão expirou. Entre de novo.";
  }
}

export async function loadOnboardingState(orgId: string): Promise<{
  state: OnboardingState;
  onboardedAt: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("onboarding_state, onboarded_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new OnboardingError("db_error", error.message);
  if (!data) throw new OnboardingError("not_found", "Organização não encontrada.");
  return {
    state: (data.onboarding_state as OnboardingState | null) ?? {},
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function patchOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
  extra?: { display_name?: string; timezone?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { state } = await loadOnboardingState(orgId);
  const merged: OnboardingState = { ...state, ...patch };
  const update: Record<string, unknown> = { onboarding_state: merged };
  if (extra?.display_name) update.display_name = extra.display_name;
  if (extra?.timezone) update.timezone = extra.timezone;
  const { error } = await admin.from("organizations").update(update).eq("id", orgId);
  if (error) throw new OnboardingError("db_error", error.message);
}
