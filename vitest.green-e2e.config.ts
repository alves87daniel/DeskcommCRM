import { defineConfig } from "vitest/config";
import path from "node:path";

// SPIKE Green v2 (descartável) — E2E PostgREST REAL: rotas e seams de verdade,
// HTTP de verdade até o Kong/PostgREST de um Supabase LOCAL, trigger e
// event_log de verdade. Fora de `pnpm test:unit` e de `pnpm test:db`: só roda
// com o stack local de pé e as três variáveis abaixo exportadas a partir de
// `supabase status -o json` (nada de credencial no Git; ver o cabeçalho de
// tests/green-e2e/postgrest-real.e2e.ts). Sem elas, a suíte se declara pulada.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/green-e2e/**/*.e2e.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.GREEN_E2E_SUPABASE_URL ?? "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.GREEN_E2E_ANON_KEY ?? "e2e-sem-stack",
      SUPABASE_SERVICE_ROLE_KEY: process.env.GREEN_E2E_SERVICE_ROLE_KEY ?? "e2e-sem-stack",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(
        __dirname,
        "node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
});
