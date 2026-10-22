---
impacto: nada_mudou
secao: corrigido
titulo: As imagens do CRM sobem no Node 22.23.4, com o conserto do Brotli (CVE-2026-111497)
---

O app, o worker e o agente de voz passam a ser construídos sobre o Node 22.23.4, a versão que corrige a rodada de segurança de 21/10/2026 — entre elas a CVE-2026-111497, uma escrita fora dos limites no decodificador Brotli que permitia execução remota de código. A versão fica fixada no patch, e não mais na linha 22 inteira, para que uma imagem nova nunca volte a sair com um Node anterior ao conserto. Quem opera a VPS não faz nada: a próxima atualização puxa as imagens novas. Crédito: @alves87daniel.
