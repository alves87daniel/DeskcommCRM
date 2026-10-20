---
impacto: exige_acao
secao: alterado
titulo: O compose e o kit de instalação passam a puxar as imagens deste repositório
---

O `docker-compose.prod.yml`, o `.env.hostgator.example` e o kit de instalação (`install.sh`, `comecar.sh`, `_common.sh`) deixam de apontar para as imagens e para o repositório do projeto de origem e passam a apontar para `ghcr.io/alves87daniel/*` e `alves87daniel/DeskcommCRM`. As quatro imagens (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`, `deskcomm-voice-agent`) já são publicadas aqui a cada merge na `main`, nas tags `main` e `latest`, e o `update.sh` passa a gravar no `.env` da instalação as referências deste repositório. Crédito: @alves87daniel.

## Requer atenção

O canal `stable` e os números de versão ainda não existem no registro deste repositório: só `main` e `latest`. Antes de instalar ou atualizar uma VPS pelo kit, publique a primeira versão (tag `vX.Y.Z` contida na `main`), que é o que faz o CI apontar `stable` para ela. Até lá, `install.sh` e `update.sh` cairiam em `stable` e o `docker compose pull` falharia com imagem não encontrada. Uma instalação que já tenha `APP_IMAGE`, `WORKER_IMAGE`, `SCHEDULER_IMAGE` ou `VOICE_AGENT_IMAGE` no `.env` apontando para o registro de origem é regravada pelo `update.sh` para as imagens deste repositório.
