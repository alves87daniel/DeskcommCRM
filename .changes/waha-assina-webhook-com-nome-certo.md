---
impacto: nada_mudou
secao: corrigido
titulo: O WAHA passa a assinar as entregas de webhook e a exigência de assinatura volta a funcionar
---

O compose entregava o segredo ao contêiner do WAHA numa variável que não existe na documentação dele (`WHATSAPP_HOOK_HMAC` em vez de `WHATSAPP_HOOK_HMAC_KEY`). O WAHA ignorava a variável e nunca assinava nada, e ligar "Exigir assinatura nas entregas do canal" cortava a entrada de mensagens com `401 signature_required`. Agora o nome é o da documentação, nos três composes e no runbook. Na atualização o contêiner do WAHA é recriado e passa a mandar `X-Webhook-Hmac` em toda entrega, assinada com o mesmo `WAHA_HMAC_SECRET` que o CRM já usa para conferir. Nenhuma ação do operador: o segredo é o mesmo, só o nome da variável mudou. A exigência de assinatura continua desligada por padrão; ligue-a depois de ver no log que as entregas chegam com `valid_signature = true`.
