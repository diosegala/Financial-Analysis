import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePlanning } from "@/lib/planning";
import { byId, useAccounts, useUnits } from "@/lib/catalog";
import type { AccountKind } from "@/lib/plan-data";
import { MONTHS, fmtBRL } from "@/lib/format";
import { OptionSelect } from "@/components/form-fields";

interface LineSum {
  unitId: string;
  accountId: string;
  months: number[];
}

/** Todas as linhas da versão de um tipo de conta (todas as unidades), com os 12 meses. Lê em páginas de 1.000. */
function useAllLines(versionId: string | null, kind: AccountKind) {
  return useQuery({
    queryKey: ["plan_lines", "cupola", versionId, kind],
    enabled: !!versionId,
    queryFn: async (): Promise<LineSum[]> => {
      const out: LineSum[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("plan_lines")
          .select("unit_id, account_id, plan_values(month, amount), accounts!inner(kind)")
          .eq("version_id", versionId!)
          .eq("accounts.kind", kind)
          .range(from, from + 999);
        if (error) throw error;
        for (const l of data ?? []) {
          const months = Array(12).fill(0) as number[];
          for (const v of l.plan_values) months[v.month - 1]! += Number(v.amount);
          out.push({ unitId: l.unit_id, accountId: l.account_id, months });
        }
        if (!data || data.length < 1000) return out;
      }
    },
  });
}

const add = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));
const total = (m: number[]) => m.reduce((a, v) => a + v, 0);

/**
 * Visão CUPOLA: a soma de todas as unidades de negócio e áreas de apoio, por conta ou por unidade, mês a mês.
 * Só leitura; cada linha se edita na grade da unidade.
 */
export function ConsolidatedView({ kind }: { kind: AccountKind }) {
  const { versionId } = usePlanning();
  const { data: lines, isLoading } = useAllLines(versionId, kind);
  const { data: units } = useUnits();
  const { data: accounts } = useAccounts();
  const [group, setGroup] = useState<"conta" | "unidade">("conta");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const unitMap = byId(units);
  const accountMap = byId(accounts);

  const rows = useMemo(() => {
    const key = (l: LineSum) => (group === "conta" ? l.accountId : l.unitId);
    const sub = (l: LineSum) => (group === "conta" ? l.unitId : l.accountId);
    const m = new Map<string, { months: number[]; parts: Map<string, number[]> }>();
    for (const l of lines ?? []) {
      const r = m.get(key(l)) ?? { months: Array(12).fill(0), parts: new Map() };
      r.months = add(r.months, l.months);
      r.parts.set(sub(l), add(r.parts.get(sub(l)) ?? Array(12).fill(0), l.months));
      m.set(key(l), r);
    }
    return [...m.entries()]
      .map(([id, r]) => ({
        id,
        months: r.months,
        parts: [...r.parts.entries()].sort((a, b) => total(b[1]) - total(a[1])),
      }))
      .filter((r) => total(r.months) !== 0)
      .sort((a, b) => total(b.months) - total(a.months));
  }, [lines, group]);

  const name = (id: string, isUnit: boolean) =>
    (isUnit ? unitMap.get(id)?.name : accountMap.get(id)?.name) ?? "—";
  const grand = rows.reduce((a, r) => add(a, r.months), Array(12).fill(0) as number[]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Soma de todas as unidades de negócio e áreas de apoio. Clique numa linha para ver o
          detalhe; para editar, escolha a unidade.
        </p>
        <div className="w-48">
          <OptionSelect
            value={group}
            onChange={(v) => {
              setGroup((v as "conta" | "unidade") ?? "conta");
              setOpen(new Set());
            }}
            options={[
              { value: "conta", label: "Por conta" },
              { value: "unidade", label: "Por unidade" },
            ]}
          />
        </div>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 font-medium">
                  {group === "conta" ? "Conta" : "Unidade"}
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
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="cursor-pointer border-b border-border hover:bg-muted/30"
                    onClick={() => toggle(r.id)}
                  >
                    <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium">
                      <span className="inline-flex items-center gap-1">
                        {open.has(r.id) ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        {name(r.id, group === "unidade")}
                      </span>
                    </td>
                    {r.months.map((v, i) => (
                      <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {v ? fmtBRL(v) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-mono font-semibold tabular-nums">
                      {fmtBRL(total(r.months))}
                    </td>
                  </tr>
                  {open.has(r.id) &&
                    r.parts.map(([pid, pm]) => (
                      <tr
                        key={`${r.id}-${pid}`}
                        className="border-b border-border/50 bg-muted/10 text-muted-foreground"
                      >
                        <td className="sticky left-0 z-10 bg-card px-3 py-1 pl-9">
                          {name(pid, group === "conta")}
                        </td>
                        {pm.map((v, i) => (
                          <td key={i} className="px-2 py-1 text-right font-mono tabular-nums">
                            {v ? fmtBRL(v) : "—"}
                          </td>
                        ))}
                        <td className="px-3 py-1 text-right font-mono tabular-nums">
                          {fmtBRL(total(pm))}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-muted-foreground">
                    Nada lançado ainda.
                  </td>
                </tr>
              ) : (
                <tr className="border-t border-border bg-muted/30 font-semibold">
                  <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Total CUPOLA</td>
                  {grand.map((v, i) => (
                    <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(v)}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(total(grand))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Seletor de escopo das páginas de lançamento: a unidade do topo ou a CUPOLA inteira (financeiro, VP e CEO). */
export function ScopeSelect({
  value,
  onChange,
}: {
  value: "unit" | "all";
  onChange: (v: "unit" | "all") => void;
}) {
  return (
    <div className="w-56">
      <OptionSelect
        value={value}
        onChange={(v) => onChange((v as "unit" | "all") ?? "unit")}
        options={[
          { value: "unit", label: "Unidade selecionada" },
          { value: "all", label: "CUPOLA (todas as unidades)" },
        ]}
      />
    </div>
  );
}
