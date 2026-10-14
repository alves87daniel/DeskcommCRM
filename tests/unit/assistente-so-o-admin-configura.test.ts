/**
 * O ASSISTENTE DE CONFIGURAÇÃO É DO ADMINISTRADOR DA ORGANIZAÇÃO (CG-IAM-01).
 *
 * ## O defeito
 *
 * Toda ação de `app/actions/onboarding/` passava por `requireOnboardingCtx`, que
 * só conferia sessão, acompanhamento e organização ativa — nunca o PAPEL. Como o
 * gate de `/app` manda para o assistente QUALQUER membro de organização sem
 * `onboarded_at`, um `viewer` dessa organização podia renomear a empresa,
 * trocar o funil, criar o agente, concluir a configuração e — o pior —
 * emitir convite de `admin` (`sendOnboardingInvites` aceitava `role: "admin"`).
 * `dadosDoPasso`, num módulo `"use server"`, recebia o `orgId` de quem chamava.
 *
 * ## O que este arquivo mede
 *
 * A matriz inteira de quem NÃO pode, ação por ação, e a prova de que a recusa
 * chega antes de qualquer efeito: nenhuma leitura ou escrita pelo service role,
 * nenhuma auditoria, nenhum e-mail, nenhuma chave guardada. E o par de
 * vacuidade: o administrador continua configurando.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/assistente-so-o-admin-configura.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
/** A organização de outro cliente, que nenhum argumento pode alcançar. */
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";

interface Operacao {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  filtros: Record<string, unknown>;
  payload?: unknown;
}

let operacoes: Operacao[] = [];
let rpcs: { fn: string; args: unknown }[] = [];

function clienteFalso() {
  const from = (table: string) => {
    const c: Operacao = { table, op: "select", filtros: {} };
    operacoes.push(c);
    const responder = () =>
      Promise.resolve(
        table === "organizations" && c.op === "select"
          ? { data: { onboarding_state: {}, onboarded_at: null, display_name: "QA" }, error: null }
          : { data: null, error: null },
      );
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "neq", "not", "in", "gte", "lte", "or"]) {
      b[m] = () => b;
    }
    b.insert = (p: unknown) => ((c.op = "insert"), (c.payload = p), b);
    b.update = (p: unknown) => ((c.op = "update"), (c.payload = p), b);
    b.upsert = (p: unknown) => ((c.op = "upsert"), (c.payload = p), b);
    b.delete = () => ((c.op = "delete"), b);
    b.eq = (k: string, v: unknown) => ((c.filtros[k] = v), b);
    b.is = (k: string, v: unknown) => ((c.filtros[`is:${k}`] = v), b);
    b.single = responder;
    b.maybeSingle = responder;
    b.then = (ok: (r: unknown) => unknown, no?: (e: unknown) => unknown) =>
      responder().then(ok, no);
    return b;
  };
  return {
    from,
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return { data: { ok: true }, error: null };
    }),
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: null }, error: null })) } },
  };
}

type Suporte = {
  id: string;
  organization_id: string;
  actor_user_id: string;
  auth_session_id: string;
  previous_organization_id: string | null;
  expires_at: string;
  name: string;
  locale: string | null;
  access_mode: "full" | "support_readonly";
  status: "active" | "expired" | "revoked";
};

/** Quem está do outro lado da sessão, em cada cenário. */
let sessao: {
  user: {
    id: string;
    email: string;
    full_name: string;
    support: Suporte | null;
    organizations: unknown[];
  } | null;
  org: { orgId: string; name: string; role: string } | null;
  mfaPendente: boolean;
};

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => sessao.user),
  resolveActiveOrg: vi.fn(async () => sessao.org),
  mfaEmDivida: vi.fn(async () => sessao.mfaPendente),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => clienteFalso()) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => clienteFalso()) }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, via: "smtp" })),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Central de Teste", logoUrl: null, hex: "#000000" })),
}));
vi.mock("@/lib/ai/credenciais/guardar", () => ({
  guardarCredencial: vi.fn(async () => ({ ok: true, id: "cred-1", last4: "7193" })),
}));

