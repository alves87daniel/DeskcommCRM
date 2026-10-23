---
impacto: nada_mudou
secao: corrigido
titulo: Um usuário logado deixa de conseguir descobrir a empresa e o agente de qualquer número de telefone cadastrado na instalação
---

A função do banco que descobre a empresa e o agente de um número de telefone, usada pelo atendimento por voz, podia ser chamada por qualquer pessoa logada no CRM, de qualquer empresa da instalação. Agora só o servidor a chama. O atendimento por voz continua igual. No mesmo ajuste, sete funções do banco passam a ter o caminho de busca fixo, como o Security Advisor do Supabase pede. Não é preciso fazer nada na instalação.
