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

export const Route = createFileRoute("/_authenticated/despesas")({
  head: () => ({
    meta: [
      { title: "Despesas — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Categorias de despesa da unidade por mês." },
      { property: "og:title", content: "Despesas — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Categorias de despesa da unidade por mês." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DespesasPage,
});

const DRE_LINES = [
  { value: "despesas_produtos", label: "Despesas de produtos" },
  { value: "despesas", label: "Despesas" },
] as const;

const DRE_LINE_LABELS = Object.fromEntries(DRE_LINES.map((l) => [l.value, l.label]));

interface Cat {
  id: string;
  name: string;
  dre_line: string;
}

function DespesasPage() {
  const { unitId, year } = usePlanning();
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [dreLine, setDreLine] = useState("despesas");

  const canEdit = !!user?.canWrite;
  const canAddCategory = !!user?.isFinanceiro;

  const { data: categories } = useQuery({
    queryKey: ["expense-categories", unitId],
    enabled: !!unitId,
    queryFn: async () =>
      ((
        await supabase
          .from("expense_categories")
          .select("id, name, dre_line")
          .eq("unit_id", unitId!)
          .order("name")
      ).data as Cat[]) ?? [],
  });

  const catIds = (categories ?? []).map((c) => c.id);

  const { data: entries, isLoading } = useQuery({
    queryKey: ["expenses", unitId, year, catIds.join(",")],
    enabled: !!unitId && !!categories,
    queryFn: async () => {
      if (catIds.length === 0) return [];
      const { data, error } = await supabase
        .from("expense_entries")
        .select("id, month, amount, category_id")
        .eq("year", year)
        .in("category_id", catIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  function entryFor(catId: string, month: number) {
    return (entries ?? []).find((e) => e.category_id === catId && e.month === month);
  }

  async function commit(catId: string, month: number, value: number) {
    const existing = entryFor(catId, month);
    if (existing) {
      const { error } = await supabase
        .from("expense_entries")
        .update({ amount: value })
        .eq("id", existing.id);
      if (error) {
        toast.error("Erro ao salvar: " + error.message);
        return;
      }
    } else if (value !== 0) {
      const { error } = await supabase.from("expense_entries").insert({
        category_id: catId,
        year,
        month,
        amount: value,
        created_by: user!.id,
      });
      if (error) {
        toast.error("Erro ao salvar: " + error.message);
        return;
      }
    }
    queryClient.invalidateQueries({ queryKey: ["expenses", unitId, year] });
    queryClient.invalidateQueries({ queryKey: ["dre-data", unitId, year] });
  }

  async function addCategory() {
    if (!name.trim()) {
      toast.error("Informe o nome da categoria.");
      return;
    }
    const { error } = await supabase.from("expense_categories").insert({
      unit_id: unitId!,
      name: name.trim(),
      dre_line: dreLine,
    });
    if (error) {
      toast.error("Erro ao criar categoria: " + error.message);
      return;
    }
    setName("");
    queryClient.invalidateQueries({ queryKey: ["expense-categories", unitId] });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Despesas</h1>
        <p className="text-sm text-muted-foreground">Categorias da unidade × 12 meses · {year}</p>
      </div>

      {canAddCategory && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
          <Input
            placeholder="Nova categoria"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56"
          />
          <Select value={dreLine} onValueChange={setDreLine}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRE_LINES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={addCategory} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> Adicionar categoria
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
                <th className="sticky left-0 bg-muted/50 px-3 py-2 font-medium">Categoria</th>
                <th className="px-3 py-2 font-medium">Linha da DRE</th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {(categories ?? []).map((c) => {
                const total = (entries ?? [])
                  .filter((e) => e.category_id === c.id)
                  .reduce((a, e) => a + Number(e.amount), 0);
                return (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="sticky left-0 bg-card px-3 py-1 font-medium">{c.name}</td>
                    <td className="px-3 py-1 text-muted-foreground">
                      {DRE_LINE_LABELS[c.dre_line] ?? c.dre_line}
                    </td>
                    {MONTHS.map((_, i) => (
                      <td key={i} className="border-l border-border/50 p-0">
                        <MoneyCell
                          value={Number(entryFor(c.id, i + 1)?.amount ?? 0)}
                          disabled={!canEdit}
                          onCommit={(v) => commit(c.id, i + 1, v)}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">
                      {fmtBRL(total)}
                    </td>
                  </tr>
                );
              })}
              {(categories ?? []).length === 0 && (
                <tr>
                  <td colSpan={15} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhuma categoria cadastrada. O financeiro pode adicionar acima.
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
