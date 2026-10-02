/**
 * SPIKE Green (descartável) — MutationContext v1.
 *
 * Contexto de execução de uma mutação Green que viaja NA MESMA request
 * PostgREST que executa o INSERT/UPDATE, para o hook de banco
 * (`green.fn_mutation_context()`, migration 0501) carimbar o evento canônico
 * com actor/source/request/correlation/causation sem que nenhum writer de
 * `crm_leads.stage_id` seja tocado.
 *
 * ─── O que ele NÃO é ────────────────────────────────────────────────────────
 *
 * Não concede autorização. Sessão humana tem o actor derivado de `auth.uid()`
 * no banco e o bloco `actor`/`service_origin` deste contexto é IGNORADO lá.
 * Só a request de `service_role` (backend) tem o contexto aceito — depois de
 * validado por schema. Um navegador que mande o header à mão não vira nada.
 *
 * ─── Por que AsyncLocalStorage ──────────────────────────────────────────────
 *
 * O admin client é singleton (`createAdminClient`) e mutar `global.headers`
 * por request misturaria contextos entre requests concorrentes. O contexto
 * fica amarrado ao contexto assíncrono e é lido NA HORA do fetch
 * (`lib/supabase/fetch-do-servidor.ts`), nunca na hora de criar o client —
 * mesmo padrão de `lib/event-log/origem-do-dreno.ts` e
 * `lib/atendimento/fronteira-server.ts`.
 *
 * ─── PII ────────────────────────────────────────────────────────────────────
 *
 * O contrato é FECHADO por chave: qualquer chave fora da lista é recusada, então
 * nome, telefone, e-mail ou texto de mensagem não têm por onde entrar.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { logger } from "@/lib/logger";

import type { Actor } from "@/lib/api/handlers/types";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";

export const GREEN_MUTATION_CONTEXT_HEADER = "x-green-mutation-context";

/** Teto do JSON serializado; o resolver SQL recusa acima disto. */
export const GREEN_MUTATION_CONTEXT_MAX_BYTES = 4096;

export type GreenActorKind = "ai_agent" | "api_token" | "webhook_source" | "system";

export interface GreenActor {
  kind: GreenActorKind;
  id?: string;
  agent_id?: string;
  api_token_id?: string;
}

export type GreenServiceOrigin =
  | { kind: "event"; event_id: string; organization_id: string; contact_id: string }
  | { kind: "continuation"; boundary: ServiceBoundary };

export interface GreenMutationContextV1 {
  v: 1;
  source: string;
  request_id?: string;
  correlation_id?: string;
  causation_event_id?: string;
  source_job_id?: string;
  idempotency_key?: string;
  /** O que o CLIENTE mandou como x-request-id: advisory, nunca controle (v1.2). */
  client_request_id?: string;
  actor?: GreenActor;
  service_origin?: GreenServiceOrigin;
}

/** O que um seam passa: `v` é fixo, `source` pode vir do contexto pai. */
export type GreenMutationContextInput = Partial<Omit<GreenMutationContextV1, "v">>;

export class GreenMutationContextError extends Error {
  constructor(public readonly campo: string) {
    super(`green_mutation_context_invalid:${campo}`);
    this.name = "GreenMutationContextError";
  }
}

/**
 * v3 — o que fica no AsyncLocalStorage é um ESCOPO, não o contexto cru.
 *
 * `aberto` é o que faz o contexto TERMINAR: `AsyncLocalStorage.run` delimita
 * quem herda, mas tudo que foi agendado lá dentro (timer, poller, callback
 * tardio) continua herdando para sempre. Quem abriu o escopo o fecha quando o
 * trabalho assenta, e um escopo fechado não entrega contexto a ninguém — é a
 * diferença entre "delimitado por construção" e "delimitado enquanto ninguém
 * guardar uma referência".
 *
 * `requisicao` marca o escopo aberto pela boundary de requisição: só nele o
 * gate de auth escreve (uma vez).
 */
interface EscopoGreen {
  ctx: GreenMutationContextV1 | undefined;
  readonly requisicao: boolean;
  aberto: boolean;
}

const als = new AsyncLocalStorage<EscopoGreen>();

function escopoVivo(): EscopoGreen | undefined {
  const escopo = als.getStore();
  return escopo?.aberto ? escopo : undefined;
}

