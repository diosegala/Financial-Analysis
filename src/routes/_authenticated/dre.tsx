import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Download, SlidersHorizontal } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useDreLines, useUnits } from "@/lib/catalog";
import { dreCsv, dreValue, downloadText, fmtLine, lineLabel, useDreReport } from "@/lib/dre";
import { boardLines, useBoard, useRevenueByNature } from "@/lib/board";
import { MONTHS, fmtBRL } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { OptionSelect } from "@/components/form-fields";
import { BoardTable, SupportSharesDialog } from "@/components/board-panel";
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
  const [view, setView] = useState<"dre" | "units">("dre");
  const [allocated, setAllocated] = useState(false);
  const [sharesOpen, setSharesOpen] = useState(false);
  const allUnits = scope === "all" && !!user?.isManagement;
  const unitIds = allUnits
    ? (units ?? []).filter((u) => u.active).map((u) => u.id)
    : unitId
      ? [unitId]
      : [];
  const { data: values, isLoading } = useDreReport(versionId, scenarioId, unitIds);
  const { data: nature } = useRevenueByNature(versionId, scenarioId, unitIds);
  // Rateio do apoio: só a gestão vê o resultado das áreas de apoio.
  const { data: board } = useBoard(user?.isManagement ? versionId : null, scenarioId, units, lines);
  const active = (lines ?? []).filter((l) => l.active);
  const { revenue: revenueLine, result: resultLine } = boardLines(lines);
  const title = allUnits ? "Todas as unidades" : (unit?.name ?? "…");
  const unitBoard = !allUnits ? board?.units.find((u) => u.unit.id === unitId) : undefined;
  const showUnits = allUnits && view === "units";
  // Linhas extras: receita recorrente × variável e, com rateio, o apoio da unidade.
  const natureRow = (key: string) => {
    const m = nature?.get(key) ?? Array(12).fill(0);
    return [...m, m.reduce((a: number, v: number) => a + v, 0)] as number[];
  };
  const extraAfter = (lineId: string) => {
    const rows: { label: string; values: number[]; strong?: boolean }[] = [];
    if (lineId === revenueLine?.id && nature) {
      rows.push({ label: "Recorrente", values: natureRow("recorrente") });
      rows.push({ label: "Variável", values: natureRow("variavel") });
    }
    if (lineId === resultLine?.id && allocated && unitBoard && values) {
      const support = [...unitBoard.support, unitBoard.support.reduce((a, v) => a + v, 0)];
      rows.push({ label: "(-) Apoio rateado", values: support });
      rows.push({
        label: "(=) Resultado após apoio",
        values: support.map((v, i) => v + dreValue(values, lineId, i === 12 ? 0 : i + 1)),
        strong: true,
      });
    }
    return rows;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="DRE prevista"
        subtitle={`${title} · ${version?.name ?? "…"} · Cenário ${scenario?.name ?? "…"}`}
        actions={
          <div className="flex items-center gap-2">
            {allUnits && (
              <OptionSelect
                className="w-40"
                value={view}
                onChange={(v) => setView((v as "dre" | "units") ?? "dre")}
                options={[
                  { value: "dre", label: "DRE consolidada" },
                  { value: "units", label: "Por unidade" },
                ]}
              />
            )}
            {user?.isManagement && (showUnits || (!allUnits && unit?.kind === "negocio")) ? (
              <OptionSelect
                className="w-44"
                value={allocated ? "com" : "sem"}
                onChange={(v) => setAllocated(v === "com")}
                options={[
                  { value: "sem", label: "Sem rateio do apoio" },
                  { value: "com", label: "Com rateio do apoio" },
                ]}
              />
            ) : null}
            {user?.isFinanceiro && allocated && board && (showUnits || unitBoard) && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setSharesOpen(true)}
              >
                <SlidersHorizontal className="h-4 w-4" /> Critério do rateio
              </Button>
            )}
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

      {board && scenarioId && (
        <SupportSharesDialog
          open={sharesOpen}
          onOpenChange={setSharesOpen}
          scenarioId={scenarioId}
          board={board}
        />
      )}
      {showUnits ? (
        board ? (
          <BoardTable board={board} allocated={allocated} />
        ) : (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        )
      ) : isLoading || !values ? (
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
                  <Fragment key={line.id}>
                    <tr
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
                    {extraAfter(line.id).map((x) => (
                      <tr
                        key={x.label}
                        className={`border-b border-border ${x.strong ? "bg-muted/30 font-semibold" : "text-muted-foreground"}`}
                      >
                        <td
                          className={`sticky left-0 z-10 px-3 py-1 ${x.strong ? "bg-muted" : "bg-card pl-8 text-xs"}`}
                        >
                          {x.label}
                        </td>
                        {x.values.map((v, i) => (
                          <td
                            key={i}
                            className={`px-2 py-1 text-right font-mono tabular-nums ${x.strong ? "" : "text-xs"} ${x.strong && v < 0 ? "text-destructive" : ""}`}
                          >
                            {fmtBRL(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
