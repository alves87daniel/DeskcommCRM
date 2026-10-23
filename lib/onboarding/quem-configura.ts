/**
 * QUEM CONFIGURA A ORGANIZAÇÃO PELO ASSISTENTE (CG-IAM-01).
 *
 * Uma regra só, lida em três lugares que não podem discordar: a guarda das
 * ações (`app/actions/onboarding/_shared.ts`), o gate de `/app`, que decide
 * quem é mandado para o assistente, e o layout de `/onboarding`, que devolve ao
 * CRM quem não o administra. Se o gate mandasse para o assistente alguém que a
 * guarda recusa, a pessoa ficaria presa numa tela onde nenhum botão funciona;
 * se o layout deixasse entrar quem a guarda recusa, cada botão seria um erro.
 *
 * O papel vem da organização ATIVA já validada contra os vínculos vivos da
 * sessão (`resolveActiveOrg`), nunca de entrada de quem chama. Acompanhamento
 * de suporte chega aqui com o papel que `fn_user_role_in_org` lhe dá (`admin`
 * no modo completo, `viewer` no somente leitura).
 */
export function configuraPeloAssistente(role: string | null | undefined): boolean {
  return role === "admin";
}
