# ADR-GREEN-001 - Deskcomm como fundação congelada do ConectorGreen

- **Status:** aceito em 2026-10-04 pelo dono do produto
- **Data:** 2026-10-04
- **Contexto medido em:** `38e2f16cd987ff3b627dbb266ed9631a142cf486` (fonte congelada da GREEN-BASELINE-1.0, branch
  `release/green-baseline-1.0`), sobre o upstream `melgarafael/DeskcommCRM` v1.69.0
  (`e8e2912178031d321caf0912b270ee06bd2c36c7`); estado do upstream lido no mesmo dia pela API pública do GitHub
- **Fonte de verdade da fundação:** [`docs/green/GREEN-BASELINE-1.0.md`](../green/GREEN-BASELINE-1.0.md)
- **Backlog que esta decisão não resolve:** [`docs/green/PRODUCTION-READINESS.md`](../green/PRODUCTION-READINESS.md)

Numeração: as ADRs do ConectorGreen usam o prefixo `GREEN-` para nunca disputar número com as ADRs `0001`-`0004`
herdadas do Deskcomm (nem com as que o upstream ainda venha a escrever).

---

## Contexto

O ConectorGreen precisava de uma base de CRM multi-tenant com RLS, barramento de eventos, automação, agentes de IA e
WhatsApp. Em vez de escrever essa base do zero, o Deskcomm (MIT, `melgarafael/DeskcommCRM`) foi avaliado como
fundação. A avaliação não foi de leitura: cinco frentes de spike construíram o domínio Green por cima do Deskcomm
v1.69.0 e mediram, com a mesma suíte nas duas versões, se o produto herdado aguentava as garantias que o
ConectorGreen exige.

| Frente                  | Migration(s) | Relatório final                                                                       |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------- |
| Mutation Boundary       | 0501, 0502   | [`GREEN-MUTATION-CONTEXT-V3.md`](../spike/GREEN-MUTATION-CONTEXT-V3.md)               |
| Lead Lifecycle          | 0503-0505    | [`GREEN-LEAD-LIFECYCLE-V1.3.md`](../spike/GREEN-LEAD-LIFECYCLE-V1.3.md)               |
| Green Automation Origin | 0506         | [`GREEN-AUTOMATION-ORIGIN-V1.md`](../spike/GREEN-AUTOMATION-ORIGIN-V1.md)             |
| Structural Boundary     | 0507         | [`GREEN-STRUCTURAL-BOUNDARY-V1.md`](../spike/GREEN-STRUCTURAL-BOUNDARY-V1.md)         |
| Canonical Event Cutover | 0508         | [`GREEN-CANONICAL-EVENT-CUTOVER-V1.md`](../spike/GREEN-CANONICAL-EVENT-CUTOVER-V1.md) |

As cinco foram seladas. A GREEN-BASELINE-1.0 as trata como uma única fundação e repetiu a regressão sobre o conjunto
([`VALIDATION-CLOSURE.md`](../green/VALIDATION-CLOSURE.md)).

Enquanto a validação acontecia, o upstream seguiu andando, e o ritmo dele é um fato que pesa na decisão:

| Fato medido em 2026-10-04                                                                                                                                                                                                              | Onde                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| O upstream publicou v1.70.0, v1.71.0 e v1.72.0 nos quatro dias seguintes à v1.69.0; a `main` dele está 984 commits à frente da fundação                                                                                                | `gh api repos/melgarafael/DeskcommCRM/releases` e `compare` |
| O upstream já tem 27 migrations acima da 0500 (até a 0542). Seis números colidem com a cadeia Green (0501, 0502, 0503, 0504, 0506, 0508)                                                                                               | `gh api .../contents/supabase/migrations`                   |
| Três **timestamps** colidem, e timestamp é a chave primária de `supabase_migrations.schema_migrations`: `20260930180000` (as duas 0501), `20261003200000` (Green 0506 x upstream 0529) e `20261004090000` (Green 0507 x upstream 0533) | idem                                                        |
| A cadeia Green alterou 25 arquivos de código do upstream (rotas de lead, transporte do Supabase, motor de automação, dispatcher, runtime de IA) e acrescentou um bloco de 3497 linhas ao `baseline.sql`                                | `git diff --stat e8e29121 38e2f16c`                         |

Seguir esse upstream por merge ou rebase recorrente significaria reabrir, a cada release, os contratos que as
spikes selaram, e disputar número e timestamp de migration com um projeto que não sabe do Green.

## Decisão

> Não seguimos o upstream do Deskcomm. Observamos o upstream.

### D1 - O Deskcomm v1.69.0 é a fundação histórica, congelada

O ConectorGreen nasce de `e8e2912178031d321caf0912b270ee06bd2c36c7` (Deskcomm v1.69.0) mais a cadeia Green 0501-0508.
Esse é o ancestral; não é uma dependência de produto que será sincronizada. A fase de avaliação de compatibilidade
com o Deskcomm está encerrada.

### D2 - Sem merge nem rebase recorrente do upstream

