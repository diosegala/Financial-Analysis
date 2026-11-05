import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/catalog";
import { fmtBRL, parseNum } from "@/lib/format";
import { Field, MonthSelect } from "@/components/form-fields";
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

const LEFT_OUT: Record<string, string> = {
  ja_reajustado: "já mudou de valor neste mês",
  unidade_enviada: "unidade enviada ou aprovada",
};

/** Reajuste da folha de todas as unidades. Mostra quem entra e quem fica de fora antes de aplicar. */
export function BulkAdjustDialog({
  versionId,
  onClose,
}: {
  versionId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pct, setPct] = useState("");
  const [from, setFrom] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const value = parseNum(pct);
  const valid = value !== null && value > 0 && from !== null;
  const args = {
    _version_id: versionId,
    _from_month: from ?? 0,
    _pct: (value ?? 0) / 100,
  };
  const { data: rows, error } = useQuery({
    queryKey: ["payroll_bulk_adjust", args],
    enabled: valid,
    gcTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("payroll_bulk_adjust", args);
      if (error) throw error;
      return data ?? [];
    },
  });
  const included = (rows ?? []).filter((r) => r.situation === "reajusta");
  const leftOut = (rows ?? []).filter((r) => LEFT_OUT[r.situation]);
  const units = new Map<string, { people: number; increase: number }>();
  for (const r of included) {
    const u = units.get(r.unit_name) ?? { people: 0, increase: 0 };
    u.people += 1;
    u.increase += Number(r.amount_after) - Number(r.amount_before);
    units.set(r.unit_name, u);
  }
  const increase = [...units.values()].reduce((a, u) => a + u.increase, 0);

  async function apply() {
    setSaving(true);
    const { error } = await supabase.rpc("payroll_bulk_adjust", { ...args, _apply: true });
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    await Promise.all(
      ["people", "plan_lines", "dre", "payroll_detail", "target_vs_plan", "guardrails"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
    toast.success(
      `Reajuste aplicado em ${included.length} pessoas. O limite de folha já considera.`,
    );
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Reajuste em lote</DialogTitle>
          <DialogDescription>
            Vale para todas as pessoas de todas as unidades. Encargos, 13º e férias acompanham o
            novo valor, e o limite de folha sobe junto. Exceções se acertam depois, na pessoa.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reajuste (%)">
            <Input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              placeholder="ex.: 6"
              className="font-mono"
            />
          </Field>
          <Field label="A partir de">
            <MonthSelect value={from} onChange={setFrom} />
          </Field>
        </div>
        {from === 1 && (
          <p className="text-xs text-muted-foreground">
            Em janeiro não há mês anterior para comparar: o app não identifica quem já foi
            reajustado. Aplique só uma vez.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{friendlyError(error.message)}</p>}
        {valid && rows && (
          <div className="space-y-3 text-sm">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 font-medium">Unidade</th>
                  <th className="py-1 text-right font-medium">Pessoas</th>
                  <th className="py-1 text-right font-medium">Aumento por mês (sem encargos)</th>
                </tr>
              </thead>
              <tbody>
                {[...units].map(([name, u]) => (
                  <tr key={name} className="border-b border-border/50">
                    <td className="py-1">{name}</td>
                    <td className="py-1 text-right tabular-nums">{u.people}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{fmtBRL(u.increase)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1">Total</td>
                  <td className="py-1 text-right tabular-nums">{included.length}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{fmtBRL(increase)}</td>
                </tr>
              </tbody>
            </table>
            {leftOut.length > 0 && (
              <div>
                <p className="font-medium">Ficam de fora ({leftOut.length})</p>
                <ul className="text-muted-foreground">
                  {leftOut.map((r) => (
                    <li key={`${r.unit_name}-${r.person_name}`}>
                      {r.person_name} ({r.unit_name}): {LEFT_OUT[r.situation]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void apply()} disabled={!valid || saving || !included.length}>
            {included.length
              ? `Reajustar ${included.length} ${included.length === 1 ? "pessoa" : "pessoas"}`
              : "Reajustar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
