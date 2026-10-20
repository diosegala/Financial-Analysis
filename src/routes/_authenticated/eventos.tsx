import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, friendlyError, useAccounts, useProducts, useRevenueTypes } from "@/lib/catalog";
import { MONTHS, fmtBRL, fmtInput, parseNum } from "@/lib/format";
import { describePrice, inputOf } from "@/lib/products";
import { PageHeader } from "@/components/page-header";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/_authenticated/eventos")({
  head: pageHead(
    "Eventos",
    "Eventos e treinamentos: vagas, preço e custos geram receita e despesa de produto.",
  ),
  component: EventosPage,
});

type Event = Tables<"events">;

const revenueOf = (e: Event) => Number(e.quantity) * Number(e.price);
const costOf = (e: Event) =>
  Number(e.quantity) * Number(e.cost_per_participant) + Number(e.fixed_cost);

function useEvents(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["events", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("events")
        .select("*")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .order("month")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

function EventosPage() {
  const { unit, version, versionId, unitId, canEdit: canAdd, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  // Alterar ou excluir um evento já lançado é só do financeiro; o líder lança eventos novos.
  const canEditRows = canAdd && !!user?.isFinanceiro;
  const { data: events, isLoading } = useEvents(versionId, unitId);
  const { data: products } = useProducts();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Event | null | "new">(null);
  const productMap = byId(products);
  const rows = events ?? [];

  async function remove(id: string) {
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["events"] });
    await queryClient.invalidateQueries({ queryKey: ["dre"] });
  }

  const totals = rows.reduce(
    (a, e) => ({ revenue: a.revenue + revenueOf(e), cost: a.cost + costOf(e) }),
    { revenue: 0, cost: 0 },
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Eventos e treinamentos"
        subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"}${
          canEditRows
            ? ""
            : canAdd
              ? " · Você adiciona eventos novos; para corrigir ou excluir, peça ao financeiro."
              : ` · ${lockReason}`
        }`}
        actions={
          canAdd && (
            <Button size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> Adicionar evento
            </Button>
          )
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Evento</th>
                <th className="px-3 py-2 font-medium">Mês</th>
                <th className="px-3 py-2 text-right font-medium">Vagas</th>
                <th className="px-3 py-2 text-right font-medium">Preço</th>
                <th className="px-3 py-2 text-right font-medium">Receita</th>
                <th className="px-3 py-2 text-right font-medium">Custo/participante</th>
                <th className="px-3 py-2 text-right font-medium">Custo fixo</th>
                <th className="px-3 py-2 text-right font-medium">Despesa de produto</th>
                <th className="px-3 py-2 text-right font-medium">Margem</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const margin = revenueOf(e) - costOf(e);
                return (
                  <tr key={e.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{e.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {e.product_id ? productMap.get(e.product_id)?.name : "Sem produto"}
                      </div>
                    </td>
                    <td className="px-3 py-1.5">{MONTHS[e.month - 1]}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtInput(Number(e.quantity))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(Number(e.price))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(revenueOf(e))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(Number(e.cost_per_participant))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(Number(e.fixed_cost))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(costOf(e))}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono tabular-nums ${margin < 0 ? "text-destructive" : ""}`}
                    >
                      {fmtBRL(margin)}
                    </td>
                    <td className="px-1">
                      {canEditRows && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label="Ações"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditing(e)}>
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => remove(e.id)}
                            >
                              Excluir
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
                  <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhum evento planejado nesta unidade.
                  </td>
                </tr>
              ) : (
                <tr className="border-t border-border bg-muted/30 font-semibold">
                  <td className="px-3 py-1.5" colSpan={4}>
                    Total
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(totals.revenue)}
                  </td>
                  <td colSpan={2} />
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(totals.cost)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(totals.revenue - totals.cost)}
                  </td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EventDialog
          event={editing === "new" ? null : editing}
          last={rows.at(-1)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EventDialog({
  event,
  last,
  onClose,
}: {
  event: Event | null;
  last?: Event | undefined;
  onClose: () => void;
}) {
  const { versionId, unitId } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: products } = useProducts();
  const { data: revenueTypes } = useRevenueTypes();
  const queryClient = useQueryClient();
  const allowed = (accounts ?? []).filter(
    (a) => a.active && (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  const revenueAccounts = allowed.filter((a) => a.kind === "receita");
  const costAccounts = allowed.filter((a) => a.kind === "despesa");
  const source = event ?? last;
  const eventProducts = (products ?? []).filter(
    (p) =>
      p.kind === "evento" &&
      ((p.active && (!p.unit_id || p.unit_id === unitId)) || p.id === event?.product_id),
  );

  const [name, setName] = useState(event?.name ?? "");
  const [productId, setProductId] = useState<string | null>(event?.product_id ?? null);
  const [revenueTypeId, setRevenueTypeId] = useState<string | null>(
    source?.revenue_type_id ?? null,
  );
  const [month, setMonth] = useState<number | null>(event?.month ?? 1);
  const [quantity, setQuantity] = useState(event ? fmtInput(Number(event.quantity)) : "");
  const [price, setPrice] = useState(event ? fmtInput(Number(event.price)) : "");
  const [cpp, setCpp] = useState(event ? fmtInput(Number(event.cost_per_participant)) : "");
  const [fixed, setFixed] = useState(event ? fmtInput(Number(event.fixed_cost)) : "");
  const [revenueAccountId, setRevenueAccountId] = useState<string | null>(
    source?.revenue_account_id ?? revenueAccounts[0]?.id ?? null,
  );
  const [costAccountId, setCostAccountId] = useState<string | null>(
    source?.cost_account_id ?? costAccounts[0]?.id ?? null,
  );

  const nums = [quantity, price, cpp, fixed].map((s) => (s.trim() === "" ? 0 : parseNum(s)));
  const valid =
    name.trim() !== "" &&
    month &&
    revenueTypeId &&
    revenueAccountId &&
    costAccountId &&
    nums.every((n) => n !== null && n >= 0);

  function pickProduct(id: string | null) {
    setProductId(id);
    const p = eventProducts.find((x) => x.id === id);
    if (!p) return;
    // Tudo o que o produto traz é preenchido; o mês e o que ficou em branco continuam com você.
    setName(p.name);
    if (p.revenue_type_id) setRevenueTypeId(p.revenue_type_id);
    if (p.price !== null) setPrice(inputOf(p.price));
    if (p.default_seats !== null) setQuantity(inputOf(p.default_seats));
    if (p.cost_per_participant !== null) setCpp(inputOf(p.cost_per_participant));
    if (p.fixed_cost !== null) setFixed(inputOf(p.fixed_cost));
    if (p.revenue_account_id) setRevenueAccountId(p.revenue_account_id);
    if (p.cost_account_id) setCostAccountId(p.cost_account_id);
  }

  async function save() {
    if (!valid) return;
    const [q, pr, c, f] = nums as number[];
    const row = {
      name: name.trim(),
      product_id: productId,
      revenue_type_id: revenueTypeId!,
      month: month!,
      quantity: q!,
      price: pr!,
      cost_per_participant: c!,
      fixed_cost: f!,
      revenue_account_id: revenueAccountId!,
      cost_account_id: costAccountId!,
    };
    // Criar passa pela função do banco (o líder só lança eventos novos); editar é só do financeiro.
    const { error } = event
      ? await supabase.from("events").update(row).eq("id", event.id)
      : await supabase.rpc("launch_event", {
          _version_id: versionId!,
          _unit_id: unitId!,
          _product_id: row.product_id as string,
          _revenue_type_id: row.revenue_type_id,
          _name: row.name,
          _month: row.month,
          _quantity: row.quantity,
          _price: row.price,
          _cost_per_participant: row.cost_per_participant,
          _fixed_cost: row.fixed_cost,
          _revenue_account_id: row.revenue_account_id,
          _cost_account_id: row.cost_account_id,
        });
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["events"] });
    await queryClient.invalidateQueries({ queryKey: ["dre"] });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
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
          <Field label="Mês">
            <MonthSelect value={month} onChange={setMonth} />
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
          <Field label="Vagas">
            <Input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Preço por participante">
            <Input value={price} onChange={(e) => setPrice(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Custo por participante">
            <Input value={cpp} onChange={(e) => setCpp(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Custo fixo do evento">
            <Input value={fixed} onChange={(e) => setFixed(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Conta da receita">
            <OptionSelect
              value={revenueAccountId}
              onChange={setRevenueAccountId}
              options={revenueAccounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field label="Conta da despesa">
            <OptionSelect
              value={costAccountId}
              onChange={setCostAccountId}
              options={costAccounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
