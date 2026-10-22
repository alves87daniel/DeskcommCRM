import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { AvisoDeIaSemChave } from "@/components/ai/AvisoDeIaSemChave";
import { temCredencialDeIaUtilizavel } from "@/lib/ai/credenciais/utilizavel";
import { AgentInboxList } from "./_components/AgentInboxList";

export const dynamic = "force-dynamic";

export default async function AgentInboxPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const canResolve = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;
  // A Central é onde o aviso "IA desligada por falta de chave" chega; a frase
  // da regra fica fixa aqui enquanto a organização não tiver credencial
  // utilizável (ADR-0005, D3), e some sozinha quando ela cadastrar.
  const temChaveUtilizavel = await temCredencialDeIaUtilizavel(await createClient(), activeOrg.orgId);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Central de avisos", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O que o assistente precisou escalar para o time: conexões caídas, tarefas que falharam, atendimentos passados a humanos.",
            idioma,
          )}
        </p>
      </header>
      {temChaveUtilizavel ? null : <AvisoDeIaSemChave idioma={idioma} />}
      <AgentInboxList canResolve={canResolve} />
    </div>
  );
}