function ehThenable(valor: unknown): valor is PromiseLike<unknown> {
  return (
    !!valor &&
    (typeof valor === "object" || typeof valor === "function") &&
    typeof (valor as { then?: unknown }).then === "function"
  );
}

/**
 * Roda `fn` dentro do escopo e o FECHA quando o trabalho termina: no retorno
 * síncrono, no throw, ou quando a promessa assenta (cumprida ou rejeitada).
 * Thenable preguiçoso (o builder do PostgREST só dispara no `then`) é
 * consumido DENTRO do escopo, para o fetch dele enxergar o contexto.
 */
function rodarNoEscopo<T>(escopo: EscopoGreen, fn: () => T): T {
  const fechar = () => {
    escopo.aberto = false;
    escopo.ctx = undefined;
  };
  let resultado: T;
  try {
    resultado = als.run(escopo, fn);
  } catch (err) {
    fechar();
    throw err;
  }
  if (resultado instanceof Promise) {
    return resultado.finally(fechar) as T;
  }
  if (ehThenable(resultado)) {
    const preguicoso = resultado;
    return new Promise((ok, erro) => {
      als.run(escopo, () => preguicoso.then(ok, erro));
    }).finally(fechar) as T;
  }
  fechar();
  return resultado;
}

const SOURCE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHAVES = new Set([
  "v",
  "source",
  "request_id",
  "correlation_id",
  "causation_event_id",
  "source_job_id",
  "idempotency_key",
  "client_request_id",
  "actor",
  "service_origin",
]);
const CHAVES_DO_ACTOR = new Set(["kind", "id", "agent_id", "api_token_id"]);
const KINDS_DO_ACTOR = new Set<GreenActorKind>([
  "ai_agent",
  "api_token",
  "webhook_source",
  "system",
]);
const CHAVES_DA_BOUNDARY = new Set([
  "organization_id",
  "contact_id",
  "conversation_id",
  "service_revision",
  "demanda_id",
  "demanda_revision",
]);

function somenteChaves(obj: object, permitidas: Set<string>, campo: string): void {
  for (const k of Object.keys(obj)) {
    if (!permitidas.has(k)) throw new GreenMutationContextError(`${campo}.${k}`);
  }
}

function idOpcional(valor: unknown, campo: string): void {
  if (valor === undefined) return;
  if (typeof valor !== "string" || !ID.test(valor)) throw new GreenMutationContextError(campo);
}

function uuid(valor: unknown, campo: string): void {
  if (typeof valor !== "string" || !UUID.test(valor)) throw new GreenMutationContextError(campo);
}

/**
 * Recusa alto o que o resolver SQL também recusaria: melhor falhar no processo
 * Node, onde há stack trace, do que no `42501` do banco.
 */
export function validateGreenMutationContext(ctx: unknown): asserts ctx is GreenMutationContextV1 {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx))
    throw new GreenMutationContextError("root");
  const c = ctx as Record<string, unknown>;
  somenteChaves(c, CHAVES, "root");
  if (c.v !== 1) throw new GreenMutationContextError("v");
  if (typeof c.source !== "string" || !SOURCE.test(c.source))
    throw new GreenMutationContextError("source");
  idOpcional(c.request_id, "request_id");
  idOpcional(c.correlation_id, "correlation_id");
  idOpcional(c.source_job_id, "source_job_id");
  idOpcional(c.idempotency_key, "idempotency_key");
  idOpcional(c.client_request_id, "client_request_id");
  if (c.causation_event_id !== undefined) uuid(c.causation_event_id, "causation_event_id");

  if (c.actor !== undefined) {
    if (!c.actor || typeof c.actor !== "object") throw new GreenMutationContextError("actor");
    const a = c.actor as Record<string, unknown>;
    somenteChaves(a, CHAVES_DO_ACTOR, "actor");
    if (!KINDS_DO_ACTOR.has(a.kind as GreenActorKind))
      throw new GreenMutationContextError("actor.kind");
    idOpcional(a.id, "actor.id");
    idOpcional(a.agent_id, "actor.agent_id");
    idOpcional(a.api_token_id, "actor.api_token_id");
  }

  if (c.service_origin !== undefined) {
    if (!c.service_origin || typeof c.service_origin !== "object") {
      throw new GreenMutationContextError("service_origin");
    }
    const o = c.service_origin as Record<string, unknown>;
    if (o.kind === "event") {
      somenteChaves(
        o,
        new Set(["kind", "event_id", "organization_id", "contact_id"]),
        "service_origin",
      );
      uuid(o.event_id, "service_origin.event_id");
      uuid(o.organization_id, "service_origin.organization_id");
      uuid(o.contact_id, "service_origin.contact_id");
    } else if (o.kind === "continuation") {
      somenteChaves(o, new Set(["kind", "boundary"]), "service_origin");
      if (!o.boundary || typeof o.boundary !== "object") {
        throw new GreenMutationContextError("service_origin.boundary");
      }
      const b = o.boundary as Record<string, unknown>;
      somenteChaves(b, CHAVES_DA_BOUNDARY, "service_origin.boundary");
      uuid(b.organization_id, "service_origin.boundary.organization_id");
      uuid(b.contact_id, "service_origin.boundary.contact_id");
      uuid(b.conversation_id, "service_origin.boundary.conversation_id");
      if (!Number.isSafeInteger(b.service_revision)) {
        throw new GreenMutationContextError("service_origin.boundary.service_revision");
      }
      if (b.demanda_id !== null) uuid(b.demanda_id, "service_origin.boundary.demanda_id");
      if (b.demanda_revision !== null && !Number.isSafeInteger(b.demanda_revision)) {
        throw new GreenMutationContextError("service_origin.boundary.demanda_revision");
      }
    } else {
      // `command` NUNCA viaja: o banco deriva. `unavailable` não é origem.
      throw new GreenMutationContextError("service_origin.kind");
    }
  }

  if (utf8Bytes(JSON.stringify(c)) > GREEN_MUTATION_CONTEXT_MAX_BYTES) {
    throw new GreenMutationContextError("size");
  }
}

