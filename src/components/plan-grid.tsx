import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MoreHorizontal, Plus, AlertTriangle } from "lucide-react";
import { usePlanning } from "@/lib/planning";
import {
  byId,
  friendlyError,
  useAccounts,
  useClients,
  useProducts,
  useRevenueTypes,
} from "@/lib/catalog";
import {
  contractPlan,
  describePlan,
  describePrice,
  inputOf,
  type PriceModel,
} from "@/lib/products";
import { norm } from "@/lib/products-import";
import type { PlanEvent } from "@/lib/events";
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
  /** Mostra os itens deste evento (em vez das linhas avulsas) e cria os novos dentro dele. */
  event?: PlanEvent | null;
}

type Dialogs =
  | { type: "line"; line: PlanLine | null }
  | { type: "fill"; line: PlanLine }
  | { type: "adjust"; line: PlanLine }
  | { type: "delete"; line: PlanLine }
  | null;

/** Spreadsheet grid of plan lines × 12 months for one account kind of the selected unit/version. */
export function PlanGrid({ kind, emptyText, event = null }: PlanGridProps) {
  const { versionId, unitId, canEdit: unitEditable, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: lines, isLoading } = usePlanLines(versionId, unitId, kind, event?.id ?? null);
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const { setValues } = usePlanMutations();
  const [dialog, setDialog] = useState<Dialogs>(null);

  // Folha: só o financeiro lança. Alterar ou excluir o que já foi lançado também é só do financeiro;
  // o líder adiciona linhas novas (as regras do banco garantem o mesmo).
  const isFin = !!user?.isFinanceiro;
  const canAdd = unitEditable && (kind !== "folha" || isFin);
  const canEditRows = unitEditable && isFin;
  const accountMap = byId(accounts);
  const clientMap = byId(clients);
  const productMap = byId(products);
  const typeMap = byId(revenueTypes);
  const grid = `grid-${kind}-${event?.id ?? "avulso"}`;
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
          {canEditRows
            ? "Clique numa célula para editar. Enter/setas navegam; cole uma faixa copiada do Excel."
            : canAdd
              ? "Você adiciona linhas novas. Para corrigir ou excluir uma linha já lançada, peça ao financeiro."
              : (lockReason ?? (kind === "folha" ? "Somente o financeiro edita a folha." : ""))}
        </p>
        {canAdd && (
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
                const accountName = accountMap.get(line.account_id)?.name;
                const clientName = line.client_id ? clientMap.get(line.client_id)?.name : null;
                const productName = line.product_id ? productMap.get(line.product_id)?.name : null;
                const label =
                  line.description ||
                  [clientName, productName].filter(Boolean).join(" — ") ||
                  accountName;
                // O cliente (ou patrocinador) já está no título quando a linha não tem descrição.
                const sub = [accountName, type?.name, line.description ? clientName : null].filter(
                  Boolean,
                );
                return (
                  <tr key={line.id} className="border-b border-border last:border-0">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1">
                      <div className="font-medium">{label}</div>
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
                          disabled={!canEditRows}
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
                      {canEditRows && (
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
        <LineDialog kind={kind} line={dialog.line} event={event} onClose={() => setDialog(null)} />
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

/** Doze campos, um por mês, para quem precisa de uma distribuição que não seja igual entre os meses. */
function MonthlyEditor({
  values,
  total,
  onChange,
  onReset,
}: {
  values: string[];
  total: number;
  onChange: (index: number, text: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="grid grid-cols-6 gap-2">
        {MONTHS.map((m, i) => (
          <label key={m} className="text-xs text-muted-foreground">
            {m}
            <Input
              value={values[i] ?? ""}
              onChange={(e) => onChange(i, e.target.value)}
              aria-label={`Valor de ${m}`}
              className="mt-0.5 h-8 px-2 text-right font-mono text-xs"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between text-sm">
        <span>
          Total: <strong>{fmtBRL(total)}</strong>
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>
          Voltar ao automático
        </Button>
      </div>
    </div>
  );
}

function LineDialog({
  kind,
  line,
  event,
  onClose,
}: {
  kind: AccountKind;
  line: PlanLine | null;
  /** Quando preenchido, a linha é um item deste evento. */
  event: PlanEvent | null;
  onClose: () => void;
}) {
  const { versionId, unitId } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const { addLine, updateLine } = usePlanMutations();
  const queryClient = useQueryClient();
  const isRevenue = kind === "receita";
  const inEvent = !!event;

  const options = (accounts ?? []).filter(
    (a) =>
      a.kind === kind &&
      a.active &&
      a.treatment === "lancavel" &&
      (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  // Só serviços entram aqui; eventos e treinamentos são lançados em Eventos.
  const productOptions = (products ?? []).filter(
    (p) =>
      p.kind === "servico" &&
      ((p.active && (!p.unit_id || p.unit_id === unitId)) || p.id === line?.product_id),
  );

  const [accountId, setAccountId] = useState<string | null>(
    line?.account_id ?? options[0]?.id ?? null,
  );
  const [description, setDescription] = useState(line?.description ?? "");
  const [clientName, setClientName] = useState(
    line?.client_id ? ((clients ?? []).find((c) => c.id === line.client_id)?.name ?? "") : "",
  );
  const [productId, setProductId] = useState<string | null>(line?.product_id ?? null);
  const [revenueTypeId, setRevenueTypeId] = useState<string | null>(line?.revenue_type_id ?? null);
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [startMonth, setStartMonth] = useState<number | null>(event?.month ?? 1);
  const [months, setMonths] = useState<string>(inEvent ? "1" : "");
  const [manual, setManual] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const product = productOptions.find((p) => p.id === productId);
  const type = (revenueTypes ?? []).find((t) => t.id === revenueTypeId);
  const model = (product?.price_model ?? "mensal") as PriceModel;
  const priceNum = amount.trim() === "" ? null : parseNum(amount);
  const quantityNum = quantity.trim() === "" ? null : parseNum(quantity);
  const monthsNum = months.trim() === "" ? null : Number(months);
  const defaultMonths =
    product?.duration_months ?? type?.recurrence_months ?? type?.max_months ?? null;

  // Item de evento: quantidade × valor unitário, dividido em parcelas iguais. Linha comum: preço e prazo do
  // produto (ou os digitados). Nos dois casos, a partir do mês de início.
  const eventTotal =
    priceNum !== null && quantityNum !== null && quantityNum >= 0
      ? Math.round(priceNum * quantityNum * 100) / 100
      : null;
  const plan =
    !line && startMonth !== null
      ? inEvent
        ? eventTotal !== null && eventTotal >= 0
          ? contractPlan(
              { price: eventTotal, price_model: "total", duration_months: monthsNum ?? 1 },
              startMonth,
            )
          : null
        : priceNum !== null && priceNum >= 0
          ? contractPlan(
              { price: priceNum, price_model: model, duration_months: monthsNum ?? defaultMonths },
              startMonth,
            )
          : null
      : null;

  // Ajuste mês a mês: sobrepõe a distribuição automática.
  const manualParsed = manual
    ? manual.map((t, i) => ({ month: i + 1, value: t.trim() === "" ? 0 : parseNum(t) }))
    : null;
  const manualInvalid = !!manualParsed?.some((m) => m.value === null);
  const schedule = manualParsed
    ? manualParsed
        .filter((m) => m.value !== null && m.value !== 0)
        .map((m) => ({ month: m.month, amount: m.value as number }))
    : (plan?.schedule ?? []);
  const scheduleTotal = Math.round(schedule.reduce((a, m) => a + m.amount, 0) * 100) / 100;

  function openManual() {
    setManual(
      MONTHS.map((_, i) => {
        const m = plan?.schedule.find((x) => x.month === i + 1);
        return m ? inputOf(m.amount) : "";
      }),
    );
  }

  function pickProduct(id: string | null) {
    setProductId(id);
    const p = productOptions.find((x) => x.id === id);
    if (!p) return;
    if (p.revenue_type_id) setRevenueTypeId(p.revenue_type_id);
    if (p.revenue_account_id && options.some((a) => a.id === p.revenue_account_id))
      setAccountId(p.revenue_account_id);
    if (!line) {
      setAmount(inputOf(p.price));
      setMonths(p.duration_months ? String(p.duration_months) : "");
    }
  }

  /** Cliente digitado: usa o cadastrado ou cria um novo. false = falhou. */
  async function resolveClient(): Promise<string | null | false> {
    const name = clientName.trim();
    if (!isRevenue || name === "") return null;
    const hit = (clients ?? []).find((c) => norm(c.name) === norm(name));
    if (hit) return hit.id;
    const { data, error } = await supabase.from("clients").insert({ name }).select("id").single();
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await queryClient.invalidateQueries({ queryKey: ["clients"] });
    return data.id;
  }

  async function save() {
    if (!accountId) return;
    setSaving(true);
    const clientId = await resolveClient();
    if (clientId === false) {
      setSaving(false);
      return;
    }
    const fields = {
      account_id: accountId,
      description: description.trim() || null,
      client_id: clientId,
      product_id: isRevenue ? (inEvent ? event.product_id : productId) : null,
      revenue_type_id: isRevenue ? revenueTypeId : null,
    };
    let ok: boolean;
    if (line) {
      ok = await updateLine(line.id, fields);
    } else {
      ok =
        (await addLine(
          {
            ...fields,
            version_id: versionId!,
            unit_id: unitId!,
            event_id: event?.id ?? null,
          },
          schedule,
        )) !== null;
    }
    setSaving(false);
    if (ok) onClose();
  }

  const needsType = isRevenue && !revenueTypeId;
  const needsDescription = inEvent && description.trim() === "";
  const valueLabel =
    !isRevenue || model === "mensal"
      ? "Valor por mês"
      : model === "total"
        ? "Valor do contrato"
        : "Valor (cobrado uma vez)";

  const accountField = (
    <Field label={inEvent ? "Categoria" : "Conta"}>
      <OptionSelect
        value={accountId}
        onChange={setAccountId}
        options={options.map((a) => ({ value: a.id, label: a.name }))}
      />
    </Field>
  );
  const typeField = isRevenue && (
    <Field
      label="Tipo de receita"
      hint={
        inEvent
          ? "Ex.: Ingressos ou Patrocínio. Define a comissão e separa o resultado do evento por origem."
          : "Define a recorrência e a base da comissão."
      }
    >
      <OptionSelect
        value={revenueTypeId}
        onChange={setRevenueTypeId}
        options={(revenueTypes ?? [])
          .filter((t) => t.active)
          .map((t) => ({ value: t.id, label: t.name }))}
      />
    </Field>
  );
  const descriptionField = (
    <Field
      label={inEvent ? "Item" : "Descrição"}
      hint={
        inEvent
          ? "Ex.: Ingressos lote 1, Patrocínio Ouro, Local, Alimentação."
          : "Opcional. Ex.: contrato, fornecedor ou observação."
      }
    >
      <Input value={description} onChange={(e) => setDescription(e.target.value)} />
    </Field>
  );
  const clientField = isRevenue && (
    <Field
      label={inEvent ? "Patrocinador ou cliente" : "Cliente"}
      hint="Escolha da lista ou digite o nome de um novo."
    >
      <Input
        list="clients-list"
        value={clientName}
        onChange={(e) => setClientName(e.target.value)}
        placeholder={inEvent ? "Nome do patrocinador ou cliente" : "Nome do cliente"}
      />
      <datalist id="clients-list">
        {(clients ?? [])
          .filter((c) => c.active)
          .map((c) => (
            <option key={c.id} value={c.name} />
          ))}
      </datalist>
    </Field>
  );

  const title = line
    ? "Editar linha"
    : inEvent
      ? isRevenue
        ? "Novo item de receita"
        : "Novo item de custo"
      : "Nova linha";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {inEvent ? (
            <>
              {descriptionField}
              {accountField}
              {typeField}
              {clientField}
            </>
          ) : (
            isRevenue && (
              <>
                <Field
                  label="Produto"
                  hint={
                    productOptions.length === 0
                      ? "Nenhum produto cadastrado para esta unidade. Cadastre em Produtos."
                      : "O preço e o prazo do produto são preenchidos sozinhos."
                  }
                >
                  <OptionSelect
                    value={productId}
                    onChange={pickProduct}
                    noneLabel="Sem produto (lançamento avulso)"
                    options={productOptions.map((p) => ({
                      value: p.id,
                      label: `${p.name} — ${describePrice(p)}`,
                    }))}
                  />
                </Field>
                {clientField}
              </>
            )
          )}

          {!line && (
            <div className="space-y-3 rounded-md border border-border p-3">
              {inEvent ? (
                <div className="grid grid-cols-4 gap-3">
                  <Field label="Quantidade">
                    <Input
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Valor unitário">
                    <Input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Início">
                    <MonthSelect value={startMonth} onChange={setStartMonth} />
                  </Field>
                  <Field label="Parcelas">
                    <Input
                      value={months}
                      onChange={(e) => setMonths(e.target.value.replace(/\D/g, ""))}
                      placeholder="1"
                      className="font-mono"
                    />
                  </Field>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Início">
                    <MonthSelect value={startMonth} onChange={setStartMonth} />
                  </Field>
                  <Field label={valueLabel}>
                    <Input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={isRevenue ? "" : "opcional"}
                      className="font-mono"
                    />
                  </Field>
                  {model !== "unico" && (
                    <Field label="Prazo (meses)">
                      <Input
                        value={months}
                        onChange={(e) => setMonths(e.target.value.replace(/\D/g, ""))}
                        placeholder={defaultMonths ? String(defaultMonths) : "até dez."}
                        className="font-mono"
                      />
                    </Field>
                  )}
                </div>
              )}
              {manual ? (
                <MonthlyEditor
                  values={manual}
                  total={scheduleTotal}
                  onChange={(i, t) => setManual((m) => m && m.map((v, k) => (k === i ? t : v)))}
                  onReset={() => setManual(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    {plan
                      ? describePlan(plan, [...MONTHS])
                      : "Informe o valor para ver a distribuição."}
                  </p>
                  <Button variant="outline" size="sm" onClick={openManual}>
                    Ajustar mês a mês
                  </Button>
                </div>
              )}
              {manualInvalid && (
                <p className="text-sm text-destructive">
                  Há um valor inválido na distribuição por mês.
                </p>
              )}
            </div>
          )}

          {!inEvent &&
            (isRevenue ? (
              <details open={needsType || undefined} className="rounded-md border border-border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  Mais detalhes{type ? ` · ${type.name}` : ""}
                </summary>
                <div className="grid gap-3 border-t border-border p-3">
                  {accountField}
                  {typeField}
                  {descriptionField}
                </div>
              </details>
            ) : (
              <div className="grid gap-3">
                {accountField}
                {descriptionField}
              </div>
            ))}
          {needsType && (
            <p className="text-sm text-destructive">
              {inEvent
                ? "Escolha o tipo de receita."
                : "Escolha o tipo de receita em “Mais detalhes”, ou selecione um produto que já tenha um."}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={save}
            disabled={saving || !accountId || needsType || needsDescription || manualInvalid}
          >
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
