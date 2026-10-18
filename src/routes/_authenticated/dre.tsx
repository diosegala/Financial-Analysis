import { createFileRoute } from "@tanstack/react-router";
import { usePlanning } from "@/lib/planning";
import { useDreData, computeYear, scenarioOf, totals } from "@/lib/dre-data";
import { MONTHS, fmtBRL, fmtPct } from "@/lib/format";
import type { DreMonth } from "@/lib/dre";

export const Route = createFileRoute("/_authenticated/dre")({
  head: () => ({
    meta: [
      { title: "DRE prevista — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "DRE prevista da unidade por mês e total do ano." },
      { property: "og:title", content: "DRE prevista — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "DRE prevista da unidade por mês e total do ano." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DrePage,
});

const LINES: { key: keyof Omit<DreMonth, "mcl">; label: string; bold?: boolean; negative?: boolean }[] = [
  { key: "receitaBruta", label: "Receita bruta", bold: true },
  { key: "despesasProdutos", label: "(-) Despesas de produtos" },
  { key: "custosIndiretos", label: "(-) Custos indiretos (folha + encargos)" },
  { key: "despesas", label: "(-) Despesas" },
  { key: "comissionamento", label: "(-) Comissionamento" },
  { key: "impostos", label: "(-) Impostos" },
  { key: "contribuicaoLiquida", label: "(=) Contribuição líquida", bold: true, negative: true },
];

function DrePage() {
  const { unitId, scenarioId, year } = usePlanning();
  const { data, isLoading } = useDreData(unitId, year);

  const scenario = data?.scenarios.find((s) => s.id === scenarioId) ?? data?.scenarios[0];
  const months = data ? computeYear(data, year, scenarioOf(scenario!)) : [];
  const total = months.length ? totals(months) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">DRE prevista da unidade</h1>
        <p className="text-sm text-muted-foreground">
          Cenário {scenario?.name ?? "…"} · Ano {year}
        </p>
      </div>

      {isLoading || !total ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 bg-muted/50 px-3 py-2 font-medium">Linha</th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">{m}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {LINES.map((line) => (
                <tr key={line.key} className={`border-b border-border ${line.bold ? "bg-muted/30 font-semibold" : ""}`}>
                  <td className="sticky left-0 bg-inherit px-3 py-1.5">{line.label}</td>
                  {months.map((m, i) => (
                    <td
                      key={i}
                      className={`px-2 py-1.5 text-right font-mono tabular-nums ${
                        line.negative && m[line.key] < 0 ? "text-destructive" : ""
                      }`}
                    >
                      {fmtBRL(m[line.key])}
                    </td>
                  ))}
                  <td
                    className={`px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${
                      line.negative && total[line.key] < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {fmtBRL(total[line.key])}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="sticky left-0 bg-card px-3 py-1.5">%MCL</td>
                {months.map((m, i) => (
                  <td key={i} className={`px-2 py-1.5 text-right font-mono tabular-nums ${m.mcl < 0 ? "text-destructive" : ""}`}>
                    {fmtPct(m.mcl)}
                  </td>
                ))}
                <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${total.mcl < 0 ? "text-destructive" : ""}`}>
                  {fmtPct(total.mcl)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
