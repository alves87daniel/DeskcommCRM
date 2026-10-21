import { randomUUID } from "node:crypto";
import type pg from "pg";

import { encryptKey } from "@/lib/crypto/aes_gcm";

/**
 * A credencial de IA da organização de teste — a ÚNICA chave que o resolvedor
 * aceita desde a ADR-0005 (`lib/agent-engine/edge/llm/credentials.ts` não lê
 * mais `ANTHROPIC_API_KEY` nem `OPENAI_API_KEY` do ambiente). O registro falso
 * do provedor substitui a CHAMADA ao modelo, não a exigência de haver uma
 * credencial ativa e validada DA organização.
 *
 * Cifrada de verdade, com a `AI_CRED_AES_KEY` de teste de `vitest.db.config.ts`.
 * Idempotente por (organização, provedor, rótulo): chamar duas vezes para a
 * mesma organização devolve a mesma linha, reativada e validada.
 */
export async function cadastrarCredencialDeTeste(
  pool: pg.Pool,
  organizationId: string,
  provider = "anthropic",
): Promise<string> {
  const cifrada = encryptKey("chave-de-teste-nunca-enviada");
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_provider_credentials
       (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, is_active, validated_at)
     values ($1, $2, $3, 'credencial de teste', $4, $5, $6, $7, true, now())
     on conflict (organization_id, provider, label) do update
       set is_active = true, validated_at = now()
     returning id`,
    [randomUUID(), organizationId, provider, cifrada.ciphertext, cifrada.iv, cifrada.tag, cifrada.last4],
  );
  return rows[0]!.id;
}
