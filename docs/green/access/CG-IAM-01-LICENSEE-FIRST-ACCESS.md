# Acesso — Primeiro acesso do licenciado

| Item                   | Valor                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| ID                     | `CG-IAM-01`                                                                                           |
| Tipo                   | FEAT                                                                                                  |
| Área                   | Acesso (`CG-IAM`)                                                                                     |
| Estado                 | EM ANDAMENTO — checkpoint local na branch `feat/cg-iam-01-licensee-first-access`, sem push e sem PR   |
| Equivalência histórica | Nenhuma. Parte dos diagnósticos de onboarding de 2026-10-09, 2026-10-10 e 2026-10-13 (sem ID próprio) |
| Migration              | Nenhuma. `0511` segue livre                                                                           |

## 1. Resultado

O primeiro acesso de uma organização deixa de depender de quem chega primeiro ao assistente:

- só o **administrador da organização** executa o assistente de configuração, validado no servidor;
- os demais papéis usam o CRM conforme as permissões deles, mesmo com a organização ainda por configurar;
- todo convite emitido pelo assistente e pela criação de organização da plataforma é **linha em `team_invites`**,
  aparece na tela de Equipe e pode ser **revogado** antes do aceite;
- o convite **sobrevive à entrada com Google** iniciada em `/login`;
- a instalação escolhe entre o assistente **herdado** (padrão) e o **simplificado** (`ONBOARDING_MODE`).

## 2. Decisões

Aprovadas pelo dono do produto em 2026-10-14: (1) segurança e permissões obrigatórias no onboarding; (2) preservar a
demonstração CG-OPS-01 e as organizações existentes; (3) convites rastreáveis e revogáveis; (4) convite preservado no
login com Google; (5) onboarding simplificado por configuração; (6) sem provisionamento automático dos funis Green.

Decisões locais desta entrega, tomadas dentro desse escopo:

| ID     | Decisão                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `D-01` | O colaborador não administrador de organização sem `onboarded_at` usa o CRM nos **dois** modos. É consequência de (1): as ações do assistente recusam os demais papéis, e mandá-lo para lá o prenderia |
| `D-02` | A guarda do assistente aplica a régua de MFA de `requireRole("admin")`: quem tem fator cadastrado prova o fator na sessão                                                                              |
| `D-03` | Acompanhamento de suporte em modo completo recebe `admin` de `fn_user_role_in_org` e segue podendo agir; o somente leitura é recusado. O layout de `/onboarding` já mantinha o suporte fora da tela    |
| `D-04` | Convite sem linha (emitido antes desta entrega) segue aceito até expirar (24 h). Todo convite novo nasce com linha                                                                                     |
| `D-05` | A escolha do assistente é variável da instalação (`ONBOARDING_MODE`), não coluna de `platform_settings`: atende sem migration                                                                          |
| `D-06` | Quem já tem vínculo e volta do Google com convite válido vai à tela de aceite e confirma com um clique, como no login por senha. Vínculo automático no callback fica só para conta nova                |
| `D-07` | Quem já é membro ativo não recebe convite novo (`already_member`), no assistente e na rota da API. O aceite nunca promoveu: `fn_accept_team_invite` devolve o vínculo ativo sem tocar no papel         |

## 3. Autorização do assistente

`requireOnboardingCtx` (`app/actions/onboarding/_shared.ts`) é a guarda de **toda** ação do assistente e passou a
exigir, nesta ordem e antes de qualquer cliente service role: sessão; acompanhamento ativo e com escrita; organização
ativa validada contra os vínculos vivos (`resolveActiveOrg`); papel `admin` (`configuraPeloAssistente`,
`lib/onboarding/quem-configura.ts`); e MFA provado (`mfaEmDivida`). A recusa não lê nem escreve nada da organização.

Protegidas: `acceptWelcome` (renomeia a organização), `skipWhatsapp`, `markWhatsappConfigured`, `skipNuvemshop`,
`markNuvemshopConfigured`, `createDefaultAgent`, `skipAi`, `aplicarQuadro`, `pularQuadro`, `dadosDoPasso`,
`marcarTesteFeito`, `pularTeste`, `sendOnboardingInvites`, `finishOnboarding` e `salvarChaveDaIa`. Fora das actions,
`GET /api/v1/onboarding/whatsapp/qr` passou a exigir `requireRole("admin")`, como o `POST` irmão: quem escaneia o QR
liga o próprio WhatsApp ao canal da empresa.

