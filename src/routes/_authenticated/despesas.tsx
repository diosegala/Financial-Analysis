import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";

export const Route = createFileRoute("/_authenticated/despesas")({
  head: pageHead("Despesas", "Despesas da unidade por conta e mês."),
  component: DespesasPage,
});

function DespesasPage() {
  const { unit, version } = usePlanning();
  return (
    <div className="space-y-4">
      <PageHeader title="Despesas" subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"}`} />
      <PlanGrid kind="despesa" emptyText="Nenhuma despesa lançada. Adicione a primeira linha." />
    </div>
  );
}
