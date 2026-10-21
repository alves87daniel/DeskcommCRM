---
impacto: nada_mudou
secao: corrigido
titulo: O teto de escrita por token passa a valer também no envio de mídia e na abertura de conversa
---
Duas rotas que aceitam token de servidor (Bearer `dsk_`) não contavam as escritas no teto: enviar mídia na conversa e abrir conversa pelo contato compartilhado. Uma integração em laço por ali não encontrava limite nenhum. Agora elas seguem o mesmo teto por token e por organização das outras rotas e respondem 429 quando a cota da janela acaba. Quem usa a tela não tem teto e não percebe diferença. Não é preciso fazer nada na instalação. Porte da correção do projeto original, contribuição de @webtecnica.
