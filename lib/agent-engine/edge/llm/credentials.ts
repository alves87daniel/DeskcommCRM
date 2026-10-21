/**
 * Config LLM por org, pós-fusão (PORT-NOTES): a credencial BYOK vive em
 * `ai_provider_credentials` do CRM (AES-256-GCM via lib/crypto/aes_gcm — colunas
 * api_key_encrypted/api_key_iv/api_key_tag) e os knobs de modelo/params vivem em
 * `organizations.settings->'llm'`. O plaintext da chave existe apenas em memória
 * do processo no instante da chamada; nunca em log.
 *
 * ═══ NÃO EXISTE CHAVE DA INSTALAÇÃO (ADR-0005) ═══
 *
 * Até 2026-10 este resolvedor tinha três degraus abaixo da credencial da
 * organização: as chaves da Anthropic, da OpenAI e da OpenRouter lidas do
 * `.env`, rotuladas como chave da instalação. Numa instalação que serve várias
 * organizações, isso fazia a chave de UMA conta pagar a IA de todas — sem teto
 * por organização, sem fatura própria e sem a organização saber. A decisão do
 * dono do produto (`docs/adr/0005-ia-paga-por-cada-organizacao.md`) acabou com o
 * conceito: a única fonte de chave é `ai_provider_credentials` da organização,
 * ativa e validada; sem ela, `LlmNotConfiguredError`, que é TERMINAL — o turno
 * passa a conversa para a equipe e a fila não tenta de novo (D3).
 *
 * `LlmEdgeConfig` ficou só com os knobs sem chave. A cerca
 * `tests/unit/ia-sem-chave-da-plataforma.test.ts` reprova a volta de qualquer
 * leitura de chave de IA do ambiente neste arquivo.
 *
 * O TETO **não** mora mais no jsonb: desde a migration 0159 ele é
 * `ai_budgets` (teto, modo, carência, limiar), lido aqui pelo mesmo round-trip
 * via `left join`. Era o defeito de origem — a tela editava `ai_budgets` e o
 * enforcement lia `settings.llm.monthly_budget_cents`, então quem preenchia a
 * tela acreditava estar protegido e não estava.
 *
 * A config é lida do DB A CADA chamada (resolveOrgLlmConfig) — trocar modelo/
 * provider/teto é UPDATE na config, sem restart nem deploy.
 */
import type pg from 'pg';
import { z } from 'zod';

import { byteaToBuffer, decryptKey } from '@/lib/crypto/aes_gcm';
import {
  LIMIAR_PADRAO_PCT,
  normalizarChaveDeOrcamento,
  normalizarModoDeOrcamento,
  type ChaveDeOrcamento,
  type ModoDeOrcamento,
} from './orcamento';
import type { RaciocinioDeepseek } from './providers';
import type { CacheTtl } from './stable-prefix';

/**
 * Config da camada LLM montada do env validado (padrão crmEdgeConfigFromEnv).
 *
 * Só KNOBS. Nenhum campo aqui carrega chave de provedor: a chave sai da
 * credencial da organização, dentro de `resolveOrgLlmConfig` (ADR-0005).
 */
export interface LlmEdgeConfig {
  /**
   * TTL do prefixo estável de cache (knob LLM_CACHE_TTL). Opcional para quem
   * monta a config na mão (testes) — o seam aplica a doutrina '1h' quando ausente.
   */
  cacheTtl?: CacheTtl;
  /**
   * Toggle do raciocínio (thinking) da DeepSeek — knob DEEPSEEK_THINKING.
   * Ausente = `'provider'`: o provedor decide (raciocínio LIGADO). Só a
   * DeepSeek lê este valor; os outros provedores não passam por essa fábrica.
   */
  deepseekThinking?: RaciocinioDeepseek;
  /**
   * `AI_BUDGET_ENFORCEMENT` já normalizado — o kill switch do operador da
   * instalação. Ausente = `'on'`, e `'on'` NÃO LIGA NADA: significa apenas
   * "respeite o que cada organização escolheu". A chave só sabe AFROUXAR.
   *
   * Vive aqui, e não lida de `process.env` dentro do seam, porque a camada tem
   * um dono de env por processo: o app (`lib/env.ts`) e o worker
   * (`lib/agent-engine/env.ts`) montam esta config, e `loadEnv` do worker
   * REMOVE o que o schema dele não declara. Uma leitura direta de
   * `process.env` aqui pareceria funcionar no app e sumiria no worker — que é
   * exatamente onde a IA gasta.
   */
  budgetEnforcement?: ChaveDeOrcamento;
}

