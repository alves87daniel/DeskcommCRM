"use server";

/**
 * Server Action: finalize onboarding — stamps `onboarded_at`, audits, and
 * emits the `tenant.onboarded` domain event. Idempotent: only fires the
 * event the first time `onboarded_at` flips from NULL.
 */
import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { modoDoOnboarding } from "@/lib/onboarding/modo";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOnboardingCtx, OnboardingError } from "./_shared";

export type FinishOnboardingResult =
  | { ok: true; alreadyOnboarded: boolean }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "db_error";
      details?: unknown;
    };

export async function finishOnboarding(): Promise<FinishOnboardingResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const admin = createAdminClient();
  // `onboarded_at` significa o mesmo nos dois modos — o administrador concluiu
  // a configuração inicial (CG-IAM-01). Não afirma canal, IA nem estrutura
  // Green; quem lê o rastro sabe pelo `modo` qual percurso foi feito.
  const modo = modoDoOnboarding();

  const { data: existing } = await admin
    .from("organizations")
    .select("onboarded_at")
    .eq("id", ctx.orgId)
    .maybeSingle();

  const alreadyOnboarded = Boolean(existing?.onboarded_at);

  if (!alreadyOnboarded) {
    const { error } = await admin
      .from("organizations")
      .update({ onboarded_at: new Date().toISOString() })
      .eq("id", ctx.orgId)
      .is("onboarded_at", null);
    if (error) return { ok: false, error: "db_error", details: error.message };

    await admin.from("event_log").insert({
      organization_id: ctx.orgId,
      event_type: "tenant.onboarded",
      // NOT NULL sem default — ver `tests/unit/evento-de-publicacao-tem-dono.test.ts`.
      entity_kind: "organization",
      payload: { completed_by: ctx.userId },
    });

    await audit({
      action: "onboarding.completed",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { modo },
    });
    await audit({
      action: "tenant.onboarded",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
    });
  }

  // No simplificado não há WhatsApp configurado: a caixa de conversas estaria
  // vazia. `/app` entrega a home da interface de quem chegou.
  redirect(modo === "simplificado" ? "/app" : "/app/inbox");
}