function utf8Bytes(texto: string): number {
  return new TextEncoder().encode(texto).length;
}

/**
 * v1.2 (LIFE-ADV-02) — a confiança vem da ORIGEM, não do formato. O
 * `request_id` confiável é gerado AQUI, no servidor; o `x-request-id` que o
 * cliente mandou nunca ocupa `request_id`/`correlation_id` (que o banco grava
 * em `trusted` e o anti-loop lê), só `client_request_id` (advisory).
 */
export function novoRequestIdDoServidor(): string {
  return randomUUID();
}

/** Valor do cliente saneado para advisory: charset e teto do contrato, nunca derruba o contexto. */
export function requestIdDoCliente(valor: unknown): string | undefined {
  if (typeof valor !== "string" || valor === "") return undefined;
  return valor.slice(0, 128).replace(/[^A-Za-z0-9_.:-]/g, "_");
}

/** Os três campos de identificação de uma requisição de entrada, na separação certa. */
export function identificadoresDaRequisicao(headerDoCliente: unknown): GreenMutationContextInput {
  const id = novoRequestIdDoServidor();
  const cliente = requestIdDoCliente(headerDoCliente);
  return { request_id: id, correlation_id: id, ...(cliente ? { client_request_id: cliente } : {}) };
}

/**
 * Merge controlado com o contexto pai (contexto aninhado): o filho sobrescreve
 * campo a campo, e o que ele não declara é herdado — `correlation_id` e
 * `service_origin` são os que mais importam herdar (o job do agente abre a
 * fronteira; a tool que roda dentro dele não deve perdê-la).
 */
function mesclar(
  pai: GreenMutationContextV1 | undefined,
  filho: GreenMutationContextInput,
): GreenMutationContextV1 {
  const definidos = Object.fromEntries(
    Object.entries(filho).filter(([, v]) => v !== undefined),
  ) as GreenMutationContextInput;
  const resultado = { ...(pai ?? {}), ...definidos, v: 1 as const } as GreenMutationContextV1;
  validateGreenMutationContext(resultado);
  return resultado;
}

/**
 * Roda `fn` com o contexto (mesclado ao pai, se houver) amarrado à cadeia async.
 *
 * FAIL-OPEN NO SEAM, FAIL-CLOSED NO BANCO. Um contexto inválido (campo fora do
 * contrato, id que não é UUID num fixture, bug de quem chamou) NÃO derruba o
 * fluxo upstream que atravessa o seam: `fn` roda SEM contexto nenhum — nunca
 * sob o contexto do pai, para a mutação não sair com a autoria errada — e o
 * aviso vai para o log. Para lead Green, a ausência de contexto é recusada
 * pelo hook de banco (42501), que é a fronteira que de fato protege; para lead
 * não-Green, nada muda. Quem precisa da recusa alta usa `validate`/`serialize`.
 */
