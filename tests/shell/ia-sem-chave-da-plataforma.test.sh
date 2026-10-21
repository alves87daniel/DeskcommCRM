#!/usr/bin/env bash
# Prova das funções da ADR-0005 em `hostgator-setup-kit/_common.sh`, com o
# banco e o docker substituídos por dublês — nada aqui toca a máquina de quem
# roda.
#
#   bash tests/shell/ia-sem-chave-da-plataforma.test.sh
#
# O que está sob prova:
#   1. `esvaziar_chaves_de_ia_migradas` (update.sh, D4): esvazia UMA variável
#      por provedor, só quando a organização do dono tem credencial ativa e
#      validada daquele provedor; a variável sem credencial fica, com aviso;
#      `AI_GATEWAY_API_KEY` sai só com credencial do provedor de conversa; rodar
#      duas vezes não muda nada. Caso de duas chaves e só uma migrada.
#   2. `cadastrar_credencial_de_ia_do_dono` (install.sh, D5): o plaintext entra
#      pelo STDIN e NUNCA aparece nos argumentos do docker; o INSERT leva os
#      hex da cifra, é `on conflict ... do nothing` e escopa a organização do
#      dono pelo e-mail.
#   3. `credencial_validada_do_dono`: sem conexão de banco, "não sei" é "não tem".
#   4. O install.sh e o update.sh CHAMAM as funções (ponto de chamada).
# A instalação de ponta a ponta com o dublê (instala, cadastra, roda de novo sem
# perguntar) mora em hostgator-setup-kit/test-validators.sh.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublê de docker: o cifrador responde hex; o psql registra o SQL e responde
# o "banco" (um arquivo com os provedores que TÊM credencial validada) ─────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *" --entrypoint node "*)
    # O plaintext chega pelo stdin; o dublê não o ecoa — só confirma que chegou.
    [ -t 0 ] || { n="$(wc -c < /dev/stdin)"; printf '%s\n' "$n" > "$DOCKER_LOG.stdin-bytes"; }
    printf 'deadbeef00 cafe0000 f00d0000 1234\n'; exit 0 ;;
  *" psql "*)
    # Só o INSERT chega pelo stdin (heredoc); a consulta vem em `-c`, e ler o
    # stdin nela travaria o dublê num terminal sem fim de arquivo.
    case "$*" in *" -c "*) ;; *) [ -t 0 ] || cat >> "$SQL_LOG" ;; esac
    printf '%s\n' "$*" >> "$SQL_LOG"
    case "$*" in *"count(*) from public.ai_provider_credentials"*)
      # Um banco que responde lixo (erro de conexão no stdout, por exemplo).
      [ -n "${BANCO_RESPOSTA_CRUA:-}" ] && { printf '%s\n' "$BANCO_RESPOSTA_CRUA"; exit 0; }
      for p in $(cat "$BANCO" 2>/dev/null); do
        case "$*" in *"c.provider = '$p'"*) printf '1\n'; exit 0 ;; esac
      done
      printf '0\n'; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"
export DOCKER_LOG="$WORK/docker.log" SQL_LOG="$WORK/sql.log" BANCO="$WORK/banco.txt"

# As funções sob prova, com o `t` do kit (idioma) e o `pg_container` real — que
# chama o `docker` do PATH, isto é, o dublê.
# shellcheck source=../../hostgator-setup-kit/_common.sh
. "$KIT_DIR/_common.sh"
export SUPABASE_DB_URL='postgresql://u:p@db.exemplo:5432/postgres'

novo_env() {
  cat > "$WORK/.env" <<'ENV'
OWNER_EMAIL="dono@exemplo.com.br"
AI_PROVIDER="anthropic"
ANTHROPIC_API_KEY="sk-ant-antiga"
OPENAI_API_KEY="sk-openai-antiga"
OPENROUTER_API_KEY=""
AI_GATEWAY_API_KEY="gw-antiga"
OUTRA="fica"
ENV
}
valor() { valor_no_envfile "$WORK/.env" "$1"; }

