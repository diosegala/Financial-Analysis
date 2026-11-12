import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useAccounts, useContractTypes } from "@/lib/catalog";
import {
  plannedCosts,
  useGuardrailMutations,
  useGuardrailSettings,
  useGuardrails,
  useReferenceSuppliers,
  useUnitReference,
} from "@/lib/guardrails";
import { MONTHS, fmtBRL, parseNum } from "@/lib/format";
import {
  monthRange,
  spreadYear,
  usePlanLines,
  usePlanMutations,
  type AccountKind,
  type PlanLine,
} from "@/lib/plan-data";
import { usePlanning } from "@/lib/planning";
import { MoneyCell } from "@/components/money-cell";
import { NumberCell } from "@/components/number-cell";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Row {
  accountId: string;
  name: string;
  lines: PlanLine[];
  reference: Map<number, number> | undefined;
  refTotal: number;
  months: number[];
  total: number;
}

const sum = (values: Iterable<number>) => [...values].reduce((a, v) => a + v, 0);

/** A categoria abre em lançamentos quando tem mais de um ou quando o único tem nome (ex.: um cliente). */
const opensLines = (row: Row) =>
  row.lines.length > 1 || (row.lines.length === 1 && !!row.lines[0]?.description);

/** Situação da categoria contra o limite: o que passou, a folga ou nada, enquanto não houver plano. */
export function Situation({
  planned,
  limit,
  pending = false,
}: {
  planned: number;
  limit: number | null;
  /** O limite ainda não foi calculado no Plano CUPOLA. */
  pending?: boolean;
}) {
  if (pending) return <span className="text-muted-foreground">Limite a definir</span>;
  if (planned === 0) return <span className="text-muted-foreground">A preencher</span>;
  if (limit === null) return <span className="text-muted-foreground">Novo: entra no total</span>;
  const diff = planned - limit;
  return diff > 0 ? (
    <span className="font-medium text-destructive">{fmtBRL(diff)} acima</span>
  ) : (
    <span className="font-medium text-emerald-700 dark:text-emerald-400">
      {fmtBRL(-diff)} de folga
    </span>
  );
}

/**
 * A grade do diretor: uma linha por categoria, da maior para a menor. Por ano, mostra o ano base, o limite e a situação ao
 * lado do valor do ano, que é editável. Mês a mês, mostra os 12 meses. Categoria com vários lançamentos abre para editar cada um.
 */
