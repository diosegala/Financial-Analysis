import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";

export const Route = createFileRoute("/_authenticated/receitas")({
  head: pageHead("Receitas", "Receitas por cliente, produto e mês."),
  component: ReceitasPage,
});

function ReceitasPage() {
  const { unit, version } = usePlanning();
  return (
    <div className="space-y-4">
      <PageHeader title="Receitas" subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"}`} />
      <PlanGrid kind="receita" emptyText="Nenhuma receita lançada. Adicione a primeira linha." />
      <p className="text-xs text-muted-foreground">
        Receitas de eventos e treinamentos são lançadas em Eventos (vagas × preço) e entram na DRE
        automaticamente.
      </p>
    </div>
  );
}
