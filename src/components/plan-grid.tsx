import { useState } from "react";
import { MoreHorizontal, Plus, AlertTriangle } from "lucide-react";
import { usePlanning } from "@/lib/planning";
import { byId, useAccounts, useClients, useProducts, useRevenueTypes } from "@/lib/catalog";
import {
  adjustFrom,
  monthRange,
  usePlanLines,
  usePlanMutations,
  type AccountKind,
  type PlanLine,
} from "@/lib/plan-data";
import { MONTHS, fmtBRL, parseNum } from "@/lib/format";
import { useCurrentUser } from "@/lib/auth";
import { MoneyCell } from "@/components/money-cell";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface PlanGridProps {
  kind: AccountKind;
  emptyText: string;
}

type Dialogs =
  | { type: "line"; line: PlanLine | null }
  | { type: "fill"; line: PlanLine }
  | { type: "adjust"; line: PlanLine }
  | { type: "delete"; line: PlanLine }
  | null;

/** Spreadsheet grid of plan lines × 12 months for one account kind of the selected unit/version. */
export function PlanGrid({ kind, emptyText }: PlanGridProps) {
  const { versionId, unitId, canEdit: unitEditable, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: lines, isLoading } = usePlanLines(versionId, unitId, kind);
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const { setValues } = usePlanMutations();
  const [dialog, setDialog] = useState<Dialogs>(null);

  // Folha: só o financeiro lança (as regras do banco garantem o mesmo).
  const canEdit = unitEditable && (kind !== "folha" || !!user?.isFinanceiro);
  const accountMap = byId(accounts);
  const clientMap = byId(clients);
  const productMap = byId(products);
  const typeMap = byId(revenueTypes);
  const grid = `grid-${kind}`;
  const rows = lines ?? [];

  function pasteBlock(rowIndex: number, month: number, block: string[][]) {
    block.forEach((cells, r) => {
      const line = rows[rowIndex + r];
      if (!line) return;
      const values = cells
        .map((text, c) => ({ month: month + c, amount: parseNum(text) }))
        .filter((v): v is { month: number; amount: number } => v.month <= 12 && v.amount !== null);
      void setValues(line.id, values);
    });
  }

  const monthTotals = MONTHS.map((_, i) =>
    rows.reduce((a, l) => a + (l.values.get(i + 1) ?? 0), 0),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? "Clique numa célula para editar. Enter/setas navegam; cole uma faixa copiada do Excel."
            : (lockReason ?? (kind === "folha" ? "Somente o financeiro edita a folha." : ""))}
        </p>
        {canEdit && (
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setDialog({ type: "line", line: null })}
          >
            <Plus className="h-4 w-4" /> Adicionar linha
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium">
                  Linha
                </th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((line, r) => {
                const total = [...line.values.values()].reduce((a, v) => a + v, 0);
                const type = line.revenue_type_id ? typeMap.get(line.revenue_type_id) : undefined;
                const filled = [...line.values.values()].filter((v) => v !== 0).length;
                const overMax = type?.max_months != null && filled > type.max_months;
                const sub = [
                  accountMap.get(line.account_id)?.name,
                  line.client_id ? clientMap.get(line.client_id)?.name : null,
                  line.product_id ? productMap.get(line.product_id)?.name : null,
                  type?.name,
                ].filter(Boolean);
                return (
                  <tr key={line.id} className="border-b border-border last:border-0">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1">
                      <div className="font-medium">{line.description || sub[0]}</div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {sub.join(" · ")}
                        {overMax && (
                          <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
                            <AlertTriangle className="h-3 w-3" /> mais de {type!.max_months} meses
                          </Badge>
                        )}
                      </div>
                    </td>
                    {MONTHS.map((_, i) => (
                      <td key={i} className="border-l border-border/50 p-0">
                        <MoneyCell
                          value={line.values.get(i + 1) ?? 0}
                          disabled={!canEdit}
                          pos={{ grid, row: r, col: i }}
                          onCommit={(v) => setValues(line.id, [{ month: i + 1, amount: v }])}
                          onPasteBlock={(block) => pasteBlock(r, i + 1, block)}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">
                      {fmtBRL(total)}
                    </td>
                    <td className="px-1">
                      {canEdit && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label="Ações da linha"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setDialog({ type: "line", line })}>
                              Editar linha
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setDialog({ type: "fill", line })}>
                              Preencher meses…
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setDialog({ type: "adjust", line })}>
                              Reajustar a partir de um mês…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDialog({ type: "delete", line })}
                            >
                              Excluir linha
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-3 py-8 text-center text-muted-foreground">
                    {emptyText}
                  </td>
                </tr>
              ) : (
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
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.type === "line" && (
        <LineDialog kind={kind} line={dialog.line} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "fill" && <FillDialog line={dialog.line} onClose={() => setDialog(null)} />}
      {dialog?.type === "adjust" && (
        <AdjustDialog line={dialog.line} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "delete" && (
        <DeleteDialog line={dialog.line} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function LineDialog({
  kind,
  line,
  onClose,
}: {
  kind: AccountKind;
  line: PlanLine | null;
  onClose: () => void;
}) {
  const { versionId, unitId } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const { addLine, updateLine } = usePlanMutations();

  const options = (accounts ?? []).filter(
    (a) => a.kind === kind && a.active && (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  const [accountId, setAccountId] = useState<string | null>(
    line?.account_id ?? options[0]?.id ?? null,
  );
  const [description, setDescription] = useState(line?.description ?? "");
  const [clientId, setClientId] = useState<string | null>(line?.client_id ?? null);
  const [productId, setProductId] = useState<string | null>(line?.product_id ?? null);
  const [revenueTypeId, setRevenueTypeId] = useState<string | null>(line?.revenue_type_id ?? null);
  const [amount, setAmount] = useState("");
  const [startMonth, setStartMonth] = useState<number | null>(1);
  const [months, setMonths] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const type = (revenueTypes ?? []).find((t) => t.id === revenueTypeId);
  const defaultMonths = type?.recurrence_months ?? type?.max_months ?? 13 - (startMonth ?? 1);

  function pickProduct(id: string | null) {
    setProductId(id);
    const p = (products ?? []).find((x) => x.id === id);
    if (p?.revenue_type_id && !revenueTypeId) setRevenueTypeId(p.revenue_type_id);
  }

  async function save() {
    if (!accountId) return;
    setSaving(true);
    const fields = {
      account_id: accountId,
      description: description.trim() || null,
      client_id: kind === "receita" ? clientId : null,
      product_id: kind === "receita" ? productId : null,
      revenue_type_id: kind === "receita" ? revenueTypeId : null,
    };
    let ok: boolean;
    if (line) {
      ok = await updateLine(line.id, fields);
    } else {
      const value = amount.trim() === "" ? null : parseNum(amount);
      const count = months.trim() === "" ? defaultMonths : Number(months);
      const values =
        value !== null && startMonth !== null
          ? monthRange(startMonth, count).map((m) => ({ month: m, amount: value }))
          : [];
      ok =
        (await addLine(
          { ...fields, version_id: versionId!, unit_id: unitId!, created_by: user?.id ?? null },
          values,
        )) !== null;
    }
    setSaving(false);
    if (ok) onClose();
  }

  const needsType = kind === "receita" && !revenueTypeId;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{line ? "Editar linha" : "Nova linha"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Conta">
            <OptionSelect
              value={accountId}
              onChange={setAccountId}
              options={options.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field label="Descrição" hint="Opcional. Ex.: contrato, fornecedor ou observação.">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {kind === "receita" && (
            <>
              <Field label="Cliente">
                <OptionSelect
                  value={clientId}
                  onChange={setClientId}
                  noneLabel="Sem cliente"
                  options={(clients ?? [])
                    .filter((c) => c.active)
                    .map((c) => ({ value: c.id, label: c.name }))}
                />
              </Field>
              <Field label="Produto">
                <OptionSelect
                  value={productId}
                  onChange={pickProduct}
                  noneLabel="Sem produto"
                  options={(products ?? [])
                    .filter((p) => p.active && (!p.unit_id || p.unit_id === unitId))
                    .map((p) => ({ value: p.id, label: p.name }))}
                />
              </Field>
              <Field label="Tipo de receita">
                <OptionSelect
                  value={revenueTypeId}
                  onChange={setRevenueTypeId}
                  options={(revenueTypes ?? [])
                    .filter((t) => t.active)
                    .map((t) => ({ value: t.id, label: t.name }))}
                />
              </Field>
            </>
          )}
          {!line && (
            <div className="grid grid-cols-3 gap-3 rounded-md border border-border p-3">
              <Field label="Valor mensal">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="opcional"
                  className="font-mono"
                />
              </Field>
              <Field label="A partir de">
                <MonthSelect value={startMonth} onChange={setStartMonth} />
              </Field>
              <Field label="Por quantos meses">
                <Input
                  value={months}
                  onChange={(e) => setMonths(e.target.value.replace(/\D/g, ""))}
                  placeholder={String(defaultMonths)}
                  className="font-mono"
                />
              </Field>
              {type?.recurrence_months && (
                <p className="col-span-3 text-xs text-muted-foreground">
                  {type.name}: preenche {type.recurrence_months} meses a partir do mês escolhido
                  (até dezembro).
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !accountId || needsType}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FillDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
  const { setValues } = usePlanMutations();
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState<number | null>(1);
  const [to, setTo] = useState<number | null>(12);
  const value = parseNum(amount);

  async function save() {
    if (value === null || from === null || to === null || to < from) return;
    if (
      await setValues(
        line.id,
        monthRange(from, to - from + 1).map((m) => ({ month: m, amount: value })),
      )
    )
      onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Preencher meses</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Valor">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="font-mono"
            />
          </Field>
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
            onClick={save}
            disabled={value === null || amount.trim() === "" || (to ?? 0) < (from ?? 0)}
          >
            Preencher
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
  const { setValues } = usePlanMutations();
  const [pct, setPct] = useState("");
  const [from, setFrom] = useState<number | null>(1);
  const value = parseNum(pct);

  async function save() {
    if (value === null || from === null) return;
    if (await setValues(line.id, adjustFrom(line.values, from, value / 100))) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reajustar a partir de um mês</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reajuste (%)" hint="Use negativo para reduzir.">
            <Input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              placeholder="ex.: 5"
              className="font-mono"
            />
          </Field>
          <Field label="A partir de">
            <MonthSelect value={from} onChange={setFrom} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={value === null || pct.trim() === ""}>
            Reajustar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
  const { deleteLine } = usePlanMutations();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir esta linha?</AlertDialogTitle>
          <AlertDialogDescription>
            A linha e os valores dos 12 meses serão removidos. A exclusão fica registrada na
            auditoria.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={async () => (await deleteLine(line.id)) && onClose()}>
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
