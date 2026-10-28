import { PAYROLL_GROUPS } from "@/lib/payroll";
import { fmtBRL } from "@/lib/format";

/** Cartões do ano: bruto, retenções, líquido, encargos, provisões, benefícios e custo total. */
export function PayrollSummary({ yearTotals }: { yearTotals: Map<string, number> }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PAYROLL_GROUPS.map((s) => (
          <div key={s.group} className="rounded-md border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{s.label} no ano</div>
            <div className="font-mono text-lg tabular-nums">
              {fmtBRL(yearTotals.get(s.group) ?? 0)}
            </div>
            <div className="text-xs text-muted-foreground">{s.hint}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        O INSS e o IRRF vêm das tabelas e dos dependentes de cada pessoa; os encargos, provisões e
        benefícios, dos parâmetros do vínculo. Abra uma pessoa (▸) para ver os custos dela mês a
        mês.
      </p>
    </div>
  );
}
