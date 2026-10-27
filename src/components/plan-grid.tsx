import { Fragment, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  MoreHorizontal,
  Plus,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Download,
  StickyNote,
} from "lucide-react";
import { usePlanning } from "@/lib/planning";
import {
  byId,
  friendlyError,
  useAccounts,
  useClients,
  useProductLines,
  useProducts,
  useRevenueTypes,
  useUnits,
} from "@/lib/catalog";
import {
  FORMAT_LABELS,
  contractPlan,
  describePlan,
  describePrice,
  inputOf,
  type PriceModel,
  type ProductFormat,
} from "@/lib/products";
import { downloadText } from "@/lib/dre";
import { RevenuePasteDialog } from "@/components/revenue-paste-dialog";
import { norm } from "@/lib/products-import";
import { REVENUE_ORIGINS, unitRevenueAccount } from "@/lib/revenue-paste";
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
  | { type: "move"; line: PlanLine }
  | { type: "paste" }
  | null;

type RevenueView = "produto" | "origem" | "lancamento";
const VIEW_KEY = "receitas.ver";
function readRevenueView(): RevenueView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "produto" || v === "origem" || v === "lancamento") return v;
  } catch {
    // sem armazenamento local (aba privada, prévia): fica o padrão
  }
  return "produto";
}

