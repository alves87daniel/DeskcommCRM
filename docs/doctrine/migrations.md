# Migrations — numeração, permissões de função e leitura do baseline

> Saiu do `CLAUDE.md` (seção Migrations & Banco) no enxugamento da issue #19. O processo e as
> regras ficam lá; este arquivo guarda o procedimento detalhado, a medição e o porquê.

## Numeração

**Arquivo versionado** em `supabase/migrations/` com o padrão do repo: `<timestamp>_<NNNN>_<slug>.sql` (ex.: `20260706210000_0027_whatsapp_conversation_unification.sql`). `NNNN` é o próximo número sequencial — e **não** é o do último arquivo da listagem:

```bash
# A POPULAÇÃO da pergunta: main do PRODUTO (o remoto que aponta para
# alves87daniel/DeskcommCRM, com qualquer nome) + TODO PR ABERTO, inclusive de
# fork. O `ls` abaixo mede o DISCO, que responde uma pergunta menor.
pnpm checar:colisao-de-migration   # declara o que mediu e o que não mediu
```

Se a leitura for manual, três coisas são obrigatórias: um `git fetch` antes (a árvore em dia
não é a main atual), `git ls-tree` da main do PRODUTO e não `ls` do disco, e o `NNNN` tirado
com a **âncora do nome canônico** aplicada ao nome **sem a pasta** —
`sed 's#.*/##' | sed -nE 's#^[0-9]{14}_([0-9]{4})_.*#\1#p'`. O
`ls | grep -oE '_[0-9]{4}_'` que estava no CLAUDE.md pegava um `_NNNN_` do SLUG (com
`…_0326_relatorio_2024_anual.sql` o teto virava 2024) e media a árvore de
trabalho, onde a 0336 já podia estar reservada por um PR aberto (#1273).

O `checar` mede o arquivo que você **já** acrescentou: sem migration nova, ele responde
`OK — nenhuma migration acrescentada` e não dá número. Crie o arquivo com um número provisório
e rode; ou, para alocar antes, use a enumeração do que está em voo em `triagem/TRIAGEM.md`
(modo de falha 37). O teto é a main **mais** tudo em voo, em NNNN **e** em timestamp.

O nome do arquivo começa pelo **timestamp**, e timestamp e `NNNN` podem discordar: em
09/09/2026 o `ls | tail -1` devolvia o `_0230_` (timestamp de 07/09) enquanto o maior `NNNN`
era `_0231_` (timestamp de 05/09). Um contribuidor externo seguiu a instrução antiga ao pé da
letra, escolheu `0231`, e o `manifest-x-migrations` reprovou o PR dele por colisão — a
instrução é que estava errada, não ele. Ordene pelo número, nunca pela listagem.

**E o número livre hoje pode estar tomado quando o seu PR entrar.** A colisão só aparece
quando o SEGUNDO PR de schema é mesclado — medido em 19/09/2026: **11 PRs abertos colidiam
com a `main` com os cinco checks obrigatórios verdes**. O `verify` **já executa** a guarda
(`pnpm checar:colisao-de-migration`, o alias de `scripts/checar-colisao-de-migration.sh` —
procurar pelo nome do arquivo no `ci.yml` devolve zero e mente), e mesmo assim os 12 passaram:
cada um mediu a `main` do dia em que rodou — o `verify` do #965 terminou em 16/09 e segue verde.
Por isso há duas camadas a mais: o CI reprova quando **um número deste PR foi tomado** por
migration que entrou na base depois da prévia (colisão, nunca atraso — PR atrasado e sem colisão
segue verde), e fora de `pull_request` ele varre a árvore inteira — nenhum `NNNN` nem timestamp pode aparecer duas vezes na `main`. Antes de escolher o número quando houver outros PRs de schema em voo, peça-o
a quem estiver alocando na rodada: **não há reserva, quem mescla primeiro fica com o número**.
Para ver o que está tomado agora, incluindo o que ainda não foi mesclado:

```bash
pnpm checar:colisao-de-migration          # mede o SEU PR contra origin/main
```

## As duas origens de `EXECUTE` (passo 9)

Toda `create function` no schema `public` termina com:

```sql
revoke execute on function public.fn_x(...) from public, anon;
grant  execute on function public.fn_x(...) to <só quem precisa>;
```

São duas origens distintas de `EXECUTE`, e tratar só uma deixa a função exposta com o gate verde: **(A)** o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do baseline, que vale para toda função criada depois dele — isto é, para todo apêndice novo — e que `revoke from public` **não** remove; **(B)** o grant a `PUBLIC` que o Postgres dá a qualquer função ao criá-la, que `revoke from anon` **não** remove. Sem os dois, o PostgREST expõe a função como RPC alcançável pela anon key, que vai para o browser. Vigiado por `tests/invariants/hardening-definer-varredura.test.ts`, que varre todas as `security definer` de `public` (issue #128 — a versão anterior checava uma lista fixa de 6, e 8 de 25 estavam expostas).

## No `baseline.sql` vale a última definição (passo 10)

**Ler o baseline com `grep` no arquivo inteiro mede a definição ERRADA.** O
`baseline.sql` é dump + apêndice, então a mesma função aparece **várias
vezes** — e quem vale é a **última**, porque o arquivo é aplicado inteiro e
em ordem. Medido em 2026-09-20: `fn_meet_action` tinha **quatro**
definições; a primeira (o corpo do dump) ainda trazia `errcode='40001'` nas
três recusas permanentes, e a última — a que o banco instala — trazia
`PT409`. Uma sonda de `grep`/`awk` ancorada na primeira ocorrência afirmou
sobre o produto o oposto do que o produto faz. O mesmo vale para
`fn_lgpd_cascade_redact_contact`, que tem oito.

**As duas formas certas**, e a primeira decide:

```bash
# (a) PERGUNTE AO BANCO, depois de aplicar — é o que o cliente terá
pnpm test:db tests/invariants/<um caso que consulte>  # ou, num psql já com o baseline aplicado:
psql "$URL" -Atc "select pg_get_functiondef(p.oid) from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='fn_x'"
```

```bash
# (b) ANCORE NA ÚLTIMA definição, quando só o arquivo estiver à mão
python3 -c "
s=open('supabase/baseline.sql').read()
i=s.rfind('create or replace function public.fn_x')   # rfind, nunca find
print(s[i:s.index('\$\$;', i)+3])"
```

Contar ocorrências no arquivo inteiro responde _"o arquivo menciona"_, nunca
_"o banco faz"_. As duas perguntas divergem sempre que há apêndice — e
apêndice é o mecanismo padrão desta casa.
