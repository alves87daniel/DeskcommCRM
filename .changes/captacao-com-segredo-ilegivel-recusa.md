---
impacto: exige_acao
secao: corrigido
titulo: A fonte de captação com assinatura recusa o envio quando não consegue ler o próprio segredo
---
Uma fonte de captação com assinatura (HMAC) aceitava qualquer envio, sem conferir, quando a instalação não conseguia ler o segredo dela, por exemplo depois de trocar a chave mestra. Agora ela recusa com 401 e registra em "Leads recebidos" o motivo "O segredo de assinatura desta fonte não pôde ser lido nesta instalação". Fonte sem assinatura e fonte com segredo legível continuam como antes. Porte da correção do projeto original.

## Requer atenção

Se você tem alguma fonte de captação com assinatura (HMAC) criada antes desta versão, faça uma destas duas coisas para cada uma delas, logo depois de atualizar:

1. Envie um teste assinado pela ferramenta que manda os leads, como um formulário de teste, e confira em Webhooks › Leads recebidos que ele chegou como lead criado.
2. Ou recrie a fonte: crie uma fonte nova em Webhooks › Receber dados, troque o endereço no formulário que envia os leads e exclua a fonte antiga. A fonte nova nasce sem assinatura, porque a tela ainda não grava o segredo.

Não espere uma recusa aparecer para agir: a fonte afetada só registra a recusa quando chega um envio, e esse envio já é um lead perdido. Fontes sem assinatura não são afetadas.
