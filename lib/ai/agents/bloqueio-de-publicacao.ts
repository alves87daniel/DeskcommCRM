/**
 * O QUE AINDA IMPEDE DE PUBLICAR O AGENTE — a régua do botão "Publicar".
 *
 * ─── Os dois defeitos que tiraram esta regra de dentro do componente ────────
 *
 * **1. A régua morava no componente, sem teste.** Ela perguntava por uma LINHA em
 * `ai_provider_credentials` (`findCredential(props.credentials, form.credential_id)`)
 * e, na época em que existia "a chave desta instalação" (um token que virava
 * `credential_id: null`), lia a ausência de linha como "não escolheu chave" e
 * travava o botão para sempre. A chave da instalação acabou (ADR-0005: toda
 * versão aponta para uma credencial da organização), mas a lição ficou: a régua
 * do botão é função pura, testada, e a tela só traduz o código em frase.
 *
 * **2. Faltar número não é o mesmo que faltar configuração.** Antes, o editor
 * tratava "nenhum número de WhatsApp escolhido" como erro de formulário, então
 * ele bloqueava o SALVAR também — numa instalação fresca, onde não existe número
 * nenhum, o dono não conseguia guardar uma linha do prompt que acabou de
 * escrever. Escolher o número é requisito para ATENDER, não para rascunhar: o
 * bloqueio vive aqui, do lado da publicação, e o `channel_session_id` virou
 * anulável no rascunho (migration 0239).
 *
 * ─── Por que função pura, fora do componente ────────────────────────────────
 *
 * Porque é a regra que decide se o agente entra no ar, e dentro do `useMemo` ela
 * não tinha um único teste. As mensagens continuam na tela (são texto de UI, e
 * passam pelo tradutor); daqui sai o CÓDIGO do motivo, que é o que se pode
 * cobrar num teste sem depender de redação.
 */

/** O estado de uma credencial da organização — espelha `credentialStatus`. */
export type EstadoDaCredencial =
  "validated" | "validating" | "unvalidated" | "invalid" | "inactive";

export interface ChaveDaVersao {
  /**
   * O estado da credencial da organização escolhida. `null` = nenhuma linha
   * casou com a escolha, ou seja, não há chave escolhida. Desde a ADR-0005 é a
   * ÚNICA origem possível: a opção "a chave desta instalação" saiu da tela
   * junto com a chave da instalação.
   */
  estadoDaCredencialDaOrg: EstadoDaCredencial | null;
}

export interface NumeroDaVersao {
  /**
   * O estado do canal, como vem de `channel_sessions.status`. `null` = nenhum
   * número escolhido ainda — rascunho legítimo, bloqueio só da publicação.
   */
  estado: string | null;
}

export interface EntradaDoBloqueio {
  /** Há rascunho VIGENTE para publicar (ver `versoes-da-tela.ts`). */
  temRascunhoVigente: boolean;
  /** O formulário passa nas próprias réguas de campo. */
  formularioValido: boolean;
  /** Há edição na tela que ainda não foi salva no rascunho. */
  alteracoesNaoSalvas: boolean;
  provedor: string;
  chave: ChaveDaVersao;
  numero: NumeroDaVersao;
}

export type MotivoDeBloqueio =
  | { codigo: "sem_rascunho" }
  | { codigo: "formulario_invalido" }
  | { codigo: "alteracoes_nao_salvas" }
  | { codigo: "sem_chave"; provedor: string }
  | { codigo: "chave_nao_utilizavel"; provedor: string; estado: EstadoDaCredencial }
  | { codigo: "sem_numero" }
  | { codigo: "numero_desconectado"; estado: string };

/**
 * O canal está de pé? O banco grava `WORKING` em maiúsculas (é o enum do provider do canal) e
 * parte do produto normaliza para minúsculas — as duas formas são o mesmo estado,
 * e exigir só uma delas reprovaria um número que está atendendo.
 */
function canalNoAr(estado: string): boolean {
  return estado.toUpperCase() === "WORKING";
}

/**
 * O primeiro motivo que impede a publicação, ou `null` quando nada impede.
 *
 * A ordem é a da tela, de fora para dentro: existe rascunho? ele é válido? está
 * salvo? tem cérebro (chave)? tem boca (número)? Devolver só o primeiro é
 * deliberado — a dica do botão é uma frase, e listar cinco pendências de uma vez
 * é o que faz ninguém ler nenhuma.
 */
export function bloqueioDePublicacao(e: EntradaDoBloqueio): MotivoDeBloqueio | null {
  if (!e.temRascunhoVigente) return { codigo: "sem_rascunho" };
  if (!e.formularioValido) return { codigo: "formulario_invalido" };
  if (e.alteracoesNaoSalvas) return { codigo: "alteracoes_nao_salvas" };

  const estado = e.chave.estadoDaCredencialDaOrg;
  if (estado === null) return { codigo: "sem_chave", provedor: e.provedor };
  if (estado !== "validated") {
    return { codigo: "chave_nao_utilizavel", provedor: e.provedor, estado };
  }

  if (e.numero.estado === null) return { codigo: "sem_numero" };
  if (!canalNoAr(e.numero.estado)) {
    return { codigo: "numero_desconectado", estado: e.numero.estado };
  }

  return null;
}
