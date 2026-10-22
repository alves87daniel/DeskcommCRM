/**
 * A organização TEM alguma chave de IA que conversa? — a pergunta das telas.
 *
 * É a pergunta que decide o aviso "IA desligada por falta de chave" na tela de
 * Credenciais e na Central (ADR-0005, D3: sem chave, o recurso fica desligado
 * para aquela organização, com aviso na tela). Conta só credencial ATIVA e
 * VALIDADA de provedor que conversa — a chave do Jev (que só decide) não atende
 * ninguém, e uma chave colada e ainda não conferida não sai para a rede.
 *
 * Recebe o client da SESSÃO (RLS escopa), e nunca lança: leitura que falha
 * responde `false`, e a tela avisa — o aviso a mais custa um clique; o aviso a
 * menos custa um dia de conversas sem resposta sem ninguém saber por quê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";

export async function temCredencialDeIaUtilizavel(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("ai_provider_credentials_safe")
      .select("provider")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null);
    if (error) return false;
    return ((data ?? []) as Array<{ provider: string }>).some((c) => ehProvedorSuportado(c.provider));
  } catch {
    return false;
  }
}
