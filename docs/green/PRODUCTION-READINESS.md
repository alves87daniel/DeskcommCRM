# ConectorGreen - Backlog de produção sobre a GREEN-BASELINE-1.0

Consolida todos os gaps conhecidos e ainda pertinentes das cinco frentes Green (relatórios em `docs/spike/`) e os
achados da própria GREEN-BASELINE-1.0. Fundação: [`GREEN-BASELINE-1.0.md`](GREEN-BASELINE-1.0.md).

## Régua

| Classe | Significado                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------- |
| P0     | Antes do primeiro deploy de produção. Não impede construir produto sobre a baseline                       |
| P1     | Produção com prioridade alta: tratar no começo da construção, ou entrar em produção com mitigação escrita |
| P2     | Dívida técnica consciente                                                                                 |
| INFO   | Fato documentado; nenhuma ação pedida                                                                     |

**Nenhum item deste backlog é BLOCKER da baseline.** BLOCKER impediria declarar a fundação; os cinco BLOCKERs que as
spikes acharam (LIFE-ADV-01, STRUCT-B1..B4, CUT-B1/B2) foram fechados pelas migrations 0506-0508. Nenhum DÉBITO foi
promovido a BLOCKER, e nenhum item foi resolvido nesta tarefa.

Siglas das origens: MC1/MC2/MC3 = `GREEN-MUTATION-CONTEXT-V1/V2/V3.md`; LC1/LC12/LC13 = `GREEN-LEAD-LIFECYCLE-V1/V1.2/V1.3.md`;
AUTO = `GREEN-AUTOMATION-ORIGIN-V1.md`; STRUCT = `GREEN-STRUCTURAL-BOUNDARY-V1.md`; CUT = `GREEN-CANONICAL-EVENT-CUTOVER-V1.md`;
BASE = achado da GREEN-BASELINE-1.0 ([`VALIDATION-CLOSURE.md`](VALIDATION-CLOSURE.md)). Itens que os relatórios
numeraram sem ID aparecem como `<relatório>-§<seção>`.

## P0 - antes de produção

### P0-01 - Ordem de deploy: banco (0508) antes do servidor

- **Origem:** CUT-GAP-01 (CUT §7.3, §16).
- **O quê:** o servidor da baseline manda `x-green-scope-id`; quem entende o escopo é a 0508.
- **Por que antes do deploy:** na ordem inversa, o servidor novo fala com a 0507, que ignora o escopo e mantém o
  supressor temporal com os defeitos medidos (evento duplicado e evento legítimo engolido, CUT §5) até a migration
  chegar. Na ordem certa, o servidor antigo não manda escopo e o gêmeo dele para lead Green simplesmente não nasce
  (nunca duplica); lead comum não muda.
- **Fecha quando:** o runbook de deploy do ConectorGreen tiver o passo "aplicar o banco, conferir a 0508, só então
  trocar a imagem", ensaiado no P0-09.

### P0-02 - Preflight estrutural antes da 0507

- **Origem:** STRUCT-GAP-01 (a) (STRUCT §13 U2, §16, §17).
- **O quê:** o bloco 0 da 0507 recusa a migration inteira (`green_structural_legacy_violation`, contagens no
  `detail`) quando a base tem estrutura impossível herdada (lead com etapa de outro funil ou organização, e afins).
- **Por que antes do deploy:** a recusa não é hipotética: no stack local com dados acumulados, a primeira aplicação
  recusou 4 leads legados, corrigidos pela fronteira antes de a 0507 aplicar. Em produção a descoberta tem de acontecer
  antes da janela, não durante. O kit (`update.sh`) reaplica o baseline sem `ON_ERROR_STOP` e filtra erro por texto;
  o comportamento dele diante dessa recusa não foi medido.
- **Fecha quando:** as mesmas contagens do bloco 0 rodarem numa cópia da base de produção e derem zero (ou o legado
  for corrigido pela fronteira, como no STRUCT §16), com o resultado anexado ao runbook.