/** Spreadsheet grid of plan lines × 12 months for one account kind of the selected unit/version. */
export function PlanGrid({ kind, emptyText, event = null }: PlanGridProps) {
  const { versionId, unitId, unit, canEdit: unitEditable, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: productLines } = useProductLines();
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
      const line = visible[rowIndex + r];
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

  // Despesas e outros lançamentos de folha: agrupados por conta. A conta é a soma dos lançamentos (ex.: os SaaS de
  // "SAAS - Agência"). Receitas: por produto (agrupados pela linha de produto), por origem ou lançamento a lançamento.
  // Grupo com até 3 lançamentos já vem aberto; o maior abre com um clique.
  const [revenueView, setRevenueView] = useState<RevenueView>(readRevenueView);
  function chooseRevenueView(v: RevenueView) {
    setRevenueView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // sem armazenamento local: a escolha vale só nesta tela
    }
  }
  const isRevenueGrid = kind === "receita" && !event;
  const grouped = !event && (kind !== "receita" || revenueView !== "lancamento");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const lineMap = byId(productLines);
  const groupOf = (
    l: PlanLine,
  ): { key: string; label: string; sub: string | null; order: string } => {
    if (kind !== "receita") {
      const name = accountMap.get(l.account_id)?.name ?? "—";
      return { key: l.account_id, label: name, sub: null, order: name };
    }
    if (revenueView === "origem") {
      const i = REVENUE_ORIGINS.findIndex((o) => o.value === l.revenue_origin);
      return {
        key: l.revenue_origin ?? "_none",
        label: i >= 0 ? REVENUE_ORIGINS[i]!.label : "Sem origem",
        sub: null,
        order: String(i >= 0 ? i : 9),
      };
    }
    const product = l.product_id ? productMap.get(l.product_id) : undefined;
    const pl = product?.line_id ? lineMap.get(product.line_id) : undefined;
    const format = pl && pl.format !== "nenhum" ? FORMAT_LABELS[pl.format as ProductFormat] : null;
    return {
      key: product?.id ?? "_none",
      label: product?.name ?? "Sem produto",
      sub: [pl?.name, format].filter(Boolean).join(" · ") || null,
      // Linha de produto primeiro (na ordem do cadastro), depois o nome; "Sem produto" no fim.
      order: product
        ? `${pl ? String(pl.sort_order).padStart(4, "0") + pl.name : "~"}|${product.name}`
        : "~~",
    };
  };
  const total = (l: PlanLine) => [...l.values.values()].reduce((a, v) => a + v, 0);
  const groups = (() => {
    const m = new Map<string, { info: ReturnType<typeof groupOf>; lines: PlanLine[] }>();
    for (const l of rows) {
      const info = groupOf(l);
      const g = m.get(info.key) ?? { info, lines: [] };
      g.lines.push(l);
      m.set(info.key, g);
    }
    return [...m.values()]
      .map(({ info, lines: ls }) => ({
        ...info,
        lines: [...ls].sort((a, b) => total(b) - total(a)),
        months: MONTHS.map((_, i) => ls.reduce((a, l) => a + (l.values.get(i + 1) ?? 0), 0)),
      }))
      .sort((a, b) => a.order.localeCompare(b.order, "pt-BR"));
  })();
  // Visão por produto: total por formato (online × presencial) no rodapé, quando houver produto com formato.
  const formatTotals = (() => {
    if (!isRevenueGrid || revenueView !== "produto") return [];
    const m = new Map<string, number[]>();
    for (const l of rows) {
      const product = l.product_id ? productMap.get(l.product_id) : undefined;
      const f = (product?.line_id ? lineMap.get(product.line_id)?.format : null) ?? "nenhum";
      const acc = m.get(f) ?? MONTHS.map(() => 0);
      MONTHS.forEach((_, i) => (acc[i]! += l.values.get(i + 1) ?? 0));
      m.set(f, acc);
    }
    if ([...m.keys()].every((f) => f === "nenhum")) return [];
    return (["online", "presencial", "hibrido", "nenhum"] as ProductFormat[])
      .filter((f) => m.has(f))
      .map((f) => ({ label: FORMAT_LABELS[f], months: m.get(f)! }));
  })();
  const isOpen = (g: { key: string; lines: PlanLine[] }) =>
    openGroups.has(g.key) !== g.lines.length <= 3;
  // Linhas visíveis, na ordem da tela: a navegação por teclado e o colar do Excel seguem esta ordem.
  const visible = grouped ? groups.flatMap((g) => (isOpen(g) ? g.lines : [])) : rows;

  function exportCsv() {
    const num = (v: number) => v.toFixed(2).replace(".", ",");
    const q = (t: string | null | undefined) => `"${(t ?? "").replace(/"/g, '""')}"`;
    const header = [
      "Descrição",
      "Produto",
      "Origem",
      ...MONTHS,
      "Total",
      "Linha do produto",
      "Conta",
      "Premissa",
    ];
    const body = (grouped ? groups.flatMap((g) => g.lines) : rows).map((l) => {
      const product = l.product_id ? productMap.get(l.product_id) : undefined;
      return [
        q(lineLabel(l)),
        q(product?.name),
        q(REVENUE_ORIGINS.find((o) => o.value === l.revenue_origin)?.label),
        ...MONTHS.map((_, i) => num(l.values.get(i + 1) ?? 0)),
        num(total(l)),
        q(product?.line_id ? lineMap.get(product.line_id)?.name : null),
        q(accountMap.get(l.account_id)?.name),
        q(l.note),
      ].join(";");
    });
    downloadText(
      `receitas-${(unit?.name ?? "unidade").toLowerCase().replace(/\s+/g, "-")}.csv`,
      "\ufeff" + [header.join(";"), ...body].join("\n"),
    );
  }

  /** Título da linha: a descrição; sem ela, cliente — produto; sem os dois, a conta. */
  function lineLabel(line: PlanLine) {
    const clientName = line.client_id ? clientMap.get(line.client_id)?.name : null;
    const productName = line.product_id ? productMap.get(line.product_id)?.name : null;
    return (
      line.description ||
      [clientName, productName].filter(Boolean).join(" — ") ||
      accountMap.get(line.account_id)?.name ||
      ""
    );
  }

  /** Uma linha da grade. Dentro de um grupo, o que já está no cabeçalho (conta ou origem) sai do subtítulo. */
  function renderLine(line: PlanLine, r: number, inGroup: boolean) {
    const total = [...line.values.values()].reduce((a, v) => a + v, 0);
    const type = line.revenue_type_id ? typeMap.get(line.revenue_type_id) : undefined;
    const filled = [...line.values.values()].filter((v) => v !== 0).length;
    const overMax = type?.max_months != null && filled > type.max_months;
    const accountName = accountMap.get(line.account_id)?.name;
    const clientName = line.client_id ? clientMap.get(line.client_id)?.name : null;
    // O cliente (ou patrocinador) já está no título quando a linha não tem descrição.
    const sub = [
      inGroup && kind !== "receita" ? null : accountName,
      type?.name,
      inGroup && revenueView === "origem"
        ? null
        : REVENUE_ORIGINS.find((o) => o.value === line.revenue_origin)?.label,
      line.description ? clientName : null,
    ].filter(Boolean);
    return (
      <tr key={line.id} className="border-b border-border last:border-0">
        <td className="sticky left-0 z-10 bg-card px-3 py-1">
          <div className="font-medium">{lineLabel(line)}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {sub.join(" · ")}
            {line.note && (
              <span
                className="inline-flex max-w-64 items-center gap-1 truncate italic"
                title={line.note}
              >
                <StickyNote className="h-3 w-3 shrink-0" /> {line.note}
              </span>
            )}
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
        <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">{fmtBRL(total)}</td>
        <td className="px-1">
          {canEditRows && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Ações da linha">
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
                {!event && (
                  <DropdownMenuItem onClick={() => setDialog({ type: "move", line })}>
                    Mudar de unidade…
                  </DropdownMenuItem>
                )}
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
  }

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
        <div className="flex flex-wrap items-center gap-2">
          {isRevenueGrid && (
            <>
              <OptionSelect
                className="w-44"
                value={revenueView}
                onChange={(v) => chooseRevenueView((v as RevenueView | null) ?? "produto")}
                options={[
                  { value: "produto", label: "Ver por produto" },
                  { value: "origem", label: "Ver por origem" },
                  { value: "lancamento", label: "Ver lançamentos" },
                ]}
              />
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={rows.length === 0}
                onClick={exportCsv}
              >
                <Download className="h-4 w-4" /> Exportar
              </Button>
              {canAdd && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setDialog({ type: "paste" })}
                >
                  <ClipboardPaste className="h-4 w-4" /> Colar da planilha
                </Button>
              )}
            </>
          )}
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
              {grouped
                ? groups.map((g) => {
                    const open = isOpen(g);
                    return (
                      <Fragment key={g.key}>
                        <tr
                          data-group-header
                          className="cursor-pointer border-b border-border bg-muted/20 hover:bg-muted/40"
                          onClick={() => toggleGroup(g.key)}
                        >
                          <td className="sticky left-0 z-10 bg-muted px-3 py-1.5 font-semibold">
                            <span className="inline-flex items-center gap-1">
                              {open ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                              {g.label}
                              <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">
                                ({g.lines.length} lançamento{g.lines.length === 1 ? "" : "s"})
                              </span>
                            </span>
                            {g.sub && (
                              <div className="pl-[18px] text-xs font-normal text-muted-foreground">
                                {g.sub}
                              </div>
                            )}
                          </td>
                          {g.months.map((v, i) => (
                            <td
                              key={i}
                              className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums"
                            >
                              {v ? fmtBRL(v) : "—"}
                            </td>
                          ))}
                          <td className="px-3 py-1.5 text-right font-mono font-semibold tabular-nums">
                            {fmtBRL(g.months.reduce((a, v) => a + v, 0))}
                          </td>
                          <td />
                        </tr>
                        {open &&
                          g.lines.map((line) => renderLine(line, visible.indexOf(line), true))}
                      </Fragment>
                    );
                  })
                : rows.map((line, r) => renderLine(line, r, false))}
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
              {rows.length > 0 &&
                formatTotals.map((f) => (
                  <tr key={f.label} className="border-t border-border/60 text-muted-foreground">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1 pl-6">{f.label}</td>
                    {f.months.map((v, i) => (
                      <td key={i} className="px-2 py-1 text-right font-mono tabular-nums">
                        {v ? fmtBRL(v) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-1 text-right font-mono tabular-nums">
                      {fmtBRL(f.months.reduce((a, v) => a + v, 0))}
                    </td>
                    <td />
                  </tr>
                ))}
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
      {dialog?.type === "move" && <MoveDialog line={dialog.line} onClose={() => setDialog(null)} />}
      {dialog?.type === "paste" && <RevenuePasteDialog onClose={() => setDialog(null)} />}
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
  const { versionId, unitId, unit } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { data: products } = useProducts();
  const { data: productLines } = useProductLines();
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
  // Todos os produtos ativos da unidade (e os de todas as unidades): serviços, treinamentos, imersões, comunidade.
  const productOptions = (products ?? []).filter(
    (p) => (p.active && (!p.unit_id || p.unit_id === unitId)) || p.id === line?.product_id,
  );
  const lineOptions = (productLines ?? []).filter(
    (l) => l.active && (!l.unit_id || l.unit_id === unitId),
  );

  const unitAccount = isRevenue ? unitRevenueAccount(options, unit) : undefined;
  const [accountId, setAccountId] = useState<string | null>(
    line?.account_id ?? unitAccount?.id ?? options[0]?.id ?? null,
  );
  const [description, setDescription] = useState(line?.description ?? "");
  const [clientName, setClientName] = useState(
    line?.client_id ? ((clients ?? []).find((c) => c.id === line.client_id)?.name ?? "") : "",
  );
  const [productId, setProductId] = useState<string | null>(line?.product_id ?? null);
  const [productName, setProductName] = useState(
    line?.product_id ? ((products ?? []).find((p) => p.id === line.product_id)?.name ?? "") : "",
  );
  const [newProductLineId, setNewProductLineId] = useState<string | null>(null);
  const [note, setNote] = useState(line?.note ?? "");
  const [revenueTypeId, setRevenueTypeId] = useState<string | null>(line?.revenue_type_id ?? null);
  // Itens de evento são vendas novas; as demais linhas de receita escolhem a origem.
  const [revenueOrigin, setRevenueOrigin] = useState<string | null>(
    line?.revenue_origin ?? (inEvent ? "nova" : null),
  );
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [startMonth, setStartMonth] = useState<number | null>(event?.month ?? 1);
  const [months, setMonths] = useState<string>(inEvent ? "1" : "");
  const [manual, setManual] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const product = productOptions.find((p) => p.id === productId);
  // Produto digitado que ainda não existe: é cadastrado na unidade ao salvar.
  const isNewProduct = isRevenue && !inEvent && !product && productName.trim() !== "";
  const type = (revenueTypes ?? []).find((t) => t.id === revenueTypeId);
  // Treinamento, imersão ou evento: o preço é por venda, recebido uma vez no mês da venda.
  const model = (
    product?.kind === "evento" ? "unico" : (product?.price_model ?? "mensal")
  ) as PriceModel;
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
        : priceNum !== null && priceNum >= 0 && quantityNum !== null && quantityNum >= 0
          ? contractPlan(
              {
                price: Math.round(priceNum * (isRevenue ? quantityNum : 1) * 100) / 100,
                price_model: model,
                duration_months: monthsNum ?? defaultMonths,
              },
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

  /** Produto digitado ou escolhido na lista: o cadastrado preenche conta, tipo, preço, prazo e quantidade. */
  function typeProduct(name: string) {
    setProductName(name);
    const p = productOptions.find((x) => norm(x.name) === norm(name));
    setProductId(p?.id ?? null);
    if (!p) return;
    if (p.revenue_type_id) setRevenueTypeId(p.revenue_type_id);
    if (p.revenue_account_id && options.some((a) => a.id === p.revenue_account_id))
      setAccountId(p.revenue_account_id);
    if (!line) {
      setAmount(inputOf(p.price));
      setMonths(p.duration_months ? String(p.duration_months) : "");
      setQuantity(p.kind === "evento" && p.default_seats ? inputOf(p.default_seats) : "1");
    }
  }

  /** Cadastra o produto novo na unidade, com o valor e o prazo digitados. false = falhou. */
  async function resolveProduct(): Promise<string | null | false> {
    if (!isRevenue) return null;
    if (inEvent) return event.product_id;
    if (!isNewProduct) return productId;
    const { data, error } = await supabase
      .from("products")
      .insert({
        name: productName.trim(),
        unit_id: unitId,
        kind: "servico",
        price: priceNum,
        price_model: "mensal",
        duration_months: monthsNum,
        line_id: newProductLineId,
        revenue_account_id: accountId,
        revenue_type_id: revenueTypeId,
      })
      .select("id")
      .single();
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await queryClient.invalidateQueries({ queryKey: ["products"] });
    return data.id;
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
    const newProductId = clientId === false ? false : await resolveProduct();
    if (clientId === false || newProductId === false) {
      setSaving(false);
      return;
    }
    const fields = {
      account_id: accountId,
      description: description.trim() || null,
      client_id: clientId,
      product_id: newProductId,
      revenue_type_id: isRevenue ? revenueTypeId : null,
      revenue_origin: isRevenue ? revenueOrigin : null,
      note: note.trim() || null,
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

  // Tipo de receita só é exigido nos itens de evento (Ingressos ou Patrocínio); na receita comum é opcional.
  const needsType = isRevenue && inEvent && !revenueTypeId;
  const needsOrigin = isRevenue && !revenueOrigin;
  const needsDescription = inEvent && description.trim() === "";
  const valueLabel =
    product?.kind === "evento"
      ? "Preço por venda"
      : !isRevenue || model === "mensal"
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
          : "Opcional. Define a recorrência e, para Parceiros, a comissão própria."
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
          : isRevenue
            ? "O que é esta receita. Ex.: Carteira Consultoria, contrato Imobiliária X."
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

  const productField = (
    <Field
      label="Produto"
      hint={
        product
          ? [
              describePrice(product),
              (productLines ?? []).find((l) => l.id === product.line_id)?.name,
            ]
              .filter(Boolean)
              .join(" · ")
          : isNewProduct
            ? `Produto novo: será cadastrado em ${unit?.name ?? "esta unidade"} com o valor e o prazo abaixo.`
            : "Opcional. Escolha da lista ou digite um novo; o valor e o prazo vêm do cadastro."
      }
    >
      <Input
        list="products-list"
        value={productName}
        onChange={(e) => typeProduct(e.target.value)}
        placeholder="Ex.: Imersão, Fee mensal, Comunidade"
      />
      <datalist id="products-list">
        {productOptions
          .filter((p) => p.active)
          .map((p) => (
            <option key={p.id} value={p.name} />
          ))}
      </datalist>
    </Field>
  );
  const newProductLineField = isNewProduct && lineOptions.length > 0 && (
    <Field
      label="Linha do produto novo"
      hint="Agrupa a receita (ex.: Treinamento online, Fee mensal)."
    >
      <OptionSelect
        value={newProductLineId}
        onChange={setNewProductLineId}
        noneLabel="Sem linha"
        options={lineOptions.map((l) => ({ value: l.id, label: l.name }))}
      />
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
                {productField}
                {newProductLineField}
                {descriptionField}
                <Field
                  label="Origem da receita"
                  hint="Carteira: contratos que já existem. Renovação: contratos recorrentes que vencem e renovam. Nova: venda ainda a fazer. A meta menos carteira e renovações é o saldo a vender."
                >
                  <OptionSelect
                    value={revenueOrigin}
                    onChange={setRevenueOrigin}
                    options={REVENUE_ORIGINS}
                  />
                </Field>
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
                <div className={`grid gap-3 ${isRevenue ? "grid-cols-4" : "grid-cols-3"}`}>
                  <Field label="Início">
                    <MonthSelect value={startMonth} onChange={setStartMonth} />
                  </Field>
                  {isRevenue && (
                    <Field label="Quantidade">
                      <Input
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        className="font-mono"
                      />
                    </Field>
                  )}
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
              <details className="rounded-md border border-border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  Mais detalhes (opcional): cliente, conta e tipo
                  <span className="ml-1 font-normal text-muted-foreground">
                    · conta {options.find((a) => a.id === accountId)?.name ?? "—"}
                    {type ? ` · ${type.name}` : ""}
                  </span>
                </summary>
                <div className="grid gap-3 border-t border-border p-3">
                  {clientField}
                  {accountField}
                  {typeField}
                </div>
              </details>
            ) : (
              <div className="grid gap-3">
                {accountField}
                {descriptionField}
              </div>
            ))}
          {isRevenue && !inEvent && (
            <Field
              label="Premissa (opcional)"
              hint="De onde vem o número. Ex.: 3 turmas de 30 alunos; reajuste IPCA em março."
            >
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
          {needsType && <p className="text-sm text-destructive">Escolha o tipo de receita.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={save}
            disabled={
              saving || !accountId || needsType || needsOrigin || needsDescription || manualInvalid
            }
          >
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Leva a linha para outra unidade (ex.: despesa do Omie que veio na unidade errada). Só o financeiro. */
function MoveDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
  const { data: units } = useUnits();
  const { updateLine } = usePlanMutations();
  const [unitId, setUnitId] = useState<string | null>(line.unit_id);
  const [saving, setSaving] = useState(false);
  const name = (units ?? []).find((u) => u.id === unitId)?.name;

  async function save() {
    if (!unitId || unitId === line.unit_id) return;
    setSaving(true);
    const ok = await updateLine(line.id, { unit_id: unitId });
    setSaving(false);
    if (ok) {
      toast.success(`Linha levada para ${name}.`);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mudar de unidade</DialogTitle>
        </DialogHeader>
        <Field
          label="Unidade"
          hint="A linha sai desta unidade e passa a contar na escolhida, com os mesmos valores."
        >
          <OptionSelect
            value={unitId}
            onChange={setUnitId}
            options={(units ?? [])
              .filter((u) => u.active)
              .map((u) => ({ value: u.id, label: u.name }))}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !unitId || unitId === line.unit_id}>
            Mudar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FillDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
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

export function AdjustDialog({ line, onClose }: { line: PlanLine; onClose: () => void }) {
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
