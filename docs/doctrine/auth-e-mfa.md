# MFA — quem exige, quem prova e onde se liga

> Saiu do `CLAUDE.md` (seção Auth & RBAC) no enxugamento da issue #21. A regra fica lá, em uma linha com
> ponteiro para cá; este arquivo guarda o detalhe, a medição e o porquê.

- MFA TOTP é **opcional e ligado por quem administra** — não é mais forçado por papel. Quem exige são duas políticas independentes que SOMAM: `platform_admins.mfa_required` (para o super-admin) e `organizations.settings.security.mfa_required` (para o `admin` do tenant). O padrão de ambas é **não exigir**, e o `bootstrap-owner.ts` grava `false` explícito. Regra pura em `lib/auth/politica-mfa.ts`
  - **Por que mudou:** o gate era `isPlatformAdmin || role === "admin"`, sem opção, e o `install.sh` cria o dono como platform admin — então TODA instalação self-host recebia um bloqueador de tela cheia logo depois do onboarding, um passo que o wizard nunca anunciou. Decisão do dono do produto; segurança que expulsa o usuário na primeira tela não protege ninguém
  - **⚠️ CADASTRAR e PROVAR são perguntas diferentes.** A política decide o cadastro. Já `mfaEmDivida()` — o 403 `mfa_required` das rotas — NÃO consulta a política: quem TEM fator prova na sessão, sempre. Ligá-lo à política faria quem ativa a verificação por vontade própria ter o fator ignorado
  - Ligar/desligar vive em **Configurações › Segurança**; desligar o próprio fator exige sessão `aal2` (senão uma sessão roubada desliga a proteção com um clique)
