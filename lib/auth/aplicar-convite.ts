import { cookies } from "next/headers";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvitePayload } from "@/lib/auth/invite-token";

/**
 * O ATO de virar membro: grava o vínculo, audita e escolhe a organização ativa.
 *
 * Existe separado porque tem DOIS chamadores legítimos, e antes só havia um:
 *
 * - `app/actions/team/acceptInvite.ts` — quem já tinha conta e clicou no botão;
 * - `app/auth/confirm/route.ts` — quem acabou de confirmar o e-mail por um
 *   convite. Esse caminho conhecia o convite, tinha a sessão firmada e o e-mail
 *   provado pelo provedor de auth, e mesmo assim só redirecionava para uma tela
 *   com um botão. O vínculo é o que dá menu e organização; sem ele a pessoa
 *   entra num CRM vazio, e essa foi a experiência medida de dois convidados
 *   reais.
 *
 * A VALIDADE DO TOKEN não se decide aqui — quem decide é quem chama, e os dois
 * chamam `verifyInviteToken` antes (o segundo por dentro de
 * `decidirConviteDoSignup`, que ainda confere o e-mail contra o que o provedor
 * confirmou).
 *
 * A LINHA DE `team_invites` (migration 0238), sim, é tratada aqui — e precisa
 * ser, nos dois sentidos:
 *
 * - **Revogação.** Um convite cancelado na tela de Equipe mantém assinatura e
 *   validade boas no token; o que diz que ele morreu é a linha. Deixar essa
 *   checagem no botão de aceite (onde ela nasceu, no PR #664) daria acesso a
 *   um convite revogado a quem chegasse pelo OUTRO caminho — confirmar o
 *   e-mail —, que é justamente o caminho de quem ainda não tem conta, ou seja,
 *   o caso comum.
 * - **Fechamento.** Sem gravar `accepted_at`, o convite de quem entrou pelo
 *   e-mail fica listado como **Pendente para sempre** na aba Membros, e o
 *   administrador reenvia ou revoga um convite que já foi aceito.
 *
 * Convite sem linha (emitido antes desta migration, ou instalação cujo envio
 * não tinha service-role) segue o fluxo: a checagem de revogação de MEMBERSHIP
 * dentro de `fn_accept_team_invite` continua valendo.
 */

export type ResultadoDoConvite =
  | { ok: true; membershipId: string; mudou: boolean }
  | { ok: false; motivo: "invalid_or_expired" | "internal_error" };

