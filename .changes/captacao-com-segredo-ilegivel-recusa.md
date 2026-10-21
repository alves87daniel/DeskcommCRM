---
impacto: exige_acao
secao: corrigido
titulo: A fonte de captação com assinatura recusa o envio quando não consegue ler o próprio segredo
---
Uma fonte de captação com assinatura (HMAC) aceitava qualquer envio, sem conferir, quando a instalação não conseguia ler o segredo dela, por exemplo depois de trocar a chave mestra. Agora ela recusa com 401 e registra em "Leads recebidos" o motivo "O segredo de assinatura desta fonte não pôde ser lido nesta instalação". Fonte sem assinatura e fonte com segredo legível continuam como antes. Porte da correção do projeto original.

## Requer atenção

Depois de atualizar, abra Webhooks › Leads recebidos. Se aparecer alguma recusa com o motivo "O segredo de assinatura desta fonte não pôde ser lido nesta instalação", essa fonte parou de receber leads. Para voltar a receber, crie uma fonte nova em Webhooks › Receber dados, troque o endereço no formulário que envia os leads e exclua a fonte antiga. A fonte nova nasce sem assinatura, porque a tela ainda não grava o segredo. Se nenhuma recusa com esse motivo aparecer, não há nada a fazer.
