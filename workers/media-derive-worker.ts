/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";
import type pg from "pg";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";
import { resolveOrgLlmConfig, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createPool } from "@/lib/agent-engine/db/pool";
import { env } from "@/lib/env";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { deriveVideoText } from "@/lib/messaging/media/video-derive";
import {
  apiTranscriptionProvider,
  idiomasDaTranscricao,
  modeloDeTranscricaoEmVigor,
} from "@/lib/messaging/media/transcription";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";
import { DETALHE_TECNICO } from "@/lib/event-log/aviso-de-evento-morto";

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

// Lista compartilhada com o drain do turno — ver lib/messaging/media/derivable.ts.

// ponytail: singleton lazy — o drain só nos dá o admin client; resolveOrgLlmConfig
// exige pg.Pool direto. Sem pool global no processo Next.js, então criamos um sob
// demanda (nunca no import). `pg.Pool` só conecta na primeira query — se
// SUPABASE_DB_URL faltar, o erro aparece ali (capturado pelo try/catch abaixo),
// não na construção.
let _pool: pg.Pool | null = null;
function derivePool(): pg.Pool {
  if (!_pool) _pool = createPool(process.env.SUPABASE_DB_URL ?? "");
  return _pool;
}

interface MessageRow {
  id: string;
  organization_id: string;
  type: string;
  media_mime: string | null;
  media_storage_path: string | null;
  media_derived_status: string | null;
}

