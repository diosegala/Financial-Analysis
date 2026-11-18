import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { MONTHS, fmtBRL } from "@/lib/format";
import { usePlanning } from "@/lib/planning";

const QUARTERS = ["1º trimestre", "2º trimestre", "3º trimestre", "4º trimestre"];

/** Quando o imposto é pago: o mês do ano, ou o ano seguinte. */
const payLabel = (month: number): string =>
  month >= 1 && month <= 12
    ? (MONTHS[month - 1] ?? "—")
    : month > 12
      ? `${MONTHS[month - 13]} do ano seguinte`
      : "—";

/** IRPJ e CSLL da empresa por trimestre: da Contribuição líquida até o imposto e o mês do pagamento. */
export function IncomeTaxPanel() {
  const { versionId, scenarioId } = usePlanning();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["income_tax_quarters", versionId, scenarioId],
    enabled: !!versionId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("income_tax_quarters", {
        _version_id: versionId!,
        _scenario_id: scenarioId!,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  if (isLoading || !rows) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const quarters = rows.filter((r) => r.quarter >= 1).sort((a, b) => a.quarter - b.quarter);
  const previous = rows.find((r) => r.quarter === 0);
  const cell = (v: number | null) => (v === null ? "—" : fmtBRL(Number(v)));
  const lines: {
    label: string;
    value: (r: (typeof quarters)[number]) => string;
    strong?: boolean;
  }[] = [
    { label: "Resultado do trimestre (Contribuição líquida)", value: (r) => cell(r.result) },
    { label: "(+) Despesas não dedutíveis", value: (r) => cell(r.additions) },
    { label: "(=) Lucro real", value: (r) => cell(r.taxable), strong: true },
    { label: "(−) Prejuízo compensado", value: (r) => cell(r.loss_used) },
    { label: "Saldo de prejuízo a compensar", value: (r) => cell(r.loss_balance) },
    { label: "(=) Base de cálculo", value: (r) => cell(r.base), strong: true },
    { label: "IRPJ (com o adicional)", value: (r) => cell(r.irpj) },
    { label: "CSLL", value: (r) => cell(r.csll) },
    { label: "Total a pagar", value: (r) => cell(r.total), strong: true },
    { label: "Pagamento", value: (r) => payLabel(r.pay_month) },
  ];

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">IRPJ e CSLL por trimestre</h2>
      <p className="text-sm text-muted-foreground">
        Lucro real, sobre o resultado da empresa. Cada unidade de negócio recebe a parte
        proporcional à receita dela no trimestre; as áreas de apoio, nenhuma. As alíquotas, os
        limites e o mês do pagamento ficam em{" "}
        <Link to="/parametros" className="underline">
          Parâmetros
        </Link>
        ; as despesas não dedutíveis são marcadas no Plano de contas ou na linha do lançamento.
      </p>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="min-w-64 px-3 py-2 font-medium" />
              {quarters.map((q) => (
                <th key={q.quarter} className="min-w-32 px-3 py-2 text-right font-medium">
                  {QUARTERS[q.quarter - 1]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label} className="border-b border-border last:border-0">
                <td className={`px-3 py-1.5 ${l.strong ? "font-medium" : ""}`}>{l.label}</td>
                {quarters.map((q) => (
                  <td
                    key={q.quarter}
                    className={`px-3 py-1.5 text-right font-mono tabular-nums ${l.strong ? "font-medium" : ""}`}
                  >
                    {l.value(q)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {previous && Number(previous.total) !== 0 && (
        <p className="text-sm text-muted-foreground">
          Em {payLabel(previous.pay_month)} também entra o IRPJ e CSLL do 4º trimestre do ano
          anterior: {fmtBRL(Number(previous.total))}.
        </p>
      )}
    </section>
  );
}
