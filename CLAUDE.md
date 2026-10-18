# CLAUDE.md — DeskcommCRM

## Este repositório é um FORK — leia antes de qualquer coisa
ConectorGreen é um fork do DeskcommCRM (melgarafael). NÃO puxamos atualizações do upstream.
Aqui, `origin` é `alves87daniel/DeskcommCRM` e a `main` deste fork é `origin/main`: todo
`git fetch`, `git merge origin/main`, `git show origin/main:...` e medição de migration
(`pnpm checar:colisao-de-migration`) vale contra ela. Os checks obrigatórios são os que
`gh api repos/alves87daniel/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`
listar (vazio = nenhum ainda).
Fora do escopo deste fork, mesmo que citados abaixo: o site e as páginas de changelog da
deskcomm, a parceria HostGator, o executor próprio (`infra/executor-proprio/`), os números
medidos no repositório do upstream, e a obrigação de o fragmento em `.changes/` alimentar
vitrine externa.
Em execução autônoma, quando uma regra exigir recurso do upstream, registre a dúvida no PR e
siga pelo caminho conservador. Fora de execução autônoma, pare e pergunte.

> Instruções pra futuras sessões Claude trabalhando neste repo. Leitura obrigatória antes de qualquer task de código.

**Este arquivo é a doutrina — a autoridade final sobre convenção e anti-pattern.** Complementos, na ordem em que ajudam:

- [`AGENTS.md`](AGENTS.md) — mesmo contrato em forma portável (para Codex/Cursor/Copilot e afins). É derivado deste arquivo, não o substitui. **Ao mudar doutrina aqui, verifique se `AGENTS.md` desatualizou.**
- [`docs/index.md`](docs/index.md) — índice dos 149 docs, com regra de precedência quando dois docs discordam. Use antes de sair varrendo `docs/`.
- [`docs/current-state.md`](docs/current-state.md) — o que está pronto, incompleto e quebrado. **Leia antes de estimar ou prometer qualquer coisa.**
- [`docs/harness-audit.md`](docs/harness-audit.md) — onde a verificação tem buraco. Importante: `pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` — verde ali não é prova para mudança de schema ou de UI.
- [`docs/threat-model.md`](docs/threat-model.md) — superfície de ataque real do self-host.

---

## Visão (1 parágrafo)

DeskcommCRM é um sistema operacional de vendas open source com agentes de IA nativos — multi-nicho (e-commerce, clínicas, imobiliárias, infoprodutos, serviços), com WhatsApp como canal primário (via WAHA). Agentes com RAG por tenant atendem, qualificam e movem o funil junto com humanos; CRM inteiro exposto via MCP. Monetização = self-host em VPS (parceria HostGator), não assinatura. Arquitetura multi-tenant com RLS desde o dia 1; LGPD nativa. Posicionamento completo: `VISION.md`.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind 4 (config em CSS — ver abaixo) + shadcn/ui (style: `new-york`, neutral)
- **Backend:** Next.js Route Handlers (mesmo repo); workers via `event_log` table + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie SameSite=Strict, HttpOnly, Secure
- **Realtime:** Supabase Realtime (postgres_changes + broadcast)
- **Storage:** Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas)
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** `event_log` table + workers (não usar Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; embeddings pela OpenAI ou, por escolha da organização, pelo Google — `lib/ai/embeddings/chave.ts`); strings tipo `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod em todo input externo (request body, webhook payload, env)
- **Observability:** Sentry com `beforeSend` sanitizado

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all` aplicada via helper `fn_user_org_ids()`
- Service role bypassa RLS — handlers que usam admin client **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (cria 2 tenants, verifica não-vazamento) é obrigatório no CI antes de merge

### Idempotência & event sourcing leve
- Mensagens WhatsApp e eventos externos: `unique (organization_id, external_id)` + captura `code === '23505'` no INSERT
- POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h). O recibo mora no **Postgres** (`public.idempotency_keys`, único por organização + chave + endpoint), não no Upstash — ver `lib/api/idempotency.ts`. Quais rotas leem o header: `grep -rln 'Idempotency-Key' app/api/v1 --include='route.ts'`
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron / Realtime listener) consome e dispara side effect

### API REST `/api/v1/`
- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Wrapper sucesso: `{ data, meta?: { cursor, has_more, total } }`
- Wrapper erro: `{ error: { code, message, details? } }` — usar helpers `ok()` / `fail()` de `lib/api/wrappers.ts`
- Paginação: cursor opaco base64+HMAC por default
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
- **API key NUNCA em query string** (vaza em logs Vercel/CF). Sempre header
- Plaintext de bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429
- `X-Request-Id` em toda response (correlaciona com audit log)