export function withGreenMutationContext<T>(ctx: GreenMutationContextInput, fn: () => T): T {
  return rodarComContexto(escopoVivo()?.ctx, ctx, fn);
}

function rodarComContexto<T>(
  pai: GreenMutationContextV1 | undefined,
  ctx: GreenMutationContextInput,
  fn: () => T,
): T {
  let mesclado: GreenMutationContextV1 | undefined;
  try {
    mesclado = mesclar(pai, ctx);
  } catch (err) {
    logger.warn(
      "[green.mutation-context] contexto inválido descartado; a mutação segue sem contexto",
      {
        campo: err instanceof GreenMutationContextError ? err.campo : String(err),
        source: ctx.source ?? pai?.source ?? null,
      },
    );
    mesclado = undefined;
  }
  return rodarNoEscopo({ ctx: mesclado, requisicao: false, aberto: true }, fn);
}

/**
 * v3 — RAIZ DE SISTEMA: roda `fn` com `ctx` SEM herdar nada de quem chamou.
 *
 * Trabalho de sistema (handler de evento, job do agent-worker, tool de um
 * servidor MCP) não é continuação de quem o disparou. Uma sessão admin que
 * chama `relogio/tick` não é a causa das mutações que o drain fizer — a causa é
 * o evento. Herdar `request_id`/`correlation_id` da requisição humana gravava
 * no canônico uma proveniência que não existe (AUDIT-08.2, ADV-05).
 */
export function withGreenSystemRoot<T>(ctx: GreenMutationContextInput, fn: () => T): T {
  return rodarComContexto(undefined, ctx, fn);
}

/**
 * v3 — roda `fn` SEM contexto nenhum, cortando o que quer que quem chamou
 * tivesse. Para o ponto de entrada de trabalho de sistema que ainda não tem
 * contexto próprio (o tick do relógio): os seams lá dentro abrem as raízes
 * deles; o que não abrir, falha fechado no banco em lead Green.
 */
export function withoutGreenMutationContext<T>(fn: () => T): T {
  return rodarNoEscopo({ ctx: undefined, requisicao: false, aberto: true }, fn);
}

export function currentGreenMutationContext(): GreenMutationContextV1 | undefined {
  return escopoVivo()?.ctx;
}

/**
 * v3 — BOUNDARY EXPLÍCITA DE REQUISIÇÃO.
 *
 * Delimita início e fim do contexto de UMA requisição com
 * `AsyncLocalStorage.run`: sempre uma raiz nova (nunca herda de quem chamou),
 * fechada quando o handler assenta. É o único lugar onde o gate de auth
 * (`abrirContextoGreenDaRequisicao`) consegue escrever. Sem boundary não há
 * contexto — a propriedade deixou de depender do formato das rotas, de haver um
 * `await` antes do gate ou da implementação de ALS do runtime (AUDIT-08.2,
 * ADV-06: no Node 22, o gate antigo deixava o contexto da requisição 1 vazar
 * para as seguintes do mesmo socket).
 */
export function runGreenRequestBoundary<T>(fn: () => T): T {
  return rodarNoEscopo({ ctx: undefined, requisicao: true, aberto: true }, fn);
}

/** O que a boundary de requisição devolve: completar o contexto depois de autenticar. */
export interface ContextoGreenDaRequisicao {
  vincular(campos: GreenMutationContextInput): void;
}

const SEM_CONTEXTO: ContextoGreenDaRequisicao = { vincular() {} };

/**
 * v3 — o gate de auth PREENCHE o contexto da requisição; quem o delimita é a
 * boundary (`runGreenRequestBoundary`), que a rota declara depois da guarda de
 * suporte (`requireSupportWrite`) — a forma `export const POST = wrapper(handle)`
 * é reprovada pela cerca `suporte-cobertura-de-efeitos` do upstream.
 *
 * Na v2 esta função ABRIA o contexto no próprio gate, sem delimitar o fim — o
 * que só era seguro enquanto toda rota tivesse um `await` antes do gate e nada
 * sobrevivesse à requisição. Agora ela não abre nada: escreve no escopo de
 * requisição corrente, uma vez. Fora de uma boundary (rota que não a declarou,
 * job, script) é no-op — o contexto fica ausente e, em lead Green, o banco
 * recusa o writer privilegiado (fail-closed); sessão humana não depende dele
 * (o ator é `auth.uid()`).
 *
 * Dentro de um contexto aninhado (tool MCP, job, regra) também é no-op: a
 * requisição é a moldura mais externa, nunca a mais forte.
 *
 * `vincular` troca o contexto do MESMO escopo por um objeto novo — é como o
 * gate do token acrescenta o ator, que só existe depois do `await` da
 * validação. Nada é compartilhado por referência entre requisições.
 */
