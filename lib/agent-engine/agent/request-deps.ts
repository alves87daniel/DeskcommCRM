import { previewFixtureRegistry } from './preview-fixture';
import { loadEnv } from '../env';
import { crmEdgeConfigFromEnv } from '../edge/crm/mcp-client';
import { llmEdgeConfigFromEnv } from '../edge/llm/run-model-call';
import { createLogger } from '../obs/logger';
import { urlDoSupabaseNoServidor } from '@/lib/supabase/url-do-servidor';
import { turnKnobsFromEnv } from './turn-knobs';
import type { InboundTurnDeps } from './inbound-turn';
export function requestTurnDeps(): InboundTurnDeps {
  const env = loadEnv();
  const fixture = process.env.INTERNAL_AGENT_RUN_STUB === 'true';
  // O dublê troca SÓ o provedor (registry): a credencial da organização continua
  // sendo exigida pelo resolvedor, como em produção (ADR-0005). Quem roda o
  // dublê cadastra uma credencial de mentira na organização de teste
  // (`scripts/bootstrap-owner.ts` faz isso sob INTERNAL_AGENT_RUN_STUB).
  const llmCfg = llmEdgeConfigFromEnv(env);
  return {
    ...(fixture
      ? {
          registry: previewFixtureRegistry(),
          embed: async () => ({
            embedding: Array(1536).fill(0.1),
            promptTokens: 0,
            model: 'text-embedding-3-small',
          }),
        }
      : {}),
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: urlDoSupabaseNoServidor(
        env.SUPABASE_SERVER_URL,
        env.NEXT_PUBLIC_SUPABASE_URL,
      ),
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    llmCfg,
    knobs: turnKnobsFromEnv(env),
    log: createLogger(),
  };
}