### Auth & RBAC
- Sempre `getUser()` (valida JWT no backend). NUNCA `getSession()` (confia no cookie local)
- 4 roles dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4)
- Super-admin de plataforma é uma role transversal — `is_platform_admin` (decisão final na Spec 01)
- MFA TOTP é **opcional e ligado por quem administra** — não é mais forçado por papel. Quem exige são duas políticas independentes que SOMAM: `platform_admins.mfa_required` (para o super-admin) e `organizations.settings.security.mfa_required` (para o `admin` do tenant). O padrão de ambas é **não exigir**, e o `bootstrap-owner.ts` grava `false` explícito. Regra pura em `lib/auth/politica-mfa.ts`
  - **Por que mudou:** o gate era `isPlatformAdmin || role === "admin"`, sem opção, e o `install.sh` cria o dono como platform admin — então TODA instalação self-host recebia um bloqueador de tela cheia logo depois do onboarding, um passo que o wizard nunca anunciou. Decisão do dono do produto; segurança que expulsa o usuário na primeira tela não protege ninguém
  - **⚠️ CADASTRAR e PROVAR são perguntas diferentes.** A política decide o cadastro. Já `mfaEmDivida()` — o 403 `mfa_required` das rotas — NÃO consulta a política: quem TEM fator prova na sessão, sempre. Ligá-lo à política faria quem ativa a verificação por vontade própria ter o fator ignorado
  - Ligar/desligar vive em **Configurações › Segurança**; desligar o próprio fator exige sessão `aal2` (senão uma sessão roubada desliga a proteção com um clique)
- Permissão por pipeline (`user_pipeline_access`) **NÃO** entra no MVP
- Suporte temporário: todo handler mutante de `app/api/v1` declara `requireSupportWrite(`
  de `lib/impersonate/support.ts` **antes do efeito**. É guarda de efeito, não de papel — não substitui
  `requireRole`/RBAC/MFA — e é cobrada pelo gate `tests/unit/suporte-cobertura-de-efeitos.test.ts`

### Audit log
- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- Cron que não fez nada não audita. Quem fez, audita. `api_audit_log` é append-only para anon/authenticated/service_role (0258), e o que protege é `revoke` explícito no apêndice, nunca o grant enumerado do dump. Retenção de 5 anos via `fn_expurgar_auditoria_vencida`, sem camada cold (knob `AUDIT_LOG_RETENTION_DAYS`, piso de 90 dias). Prova, comandos e racional: [`docs/doctrine/auditoria.md`](docs/doctrine/auditoria.md).
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WAHA
- Imagem NOWEB pinada por arquitetura: `latest-2026.7.2` em x86 e `noweb-arm-2026.7.2` em ARM64. A prova local criou duas sessões CORE simultâneas até `SCAN_QR_CODE`; não prova pairing, duas contas `WORKING` nem envio. Não bloquear segunda sessão por tier: conferir resposta estruturada e pós-condição da operação.
- Engine NOWEB default; WEBJS apenas se precisar stickers animados / botões
- Auth: env do WAHA recebe **hash SHA512 hex** da api key; cliente envia plaintext em `X-Api-Key`
- Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms. Campanha 1 msg/5s. Warm-up 7-14d. Spinning de copy. Janela de disparo 7h-22h (domingo LIBERADO por default desde 2026-08-20; a janela é knob por canal). Janela de RESPOSTA por canal (0495, `channel_knobs.resposta_*`), que herda a de disparo quando vazia — só `inbound_turn`/`case_reply_turn` a leem
- STOP detection: a regra mora em `lib/opt-out/deteccao.ts` e é a MESMA nos dois lados —
  a ingestão (que grava `is_blocked=true`) e o runtime do agente. **Não é mais a palavra
  solta:** só bloqueia palavra ISOLADA (mensagem inteira = a palavra) ou verbo de cessação
  com OBJETO DE COMUNICAÇÃO ("parar de me mandar", "sair da lista"). Enquanto eram duas
  regras, a ingestão bloqueava paciente que perguntou "tem como parar a dor?" — medido em
  clínica, 12 falsos positivos num corpus de 32 frases de nicho.
  Cobre português e espanhol, nos dois níveis (inequívoco e ambíguo) — foi preciso um PR
  além do #275 (que só tinha coberto o vocabulário inequívoco) para o espanhol ganhar a
  camada ambígua e as construções com pronome preso ("escribirme"). Para ver o vocabulário
  em vigor sem confiar nesta linha:
  `sed -n '/PALAVRAS_DE_OPT_OUT/,/^]/p' lib/opt-out/deteccao.ts | grep -E '^ *"'`, e as frases de controle em
  `tests/unit/opt-out-deteccao.test.ts`.
  O Jev (`lib/ai/decisao/pedidos.ts`) só é perguntado onde esta regra disse não, e nunca bloqueia
  ninguém — no máximo abre um aviso na Central ("Avisar a equipe"): a regra continua a única que bloqueia
  (cerca: `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`).
