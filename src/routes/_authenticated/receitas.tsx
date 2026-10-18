import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { usePlanning } from "@/lib/planning";
import { MONTHS, fmtBRL } from "@/lib/format";
import { MoneyCell } from "@/components/money-cell";
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

export const Route = createFileRoute("/_authenticated/receitas")({
  head: () => ({
    meta: [
      { title: "Receitas — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Grade de receitas por cliente, produto e mês." },
      { property: "og:title", content: "Receitas — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Grade de receitas por cliente, produto e mês." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReceitasPage,
});

const TYPES = [
  { value: "recorrente_6", label: "Recorrente 6 meses" },
  { value: "recorrente_12", label: "Recorrente 12 meses" },
  { value: "variavel", label: "Variável (até 3 meses)" },
  { value: "parceiros", label: "Parceiros" },
  { value: "educacao", label: "Educação (evento/treinamento)" },
] as const;

interface Entry {
  id: string;
  month: number;
  amount: number;
}

interface Row {
  key: string;
  client: string;
  product: string;
  type: string;
  entries: Map<number, Entry>;
}

const TYPE_LABELS = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));

function ReceitasPage() {
  const { unitId, year } = usePlanning();
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [client, setClient] = useState("");
  const [product, setProduct] = useState("");
  const [type, setType] = useState<string>("variavel");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["revenue", unitId, year],
    enabled: !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("revenue_entries")
        .select("id, month, amount, client_name, product_name, revenue_type")
        .eq("unit_id", unitId!)
        .eq("year", year);
      if (error) throw error;
      const map = new Map<string, Row>();
      for (const e of data ?? []) {
        const key = `${e.client_name}|||${e.product_name}|||${e.revenue_type}`;
        if (!map.has(key)) {
          map.set(key, { key, client: e.client_name, product: e.product_name, type: e.revenue_type, entries: new Map() });
        }
        map.get(key)!.entries.set(e.month, { id: e.id, amount: Number(e.amount) });
      }
      return [...map.values()].sort((a, b) => a.client.localeCompare(b.client));
    },
  });

  const canEdit = !!user?.canWrite;

  async function commit(row: Row, month: number, value: number) {
    const existing = row.entries.get(month);
    if (existing) {
      const { error } = await supabase.from("revenue_entries").update({ amount: value }).eq("id", existing.id);
      if (error) { toast.error("Erro ao salvar: " + error.message); return; }
    } else if (value !== 0) {
      const { error } = await supabase.from("revenue_entries").insert({
        unit_id: unitId!,
        year,
        month,
        client_name: row.client,
        product_name: row.product,
        revenue_type: row.type,
        amount: value,
        created_by: user!.id,
      });
      if (error) { toast.error("Erro ao salvar: " + error.message); return; }
    }
    queryClient.invalidateQueries({ queryKey: ["revenue", unitId, year] });
    queryClient.invalidateQueries({ queryKey: ["dre-data", unitId, year] });
  }

  async function addRow() {
    if (!client.trim() || !product.trim()) { toast.error("Preencha cliente e produto."); return; }
    const { error } = await supabase.from("revenue_entries").insert({
      unit_id: unitId!,
      year,
      month: 1,
      client_name: client.trim(),
      product_name: product.trim(),
      revenue_type: type,
      amount: 0,
      created_by: user!.id,
    });
    if (error) { toast.error("Erro ao criar linha: " + error.message); return; }
    setClient("");
    setProduct("");
    queryClient.invalidateQueries({ queryKey: ["revenue", unitId, year] });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Receitas</h1>
        <p className="text-sm text-muted-foreground">Cliente / produto × 12 meses · {year}</p>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
          <Input placeholder="Cliente" value={client} onChange={(e) => setClient(e.target.value)} className="w-48" />
          <Input placeholder="Produto / evento" value={product} onChange={(e) => setProduct(e.target.value)} className="w-48" />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={addRow} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> Adicionar linha
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 bg-muted/50 px-3 py-2 font-medium">Cliente</th>
                <th className="px-3 py-2 font-medium">Produto</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">{m}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((row) => {
                const total = [...row.entries.values()].reduce((a, e) => a + e.amount, 0);
                return (
                  <tr key={row.key} className="border-b border-border last:border-0">
                    <td className="sticky left-0 bg-card px-3 py-1 font-medium">{row.client}</td>
                    <td className="px-3 py-1">{row.product}</td>
                    <td className="px-3 py-1 text-muted-foreground">{TYPE_LABELS[row.type] ?? row.type}</td>
                    {MONTHS.map((_, i) => (
                      <td key={i} className="border-l border-border/50 p-0">
                        <MoneyCell
                          value={row.entries.get(i + 1)?.amount ?? 0}
                          disabled={!canEdit}
                          onCommit={(v) => commit(row, i + 1, v)}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">{fmtBRL(total)}</td>
                  </tr>
                );
              })}
              {(rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={16} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhuma receita lançada. Adicione a primeira linha acima.
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
