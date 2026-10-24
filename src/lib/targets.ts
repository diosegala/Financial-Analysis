import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type ScenarioTarget = Tables<"scenario_targets">;
export type TargetShare = Tables<"target_unit_shares">;
export type TargetWeight = Tables<"target_month_weights">;
export type RevenueTarget = Tables<"revenue_targets">;

export function useScenarioTarget(scenarioId: string | null) {
  return useQuery({
    queryKey: ["targets", "scenario", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<ScenarioTarget | null> => {
      const { data, error } = await supabase
        .from("scenario_targets")
        .select("*")
        .eq("scenario_id", scenarioId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useTargetShares(scenarioId: string | null) {
  return useQuery({
    queryKey: ["targets", "shares", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<TargetShare[]> => {
      const { data, error } = await supabase
        .from("target_unit_shares")
        .select("*")
        .eq("scenario_id", scenarioId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useTargetWeights(scenarioId: string | null) {
  return useQuery({
    queryKey: ["targets", "weights", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<TargetWeight[]> => {
      const { data, error } = await supabase
        .from("target_month_weights")
        .select("*")
        .eq("scenario_id", scenarioId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Meta calculada por unidade e mês. O financeiro vê sempre; o líder, só depois de publicada. */
export function useRevenueTargets(scenarioId: string | null) {
  return useQuery({
    queryKey: ["targets", "revenue", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<RevenueTarget[]> => {
      const { data, error } = await supabase
        .from("revenue_targets")
        .select("*")
        .eq("scenario_id", scenarioId!);
      if (error) throw error;
      return (data ?? []).map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });
}

export function useTargetGap(scenarioId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["targets", "gap", scenarioId],
    enabled: !!scenarioId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("target_gap", { _scenario_id: scenarioId! });
      if (error) throw error;
      const r = data?.[0];
      return r
        ? {
            revenue: Number(r.revenue),
            variable_costs: Number(r.variable_costs),
            payroll: Number(r.payroll),
            expenses: Number(r.expenses),
            result: Number(r.result),
            target_amount: Number(r.target_amount),
            gap: Number(r.gap),
          }
        : null;
    },
  });
}

/** Regras de receita que formam a alíquota variável da unidade, com a taxa de cada uma em junho. */
export function useVariableParts(unitIds: string[], year: number | undefined) {
  return useQuery({
    queryKey: ["targets", "rate_parts", unitIds.join(","), year],
    enabled: unitIds.length > 0 && !!year,
    queryFn: async () => {
      const out = new Map<string, { rule_name: string; rate: number; included: boolean }[]>();
      for (const unitId of unitIds) {
        const { data, error } = await supabase.rpc("variable_rate_parts", {
          _unit_id: unitId,
          _ref: `${year}-06-01`,
        });
        if (error) throw error;
        out.set(
          unitId,
          (data ?? []).map((p) => ({
            rule_name: p.rule_name,
            rate: Number(p.rate),
            included: p.included,
          })),
        );
      }
      return out;
    },
  });
}

export function useTargetMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["targets"] }),
      queryClient.invalidateQueries({ queryKey: ["target_vs_plan"] }),
    ]);
  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await refresh();
    return true;
  }
  return {
    saveTarget: (
      scenarioId: string,
      v: {
        target_kind: "resultado" | "margem";
        target_value: number;
        financial_variable_pct: number;
      },
    ) =>
      run(
        supabase
          .from("scenario_targets")
          .upsert({ scenario_id: scenarioId, ...v }, { onConflict: "scenario_id" }),
      ),
    saveShares: async (
      scenarioId: string,
      rows: { unit_id: string; share: number; variable_pct_override: number | null }[],
    ) => {
      const keep = rows.map((r) => r.unit_id);
      const del = supabase.from("target_unit_shares").delete().eq("scenario_id", scenarioId);
      const ok = await run(keep.length ? del.not("unit_id", "in", `(${keep.join(",")})`) : del);
      if (!ok) return false;
      if (rows.length === 0) return true;
      return run(
        supabase.from("target_unit_shares").upsert(
          rows.map((r) => ({ scenario_id: scenarioId, ...r })),
          { onConflict: "scenario_id,unit_id" },
        ),
      );
    },
    /** Substitui os pesos do cenário: só entram os meses preenchidos. unit_id nulo = padrão. */
    saveWeights: async (
      scenarioId: string,
      rows: { unit_id: string | null; month: number; weight: number }[],
    ) => {
      if (
        !(await run(supabase.from("target_month_weights").delete().eq("scenario_id", scenarioId)))
      )
        return false;
      if (rows.length === 0) return true;
      return run(
        supabase
          .from("target_month_weights")
          .insert(rows.map((r) => ({ scenario_id: scenarioId, ...r }))),
      );
    },
    compute: async (scenarioId: string) => {
      const { error } = await supabase.rpc("compute_targets", { _scenario_id: scenarioId });
      if (error) {
        toast.error(friendlyError(error.message));
        return false;
      }
      await refresh();
      return true;
    },
    publish: async (scenarioId: string, publish: boolean) => {
      const { error } = await supabase.rpc("publish_targets", {
        _scenario_id: scenarioId,
        _publish: publish,
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
