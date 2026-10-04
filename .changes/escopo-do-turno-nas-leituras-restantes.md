---
impacto: nada_mudou
secao: corrigido
titulo: Preencher uma resposta pronta numa conversa de atendimento usa só os dados do contato da conversa
---

Numa conversa de atendimento, `crm_render_message_template` passa a preencher a resposta
pronta apenas com os dados do contato daquela conversa: um `contact_id` ou um `lead_id` de
outro contato é recusado, e sem nenhum dos dois o contato da conversa é usado. Fora de uma
conversa de atendimento (integração, MCP externo), nada muda.
