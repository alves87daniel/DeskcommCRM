#!/usr/bin/env bash
# Prova de `recusar_segredo_hmac_do_waha` e `consertar_segredo_hmac_do_waha`
# (_common.sh), e de onde o install.sh e o update.sh as chamam.
#
#   bash tests/shell/segredo-hmac-do-waha.test.sh
#
# ── O defeito que ele guarda ────────────────────────────────────────────────
#
# Desde a issue #40 o compose entrega WAHA_HMAC_SECRET ao WAHA em
# WHATSAPP_HOOK_HMAC_KEY, e o WAHA passa a assinar toda entrega de webhook com
# ele. Do outro lado, `lib/waha/webhook-auth.ts` descarta segredo com menos de 16
# caracteres depois de `trim()` (MIN_SECRET_LEN) e recusa toda entrega ASSINADA
# como `bad_signature` — mesmo com a exigência de assinatura desligada. Um .env
# antigo com segredo curto, vazio ou com espaço nas pontas pararia, em silêncio,
# toda mensagem recebida no WhatsApp (apontado no PR #44).
#
# O install.sh RECUSA antes de escrever o .env: quem instala está diante da tela.
# O update.sh CONSERTA: gera um segredo novo, grava no .env e recria o app e o
# WAHA juntos — quem atualiza é o agent.sh, sem ninguém olhando, e a doutrina de
# packaging proíbe atualização que peça edição do .env.
#
# O caminho inteiro do update.sh, com o dublê de docker, está em
# hostgator-setup-kit/test-validators.sh ("update.sh conserta o WAHA_HMAC_SECRET").
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── A regra (a do install.sh) ────────────────────────────────────────────────
# Roda a guarda com o segredo dado. Devolve o código; a mensagem vai para $ERR.
ERR=""
avaliar() {  # avaliar <segredo>
  local rc
  ERR="$( (
    # shellcheck source=/dev/null
    . "$KIT_DIR/_common.sh" >/dev/null 2>&1
    set +e
    WAHA_HMAC_SECRET="$1" recusar_segredo_hmac_do_waha
  ) 2>&1 >/dev/null )"
  rc=$?
  return $rc
}
aceita() { avaliar "$1"; }
recusa() { ! avaliar "$1"; }
mensagem_explica() {  # a recusa diz qual variável, qual regra e como gerar outro
  case "$ERR" in *WAHA_HMAC_SECRET*) ;; *) return 1 ;; esac
  case "$ERR" in *"16 caracteres"*) ;; *) return 1 ;; esac
  case "$ERR" in *"openssl rand -hex 32"*) ;; *) return 1 ;; esac
}
nao_vaza() {  # a mensagem existe, fala do tamanho e nunca do valor
  [ -n "$ERR" ] || return 1
  case "$ERR" in *"$1"*) return 1 ;; esac
}

echo "── A regra: 16 caracteres ou mais, sem espaço nas pontas"
check "vazio é recusado" recusa ""
check "a recusa explica variável, regra e conserto" mensagem_explica
check "15 caracteres é recusado" recusa "abcdefghijklmno"
check "a recusa diz o tamanho e não mostra o segredo" nao_vaza "abcdefghijklmno"
check "16 caracteres passa (o piso de MIN_SECRET_LEN)" aceita "abcdefghijklmnop"
check "64 hex (o que o install.sh gera) passa" aceita "$(printf 'a%.0s' $(seq 1 64))"
check "espaço na ponta é recusado (o WAHA assina cru, o CRM confere aparado)" recusa " abcdefghijklmnop"
check "16 caracteres só depois de aparar é recusado" recusa "abcdefghijklmno "
check "o \\r de um .env com CRLF não conta como espaço" aceita "abcdefghijklmnop"$'\r'

# ── O conserto (o do update.sh) ──────────────────────────────────────────────
# Roda o conserto sobre um .env com o segredo dado. RC, saída e o .env depois
# ficam em $C_RC, $C_OUT e no próprio arquivo.
C_RC=0; C_OUT=""
consertar() {  # consertar <arquivo .env> <segredo carregado na memória>
  C_OUT="$( (
    # shellcheck source=/dev/null
    . "$KIT_DIR/_common.sh" >/dev/null 2>&1
    set +e
    WAHA_HMAC_SECRET="$2" consertar_segredo_hmac_do_waha "$1"
  ) 2>&1 )"
  C_RC=$?
}
segredo_no_env() { grep -E '^WAHA_HMAC_SECRET=' "$1" | sed 's/^WAHA_HMAC_SECRET=//'; }
uma_linha_so() { [ "$(grep -c '^WAHA_HMAC_SECRET=' "$1")" -eq 1 ]; }
eh_64_hex() { printf '%s' "$1" | grep -qxE '[0-9a-f]{64}'; }