/**
 * Monta os knobs da camada LLM a partir do env validado. Deixou de ler chave
 * de provedor de propósito (ADR-0005): o parâmetro não declara chave nenhuma,
 * e um chamador que tentar passá-las recebe erro de tipo.
 */
export function llmEdgeConfigFromEnv(env: {
  LLM_CACHE_TTL?: string;
  AI_BUDGET_ENFORCEMENT?: string;
  DEEPSEEK_THINKING?: string;
}): LlmEdgeConfig {
  const ttl = env.LLM_CACHE_TTL ?? '1h';
  if (ttl !== '5m' && ttl !== '1h') {
    throw new Error("LLM_CACHE_TTL inválido — use '5m' ou '1h' (default 1h)");
  }
  const raciocinio = env.DEEPSEEK_THINKING ?? 'provider';
  if (raciocinio !== 'provider' && raciocinio !== 'disabled') {
    throw new Error("DEEPSEEK_THINKING inválido — use 'provider' ou 'disabled' (default provider)");
  }
  return {
    cacheTtl: ttl,
    deepseekThinking: raciocinio,
    // Sem `if` de valor vazio: aqui o ausente TEM um significado ('on'), e o
    // normalizador é quem o dá. Um campo opcional que some faria o seam ter de
    // repetir o default, e dois defaults é como um dos dois fica para trás.
    budgetEnforcement: normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT),
  };
}

/**
 * Org sem credencial LLM utilizável — erro tipado, mensagem sem valores
 * (credencial fora).
 *
 * É TERMINAL, e isso é a decisão D3 da ADR-0005 (dono do produto, 21/10/2026):
 * sem chave da organização não há chave nenhuma, e tentar de novo daqui a um
 * minuto dá o mesmo resultado. A fila lê a propriedade `terminal`
 * (`workers/agent-worker/main.ts`) e CANCELA o job em vez de reagendar cinco
 * vezes e abrir um `job_dead` crítico por conversa. O que torna o cancelamento
 * seguro é a escolta do turno (`comHandoffSeIaNaoResponder`, em
 * `lib/agent-engine/agent/inbound-turn.ts`): a conversa é passada à equipe
 * ANTES de o erro chegar à fila, e a Central recebe UM aviso por organização.
 */
export class LlmNotConfiguredError extends Error {
  override readonly name = 'llm_not_configured';
  /** Lido pela fila: veto de configuração, não incidente — sem retry. */
  readonly terminal = true as const;
  constructor() {
    super(
      'esta organização não tem chave de IA ativa e validada para o provedor do ponto — a IA fica desligada para ela até alguém cadastrar a chave em IA › Credenciais (a plataforma não custeia IA, ADR-0005)',
    );
  }
}

/**
 * O teto da organização, como o resolvedor o leu. É o ESTADO, nunca a decisão:
 * quem decide é `decidirOrcamento` (`./orcamento.ts`), e quem lhe entrega os
 * números é o statement do gate — não este objeto.
 *
 * ⚠️ ESTES VALORES SERVEM SÓ AO ATALHO DE CUSTO. O gate os usa para uma única
 * pergunta ("vale a pena ir ao banco?") e depois relê tudo dentro de
 * `SQL_ORCAMENTO`, que enxerga um snapshot atômico junto com os inserts.
 * Decidir sobre a cópia daqui seria decidir sobre um número mais velho que o
 * aviso que ele mesmo abriria.
 */