### P0-03 - Validação das FKs compostas com volume real

- **Origem:** STRUCT-GAP-01 (b) (STRUCT §17).
- **O quê:** a 0507 troca `crm_stages_pipeline_id_fkey`, `crm_leads_pipeline_id_fkey`, `crm_leads_stage_id_fkey` e
  `product_pipeline_binding_pipeline_id_fkey` por FKs compostas e as valida na hora, varrendo `crm_leads` e
  `crm_stages` sob `SHARE ROW EXCLUSIVE`.
- **Por que antes do deploy:** com volume real, a varredura segura a escrita em `crm_leads` de todas as organizações
  pelo tempo da validação. A migration não é editada (0501-0508 ficam como estão): a estratégia é de deploy.
- **Fecha quando:** a duração da 0507 for medida numa cópia com o volume de produção e houver decisão escrita: janela
  de manutenção suficiente, ou passo de deploy que crie as FKs `NOT VALID` e rode `VALIDATE CONSTRAINT` fora do pico
  antes da migration (que então só encontra o estado final).

### P0-04 - Fila de relógio drenada antes da 0506

- **Origem:** AUTO-GAP-03 (AUTO §14, §15).
- **O quê:** eventos de relógio (`lead.stage_stale`, `lead.silent_for`, `lead.date_field_due`, `contact.birthday`)
  emitidos antes da 0506 não têm carimbo em `green.scheduler_trigger_emission`.
- **Por que antes do deploy:** drenados depois e apontando lead Green, a raiz é recusada
  (`green_automation_trigger_untrusted`, fail-closed) e o cron não reemite a mesma âncora: a automação daquele lead
  simplesmente não acontece. Só afeta a transição, por isso se resolve no rollout.
- **Fecha quando:** o runbook drenar a fila de relógio (nenhum desses eventos `pending`/`processing`) antes de aplicar
  o banco.

### P0-05 - Barramento `emit_event` aberto para `lead.*` (relato forjável)

- **Origem:** AUTO-GAP-01 (AUTO §1, §6, §14; CUT §5 S12, §6, §16).
- **O quê:** `public.emit_event` é executável por qualquer membro da organização (viewer em diante) e só reserva
  `message.received`, `appointment.outcome_confirmed` e `ai.case_*`. A 0508 fechou o relato sem escopo para lead
  Green, mas um escopo inventado no header passa: o header de escopo é transporte, não autorização.
- **Por que antes do deploy:** com usuários reais, um viewer consegue gravar um `lead.*` com o tipo, o sujeito e a
  regra certos, e esse fato dispara automação e follow-up como se a mudança tivesse acontecido. É falha de autorização
  no barramento, não de consistência interna, e o upstream não a corrige.
- **Fecha quando:** `lead.*` (e os demais tipos que disparam regra Green) deixarem de ser emitíveis por
  `authenticated` - reservar os tipos de gatilho a produtores de servidor/trigger ou exigir papel de escrita no
  `emit_event` (AUTO §14) -, com teste de banco que prove a recusa e a não-regressão dos produtores legítimos com sessão
  (agenda, move/bulk, `message.failed`).

### P0-06 - Escala da zona de perigo e custo do lock do binding

- **Origem:** LIFE-ADV-05 (LC1 §10.4; LC12 §15.2, §17; LC13 §9.2, §10), STRUCT-GAP-05 (STRUCT §11-§12), CUT §9.
- **O quê:** `public.fn_apagar_dados_operacionais_da_org` apaga a organização inteira numa transação (lápides, linhas
  de livro-razão, WAL). Criar ou remover um binding reivindica identidades sob `SHARE ROW EXCLUSIVE` em
  `public.crm_leads` (todas as organizações) pelo tempo da transação. Pela API, as duas operações herdam o teto do
  PostgREST: `statement_timeout=8s` e `lock_timeout=4s` no papel `authenticator`, que o `service_role` não sobrescreve
  (conferido no catálogo do stack local).
