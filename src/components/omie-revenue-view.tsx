import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { byId, useUnits } from "@/lib/catalog";
import { SOURCE_LABELS, useOmieRevenue, type OmieRevenue } from "@/lib/omie";
import { MONTHS, fmtBRL } from "@/lib/format";
import { norm } from "@/lib/products-import";
import { OptionSelect } from "@/components/form-fields";
import { Input } from "@/components/ui/input";

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);
const add = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));
const zero = () => Array(12).fill(0) as number[];
const monthly = (r: OmieRevenue) => r.received.map((v, i) => v + (r.open[i] ?? 0));

interface Category {
  name: string;
  source: OmieRevenue["source"];
  months: number[];
  clients: { name: string; months: number[] }[];
}
interface UnitGroup {
  unitId: string | null;
  months: number[];
  categories: Category[];
}

/** Receita realizada do Omie por unidade → categoria → cliente, mês a mês (recebido + em aberto). */
export function OmieRevenueView({ baseYear }: { baseYear: number }) {
  const years = [baseYear - 2, baseYear - 1, baseYear];
  const [year, setYear] = useState(baseYear);
  const { data, isLoading } = useOmieRevenue(year);
  const { data: units } = useUnits();
  const unitMap = byId(units);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const groups = useMemo(() => {
    const q = norm(search);
    const byUnit = new Map<string, UnitGroup>();
    for (const r of data ?? []) {
      if (q && !norm(r.clientName).includes(q) && !norm(r.categoryName).includes(q)) continue;
      const m = monthly(r);
      const uk = r.unitId ?? "";
      const g = byUnit.get(uk) ?? { unitId: r.unitId, months: zero(), categories: [] };
      g.months = add(g.months, m);
      let c = g.categories.find((x) => x.name === r.categoryName && x.source === r.source);
      if (!c) {
        c = { name: r.categoryName, source: r.source, months: zero(), clients: [] };
        g.categories.push(c);
      }
      c.months = add(c.months, m);
      c.clients.push({ name: r.clientName, months: m });
      byUnit.set(uk, g);
    }
    const out = [...byUnit.values()].filter((g) => sum(g.months) !== 0);
    for (const g of out) {
      g.categories = g.categories.filter((c) => sum(c.months) !== 0);
      g.categories.sort((a, b) => sum(b.months) - sum(a.months));
      for (const c of g.categories) c.clients.sort((a, b) => sum(b.months) - sum(a.months));
    }
    return out.sort((a, b) => sum(b.months) - sum(a.months));
  }, [data, search]);
  const total = groups.reduce((a, g) => add(a, g.months), zero());

  const cells = (values: number[], className = "") => (
    <>
      {values.map((v, i) => (
        <td key={i} className={`px-2 py-1 text-right font-mono tabular-nums ${className}`}>
          {v ? fmtBRL(v) : "—"}
        </td>
      ))}
      <td className={`px-2 py-1 text-right font-mono tabular-nums ${className}`}>
        {fmtBRL(sum(values))}
      </td>
    </>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          className="w-28"
          value={String(year)}
          onChange={(v) => setYear(Number(v ?? baseYear))}
          options={years.map((y) => ({ value: String(y), label: String(y) }))}
        />
        <Input
          className="w-64"
          placeholder="Buscar cliente ou categoria"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Recebido pela data do recebimento + em aberto pelo vencimento. Transferências, dividendos
          e empréstimos ficam de fora.
        </span>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : groups.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          Nenhuma receita de {year} no banco. Rode a leitura do Omie com esse ano (`python3
          scripts/omie-sync.py --year {year}`).
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 font-medium">
                  Unidade / categoria / cliente
                </th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const uk = `u:${g.unitId ?? ""}`;
                const uOpen = open.has(uk);
                return (
                  <Fragment key={uk}>
                    <tr
                      className="cursor-pointer border-b border-border bg-muted/30 font-semibold hover:bg-muted/50"
                      onClick={() => toggle(uk)}
                    >
                      <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">
                        <span className="inline-flex items-center gap-1">
                          {uOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                          {g.unitId ? (unitMap.get(g.unitId)?.name ?? "—") : "Sem unidade"}
                        </span>
                      </td>
                      {cells(g.months)}
                    </tr>
                    {uOpen &&
                      g.categories.map((c) => {
                        const ck = `${uk}|${c.name}|${c.source}`;
                        const cOpen = open.has(ck);
                        return (
                          <Fragment key={ck}>
                            <tr
                              className="cursor-pointer border-b border-border/60 hover:bg-muted/20"
                              onClick={() => toggle(ck)}
                            >
                              <td className="sticky left-0 z-10 bg-card px-3 py-1 pl-7">
                                <span className="inline-flex items-center gap-1">
                                  {cOpen ? (
                                    <ChevronDown className="h-3 w-3" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3" />
                                  )}
                                  {c.name}
                                </span>
                                <div className="pl-4 text-xs text-muted-foreground">
                                  {c.clients.length} cliente(s) · unidade pelo{" "}
                                  {SOURCE_LABELS[c.source]}
                                </div>
                              </td>
                              {cells(c.months)}
                            </tr>
                            {cOpen &&
                              c.clients.map((cl, i) => (
                                <tr
                                  key={`${ck}|${i}`}
                                  className="border-b border-border/40 text-xs text-muted-foreground"
                                >
                                  <td className="sticky left-0 z-10 bg-card px-3 py-0.5 pl-14">
                                    {cl.name}
                                  </td>
                                  {cells(cl.months)}
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Total</td>
                {cells(total)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
