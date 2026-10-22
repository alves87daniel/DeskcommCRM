"use client";
import * as React from "react";
import Link from "next/link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  type CredentialRow,
  type Provider,
  credentialStatus,
} from "@/hooks/ai/useCredentials";

interface Props {
  provider: Provider;
  credentials: CredentialRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string;
}

export const STATUS_LABEL: Record<ReturnType<typeof credentialStatus>, string> = {
  validated: "validada",
  validating: "validando",
  unvalidated: "não validada",
  invalid: "inválida",
  inactive: "inativa",
};

export function CredentialPicker({
  provider,
  credentials,
  value,
  onChange,
  disabled,
  id,
}: Props) {
  const t = useT();
  const filtered = credentials.filter((c) => c.provider === provider);
  // Sem credencial da organização não há o que escolher — e é aí que o atalho
  // para cadastrar precisa aparecer. (A opção "a chave desta instalação" saiu
  // com a ADR-0005: toda versão aponta para uma credencial da organização.)
  const semOpcao = filtered.length === 0;

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Chave de acesso")}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("Escolha uma chave")} />
        </SelectTrigger>
        <SelectContent>
          {filtered.map((c) => {
            const st = credentialStatus(c);
            return (
              <SelectItem key={c.id} value={c.id}>
                {c.label} · …{c.api_key_last4 ?? "????"} · {t(STATUS_LABEL[st])}
              </SelectItem>
            );
          })}
          {semOpcao ? (
            <SelectItem value="__none__" disabled>
              {t("Nenhuma credencial")} {provider} {t("cadastrada")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {semOpcao ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Cadastrar credencial")} {provider}
          </Link>{" "}
          {t("na aba Credenciais.")}
        </p>
      ) : null}
    </div>
  );
}

export function findCredential(credentials: CredentialRow[], id: string): CredentialRow | null {
  return credentials.find((c) => c.id === id) ?? null;
}
