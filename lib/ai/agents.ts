/**
 * Busca o ai_agent configurado como agente de VOZ pra uma org
 * (ai_agents.channel = 'voice', coluna aditiva da migration 0347).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_CONFIG_DEFAULTS, agentConfigSchema } from "@/lib/ai/guardrails-schema";
import { credencialMaisRecente } from "@/lib/ai/credenciais/mais-recente";

export interface VoiceAgentConfig {
  id: string;
  systemPrompt: string;
  /** Voz e velocidade da fala (session.audio.output) e parâmetros de RAG —
   *  configuráveis por Configurações > Agente > aba Voz, com fallback pros
   *  defaults quando a organização nunca mexeu nisso. */
  voice: string;
  voiceSpeed: number;
  ragTopK: number;
  ragSimilarityThreshold: number;
  voiceModel: string;
  /**
   * Chave da OpenAI pra abrir a sessão Realtime (WebSocket cru, não passa
   * pelo AI Gateway). Vem SÓ da credencial cadastrada em IA > Credenciais pra
   * esta org (ADR-0005: não existe chave da instalação). `null` = a org não
   * tem credencial OpenAI ativa e validada, e a ligação NÃO abre
   * (`workers/voice-agent/index.ts` avisa e encerra).
   */
  apiKey: string | null;
}

/**
 * A chave OpenAI ativa e validada desta org, cadastrada em IA > Credenciais —
 * a MAIS RECENTE, pelo resolvedor único (`credencialMaisRecente`, ADR-0005 D2).
 *
 * Era "a mais antiga", e caía na chave do `.env` quando não havia nenhuma. Os
 * dois degraus saíram: a antiga revogada no provedor seguia sendo escolhida
 * depois de uma troca de chave, e o `.env` fazia a conta de outra pessoa pagar
 * a sessão Realtime desta organização.
 */
async function resolverChaveOpenAiDaVoz(organizationId: string): Promise<string | null> {
  const credencial = await credencialMaisRecente(createAdminClient(), organizationId, "openai");
  return credencial?.apiKey ?? null;
}

export async function getActiveVoiceAgent(organizationId: string): Promise<VoiceAgentConfig | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select("id, system_prompt, config")
    .eq("organization_id", organizationId)
    .eq("channel", "voice")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const cfgParsed = agentConfigSchema.safeParse({
    ...AGENT_CONFIG_DEFAULTS,
    ...((data.config ?? {}) as Record<string, unknown>),
  });
  const cfg = cfgParsed.success ? cfgParsed.data : AGENT_CONFIG_DEFAULTS;

  return {
    id: data.id,
    systemPrompt: data.system_prompt,
    voice: cfg.voice,
    voiceSpeed: cfg.voice_speed,
    voiceModel: cfg.voice_model,
    ragTopK: cfg.rag_top_k,
    ragSimilarityThreshold: cfg.rag_similarity_threshold,
    apiKey: await resolverChaveOpenAiDaVoz(organizationId),
  };
}
