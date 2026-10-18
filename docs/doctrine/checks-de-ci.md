# Os checks do CI — o que cada um mede

> Saiu do `CLAUDE.md` (seção Testes) no enxugamento da issue #17. A regra que fica lá: a lista de
> checks obrigatórios vem do comando, nunca de uma prosa. Este arquivo explica o que cada job mede
> e como perguntar ao workflow em vez de confiar num número.

## Quais são obrigatórios

Neste fork, os checks obrigatórios são os que a branch protection da `main` listar. Lista vazia
quer dizer nenhum:

```bash
gh api repos/alves87daniel/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

Pergunte de novo antes de citar a lista. As versões anteriores do `CLAUDE.md` envelheceram duas
vezes: uma dizia que o `e2e` não era obrigatório depois que ele passou a ser, e outra seguia
dizendo "quatro" depois que o `imagens-ok` entrou. Triagem que lê a lista velha mede contra a
régua errada.

## O que cada job mede

- **`verify`** (`ci.yml`) — **job de fachada** sobre a matriz `verify-parte`, como o
  `invariants`. Juntas, as partes rodam as cercas estruturais, typecheck, lint, `lint:channels`,
  a auditoria de `role-rank`, a guarda de colisão de migration, o `test:unit` dividido entre elas
  e o `test:shell`; alguns passos rodam só numa parte. `pnpm lint` sozinho cobre só o lint. Liste
  os passos e as condições em vez de acreditar nesta linha:

  ```bash
  awk '/^  verify-parte:/,/^  verify:/' .github/workflows/ci.yml | grep -E '^ +- name:'
  ```

- **`invariants`** (`ci.yml`) — **job de fachada**: não roda suíte nenhuma, só reprova quando a
  matriz `invariants-majors` não fecha em `success`. Quem roda é a matriz, uma perna por major do
  Postgres que o produto diz suportar. Cada perna faz duas passadas: `pnpm test:db` (baseline em
  modo install com `ON_ERROR_STOP=1` e em modo update, mais os invariantes, inclusive o isolamento
  RLS entre 2 organizações) e `pnpm test:db:update` (atualização de um banco COM dados). Quais
  majors hoje:

  ```bash
  awk '/^  invariants-majors:/,/^  [a-z-]+:/' .github/workflows/ci.yml | grep -A6 'matrix:'
  ```

- **`build-and-size`** (`perf.yml`) — `pnpm build` em Node 22.
- **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda todas as specs
  Playwright menos as que `FORA_DO_CI` declara. Só roda em PR que alcança algo que ele mede: PR só
  de documentação, teste de outra suíte, fragmento ou workflow alheio pula as partes (regra em
  `scripts/pr-alcanca-o-e2e.sh`; na dúvida, roda). Nesse caso o `e2e` verde não prova tela
  nenhuma.
- **`imagens-ok`** (`publish-image.yml`) — reprova quando qualquer uma das três imagens Docker não
  constrói.

## As specs do `e2e`: pergunte ao workflow

Não há número de specs aqui de propósito. O número que o `CLAUDE.md` trazia apodreceu cinco vezes
(a quinta em 2026-08-24, quando `inbox-quem-manda.spec.ts` entrou). Comando não envelhece.

Quais ficam fora, e por quê, é o que a própria variável `FORA_DO_CI` diz:

```bash
git show origin/main:.github/workflows/e2e.yml | \
  python3 -c "import sys,re; y=sys.stdin.read(); print(sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
```

Se a jornada de instalação fresca tem gate, quem responde é este, que diz quem o CI **invoca**:

```bash
git show origin/main:.github/workflows/e2e.yml | python3 -c "import sys,re; y=sys.stdin.read(); print('vps-fresh-onboarding no CI:', 'vps-fresh-onboarding.spec.ts' in {s for _,c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)})"
```

As duas saídas se fecham uma contra a outra porque `tests/unit/e2e-cobertura-completa.test.ts`
reprova spec que não esteja nem numa `SPECS_PARTE_*` nem na `FORA_DO_CI`, com motivo escrito.
Nenhuma spec cai no vão entre as duas.

Esta frase já envelheceu três vezes. Ela dizia que a única spec de fora era
`vps-fresh-onboarding` quando a variável já listava duas (2026-09-04, `inbox-tempo-real`). Depois
seguiu dizendo que a instalação fresca estava sem gate quando o #983 já a punha para rodar no CI,
com WAHA e Redis de verdade. Por isso ela virou comando.

O que não envelhece: `vps-fresh-onboarding` é a P0 da doutrina de QA Visual, porque a instalação
fresca é o produto que se vende. Ter gate não dispensa a prova pela tela (DoD 12). O gate prova que
não regrediu, não que a experiência ficou boa. E em PR que pula as partes, o verde não prova tela
nenhuma, a da instalação fresca inclusive.

## Não conte com `grep` no arquivo inteiro

`grep -oE '[a-z0-9-]+\.spec\.ts' .github/workflows/e2e.yml | sort -u | wc -l` conta quem é
CITADO, não quem é INVOCADO: a `FORA_DO_CI` é uma variável YAML como as outras e entra na conta.
Medido, o conjunto de specs citadas fora de variável é vazio. O que roda são as `SPECS_PARTE_*`:

```bash
ls tests/e2e/*.spec.ts | wc -l                    # quantas existem
python3 - <<'PY'                                  # quantas o CI invoca
import re
y = open(".github/workflows/e2e.yml", encoding="utf-8").read()
print(len({s for _, c in re.findall(r'(SPECS_PARTE_\d+):\s*>-\n((?:[ ]{8,}.*\n)+)', y)
             for s in re.findall(r'[a-z0-9-]+\.spec\.ts', c)}))
PY
```

## Por que não há número nesta prosa

Pôr a prosa sob gate (fazer `tests/unit/e2e-cobertura-completa.test.ts` cobrar também o texto) era
o conserto pedido. Tirar o número é melhor e mais barato: não há o que policiar, e a diferença entre
disco e CI segue vigiada onde importa, no próprio teste, que reprova toda spec nova fora de
`SPECS_PARTE_*` ou de `FORA_DO_CI`. Prosa que nenhum gate lê diverge; prosa que não afirma número
não tem como divergir.
