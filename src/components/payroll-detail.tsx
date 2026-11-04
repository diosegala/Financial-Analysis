import { PAYROLL_GROUPS } from "@/lib/payroll";
import { fmtBRL } from "@/lib/format";

/** Cartões do ano: bruto, encargos, 13º e férias, benefícios e custo total. Líquido e descontos abrem em cada pessoa. */
export function PayrollSummary({ yearTotals }: { yearTotals: Map<string, number> }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PAYROLL_GROUPS.filter((s) => s.group !== "retencao" && s.group !== "liquido").map((s) => (
          <div key={s.group} className="rounded-md border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{s.label} no ano</div>
            <div className="font-mono text-lg tabular-nums">
              {fmtBRL(yearTotals.get(s.group) ?? 0)}
            </div>
            <div className="text-xs text-muted-foreground">{s.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