- Mídia: subir pro Supabase Storage primeiro, passar URL ao WAHA (não inline base64)
- Multi-device: assinar `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
- Grupos: entram **só os ligados** em Conexões › Grupos (`channel_session_groups`). O grupo ligado vira conversa `is_group` com um contato `kind = 'whatsapp_group'` que nunca entra em funil, lista, campanha ou IA; o remetente é `p.author` (nunca `p.from`), gravado em `messages.metadata.group_sender` (`lib/messaging/remetente-de-grupo.ts`). Para conversa de grupo o banco emite `message.group_received`, e não `message.received`, e o roteamento automático pula grupo. O filtro `ignore.groups` do WAHA é propriedade desta funcionalidade (`definirRecebimentoDeGrupos`); compatibilidade e convergência não o tocam. Spec: `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`
- Cron `recover-stuck-messages` (`app/api/v1/cron/recover-stuck-messages/route.ts`, agendado no `scheduler` do `docker-compose.prod.yml`): marca `status='sending'` há >5min como `failed` **e abre aviso na Central** (`agent_inbox_items` kind `message_send_stuck`). Não toca em `queued`: esse estado tem dono (o agent-engine reagenda por `SEND_QUEUED_RETRY_MS`), e falhá-lo perderia mensagem que ia sair. Não reenvia — envio em dobro é pior que não-envio

### Marca própria (white-label)
- **Uma imagem Docker serve todas as marcas.** Nada de `NEXT_PUBLIC_*` para marca, nada de `public/favicon.ico`, nada de imagem por revendedor — a imagem é pré-buildada e o `update.sh` regrava `APP_IMAGE` incondicionalmente
- **O banco está ACIMA do `.env`.** `platform_branding` (instalação) e `organizations.settings.branding` (organização) são a fonte; `APP_NAME`/`APP_LOGO_URL`/`APP_ACCENT_HEX` são **semente e piso de rollback** (o `agent.sh` reverte a imagem, nunca o banco)
- **Resolvedor NUNCA lança.** `lib/branding/instalacao.ts` e `lib/branding/saida.ts` degradam para o padrão do produto e seguem: `branding()` roda em `app/layout.tsx`, e um throw ali é 500 em todas as telas
- **Saída sem DOM usa `marcaDaSaida()`** (`lib/branding/saida.ts`) — e-mail, remetente, ícone, `issuer` do MFA. Um hex e uma frente legível, tema **claro** sempre. Nunca passe `MarcaResolvida` a template de e-mail
- **O PDF de LGPD NUNCA leva marca.** Ele nomeia o **controlador** (`organizations.legal_name`) e o DPO resolvido. Nomear ali o revendedor — que é operador — inverteria papéis num documento que responde a direito legal. Vigiado em `tests/unit/mapas-de-arquitetura.test.ts`
- Vazamento de marca no código é vigiado por `tests/unit/branding.test.ts` (varre `app|components|lib|workers|hooks`), com allowlist que **só encolhe**. Contexto de venda em [`docs/white-label.md`](docs/white-label.md); mapa em `docs/architecture/marca-propria.architecture.json`

### Doutrina DIRC (antes de adicionar campo)
- **D**uplicar — vive aqui mesmo?
- **I**ntegrar — vem de outra tabela via FK?
- **R**eferenciar — só ponteiro?
- **C**alcular — pode ser computado on-demand?

### Modelagem
- 5 tabelas core CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` (polimórfica timeline), `crm_lead_links` (polimórficos vínculos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound `sending` ainda não tem ID WAHA)
- `type` é `text` + `check constraint`, **não enum** (enum é difícil de estender)
  - **Exceção deliberada — colunas de vocabulário ABERTO:** onde um clone pode ter linhas com valor
    legado (ex.: `crm_lead_activities.type`), o CHECK **não** entra: a constraint faria o `update.sh`
    do clone quebrar, e a doutrina de migrations proíbe. Nesses casos o vocabulário vive só no
    TypeScript, o emissor usa **constante compartilhada, nunca string literal**, e a coluna fica
    **fora** do invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre
    apenas colunas que JÁ têm CHECK. Ver o cabeçalho desse arquivo antes de "completar" o schema.
