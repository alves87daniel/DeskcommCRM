/**
 * PUBLICAR EXIGE A CREDENCIAL DA ORGANIZAÇÃO — no servidor e no banco (ADR-0005).
 *
 * `publishAgentVersion` aceitava versão sem `credential_id` quando a instalação
 * tinha a chave no `.env` (`chaveDePlataforma`) e avisava o Postgres com
 * `p_platform_credential_verified: true`. Os dois lados mudaram: o wrapper
 * recusa antes da ida ao banco, e a função SQL (migration 0511) ignora a flag.
 * O banco é medido por `pnpm test:db`; aqui, o wrapper e o espelho da migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { publishAgentVersion } from "@/lib/ai/agents/publish";

const RAIZ = process.cwd();

function admin(version: { provider: string; credential_id: string | null } | null) {
  const rpc = vi.fn(async (_nome: string, _args: Record<string, unknown>) => ({
    data: [{ agent_id: "a", version_id: "v", previous_version_id: null, published_at: "2026-10-21T00:00:00Z" }],
    error: null,
  }));
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: version, error: null }),
  };
  return { client: { from: () => chain, rpc } as never, rpc };
}

describe("publishAgentVersion", () => {
  it("versão sem credencial da organização: credential_missing, sem ir ao banco", async () => {
    const { client, rpc } = admin({ provider: "anthropic", credential_id: null });
    const r = await publishAgentVersion(client, { orgId: "o", agentId: "a", versionId: "v" });
    expect(r).toEqual({ ok: false, code: "credential_missing", message: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("com credencial, publica — e NUNCA afirma ao banco que a instalação tem chave", async () => {
    const { client, rpc } = admin({ provider: "anthropic", credential_id: "cred-1" });
    const r = await publishAgentVersion(client, { orgId: "o", agentId: "a", versionId: "v", expectedProvenance: "onboarding" });
    expect(r.ok).toBe(true);
    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(args.p_platform_credential_verified).not.toBe(true);
  });
});

describe("a migration 0511 e o apêndice do baseline", () => {
  const migration = readFileSync(join(RAIZ, "supabase/migrations/20261021120000_0511_ia_sem_chave_da_plataforma.sql"), "utf8");
  const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
  const manifest = readFileSync(join(RAIZ, "supabase/migrations/MANIFEST.md"), "utf8");

  it("a função recusa credential_id nulo sem olhar a flag", () => {
    expect(migration).toMatch(/if v_version\.credential_id is null then\s+raise exception 'credential_missing'/);
    expect(migration).not.toMatch(/credential_id is null and p_platform_credential_verified is not true/);
  });

  it("a última definição do baseline é a mesma — e a tripla está completa", () => {
    const ultima = baseline.lastIndexOf("create or replace function public.fn_publish_ai_agent_version(\n  p_org_id uuid,");
    const trecho = baseline.slice(ultima, baseline.indexOf("$$;", ultima));
    expect(trecho).toMatch(/if v_version\.credential_id is null then\s+raise exception 'credential_missing'/);
    expect(trecho).not.toMatch(/p_platform_credential_verified is not true/);
    expect(baseline).toContain("(migration 0511");
    expect(manifest).toMatch(/0511_ia_sem_chave_da_plataforma/);
  });

  it("o vocabulário da passagem ganhou 'ia_sem_chave' nos dois lados", () => {
    expect(migration).toMatch(/'ia_sem_chave'/);
    expect(baseline.slice(baseline.lastIndexOf("passagens_de_atendimento_motivo_codigo_check"))).toMatch(/'ia_sem_chave'/);
  });
});