`dadosDoPasso` vivia num módulo `"use server"` — portanto era endpoint — e recebia o `orgId` de quem chamava (lia o
funil e usava a chave de IA de outra empresa). Agora não tem parâmetro: organização e nome vêm da sessão.

O gate usa a mesma regra nas duas pontas: `app/app/layout.tsx` só manda o administrador para `/onboarding`, e
`app/onboarding/layout.tsx` e `page.tsx` devolvem ao `/app` quem não administra.

Consumidores mapeados antes da mudança: `requireOnboardingCtx` só é chamada pelas actions de `app/actions/onboarding/`
(e citada num comentário de `lib/ai/pontos/padrao-da-organizacao.ts`). `loadAuthUser`, `resolveActiveOrg` e
`requireRole` não mudaram.

## 4. Convites: emissão, armazenamento, revogação e aceite

O token HMAC continua stateless e com o mesmo contrato (`lib/auth/invite-token.ts`, 24 h); quem diz que um convite
morreu é a linha de `team_invites` (migration 0238), cujo `id` é o `invite_id` do token.

| Emissor                                     | Antes                                       | Agora                                                                   |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Tela de Equipe (`POST /api/v1/team/invite`) | `emitirConvite`, com linha                  | Igual; lista de membros pela mesma função do assistente                 |
| Assistente (`sendOnboardingInvites`)        | Token sem linha, sem `iat` nem `invited_by` | `emitirConvite` com `origem: onboarding`; membro ativo pulado           |
| Plataforma (`POST /api/v1/admin/tenants`)   | `issueInvite` sem linha, papel `admin`      | `emitirConviteComIdFixo`: linha com o `invite_id` do recibo idempotente |

Na plataforma, o replay com a mesma `Idempotency-Key` encontra a linha, re-assina o mesmo token (mesmo link) e não envia
de novo. A criação da organização (`fn_create_tenant_with_owner`) não mudou.

**Aceite** (`lib/auth/aplicar-convite.ts`): a linha é **reivindicada antes do vínculo** — `accepted_at`/`accepted_by`
gravados só onde `revoked_at` e `accepted_at` são nulos. Revogação gravada no meio vence; convite aceito por outra pessoa
não serve a ninguém; replay da mesma pessoa é idempotente; se o banco recusar o vínculo, a posse é devolvida.
Organização, papel e convidador continuam vindo só do token, e o cookie `active_org` aponta a organização do convite.

**Revogação** (`POST /api/v1/team/invites/[id]/revoke`): só escreve onde `accepted_at` é nulo e agora confere se alguma
linha mudou. Se o aceite ganhou a linha, responde `409 state_conflict` e não audita revogação.

Sem organização fantasma: conta nova com convite válido nunca passa por `ensureTenantForUser`; convite inválido,
expirado, de outro e-mail ou revogado não concede vínculo e também não provisiona organização.

## 5. Convite na entrada com Google

`conviteDoDestino` (`lib/auth/entrada-com-google.ts`) extrai o token **só** da forma exata
`/team/accept-invite/<corpo>.<assinatura>` (base64url, um segmento, sem query nem esquema). Na ida,
`urlDeRetornoDoGoogle` leva esse convite como `convite`; na volta, `/auth/callback` usa `convite` ou o do `next`. As
provas são as de sempre: `decidirConviteDoSignup` (assinatura e e-mail confirmado) e `aplicarConvite` (linha e
revogação). Quem já tem vínculo e chega com convite válido vai à tela de aceite, inclusive depois do segundo fator.
Sem convite, o caminho é o de antes; o login por senha não mudou. `safeNext` continua filtrando todo destino.

## 6. Onboarding simplificado