- **Números medidos:** 3000 leads Green apagados pela RPC em 3,4-3,75 s (LC12 §17); binding com 500 leads numa
  transação, abaixo do teto (STRUCT §11 AT1). Extrapolando linearmente, o teto de 8 s chega na casa de 6-7 mil leads
  Green por organização no hardware de teste; o limite real precisa ser medido.
- **Por que antes do deploy:** falhar por tamanho é seguro (nada é apagado, o binding não nasce), mas a zona de perigo
  fica inutilizável em organização grande, e um binding grande trava escrita de leads de todos os tenants enquanto
  roda.
- **Fecha quando (mínimo):** medição com o volume esperado de produção e limite operacional escrito (tamanho máximo
  de organização para a zona de perigo; binding grande só em janela). **Solução completa (pode virar P1 se o limite
  cobrir os tenants reais):** lote com fronteira explícita na zona de perigo (LC1 §10.4) e lock por organização ou
  advisory lock por pipeline no binding (LC13 §9.2).

### P0-07 - Triagem de segurança do upstream depois da v1.69.0

- **Origem:** BASE (ADR-GREEN-001, D3 e D5).
- **O quê:** em 2026-10-04 o upstream já publicou v1.70.0, v1.71.0 e v1.72.0 (984 commits depois da fundação, 27
  migrations acima da 0500). Pelos nomes, várias são de segurança e privilégio: `0521_avisos_do_security_advisor`,
  `0525_auditoria_so_inclusao_para_todo_papel`, `0529`/`0533_support_readonly_nao_escreve_*`,
  `0532_anonimizar_exige_plataforma_full`, `0508_platform_admin_full_so_escreve` (numeração do upstream).
- **Por que antes do deploy:** a ADR-GREEN-001 tira do upstream o papel de fornecedor de patches. Ir para produção
  com correções de segurança conhecidas e não avaliadas é risco evitável.
- **Fecha quando:** cada release do upstream posterior à v1.69.0 tiver decisão registrada (portar, adaptar,
  ignorar), os itens de segurança aplicáveis portados com número da sequência do ConectorGreen (0509+), e a triagem
  virar rotina por release.

### P0-08 - CI, imagens e branch protection próprios

- **Origem:** BASE.
- **O quê:** o repositório `alves87daniel/DeskcommCRM` é um fork sem GitHub Actions habilitado (0 workflows
  registrados, 0 execuções) e sem branch protection na `main`. Os workflows herdados assumem o upstream: publicam
  imagens em `ghcr.io/<dono>/deskcomm*` a cada push na `main`, abrem PR de release e cortam tag por GitHub App
  (`release.yml`), rodam um cron a cada 5 minutos (`relogio.yml`) e comentam em PRs (`vigia-de-colisao.yml`).
- **Por que antes do deploy:** pela doutrina de packaging herdada, instalação de produção puxa imagem publicada pelo
  CI e nunca constrói na máquina do cliente; sem CI não há imagem nem gate. Ligar os workflows como estão publicaria
  imagens e releases com identidade do Deskcomm.
- **Fecha quando:** os workflows forem revisados para o ConectorGreen (nomes de imagem, release, cron, guardas de
  fork), o Actions for habilitado por decisão do dono e a `main` exigir os checks equivalentes a `verify`,
  `invariants`, `build-and-size`, `e2e` e `imagens-ok`, mais as suítes Green (`tests/green-e2e` não roda em nenhum
  workflow hoje).

### P0-09 - Ensaio de rollout com a imagem de produção

