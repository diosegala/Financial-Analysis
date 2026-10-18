import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { usePlanning } from "@/lib/planning";
import { useDreData, computeYear, scenarioOf, totals } from "@/lib/dre-data";
import { fmtBRL, fmtPct, parseNum } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/cenarios")({
  head: () => ({
    meta: [
      { title: "Cenários — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Variações de cenário e comparação lado a lado." },
      { property: "og:title", content: "Cenários — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Variações de cenário e comparação lado a lado." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CenariosPage,
});

function CenariosPage() {
  const { unitId, year } = usePlanning();
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data, isLoading } = useDreData(unitId, year);

  const canEdit = !!user?.isFinanceiro;

  async function saveVariation(id: string, field: "revenue_variation" | "expense_variation", text: string) {
    const value = parseNum(text) / 100;
    const patch = field === "revenue_variation" ? { revenue_variation: value } : { expense_variation: value };
    const { error } = await supabase.from("scenarios").update(patch).eq("id", id);
    if (error) { toast.error("Erro ao salvar: " + error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["dre-data"] });
    queryClient.invalidateQueries({ queryKey: ["scenarios"] });
  }

  async function setOfficial(id: string) {
    const { error } = await supabase.from("scenarios").update({ is_official: true }).eq("id", id);
    if (error) { toast.error("Erro: " + error.message); return; }
    await supabase.from("scenarios").update({ is_official: false }).neq("id", id);
    queryClient.invalidateQueries({ queryKey: ["dre-data"] });
    queryClient.invalidateQueries({ queryKey: ["scenarios"] });
  }

  const scenarios = data?.scenarios ?? [];
  const computed = scenarios.map((s) => ({
    ...s,
    total: data ? totals(computeYear(data, year, scenarioOf(s))) : null,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cenários</h1>
        <p className="text-sm text-muted-foreground">
          O Realista é lançado; Otimista e Conservador são variações percentuais aplicadas pelo financeiro.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {computed.map((s) => (
              <div key={s.id} className="space-y-3 rounded-md border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{s.name}</span>
                  {s.is_official ? (
                    <Badge>Oficial</Badge>
                  ) : canEdit ? (
                    <Button variant="outline" size="sm" onClick={() => setOfficial(s.id)}>
                      Marcar oficial
                    </Button>
                  ) : null}
                </div>
                <label className="block text-sm">
                  <span className="text-muted-foreground">Variação de receita (%)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={!canEdit || s.name === "Realista"}
                    defaultValue={String(Number(s.revenue_variation) * 100).replace(".", ",")}
                    onBlur={(e) => saveVariation(s.id, "revenue_variation", e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums disabled:opacity-60"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted-foreground">Variação de despesa (%)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={!canEdit || s.name === "Realista"}
                    defaultValue={String(Number(s.expense_variation) * 100).replace(".", ",")}
                    onBlur={(e) => saveVariation(s.id, "expense_variation", e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums disabled:opacity-60"
                  />
                </label>
              </div>
            ))}
          </div>

          <div>
            <h2 className="mb-2 text-lg font-semibold">Comparação no ano (unidade selecionada)</h2>
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left">
                    <th className="px-3 py-2 font-medium">Linha</th>
                    {computed.map((s) => (
                      <th key={s.id} className="px-3 py-2 text-right font-medium">{s.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["receitaBruta", "Receita bruta"],
                      ["custosIndiretos", "Custos indiretos"],
                      ["despesas", "Despesas"],
                      ["contribuicaoLiquida", "Contribuição líquida"],
                    ] as const
                  ).map(([key, label]) => (
                    <tr key={key} className="border-b border-border">
                      <td className="px-3 py-1.5">{label}</td>
                      {computed.map((s) => (
                        <td
                          key={s.id}
                          className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                            key === "contribuicaoLiquida" && (s.total?.[key] ?? 0) < 0 ? "text-destructive" : ""
                          }`}
                        >
                          {s.total ? fmtBRL(s.total[key]) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="px-3 py-1.5">%MCL</td>
                    {computed.map((s) => (
                      <td key={s.id} className={`px-3 py-1.5 text-right font-mono tabular-nums ${(s.total?.mcl ?? 0) < 0 ? "text-destructive" : ""}`}>
                        {s.total ? fmtPct(s.total.mcl) : "—"}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
