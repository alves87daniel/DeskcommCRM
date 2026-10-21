---
impacto: nada_mudou
secao: corrigido
titulo: O Next.js sobe para 16.3.8 e as dependências deixam de ter aviso de segurança crítico
---

O Next.js passa de 16.3.6 para 16.3.8, versão que fecha os avisos de segurança publicados para ele em 07/10/2026: uma falha de requisição forjada no servidor (SSRF) no otimizador de imagens, duas de envenenamento de cache em páginas estáticas e três de exposição de informação. Duas bibliotecas usadas por dentro também sobem para fechar os dois avisos críticos que a verificação de dependências apontava: `solid-js`, que traz `seroval` 1.6, e `proxy-addr` 2.0.8. Nenhuma das duas roda no atendimento em produção, mas saem da lista. A atualização não exige nenhuma ação de quem opera a instalação.
