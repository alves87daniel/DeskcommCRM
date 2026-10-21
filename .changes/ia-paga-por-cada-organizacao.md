---
impacto: exige_acao
secao: alterado
titulo: A IA usa só a chave cadastrada pela tela — a chave do arquivo de ambiente deixa de valer
---
Antes, uma instalação podia atender a inteligência artificial de todas as empresas com a chave colada no arquivo de ambiente, e a conta de quem instalou pagava por todas. Agora cada empresa usa a própria chave, cadastrada em IA › Credenciais; sem ela a IA daquela empresa fica desligada, a conversa que chega vai direto para a equipe e a Central mostra um aviso só. O instalador continua perguntando a chave, mas a grava como credencial da empresa do dono; rodar de novo não pergunta a chave que já está cadastrada. A transcrição de áudio por um serviço próprio apontado no arquivo de ambiente (TRANSCRIPTION_API_KEY e TRANSCRIPTION_BASE_URL) saiu; a transcrição usa a chave da OpenAI da empresa. Crédito: @alves87daniel.

## Requer atenção

Se a sua instalação atende só pela chave do arquivo de ambiente (ANTHROPIC_API_KEY, OPENAI_API_KEY ou OPENROUTER_API_KEY, e AI_GATEWAY_API_KEY), cadastre essa chave pela tela, em IA › Credenciais, na empresa do dono, ANTES de atualizar — e a da OpenAI também, se você ouve áudios. Depois disso a atualização esvazia do arquivo cada chave cuja credencial já existe e avisa, no fim, qual ainda falta. Sem a credencial cadastrada, a IA daquela empresa fica desligada até alguém cadastrar.