| `ONBOARDING_MODE`    | Passos do assistente                                                                    | Ao concluir  |
| -------------------- | --------------------------------------------------------------------------------------- | ------------ |
| vazio ou `herdado`   | Seu negócio, telefone (WhatsApp), loja (se ligada), treinar (IA), funil, ensaio, equipe | `/app/inbox` |
| `simplificado`       | Seu negócio, equipe (opcional)                                                          | `/app`       |
| qualquer outro valor | Herdado, com aviso no log                                                               | `/app/inbox` |

No simplificado, WhatsApp, IA e funis continuam nas Configurações. A tela final não fala de agente treinado nem de
rascunho. `onboarded_at` mantém o contrato atual nos dois modos — o administrador concluiu a configuração inicial —, é o
que o gate de `/app`, o filtro "onboarding" da plataforma e o painel leem, e **não** afirma canal, IA ou estrutura Green.
O rastro `onboarding.completed` registra o `modo`; o payload de `tenant.onboarded` não mudou.

A organização criada pela plataforma continua nascendo como hoje (sem `onboarded_at`, com o funil padrão semeado pelo
gatilho). Esta entrega não a completa nem promete funis Green.

## 7. Compatibilidade

Sem migration, backfill, limpeza ou reset. Organizações já configuradas não passam pelo assistente em nenhum modo;
vínculos, papéis, funis, oportunidades, contatos, produtos, canais e IA não são tocados. Convites pendentes com linha
seguem válidos e revogáveis; os sem linha seguem aceitos até expirar (`D-04`). A demonstração CG-OPS-01 (worktree e
stack próprios) não foi alterada nem atualizada, e o Docker não foi iniciado.

## 8. Testes

Unitários novos: `assistente-so-o-admin-configura` (140 casos: quatro papéis, sessão ausente, vínculo inativo, suporte
somente leitura e encerrado, MFA pendente, `orgId` forjado, convite de admin por quem não administra; recusa sem
escrita), `colaborador-nao-cai-no-assistente`, `qr-do-assistente-so-para-admin`,
`acoes-do-assistente-passam-pela-guarda` (cerca estrutural), `convite-do-assistente-e-rastreavel`,
`convite-do-titular-e-rastreavel`, `aceite-reivindica-o-convite-antes-do-vinculo`,
`revogacao-que-perde-para-o-aceite`, `convite-sobrevive-ao-google-do-login`,
`onboarding-simplificado-por-configuracao`, `fim-do-assistente-registra-o-modo`. Ajustados sem mudar o que medem:
`onboarding-chave-da-ia-vale-para-a-empresa`, `aplicar-convite`, `organizacoes-criacao-e-troca`. E2E ajustado:
`troca-de-organizacao-tem-volta` (o `manager` da organização não configurada fica no CRM).

Não há mudança de SQL, então nenhum invariante de banco novo. O E2E ajustado e a prova pela tela ficam para o CI e para
um ambiente com Supabase (seção 9).

## 9. Pendências e riscos

- **Validação pendente:** E2E Playwright (inclusive `troca-de-organizacao-tem-volta`), `test:db` e prova pela tela do
  percurso simplificado e do Google real não rodaram localmente (dependem de Docker/Supabase e de OAuth configurado).
- Links emitidos pelo assistente ou pela plataforma **antes** desta entrega continuam irrevogáveis até expirar (24 h).
- Posse e vínculo não são uma transação só (sem migration): se a RPC falhar por infraestrutura e a devolução da posse
  também falhar, a linha fica "aceita" sem vínculo; o replay da mesma pessoa refaz o vínculo.
- A tela de aceite não mostra "revogado" antes do clique; a recusa aparece ao confirmar.
- Replay da criação de organização depois de revogado o convite do titular devolve o mesmo link, que o aceite recusa.
- No simplificado, as páginas dos passos herdados seguem alcançáveis por URL para o administrador (sem efeito no gate).

## 10. Fora do escopo

Migration 0511 de provisionamento Green; funis ConexãoGreen e Expansão de fábrica; catálogo inicial automático; ADR
GREEN-002 / DP-01; distribuição comercial entre licenciados; ConectorZap; identidade visual; hosting e deploy; workflow
`release`; mudanças gerais de permissão fora de onboarding e convites.