- **Origem:** MC3-§12.N2 (MC3 §12), CUT-GAP-05, BASE.
- **O quê:** os E2Es Green rodaram com `next build` + `next start` em Node 22; o servidor `standalone` do `Dockerfile`
  (`.next/standalone/server.js`) nunca foi exercitado. A `test:db` roda em Postgres 15 e o stack dos E2Es em Postgres 17.
  Durante o `update.sh`, os apêndices 0501/0502 são reaplicados antes do da 0508 e o supressor antigo existe por
  instantes ao lado do porteiro (os dois só recusam).
- **Por que antes do deploy:** produção roda a imagem, não o `next start` da máquina de desenvolvimento, e aplica o
  baseline sobre dados reais. Os itens P0-01 a P0-04 só se provam num ensaio.
- **Fecha quando:** um staging com cópia dos dados de produção (origem Deskcomm v1.69.0) fizer o upgrade pelo caminho
  real, na ordem do P0-01, e os E2Es Green passarem contra a imagem publicada pelo CI do P0-08.

## P1 - produção, prioridade alta

| ID    | Origem                 | Item                                                                                                                                                                                                                          | Por que P1                                                                                                                                                                                                    |
| ----- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | LC1-§10.3              | Recusa Green (contexto ausente, estrutura inválida, origem não provada) aparece só em log (`logger.error`/`console.error`), não como aviso na Central                                                                         | É fail-closed, então nada se corrompe; mas o operador não vê por que um lead não nasceu ou não andou. Os relatórios pediram decisão "antes do baseline": é decisão de produto e entra no começo da construção |
| P1-02 | LC1-§10.2              | Contato apagado com histórico (`fn_apagar_contato_com_historico`, 0488): a Opportunity Green perde o contato (`SET NULL`) sem registro Green                                                                                  | Não quebra contrato Green (lead, identidade e canônicos ficam), mas é comportamento de LGPD e de produto que precisa de decisão antes de dados reais                                                          |
| P1-03 | MC3-§12.N1, LC1-§10.I3 | Regra de construção: toda rota, tool ou job NOVO que escreva lead pelo client de serviço em funil possivelmente Green declara o boundary (`runGreenRequestBoundary` / `withGreenSystemRoot`); sem ele, falha fechado em Green | A construção do produto começa agora e vai criar writers; hoje a regra é texto. Precisa de cerca (teste estrutural) antes de o primeiro writer novo entrar                                                    |
| P1-04 | BASE (ADR-GREEN-001)   | Guardas herdadas medem o upstream: `pnpm checar:colisao-de-migration`, `scripts/conferir-isolamento-do-kit.sh` (última release do Deskcomm), comandos de branch protection do `CLAUDE.md`                                     | Os números 0501-0508 e três timestamps já colidem com o upstream; a guarda de colisão precisa medir a `main` do ConectorGreen antes da 0509                                                                   |
| P1-05 | BASE                   | `CLAUDE.md`, `AGENTS.md`, `README*` e a marca padrão ainda descrevem o Deskcomm (e mandam medir `melgarafael/DeskcommCRM`)                                                                                                    | Agentes e pessoas leem a doutrina antes de codar; até ela ser adaptada, a ADR-GREEN-001 prevalece sobre o que ela diz de upstream, e isso precisa estar escrito nela                                          |

## P2 - dívida técnica

