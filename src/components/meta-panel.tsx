import { usePlanning } from "@/lib/planning";
import { useTargetVsPlan } from "@/lib/targets";
import { MONTHS, fmtBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);

/**
 * Meta da unidade quebrada em carteira, renovações e vendas novas.
 * Saldo a vender = meta − carteira − renovações; falta = saldo a vender − vendas novas planejadas.
 */
export function MetaPanel() {
  const { versionId, scenarioId, unitId, unit } = usePlanning();
  const { data: months } = useTargetVsPlan(versionId, scenarioId, unitId);
  if (!months) return null;
  const hasTarget = months.some((m) => m.target > 0);
  if (!hasTarget) {
    return (
      <p className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
        A meta de receita de {unit?.name ?? "esta unidade"} ainda não foi publicada pelo financeiro
        neste cenário. Quando for, ela aparece aqui para você quebrar em carteira, renovações e
        vendas novas.
      </p>
    );
  }

  const saldo = months.map((m) => m.target - m.carteira - m.renovacao);
  const falta = months.map((m, i) => saldo[i]! - m.nova);
  const rows: { label: string; values: number[]; strong?: boolean; tone?: "falta" }[] = [
    { label: "Meta", values: months.map((m) => m.target), strong: true },
    { label: "Carteira atual", values: months.map((m) => m.carteira) },
    { label: "Renovações", values: months.map((m) => m.renovacao) },
    { label: "Saldo a vender", values: saldo, strong: true },
    { label: "Vendas novas planejadas", values: months.map((m) => m.nova) },
    { label: "Falta para a meta", values: falta, strong: true, tone: "falta" },
  ];
  const semOrigem = sum(months.map((m) => m.semOrigem));

  return (
    <section className="space-y-2 rounded-md border border-border bg-card p-3">
      <div>
        <h2 className="text-base font-semibold">Meta de receita × plano</h2>
        <p className="text-xs text-muted-foreground">
          Meta menos carteira e renovações é o saldo a vender. O que as vendas novas planejadas não
          cobrem aparece em “Falta para a meta”.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="min-w-44 px-2 py-1.5 font-medium" />
              {MONTHS.map((m) => (
                <th key={m} className="min-w-20 px-2 py-1.5 text-right font-medium">
                  {m}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className={cn("border-b border-border/60", r.strong && "font-semibold")}
              >
                <td className="px-2 py-1">{r.label}</td>
                {r.values.map((v, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-2 py-1 text-right font-mono tabular-nums",
                      r.tone === "falta" && v > 0.5 && "text-destructive",
                    )}
                  >
                    {fmtBRL(v)}
                  </td>
                ))}
                <td
                  className={cn(
                    "px-2 py-1 text-right font-mono tabular-nums",
                    r.tone === "falta" && sum(r.values) > 0.5 && "text-destructive",
                  )}
                >
                  {fmtBRL(sum(r.values))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {semOrigem > 0 && (
        <p className="text-xs text-destructive">
          {fmtBRL(semOrigem)} em linhas sem origem: edite cada linha e escolha carteira, renovação
          ou venda nova para entrar na conta.
        </p>
      )}
    </section>
  );
}
