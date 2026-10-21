#!/usr/bin/env bash
# Prova de `recusar_segredo_hmac_do_waha` (_common.sh) e de onde o install.sh e o
# update.sh a chamam.
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
# toda mensagem recebida no WhatsApp. O `lib/env.ts` aceita qualquer string e o
# install.sh preserva o valor que já existe, então o caminho é real (apontado no
# PR #44).
#
# O kit recusa ANTES de o WAHA receber o valor: o install.sh antes de escrever o
# .env, o update.sh antes de mexer em qualquer coisa.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# Roda a função com o segredo dado. Devolve o código; a mensagem vai para $ERR.
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
nao_vaza() {  # a mensagem fala do tamanho, nunca do valor
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
echo "── install.sh"
check "chama a guarda depois de gerar o segredo que falta" antes "$I_GERA" "$I_CHAMA"
check "chama a guarda antes de escrever o .env" antes "$I_CHAMA" "$I_ESCREVE"

UPDATE="$KIT_DIR/update.sh"
U_CHAMA="$(linha_de "$UPDATE" 'recusar_segredo_hmac_do_waha')"
U_PROCURA="$(linha_de "$UPDATE" '^step "Procurando atualizações"')"
U_SOBE="$(linha_de "$UPDATE" '(^|[^a-z_])dc up -d')"
echo "── update.sh"
check "chama a guarda antes de procurar versão (nada foi mexido ainda)" antes "$U_CHAMA" "$U_PROCURA"
check "chama a guarda antes de recriar os contêineres" antes "$U_CHAMA" "$U_SOBE"

echo
if [ "$FAILS" -eq 0 ]; then echo "segredo-hmac-do-waha: tudo verde"; else echo "segredo-hmac-do-waha: $FAILS falha(s)"; fi
[ "$FAILS" -eq 0 ]