- `tags text[]` + GIN index; promove pra coluna gerada apenas quando vira hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` em pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger Postgres faz HTTP** (letal — espera rede dentro da transação)
10. Service role usado em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no DB (deve ser hash SHA256)
14. `console.log` deixado em código merged (use logger estruturado ou Sentry breadcrumb)

---

## Paths importantes

| Path | Conteúdo |
|---|---|
| `docs/prd/00-prd-master.md` | Visão geral, escopo MVP, KPIs |
| `docs/prd/01-prd-platform-base.md` | Auth, tenancy, RBAC, LGPD framework |
| `docs/prd/02-...06-` | Customer 360, WhatsApp, Pipeline, IA-RAG, Nuvemshop |
| `docs/specs/` | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| `docs/business-rules/` | Regras de negócio fora do código |
| `docs/research/reference-synthesis.md` | Arquitetura herdada do curso WAHA |
| `tasks/todo.md` | Workflow de construção atual |
| `app/globals.css` | **Tailwind 4 é CSS-first: não existe `tailwind.config.ts`.** Tokens em `:root` / `[data-theme]`, ponte token → utilitário no `@theme inline`, alcance do scanner nos `@source`. Vigiado por `tests/unit/tailwind-tokens.test.ts` |
| `lib/api/wrappers.ts` | `ok()`, `fail()`, tipos `ApiSuccess<T>` / `ApiError` |
| `lib/api/errors.ts` | Códigos de erro canônicos |
| `lib/env.ts` | Validação Zod das env vars (lança no startup se faltar crítica) |
| `lib/supabase/{browser,server,admin}.ts` | Clients canônicos |
| `app/api/v1/health/route.ts` | Health check (Supabase + Redis + WAHA) |
| `supabase/migrations/` | Schema versionado |
| `docs/runbooks/deploy.md` | **Deploy em produção — leia ANTES de mexer na VPS** |

---

## Deploy em produção (NÃO NEGOCIÁVEL)

**Numa VPS que já tem proxy reverso próprio (Hostinger, Coolify, Dokploy…), todo
`up -d` leva os DOIS arquivos de compose:**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Omitir `-f docker-compose.traefik.yml` recria o contêiner sem as labels de
roteamento; o Traefik da hospedagem deixa de enxergá-lo e **o domínio inteiro
responde `404 page not found`** — com o contêiner `healthy`, porque o
healthcheck é um probe TCP interno e não sabe nada de roteamento.

Depois de qualquer deploy, confirme que o domínio responde **307** (redireciona
pro login) e não 404. Verificações e o caso de build local em
`docs/runbooks/deploy.md`.

O caminho normal **não constrói nada na VPS**: commit → push → PR → merge na
`main` → o CI publica no GHCR → a VPS puxa. Imagem construída na VPS é exceção
de emergência e é dívida: existe só naquele disco e qualquer `up -d` sem
`APP_PULL_POLICY=never` a substitui em silêncio.

Essa frase já foi meia-verdade: valia para o `app` e era falsa para o produto,
porque o serviço `worker` não tinha `image:` — era construído na VPS de todo
cliente e nunca reconstruído por nenhum `update.sh`. Hoje os três serviços
nossos (`app`, `worker`, `scheduler`) são imagens publicadas, e um teste
reprova o retorno do padrão. Ver a doutrina abaixo.

---

## Packaging e distribuição — DOUTRINA (NÃO NEGOCIÁVEL)

Lei completa em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md);
decisões estruturais e o que foi recusado em
[`docs/adr/0001-packaging-e-distribuicao.md`](docs/adr/0001-packaging-e-distribuicao.md).
O não-negociável, em quatro linhas:

1. **Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do
   cliente.** Todo serviço declara `image:` de uma imagem publicada; `build:`
   só existe **ao lado**, como escape. Serviço `build:`-only é invisível para
   `docker compose pull` e imune a `up -d` sem `--build` — ele não é só caro de
   instalar, ele **nunca é atualizado**.
2. **Publicação é ato do CI.** Nunca da sua máquina: o CI publica as imagens
   nativas para linux/amd64 e linux/arm64, e a falha de arquitetura precisa
   aparecer antes do `up -d` do cliente. O job
   `imagens-ok` reprova quando qualquer uma das três imagens não constrói, e
   **é status check obrigatório desde 2026-08-13** — a branch protection tem
   `verify, build-and-size, invariants, e2e, imagens-ok`. (Este parágrafo dizia
   "ainda não é obrigatório" até 2026-08-14; a ativação era o passo final do
   merge da doutrina e aconteceu.) Confira na fonte antes de confiar nesta linha.
3. **Instalação de cliente aponta para número de versão, nunca para tag móvel.**
   `latest` aqui significa **topo da `main`**, não última release — quem quer a
   última release usa `stable`. `pull_policy` acompanha a mutabilidade da tag:
   imutável → `missing`, móvel → `always`.
4. **Dependência upstream é referenciada com tag fixa, nunca republicada.**
   Vale para WAHA (licenciado — republicar é passivo jurídico), Redis, Caddy e
   `serverless-redis-http`.

Bump de versão **não pode** exigir que o operador da VPS edite `.env`, compose
ou qualquer arquivo à mão. Se exigir, não entra: vira issue com plano de
migração e vai para uma major.
---

## Extensões — DOUTRINA (NÃO NEGOCIÁVEL)

Lei completa em [`docs/doctrine/extensoes.md`](docs/doctrine/extensoes.md); o
contrato que existe hoje em
[`docs/specs/extensoes-declarativas-v1.md`](docs/specs/extensoes-declarativas-v1.md).
A pergunta que decide o destino de uma mudança não é "isto serve a muita gente?",
e sim **"se nenhuma organização ativar isto, a operação comum continua inteira?"**.
O não-negociável:

1. **O núcleo continua útil com zero extensões.** Identidade, autorização,
   isolamento, auditoria, contratos e cadeia de envio são núcleo; jornada de nicho,
   aparência e integração com dados e manutenção próprios podem ser extensão.
2. **Extensão pede capacidade nomeada; não importa código interno nem lê o banco.**
   Instalar não concede autoridade: toda escrita revalida ator, organização e papel
   atuais no banco.
3. **A instância decide o pacote; a organização decide o uso.** Instalar, atualizar,
   desfazer e remover são do administrador da instalação; ativar e configurar, do
   administrador da organização. A plataforma não reativa decisão da organização.
4. **Toda operação é recibo idempotente com saída pela tela, e toda troca de
   ponteiro exige a revisão que a tela viu.** Tirar é lógico e preserva dados.
5. **Não anunciar o que não existe** (SDK, código isolado, marketplace público), e
   não extrair do núcleo recurso já distribuído sem equivalência e migração.
6. **Módulo oficial com dados não põe tabela no baseline para todos**
   ([ADR-0002](docs/adr/0002-tabelas-de-modulo-num-banco-so.md), aceita em 17/09/2026). Um banco
   só, schema `public`; as tabelas nascem por função provisionadora fixa do módulo, quando ele é
   **instalado na instância**. Ninguém opera segundo banco — é decisão do dono, e seria impossível
   com chave estrangeira para o núcleo.

---

## Como rodar local

```bash
nvm use                    # node 22
pnpm install               # o gerenciador é pnpm (packageManager no package.json), não npm
cp .env.example .env.local  # preencher
docker compose up -d        # WAHA local
pnpm dev                    # http://localhost:3000
pnpm worker                 # agent-worker (processo separado do Next)
pnpm dev:crons              # chama localmente só os crons de PATHS em scripts/dev-crons.ts (não todos)
```

Schema: aplique `supabase/baseline.sql`, **não** as migrations (a cadeia não sobe do zero).
Stack local completa (Supabase via `scripts/local-supabase.sh`; app, worker, scheduler, WAHA e Redis via `docker-compose.local.yml`), depois de rodar
`./ubuntu-local-installer.sh` uma vez: `pnpm local:up | local:down | local:status | local:logs`.
Ver `README.md` pra detalhes de setup.

---

## Testes

```bash
pnpm typecheck   # tsc --noEmit -p tsconfig.typecheck.json (inclui tests/)
pnpm lint        # eslint next/core-web-vitals
pnpm test:unit   # Vitest (NÃO inclui tests/invariants/** — ver abaixo)
pnpm test:db     # Postgres efêmero + baseline install/update + 364 invariantes
pnpm test:e2e    # Playwright (requer dev server)
pnpm gov:verify  # typecheck + lint + lint:channels + lint:role-rank + test:unit
pnpm cercas      # só as cercas estruturais (projeto vitest "cercas")
pnpm test:journeys  # Playwright com tests/journeys/playwright.config.ts
pnpm format:check   # prettier
```

Um teste só:

```bash
pnpm vitest run lib/foo/bar.test.ts         # um arquivo unit
pnpm vitest run -t "nome do caso"           # um caso pelo nome
pnpm test:db tests/invariants/x.test.ts     # um invariante (o script repassa os args ao vitest)
pnpm playwright test tests/e2e/x.spec.ts    # uma spec e2e
```

**`pnpm test:unit` (sem caminho) é a suíte: `vitest run tests/unit` é um recorte.** Para ler o
resultado sem falso verde (o exit code é a autoridade; rodapé, `FAIL`, `Failed Suites`, `Errors`),
use a skill `deskcomm-ler-suite`. Gate escolhido não é suíte: `typecheck` e `lint` verdes não
dizem nada sobre o arquivo que quebrou.

**Os invariantes não estão no `test:unit`.** `vitest.config.ts` exclui `tests/invariants/**` de propósito: essa suíte precisa de um Postgres real e roda via `vitest.db.config.ts`, orquestrada por `scripts/test-db.sh`. Rodar só `pnpm test:unit` e concluir "está tudo verde" é um falso verde — o isolamento RLS não foi exercitado.

A lista de checks obrigatórios vem do comando do bloco do fork, no topo, nunca desta prosa. O
que cada job mede e o que `FORA_DO_CI` exclui:
[`docs/doctrine/checks-de-ci.md`](docs/doctrine/checks-de-ci.md).

Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento, follow-up, webhooks ou automações: rode `pnpm test:db` **localmente** antes de abrir PR. É o único caminho que exercita o `baseline.sql` que o self-hoster realmente aplica.

---

## QA Visual com Recursos Reais — DOUTRINA (produto self-host)

**O DeskcommCRM é distribuído open-source: a experiência de quem instala numa VPS É o produto.** Toda feature nova (ou fix de comportamento visível) DEVE ser provada como um **usuário leigo a usaria de verdade** — pelo frontend, num ambiente que imita a instalação fresca — antes de "pronto". Não é opcional; é critério de aceite de toda sessão que toca UI ou fluxo de usuário.

**O que "recurso real" significa (e o que NÃO conta):**
- **Conta.** Prova pela tela, dirigindo o browser (Playwright), logando com conta de teste real. `curl`/chamada de API **não** provam UX — validam o backend, mas não o que o usuário vê, clica e entende. Use curl só como diagnóstico.
- **Banco fresco estilo VPS.** Postgres limpo aplicado do `supabase/baseline.sql` (não das `migrations/` — a cadeia fresh não sobe) + `scripts/bootstrap-owner.ts` (o que o `install.sh` faz). O ambiente do teste = o que o clone recém-instalado tem: sem os seus dados, sem os seus envs opcionais.
- **Dependências como na VPS.** WAHA local, Redis local (`redis` + `serverless-redis-http`), cron drain via endpoint. E **teste com os envs opcionais AUSENTES** (ex.: sem `RESEND_API_KEY`) — é o estado real de um primeiro deploy, e é onde moram os piores bugs de primeira impressão.
- **Efeito colateral externo provado com receiver real.** Webhook outbound, envio — suba um receiver HTTP de verdade e prove o que chegou (ou que foi barrado). Mock não estressa o egress real (anti-SSRF, projeção de payload, https em prod).

**Prioridade: primeira impressão acima de tudo.** Onboarding e as primeiras ações (criar conta, conectar canal, primeiro lead, primeiro convite) são a primeira impressão do usuário — bug ali é abandono. Teste esses caminhos primeiro e com o maior rigor.

**Registro obrigatório (senão o progresso é invisível):**
- Mapa de jornadas vivo em `docs/testing/user-journey-map.md` — casos por jornada, prioridade (`[P0]` primeira impressão), e achados. Atualize quando adicionar cobertura ou achar bug.
- Specs em `tests/e2e/*.spec.ts` que dirigem o **frontend** (não só API). Evidência visual (screenshot/trace) em `evidence/<entrega>/`, que é versionada; nunca em pasta que o `.gitignore` ignora, senão a prova não sai da sua máquina.
- Bug achado executando → **conserta na causa raiz**, com migration versionada se tocar schema (ver doutrina abaixo), commit próprio, e re-teste verde como prova.

**Medidas de front-end por ferramenta, nunca a olho** (`getBoundingClientRect`/`getComputedStyle` no Playwright). Ver `feedback_protocolo_execucao_visivel` na memória.

**Receita de ambiente fresco (não-óbvia):** banco = `baseline.sql` num Supabase local **pg15** (`config.toml major_version = 15`). Já foi pg17, por causa de 9 `GRANT MAINTAIN` que o `pg_dump` emitiu sozinho; hoje quem guarda o piso é `tests/unit/baseline-no-piso-do-postgres.test.ts`; `next build` + `next start` (produção — `next dev` compila lento demais e o Turbopack quebra `cookies()`); **worktree com `node_modules` real, nunca symlink** (Turbopack rejeita symlink "out of filesystem root") e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco). Detalhes em [[project_invite_e2e_and_bugs]].

---

## Higiene de branches — DOUTRINA (NÃO NEGOCIÁVEL)

**`main` é produção e é a fonte da verdade. Toda branch começa e se mantém atualizada com a `main`.** Trabalho iniciado numa branch atrasada gera conflito e retrabalho — é a causa número um de "cagada" em ambiente multi-sessão. Regra:

1. **ANTES de começar QUALQUER trabalho numa branch, atualize-a com a `main`:** `git fetch origin && git merge origin/main` (traz produção pra dentro). Se a branch ainda não tem commits próprios, é fast-forward puro (`git merge --ff-only origin/main`). Não codar antes disso.
2. **NUNCA `reset --hard`/force pra "atualizar"** — apaga trabalho. Só dois caminhos: **fast-forward** (branch sem commits próprios) ou **merge da `main` pra dentro** (preserva os dois lados). `main` nunca é reescrita.
3. **NUNCA toque numa branch/worktree com working tree sujo que não é seu.** Antes de atualizar qualquer branch, cheque `git status` e `git worktree list` — se está suja e é de outra sessão, **deixe quieto** e avise. Merge só entra em árvore limpa.
4. **Quando uma feature entra na `main`, todas as outras branches ficam atrasadas na hora.** Quem for retomar qualquer uma delas aplica a regra 1 primeiro. Ao fim de uma feature, considere propagar a `main` para as branches vivas limpas (FF as sem trabalho próprio; merge nas divergentes limpas; pular as sujas/conflitantes e reportar).
5. **Conflito ao atualizar = pare e resolva com cabeça** (ou escale), nunca escolha um lado no automático numa branch que não é sua. Preservar trabalho > branch "verde rápido".

---

## Migrations & Banco — DOUTRINA (projeto open-source)

**Este projeto é open-source. Toda mudança de schema DEVE sair como migration versionada** — quem clonou uma versão antiga do banco precisa conseguir atualizar aplicando as migrations em ordem. **Nunca** aplique `ALTER`/`CREATE` solto no banco sem o arquivo correspondente. Isto é critério de aceite de TODA sessão, não opcional.

Processo padrão (siga sempre):

1. **Arquivo versionado** em `supabase/migrations/` com o padrão `<timestamp>_<NNNN>_<slug>.sql`. O `NNNN` sai de `pnpm checar:colisao-de-migration`, nunca de `ls | tail`: o teto é a `main` mais todo PR em voo, e quem mescla primeiro fica com o número. Ver [`docs/doctrine/migrations.md`](docs/doctrine/migrations.md) §Numeração.
2. **Idempotente sempre que possível**: `add column if not exists`, `create ... if not exists`, `create or replace function`. Uma migration deve poder ser re-aplicada sem quebrar nem duplicar efeito.
3. **Portável em `psql` puro** (clones podem não usar o MCP/CLI Supabase): **sem** `create temporary table ... on commit drop` fora de transação explícita; **sem** `BEGIN`/`COMMIT` explícito (o runner já envolve em transação, como as demais migrations). Prefira CTEs, subqueries de janela e colunas-mapa (ex.: `is_merged_into`) a temp tables.
4. **Data migrations genéricas**: se a migration corrige/deduplica dados, escreva pensando em QUALQUER banco de clone (não hardcode IDs do seu tenant). Repointe FKs conferindo o catálogo (`information_schema` FK map) para não perder histórico.
5. **Registre no MANIFEST**: adicione uma linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") descrevendo versão, nome e o QUÊ/PORQUÊ.
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que o kit self-host aplica).** O baseline é um dump `--schema-only` + um **apêndice idempotente** no fim do arquivo (blocos rotulados `-- ---- <coisa> (migration NNNN) ----`). O kit HostGator aplica **só o baseline.sql**, tanto no `install.sh` (banco novo, `ON_ERROR_STOP=1`) quanto no `update.sh` (re-aplica em banco existente, **sem** `ON_ERROR_STOP`). Então toda mudança de schema pós-snapshot DEVE ser acrescentada ao apêndice, **idempotente e auto-curativa**: `add column if not exists`, `create ... if not exists`, `create or replace function`, e — se a mudança adiciona constraint — **deduplicar/corrigir os dados ANTES** de criar a constraint (senão o `update.sh` de um clone bugado quebra). Sem isto, clones não recebem a mudança (ou quebram ao atualizar). Migração adicionada só em `migrations/` mas não no baseline **não chega aos self-hosters**.
7. **Aplique e prove**: aplique via `mcp__plugin_supabase_supabase__apply_migration` (ou `supabase db push`), capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem de linhas que não pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Para mudanças de schema no kit, valide o baseline num Postgres descartável (`pgvector/pgvector:pg15` + extensões) aplicando `install` (fresh, `ON_ERROR_STOP=1`) e `update` (re-aplicar, sem a flag) — ambos têm que passar.
8. **Backfill de dados quebrados existentes**: constraint nova falha se os dados atuais a violam — a migration (e o apêndice do baseline) deve deduplicar/corrigir ANTES de criar a constraint.
9. **Função nova em `public` nasce EXPOSTA — revogue as DUAS origens.** Toda `create function` no schema `public` termina com:

   ```sql
   revoke execute on function public.fn_x(...) from public, anon;
   grant  execute on function public.fn_x(...) to <só quem precisa>;
   ```

   São duas origens de `EXECUTE` (default ACL para `anon` e grant a `PUBLIC`), e por isso o revoke
   cobre as duas. Racional em [`docs/doctrine/migrations.md`](docs/doctrine/migrations.md).

10. No `baseline.sql` vale a **última** definição de cada função. Pergunte ao banco (`pg_get_functiondef`) ou use `rfind`, nunca `grep` no arquivo. Ver [`docs/doctrine/migrations.md`](docs/doctrine/migrations.md).

**Resumo do fluxo de uma mudança de schema:** arquivo em `migrations/` (fonte da verdade p/ Supabase CLI) **+** apêndice idempotente no `baseline.sql` (p/ o kit self-host) **+** linha no MANIFEST. Os dois artefatos de schema andam juntos. Nunca edite migrations já aplicadas — corrija com uma "forward-fix" nova (e mais um apêndice no baseline).

---

## Skills relevantes a usar (Claude Code)

**Guias embutidos neste repositório** (`.claude/skills/`, espelho gerado de `.agents/skills/` — a
mesma tabela vale para Codex, Cursor, OpenCode e Antigravity; ver `AGENTS.md`). Para tê-los em
qualquer pasta, `bash scripts/instalar-guias.sh`; editando um guia numa branch, rode com `--fonte .`
naquele clone — no Claude Code a skill GLOBAL vence a do projeto com o mesmo nome:

- `deskcomm-instalar` — instalar, atualizar ou consertar a instalação numa VPS
- `deskcomm-cliente-novo` — configurar o CRM para um cliente ou nicho (agentes, roteadores, follow-ups, conhecimento)
- `deskcomm-metricas` — desempenho, conversão, custo de IA, funil, relatório
- `deskcomm-prompt` — afinar o prompt de um agente que não performa
- `deskcomm-contribuir` — o espelho da triagem, antes do PR; fica quieto para o mantenedor
- `deskcomm-extensao` — criar extensão em vez de PR no núcleo: régua de destino, contrato do pacote e envio
- `deskcomm-doutrina` — as três regras que mais custam, antes de escrever código
- `deskcomm-ler-suite` — ler o resultado do `pnpm test:unit` sem falso verde, antes de dizer que a suíte passou

Os guias têm página pública em [deskcomm.com.br/guias](https://www.deskcomm.com.br/guias), escrita
à mão em `deskcomm-site/conteudo/guias.ts`: guia criado, renomeado ou com comando novo pede a mesma
mudança lá — senão a página ensina um guia que não existe. Ela e a de changelog saem do mesmo PR do
`deskcomm-site`; enquanto as duas não responderem 200, vale o `curl` que abre a seção "A vitrine" de
[`docs/doctrine/versionamento.md`](docs/doctrine/versionamento.md), não a frase acima.

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — pra task com mais de 1 etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bugs reportados
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `tomik-db-doctrine` — referência cruzada de doutrina de schema
- `supabase:supabase` — qualquer task com Supabase
- `vercel:nextjs` — App Router, Server Components, edge runtime
- `vercel:ai-gateway` — config de fallback de provider
- `frontend-design` — UI distinta (não cair em shadcn-default genérico)

---

## Definition of Done

Antes de declarar uma task pronta:

1. `pnpm typecheck` passa zerado
2. `pnpm lint` zerado
3. Testes unit/e2e relevantes existem e passam
4. RLS testada se feature toca tabela tenant-aware
5. Audit log emitido se há mutação relevante
6. Rate limit aplicado se rota é pública
7. Zod valida todo input externo
8. Sem `console.log` esquecido
9. Env vars novas adicionadas em `.env.example` + `lib/env.ts`
10. Doc atualizada se mudou contrato (PRD/spec)
11. **Mudança de schema saiu como migration versionada + linha no MANIFEST** (ver Doutrina de Migrations) — clones conseguem atualizar
12. **Se tocou UI/fluxo de usuário: provado pela tela como um leigo faria**, em ambiente fresco estilo VPS, com evidência visual (ver Doutrina de QA Visual com Recursos Reais) — curl não conta. Quando o caminho passa por um agente de IA, o caso de aceite mede o **par** (a tela pelo agente + a ferramenta chamada direto, com o mesmo texto cru) e só conta como prova quando os dois concordam — emenda em [`docs/doctrine/prova-em-par.md`](docs/doctrine/prova-em-par.md) (#489)
13. **Living System Checklist respondido** (lei em `docs/doctrine/sistema-vivo.md`; racional no manual `docs/doctrine/sistema-vivo/`) — a feature não é ilha: tem entrada + saída, emite atividade/log, aparece na tela, tem porta na navegação, tem mecanismo anti-morte, **declara seu laço de retorno** (invariante 7 — o que muda no sistema quando ela erra), e o mapa vivo (`docs/architecture/`) reflete peça nova com ≥2 arestas. Resposta que não **nomeia o artefato concreto** (consumidor real, tela real, log real) não conta
14. **Tela nova tem porta** — declarada em **`lib/navigation/catalogo.ts`** (no `NAV_CATALOG`, com seu grupo), ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes: o CI reprova tela que existe mas em que só se chega digitando a URL.

    ⚠️ Esta linha dizia `lib/navigation/registry.ts`, e quem a seguisse abria um
    arquivo **sem um único lugar onde declarar**: o `registry.ts` só deriva
    (`NAV_DESTINATIONS` sai de `NAV_CATALOG`) e reexporta. Ele é a FACE do
    módulo — é dele que o teste importa, e por isso o engano é fácil. Quem
    declara é o catálogo. Para conferir sem acreditar nesta linha:

    ```bash
    grep -c 'href:' lib/navigation/catalogo.ts lib/navigation/registry.ts
    ```
15. **Se tocou Dockerfile, compose ou setup kit: a mudança chega a quem já instalou** (lei em `docs/doctrine/packaging.md`) — nenhum serviço de produção ficou `build:`-only; variável nova tem default que não quebra `.env` antigo; a atualização não pede edição manual de arquivo; e, se mudou o que a imagem contém, o `update.sh` alcança essa peça. Rode `pnpm test:shell` — é o único gate que exercita o kit
16. **Se o PR muda comportamento, procure a afirmação de estado sobre esse comportamento.** Só
    sobre o que você mudou, e só nos documentos de autoridade — não saia caçando pelo repo. A
    documentação afirma como o mundo *está*, e uma auditoria de 2026-08-14 achou **227
    afirmações desatualizadas em 393 medidas**
    ([`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md)).
    Onde a afirmação puder virar **comando**, troque em vez de corrigir: um número corrigido
    envelhece de novo; um `rode isto para saber` não envelhece nunca

17. **Se o PR muda comportamento visível a quem opera uma VPS, ele traz o seu fragmento em
    `.changes/`** (lei em [`docs/doctrine/versionamento.md`](docs/doctrine/versionamento.md)).
    O fragmento declara **o efeito no operador** — `nada_mudou` / `capacidade_nova` /
    `exige_acao` —, nunca o número: o número é calculado a partir do conjunto, e é por isso
    que duas sessões paralelas não colidem mais. Confira com `pnpm release:conferir`.
    O CI valida a FORMA de todo fragmento, mas **não** cobra a presença de um — cobrar
    presença num check obrigatório reprovaria PR de Dependabot, PR de fork, e o próprio PR
    de release, que consome os fragmentos e deixa o diretório vazio. A presença é cobrada
    aqui, e por quem revisa.
    **Toda versão publicada aparece na página de changelog da LP** (deskcomm.com.br/changelog,
    pt-BR/en/es). Ninguém escreve no site: a LP lê o `CHANGELOG.md` da `main`, e o último passo
    do corte (`release.yml`, job `cortar-tag`) reprova quando a versão não chegou. O texto do
    fragmento é, portanto, nota pública. Enquanto as três páginas não responderem 200 esse passo
    reprova TODO corte — a vitrine vem de um PR do `deskcomm-site`, e o `curl` que diz em que
    estado ela está abre a seção. Lei: seção "A vitrine" de `versionamento.md`.

18. **Se o PR muda comportamento, ele declara o destino: núcleo, extensão, ambos ou
    infraestrutura** (lei em [`docs/doctrine/extensoes.md`](docs/doctrine/extensoes.md)), com a razão
    medida pela pergunta "se nenhuma organização ativar isto, a operação comum continua inteira?".
    "Ambos" traz o consumidor real do ponto novo do núcleo e a prova dos dois lados. Classificar como
    extensão não autoriza remover nem desligar o que já foi distribuído.

Um staff engineer aprovaria? Se não, itera.
