import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";
import { MetaPanel } from "@/components/meta-panel";
import { GuardrailScore } from "@/components/guardrail-score";
import { ProductsLink } from "@/components/products-link";
import { ConsolidatedView, ScopeSelect } from "@/components/consolidated-view";

export const Route = createFileRoute("/_authenticated/receitas")({
  head: pageHead("Receitas", "Receitas por cliente, produto e mês."),
  component: ReceitasPage,
});

function ReceitasPage() {
  const { unit, version } = usePlanning();
  const { data: user } = useCurrentUser();
  const [scope, setScope] = useState<"unit" | "all">("unit");
  const all = scope === "all" && !!user?.isManagement;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Receitas"
        subtitle={`${all ? "CUPOLA (todas as unidades)" : (unit?.name ?? "…")} · ${version?.name ?? "…"}`}
        actions={
          <div className="flex gap-2">
            {user?.isManagement && <ScopeSelect value={scope} onChange={setScope} />}
            <ProductsLink />
          </div>
        }
      />
      {all ? (
        <ConsolidatedView kind="receita" />
      ) : (
        <>
          <GuardrailScore />
          <MetaPanel />
          <PlanGrid
            kind="receita"
            emptyText="Nenhuma receita lançada. Adicione a primeira linha."
          />
          <p className="text-xs text-muted-foreground">
            Treinamentos, imersões e comunidade entram aqui pelo produto. Eventos com vários itens
            (ingressos, patrocínio, local) ficam em Eventos e entram na DRE e na meta
            automaticamente.
          </p>
        </>
      )}
    </div>
  );
}
