import Link from "next/link";

import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * A FRASE DA REGRA, onde a pessoa procura quando a IA não responde.
 *
 * ADR-0005, D3: a organização sem chave de IA ativa e validada não tem IA — o
 * ponto não chama provedor nenhum, nunca cai em outra chave, e a conversa vai
 * para a equipe. Isso precisa estar ESCRITO nas duas telas em que alguém
 * procura a causa: Credenciais (onde se resolve) e a Central (onde o aviso
 * chega). Um recurso desligado sem a frase é indistinguível de um recurso
 * quebrado.
 *
 * Componente de servidor: quem decide se ele aparece é a página, com
 * `temCredencialDeIaUtilizavel`.
 */
export function AvisoDeIaSemChave({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <Card
      className="border-amber-500/40 bg-amber-500/5 p-4"
      data-testid="aviso-ia-sem-chave"
      role="status"
    >
      <p className="text-sm font-medium">{t("IA desligada por falta de chave")}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "Esta empresa não tem chave de IA ativa e validada. Sem ela nenhum ponto de IA chama provedor: as conversas vão direto para a equipe. A plataforma não custeia IA — a chave é da sua empresa.",
        )}{" "}
        <Link href="/app/ai/credentials" className="font-medium text-foreground underline underline-offset-4">
          {t("Cadastrar a chave em IA › Credenciais")}
        </Link>
      </p>
    </Card>
  );
}
