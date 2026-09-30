---
impacto: capacidade_nova
secao: corrigido
titulo: Teto de escrita por token passa a valer também nos uploads de mídia e nas rotas de rascunho e de abertura de conversa
---

Quatro rotas que aceitam autenticação por token de servidor (Bearer `dsk_`)
aplicavam a autenticação sem o teto de escrita — o que uma integração em laço
fazia por ali não era contado em lugar nenhum: `drafts/consume`, o anexo de
nota interna e os dois caminhos de mídia (`conversations/[id]/media`) e de
abertura de conversa pelo contato compartilhado. Essas três rotas passam agora
a chamar o mesmo `tetoDeEscritaDoToken` que as irmãs (`messages`, `drafts`,
`leads` e a agenda) já usavam.

O efeito para quem integra é o mesmo que já existe nas outras rotas: por token,
cada rota passa a respeitar o teto por token e por organização da janela em
vigor, recusando com 429 quando a cota esgotar. Quem autentica pela sessão do
navegador não tem teto e não muda nada. Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2012).