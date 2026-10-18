# WAHA — grupos e mensagens presas em envio

> Saiu do `CLAUDE.md` (seção WAHA) no enxugamento da issue #21. A regra fica lá, em uma linha com
> ponteiro para cá; este arquivo guarda o detalhe, a medição e o porquê.

## Grupos

- Grupos: entram **só os ligados** em Conexões › Grupos (`channel_session_groups`). O grupo ligado vira conversa `is_group` com um contato `kind = 'whatsapp_group'` que nunca entra em funil, lista, campanha ou IA; o remetente é `p.author` (nunca `p.from`), gravado em `messages.metadata.group_sender` (`lib/messaging/remetente-de-grupo.ts`). Para conversa de grupo o banco emite `message.group_received`, e não `message.received`, e o roteamento automático pula grupo. O filtro `ignore.groups` do WAHA é propriedade desta funcionalidade (`definirRecebimentoDeGrupos`); compatibilidade e convergência não o tocam. Spec: `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`

## Cron `recover-stuck-messages`

- Cron `recover-stuck-messages` (`app/api/v1/cron/recover-stuck-messages/route.ts`, agendado no `scheduler` do `docker-compose.prod.yml`): marca `status='sending'` há >5min como `failed` **e abre aviso na Central** (`agent_inbox_items` kind `message_send_stuck`). Não toca em `queued`: esse estado tem dono (o agent-engine reagenda por `SEND_QUEUED_RETRY_MS`), e falhá-lo perderia mensagem que ia sair. Não reenvia — envio em dobro é pior que não-envio
