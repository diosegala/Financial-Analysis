import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "./catalog";

export interface ExpenseBaseSummary {
  lines: number;
  total: number;
  byUnit: Map<string, number>;
}

/** Linhas da base gerada a partir do realizado do Omie (origin = gerada), somadas por unidade. */
export function useExpenseBase(versionId: string | null) {
  return useQuery({
    queryKey: ["expense_base", versionId],
    enabled: !!versionId,
    queryFn: async (): Promise<ExpenseBaseSummary> => {
      // Em páginas de 1.000 (limite do Supabase por consulta): a base por fornecedor passa de mil linhas.
      const data: { unit_id: string; plan_values: { amount: number }[] }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .from("plan_lines")
          .select("id, unit_id, plan_values(amount)")
          .eq("version_id", versionId!)
          .eq("origin", "gerada")
          .order("id")
          .range(from, from + 999);
        if (error) throw error;
        data.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      const byUnit = new Map<string, number>();
      let total = 0;
      for (const l of data) {
        const sum = l.plan_values.reduce((a, v) => a + Number(v.amount), 0);
        byUnit.set(l.unit_id, (byUnit.get(l.unit_id) ?? 0) + sum);
        total += sum;
      }
      return { lines: data.length, total, byUnit };
    },
  });
}

export function useExpenseBaseMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      ["expense_base", "plan_lines", "dre", "targets", "target_vs_plan"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
  return {
    /** Gera (ou refaz) a base: troca só as linhas geradas da versão. */
    generate: async (versionId: string, pct: number, mode: "mes_a_mes" | "media") => {
      const { data, error } = await supabase.rpc("generate_expense_base", {
        _version_id: versionId,
        _pct: pct,
        _mode: mode,
      });
      if (error) {
        toast.error(friendlyError(error.message));
        return null;
      }
      await refresh();
      const r = data?.[0];
      return r ? { lines: r.lines, total: Number(r.total) } : null;
    },
    /** Reajuste geral sobre as linhas geradas, mantendo as edições feitas linha a linha. */
    adjust: async (versionId: string, pct: number) => {
      const { error } = await supabase.rpc("adjust_generated_lines", {
        _version_id: versionId,
        _pct: pct,
      });
      if (error) {
        toast.error(friendlyError(error.message));
        return false;
      }
      await refresh();
      return true;
    },
  };
}