import { audit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/roteador";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { salvarChaveDaIa } from "@/app/actions/onboarding/chaveDaIa";
import { createDefaultAgent, skipAi } from "@/app/actions/onboarding/createDefaultAgent";
import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";
import { marcarTesteFeito, pularTeste } from "@/app/actions/onboarding/marcarTeste";
import { aplicarQuadro, dadosDoPasso, pularQuadro } from "@/app/actions/onboarding/montarQuadro";
import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";
import {
  markNuvemshopConfigured,
  markWhatsappConfigured,
  skipNuvemshop,
  skipWhatsapp,
} from "@/app/actions/onboarding/skipWhatsapp";

function formulario(campos: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

/** Cada ação do assistente, chamada como o navegador (ou um atacante) a chamaria. */
const ACOES: Record<string, () => Promise<unknown>> = {
  acceptWelcome: () =>
    acceptWelcome(formulario({ display_name: "Empresa Tomada", timezone: "America/Sao_Paulo" })),
  skipWhatsapp: () => skipWhatsapp(),
  markWhatsappConfigured: () => markWhatsappConfigured("org_sessao", "WORKING"),
  skipNuvemshop: () => skipNuvemshop(),
  markNuvemshopConfigured: () => markNuvemshopConfigured(),
  createDefaultAgent: () => createDefaultAgent(formulario({ name: "Atendente IA" })),
  skipAi: () => skipAi(),
  aplicarQuadro: () =>
    aplicarQuadro(
      formulario({
        quadro: JSON.stringify({ nome: "Vendas", etapas: [{ nome: "Novo" }, { nome: "Ganho" }] }),
      }),
    ),
  pularQuadro: () => pularQuadro(),
  marcarTesteFeito: () => marcarTesteFeito(true),
  pularTeste: () => pularTeste(),
  // O escalonamento: quem não administra tentando emitir convite de administrador.
  sendOnboardingInvites: () =>
    sendOnboardingInvites({ invitations: [{ email: "comparsa@example.com", role: "admin" }] }),
  sendOnboardingInvitesPular: () => sendOnboardingInvites({ invitations: [], skip: true }),
  finishOnboarding: () => finishOnboarding(),
  salvarChaveDaIa: () =>
    salvarChaveDaIa(formulario({ provider: "anthropic", api_key: "sk-ant-1234567890" })),
  // A forma antiga da chamada — `orgId` primeiro — é a que um atacante mandaria.
  dadosDoPasso: () =>
    (dadosDoPasso as unknown as (a: string, b: string) => Promise<unknown>)(OUTRA_ORG, "Negócio"),
};

type Desfecho =
  | { tipo: "retorno"; valor: unknown }
  | { tipo: "lancou"; erro: Error }
  | { tipo: "redirect"; destino: string };

async function executar(acao: () => Promise<unknown>): Promise<Desfecho> {
  try {
    return { tipo: "retorno", valor: await acao() };
  } catch (e) {
    const erro = e as Error;
    const m = /^REDIRECT:(.*)$/.exec(erro.message ?? "");
    return m ? { tipo: "redirect", destino: m[1]! } : { tipo: "lancou", erro };
  }
}

function recusou(d: Desfecho): boolean {
  if (d.tipo === "lancou") return d.erro.name === "OnboardingError";
  if (d.tipo === "retorno") return (d.valor as { ok?: boolean } | undefined)?.ok === false;
  return false;
}

const suporte = (access_mode: Suporte["access_mode"], status: Suporte["status"]): Suporte => ({
  id: "44444444-4444-4444-8444-444444444444",
  organization_id: ORG,
  actor_user_id: USER,
  auth_session_id: "55555555-5555-4555-8555-555555555555",
  previous_organization_id: null,
  expires_at: "2099-01-01T00:00:00Z",
  name: "QA",
  locale: null,
  access_mode,
  status,
});

const usuario = (support: Suporte | null = null) => ({
  id: USER,
  email: "pessoa@example.com",
  full_name: "Pessoa",
  support,
  organizations: [{ organization_id: ORG, organization_name: "QA", role: "viewer" }],
});

/** Os cenários em que NINGUÉM pode configurar a organização pelo assistente. */
const CENARIOS_RECUSADOS: Record<string, () => typeof sessao> = {
  "sem sessão": () => ({ user: null, org: null, mfaPendente: false }),
  // Vínculo revogado não aparece em `user_organizations` lido com `revoked_at is null`:
  // a pessoa autentica e fica sem organização ativa.
  "vínculo inativo": () => ({
    user: { ...usuario(), organizations: [] },
    org: null,
    mfaPendente: false,
  }),
  viewer: () => ({
    user: usuario(),
    org: { orgId: ORG, name: "QA", role: "viewer" },
    mfaPendente: false,
  }),
  agent: () => ({
    user: usuario(),
    org: { orgId: ORG, name: "QA", role: "agent" },
    mfaPendente: false,
  }),
  manager: () => ({
    user: usuario(),
    org: { orgId: ORG, name: "QA", role: "manager" },
    mfaPendente: false,
  }),
  "suporte somente leitura": () => ({
    user: usuario(suporte("support_readonly", "active")),
    org: { orgId: ORG, name: "QA", role: "viewer" },
    mfaPendente: false,
  }),
  "suporte encerrado": () => ({
    user: usuario(suporte("full", "expired")),
    org: { orgId: ORG, name: "QA", role: "admin" },
    mfaPendente: false,
  }),
  // Admin com fator cadastrado e sessão `aal1`: a mesma régua de `requireRole("admin")`.
  "admin sem provar a verificação em duas etapas": () => ({
    user: usuario(),
    org: { orgId: ORG, name: "QA", role: "admin" },
    mfaPendente: true,
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  operacoes = [];
  rpcs = [];
});

describe("só o administrador da organização configura pelo assistente", () => {
  for (const [cenario, montar] of Object.entries(CENARIOS_RECUSADOS)) {
    describe(cenario, () => {
      for (const [nome, acao] of Object.entries(ACOES)) {
        it(`${nome}: recusa antes de qualquer efeito`, async () => {
          sessao = montar();
          const d = await executar(acao);

          expect(recusou(d), `${nome} não recusou (${cenario}): ${JSON.stringify(d)}`).toBe(true);
          expect(
            operacoes,
            `${nome} tocou o banco pelo service role antes de recusar (${cenario})`,
          ).toEqual([]);
          expect(rpcs, `${nome} chamou função do banco antes de recusar (${cenario})`).toEqual([]);
          expect(vi.mocked(audit)).not.toHaveBeenCalled();
          expect(vi.mocked(sendEmail), "um convite saiu por e-mail").not.toHaveBeenCalled();
          expect(
            vi.mocked(guardarCredencial),
            "uma chave de IA foi guardada",
          ).not.toHaveBeenCalled();
        });
      }
    });
  }
});

describe("o administrador segue configurando — o par de vacuidade", () => {
  const admin = () => ({
    user: usuario(),
    org: { orgId: ORG, name: "QA", role: "admin" },
    mfaPendente: false,
  });

  // As ações que só carimbam o estado do assistente: passam pela guarda,
  // escrevem na organização da SESSÃO e seguem para o próximo passo.
  for (const nome of [
    "acceptWelcome",
    "skipWhatsapp",
    "markWhatsappConfigured",
    "skipNuvemshop",
    "markNuvemshopConfigured",
    "skipAi",
    "pularQuadro",
    "marcarTesteFeito",
    "pularTeste",
    "sendOnboardingInvitesPular",
    "finishOnboarding",
  ]) {
    it(`${nome}: grava na organização da sessão e avança`, async () => {
      sessao = admin();
      const d = await executar(ACOES[nome]!);

      expect(d.tipo, `${nome} não avançou para o admin: ${JSON.stringify(d)}`).toBe("redirect");
      const escritas = operacoes.filter((o) => o.op !== "select");
      expect(escritas.length, `${nome} não escreveu nada para o admin`).toBeGreaterThan(0);
      for (const o of operacoes) {
        const alvo =
          o.table === "organizations" ? o.filtros.id : (o.filtros.organization_id ?? ORG);
        expect(alvo, `${nome} alcançou outra organização em ${o.table}`).toBe(ORG);
      }
    });
  }

  it("dadosDoPasso ignora o `orgId` forjado e lê só a organização da sessão", async () => {
    sessao = admin();
    const d = await executar(ACOES.dadosDoPasso!);

    expect(d.tipo, JSON.stringify(d)).toBe("retorno");
    expect(operacoes.length).toBeGreaterThan(0);
    for (const o of operacoes) {
      const alvo = o.table === "organizations" ? o.filtros.id : o.filtros.organization_id;
      expect(alvo, `dadosDoPasso leu ${o.table} fora da organização da sessão`).not.toBe(OUTRA_ORG);
    }
    expect(JSON.stringify(operacoes)).not.toContain(OUTRA_ORG);
  });
});
