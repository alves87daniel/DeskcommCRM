---
impacto: nada_mudou
secao: corrigido
titulo: Os pedidos de privacidade, os honorários e a lista de conversas de uma conversa de atendimento também ficam do lado do contato do turno
---

O #2182 escopou ao contato da conversa as quatro leituras do Atender, mas deixou três
ferramentas e um conserto de página de fora. Um pedido de EXCLUSÃO de outro cliente
(`crm_list_privacy_requests`) continuava chegando ao modelo como instrução de "não insista
com esta pessoa", e o contrato e as parcelas de honorários de um caso que não é desta
conversa (`crm_get_honorarios_contrato`, `crm_list_honorarios_parcelas`) continuavam
trazendo valor, percentual e repasse para o lado de cá. As três agora leem
`ctx.contatoDoTurno`: a lista de privacidade filtra a própria consulta pelo contato do
turno, e o contrato e as parcelas são recusados — antes da consulta — quando o caso não
é deste cliente, com a mesma resposta para caso que não existe, caso de outra organização
e caso de outro cliente: um uuid não vira oráculo de existência.

`crm_list_conversations` também passa a filtrar o contato NA CONSULTA, e não mais na
página que o handler já tinha truncado: com a conversa mais antiga do mesmo cliente fora
da primeira página, o agente ouvia que não havia mais nada. No predicado, cursor e
`has_more` voltam a valer, porque a página já é do contato. O `404` de um uuid
inexistente em `crm_get_conversation_history` passa a ser a MESMA recusa de uma conversa
de outro cliente, em vez de dois estados distintos para o mesmo "não é seu para ler".

Sem contato do turno — rota HTTP, MCP externo, agente sem conversa — nada muda.

Refs #2184

Contribuição de @webtecnica (#2184).
