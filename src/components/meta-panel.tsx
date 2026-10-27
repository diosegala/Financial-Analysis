import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePlanning } from "@/lib/planning";
import { byId, useProducts } from "@/lib/catalog";
import { useRevenueByProduct, useTargetVsPlan } from "@/lib/targets";
import { MONTHS, fmtBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);

/**
 * Meta da unidade quebrada em carteira, renovações e vendas novas.
 * Saldo a vender = meta − carteira − renovações; falta = saldo a vender − vendas novas planejadas.
 * Carteira, renovações e vendas novas abrem por produto, mês a mês (o "+" de cada linha).
 */
export function MetaPanel() {
  const { versionId, scenarioId, unitId, unit } = usePlanning();
  const { data: months } = useTargetVsPlan(versionId, scenarioId, unitId);
  const { data: byProduct } = useRevenueByProduct(versionId, unitId);
  const { data: products } = useProducts();
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!months) return null;
  const productMap = byId(products);
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  /** Produtos de uma origem, do maior para o menor no ano. */
  const productRows = (origin: string) =>
    [...(byProduct?.get(origin) ?? new Map<string | null, number[]>()).entries()]
      .map(([id, values]) => ({
        label: id ? (productMap.get(id)?.name ?? "—") : "Sem produto",
        values,
      }))
      .sort((a, b) => sum(b.values) - sum(a.values));
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
  const rows: {
    label: string;
    values: number[];
    strong?: boolean;
    tone?: "falta";
    origin?: string;
  }[] = [
    { label: "Meta", values: months.map((m) => m.target), strong: true },
    { label: "Carteira atual", values: months.map((m) => m.carteira), origin: "carteira" },
    { label: "Renovações", values: months.map((m) => m.renovacao), origin: "renovacao" },
    { label: "Saldo a vender", values: saldo, strong: true },
    { label: "Vendas novas planejadas", values: months.map((m) => m.nova), origin: "nova" },
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
            {rows.map((r) => {
              const details = r.origin ? productRows(r.origin) : [];
              const isOpen = !!r.origin && open.has(r.origin);
              return (
                <Fragment key={r.label}>
                  <tr className={cn("border-b border-border/60", r.strong && "font-semibold")}>
                    <td className="px-2 py-1">
                      {details.length > 0 ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 whitespace-nowrap hover:underline"
                          onClick={() => toggle(r.origin!)}
                          aria-expanded={isOpen}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          {r.label}
                        </button>
                      ) : (
                        r.label
                      )}
                    </td>
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
                  {isOpen &&
                    details.map((d) => (
                      <tr
                        key={`${r.origin}-${d.label}`}
                        className="border-b border-border/40 text-xs text-muted-foreground"
                      >
                        <td className="px-2 py-0.5 pl-7">{d.label}</td>
                        {d.values.map((v, i) => (
                          <td key={i} className="px-2 py-0.5 text-right font-mono tabular-nums">
                            {v ? fmtBRL(v) : "—"}
                          </td>
                        ))}
                        <td className="px-2 py-0.5 text-right font-mono tabular-nums">
                          {fmtBRL(sum(d.values))}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
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
