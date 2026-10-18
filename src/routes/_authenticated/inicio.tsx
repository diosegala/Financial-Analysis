import { createFileRoute } from "@tanstack/react-router";
import { usePlanning } from "@/lib/planning";
import { useDreData, computeYear, scenarioOf, totals } from "@/lib/dre-data";
import { fmtBRL, fmtPct, MONTHS_FULL } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/inicio")({
  head: () => ({
    meta: [
      { title: "Início — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Resumo do planejamento financeiro da unidade." },
      { property: "og:title", content: "Início — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Resumo do planejamento financeiro da unidade." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: InicioPage,
});

function InicioPage() {
  const { unitId, scenarioId, year } = usePlanning();
  const { data, isLoading } = useDreData(unitId, year);

  const scenario = data?.scenarios.find((s) => s.id === scenarioId) ?? data?.scenarios[0];
  const months = data ? computeYear(data, year, scenarioOf(scenario!)) : [];
  const total = months.length ? totals(months) : null;
  const monthName = MONTHS_FULL[new Date().getMonth()];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Visão geral</h1>
        <p className="text-sm text-muted-foreground">
          Cenário {scenario?.name ?? "…"} · Ano {year}
        </p>
      </div>

      {isLoading || !total ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Receita bruta no ano</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-2xl font-semibold tabular-nums">{fmtBRL(total.receitaBruta)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Custos indiretos no ano</CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-2xl font-semibold tabular-nums">{fmtBRL(total.custosIndiretos)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Contribuição líquida no ano</CardTitle>
              </CardHeader>
              <CardContent className={`font-mono text-2xl font-semibold tabular-nums ${total.contribuicaoLiquida < 0 ? "text-destructive" : ""}`}>
                {fmtBRL(total.contribuicaoLiquida)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">%MCL no ano</CardTitle>
              </CardHeader>
              <CardContent className={`font-mono text-2xl font-semibold tabular-nums ${total.mcl < 0 ? "text-destructive" : ""}`}>
                {fmtPct(total.mcl)}
              </CardContent>
            </Card>
          </div>
          <p className="text-sm text-muted-foreground">
            Use o menu lateral para lançar receitas, folha e despesas de {monthName} em diante e acompanhar a DRE prevista da unidade.
          </p>
        </>
      )}
    </div>
  );
}