export interface OrcamentoDaOrg {
  modo: ModoDeOrcamento;
  /** `ai_budgets.monthly_limit_cents` — centavo de DÓLAR (ver `pricing.ts`). */
  tetoCents: number;
  efetivoEm: Date | null;
  limiarPct: number;
}

/**
 * De QUEM é a chave que o resolvedor devolveu. Desde a ADR-0005 há UMA resposta
 * possível, e o campo continua existindo por ela: é o que impede o próximo
 * degrau de entrar sem mudar um tipo que o compilador vigia. Mesmo vocabulário
 * de `lib/ai/embeddings/chave.ts`, que responde a mesma pergunta para embedding.
 */
export type OrigemDaChaveLlm = 'credencial_da_organizacao';

export interface OrgLlmConfig {
  provider: string;
  /** plaintext decifrado — existe só em memória, jamais logado/persistido */
  apiKey: string;
  /** Sempre `credencial_da_organizacao` (ADR-0005). */
  origemDaChave: OrigemDaChaveLlm;
  defaultModel: string | null;
  params: Record<string, unknown>;
  enabledModels: string[];
  orcamento: OrcamentoDaOrg;
  /**
   * `null` = a leitura do orçamento foi normal. Não-nulo = a causa, já pronta
   * para log, de o resolvedor ter caído na query legada.
   *
   * UM campo e não um par `boolean` + `string`: dois campos que só fazem
   * sentido juntos são dois campos que podem discordar. Não-nulo já significa
   * "indisponível", e ainda carrega o PORQUÊ — que é o que separa falhar
   * ABERTO na informação de falhar em silêncio.
   */
  orcamentoIndisponivelPorque: string | null;
  /**
   * O endereço da PRÓPRIA credencial, e só o provedor personalizado (#1642) tem
   * um (`ai_provider_credentials.base_url`). `null` nos nativos: o endpoint deles
   * é intrínseco.
   *
   * Lido numa query SEPARADA e só quando o provider é `custom`: o resolvedor
   * nunca pode cair por schema atrasado num clone que ainda não aplicou a 0413,
   * e nenhum provedor nativo paga o preço de uma coluna nova.
   */
  baseUrl: string | null;
}

// Leitura DEFENSIVA de organizations.settings->'llm' (jsonb livre): campo com
// shape errado cai no default, nunca derruba o turno.
//
// `monthly_budget_cents` SAIU daqui (migration 0159): o teto deixou de morar
// num escalar de jsonb livre lido por dois `.catch()` — onde valor com forma
// errada virava `null` e `null` era ilimitado, isto é, o campo que protegia
// falhava ABERTO por construção — e passou a morar em `ai_budgets`, com CHECK,
// tela, RLS e auditoria. Os demais `.catch()` ficam: são a defesa certa para o
// que continua sendo jsonb livre.
const llmSettingsSchema = z
  .object({
    provider: z.string().min(1).catch('anthropic'),
    default_model: z.string().min(1).nullable().catch(null),
    params: z.record(z.string(), z.unknown()).catch({}),
    enabled_models: z.array(z.string()).catch([]),
  })
  .passthrough()
  .catch({
    provider: 'anthropic',
    default_model: null,
    params: {},
    enabled_models: [],
  });

/**
 * A leitura em UMA ida ao banco: os knobs de jsonb e o teto, `left join` na PK
 * de uma tabela de uma linha por organização — o mesmo round-trip que a query
 * anterior fazia sozinha.
 *
 * `left join` e nunca `join`: NENHUM gatilho de `organizations` semeia
 * `ai_budgets` (os produtores são o gatilho de `llm_calls`, os dois backfills
 * do baseline e o PATCH da tela). Um `join` faria organização sem linha
 * desaparecer da consulta e o resolvedor concluir "organização inexistente" —
 * derrubando toda chamada de IA dela.
 */
const SQL_CONFIG_COM_ORCAMENTO = `
  select o.settings->'llm'            as llm,
         b.monthly_limit_cents        as teto,
         b.enforcement_mode           as modo,
         b.enforcement_effective_at   as efetivo_em,
         b.alarm_threshold_pct        as limiar_pct
    from organizations o
    left join ai_budgets b on b.organization_id = o.id
   where o.id = $1`;

