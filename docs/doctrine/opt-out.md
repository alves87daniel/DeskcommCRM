# Opt-out (STOP) — uma regra só, nos dois lados

> Saiu do `CLAUDE.md` (seção WAHA) no enxugamento da issue #21. A regra fica lá, em uma linha com
> ponteiro para cá; este arquivo guarda o detalhe, a medição e o porquê.

- STOP detection: a regra mora em `lib/opt-out/deteccao.ts` e é a MESMA nos dois lados —
  a ingestão (que grava `is_blocked=true`) e o runtime do agente. **Não é mais a palavra
  solta:** só bloqueia palavra ISOLADA (mensagem inteira = a palavra) ou verbo de cessação
  com OBJETO DE COMUNICAÇÃO ("parar de me mandar", "sair da lista"). Enquanto eram duas
  regras, a ingestão bloqueava paciente que perguntou "tem como parar a dor?" — medido em
  clínica, 12 falsos positivos num corpus de 32 frases de nicho.
  Cobre português e espanhol, nos dois níveis (inequívoco e ambíguo) — foi preciso um PR
  além do #275 (que só tinha coberto o vocabulário inequívoco) para o espanhol ganhar a
  camada ambígua e as construções com pronome preso ("escribirme"). Para ver o vocabulário
  em vigor sem confiar neste texto:
  `sed -n '/PALAVRAS_DE_OPT_OUT/,/^]/p' lib/opt-out/deteccao.ts | grep -E '^ *"'`, e as frases de controle em
  `tests/unit/opt-out-deteccao.test.ts`.
  O Jev (`lib/ai/decisao/pedidos.ts`) só é perguntado onde esta regra disse não, e nunca bloqueia
  ninguém — no máximo abre um aviso na Central ("Avisar a equipe"): a regra continua a única que bloqueia
  (cerca: `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`).
