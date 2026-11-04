import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Plus, Sparkles, Trash2 } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useAccounts, useDreLines, type DreLine } from "@/lib/catalog";
import {
  useAccountCompare,
  useAdjustments,
  useAnalysis,
  useCompareMutations,
  useDreCompare,
  useShifts,
  useUnmatched,
  type CompareValues,
} from "@/lib/compare";
import { MONTHS, MONTHS_FULL, fmtBRL, fmtPct, parseNum } from "@/lib/format";
import { lineLabel } from "@/lib/dre";
import { PageHeader } from "@/components/page-header";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/acompanhamento")({
  head: pageHead("Acompanhamento", "Previsto × realizado, previsão do ano e análise por IA."),
  component: AcompanhamentoPage,
});

/** Diferença boa ou ruim: em receita e resultado, faltar é ruim; em custo, passar é ruim. */
function Diff({ line, value, percent }: { line: DreLine; value: number; percent: boolean }) {
  const income = line.kind === "subtotal" || line.kind === "percentual" || line.sign > 0;
  const bad = income ? value < 0 : value > 0;
  const shown = percent ? fmtPct(value) : fmtBRL(value);
  if (Math.abs(value) < 0.005) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={bad ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>
      {shown}
    </span>
  );
}

function CompareTable({
  lines,
  values,
  month,
  closed,
}: {
  lines: DreLine[];
  values: CompareValues;
  /** 0 = acumulado até o último mês fechado. */
  month: number;
  closed: number;
}) {
  const cell = (id: string, m: number) =>
    values.get(id)?.get(m) ?? { planned: 0, actual: 0, forecast: 0 };
  const ytd = (line: DreLine) => {
    if (line.kind === "percentual") {
      const part = (id: string | null) => {
        let p = 0;
        let a = 0;
        for (let m = 1; m <= closed; m++) {
          p += cell(id ?? "", m).planned;
          a += cell(id ?? "", m).actual;
        }
        return { p, a };
      };
      const n = part(line.numerator_line_id);
      const d = part(line.denominator_line_id);
      return { planned: d.p ? n.p / d.p : 0, actual: d.a ? n.a / d.a : 0 };
    }
    let planned = 0;
    let actual = 0;
    for (let m = 1; m <= closed; m++) {
      planned += cell(line.id, m).planned;
      actual += cell(line.id, m).actual;
    }
    return { planned, actual };
  };
  const yearView = month === 0;
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-1.5 text-right font-mono tabular-nums";
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th className="px-3 py-2 font-medium">Linha</th>
            <th className={th}>Previsto{yearView ? " até o mês" : ""}</th>
            <th className={th}>Realizado{yearView ? " até o mês" : ""}</th>
            <th className={th}>Diferença</th>
            {yearView && <th className={th}>Plano do ano</th>}
            {yearView && <th className={th}>Previsão do ano</th>}
            {yearView && <th className={th}>Previsão × plano</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const percent = line.kind === "percentual";
            const strong = line.kind === "subtotal" || percent || line.sign > 0;
            const fmt = (v: number) => (percent ? fmtPct(v) : fmtBRL(v));
            const now = yearView ? ytd(line) : cell(line.id, month);
            const year = cell(line.id, 0);
            return (
              <tr
                key={line.id}
                className={`border-b border-border last:border-0 ${strong ? "bg-muted/30 font-semibold" : ""}`}
              >
                <td className="px-3 py-1.5">{lineLabel(line)}</td>
                <td className={td}>{fmt(now.planned)}</td>
                <td className={td}>{fmt(now.actual)}</td>
                <td className={td}>
                  <Diff line={line} value={now.actual - now.planned} percent={percent} />
                </td>
                {yearView && <td className={td}>{fmt(year.planned)}</td>}
                {yearView && <td className={td}>{fmt(year.forecast)}</td>}
                {yearView && (
                  <td className={td}>
                    <Diff line={line} value={year.forecast - year.planned} percent={percent} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BiggestDifferences({
  unitId,
  month,
  closed,
}: {
  unitId: string | null;
  month: number;
  closed: number;
}) {
  const { versionId, scenarioId } = usePlanning();
  const { data } = useAccountCompare(versionId, scenarioId, unitId);
  const totals = new Map<string, { name: string; kind: string; planned: number; actual: number }>();
  for (const r of data ?? []) {
    if (month ? r.month !== month : r.month > closed) continue;
    const t = totals.get(r.accountId) ?? { name: r.name, kind: r.kind, planned: 0, actual: 0 };
    t.planned += r.planned;
    t.actual += r.actual;
    totals.set(r.accountId, t);
  }
  const list = [...totals.values()]
    .filter((t) => Math.abs(t.actual - t.planned) >= 1)
    .sort((a, b) => Math.abs(b.actual - b.planned) - Math.abs(a.actual - a.planned))
    .slice(0, 10);
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Maiores diferenças por categoria</h2>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="px-3 py-2 font-medium">Categoria</th>
              <th className="px-3 py-2 text-right font-medium">Previsto</th>
              <th className="px-3 py-2 text-right font-medium">Realizado</th>
              <th className="px-3 py-2 text-right font-medium">Diferença</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const diff = t.actual - t.planned;
              const bad = t.kind === "receita" ? diff < 0 : diff > 0;
              return (
                <tr key={t.name} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{t.name}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(t.planned)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(t.actual)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono tabular-nums ${bad ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}
                  >
                    {fmtBRL(diff)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AnalysisPanel({ unitId, title }: { unitId: string | null; title: string }) {
  const { versionId, scenarioId } = usePlanning();
  const { data } = useAnalysis(versionId, unitId);
  const { analyze } = useCompareMutations();
  const [busy, setBusy] = useState(false);
  const a = data?.content;
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Análise por IA · {title}</h2>
          <p className="text-xs text-muted-foreground">
            {data
              ? `Feita em ${new Date(data.at).toLocaleString("pt-BR")}. É uma sugestão: confira antes de decidir.`
              : "Lê a DRE, as categorias e os limites e aponta gargalos, ajustes e como o ano tende a fechar."}
          </p>
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await analyze(versionId!, scenarioId!, unitId);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles className="h-4 w-4" />{" "}
          {busy ? "Analisando…" : data ? "Analisar de novo" : "Analisar"}
        </Button>
      </div>
      {a && (
        <div className="space-y-3 text-sm">
          <p>{a.resumo}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {(
              [
                ["Gargalos", a.gargalos],
                ["Onde ajustar", a.ajustes],
              ] as const
            ).map(([label, items]) => (
              <div key={label} className="space-y-2">
                <h3 className="font-semibold">{label}</h3>
                {items.map((i) => (
                  <div key={i.titulo}>
                    <div className="font-medium">{i.titulo}</div>
                    <div className="text-muted-foreground">{i.explicacao}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div>
            <h3 className="font-semibold">Como o ano tende a fechar</h3>
            <p className="text-muted-foreground">{a.previsao}</p>
          </div>
        </div>
      )}
    </section>
  );
}

type Move =
  | {
      type: "shift";
      accountId: string | null;
      from: number | null;
      to: number | null;
      amount: string;
      note: string;
    }
  | { type: "adjust"; accountId: string | null; from: number | null; amount: string; note: string };

function MoveDialog({ initial, onClose }: { initial: Move; onClose: () => void }) {
  const { versionId, unitId } = usePlanning();
  const { data: accounts } = useAccounts();
  const { addShift, addAdjustment } = useCompareMutations();
  const [m, setM] = useState<Move>(initial);
  const value = parseNum(m.amount) ?? 0;
  const shift = m.type === "shift";
  const valid =
    !!m.accountId &&
    !!m.from &&
    value !== 0 &&
    m.note.trim() !== "" &&
    (shift ? value > 0 && !!m.to && m.to !== m.from : true);
  const options = (accounts ?? [])
    .filter(
      (a) =>
        a.active &&
        a.treatment !== "fora_dre" &&
        (!a.unit_ids || (unitId && a.unit_ids.includes(unitId))),
    )
    .map((a) => ({ value: a.id, label: a.name }));
  async function save() {
    if (!valid) return;
    const base = {
      version_id: versionId!,
      unit_id: unitId!,
      account_id: m.accountId!,
      note: m.note.trim(),
    };
    const ok =
      m.type === "shift"
        ? await addShift({ ...base, from_month: m.from!, to_month: m.to!, amount: value })
        : await addAdjustment({ ...base, month: m.from!, amount: value });
    if (ok) onClose();
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shift ? "Remanejar entre meses" : "Ajustar o realizado"}</DialogTitle>
          <DialogDescription>
            {shift
              ? "O valor saiu de um mês e vai acontecer em outro. O plano aprovado não muda; a previsão do ano sim."
              : "Corrige o realizado quando o Omie não reflete o fato. Use negativo para reduzir."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Categoria">
              <OptionSelect
                value={m.accountId}
                onChange={(v) => setM({ ...m, accountId: v })}
                options={options}
              />
            </Field>
          </div>
          <Field label={shift ? "Saiu de" : "Mês"}>
            <MonthSelect value={m.from} onChange={(v) => setM({ ...m, from: v })} />
          </Field>
          {m.type === "shift" && (
            <Field label="Vai para">
              <MonthSelect value={m.to} onChange={(v) => setM({ ...m, to: v })} />
            </Field>
          )}
          <div className="col-span-2">
            <Field label="Valor">
              <Input
                aria-label="Valor"
                value={m.amount}
                onChange={(e) => setM({ ...m, amount: e.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="Motivo">
              <Textarea
                aria-label="Motivo"
                value={m.note}
                onChange={(e) => setM({ ...m, note: e.target.value })}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} onClick={() => void save()}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AcompanhamentoPage() {
  const { unit, unitId, version, versionId, scenarioId, isAdmin } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: lines } = useDreLines();
  const [company, setCompany] = useState(false);
  const [month, setMonth] = useState(0);
  const [move, setMove] = useState<Move | null>(null);
  const management = !!user?.isManagement && (isAdmin || !user.isFinanceiro);
  const scopeUnit = company && management ? null : unitId;
  const { data: values, isLoading } = useDreCompare(versionId, scenarioId, scopeUnit);
  const { data: shifts } = useShifts(versionId, scopeUnit);
  const { data: adjustments } = useAdjustments(versionId, scopeUnit);
  const { data: unmatched } = useUnmatched(versionId, isAdmin);
  const { deleteShift, deleteAdjustment, setClosedMonth } = useCompareMutations();
  const closed = version?.closed_month ?? 0;
  const canMove =
    !!scopeUnit && !!user?.canWrite && (user.isFinanceiro || user.unitIds.includes(scopeUnit));
  const active = (lines ?? []).filter((l) => {
    if (!l.active) return false;
    if (l.kind === "subtotal" || l.kind === "percentual") return true;
    const year = values?.get(l.id)?.get(0);
    return !!year && (year.planned !== 0 || year.actual !== 0 || year.forecast !== 0);
  });
  const title = scopeUnit ? (unit?.name ?? "…") : "CUPOLA";

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Acompanhamento · ${title}`}
        subtitle={
          closed
            ? `Realizado do Omie até ${MONTHS_FULL[closed - 1]?.toLowerCase()}. A previsão do ano soma o realizado, o previsto dos meses abertos e os remanejamentos.`
            : "Nenhum mês fechado ainda: a previsão do ano é igual ao plano. O realizado aparece quando o financeiro fechar o primeiro mês."
        }
        actions={
          <div className="flex flex-wrap items-end gap-2">
            {management && (
              <div className="w-52">
                <OptionSelect
                  value={company ? "c" : "u"}
                  onChange={(v) => setCompany(v === "c")}
                  options={[
                    { value: "u", label: "Unidade selecionada" },
                    { value: "c", label: "CUPOLA (empresa)" },
                  ]}
                />
              </div>
            )}
            <div className="w-52">
              <OptionSelect
                value={String(month)}
                onChange={(v) => setMonth(Number(v ?? 0))}
                options={[
                  { value: "0", label: "Acumulado do ano" },
                  ...MONTHS_FULL.map((m, i) => ({ value: String(i + 1), label: m })),
                ]}
              />
            </div>
            {isAdmin && versionId && (
              <div className="w-56">
                <OptionSelect
                  value={String(closed)}
                  onChange={(v) => void setClosedMonth(versionId, Number(v ?? 0))}
                  options={[
                    { value: "0", label: "Nenhum mês fechado" },
                    ...MONTHS_FULL.map((m, i) => ({
                      value: String(i + 1),
                      label: `Fechado até ${m}`,
                    })),
                  ]}
                />
              </div>
            )}
          </div>
        }
      />

      {isLoading || !values ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <CompareTable lines={active} values={values} month={month} closed={closed} />
      )}

      <BiggestDifferences unitId={scopeUnit} month={month} closed={closed} />

      <AnalysisPanel unitId={scopeUnit} title={title} />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Remanejamentos</h2>
            <p className="text-sm text-muted-foreground">
              Pagamento ou recebimento que mudou de mês. Vale com o plano travado e não altera o
              plano.
            </p>
          </div>
          {canMove && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() =>
                setMove({
                  type: "shift",
                  accountId: null,
                  from: null,
                  to: null,
                  amount: "",
                  note: "",
                })
              }
            >
              <Plus className="h-4 w-4" /> Remanejar
            </Button>
          )}
        </div>
        {(shifts ?? []).map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <span className="font-medium">{s.accounts?.name}</span>
            {!scopeUnit && <span className="text-muted-foreground">{s.units?.name}</span>}
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              {MONTHS[s.from_month - 1]} <ArrowRight className="h-3 w-3" /> {MONTHS[s.to_month - 1]}
            </span>
            <span className="font-mono tabular-nums">{fmtBRL(Number(s.amount))}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.note}>
              {s.note}
            </span>
            {canMove && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Excluir remanejamento"
                onClick={() => void deleteShift(s.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </section>

      {(isAdmin || (adjustments ?? []).length > 0) && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Ajustes do realizado</h2>
              <p className="text-sm text-muted-foreground">
                Correções feitas pelo financeiro quando o Omie não reflete o fato.
              </p>
            </div>
            {isAdmin && scopeUnit && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() =>
                  setMove({ type: "adjust", accountId: null, from: null, amount: "", note: "" })
                }
              >
                <Plus className="h-4 w-4" /> Ajustar
              </Button>
            )}
          </div>
          {(adjustments ?? []).map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <span className="font-medium">{a.accounts?.name}</span>
              {!scopeUnit && <span className="text-muted-foreground">{a.units?.name}</span>}
              <span className="text-muted-foreground">{MONTHS[a.month - 1]}</span>
              <span className="font-mono tabular-nums">{fmtBRL(Number(a.amount))}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={a.note}>
                {a.note}
              </span>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Excluir ajuste"
                  onClick={() => void deleteAdjustment(a.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

      {isAdmin && (unmatched ?? []).length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">O que não casou com o plano</h2>
          <p className="text-sm text-muted-foreground">
            Valores do Omie sem conta ou sem unidade neste ano. Acerte em Configurações antes de
            fechar o mês.
          </p>
          <div className="rounded-md border border-border bg-card text-sm">
            {(unmatched ?? []).map((u) => (
              <div
                key={`${u.issue}${u.category_name}`}
                className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0"
              >
                <span>
                  {u.category_name} <span className="text-muted-foreground">· {u.issue}</span>
                </span>
                <span className="font-mono tabular-nums">{fmtBRL(Number(u.amount))}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {move && <MoveDialog initial={move} onClose={() => setMove(null)} />}
    </div>
  );
}