export async function deriveMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_DERIVE_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, type, media_mime, media_storage_path, media_derived_status")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageRow | null;
  if (!msg) return { consumer_key, status: "skipped", detail: "no media" };

  // Desistir DE PROPÓSITO grava `skipped` (terminal em DERIVACAO_TERMINADA).
  // Sem a marca, a linha ficava com status null para sempre e o drain do turno,
  // que espera a mídia da CONVERSA, segurava a resposta do texto seguinte até o
  // teto de 120s por uma leitura que nunca ia acontecer.
  const markSkipped = async (detail: string): Promise<HandlerResult> => {
    await admin.from("messages")
      .update({ media_derived_status: "skipped" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "skipped", detail };
  };

  if (!msg.media_storage_path) return markSkipped("no media");
  if (msg.media_derived_status === "ready") return { consumer_key, status: "skipped", detail: "already derived" };
  if (!TIPOS_DERIVAVEIS.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };
  // Vídeo é opt-in (custo: ffmpeg + N chamadas de visão): só deriva se algum agente
  // publicado da org tem video_frames_enabled=true (flag da migration 0058).
  if (msg.type === "video") {
    const { data: flag } = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("status", "published")
      .eq("video_frames_enabled", true)
      .limit(1)
      .maybeSingle();
    if (!flag) return markSkipped("video_frames_disabled");
  }

  /** O que o operador chama de "isto" — o aviso não pode falar em `msg.type`. */
  const rotuloDoTipo =
    ({ image: "imagem", audio: "áudio", document: "documento", video: "vídeo" } as Record<
      string,
      string
    >)[msg.type] ?? "mídia";

  // Grava o MARCADOR junto do `failed`, e é o que separa "o agente não sabe que
  // existe arquivo" de "o agente sabe que não conseguiu ler".
  //
  // Sem ele, `get-lead-context` cai no marcador de tipo — `[documento]` — que
  // diz que veio um arquivo e não diz que a leitura falhou. Medido numa VPS em
  // produção (17/09): um PDF de catálogo, sem camada de texto, falhou no
  // extrator; o agente recebeu `[documento]` e respondeu ao cliente que o
  // material "parece ser de distribuidora/promocional" — uma afirmação sobre um
  // conteúdo que ele nunca leu. As RECUSAS já entregavam este marcador há
  // tempos (`MARCADOR_NAO_LIDA`, seis caminhos); só a falha permanente não
  // entregava, e é justamente a que erra por invenção em vez de silêncio.
  //
  // O turno que já rodou não volta atrás — o dreno tem teto de espera. O que
  // isto conserta é todo turno seguinte da conversa, que lê o histórico.
  const markFailed = async () => {
    await admin.from("messages")
      .update({ media_derived_text: MARCADOR_NAO_LIDA, media_derived_status: "failed" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Só knobs: a chave de visão sai da credencial da organização, dentro de
    // `resolveOrgLlmConfig` (ADR-0005 — não existe chave da instalação).
    const llmCfg: LlmEdgeConfig = { cacheTtl: "1h" };

    // ─── O painel de provedores manda AQUI também ────────────────────────────
    //
    // `visao_de_imagem` está no registro de pontos, sem `fixo`, e fora dos
    // pontos governados pela versão publicada — ou seja, a tela o oferece como
    // editável. Enquanto este worker resolvia só pela config da organização, o
    // operador escolhia um modelo com visão, a tela dizia "salvo", a linha
    // entrava em `ai_purpose_bindings` e a descrição de imagem seguia usando o
    // modelo padrão. É textualmente a classe de defeito que
    // `lib/ai/gateway-binding.ts` declara ter vindo matar — três pontos foram
    // fechados e este ficou igual.
    //
    // ⚠️ Resolver primeiro o padrão da organização falha quando a org não tem
    // credencial padrão (ex.: onboarding com google/gemini sem chave), mesmo com
    // `visao_de_imagem` configurado e ativo com OpenAI/Anthropic (#1591). Por
    // isso, tentamos primeiro o binding de visão; se ele não existir ou falhar,
    // caímos no padrão da organização.
    const bindingDaVisao = await lerBindingDoPonto(admin, row.organization_id, "visao_de_imagem");
    // A `base_url` do binding de visão, para descer até o factory do provedor.
    //
    // ⚠️ O ponto `visao_de_imagem` aceita um endpoint próprio (é o que o painel
    // de Provedores oferece), e o TURNO DO AGENTE já o honra: `run-model-call`
    // chama `factory(config.apiKey, model, decisao.baseUrl ?? undefined)`. Aqui
    // a chamada era `factory(llm.apiKey, llm.defaultModel ?? "")`, sem o
    // terceiro argumento — então quem apontava o binding para um gateway
    // compatível via o factory cair no OPENROUTER_ENDPOINT e a derivação falhar
    // (ou pior: ir para a internet com a chave do operador), enquanto o mesmo
    // binding funcionava no chat. Um caminho só: a base_url lida aqui é a mesma
    // que o turno usa.
    let baseUrlDaVisao: string | null = null;
    let llm: Awaited<ReturnType<typeof resolveOrgLlmConfig>> | null = null;

    if (bindingDaVisao) {
      try {
        const comBinding = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: bindingDaVisao.provider,
          credentialId: bindingDaVisao.credential_id,
        });
        llm = { ...comBinding, defaultModel: bindingDaVisao.model_id };
        // Só vale se a credencial do binding resolveu: no catch abaixo o worker
        // volta para o padrão da org, e aí o endpoint do padrão é o correto.
        baseUrlDaVisao = bindingDaVisao.base_url;
      } catch (err) {
        // Binding apontando para provedor sem chave não pode derrubar a
        // derivação inteira: cai no padrão da organização e AVISA, que é o
        // desfecho que deixa rastro em vez de silêncio.
        logger.warn("[media-derive] binding de visão sem credencial utilizável; usando o padrão da org", {
          organization_id: row.organization_id,
          provider: bindingDaVisao.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!llm) {
      llm = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);
    }

    // A transcrição NÃO usa a chave do provedor de conversa: o ponto "Ouvir o
    // áudio do cliente" tem serviço padrão próprio (a API de transcrição da
    // OpenAI, com a credencial OpenAI da organização) e aceita o binding do
    // painel — credencial `custom` com endereço (Groq, gateway, máquina própria)
    // e o modelo de lá (ADR-0005, item 18 da #33). Numa org com Anthropic, a
    // chave da Anthropic mandada para a OpenAI voltava 401 em toda tentativa.
    const transcricao = await resolverTranscricao(admin, llmCfg, row.organization_id, llm);

    // O 5º argumento é a `base_url` do binding: o factory precisa dela para não
    // cair no endpoint padrão do provedor (ver o comentário lá em cima). A chave
    // que vai com ela é SEMPRE da organização (ADR-0005), então a recusa antiga
    // "endereço da empresa com chave da instalação" (decisão 22-a) não tem mais
    // caso: não há chave alheia que possa sair para o endereço escolhido por ela.
    const deps = buildDeriveDeps(llm, transcricao, row.organization_id, admin, baseUrlDaVisao);

    const text = await deriveMediaText(msg.type, buffer, msg.media_mime ?? "application/octet-stream", deps);
    await admin.from("messages")
      .update({ media_derived_text: text, media_derived_status: "ready" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts >= DRAIN_MAX_ATTEMPTS - 1) {
      logger.error("[media-derive] failed permanently", { message_id: msg.id, detail });
      await markFailed();
      // ─── E AVISA. Desistir calado era o desfecho mais comum ────────────────
      //
      // As recusas que este worker já sabia explicar — modelo sem visão,
      // provedor indisponível, falta de chave da OpenAI para transcrever —
      // abrem `midia_nao_lida` lá embaixo, e por isso pareciam cobrir o
      // assunto. Não cobriam: o que estoura como EXCEÇÃO (credencial recusada,
      // modelo que a conta não pode usar, tempo esgotado, e também o download
      // do Storage que falhou) cai aqui, marcava `failed` e não dizia nada.
      //
      // Medido numa VPS em produção (org real, 14/09): quatro imagens JPEG com
      // `media_derived_status='failed'`, os quatro eventos mortos em
      // `event_log` com "The model `claude-sonnet-5` does not exist or you do
      // not have access to it" — e a Central com ZERO avisos de mídia.
      //
      // O QUE A CENTRAL MOSTRA NESTA TENTATIVA: dois avisos, não um. Este
      // handler devolve `error` na tentativa em que `drainEventLog` desiste
      // (`row.attempts + 1 >= 5`, o mesmo limiar de `DRAIN_MAX_ATTEMPTS`), e o
      // dreno abre `event_dead` para o evento morto. Cada um só abre se não
      // houver outro da mesma família aberto na organização — então, numa pane,
      // são no máximo um de cada. O `event_dead` diz que um processamento
      // parou; este diz o que fazer (a orientação da política aponta
      // Provedores de IA).
      //
      // O marcador de "não consegui interpretar" agora É gravado por
      // `markFailed` — a consequência é a mesma das recusas dali em diante. O
      // que continua valendo é o turno que já correu: ele seguiu sem o texto,
      // dentro do teto de espera do dreno do agent-engine, e por isso a frase
      // fala do PRÓXIMO turno, não do que passou.
      //
      // O `detail` entra porque é a frase do PROVEDOR, e é ela que distingue
      // "chave errada" de "modelo que sua conta não assina" — duas ações
      // diferentes para quem opera. Mas entra no FIM, como detalhe técnico:
      // é inglês de API, e quem lê a Central não programa.
      await avisarMidiaNaoLida(
        msg.organization_id,
        rotuloDoTipo,
        "a leitura deu erro em todas as tentativas, ao abrir o arquivo ou ao chamar o provedor de IA",
        "O conteúdo do arquivo não chegou ao agente. Da próxima mensagem em diante ele sabe que houve um arquivo que não deu para ler, e responde avisando em vez de supor o que estava nele.",
        detail.slice(0, 200),
      );
    }
    return { consumer_key, status: "error", detail };
  }
}

/**
 * Lê o binding de um ponto. Fora do `gateway-binding.ts` de propósito: aquele
 * módulo devolve um `LanguageModel` pronto do SDK, e aqui o que se precisa é do
 * par provider/modelo/credencial para alimentar `resolveOrgLlmConfig`, que é
 * quem sabe decifrar a chave BYOK desta organização.
 */
async function lerBindingDoPonto(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  purpose: string,
): Promise<{
  provider: string;
  model_id: string;
  credential_id: string | null;
  base_url: string | null;
} | null> {
  const { data, error } = await admin
    .from("ai_purpose_bindings")
    .select("provider, model_id, credential_id, base_url")
    .eq("organization_id", organizationId)
    .eq("purpose", purpose)
    .eq("is_enabled", true)
    .maybeSingle();
  if (error) {
    logger.warn("[media-derive] não consegui ler o binding do ponto", {
      organization_id: organizationId,
      purpose,
      error: error.message,
    });
    return null;
  }
  return (
    (data as {
      provider: string;
      model_id: string;
      credential_id: string | null;
      base_url: string | null;
    } | null) ?? null
  );
}

/** Chave, endereço e modelo com que o áudio desta organização é transcrito. */
interface ServicoDeTranscricao {
  apiKey: string;
  baseUrl: string | null;
  model: string;
}

/**
 * O serviço de transcrição da organização: o binding do ponto
 * `transcricao_de_audio` quando existe e a credencial dele resolve (endereço
 * do binding, ou o da credencial `custom`; modelo do binding); senão o padrão
 * do ponto — a credencial OpenAI mais recente da organização, no endpoint da
 * OpenAI, com `TRANSCRIPTION_MODEL` ou `whisper-1`. `null` quando não há
 * credencial nenhuma: o áudio fica sem transcrição, com aviso.
 */
async function resolverTranscricao(
  admin: ReturnType<typeof createAdminClient>,
  llmCfg: LlmEdgeConfig,
  organizationId: string,
  /** A config já resolvida para a visão/conversa: quando é OpenAI, a chave serve e poupa uma ida ao banco. */
  llm: { provider: string; apiKey: string },
): Promise<ServicoDeTranscricao | null> {
  const binding = await lerBindingDoPonto(admin, organizationId, "transcricao_de_audio");
  if (binding) {
    try {
      const cfg = await resolveOrgLlmConfig(derivePool(), llmCfg, organizationId, {
        provider: binding.provider,
        credentialId: binding.credential_id,
      });
      return { apiKey: cfg.apiKey, baseUrl: binding.base_url ?? cfg.baseUrl ?? null, model: binding.model_id };
    } catch (err) {
      // Binding apontando para credencial que não resolve não pode calar o
      // áudio: cai no padrão do ponto e AVISA — rastro em vez de silêncio.
      logger.warn("[media-derive] binding de transcrição sem credencial utilizável; usando o padrão do ponto", {
        organization_id: organizationId,
        provider: binding.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const model = modeloDeTranscricaoEmVigor({ model: env.TRANSCRIPTION_MODEL });
  if (llm.provider === "openai") return { apiKey: llm.apiKey, baseUrl: null, model };
  try {
    const oa = await resolveOrgLlmConfig(derivePool(), llmCfg, organizationId, { provider: "openai" });
    return { apiKey: oa.apiKey, baseUrl: null, model };
  } catch {
    return null;
  }
}

function buildDeriveDeps(
  llm: { provider: string; apiKey: string; defaultModel: string | null },
  transcricao: ServicoDeTranscricao | null,
  orgId: string,
  admin: ReturnType<typeof createAdminClient>,
  // Endpoint próprio do binding de visão, quando houver. `null` = usa o padrão
  // do provedor, que é o comportamento do turno do agente sem `baseUrl`.
  baseUrlDaVisao: string | null = null,
): DeriveDeps {
  const registry = createDefaultRegistry();
  // Thunk, não consulta: nada vai ao banco até a visão ser de fato perguntada,
  // e num provedor direto `visaoEmVigor` nem pergunta.
  //
  // ⚠️ Por que a consulta é escrita aqui, e também em `media-parts.ts`, em vez de
  // morar num helper compartilhado: casar o client do Supabase contra a interface
  // estreita de um helper faz o checador estourar em TS2589 ("type instantiation
  // is excessively deep") — é o parser de colunas do PostgREST, não uma
  // incompatibilidade real. E ele estoura de forma DESIGUAL: `tsc --noEmit`
  // passava e o `next build` reprovava, no mesmo arquivo e na mesma linha, o que
  // torna o helper uma armadilha que só aparece no CI. O que precisava ser único
  // é a REGRA, e ela é: `visaoEmVigor` decide, aqui e em `media-parts.ts`.
  const catalogo = async (): Promise<boolean | null> => {
    const { data } = await admin
      .from("ai_models")
      .select("supports_vision")
      .eq("provider", llm.provider)
      .eq("model_id", llm.defaultModel ?? "")
      .is("deprecated_at", null)
      .maybeSingle();
    return data?.supports_vision ?? null;
  };
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    // ⚠️ A resposta é resolvida AQUI, não na montagem das deps, porque num
    // roteador ela depende do catálogo e a consulta é assíncrona. Antes disto
    // a pergunta ia direto ao registro, que num roteador responde pelo prefixo
    // do fabricante: `openai/gpt-3.5-turbo` era dado como capaz de ver, a
    // chamada de visão saía e o aviso ao operador nunca abria.
    const visao = await visaoEmVigor({
      provider: llm.provider,
      modelId: llm.defaultModel ?? "",
      catalogo,
    });
    const visionCapable = visao.enxerga;
    // ─── Falha VISÍVEL, não string vazia ────────────────────────────────────
    //
    // Antes daqui, modelo sem visão devolvia "" e pronto: o cliente mandava a
    // foto do produto ou o comprovante, o agente respondia como se nada tivesse
    // chegado, e não havia erro, log nem aviso em lugar nenhum. Para quem
    // instalou, o produto parecia estar ignorando o cliente de propósito.
    //
    // Agora o texto derivado DIZ que a mídia não pôde ser lida — o agente passa
    // a saber que recebeu algo que não consegue interpretar, em vez de achar
    // que a mensagem veio vazia — e um aviso abre na Central para o operador
    // poder agir (invariante 7 da doutrina do Sistema Vivo: todo laço se fecha).
    if (!visionCapable) {
      // "não sei" e "não consegue" são estados diferentes, e o aviso precisa
      // dizer qual é. Um modelo que este registro não conhece cai em
      // `{image:false}` por conservadorismo — afirmar ao operador que ele "não
      // enxerga imagens" seria gravar uma alegação que ninguém verificou (e
      // era o que acontecia com todo modelo da OpenRouter).
      const motivo = visao.sabemos
        ? `o modelo ${llm.defaultModel ?? "configurado"} não enxerga imagens`
        : `não sei se o modelo ${llm.defaultModel ?? "configurado"} enxerga imagens, ` +
          `então não arrisquei enviar a foto — escolha um modelo do catálogo em Agente de IA → Provedores`;
      await avisarMidiaNaoLida(orgId, "imagem", motivo);
      return MARCADOR_NAO_LIDA;
    }
    // O endereço é escolhido por quem administra a instalação (o campo de
    // endereço do binding) e a chamada leva a chave do provedor no cabeçalho:
    // sem esta recusa, um destino interno — o metadata da nuvem, o Postgres do
    // compose — recebe credencial da instalação e ainda pode devolver resposta
    // forjada ao agente. Mesma recusa das saídas de webhook, e antes de a
    // chave sair daqui.
    if (baseUrlDaVisao) {
      const recusa = await motivoDaRecusaDeDestino(baseUrlDaVisao, "organizacao");
      if (recusa) {
        await avisarMidiaNaoLida(
          orgId,
          "imagem",
          "o endereço configurado para a visão não foi aceito como destino, então não enviei a imagem nem a chave para lá — confira o endereço do provedor em Agente de IA e Provedores; endereço escolhido pela empresa não pode apontar para a rede interna do servidor",
          undefined,
          recusa,
        );
        return MARCADOR_NAO_LIDA;
      }
    }
    const factory = registry[llm.provider];
    if (!factory) {
      await avisarMidiaNaoLida(orgId, "imagem", `o provedor ${llm.provider} não está disponível nesta instalação`);
      return MARCADOR_NAO_LIDA;
    }
    const res = await generateText({
      model: factory(llm.apiKey, llm.defaultModel ?? "", baseUrlDaVisao ?? undefined),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva objetivamente esta imagem em 1-2 frases, em português, para um atendente de vendas entender o que o cliente enviou." },
            // AI SDK v7: file part com mediaType (o antigo image part é deprecated).
            { type: "file", data: buffer, mediaType: mime.split(";")[0]! },
          ],
        },
      ],
    });
    return res.text;
  };
  // Sem chave OpenAI não há como transcrever: devolver string vazia é honesto
  // (o derivado fica vazio e o marcador "[áudio]" continua valendo) e evita o
  // loop de 401 que retentava a cada drain.
  const semTranscricao: DeriveDeps["transcriber"] = {
    transcribe: async () => {
      // Mesma razão da visão: devolver "" fazia o agente responder ao áudio
      // como se ele não existisse. O aviso é o que dá ao operador a chance
      // de cadastrar a chave — sem ele, o sintoma é indistinguível de "o
      // agente é ruim".
      await avisarMidiaNaoLida(
        orgId,
        "áudio",
        "falta uma credencial para transcrever: a OpenAI da organização, ou um serviço compatível apontado em Ouvir o áudio do cliente",
      );
      return MARCADOR_NAO_LIDA;
    },
  };
  // Chave, endereço e modelo vêm de `resolverTranscricao` — o padrão do ponto
  // (credencial OpenAI da organização) ou o binding do painel (ADR-0005, item 18
  // da #33). O "serviço de transcrição do `.env`" (chave e endereço próprios da
  // instalação) saiu com a chave da instalação: era a chave de uma conta
  // transcrevendo o áudio de todas as organizações; o `update.sh` migra esse
  // par para uma credencial `custom` da organização do dono. Ficam no `.env`
  // só os knobs sem chave — `TRANSCRIPTION_MODEL` (aplicado ao padrão) e
  // `TRANSCRIPTION_LANGUAGES`.
  const idiomas = idiomasDaTranscricao(env.TRANSCRIPTION_LANGUAGES);
  const transcriber: DeriveDeps["transcriber"] = transcricao
    ? apiTranscriptionProvider({
        apiKey: transcricao.apiKey,
        model: transcricao.model,
        languages: idiomas,
        ...(transcricao.baseUrl ? { baseUrl: transcricao.baseUrl } : {}),
      })
    : semTranscricao;
  return {
    transcriber,
    describeImage,
    extractPdf: extractPdfText,
    // Onda 3.1: vídeo → ffmpeg (áudio+frames) reusando transcrição e visão da org.
    deriveVideo: (buffer) => deriveVideoText(buffer, { transcriber, describeImage }),
  };
}

/**
 * O texto que substitui a string vazia quando a mídia não pôde ser lida.
 *
 * Não é cosmético: o agente recebe este texto como derivado da mensagem, então
 * ele passa a SABER que chegou algo que não conseguiu interpretar, em vez de
 * concluir que a mensagem veio vazia. A diferença aparece na resposta ao
 * cliente — "não consegui abrir sua foto, pode me dizer o que é?" no lugar de
 * um silêncio que parece descaso.
 */
export const MARCADOR_NAO_LIDA = "[o cliente enviou uma mídia que não consegui interpretar]";

/**
 * Abre UM aviso na Central por organização enquanto o problema durar.
 *
 * Um aviso por mensagem inundaria a Central numa operação com volume — e
 * Central inundada é Central que ninguém abre, que é como o alerta morre. A
 * condição de não-duplicar é a mesma que `budget_exceeded` já usa: enquanto
 * houver item aberto do mesmo kind, recusas novas não criam outro.
 *
 * Fire-and-forget: falhar ao avisar não pode derrubar a derivação da mídia.
 */
/**
 * O título e o corpo do aviso `midia_nao_lida`. Primeiro o que houve e o que
 * fazer, em português; a frase crua do provedor, quando existe, no fim e
 * rotulada (`DETALHE_TECNICO`) — mesma regra do aviso de evento morto.
 */
export function textoDoAvisoDeMidiaNaoLida(aviso: {
  tipo: string;
  motivo: string;
  consequencia: string;
  detalheTecnico?: string;
}): { title: string; body: string } {
  return {
    title: `O agente não conseguiu ler ${aviso.tipo} que o cliente enviou`,
    body:
      `Motivo: ${aviso.motivo}. ${aviso.consequencia} ` +
      `Para resolver, ajuste o modelo desse ponto em Agente de IA → Provedores, ou cadastre a chave necessária em Credenciais.` +
      (aviso.detalheTecnico ? ` ${DETALHE_TECNICO} ${aviso.detalheTecnico}` : ""),
  };
}

async function avisarMidiaNaoLida(
  organizationId: string,
  tipo: string,
  motivo: string,
  /**
   * O que aconteceu com o atendimento. O padrão vale para as recusas, que
   * entregam o marcador ao agente; a falha permanente não entrega nada.
   */
  consequencia = "Enquanto isso, o agente responde avisando que não conseguiu abrir o arquivo.",
  /** A frase crua do provedor ou do armazenamento, quando houver — vai no fim, rotulada. */
  detalheTecnico?: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "midia_nao_lida")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    // `warn`, não `warning`: o CHECK de `agent_inbox_items.severity` aceita
    // info|warn|critical. Com o valor errado o INSERT era recusado com 23514 —
    // e o aviso NUNCA abria. A Central ficava vazia exatamente no caso que esta
    // função existe para tornar visível.
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "midia_nao_lida",
      severity: "warn",
      ...textoDoAvisoDeMidiaNaoLida({ tipo, motivo, consequencia, detalheTecnico }),
    });
    // E o retorno é CONFERIDO. O supabase-js devolve `{ error }` em vez de
    // lançar, então o `catch` abaixo era inalcançável para erro de banco: a
    // recusa era engolida, o worker devolvia "ok" e nada era logado. Um aviso
    // que falha em silêncio é pior que aviso nenhum — ele faz o próximo
    // diagnóstico começar da premissa errada.
    if (error) {
      logger.warn("[media-derive] o banco recusou o aviso de mídia não lida", {
        organization_id: organizationId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[media-derive] não consegui abrir o aviso de mídia não lida", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
