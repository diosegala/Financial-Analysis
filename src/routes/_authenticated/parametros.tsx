import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { YEAR, MONTHS_FULL } from "@/lib/format";
import { parseNum } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/parametros")({
  head: () => ({
    meta: [
      { title: "Parâmetros — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Parâmetros de imposto, comissões e encargos com vigência." },
      { property: "og:title", content: "Parâmetros — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Parâmetros de imposto, comissões e encargos com vigência." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ParametrosPage,
});

const KEYS = [
  { value: "imposto", label: "Imposto" },
  { value: "comissao_comercial", label: "Comissão comercial" },
  { value: "comissao_parceiro", label: "Comissão de parceiro" },
  { value: "encargos", label: "Encargos" },
] as const;

const KEY_LABELS = Object.fromEntries(KEYS.map((k) => [k.value, k.label]));

function ParametrosPage() {
  const { data: user, isLoading: loadingUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("imposto");
  const [value, setValue] = useState("");
  const [month, setMonth] = useState("1");

  const { data: params, isLoading } = useQuery({
    queryKey: ["parameters"],
    queryFn: async () =>
      (await supabase.from("parameters").select("id, key, value, valid_from, created_at").order("valid_from", { ascending: false })).data ?? [],
  });

  if (!loadingUser && user && !user.isFinanceiro) {
    return <Navigate to="/inicio" />;
  }

  async function addParam() {
    const n = parseNum(value);
    if (n <= 0) { toast.error("Informe um valor percentual maior que zero."); return; }
    const validFrom = `${YEAR}-${month.padStart(2, "0")}-01`;
    const { error } = await supabase.from("parameters").insert({
      key,
      value: n / 100,
      valid_from: validFrom,
      created_by: user!.id,
    });
    if (error) { toast.error("Erro ao salvar: " + error.message); return; }
    setValue("");
    toast.success("Parâmetro salvo.");
    queryClient.invalidateQueries({ queryKey: ["parameters"] });
    queryClient.invalidateQueries({ queryKey: ["dre-data"] });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Parâmetros</h1>
        <p className="text-sm text-muted-foreground">
          Cada mudança vale a partir do mês escolhido; os meses anteriores mantêm o valor anterior.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
        <Select value={key} onValueChange={setKey}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEYS.map((k) => (
              <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Valor % (ex.: 15)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-40 font-mono"
        />
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS_FULL.map((m, i) => (
              <SelectItem key={i + 1} value={String(i + 1)}>A partir de {m}/{YEAR}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={addParam} size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> Adicionar vigência
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Parâmetro</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2 font-medium">Vigente a partir de</th>
                <th className="px-3 py-2 font-medium">Registrado em</th>
              </tr>
            </thead>
            <tbody>
              {(params ?? []).map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 font-medium">{KEY_LABELS[p.key] ?? p.key}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {(Number(p.value) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%
                  </td>
                  <td className="px-3 py-1.5">{new Date(p.valid_from + "T00:00:00").toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{new Date(p.created_at).toLocaleDateString("pt-BR")}</td>
                </tr>
              ))}
              {(params ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhum parâmetro cadastrado ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