echo "1. esvaziar_chaves_de_ia_migradas — duas chaves, só uma migrada"
novo_env
printf 'anthropic\n' > "$BANCO"
: > "$SQL_LOG"
saida="$(esvaziar_chaves_de_ia_migradas "$WORK/.env" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')"
check "ANTHROPIC_API_KEY esvaziada (credencial anthropic existe)" test -z "$(valor ANTHROPIC_API_KEY)"
check "a linha continua DECLARADA no .env" grep -q '^ANTHROPIC_API_KEY=' "$WORK/.env"
check "OPENAI_API_KEY fica (sem credencial openai)" test "$(valor OPENAI_API_KEY)" = "sk-openai-antiga"
check "AI_GATEWAY_API_KEY sai: o provedor de conversa (anthropic) tem credencial" test -z "$(valor AI_GATEWAY_API_KEY)"
check "as outras linhas não mudam" test "$(valor OUTRA)" = "fica"
check "o aviso diz QUAL variável ainda falta" bash -c "printf '%s' \"\$1\" | grep -q 'OPENAI_API_KEY (openai)'" _ "$saida"
check "o aviso NÃO cita a que já foi esvaziada como faltando" bash -c "! printf '%s' \"\$1\" | grep -q 'ANTHROPIC_API_KEY (anthropic)'" _ "$saida"
check "a pergunta ao banco escopa a organização do DONO pelo e-mail" grep -q "u.email = 'dono@exemplo.com.br'" "$SQL_LOG"
antes="$(cat "$WORK/.env")"
esvaziar_chaves_de_ia_migradas "$WORK/.env" >/dev/null 2>&1
check "rodar de novo não muda nada (idempotente)" test "$antes" = "$(cat "$WORK/.env")"

echo "2. esvaziar_chaves_de_ia_migradas — as duas migradas"
novo_env
printf 'anthropic\nopenai\n' > "$BANCO"
saida="$(esvaziar_chaves_de_ia_migradas "$WORK/.env" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')"
check "ANTHROPIC_API_KEY esvaziada" test -z "$(valor ANTHROPIC_API_KEY)"
check "OPENAI_API_KEY esvaziada" test -z "$(valor OPENAI_API_KEY)"
check "sem aviso de falta" bash -c "! printf '%s' \"\$1\" | grep -q 'Ainda com valor'" _ "$saida"

echo "3. esvaziar_chaves_de_ia_migradas — o gateway segue sem credencial do provedor de conversa"
novo_env
sed -i 's/^AI_PROVIDER=.*/AI_PROVIDER="openrouter"/' "$WORK/.env"
printf 'anthropic\nopenai\n' > "$BANCO"
saida="$(esvaziar_chaves_de_ia_migradas "$WORK/.env" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')"
check "AI_GATEWAY_API_KEY fica: o provedor de conversa (openrouter) não tem credencial" test "$(valor AI_GATEWAY_API_KEY)" = "gw-antiga"
check "o aviso nomeia o gateway e o provedor que falta" bash -c "printf '%s' \"\$1\" | grep -q 'AI_GATEWAY_API_KEY (openrouter)'" _ "$saida"

echo "4. cadastrar_credencial_de_ia_do_dono — o plaintext não sai pelo argv"
: > "$DOCKER_LOG"; : > "$SQL_LOG"; rm -f "$DOCKER_LOG.stdin-bytes"
export AI_CRED_AES_KEY="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
printf 'sk-ant-segredo-nunca-no-argv\n' | cadastrar_credencial_de_ia_do_dono anthropic "dono@exemplo.com.br" "ghcr.io/x/app:1.2.3" >/dev/null 2>&1
rc=$?
check "a função termina bem" test "$rc" = 0
check "o cifrador roda na IMAGEM DO APP pinada, com entrypoint node" grep -q -- '--entrypoint node ghcr.io/x/app:1.2.3' "$DOCKER_LOG"
check "o plaintext chegou ao cifrador pelo stdin" test -s "$DOCKER_LOG.stdin-bytes"
check "o plaintext NUNCA aparece nos argumentos do docker" bash -c "! grep -q 'sk-ant-segredo' \"\$DOCKER_LOG\""
check "o INSERT leva os hex da cifra" grep -q "decode('deadbeef00', 'hex')" "$SQL_LOG"
check "o INSERT é idempotente pela restrição única" grep -q "on conflict (organization_id, provider, label) do nothing" "$SQL_LOG"
check "a credencial nasce ativa e validada" grep -q "true, now(), u.id" "$SQL_LOG"
check "escopada pela organização do dono, pelo e-mail" grep -q "u.email = 'dono@exemplo.com.br'" "$SQL_LOG"
check "o plaintext NUNCA aparece no SQL" bash -c "! grep -q 'sk-ant-segredo' \"\$SQL_LOG\""

