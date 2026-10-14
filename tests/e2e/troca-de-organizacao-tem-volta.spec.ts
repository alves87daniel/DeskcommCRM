import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

/**
 * TROCAR DE ORGANIZAÇÃO TEM VOLTA — mesmo quando a organização de destino
 * ainda não foi configurada.
 *
 * ─── O defeito, e como ele apareceu ──────────────────────────────────────
 *
 * `app/app/layout.tsx` manda para `/onboarding` toda organização ativa sem
 * `onboarded_at`. Então trocar de organização pelo seletor do topo — um clique,
 * a ação mais banal do cabeçalho — podia levar ao wizard de seis passos da
 * organização nova **e tirar o seletor da tela junto**: o layout de `/app` sai
 * inteiro da árvore, e o `TenantSwitcher` mora nele.
 *
 * O que sobrava, medido no snapshot de uma falha do CI (run 33164258175):
 * "Termos de Uso", "Política de Privacidade" e um "Continuar" desabilitado.
 * Três controles, nenhuma saída. Quem foi convidado para uma organização nova e
 * trocou para ver o que era ficava sem caminho de volta — limpar cookie ou
 * adivinhar a URL de logout.
 *
 * O vermelho do CI era outro (dois seeds disputando o mesmo slug deixavam a org
 * B sem onboarding), e essa parte se conserta no harness. Esta spec prende o
 * que o vermelho EXPÔS, que é de produto e sobrevive ao conserto do seed.
 *
 * ─── Por que a organização do seed de funis ──────────────────────────────
 *
 * Depois da separação dos slugs, `e2e-segunda-org` é o único lugar do harness
 * com uma organização legitimamente **não configurada** — e é exatamente o
 * fixture de que este caso precisa. Está escrito lá, no `insert`, para ninguém
 * "consertar" a ausência do `onboarded_at` achando que é descuido.
 *
 * ─── Desde a CG-IAM-01 ───────────────────────────────────────────────────
 *
 * O assistente passou a ser só do administrador da organização, e o gate de
 * `/app` só manda o administrador para lá. O usuário do caso é `manager` na
 * organização não configurada, então o seletor nem sai da tela: a volta é pelo
 * próprio seletor. A propriedade — trocar de organização tem volta — é a mesma.
 */
const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  funis?: { segunda_org_id: string };
  duas_orgs?: { org_a_id: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  // A spec semeia a própria precondição: depender de `pipelines-gestao` ter
  // rodado antes seria depender da ORDEM, que é o defeito que esta suíte já
  // pagou mais de uma vez.
  if (!c.funis || !c.duas_orgs) {
    if (!c.duas_orgs) execFileSync("npx", ["tsx", "scripts/seed-e2e-duas-organizacoes.ts"], { stdio: "inherit" });
    if (!c.funis) execFileSync("npx", ["tsx", "scripts/seed-e2e-funis.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.funis?.segunda_org_id) throw new Error("o seed de funis não gravou `funis.segunda_org_id`");
  if (!c.duas_orgs?.org_a_id) throw new Error("o seed de duas orgs não gravou `duas_orgs.org_a_id`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test.describe.configure({ timeout: 150_000 });

test("trocar para uma organização não configurada mantém o colaborador no CRM — e dá para voltar", async ({ page }) => {
  const creds = lerCreds();
  const semOnboarding = creds.funis!.segunda_org_id;
  const orgA = creds.duas_orgs!.org_a_id;

  await entrar(page, creds);
  await page.goto("/app/inbox");

  // Ancora na org A e guarda o nome dela — é para cá que a volta tem de trazer.
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor).toBeVisible({ timeout: 20_000 });
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgA}`).click();
  await expect(seletor).toBeEnabled({ timeout: 60_000 });
  const nomeDaOrgA = (await seletor.textContent())!.trim();
  expect(nomeDaOrgA.length, "o seletor não anuncia o nome da organização ativa").toBeGreaterThan(0);

  // ── a troca que prendia ────────────────────────────────────────────────
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${semOnboarding}`).click();

  // CG-IAM-01: o assistente é do ADMINISTRADOR. Quem está aqui é `manager`
  // na organização sem `onboarded_at` (o vínculo do `seed-e2e-funis`), então o
  // destino correto é o próprio CRM — e o seletor continua na tela. Antes desta
  // entrega o gate mandava qualquer membro para o wizard, onde as ações agora
  // recusam quem não administra: ele ficaria preso numa tela sem botão que
  // funcione. A saída do wizard (`sair-do-onboarding`) segue valendo para o
  // administrador e tem cerca própria em `tests/unit/onboarding-tem-saida.test.tsx`.
  await expect(seletor).toBeEnabled({ timeout: 60_000 });
  await expect(
    seletor,
    `troquei para a organização ${semOnboarding} e o seletor seguiu em "${nomeDaOrgA}" — a troca não aconteceu`,
  ).not.toHaveText(nomeDaOrgA, { timeout: 20_000 });
  expect(
    page.url(),
    "o colaborador foi mandado para o assistente de uma organização que só o administrador configura",
  ).not.toMatch(/\/onboarding/);

  // ── e a volta CHEGA: a organização de antes, pelo mesmo seletor ────────
  await seletor.click();
  await page.getByTestId(`tenant-switcher-item-${orgA}`).click();
  await expect(seletor).toBeEnabled({ timeout: 60_000 });
  await expect(
    seletor,
    `a volta não trouxe para "${nomeDaOrgA}" — trocou de lugar, não desfez a troca`,
  ).toContainText(nomeDaOrgA, { timeout: 20_000 });

  await page.screenshot({ path: "evidence/onboarding/troca-de-org-tem-volta.png" });
});
