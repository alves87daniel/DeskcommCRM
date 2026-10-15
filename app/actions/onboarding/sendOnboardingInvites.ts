"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * Emite pela TRILHA CANÔNICA (`emitirConvite`, a mesma de
 * `POST /api/v1/team/invite`) — CG-IAM-01. Antes o assistente assinava o token
 * sozinho, sem linha em `team_invites`: o convite não aparecia na tela de
 * Equipe e não podia ser revogado, porque o aceite só reconhece a revogação
 * pela linha (`lib/auth/aplicar-convite.ts`). Agora cada convite é uma linha
 * cujo `id` é o `invite_id` do token, com `iat` e `invited_by` assinados.
 *
 * Só o administrador chega aqui (`requireOnboardingCtx`), então convidar
 * `admin` é ato de quem já administra — a mesma autoridade da rota da API.
 * Quem já tem vínculo ativo é pulado (`already_member`), como na rota: o aceite
 * não promoveria ninguém, mas o e-mail diria o contrário.
 *
 * Failures to send email do NOT block onboarding progression.
 */
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailsDeMembrosAtivos, emitirConvite } from "@/lib/team/convites";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

type PapelHumano = "viewer" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: nenhum transporte configurado) — o link
       * de aceite é devolvido para o admin enviar manualmente. */
      undelivered?: { email: string; accept_url: string }[];
      /** E-mails que já têm vínculo ativo na organização: não foram reconvidados. */
      already_member?: string[];
    }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "forbidden" | "mfa_required" | "invalid_input";
      details?: unknown;
    };

interface InvitePayload {
  // Convite é para PESSOA: só papel humano. `ai_operator` não entra aqui de
  // propósito — é papel de token de agente, ninguém o recebe por e-mail.
  invitations: { email: string; role: PapelHumano }[];
  skip?: boolean;
}

export async function sendOnboardingInvites(payload: InvitePayload): Promise<SendInvitesResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  if (payload.skip) {
    await patchOnboardingState(ctx.orgId, { team: { invites_sent: 0, skipped: true } });
    await audit({
      action: "onboarding.team_invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { skipped: true, count: 0 },
    });
    redirect("/onboarding");
  }

  let input;
  try {
    input = inviteOnboardingSchema.parse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  // Service role: a linha de `team_invites` e a lista de membros são lidas e
  // escritas ignorando a RLS, sempre filtradas pelo `orgId` da SESSÃO.
  const admin = createAdminClient();
  const requestId = randomUUID();
  const inviterName = ctx.fullName ?? ctx.email ?? "Um colega";
  const membros = await emailsDeMembrosAtivos(admin, ctx.orgId);

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  const alreadyMember: string[] = [];
  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();
    if (membros.has(email)) {
      alreadyMember.push(email);
      continue;
    }
    const emitido = await emitirConvite(admin, {
      organizationId: ctx.orgId,
      orgName: ctx.orgName,
      email,
      role: inv.role,
      inviterId: ctx.userId,
      inviterName,
      requestId,
      origem: "onboarding",
    });
    if (emitido.email_dispatched) sent += 1;
    else {
      failed += 1;
      undelivered.push({ email, accept_url: emitido.accept_url });
    }
  }

  await patchOnboardingState(ctx.orgId, {
    team: { invites_sent: sent + failed, skipped: false },
  });
  await audit({
    action: "onboarding.team_invited",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    metadata: { count: sent + failed, sent, failed, already_member: alreadyMember.length },
  });

  // Email falhou (ex.: VPS sem SMTP e sem Resend): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). O mesmo para quem já era membro: o admin
  // precisa saber que aquele e-mail não recebeu convite. Redirect só no caminho
  // 100% entregue.
  if (failed > 0 || alreadyMember.length > 0) {
    return {
      ok: true,
      sent,
      failed,
      ...(undelivered.length ? { undelivered } : {}),
      ...(alreadyMember.length ? { already_member: alreadyMember } : {}),
    };
  }

  redirect("/onboarding");
}
