// @vitest-environment node
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import loadConfig from "next/dist/server/config";
import { describe, expect, it } from "vitest";

// CG-SEC-01 (Segurança — Proteção das credenciais nos logs locais).
//
// O `next dev` 16.3 escreve no terminal cada chamada de server function COM OS
// ARGUMENTOS (`logging.serverFunctions`, padrão `true`, ativo só quando
// NODE_ENV=development). A action de login recebe a senha como argumento:
// onde a saída do `next dev` vai para arquivo, a credencial vira texto puro em
// disco.
//
// A pergunta é sobre a configuração EFETIVA, a que o `next dev` usa, e não
// sobre o texto do next.config.ts: por isso o teste carrega a configuração
// pelo carregador do próprio Next, na fase de desenvolvimento, com validação
// de schema, defaults e o embrulho do Sentry. O caminho
// `next/dist/server/config` é interno: se um bump do Next o mover, este teste
// quebra no import, e é exatamente a hora de reconferir se a opção ainda
// existe e ainda tem o mesmo padrão.
describe("next dev não registra os argumentos de server functions", () => {
  // O carregador transpila o next.config.ts e importa o Sentry: ~10 s medidos
  // a frio (primeira execução), perto demais dos 15 s padrão da suíte.
  it(
    "a configuração efetiva da fase de desenvolvimento desliga logging.serverFunctions",
    { timeout: 60_000 },
    async () => {
      const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, process.cwd());

      expect(config.logging).toMatchObject({ serverFunctions: false });
    },
  );
});
