import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type AccountKind = "receita" | "despesa" | "folha";

export type PlanLine = Tables<"plan_lines"> & {
  /** month (1–12) → amount */
  values: Map<number, number>;
};

export function usePlanLines(versionId: string | null, unitId: string | null, kind: AccountKind) {
  return useQuery({
    queryKey: ["plan_lines", versionId, unitId, kind],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<PlanLine[]> => {
      const { data, error } = await supabase
        .from("plan_lines")
        .select("*, plan_values(month, amount), accounts!inner(kind)")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .eq("accounts.kind", kind)
        .order("sort_order")
        .order("created_at");
      if (error) throw error;
      return (data ?? []).map(({ plan_values, accounts: _account, ...line }) => ({
        ...line,
        values: new Map(plan_values.map((v) => [v.month, Number(v.amount)])),
      }));
    },
  });
}

export function usePlanMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["plan_lines"] }),
      queryClient.invalidateQueries({ queryKey: ["dre"] }),
    ]);

  function fail(error: { message: string } | null) {
    if (!error) return false;
    toast.error(friendlyError(error.message));
    return true;
  }

  /** Upserts month values; amount 0 is stored as 0 (keeps the cell explicit). */
  async function setValues(lineId: string, values: { month: number; amount: number }[]) {
    if (values.length === 0) return true;
    const { error } = await supabase.from("plan_values").upsert(
      values.map((v) => ({ line_id: lineId, ...v })),
      { onConflict: "line_id,month" },
    );
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  async function addLine(
    line: TablesInsert<"plan_lines">,
    values: { month: number; amount: number }[] = [],
  ) {
    const { data, error } = await supabase.from("plan_lines").insert(line).select("id").single();
    if (fail(error) || !data) return null;
    if (values.length > 0) await setValues(data.id, values);
    else await refresh();
    return data.id;
  }

  async function updateLine(id: string, patch: TablesUpdate<"plan_lines">) {
    const { error } = await supabase.from("plan_lines").update(patch).eq("id", id);
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  async function deleteLine(id: string) {
    const { error } = await supabase.from("plan_lines").delete().eq("id", id);
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  return { setValues, addLine, updateLine, deleteLine };
}

/** Months [start, start + count) clipped to December. */
export function monthRange(start: number, count: number): number[] {
  return Array.from({ length: Math.max(0, Math.min(count, 13 - start)) }, (_, i) => start + i);
}

/** Applies a % adjustment from a month on: every month >= from gets amount × (1 + pct). */
export function adjustFrom(values: Map<number, number>, from: number, pct: number) {
  return [...values.entries()]
    .filter(([m]) => m >= from)
    .map(([month, amount]) => ({ month, amount: Math.round(amount * (1 + pct) * 100) / 100 }));
}