| ID    | Origem                                                     | Item                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01 | AUTO-GAP-02 (com ADV-08, ADV-12)                           | Backend que declara `rule:*` / `source=automation` sem a origem `automation` continua lido como causado por regra pelo anti-loop; writer privilegiado sem `service_origin` continua aceito. Só o backend alcança                                                                                                                                            |
| P2-02 | CUT-GAP-04 (= "DÉBITO-02" do CUT §10)                      | `lead.created` continua do writer, depois do commit, em outra request (não atômico, como no upstream); o registro atômico do nascimento Green é `green.lead_birth_provenance`                                                                                                                                                                               |
| P2-03 | STRUCT-GAP-04                                              | `lib/database.types.ts` descreve as quatro FKs da 0507 com uma coluna; sem efeito em runtime (embeds por nome provados). Regenerar os tipos                                                                                                                                                                                                                 |
| P2-04 | LC12-§15.3 (INFO no LC13 §10)                              | `idempotency_key` do MCP (declarada pelo cliente em `Idempotency-Key`) fica no envelope `trusted`. Nenhum consumidor de controle a lê hoje; P2 porque vira risco no dia em que um ler. Mover para advisory, como o `client_request_id`                                                                                                                      |
| P2-05 | LC12-§15.5, MC2-§10.8, LC1-§10.10, AUTO-GAP-08, MC3-§12.N4 | Retenção do domínio Green: `green.lead_identity` (sem PII, uma linha por lead que tocou o domínio, sobrevive à organização por desenho), `stage_event_ledger`, `lead_birth_provenance`, `scheduler_trigger_emission`; o canônico no `event_log` não é apagável por `service_role` e `TRUNCATE` não é coberto. Nenhum job do upstream apaga `event_log` hoje |
| P2-06 | CUT-GAP-02                                                 | Contrato de confiança no escopo: o porteiro grava o relato de um escopo do servidor que não canonizou aquela transição; os 6 writers só relatam depois de UPDATE bem-sucedido                                                                                                                                                                               |
| P2-07 | CUT-GAP-03                                                 | Writers ainda fazem a request de relato para lead Green (vira no-op): custo de latência                                                                                                                                                                                                                                                                     |
| P2-08 | AUTO-GAP-06                                                | Régua de gatilhos espelhada em SQL (`fn_automation_trigger_entity`/`_family`, `WHEN` do carimbo) e em TS; gatilho novo sem espelho falha fechado em Green                                                                                                                                                                                                   |
| P2-09 | STRUCT-GAP-02                                              | Lead comum "torto" (etapa de outro funil da mesma organização) continua possível no upstream; o Green recusa a entrada dele                                                                                                                                                                                                                                 |
| P2-10 | LC12-§15.6                                                 | A cerca estrutural do request id (`lib/green/request-id-v12.test.ts`) é lexical; seam futuro com outra forma sintática precisa de teste de comportamento                                                                                                                                                                                                    |
| P2-11 | LC1-§10.9, EV-01B residual                                 | Webhook-in e prospecção provados por dublê e unidade, não pelo PostgREST real; a troca de log do voice-agent não tem teste                                                                                                                                                                                                                                  |
| P2-12 | MC1-§8.4, ADV-12                                           | Ator privilegiado é declarado, não provado (fora da automação); writer dentro de job sai como `system/<job.kind>`                                                                                                                                                                                                                                           |

## INFO

