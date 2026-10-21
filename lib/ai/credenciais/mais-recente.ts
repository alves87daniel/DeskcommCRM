/**
 * A CREDENCIAL MAIS RECENTE DA ORGANIZAÇÃO — o resolvedor único dos caminhos
 * que falam Supabase (ADR-0005, decisão D2).
 *
 * Sem binding do ponto, TODO resolvedor do produto escolhe a mesma linha: a
 * credencial ativa e validada mais recente do provedor, da organização. Antes
 * desta função quatro caminhos escolhiam diferente — o agente de voz e os
 * embeddings pegavam a MAIS ANTIGA, a prospecção ordenava da mais antiga para a
 * mais nova, a primeira publicação pegava uma qualquer. O defeito aparecia na
 * troca de chave: a pessoa revoga a chave antiga no provedor, cadastra a nova
 * pela tela, e um desses caminhos seguia usando a revogada (ainda `is_active`
 * e validada no banco) enquanto o turno do agente já respondia pela nova.
 *
 * `order by created_at desc, id desc` — a MESMA ordem de `resolveOrgLlmConfig`
 * (`lib/agent-engine/edge/llm/credentials.ts`), que fala `pg` e por isso não
 * importa daqui. O desempate pelo `id` existe para duas credenciais criadas no
 * mesmo instante não alternarem entre chamadas.
 *
 * Nunca lança: leitura que falha devolve `null`, como todo leitor de
 * credencial deste repositório — e o chamador trata `null` como "sem chave",
 * nunca como licença para cair em outra chave (ADR-0005, D3).
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

export interface CredencialMaisRecente {
  id: string;
  provider: string;
  label: string;
  /** Plaintext. Vive só no escopo de quem chamou — nunca logado nem persistido. */
  apiKey: string;
  /** Quantas ativas e validadas o provedor tem — a tela avisa quando há mais de uma. */
  quantas: number;
}

interface LinhaDeCredencial {
  id: string;
  label: string | null;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
}

export async function credencialMaisRecente(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  provider: string,
): Promise<CredencialMaisRecente | null> {
  try {
    // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data, error } = await admin
      .from("ai_provider_credentials")
      .select("id, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", provider)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (error) return null;
    const linhas = (data ?? []) as LinhaDeCredencial[];
    const primeira = linhas[0];
    if (!primeira) return null;
    return {
      id: primeira.id,
      provider,
      label: primeira.label ?? "",
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(primeira.api_key_encrypted),
        iv: byteaToBuffer(primeira.api_key_iv),
        tag: byteaToBuffer(primeira.api_key_tag),
      }),
      quantas: linhas.length,
    };
  } catch {
    // Sem detalhe no log: qualquer eco aqui corre o risco de carregar material
    // da credencial.
    return null;
  }
}