- Nenhum `git merge`/`git rebase` da `main` do upstream na `main` do ConectorGreen.
- Paridade com o Deskcomm não é critério de produto, e divergência (fork drift) não é critério de FAIL.
- A regra "toda branch se mantém atualizada com a `main`" do [`CLAUDE.md`](../../CLAUDE.md) passa a se referir à `main`
  do ConectorGreen, nunca à do upstream.

### D3 - Observar releases do upstream

Cada release nova do Deskcomm é lida (CHANGELOG, migrations novas, alertas de segurança) e recebe uma das três
decisões: **portar**, **adaptar** ou **ignorar**, registrada com o motivo. Ignorar é uma decisão válida e o caso
comum.

### D4 - Portar é seletivo e precisa de benefício concreto

Uma mudança do upstream só entra quando traz benefício concreto para o ConectorGreen. Critérios, em ordem:

1. **Segurança** (vulnerabilidade, RLS, privilégio, vazamento de dado): sempre avaliada; entra quando o caminho
   afetado existe no ConectorGreen.
2. **Correção de defeito** num caminho que o ConectorGreen usa.
3. **Dependência** (bump com correção de segurança ou fim de suporte).
4. **Capacidade** que o roadmap do ConectorGreen pediu explicitamente.

E, para entrar, o porte:

- vem por `cherry-pick` ou adaptação manual, num PR próprio, citando o commit/PR de origem no upstream;
- **migration do upstream nunca entra com o nome de origem**: ganha o próximo número e um timestamp novo da sequência
  do ConectorGreen (a partir da 0509), com linha no MANIFEST e apêndice no `baseline.sql` como manda a doutrina de
  migrations;
- não altera migration já aplicada (0501-0508 incluídas) e não reabre contrato selado: se o porte tocar arquivo do
  domínio Green (lista em [`GREEN-BASELINE-1.0.md`](../green/GREEN-BASELINE-1.0.md), seção 5), ele roda as suítes Green
  seladas, a `test:db` inteira e os E2Es Green antes do merge;
- muda contrato Green só por decisão explícita, registrada como nova ADR `GREEN-NNN`.

### D5 - Segurança e dependências são responsabilidade do ConectorGreen

Correções de segurança e atualização de dependências deixam de chegar "de graça" pelo upstream. O ConectorGreen
responde por elas: o upstream é uma fonte de alertas, não um fornecedor de patches. Até existir um processo próprio,
o mínimo é a triagem de D3 com prioridade para os itens de segurança.

### D6 - Os nomes de spike ficam na história

As migrations 0501-0508, os commits e os relatórios em `docs/spike/` mantêm os nomes `spike_*`: eles registram como a
decisão foi alcançada e não são renomeados nem reescritos. Documentação nova trata o resultado como **ConectorGreen**,
não como experimento sobre o Deskcomm.

## Consequências

- **Upgrade suportado:** a origem suportada é uma instalação Deskcomm **v1.69.0** (ou um banco novo). Uma instalação
  Deskcomm v1.70.0 ou posterior tem schema que o ConectorGreen não tem (e números de migration que colidem); levá-la ao
  ConectorGreen é migração de dados sob medida, fora desta decisão.
- **Guardas herdadas apontam para o upstream:** `pnpm checar:colisao-de-migration`, o workflow
  `.github/workflows/vigia-de-colisao.yml`, a conferência do kit em `scripts/conferir-isolamento-do-kit.sh` e os
  comandos de branch protection citados no `CLAUDE.md` medem `melgarafael/DeskcommCRM`. Precisam ser reapontados para o
  ConectorGreen antes de valerem como gate aqui (registrado no backlog de produção).
- **CI:** o repositório `alves87daniel/DeskcommCRM` é um fork sem GitHub Actions habilitado e sem branch protection;
  os workflows herdados também publicam imagens e cortam releases em nome do upstream. Ligar o CI do ConectorGreen é
  decisão do dono, com os workflows revisados antes (backlog de produção).
- **Licença:** o Deskcomm é MIT; o aviso de copyright do `LICENSE` permanece em toda distribuição do ConectorGreen.
- **Custo aceito:** melhorias do upstream não chegam sozinhas. Cada porte é trabalho deliberado, e o drift cresce a
  cada release que não vale portar. Esse é o preço de não reabrir os contratos selados a cada release.
- **Ganho:** a fundação deixa de ser alvo móvel. O que foi provado em 0501-0508 continua provado até que o próprio
  ConectorGreen decida mudar.

## Alternativas recusadas

| Alternativa                                           | Por que não                                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acompanhar o upstream por merge/rebase a cada release | Três releases em quatro dias; cada merge reabre os 25 arquivos de código tocados pela cadeia Green e disputa número e timestamp de migration (seis números e três timestamps já colidem) |
| Contribuir o domínio Green de volta ao upstream       | O domínio Green é regra de produto do ConectorGreen, não do CRM genérico; o upstream não tem por que carregá-lo                                                                          |
| Recomeçar do upstream mais novo (v1.72.0)             | Invalida a validação inteira: as cinco frentes foram provadas sobre a v1.69.0, e refazer as provas sobre uma base que continua andando não termina                                       |
