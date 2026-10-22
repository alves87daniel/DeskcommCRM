/**
 * A CREDENCIAL DO DUBLÊ PARA UMA ORGANIZAÇÃO QUE A SPEC CRIOU.
 *
 * Desde a ADR-0005 a única chave que o resolvedor aceita é a credencial ativa
 * e validada DA organização — o `.env.e2e` não traz chave nenhuma, e o dublê
 * (`INTERNAL_AGENT_RUN_STUB=true`) substitui a chamada ao provedor, não a
 * exigência de haver credencial. Uma spec que cria a própria organização e
 * passa por um ponto de IA (testar o agente, sugerir resposta) precisa, então,
 * de uma credencial nela — senão o produto responde, corretamente, "esta
 * organização não tem chave de IA".
 *
 * Em vez de cifrar aqui (o processo do Playwright não tem a `AI_CRED_AES_KEY`
 * do servidor), COPIA a linha que `scripts/seed-e2e-credentials.ts` cadastrou
 * na organização semeada: o ciframento é da chave do servidor, e o servidor é
 * quem decifra — a cópia vale para qualquer organização.
 */
import * as fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

const ROTULO_DO_DUBLE = "Dublê do provedor controlado";

export async function clonarCredencialDoDuble(db: SupabaseClient, orgId: string): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as { org_id?: string };
  if (!creds.org_id) throw new Error("`.e2e-creds.json` sem org_id — rode `pnpm seed:e2e` antes");

  const { data: origem, error } = await db
    .from("ai_provider_credentials")
    .select("provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4")
    .eq("organization_id", creds.org_id)
    .eq("label", ROTULO_DO_DUBLE)
    .maybeSingle();
  if (error) throw new Error(`ler a credencial do dublê: ${error.message}`);
  if (!origem) {
    throw new Error(
      "a organização semeada não tem a credencial do dublê — o seed roda com INTERNAL_AGENT_RUN_STUB=true e AI_CRED_AES_KEY",
    );
  }

  const { error: erroAoCopiar } = await db.from("ai_provider_credentials").insert({
    ...origem,
    organization_id: orgId,
    is_active: true,
    validated_at: new Date().toISOString(),
  });
  if (erroAoCopiar) throw new Error(`copiar a credencial do dublê: ${erroAoCopiar.message}`);
}
