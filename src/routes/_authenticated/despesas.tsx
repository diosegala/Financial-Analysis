import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";
import { ExpenseBasePanel } from "@/components/expense-base-panel";
import { ConsolidatedView, ScopeSelect } from "@/components/consolidated-view";

export const Route = createFileRoute("/_authenticated/despesas")({
  head: pageHead("Despesas", "Despesas da unidade por conta e mês."),
  component: DespesasPage,
});

function DespesasPage() {
  const { unit, version } = usePlanning();
  const { data: user } = useCurrentUser();
  const [scope, setScope] = useState<"unit" | "all">("unit");
  const all = scope === "all" && !!user?.isManagement;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Despesas"
        subtitle={`${all ? "CUPOLA (todas as unidades)" : (unit?.name ?? "…")} · ${version?.name ?? "…"}`}
        actions={user?.isManagement && <ScopeSelect value={scope} onChange={setScope} />}
      />
      <ExpenseBasePanel showUnit={!all} />
      {all ? (
        <ConsolidatedView kind="despesa" />
      ) : (
        <PlanGrid kind="despesa" emptyText="Nenhuma despesa lançada. Adicione a primeira linha." />
      )}
    </div>
  );
}
