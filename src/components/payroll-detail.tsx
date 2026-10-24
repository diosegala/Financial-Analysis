import { useMemo, useState } from "react";
import { usePlanning } from "@/lib/planning";
import { usePayrollDetail, type PayrollGroup, type PersonLine } from "@/lib/payroll";
import { MONTHS, fmtBRL } from "@/lib/format";
import { OptionSelect } from "@/components/form-fields";

const GROUP_ORDER: PayrollGroup[] = [
  "bruto",
  "retencao",
  "liquido",
  "encargo",
  "provisao",
  "beneficio",
  "custo_total",
];

const SUMMARY: { group: PayrollGroup; label: string; hint: string }[] = [
  { group: "bruto", label: "Salário bruto", hint: "O que a pessoa tem direito" },
  {
    group: "retencao",
    label: "INSS e IRRF do empregado",
    hint: "Retidos do bruto, não são custo extra",
  },
  { group: "liquido", label: "Salário líquido", hint: "O que a pessoa recebe" },
  { group: "encargo", label: "Encargos patronais", hint: "INSS patronal, RAT, terceiros, FGTS…" },
  { group: "provisao", label: "Provisões", hint: "13º e férias" },
  { group: "beneficio", label: "Benefícios", hint: "Por pessoa ativa" },
  { group: "custo_total", label: "Custo total", hint: "Bruto + encargos + provisões + benefícios" },
];

/** Por colaborador, de janeiro a dezembro: bruto, líquido, encargos e o custo para a empresa. */
export function PayrollDetail({ people }: { people: PersonLine[] }) {
  const { versionId, scenarioId, unitId } = usePlanning();
  const { data, isLoading } = usePayrollDetail(versionId, scenarioId, unitId);
  const [item, setItem] = useState<string>("Custo total para a empresa");

  const rows = data ?? [];
  const items = useMemo(() => {
    const seen = new Map<string, PayrollGroup>();
    for (const r of rows) if (!seen.has(r.item)) seen.set(r.item, r.grupo);
    return [...seen.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[1]) - GROUP_ORDER.indexOf(b[1]),
    );
  }, [rows]);

  const total = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((a, r) => a + r.amount, 0);
  const byPerson = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of rows) {
      if (r.item !== item) continue;
      const arr = m.get(r.person_id) ?? Array(12).fill(0);
      arr[r.month - 1] = (arr[r.month - 1] ?? 0) + r.amount;
      m.set(r.person_id, arr);
    }
    return m;
  }, [rows, item]);
  const monthTotals = MONTHS.map((_, i) =>
    [...byPerson.values()].reduce((a, arr) => a + (arr[i] ?? 0), 0),
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (people.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Nenhuma pessoa cadastrada nesta unidade.</p>
    );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SUMMARY.map((s) => (
          <div key={s.group} className="rounded-md border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{s.label} no ano</div>
            <div className="font-mono text-lg tabular-nums">
              {fmtBRL(total((r) => r.grupo === s.group))}
            </div>
            <div className="text-xs text-muted-foreground">{s.hint}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        O INSS e o IRRF vêm das tabelas e dos dependentes de cada pessoa; os encargos, provisões e
        benefícios, dos parâmetros do vínculo. Somente leitura: a remuneração se edita na aba
        Remuneração.
      </p>
      <div className="max-w-sm">
        <OptionSelect
          value={item}
          onChange={(v) => v && setItem(v)}
          options={items.map(([name]) => ({ value: name, label: name }))}
        />
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium">Pessoa</th>
              {MONTHS.map((m) => (
                <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {people.map(({ person }) => {
              const arr = byPerson.get(person.id) ?? Array(12).fill(0);
              return (
                <tr key={person.id} className="border-b border-border">
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5">{person.name}</td>
                  {arr.map((v: number, i: number) => (
                    <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {v ? fmtBRL(v) : "—"}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(arr.reduce((a: number, v: number) => a + v, 0))}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-border bg-muted/30 font-semibold">
              <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Total</td>
              {monthTotals.map((t, i) => (
                <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(t)}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                {fmtBRL(monthTotals.reduce((a, t) => a + t, 0))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
