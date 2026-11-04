import { Fragment } from "react";
import { Download } from "lucide-react";
import { useDreLines } from "@/lib/catalog";
import { dreCsv, dreValue, downloadText, fmtLine, lineLabel, useDreReport } from "@/lib/dre";
import { MONTHS } from "@/lib/format";
import { usePlanning } from "@/lib/planning";
import { Button } from "@/components/ui/button";

/** A DRE no formato final, por mês e total do ano, de uma unidade ou da empresa. */
export function DreTable({
  unitIds,
  title,
  hideEmpty = false,
}: {
  unitIds: string[];
  title: string;
  /** Tira as linhas sem valor no ano (ex.: despesas de produtos numa unidade que não tem). Subtotais ficam. */
  hideEmpty?: boolean;
}) {
  const { versionId, scenarioId } = usePlanning();
  const { data: lines } = useDreLines();
  const { data: values, isLoading } = useDreReport(versionId, scenarioId, unitIds);
  const active = (lines ?? []).filter((l) => l.active);
  if (isLoading || !values) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => downloadText(`DRE ${title}.csv`, dreCsv(active, values))}
        >
          <Download className="h-4 w-4" /> Exportar para Excel
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 font-medium">Linha</th>
              {MONTHS.map((m) => (
                <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {active
              .filter(
                (line) =>
                  !hideEmpty ||
                  line.kind === "subtotal" ||
                  line.kind === "percentual" ||
                  dreValue(values, line.id, 0) !== 0,
              )
              .map((line) => {
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
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