/** A query de antes da 0159 — a rede quando o schema do clone está atrasado. */
const SQL_CONFIG_LEGADO = `select settings->'llm' as llm from organizations where id = $1`;

interface LinhaDeConfig {
  llm: unknown;
  teto?: number | string | null;
  modo?: string | null;
  efetivo_em?: Date | null;
  limiar_pct?: number | string | null;
}

const ORCAMENTO_DESLIGADO: OrcamentoDaOrg = {
  modo: 'off',
  tetoCents: 0,
  efetivoEm: null,
  limiarPct: LIMIAR_PADRAO_PCT,
};

/**
 * O erro do Postgres em uma linha, para log. Leva o SQLSTATE porque é ele que
 * separa "o clone não aplicou o apêndice" (`42703`) de "o banco caiu" — e a
 * frase tranquilizadora ("orçamento indisponível") sem a causa manda a próxima
 * pessoa investigar do zero.
 */
function causaDoBanco(err: unknown): string {
  const codigo = (err as { code?: unknown } | null)?.code;
  const texto = err instanceof Error ? err.message : String(err);
  return `${typeof codigo === 'string' ? codigo : 'sem_sqlstate'}: ${texto}`.slice(0, 300);
}

/**
 * Override por-turno vindo da versão PUBLICADA do agente (Fase 2B): a tela
 * escolhe provider e credencial ESPECÍFICA; sem override, vale a config da org
 * (settings.llm + credencial mais recente do provider).
 */
export interface LlmResolveOverride {
  provider?: string;
  credentialId?: string | null;
}

/**
 * Resolve a config LLM da org: knobs de organizations.settings->'llm' + a
 * credencial da organização (decifrada com aes_gcm) — a ESCOLHIDA na versão
 * publicada quando houver, senão a MAIS RECENTE ativa e validada do provider
 * (ordem única de todo resolvedor do produto, ADR-0005 D2). Sem credencial →
 * `LlmNotConfiguredError`, sem outro degrau. Chamada a cada run — troca de
 * config vale no run seguinte.
 */
