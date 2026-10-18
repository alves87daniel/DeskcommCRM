# Auth dual na API — cookie ou bearer, rota por rota

> Saiu do `CLAUDE.md` (seção API REST) no enxugamento da issue #21. A regra fica lá, em uma linha com
> ponteiro para cá; este arquivo guarda o detalhe, a medição e o porquê.

- **Auth dual é a direção do produto, e ela se cumpre rota por rota.** Cookie de sessão para o
  frontend; `Authorization: Bearer dsk_...` (linha de `api_tokens`, resolvida no servidor) para
  chamada de servidor. O prefixo é **`dsk_`**, e quem o exige é `lib/mcp/auth.ts` — `tok_` nunca
  existiu no código e estava escrito aqui, em `AGENTS.md` e na Spec 09 até 17/09/2026
  - O helper é `lib/api/auth-dual.ts`, e habilitar uma rota é **por rota**: não há chave geral.
    Para saber quais já aceitam bearer — o número muda, o comando não:
    `git grep -ln "auth-dual" -- app/api/v1` (mais `app/api/v1/contacts/route.ts`, que implementou
    o padrão inline e deu origem ao helper)
  - **Chamar o helper na rota não basta:** o `proxy.ts` global roda antes de qualquer handler e só
    reconhece cookie. Sem uma entrada em `lib/auth/public-paths.ts` para o caminho, todo bearer
    recebe 401 do proxy antes de chegar ao handler. "Público" ali quer dizer "o proxy não decide",
    nunca "sem autenticação"
  - Decisão do dono do produto em 17/09/2026: **converter as rotas que cada integração precisar**,
    conforme aparecerem, em vez de namespace paralelo por cliente. Uma rota convertida serve a todo
    integrador. Contexto: PR #1008, que escreveu 26 rotas paralelas porque não achou por onde entrar
