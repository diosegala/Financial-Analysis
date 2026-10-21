import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, useAccounts, useProducts, useRevenueTypes } from "@/lib/catalog";
import {
  standardItems,
  summarizeEvent,
  useEventItems,
  useEventMutations,
  useEvents,
  type EventItem,
  type EventSummary,
  type PlanEvent,
} from "@/lib/events";
import { describePrice } from "@/lib/products";
import { MONTHS, fmtBRL, fmtPct } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export const Route = createFileRoute("/_authenticated/eventos")({
  head: pageHead(
    "Eventos",
    "Eventos e treinamentos com vários itens de receita e custo por categoria.",
  ),
  component: EventosPage,
});

const tone = (n: number) => (n < 0 ? "text-destructive" : "");

function EventosPage() {
  const { unit, version, versionId, unitId, canEdit: canAdd, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: events, isLoading } = useEvents(versionId, unitId);
  const { data: items } = useEventItems(versionId, unitId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rows = events ?? [];
  const selected = rows.find((e) => e.id === selectedId) ?? rows[0] ?? null;

  const itemsOf = (eventId: string) => (items ?? []).filter((i) => i.eventId === eventId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Eventos e treinamentos"
        subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"}${canAdd ? "" : ` · ${lockReason}`}`}
        actions={
          canAdd && (
            <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Novo evento
            </Button>
          )
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
          Nenhum evento planejado nesta unidade.
          {canAdd ? " Use “Novo evento” e depois adicione os itens de receita e de custo." : ""}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <ul className="space-y-1.5 self-start">
            {rows.map((e) => {
              const s = summarizeEvent(itemsOf(e.id));
              const active = e.id === selected?.id;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-primary bg-accent"
                        : "border-border bg-card hover:bg-accent/50"
                    }`}
                  >
                    <div className="font-medium">{e.name}</div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{MONTHS[e.month - 1]}</span>
                      <span className={`font-mono tabular-nums ${tone(s.resultado)}`}>
                        {fmtBRL(s.resultado)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <EventDetail
              event={selected}
              items={itemsOf(selected.id)}
              canManage={canAdd && !!user?.isFinanceiro}
              onDeleted={() => setSelectedId(null)}
            />
          )}
        </div>
      )}
      {creating && (
        <EventDialog event={null} onCreated={setSelectedId} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function EventDetail({
  event,
  items,
  canManage,
  onDeleted,
}: {
  event: PlanEvent;
  items: EventItem[];
  canManage: boolean;
  onDeleted: () => void;
}) {
  const { data: accounts } = useAccounts();
  const { data: types } = useRevenueTypes();
  const { data: products } = useProducts();
  const { deleteEvent } = useEventMutations();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const summary = summarizeEvent(items);
  const accountMap = byId(accounts);
  const typeMap = byId(types);
  const productName = event.product_id ? byId(products).get(event.product_id)?.name : null;

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{event.name}</h2>
          <p className="text-sm text-muted-foreground">
            {MONTHS[event.month - 1]}
            {productName ? ` · ${productName}` : ""}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" /> Editar evento
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="h-4 w-4" /> Excluir
            </Button>
          </div>
        )}
      </div>

      <ResultPanel
        summary={summary}
        originName={(id) => (id ? (typeMap.get(id)?.name ?? "—") : "Sem tipo")}
        categoryName={(id) => accountMap.get(id)?.name ?? "—"}
      />

      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Receitas do evento</h3>
        <p className="text-sm text-muted-foreground">
          Um item para cada lote de ingresso, cota ou valor de patrocínio, e para os itens
          adicionais vendidos depois. Cada um tem seus meses.
        </p>
        <PlanGrid
          kind="receita"
          event={event}
          emptyText="Nenhum item de receita. Adicione ingressos, patrocínios e outros itens."
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Custos do evento</h3>
        <p className="text-sm text-muted-foreground">
          Um item para cada custo; a categoria é a conta escolhida.
        </p>
        <PlanGrid
          kind="despesa"
          event={event}
          emptyText="Nenhum item de custo. Adicione os custos por categoria."
        />
      </section>

      {editing && (
        <EventDialog event={event} onCreated={() => {}} onClose={() => setEditing(false)} />
      )}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {event.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              O evento e todos os seus itens de receita e de custo serão excluídos. Isso fica
              registrado na auditoria.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if ((await deleteEvent(event.id)) !== false) onDeleted();
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResultPanel({
  summary,
  originName,
  categoryName,
}: {
  summary: EventSummary;
  originName: (id: string) => string;
  categoryName: (id: string) => string;
}) {
  const origins = [...summary.porOrigem.entries()].sort((a, b) => b[1] - a[1]);
  const categories = [...summary.porCategoria.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Receita", fmtBRL(summary.receita), ""],
          ["Custos", fmtBRL(summary.custo), ""],
          ["Resultado", fmtBRL(summary.resultado), tone(summary.resultado)],
          [
            "Margem",
            summary.margem === null ? "—" : fmtPct(summary.margem),
            tone(summary.resultado),
          ],
        ].map(([label, value, cls]) => (
          <div key={label} className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`font-mono text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
          </div>
        ))}
      </div>
      {(origins.length > 0 || categories.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          <BreakdownTable
            title="Receita por origem"
            rows={origins.map(([id, v]) => [originName(id), v])}
          />
          <BreakdownTable
            title="Custos por categoria"
            rows={categories.map(([id, v]) => [categoryName(id), v])}
          />
        </div>
      )}
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-sm font-medium">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">Nada lançado ainda.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([name, value]) => (
              <tr key={name} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5">{name}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmtBRL(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EventDialog({
  event,
  onCreated,
  onClose,
}: {
  event: PlanEvent | null;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const { versionId, unitId } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const { createEvent, updateEvent } = useEventMutations();
  const eventProducts = (products ?? []).filter(
    (p) =>
      p.kind === "evento" &&
      ((p.active && (!p.unit_id || p.unit_id === unitId)) || p.id === event?.product_id),
  );
  const allowed = (accounts ?? []).filter(
    (a) => a.active && (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  const revenueAccounts = allowed.filter((a) => a.kind === "receita");
  const costAccounts = allowed.filter((a) => a.kind === "despesa");

  const [productId, setProductId] = useState<string | null>(event?.product_id ?? null);
  const [name, setName] = useState(event?.name ?? "");
  const [month, setMonth] = useState<number | null>(event?.month ?? 1);
  const [useStandard, setUseStandard] = useState(true);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [revenueAccountId, setRevenueAccountId] = useState<string | null>(
    revenueAccounts[0]?.id ?? null,
  );
  const [costAccountId, setCostAccountId] = useState<string | null>(costAccounts[0]?.id ?? null);
  const [saving, setSaving] = useState(false);

  const product = eventProducts.find((p) => p.id === productId);
  const standard = !event && useStandard && product ? standardItems(product, fmtBRL) : [];
  const hasRevenue = standard.some((i) => i.kind === "receita");
  const hasCost = standard.some((i) => i.kind === "despesa");

  function pickProduct(id: string | null) {
    setProductId(id);
    const p = eventProducts.find((x) => x.id === id);
    if (!p) return;
    if (!name) setName(p.name);
    setTypeId(p.revenue_type_id);
    if (p.revenue_account_id) setRevenueAccountId(p.revenue_account_id);
    if (p.cost_account_id) setCostAccountId(p.cost_account_id);
  }

  const valid =
    name.trim() !== "" &&
    month !== null &&
    (!hasRevenue || (typeId && revenueAccountId)) &&
    (!hasCost || costAccountId);

  async function save() {
    if (!valid || !versionId || !unitId || month === null) return;
    setSaving(true);
    if (event) {
      const ok = await updateEvent(event.id, { name: name.trim(), product_id: productId, month });
      setSaving(false);
      if (ok !== false) onClose();
      return;
    }
    const id = await createEvent({
      versionId,
      unitId,
      productId,
      name: name.trim(),
      month,
      lines: standard.map((i) => ({
        account_id: (i.kind === "receita" ? revenueAccountId : costAccountId)!,
        description: i.description,
        revenue_type_id: i.kind === "receita" ? typeId : null,
        values: [{ month, amount: i.amount }],
      })),
    });
    setSaving(false);
    if (id !== false) {
      if (typeof id === "string") onCreated(id);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{event ? "Editar evento" : "Novo evento"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Produto">
            <OptionSelect
              value={productId}
              onChange={pickProduct}
              noneLabel="Sem produto"
              options={eventProducts.map((p) => ({
                value: p.id,
                label: `${p.name} — ${describePrice(p)}`,
              }))}
            />
          </Field>
          <Field label="Nome do evento">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Mês do evento"
            hint="Quando acontece. Os meses de cada receita e custo são dos itens."
          >
            <MonthSelect value={month} onChange={setMonth} />
          </Field>
          {!event && standard.length > 0 && (
            <label className="col-span-2 flex items-start gap-2 text-sm">
              <Checkbox
                checked={useStandard}
                onCheckedChange={(c) => setUseStandard(!!c)}
                className="mt-0.5"
              />
              <span>
                Criar os itens padrão do produto no mês do evento:{" "}
                {standard.map((i) => `${i.description} ${fmtBRL(i.amount)}`).join("; ")}.
              </span>
            </label>
          )}
          {hasRevenue && (
            <>
              <Field label="Tipo de receita dos ingressos">
                <OptionSelect
                  value={typeId}
                  onChange={setTypeId}
                  options={(revenueTypes ?? [])
                    .filter((t) => t.active)
                    .map((t) => ({ value: t.id, label: t.name }))}
                />
              </Field>
              <Field label="Categoria da receita">
                <OptionSelect
                  value={revenueAccountId}
                  onChange={setRevenueAccountId}
                  options={revenueAccounts.map((a) => ({ value: a.id, label: a.name }))}
                />
              </Field>
            </>
          )}
          {hasCost && (
            <Field label="Categoria dos custos">
              <OptionSelect
                value={costAccountId}
                onChange={setCostAccountId}
                options={costAccounts.map((a) => ({ value: a.id, label: a.name }))}
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