ENV1="$WORK/curto.env"
printf 'INTERNAL_SECRET=fica\nWAHA_HMAC_SECRET=curto\nAPP_NAME=Loja\n' > "$ENV1"
consertar "$ENV1" "curto"
NOVO="$(segredo_no_env "$ENV1")"
echo "── O conserto: segredo curto"
check "devolve 0 (trocou — quem chama recria app e WAHA)" test "$C_RC" -eq 0
check "o .env passa a ter um segredo de 64 hex" eh_64_hex "$NOVO"
check "com uma linha só de WAHA_HMAC_SECRET" uma_linha_so "$ENV1"
check "as outras chaves ficam como estavam" grep -qx 'INTERNAL_SECRET=fica' "$ENV1"
check "e a outra também" grep -qx 'APP_NAME=Loja' "$ENV1"
check "o aviso existe e diz o tamanho do velho" grep -q '5 caractere(s)' <<<"$C_OUT"
nao_contem() { case "$C_OUT" in *"$1"*) return 1 ;; esac; }
check "o aviso não mostra o segredo novo" nao_contem "$NOVO"
check "o aviso não mostra o segredo velho" nao_contem "curto"

ANTES="$(cat "$ENV1")"
consertar "$ENV1" "$NOVO"
echo "── O conserto é idempotente"
check "na segunda passada devolve 1 (nada a fazer)" test "$C_RC" -eq 1
check "e o .env não muda" test "$(cat "$ENV1")" = "$ANTES"
check "e não avisa nada" test -z "$C_OUT"

ENV2="$WORK/sem-chave.env"
printf 'INTERNAL_SECRET=fica\n' > "$ENV2"
consertar "$ENV2" ""
echo "── O conserto: chave ausente e espaço nas pontas"
check "sem a chave, ela é criada com 64 hex" eh_64_hex "$(segredo_no_env "$ENV2")"
ENV3="$WORK/espaco.env"
printf 'WAHA_HMAC_SECRET= abcdefghijklmnop\n' > "$ENV3"
consertar "$ENV3" " abcdefghijklmnop"
check "com espaço na ponta, troca" test "$C_RC" -eq 0
ENV4="$WORK/bom.env"
printf 'WAHA_HMAC_SECRET=abcdefghijklmnop\r\n' > "$ENV4"
ANTES4="$(cat "$ENV4")"
consertar "$ENV4" "abcdefghijklmnop"$'\r'
check "um segredo bom num .env com CRLF não é trocado" test "$C_RC" -eq 1
check "e o .env fica intacto" test "$(cat "$ENV4")" = "$ANTES4"

# ── Onde os scripts chamam ───────────────────────────────────────────────────
# Linha (não comentada) da primeira ocorrência de um padrão; vazio se não há.
linha_de() {  # linha_de <arquivo> <padrão ERE>
  grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}
antes() {  # antes <a> <b>: a existe, b existe, a < b
  [ -n "$1" ] && [ -n "$2" ] && [ "$1" -lt "$2" ]
}

INSTALL="$KIT_DIR/install.sh"
I_GERA="$(linha_de "$INSTALL" ':[[:space:]]+"\$\{WAHA_HMAC_SECRET:=')"
I_CHAMA="$(linha_de "$INSTALL" 'recusar_segredo_hmac_do_waha')"
I_ESCREVE="$(linha_de "$INSTALL" 'envq WAHA_HMAC_SECRET')"
echo "── install.sh recusa"
check "chama a guarda depois de gerar o segredo que falta" antes "$I_GERA" "$I_CHAMA"
check "chama a guarda antes de escrever o .env" antes "$I_CHAMA" "$I_ESCREVE"

UPDATE="$KIT_DIR/update.sh"
U_CONSERTA="$(linha_de "$UPDATE" 'consertar_segredo_hmac_do_waha')"
U_RECRIA="$(linha_de "$UPDATE" 'dc up -d --no-deps --force-recreate app waha')"
U_PROCURA="$(linha_de "$UPDATE" '^step "Procurando atualizações"')"
U_RECUSA="$(linha_de "$UPDATE" 'recusar_segredo_hmac_do_waha')"
echo "── update.sh conserta"
check "chama o conserto antes de procurar versão (vale também para 'já está na mais recente')" antes "$U_CONSERTA" "$U_PROCURA"
check "recria app e WAHA logo depois do conserto, antes de procurar versão" antes "$U_CONSERTA" "$U_RECRIA"
check "e a recriação vem antes de procurar versão" antes "$U_RECRIA" "$U_PROCURA"
check "não recusa mais (a recusa é só do install.sh)" test -z "$U_RECUSA"

echo
if [ "$FAILS" -eq 0 ]; then echo "segredo-hmac-do-waha: tudo verde"; else echo "segredo-hmac-do-waha: $FAILS falha(s)"; fi
[ "$FAILS" -eq 0 ]
