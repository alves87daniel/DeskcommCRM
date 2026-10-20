---
impacto: nada_mudou
secao: corrigido
titulo: A fonte de captação com assinatura recusa o envio quando não consegue ler o próprio segredo
---
Uma fonte de captação com assinatura (HMAC) aceitava qualquer envio, sem conferir, quando a instalação não conseguia ler o segredo dela, por exemplo depois de trocar a chave mestra. Agora ela recusa com 401 e registra em "Leads recebidos" o motivo "segredo de assinatura não pôde ser lido". Para voltar a receber, cadastre a assinatura de novo na fonte. Fonte sem assinatura continua como antes. Porte da correção do projeto original.