export async function aplicarConvite(params: {
  userId: string;
  payload: InvitePayload;
  requestId?: string | null;
}): Promise<ResultadoDoConvite> {
  const { userId, payload, requestId } = params;

  const admin = createAdminClient();
  const recusa = { ok: false, motivo: "invalid_or_expired" } as const;
  const falha = { ok: false, motivo: "internal_error" } as const;
  /** O que o log precisa para alguém consertar à mão. Nunca o token. */
  const identidade = {
    invite_id: payload.invite_id,
    organization_id: payload.organization_id,
    user_id: userId,
    request_id: requestId ?? null,
  };

  type Linha = {
    revoked_at: string | null;
    accepted_at: string | null;
    accepted_by: string | null;
  };
  // `error` é falha de banco, e falha de banco NÃO é "convite sem linha".
  // Tratar as duas igual mandava um convite revogado pelo fluxo legado, que
  // não consulta a linha, bastando a leitura falhar.
  const lerLinha = async (): Promise<{ linha: Linha | null; erro: boolean }> => {
    const { data, error } = await admin
      .from("team_invites")
      .select("revoked_at, accepted_at, accepted_by")
      .eq("id", payload.invite_id)
      .eq("organization_id", payload.organization_id)
      .maybeSingle();
    if (error) {
      logger.error("convite: falha ao ler a linha do convite", { ...identidade, code: error.code });
      return { linha: null, erro: true };
    }
    return { linha: (data as Linha | null) ?? null, erro: false };
  };
  /** Revogado, ou aceito por outra pessoa: o convite não serve a quem chegou agora. */
  const naoServe = (l: Linha) =>
    Boolean(l.revoked_at) || (Boolean(l.accepted_at) && l.accepted_by !== userId);

  // Convite REVOGADO na tela de Equipe. Sem linha, segue — ver o cabeçalho.
  const leitura = await lerLinha();
  if (leitura.erro) return falha;
  const linhaDoConvite = leitura.linha;
  if (linhaDoConvite && naoServe(linhaDoConvite)) return recusa;

  // POSSE ANTES DO VÍNCULO (CG-IAM-01). Ler, vincular e só depois fechar a linha
  // deixava uma revogação gravada no meio virar acesso — com a tela de Equipe
  // dizendo "revogado". Agora o aceite marca a linha primeiro, e só onde ela
  // ainda está em aberto; a revogação, do lado dela, só escreve onde
  // `accepted_at` é nulo. Uma das duas ganha, nunca as duas.
  //
  // O vínculo só nasce com a posse CONFIRMADA (linha devolvida pelo UPDATE) ou
  // com a posse já desta pessoa (replay). Erro de banco aqui não é "perdeu a
  // linha": é não saber — e não saber não vira acesso.
  let reivindicou = false;
  if (linhaDoConvite && !linhaDoConvite.accepted_at) {
    const { data: ganhou, error: erroDaPosse } = await admin
      .from("team_invites")
      .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
      .eq("id", payload.invite_id)
      .eq("organization_id", payload.organization_id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (erroDaPosse) {
      logger.error("convite: falha ao reivindicar a posse do convite", {
        ...identidade,
        code: erroDaPosse.code,
      });
      return falha;
    }
    if (ganhou) reivindicou = true;
    else {
      // Perdeu a linha: revogada no meio, ou o mesmo aceite chegou duas vezes
      // (clique duplo). Só o segundo caso segue — e segue como replay.
      const agora = await lerLinha();
      if (agora.erro) return falha;
      if (!agora.linha || naoServe(agora.linha)) return recusa;
    }
  }

  // Org, papel e convidador vêm EXCLUSIVAMENTE do token assinado; o usuário,
  // de quem chamou. Nada aqui vem de body de requisição.
  const { data: resultado, error } = await admin.rpc("fn_accept_team_invite", {
    p_interface_settings: payload.interface_settings ?? { preset: "completa" },
    p_user: userId,
    p_org: payload.organization_id,
    p_role: payload.role,
    p_invited_by: payload.invited_by ?? null,
    p_issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    p_invited_at: new Date((payload.iat ?? payload.exp - 86400) * 1000).toISOString(),
  });

  if (error) {
    // O vínculo não nasceu: a posse volta, senão a linha diria "aceito" para
    // quem não entrou — e o administrador não teria mais como revogar nem
    // reenviar. Só desfaz o que este aceite marcou.
    //
    // A devolução não é atômica com a posse (duas escritas, sem transação), então
    // ela só vale se o banco DEVOLVER a linha desfeita. Erro, ou nenhuma linha
    // casando, é estado incerto: a linha pode seguir "aceita" por quem não
    // entrou. Isso não pode virar a recusa mansa de 42501 — é falha, com log do
    // que o operador precisa para consertar.
    if (reivindicou) {
      const { data: devolvida, error: erroDaDevolucao } = await admin
        .from("team_invites")
        .update({ accepted_at: null, accepted_by: null })
        .eq("id", payload.invite_id)
        .eq("organization_id", payload.organization_id)
        .eq("accepted_by", userId)
        .select("id")
        .maybeSingle();
      if (erroDaDevolucao || !devolvida) {
        logger.error("convite: posse reivindicada sem vínculo e a devolução não se confirmou", {
          ...identidade,
          vinculo_code: error.code,
          devolucao_code: erroDaDevolucao?.code ?? null,
          devolucao_casou: Boolean(devolvida),
        });
        return falha;
      }
    }
    return {
      ok: false,
      // 42501 é a recusa da própria função (convite revogado ou posterior à
      // revogação) — não é falha de infraestrutura e não merece 500.
      motivo: error.code === "42501" ? "invalid_or_expired" : "internal_error",
    };
  }

  if (resultado.changed) {
    await audit({
      action: "member.accepted",
      actorUserId: userId,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: resultado.id,
      metadata: { invite_id: payload.invite_id, role: payload.role },
      requestId: requestId ?? null,
    });
  }

  // O convite já foi fechado na aba Membros ANTES do vínculo (a posse, acima);
  // o replay do mesmo token não mexe na linha.

  // Sem isto a pessoa entra sem organização escolhida e o app não sabe qual
  // mostrar — o mesmo motivo pelo qual o botão de aceite sempre gravou aqui.
  (await cookies()).set("active_org", payload.organization_id, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return { ok: true, membershipId: resultado.id as string, mudou: Boolean(resultado.changed) };
}