echo "5. credencial_validada_do_dono — não sei é não tem"
# `nao` roda num shell NOVO que carrega o kit de novo: `bash -c` não herda
# função, e um `! comando-inexistente` passaria por vacuidade (medido: foi
# assim que a primeira versão destes casos ficou verde sem medir nada). Por
# isso o shell novo confere que a função EXISTE antes de negá-la.
nao() {  # nao <ambiente extra> <args da função>
  bash -c ". '$KIT_DIR/_common.sh'; $1; type credencial_validada_do_dono >/dev/null 2>&1 || exit 99; ! credencial_validada_do_dono $2" </dev/null
}
printf 'openai\n' > "$BANCO"
check "sem conexão de banco no ambiente devolve 1" nao "unset SUPABASE_DB_URL SUPABASE_DB_ADMIN_URL" "openai dono@exemplo.com.br"
check "sem e-mail devolve 1" nao ":" "openai ''"
check "com credencial do provedor devolve 0" credencial_validada_do_dono openai "dono@exemplo.com.br"
check "sem credencial do provedor devolve 1" nao ":" "anthropic dono@exemplo.com.br"
check "resposta que não é número devolve 1" nao "export BANCO_RESPOSTA_CRUA='psql: error: connection refused'" "openai dono@exemplo.com.br"
check "controle: o shell novo enxerga a função (senão os casos acima seriam vazios)" bash -c ". '$KIT_DIR/_common.sh'; type credencial_validada_do_dono >/dev/null"
check "controle: o shell novo reprova quando a função está lá e o banco diz que tem" bash -c "! ( . '$KIT_DIR/_common.sh'; ! credencial_validada_do_dono openai dono@exemplo.com.br )" </dev/null

echo "6. pontos de chamada"
check "o update.sh esvazia as chaves migradas antes de recriar o app" bash -c "a=\$(grep -n 'esvaziar_chaves_de_ia_migradas .env' '$KIT_DIR/update.sh' | head -1 | cut -d: -f1); b=\$(grep -n '^# ── 5. App novo' '$KIT_DIR/update.sh' | cut -d: -f1); [ -n \"\$a\" ] && [ -n \"\$b\" ] && [ \"\$a\" -lt \"\$b\" ]"
check "o install.sh não grava chave de IA no .env (as quatro saem vazias)" bash -c "grep -qE 'envq ANTHROPIC_API_KEY \"\"' '$KIT_DIR/install.sh' && grep -qE 'envq OPENAI_API_KEY \"\"' '$KIT_DIR/install.sh' && grep -qE 'envq OPENROUTER_API_KEY \"\"' '$KIT_DIR/install.sh' && grep -qE 'envq AI_GATEWAY_API_KEY \"\"' '$KIT_DIR/install.sh'"
check "o install.sh cadastra as chaves colhidas como credencial do dono" grep -q 'cadastrar_credencial_de_ia_do_dono "\$prov" "\$OWNER_EMAIL"' "$KIT_DIR/install.sh"
check "o install.sh pergunta ao banco antes de perguntar a chave (idempotência)" grep -q 'credencial_validada_do_dono "\$_prov"' "$KIT_DIR/install.sh"
check "pendencia_da_ia lê o banco, não o .env" bash -c "sed -n '/^pendencia_da_ia()/,/^}/p' '$KIT_DIR/install.sh' | grep -q 'credencial_validada_do_dono' && ! sed -n '/^pendencia_da_ia()/,/^}/p' '$KIT_DIR/install.sh' | grep -q 'ANTHROPIC_API_KEY'"

if [ "$FAILS" -gt 0 ]; then printf '\n%d caso(s) vermelho(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