| Origem                                     | Fato                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BASE (ADR-GREEN-001)                       | Origem de upgrade suportada = Deskcomm v1.69.0. Seis números (0501-0504, 0506, 0508) e três timestamps (`20260930180000`, `20261003200000`, `20261004090000`) da cadeia Green colidem com migrations do upstream                                                                  |
| BASE                                       | Merge da adoção sem checks: o fork não tem workflow nem branch protection (ver P0-08); a regressão equivalente rodou localmente ([`VALIDATION-CLOSURE.md`](VALIDATION-CLOSURE.md))                                                                                                |
| CUT-GAP-05                                 | Colunas `legacy_suppressed_at`/`legacy_request_id` e índice `stage_event_ledger_twin_idx` ficam como histórico (não escritos)                                                                                                                                                     |
| INFO-07 (CUT) = STRUCT-GAP-03              | Binding não gera evento por lead: entrada = identidade `live` com `first_seen_at` na transação; saída = `green.binding_removed` com `released_leads` (decisão do CUT §9)                                                                                                          |
| STRUCT-GAP-10                              | `released_leads` conta, não lista quais leads cada remoção soltou                                                                                                                                                                                                                 |
| INFO-01 (CUT)                              | Reordenação de lead comum (`from = to`) continua emitindo `lead.stage_changed` e alguns consumidores reagem (upstream); no Green deixou de ser fato                                                                                                                               |
| INFO-02 (CUT)                              | `lead.bulk_moved` não tem consumidor e fica `pending` para sempre (upstream)                                                                                                                                                                                                      |
| INFO-03 (CUT)                              | Agenda pela sessão: o lead comum perde o `lead.stage_changed` desse caminho (`reserved_service_origin`, upstream); no Green o fato é o canônico                                                                                                                                   |
| INFO-04 (CUT)                              | Payload legado traz `status` de antes do movimento; o canônico traz o de depois. Nenhum consumidor lê                                                                                                                                                                             |
| INFO-05 (CUT)                              | `call_webhook` repassa o payload inteiro: integrador recebe o formato canônico para lead Green (sem `position_in_stage`)                                                                                                                                                          |
| INFO-06 (CUT)                              | Achados de passagem do upstream: prospecção grava `lead.created` com `request_id=rule:<campanha>`; condição curada `event.to_stage_id` de `lead.stage_stale` nunca casa                                                                                                           |
| AUTO-GAP-04                                | Execução = par (regra, evento) enquanto o evento está vivo; redelivery não duplica no Green, o registro upstream ganha uma linha por passagem                                                                                                                                     |
| AUTO-GAP-05                                | Devolver um evento `done`/`dead` a `pending` (só `service_role`/dono) o torna executável de novo                                                                                                                                                                                  |
| AUTO-GAP-07                                | Regra desativada ou editada no meio da execução recusa a escrita Green (run `failed`, visível)                                                                                                                                                                                    |
| STRUCT-GAP-06..09                          | Upstream: arquivar etapa são duas instruções sem transação comum; `is_won`/`is_lost` de etapa muda o fechamento de quem entrar; outras referências a etapa/funil seguem com FK simples; exclusão de funil com lead comum torto responde 500                                       |
| MC3-§12.N5, LC1-§10.5                      | Excluir a organização apaga os canônicos dela (exceção deliberada); o rastro é `green.binding_removed` com `org_deleted = true`                                                                                                                                                   |
| MC3-§12.N6                                 | A fronteira AFTER roda depois dos AFTER do upstream em `crm_leads` (ordem alfabética dos triggers)                                                                                                                                                                                |
| MC3-§12.N7                                 | Canônicos da v2 sem envelope só existem em bancos de spike; nenhuma base de produção rodou a v2                                                                                                                                                                                   |
| MC1-§4 (S14)                               | Não há exactly-once geral: replay com a mesma `idempotency_key` gera segundo evento no upstream; o Green não duplica por redelivery do motor                                                                                                                                      |
| LC12-§8, LC12-§15.4, LC13-§9.1, LC13-§10.5 | Resíduos aceitos: erro revela "UUID já retirado do domínio" a quem escolheu o UUID; backfill da 0504 não alcança orgs apagadas antes dela; estado impossível só por escrita do dono; `TRUNCATE` herdado para `anon`/`authenticated` em `public` (upstream, sem rota no PostgREST) |
| LC1-§10.8, LC1-§10.I1                      | Estado parcial não-Green do upstream em webhook-in e prospecção; `fn_event_log_e_registro` redefinida pela cadeia (drift vigiado pela cerca de evento-fato)                                                                                                                       |
| MC1-§8.5..§8.7, MC2-§8                     | Custo por linha dos triggers Green; header Green viaja em toda chamada do SDK dentro do contexto; `caller=direct` aceita GUC; o dono do banco está fora do modelo de ameaça                                                                                                       |
| MC3 §14.2, CUT §14.2                       | Asserções de suítes seladas alteradas por mudança de contrato declarada (válvula `DESKCOMM_GOV_INVARIANTS_EDIT=1`), documentadas nos relatórios                                                                                                                                   |
| BASE                                       | `test:db` roda em Postgres 15 (piso); o stack dos E2Es é Postgres 17                                                                                                                                                                                                              |