export function CategoryGrid({
  kind,
  onOpenPeople,
}: {
  kind: AccountKind;
  /** Despesas: a primeira linha é a folha, que abre o passo Pessoas. */
  onOpenPeople?: () => void;
}) {
  const { versionId, unitId, scenarioId, canEdit, year } = usePlanning();
  const { data: allLines, isLoading } = usePlanLines(versionId, unitId, kind);
  // Taxas e impostos da planilha de Educação ficam na DRE, não nas grades.
  const lines = allLines?.filter((l) => l.origin !== "planilha_deducao");
  const { data: accounts } = useAccounts();
  const { data: contractTypes } = useContractTypes();
  const { data: reference } = useUnitReference(versionId, unitId);
  const { data: settings } = useGuardrailSettings(scenarioId);
  const { data: guardrails } = useGuardrails(scenarioId);
  const { setValues, addLine, updateLine, deleteLine } = usePlanMutations();
  const { loadReference } = useGuardrailMutations(scenarioId);
  const [monthly, setMonthly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [cutting, setCutting] = useState<Row | null>(null);
  const [suppliers, setSuppliers] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [addingLine, setAddingLine] = useState<Row | null>(null);
  /** Categorias mexidas nesta tela: continuam à vista mesmo sem valor, para digitar. */
  const [kept, setKept] = useState<Set<string>>(new Set());
  const keep = (accountId: string) => setKept((k) => new Set(k).add(accountId));

  const isCost = kind === "despesa";
  const lineWord = kind === "receita" ? "cliente" : "item";
  const showBase = kind !== "folha";
  const baseCol = showBase && !monthly;
  const costCol = isCost && !monthly;
  const cut = Number(settings?.cost_cut_pct ?? 0);
  const limitOf = (ref: number) => ref * (1 - cut);
  const baseYear = year ? year - 1 : "";
  const guard = guardrails?.find((g) => g.unitId === unitId);
  const calculated = !!settings?.suggested_at;

  const salaryAccounts = new Set((contractTypes ?? []).map((c) => c.account_id));
  const available = (accounts ?? []).filter(
    (a) =>
      a.active &&
      a.kind === kind &&
      a.treatment === "lancavel" &&
      !a.per_person &&
      !salaryAccounts.has(a.id) &&
      (!a.unit_ids || (unitId && a.unit_ids.includes(unitId))),
  );
  const names = new Map((accounts ?? []).map((a) => [a.id, a.name]));
  const byAccount = new Map<string, PlanLine[]>();
  for (const l of lines ?? [])
    byAccount.set(l.account_id, [...(byAccount.get(l.account_id) ?? []), l]);
  const refKinds = new Set((accounts ?? []).filter((a) => a.kind === kind).map((a) => a.id));
  const ids = new Set([
    ...byAccount.keys(),
    ...(showBase ? [...(reference?.keys() ?? [])].filter((id) => refKinds.has(id)) : []),
  ]);
  const allRows: Row[] = [...ids]
    .map((accountId) => {
      const ls = byAccount.get(accountId) ?? [];
      const ref = reference?.get(accountId);
      const months = MONTHS.map((_, i) => sum(ls.map((l) => l.values.get(i + 1) ?? 0)));
      return {
        accountId,
        name: names.get(accountId) ?? "—",
        lines: ls,
        reference: ref,
        refTotal: ref ? sum(ref.values()) : 0,
        months,
        total: sum(months),
      };
    })
    .sort((a, b) => Math.max(b.refTotal, b.total) - Math.max(a.refTotal, a.total));
  // Aparece a categoria lançada na unidade, mesmo zerada: o valor pode vir depois. A que só existe no ano anterior fica em
  // "Adicionar categoria", e o ano anterior segue na base do limite.
  const rows = allRows.filter((r) => r.total !== 0 || r.lines.length > 0 || kept.has(r.accountId));
  const shown = new Set(rows.map((r) => r.accountId));
  const hidden = allRows.filter((r) => !shown.has(r.accountId) && r.refTotal !== 0);
  const availableIds = new Set(available.map((a) => a.id));
  const addable = (accounts ?? [])
    .filter(
      (a) => !shown.has(a.id) && (availableIds.has(a.id) || (ids.has(a.id) && refKinds.has(a.id))),
    )
    .map((a) => {
      const ref = reference?.get(a.id);
      const refTotal = ref ? sum(ref.values()) : 0;
      return {
        id: a.id,
        label: refTotal ? `${a.name} · ${baseYear}: ${fmtBRL(refTotal)}` : a.name,
        refTotal,
      };
    })
    .sort((a, b) => b.refTotal - a.refTotal || a.label.localeCompare(b.label));
  const emptyPlan = isCost && (lines ?? []).length === 0 && (reference?.size ?? 0) > 0;
  const colSpan = 3 + (monthly ? 12 : 0) + (baseCol ? 1 : 0) + (costCol ? 2 : 0);

  /** Grava um mês da categoria: cria o lançamento se ainda não houver. */
  async function commit(row: Row, values: { month: number; amount: number }[]) {
    keep(row.accountId);
    const line = row.lines[0];
    if (line) return setValues(line.id, values);
    return addLine({ version_id: versionId!, unit_id: unitId!, account_id: row.accountId }, values);
  }

  /** Valor do ano digitado: dividido igualmente pelos 12 meses. */
  function setYear(row: Row, line: PlanLine | undefined, total: number) {
    keep(row.accountId);
    const values = spreadYear(total).map((amount, i) => ({ month: i + 1, amount }));
    return line ? setValues(line.id, values) : commit(row, values);
  }

  async function bringBase(row: Row) {
    if (!row.reference) return;
    const values = MONTHS.map((_, i) => ({
      month: i + 1,
      amount: row.reference?.get(i + 1) ?? 0,
    }));
    if (!opensLines(row)) return void (await commit(row, values));
    // Com clientes ou itens lançados, o ano anterior entra como mais um item, sem mexer nos outros.
    const description = `Valores de ${baseYear}`;
    const line = row.lines.find((l) => l.description === description);
    keep(row.accountId);
    setOpen((o) => new Set(o).add(row.accountId));
    if (line) await setValues(line.id, values);
    else
      await addLine(
        { version_id: versionId!, unit_id: unitId!, account_id: row.accountId, description },
        values,
      );
  }

  async function applyCut(row: Row, pct: number) {
    await Promise.all(
      row.lines.map((l) =>
        setValues(
          l.id,
          [...l.values.entries()].map(([month, amount]) => ({
            month,
            amount: Math.round(amount * (1 - pct) * 100) / 100,
          })),
        ),
      ),
    );
  }

  function pasteBlock(start: number, month: number, block: string[][]) {
    const direct = rows.filter((r) => !opensLines(r));
    block.forEach((cells, i) => {
      const row = direct[start + i];
      if (!row) return;
      const values = cells
        .map((text, c) => ({ month: month + c, amount: parseNum(text) }))
        .filter((v): v is { month: number; amount: number } => v.month <= 12 && v.amount !== null);
      void commit(row, values);
    });
  }

  let directIndex = -1;
  const totals = MONTHS.map((_, i) => sum(rows.map((r) => r.months[i] ?? 0)));
  const payrollRow = isCost && onOpenPeople && guard;
  const totalPlanned = sum(totals) + (payrollRow ? guard.plannedPayroll : 0);
  const totalRef = sum(allRows.map((r) => r.refTotal)) + (payrollRow ? guard.basePayroll : 0);

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="mr-auto flex gap-1 rounded-md border border-border bg-card p-1 text-sm">
          {(
            [
              [false, "Por ano"],
              [true, "Mês a mês"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setMonthly(value)}
              className={`rounded px-3 py-1 ${monthly === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {canEdit && emptyPlan && (
          <Button size="sm" onClick={() => void loadReference(versionId!, unitId!)}>
            Trazer todas as despesas de {baseYear}
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Adicionar categoria
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="sticky left-0 z-10 min-w-64 bg-muted px-3 py-2 font-medium">
                Categoria
              </th>
              {baseCol && <th className="min-w-28 px-2 py-2 text-right font-medium">{baseYear}</th>}
              {costCol && <th className="min-w-28 px-2 py-2 text-right font-medium">Limite</th>}
              <th className="min-w-36 px-2 py-2 text-right font-medium">{year ?? ""}</th>
              {costCol && <th className="min-w-36 px-2 py-2 text-right font-medium">Situação</th>}
              {monthly &&
                MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {payrollRow && (
              <tr
                className="cursor-pointer border-b border-border bg-muted/20 hover:bg-muted/40"
                onClick={onOpenPeople}
              >
                <td className="sticky left-0 z-10 bg-muted px-3 py-1.5 font-medium">
                  Pessoas e benefícios
                  <div className="text-xs font-normal text-muted-foreground">
                    Base: folha atual. Edite no passo Pessoas
                  </div>
                </td>
                {baseCol && (
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {calculated ? fmtBRL(guard.basePayroll) : "—"}
                  </td>
                )}
                {costCol && (
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {calculated ? fmtBRL(guard.payrollLimit) : "—"}
                  </td>
                )}
                <td className="px-2 py-1.5 text-right font-mono font-medium tabular-nums">
                  {fmtBRL(guard.plannedPayroll)}
                </td>
                {costCol && (
                  <td className="px-2 py-1.5 text-right">
                    <Situation
                      planned={guard.plannedPayroll}
                      limit={guard.payrollLimit}
                      pending={!calculated}
                    />
                  </td>
                )}
                {monthly && <td colSpan={12} />}
                <td />
              </tr>
            )}
            {rows.map((row) => {
              const many = opensLines(row);
              // Lançamentos da planilha de Educação: corrigem-se na planilha.
              const fromSheet = row.lines.some((l) => l.sheet_tab_id);
              const editable = canEdit && !fromSheet;
              const isOpen = open.has(row.accountId);
              if (!many) directIndex++;
              const r = directIndex;
              return (
                <Fragment key={row.accountId}>
                  <tr className="border-b border-border">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1 font-medium">
                      {many ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-left"
                          aria-expanded={isOpen}
                          onClick={() =>
                            setOpen((s) => {
                              const n = new Set(s);
                              if (n.has(row.accountId)) n.delete(row.accountId);
                              else n.add(row.accountId);
                              return n;
                            })
                          }
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                          )}
                          {row.name}
                          <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">
                            ({row.lines.length}{" "}
                            {row.lines.length === 1
                              ? lineWord
                              : lineWord === "item"
                                ? "itens"
                                : `${lineWord}s`}
                            )
                          </span>
                        </button>
                      ) : (
                        row.name
                      )}
                      {fromSheet && (
                        <span
                          className="ml-1 text-xs font-normal text-muted-foreground"
                          title="Vem da planilha de Educação. Para mudar, altere a planilha e leia de novo."
                        >
                          · da planilha
                        </span>
                      )}
                    </td>
                    {baseCol && (
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {row.refTotal ? fmtBRL(row.refTotal) : "—"}
                      </td>
                    )}
                    {costCol && (
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {row.refTotal ? fmtBRL(limitOf(row.refTotal)) : "—"}
                      </td>
                    )}
                    <td className="px-2 py-1 text-right">
                      {monthly || many ? (
                        <span className="font-mono font-medium tabular-nums">
                          {fmtBRL(row.total)}
                        </span>
                      ) : (
                        <NumberCell
                          className="ml-auto w-32"
                          label={`${row.name} em ${year ?? ""}`}
                          value={row.total}
                          disabled={!editable}
                          onSave={(v) => void setYear(row, row.lines[0], v ?? 0)}
                        />
                      )}
                    </td>
                    {costCol && (
                      <td className="px-2 py-1 text-right">
                        <Situation
                          planned={row.total}
                          limit={row.refTotal ? limitOf(row.refTotal) : null}
                        />
                      </td>
                    )}
                    {monthly &&
                      MONTHS.map((_, i) => (
                        <td key={i} className="border-l border-border/50 p-0">
                          {many ? (
                            <div className="px-2 py-1 text-right font-mono tabular-nums">
                              {row.months[i] ? fmtBRL(row.months[i]!) : "—"}
                            </div>
                          ) : (
                            <MoneyCell
                              value={row.months[i] ?? 0}
                              disabled={!editable}
                              pos={{ grid: `grid-${kind}`, row: r, col: i }}
                              onCommit={(v) => void commit(row, [{ month: i + 1, amount: v }])}
                              onPasteBlock={(block) => pasteBlock(r, i + 1, block)}
                            />
                          )}
                        </td>
                      ))}
                    <td className="px-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`Ações de ${row.name}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {editable && (
                            <DropdownMenuItem onClick={() => setAddingLine(row)}>
                              Adicionar {lineWord}…
                            </DropdownMenuItem>
                          )}
                          {editable && row.reference && (
                            <DropdownMenuItem onClick={() => void bringBase(row)}>
                              Trazer valores de {baseYear}
                            </DropdownMenuItem>
                          )}
                          {editable && row.total > 0 && (
                            <DropdownMenuItem onClick={() => setCutting(row)}>
                              Cortar em %…
                            </DropdownMenuItem>
                          )}
                          {isCost && row.reference && (
                            <DropdownMenuItem onClick={() => setSuppliers(row)}>
                              Ver fornecedores de {baseYear}
                            </DropdownMenuItem>
                          )}
                          {editable && row.lines.length > 0 && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setRemoving(row)}
                              >
                                Excluir categoria
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                  {many && isOpen && editable && (
                    <tr className="border-b border-border/50 bg-muted/20 text-xs">
                      <td className="sticky left-0 z-10 bg-muted/40 py-1 pl-7 pr-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-xs"
                          onClick={() => setAddingLine(row)}
                        >
                          <Plus className="h-3.5 w-3.5" /> Adicionar {lineWord}
                        </Button>
                      </td>
                      <td colSpan={colSpan - 1} />
                    </tr>
                  )}
                  {many &&
                    isOpen &&
                    row.lines.map((l) => (
                      <tr key={l.id} className="border-b border-border/50 bg-muted/20 text-xs">
                        <td className="sticky left-0 z-10 bg-muted/40 py-1 pl-7 pr-2">
                          <div className="flex items-center gap-1">
                            <Input
                              key={l.description ?? ""}
                              aria-label={`Nome do ${lineWord}`}
                              defaultValue={l.description ?? ""}
                              placeholder={`Nome do ${lineWord}`}
                              disabled={!canEdit || !!l.sheet_tab_id}
                              className="h-7 text-xs"
                              onBlur={(e) => {
                                const name = e.target.value.trim();
                                if (name !== (l.description ?? ""))
                                  void updateLine(l.id, { description: name || null });
                              }}
                            />
                            {canEdit && !l.sheet_tab_id && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0"
                                aria-label={`Excluir ${l.description ?? lineWord}`}
                                onClick={() => void deleteLine(l.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                        {baseCol && <td />}
                        {costCol && <td />}
                        <td className="px-2 py-1 text-right">
                          {monthly ? (
                            <span className="font-mono tabular-nums">
                              {fmtBRL(sum(l.values.values()))}
                            </span>
                          ) : (
                            <NumberCell
                              className="ml-auto w-32"
                              label={`${l.description ?? row.name} em ${year ?? ""}`}
                              value={sum(l.values.values())}
                              disabled={!canEdit || !!l.sheet_tab_id}
                              onSave={(v) => void setYear(row, l, v ?? 0)}
                            />
                          )}
                        </td>
                        {costCol && <td />}
                        {monthly &&
                          MONTHS.map((_, i) => (
                            <td key={i} className="border-l border-border/50 p-0">
                              <MoneyCell
                                value={l.values.get(i + 1) ?? 0}
                                disabled={!canEdit || !!l.sheet_tab_id}
                                onCommit={(v) =>
                                  void setValues(l.id, [{ month: i + 1, amount: v }])
                                }
                              />
                            </td>
                          ))}
                        <td />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            {rows.length === 0 && !payrollRow ? (
              <tr>
                <td colSpan={colSpan} className="px-3 py-8 text-center text-muted-foreground">
                  Nenhuma categoria ainda. Use "Adicionar categoria".
                </td>
              </tr>
            ) : (
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Total</td>
                {baseCol && (
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(totalRef)}
                  </td>
                )}
                {costCol && (
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {guard && calculated ? fmtBRL(guard.ceiling) : "—"}
                  </td>
                )}
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(totalPlanned)}
                </td>
                {costCol && (
                  <td className="px-2 py-1.5 text-right">
                    {guard ? (
                      <Situation
                        planned={plannedCosts(guard)}
                        limit={guard.ceiling}
                        pending={!calculated}
                      />
                    ) : null}
                  </td>
                )}
                {monthly &&
                  totals.map((t, i) => (
                    <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(t)}
                    </td>
                  ))}
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hidden.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden.length === 1
            ? `1 categoria de ${baseYear} sem valor em ${year ?? ""} não aparece`
            : `${hidden.length} categorias de ${baseYear} sem valor em ${year ?? ""} não aparecem`}{" "}
          ({fmtBRL(sum(hidden.map((r) => r.refTotal)))} em {baseYear}, somados no total acima). Para
          lançar, use Adicionar categoria.
        </p>
      )}

      {adding && (
        <AddCategoryDialog
          options={addable.map((a) => ({ value: a.id, label: a.label }))}
          onClose={() => setAdding(false)}
          onAdd={async (accountId) => {
            // Pode já haver lançamento sem valor: só volta para a tela.
            const ok =
              byAccount.has(accountId) ||
              (await addLine({
                version_id: versionId!,
                unit_id: unitId!,
                account_id: accountId,
              }));
            if (ok) {
              keep(accountId);
              setAdding(false);
            }
          }}
        />
      )}
      {addingLine && (
        <AddLineDialog
          row={addingLine}
          word={lineWord}
          onClose={() => setAddingLine(null)}
          onAdd={async (description, values) => {
            const ok = await addLine(
              {
                version_id: versionId!,
                unit_id: unitId!,
                account_id: addingLine.accountId,
                description,
              },
              values,
            );
            if (ok) {
              setOpen((o) => new Set(o).add(addingLine.accountId));
              setAddingLine(null);
            }
          }}
        />
      )}
      {cutting && (
        <CutDialog
          row={cutting}
          onClose={() => setCutting(null)}
          onApply={async (pct) => {
            await applyCut(cutting, pct);
            setCutting(null);
          }}
        />
      )}
      {suppliers && <SuppliersDialog row={suppliers} onClose={() => setSuppliers(null)} />}
      {removing && (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Excluir {removing.name}?</DialogTitle>
              <DialogDescription>
                A categoria e os valores dela em {year} saem do planejamento desta unidade. Ela
                continua no cadastro e o valor de {baseYear} continua na base do limite. Para usar
                de novo, clique em Adicionar categoria.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  await Promise.all(removing.lines.map((l) => deleteLine(l.id)));
                  setKept((k) => {
                    const n = new Set(k);
                    n.delete(removing.accountId);
                    return n;
                  });
                  setRemoving(null);
                }}
              >
                Excluir
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AddCategoryDialog({
  options,
  onAdd,
  onClose,
}: {
  options: { value: string; label: string }[];
  onAdd: (accountId: string) => void;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar categoria</DialogTitle>
          <DialogDescription>
            Ela entra na grade para você lançar o valor. As com valor no ano anterior vêm primeiro,
            com o total ao lado. Sem esse valor, ela não tem limite próprio: o valor conta no total
            da unidade. Uma categoria nova precisa existir no Omie e ser lida em Configurações.
          </DialogDescription>
        </DialogHeader>
        <Field label="Categoria">
          <OptionSelect value={accountId} onChange={setAccountId} options={options} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!accountId} onClick={() => accountId && onAdd(accountId)}>
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLineDialog({
  row,
  word,
  onAdd,
  onClose,
}: {
  row: Row;
  word: string;
  onAdd: (description: string, values: { month: number; amount: number }[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState<number | null>(1);
  const [to, setTo] = useState<number | null>(12);
  const value = parseNum(amount) ?? 0;
  const months = from && to && from <= to ? monthRange(from, to - from + 1) : [];
  const valid = name.trim() !== "" && value > 0 && months.length > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Adicionar {word} em {row.name}
          </DialogTitle>
          <DialogDescription>
            {valid
              ? `${months.length} ${months.length === 1 ? "mês" : "meses"}: ${fmtBRL(value * months.length)} no ano.`
              : "Informe o nome, o valor por mês e o período."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label={word === "cliente" ? "Cliente" : "Item"}>
              <Input
                aria-label={`Nome do novo ${word}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="Valor por mês">
              <Input
                aria-label="Valor por mês"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          <Field label="De">
            <MonthSelect value={from} onChange={setFrom} />
          </Field>
          <Field label="Até">
            <MonthSelect value={to} onChange={setTo} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!valid}
            onClick={() =>
              onAdd(
                name.trim(),
                months.map((month) => ({ month, amount: value })),
              )
            }
          >
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CutDialog({
  row,
  onApply,
  onClose,
}: {
  row: Row;
  onApply: (pct: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("10");
  const pct = (parseNum(text) ?? 0) / 100;
  const valid = pct > 0 && pct <= 1;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cortar {row.name}</DialogTitle>
          <DialogDescription>
            Reduz todos os meses desta categoria. Hoje: {fmtBRL(row.total)}.
            {valid ? ` Fica em ${fmtBRL(row.total * (1 - pct))}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <Field label="Corte (%)">
          <Input
            aria-label="Corte em %"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid} onClick={() => onApply(pct)}>
            Aplicar corte
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuppliersDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const { versionId, unitId, year } = usePlanning();
  const { data, isLoading } = useReferenceSuppliers(versionId, unitId, row.accountId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{row.name}</DialogTitle>
          <DialogDescription>
            Fornecedores em {year ? year - 1 : ""}, só para consulta.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="max-h-96 overflow-y-auto text-sm">
            {(data ?? []).map((s) => (
              <div
                key={s.supplier}
                className="flex justify-between gap-3 border-b border-border py-1.5"
              >
                <span>{s.supplier}</span>
                <span className="font-mono tabular-nums">{fmtBRL(s.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
