import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/catalog";
import { BASIS_LABELS, type Board, type BoardUnit } from "@/lib/board";
import { fmtBRL, fmtPct, parseNum } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);
const ratio = (a: number, b: number) => (b ? a / b : 0);

function totals(u: BoardUnit) {
  const target = sum(u.target);
  const revenue = sum(u.revenue);
  const result = sum(u.result);
  const support = sum(u.support);
  return {
    target,
    revenue,
    missing: Math.max(target - revenue, 0),
    recurringPct: ratio(sum(u.recurring), revenue),
    result,
    support,
    after: result + support,
  };
}

const money = (v: number, signed = false) => (
  <span className={`font-mono tabular-nums ${signed && v < 0 ? "text-destructive" : ""}`}>
    {fmtBRL(v)}
  </span>
);

/** Cartões por unidade de negócio: meta, planejado, falta, % recorrente e resultado com e sem o apoio. */
export function BoardCards({ board }: { board: Board }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {board.units.map((u) => {
        const t = totals(u);
        return (
          <Card key={u.unit.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{u.unit.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <Row label="Meta de receita">{t.target ? money(t.target) : "—"}</Row>
              <Row label="Planejado">
                {money(t.revenue)}
                {t.target > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmtPct(ratio(t.revenue, t.target))})
                  </span>
                )}
              </Row>
              <Row label="Falta para a meta">{t.target ? money(t.missing) : "—"}</Row>
              <Row label="Receita recorrente">{t.revenue ? fmtPct(t.recurringPct) : "—"}</Row>
              <div className="my-1 border-t border-border" />
              <Row label="Resultado da unidade">{money(t.result, true)}</Row>
              <Row label={`Apoio rateado (${fmtPct(u.share)})`}>{money(t.support, true)}</Row>
              <Row label="Resultado após apoio" strong>
                {money(t.after, true)}
              </Row>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Row({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-2 ${strong ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/** Tabela das unidades lado a lado, com ou sem o rateio das áreas de apoio. Fecha com o total da empresa. */
export function BoardTable({ board, allocated }: { board: Board; allocated: boolean }) {
  const rows = board.units.map((u) => ({ u, t: totals(u) }));
  const total = rows.reduce(
    (a, { t }) => ({
      target: a.target + t.target,
      revenue: a.revenue + t.revenue,
      recurring: a.recurring + t.recurringPct * t.revenue,
      result: a.result + t.result,
      support: a.support + t.support,
    }),
    { target: 0, revenue: 0, recurring: 0, result: 0, support: 0 },
  );
  const supportTotal = sum(board.supportResult);
  const companyResult = total.result + supportTotal;
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-1.5 text-right";

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="px-3 py-2 font-medium">Unidade</th>
              <th className={th}>Meta</th>
              <th className={th}>Receita planejada</th>
              <th className={th}>% da meta</th>
              <th className={th}>% recorrente</th>
              <th className={th}>Resultado da unidade</th>
              {allocated && (
                <>
                  <th className={th}>Apoio rateado</th>
                  <th className={th}>Resultado após apoio</th>
                </>
              )}
              <th className={th}>Margem</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ u, t }) => {
              const shown = allocated ? t.after : t.result;
              return (
                <tr key={u.unit.id} className="border-b border-border">
                  <td className="px-3 py-1.5">{u.unit.name}</td>
                  <td className={td}>{t.target ? money(t.target) : "—"}</td>
                  <td className={td}>{money(t.revenue)}</td>
                  <td className={td}>{t.target ? fmtPct(ratio(t.revenue, t.target)) : "—"}</td>
                  <td className={td}>{t.revenue ? fmtPct(t.recurringPct) : "—"}</td>
                  <td className={td}>{money(t.result, true)}</td>
                  {allocated && (
                    <>
                      <td className={td}>
                        {money(t.support, true)}
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({fmtPct(u.share)})
                        </span>
                      </td>
                      <td className={`${td} font-semibold`}>{money(t.after, true)}</td>
                    </>
                  )}
                  <td className={td}>{t.revenue ? fmtPct(ratio(shown, t.revenue)) : "—"}</td>
                </tr>
              );
            })}
            {!allocated && (
              <tr className="border-b border-border text-muted-foreground">
                <td className="px-3 py-1.5">Áreas de apoio</td>
                <td className={td} colSpan={4} />
                <td className={td}>{money(supportTotal, true)}</td>
                <td className={td} />
              </tr>
            )}
            <tr className="bg-muted/30 font-semibold">
              <td className="px-3 py-1.5">Empresa</td>
              <td className={td}>{total.target ? money(total.target) : "—"}</td>
              <td className={td}>{money(total.revenue)}</td>
              <td className={td}>
                {total.target ? fmtPct(ratio(total.revenue, total.target)) : "—"}
              </td>
              <td className={td}>
                {total.revenue ? fmtPct(ratio(total.recurring, total.revenue)) : "—"}
              </td>
              <td className={td}>{money(allocated ? total.result : companyResult, true)}</td>
              {allocated && (
                <>
                  <td className={td}>{money(total.support, true)}</td>
                  <td className={td}>{money(companyResult, true)}</td>
                </>
              )}
              <td className={td}>
                {total.revenue ? fmtPct(ratio(companyResult, total.revenue)) : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Resultado = último subtotal da DRE. O resultado das áreas de apoio é dividido conforme{" "}
        {BASIS_LABELS[board.basis]}. Recorrente = tipo de receita ou linha de produto recorrente, ou
        origem carteira/renovação.
      </p>
    </div>
  );
}

/** O financeiro define quanto do apoio cada unidade recebe. Sem critério = participação na meta. */
export function SupportSharesDialog({
  open,
  onOpenChange,
  scenarioId,
  board,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scenarioId: string;
  board: Board;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open)
      setValues(
        Object.fromEntries(
          board.units.map((u) => [u.unit.id, (u.share * 100).toFixed(1).replace(".", ",")]),
        ),
      );
  }, [open, board]);
  const parsed = board.units.map((u) => parseNum(values[u.unit.id] ?? "") ?? NaN);
  const total = parsed.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  const valid = parsed.every((v) => Number.isFinite(v) && v >= 0) && Math.abs(total - 100) < 0.05;

  const run = async (rows: { unit_id: string; share: number }[]) => {
    setSaving(true);
    try {
      const del = await supabase.from("support_shares").delete().eq("scenario_id", scenarioId);
      if (del.error) throw del.error;
      if (rows.length) {
        const ins = await supabase
          .from("support_shares")
          .insert(rows.map((r) => ({ ...r, scenario_id: scenarioId })));
        if (ins.error) throw ins.error;
      }
      await queryClient.invalidateQueries({ queryKey: ["dre"] });
      toast.success("Critério do rateio salvo.");
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Critério do rateio das áreas de apoio</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Quanto do resultado das áreas de apoio cada unidade de negócio recebe neste cenário. Hoje:{" "}
          {BASIS_LABELS[board.basis]}.
        </p>
        <div className="space-y-2">
          {board.units.map((u) => (
            <label key={u.unit.id} className="flex items-center justify-between gap-3 text-sm">
              {u.unit.name}
              <span className="flex items-center gap-1">
                <Input
                  className="w-24 text-right"
                  value={values[u.unit.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [u.unit.id]: e.target.value }))}
                />
                %
              </span>
            </label>
          ))}
          <p
            className={`text-right text-xs ${valid ? "text-muted-foreground" : "text-destructive"}`}
          >
            Soma: {total.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% (precisa dar 100%)
          </p>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => run([])}
            title="Apaga o critério: vale a participação na meta (ou, sem meta, a receita planejada)"
          >
            Voltar ao automático
          </Button>
          <Button
            disabled={saving || !valid}
            onClick={() =>
              run(
                board.units.map((u, i) => ({ unit_id: u.unit.id, share: (parsed[i] ?? 0) / 100 })),
              )
            }
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
