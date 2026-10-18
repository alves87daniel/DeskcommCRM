---
name: deskcomm-ler-suite
description: 'Como ler o resultado da suíte de testes do DeskcommCRM sem falso verde. USE SEMPRE que for rodar pnpm test:unit, interpretar o rodapé do Vitest, contar falhas, explicar um exit 1 com 0 failed, ou antes de dizer que a suíte passou. Cobre o recorte de tests/unit, o log cortado, Failed Suites, a linha Errors e o vermelho local do rate-limit sem Redis.'
---

# Ler a suíte sem falso verde

> A regra mora no `CLAUDE.md` (seção Testes): a suíte é `pnpm test:unit` sem caminho, e os
> invariantes rodam à parte, em `pnpm test:db`. Esta skill é o procedimento para ler o resultado.
> **O exit code é a autoridade; o rodapé e o `grep` são explicação dele.**

## 1. Rode a suíte, não o recorte

O script `test:unit` é `vitest run` **sem caminho**, e ele alcança o repositório inteiro, inclusive
os testes que moram ao lado do código em `lib/`, `app/`, `components/` e `hooks/`. Medido em
2026-08-28: `vitest run` alcançava 566 arquivos e `tests/unit/` tinha 388. Os 178 de fora eram 133
em `lib/`, 37 em `app/`, 3 em `components/`, 1 em `hooks/` e 4 em `tests/`.

Quem roda `vitest run tests/unit` obtém um verde menor e mais fácil sem perceber. Já aconteceu num
PR: a suíte foi reportada verde, e o verde era do recorte.

Também não troque a suíte pelos gates que você lembra: `typecheck`, `lint`, `lint:channels` e os
arquivos de cerca podem estar todos verdes com a suíte vermelha, porque nenhum deles toca o
arquivo que quebrou.

## 2. Não corte a saída

`| tail -8` guarda o rodapé e joga fora os nomes dos arquivos que falharam, que são o único dado
que permite reconciliar depois. Redirecione e filtre:

```bash
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2                   # ← a AUTORIDADE
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c   # arquivos + contagem
```

## 3. Compare o rodapé com o `grep`

O `grep FAIL` pode devolver vazio **com** falhas. Sem TTY, o reporter padrão às vezes imprime só o
resumo: uma rodada com `3 failed` produziu um log de 629 bytes sem nenhum `FAIL`, e esse vazio lê
igual a "nenhuma falha".

Compare a linha certa. `Test Files N failed` conta ARQUIVOS; `Tests N failed` conta CASOS; o
`uniq -c` do `grep` soma CASOS. O controle é contra `Tests`:

```bash
r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/vt.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"   # têm de bater
```

Comparar contra `Test Files` dá divergência falsa: `2 failed` de arquivos contra `7` de casos
parece defeito da sonda e é só régua trocada.

## 4. Se não baterem, olhe `Failed Suites` antes de culpar a sonda

Falha de coleta ou de hook entra numa seção própria, `Failed Suites`. Ela soma às linhas `FAIL`
sem entrar no rodapé de casos:

```bash
grep -aoE "Failed Suites [0-9]+" /tmp/vt.log | grep -oE "[0-9]+"   # > 0 ⇒ arquivo/suíte falhou SEM ser por caso
grep -aqE "^ *Test Files" /tmp/vt.log && echo "log inteiro" || echo "log truncado — o zero não vale"
```

O segundo comando é necessário porque a seção só aparece quando existe falha de suíte; log
truncado ou comando que não rodou também devolvem zero. Com `Failed Suites` > 0 e log inteiro, a
conta fecha: `Tests failed` + `Failed Suites` = `grep FAIL`. A causa (sintaxe na coleta ou
`Hook timed out` em `beforeAll`) está no próprio log.

Só quando as seções também não explicarem a divergência, diagnostique "sonda cega" e rode de novo
com `--reporter=verbose`.

## 5. Exit 1 com tudo verde: leia a linha `Errors`

O Vitest sai com `exit=1` quando há **erro não tratado** durante a execução, mesmo com todos os
testes passando. Esse erro aparece numa terceira linha do rodapé, que nenhuma das sondas acima lê:

```
 Test Files  866 passed (866)
      Tests  8904 passed | 1 expected fail (8905)
     Errors  1 error          ← só o exit code viu isto
```

Medido em 2026-09-15: `EnvironmentTeardownError: [vitest-worker]: Closing rpc while
"onUserConsoleLog" was pending`, sob carga. Rodapé `0 failed`, `grep FAIL` vazio, exit 1. Quando o
exit diverge dos dois, leia a linha antes de concluir qualquer coisa:

```bash
grep -aE "^ *Errors " /tmp/vt.log      # vazio é o esperado
```

## 6. Vermelho local que não é seu: `rate-limit.test.ts`

`lib/ai/dispatcher/rate-limit.test.ts` falha em 5 casos, com 15s de timeout cada, quando o
`.env.local` tem `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` e o Redis para o qual eles
apontam **não está de pé** (neste repo é o `serverless-redis-http` local, não a nuvem).

O `tests/setup/vitest.setup.ts` carrega o `.env.local` para dentro do `process.env`, e o módulo só
usa o contador em memória quando essas variáveis estão **ausentes**. Provado nos dois sentidos. No
CI não há `UPSTASH` nenhum, então lá o caminho é o contador em memória e o arquivo passa.

Para confirmar que é isso: suba o Redis local, ou rode o arquivo sem as duas variáveis no ambiente.

## 7. O que relatar

No PR ou no resumo, relate as três coisas juntas: o exit code, a linha `Tests` do rodapé e, se
houver falha, os arquivos do `grep FAIL`. Se alguma delas não bate com as outras, diga qual seção
explicou a diferença (`Failed Suites` ou `Errors`), ou diga que a diferença ficou sem explicação.