export function abrirContextoGreenDaRequisicao(
  ctx: GreenMutationContextInput,
): ContextoGreenDaRequisicao {
  const escopo = escopoVivo();
  if (!escopo || !escopo.requisicao || escopo.ctx !== undefined) return SEM_CONTEXTO;
  try {
    escopo.ctx = mesclar(undefined, ctx);
  } catch (err) {
    logger.warn("[green.mutation-context] contexto de requisição inválido descartado", {
      campo: err instanceof GreenMutationContextError ? err.campo : String(err),
      source: ctx.source ?? null,
    });
    return SEM_CONTEXTO;
  }
  return {
    vincular(campos) {
      if (!escopo.aberto) return;
      try {
        escopo.ctx = mesclar(escopo.ctx, campos);
      } catch (err) {
        logger.warn("[green.mutation-context] vínculo de requisição inválido descartado", {
          campo: err instanceof GreenMutationContextError ? err.campo : String(err),
          source: escopo.ctx?.source ?? null,
        });
      }
    },
  };
}

/* ── transporte ─────────────────────────────────────────────────────────────── */

function base64DeUtf8(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function utf8DeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** JSON UTF-8 em Base64 padrão — o que o banco lê com `decode(..., 'base64')`. */
export function serializeGreenMutationContext(ctx: GreenMutationContextV1): string {
  validateGreenMutationContext(ctx);
  return base64DeUtf8(JSON.stringify(ctx));
}

/** Inverso de `serialize` — para teste e diagnóstico; nunca aceita input de usuário. */
export function parseGreenMutationContext(valor: string): GreenMutationContextV1 {
  const ctx: unknown = JSON.parse(utf8DeBase64(valor));
  validateGreenMutationContext(ctx);
  return ctx;
}

/**
 * O `init` da requisição com o header do contexto corrente, quando há um.
 *
 * Chamado pelo `fetchDoServidor` NA HORA da chamada (é o que amarra o header à
 * request certa sob concorrência). Sem contexto, devolve o `init` intacto —
 * transporte byte a byte igual ao de antes. Quando `input` é um `Request`, os
 * headers dele entram no merge para o `init` novo não os apagar.
 */
export function initComContextoGreen(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInit | undefined {
  const ctx = escopoVivo()?.ctx;
  if (!ctx) return init;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((valor, nome) => headers.set(nome, valor));
  headers.set(GREEN_MUTATION_CONTEXT_HEADER, serializeGreenMutationContext(ctx));
  return { ...init, headers };
}

/* ── adaptadores dos seams ─────────────────────────────────────────────────── */

/**
 * O `Actor` do Deskcomm no vocabulário do contexto. `user` nunca vira actor de
 * header (o banco deriva humano de `auth.uid()`); um ator humano chegando por
 * caminho privilegiado é rebaixado a `system`, e o banco registra o `caller`.
 */
export function greenActorFromActor(actor: Actor, apiTokenId?: string): GreenActor {
  switch (actor.type) {
    case "ai_agent":
      return {
        kind: "ai_agent",
        id: actor.id,
        ...(actor.agent_id ? { agent_id: actor.agent_id } : {}),
        ...((actor.api_token_id ?? apiTokenId)
          ? { api_token_id: actor.api_token_id ?? apiTokenId }
          : {}),
      };
    case "api_token":
      return {
        kind: "api_token",
        id: actor.id,
        ...(apiTokenId ? { api_token_id: apiTokenId } : {}),
      };
    case "webhook_source":
      return { kind: "webhook_source", id: actor.id };
    default:
      return { kind: "system", id: actor.id };
  }
}

/** Continuação de atendimento (fronteira já validada por quem a abriu). */
export function greenContinuation(boundary: ServiceBoundary): GreenServiceOrigin {
  return {
    kind: "continuation",
    boundary: {
      organization_id: boundary.organization_id,
      contact_id: boundary.contact_id,
      conversation_id: boundary.conversation_id,
      service_revision: boundary.service_revision,
      demanda_id: boundary.demanda_id,
      demanda_revision: boundary.demanda_revision,
    },
  };
}