export async function resolveOrgLlmConfig(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  organizationId: string,
  override?: LlmResolveOverride,
): Promise<OrgLlmConfig> {
  // `cfg` segue na assinatura por ser o contrato de todo chamador do seam — e
  // por não carregar chave nenhuma, o resolvedor não tem o que ler dele.
  void cfg;
  // ⚠️ O RESOLVEDOR NUNCA LANÇA POR SCHEMA DESATUALIZADO.
  //
  // `hostgator-setup-kit/update.sh` aplica o baseline com `|| true` e SEM
  // `ON_ERROR_STOP`, e só depois sobe a imagem nova. Um apêndice parcialmente
  // aplicado deixa a imagem nova consultando uma coluna que não existe — e um
  // throw aqui derrubaria TODA chamada de LLM de TODA organização daquele
  // clone, que é pior do que o estrangulamento que este trabalho existe para
  // evitar. É a mesma lei que o CLAUDE.md já escreve para a marca
  // ("Resolvedor NUNCA lança"), aplicada onde ela também vale.
  //
  // Uma query no caminho feliz; duas só no caminho quebrado. E a queda é
  // ABERTA NA AÇÃO (modo 'off' ⇒ ninguém é bloqueado por um erro de leitura) e
  // ABERTA NA INFORMAÇÃO (`orcamentoIndisponivelPorque` carrega a causa até o
  // log do seam) — nunca a frase tranquilizadora sozinha.
  let rows: LinhaDeConfig[];
  let orcamentoIndisponivelPorque: string | null = null;
  try {
    ({ rows } = await db.query<LinhaDeConfig>(SQL_CONFIG_COM_ORCAMENTO, [organizationId]));
  } catch (err) {
    orcamentoIndisponivelPorque = causaDoBanco(err);
    ({ rows } = await db.query<LinhaDeConfig>(SQL_CONFIG_LEGADO, [organizationId]));
  }
  if (rows.length === 0) {
    throw new Error('organização inexistente ao resolver config LLM');
  }
  const linha = rows[0];
  const settings = llmSettingsSchema.parse(linha?.llm ?? {});
  const provider = override?.provider ?? settings.provider;

  // Organização sem linha em `ai_budgets` cai aqui com tudo nulo, e o
  // normalizador resolve `modo` para 'off'. NULO É SEMPRE A RESPOSTA MAIS
  // FROUXA — em toda coluna, em todo caminho deste arquivo.
  const orcamento: OrcamentoDaOrg =
    orcamentoIndisponivelPorque !== null
      ? ORCAMENTO_DESLIGADO
      : {
          modo: normalizarModoDeOrcamento(linha?.modo),
          tetoCents: Number(linha?.teto ?? 0),
          efetivoEm: linha?.efetivo_em ?? null,
          limiarPct: Number(linha?.limiar_pct ?? LIMIAR_PADRAO_PCT),
        };

  // Credencial: a ESCOLHIDA na versão publicada quando houver (ainda exigindo
  // ativa+validada — publish valida, mas a credencial pode ser revogada depois);
  // senão a mais recente ativa/validada do provider. Sempre escopada pela org.
  //
  // `order by created_at desc, id desc`: duas credenciais criadas no mesmo
  // instante não podem alternar entre chamadas — é a mesma ordem de
  // `lib/ai/credenciais/mais-recente.ts`, o resolvedor dos caminhos Supabase.
  const { rows: credRows } = override?.credentialId
    ? await db.query<{
        id: string;
        api_key_encrypted: unknown;
        api_key_iv: unknown;
        api_key_tag: unknown;
      }>(
        `select id, api_key_encrypted, api_key_iv, api_key_tag
         from ai_provider_credentials
         where organization_id = $1 and id = $2
           and is_active and validated_at is not null
         limit 1`,
        [organizationId, override.credentialId],
      )
    : await db.query<{
        id: string;
        api_key_encrypted: unknown;
        api_key_iv: unknown;
        api_key_tag: unknown;
      }>(
        `select id, api_key_encrypted, api_key_iv, api_key_tag
         from ai_provider_credentials
         where organization_id = $1 and provider = $2
           and is_active and validated_at is not null
         order by created_at desc, id desc
         limit 1`,
        [organizationId, provider],
      );

  const cred = credRows[0];
  if (cred === undefined) {
    // SEM DEGRAU ABAIXO. Aqui existiam três ramos que faziam a chave do `.env`
    // responder pela organização sem chave — a ADR-0005 os apagou, e a cerca
    // `tests/unit/ia-sem-chave-da-plataforma.test.ts` reprova a volta deles.
    throw new LlmNotConfiguredError();
  }
  const apiKey = decryptKey({
    ciphertext: byteaToBuffer(cred.api_key_encrypted),
    iv: byteaToBuffer(cred.api_key_iv),
    tag: byteaToBuffer(cred.api_key_tag),
  });
  const origemDaChave: OrigemDaChaveLlm = 'credencial_da_organizacao';

  // O ENDEREÇO do provedor personalizado (#1642), na mesma linha da chave que
  // acima. Query separada e condicionada ao provider: se o clone ainda não
  // aplicou a 0413, só este caminho novo sente a falta (o erro vira `null` e o
  // registry recusa a chamada com a frase certa) — os quatro nativos seguem sem
  // tocar numa coluna que ainda não existe.
  let baseUrl: string | null = null;
  if (provider === "custom") {
    try {
      const { rows: urlRows } = await db.query<{ base_url: string | null }>(
        `select base_url from ai_provider_credentials where id = $1 and organization_id = $2 limit 1`,
        [cred.id, organizationId],
      );
      baseUrl = urlRows[0]?.base_url ?? null;
    } catch {
      baseUrl = null;
    }
  }

  return {
    provider,
    apiKey,
    baseUrl,
    origemDaChave,
    defaultModel: settings.default_model ?? null,
    params: settings.params,
    enabledModels: settings.enabled_models,
    orcamento,
    orcamentoIndisponivelPorque,
  };
}
