import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Download } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useDreLines, useUnits } from "@/lib/catalog";
import { dreCsv, dreValue, downloadText, fmtLine, lineLabel, useDreReport } from "@/lib/dre";
import { MONTHS } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/dre")({
  head: pageHead(
    "DRE prevista",
    "DRE prevista por unidade ou consolidada, por mês e total do ano.",
  ),
  component: DrePage,
});

function DrePage() {
  const { unit, unitId, version, versionId, scenario, scenarioId } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: lines } = useDreLines();
  const { data: units } = useUnits();
  const [scope, setScope] = useState<"unit" | "all">("unit");
  const allUnits = scope === "all" && !!user?.isManagement;
  const unitIds = allUnits
    ? (units ?? []).filter((u) => u.active).map((u) => u.id)
    : unitId
      ? [unitId]
      : [];
  const { data: values, isLoading } = useDreReport(versionId, scenarioId, unitIds);
  const active = (lines ?? []).filter((l) => l.active);
  const title = allUnits ? "Todas as unidades" : (unit?.name ?? "…");

  return (
    <div className="space-y-4">
      <PageHeader
        title="DRE prevista"
        subtitle={`${title} · ${version?.name ?? "…"} · Cenário ${scenario?.name ?? "…"}`}
        actions={
          <div className="flex items-center gap-2">
            {user?.isManagement && (
              <OptionSelect
                className="w-48"
                value={scope}
                onChange={(v) => setScope((v as "unit" | "all") ?? "unit")}
                options={[
                  { value: "unit", label: "Unidade selecionada" },
                  { value: "all", label: "Todas as unidades" },
                ]}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!values}
              onClick={() =>
                values &&
                downloadText(
                  `DRE ${title} - ${version?.name} - ${scenario?.name}.csv`,
                  dreCsv(active, values),
                )
              }
            >
              <Download className="h-4 w-4" /> Exportar para Excel
            </Button>
          </div>
        }
      />

      {isLoading || !values ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 font-medium">
                  Linha
                </th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {active.map((line) => {
                const strong =
                  line.kind === "subtotal" || line.kind === "percentual" || line.sign > 0;
                const signed = line.kind === "subtotal" || line.kind === "percentual";
                return (
                  <tr
                    key={line.id}
                    className={`border-b border-border ${strong ? "bg-muted/30 font-semibold" : ""}`}
                  >
                    <td
                      className={`sticky left-0 z-10 px-3 py-1.5 ${strong ? "bg-muted" : "bg-card"}`}
                    >
                      {lineLabel(line)}
                    </td>
                    {[...MONTHS.keys(), 12].map((i) => {
                      const month = i === 12 ? 0 : i + 1;
                      const v = dreValue(values, line.id, month);
                      return (
                        <td
                          key={i}
                          className={`px-2 py-1.5 text-right font-mono tabular-nums ${
                            signed && v < 0 ? "text-destructive" : ""
                          } ${month === 0 ? "font-semibold" : ""}`}
                        >
                          {fmtLine(line, v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
