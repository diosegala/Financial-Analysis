import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type GuardrailSettings = Tables<"guardrail_settings">;
export type GuardrailUnitRow = Tables<"guardrail_units">;
export type Distribution = "piso" | "margem" | "manual";

export const DISTRIBUTION_LABELS: Record<Distribution, string> = {
  piso: "Pelo piso de receita (quem vende mais contribui mais)",
  margem: "Pela margem (piso líquido − despesa lançada)",
  manual: "Manual (% por unidade)",
};

/** Contrato de uma unidade no cenário: piso, contribuição e teto, mais o que já está lançado (valores do ano). */
export interface Guardrail {
  unitId: string;
  kind: string;
  floorSuggested: number | null;
  floor: number | null;
  variableRate: number;
  floorNet: number | null;
  share: number | null;
  contribution: number | null;
  ceilingSuggested: number | null;
  ceiling: number;
  plannedRevenue: number;
  plannedVariable: number;
  /** Despesa lançada sem as condicionadas (é a que conta na trava). */
  plannedExpense: number;
  conditionalExpense: number;
}

const num = (v: number | null) => (v === null ? null : Number(v));

export function useGuardrailSettings(scenarioId: string | null) {
  return useQuery({
    queryKey: ["guardrails", "settings", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<GuardrailSettings | null> => {
      const { data, error } = await supabase
        .from("guardrail_settings")
        .select("*")
        .eq("scenario_id", scenarioId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useGuardrailUnits(scenarioId: string | null) {
  return useQuery({
    queryKey: ["guardrails", "units", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<GuardrailUnitRow[]> => {
      const { data, error } = await supabase
        .from("guardrail_units")
        .select("*")
        .eq("scenario_id", scenarioId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** O contrato calculado no banco. O líder recebe só as unidades dele, e só depois de publicado. */
export function useGuardrails(scenarioId: string | null) {
  return useQuery({
    // Debaixo de "target_vs_plan": lançar receita ou despesa atualiza o placar junto.
    queryKey: ["target_vs_plan", "guardrails", scenarioId],
    enabled: !!scenarioId,
    queryFn: async (): Promise<Guardrail[]> => {
      const { data, error } = await supabase.rpc("guardrails", { _scenario_id: scenarioId! });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        unitId: r.unit_id,
        kind: r.kind,
        floorSuggested: num(r.floor_suggested),
        floor: num(r.floor_amount),
        variableRate: Number(r.variable_rate ?? 0),
        floorNet: num(r.floor_net),
        share: num(r.share),
        contribution: num(r.contribution),
        ceilingSuggested: num(r.ceiling_suggested),
        ceiling: Number(r.ceiling ?? 0),
        plannedRevenue: Number(r.planned_revenue ?? 0),
        plannedVariable: Number(r.planned_variable ?? 0),
        plannedExpense: Number(r.planned_expense ?? 0),
        conditionalExpense: Number(r.conditional_expense ?? 0),
      }));
    },
  });
}

/**
 * Resultado da empresa em dois cenários:
 * trava = piso líquido das unidades − despesa sem condicionadas (inclui o apoio) + receita líquida do apoio;
 * plano = tudo o que foi lançado (receita planejada, todas as despesas, inclusive condicionadas).
 */
export function scenarioResults(rows: Guardrail[]) {
  let trava = 0;
  let plano = 0;
  for (const r of rows) {
    const net = r.plannedRevenue - r.plannedVariable;
    plano += net - r.plannedExpense - r.conditionalExpense;
    trava += (r.kind === "negocio" ? (r.floorNet ?? 0) : net) - r.plannedExpense;
  }
  return { trava, plano };
}

export function useGuardrailMutations(scenarioId: string | null) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["guardrails"] }),
      queryClient.invalidateQueries({ queryKey: ["target_vs_plan"] }),
    ]);
  const fail = (e: { message: string } | null) => {
    if (e) toast.error(friendlyError(e.message));
    return !e;
  };
  return {
    async saveSettings(patch: Partial<GuardrailSettings>) {
      const { error } = await supabase
        .from("guardrail_settings")
        .upsert({ scenario_id: scenarioId!, ...patch }, { onConflict: "scenario_id" });
      await refresh();
      return fail(error);
    },
    async saveUnit(unitId: string, patch: Partial<GuardrailUnitRow>) {
      const { error } = await supabase
        .from("guardrail_units")
        .upsert(
          { scenario_id: scenarioId!, unit_id: unitId, ...patch },
          { onConflict: "scenario_id,unit_id" },
        );
      await refresh();
      return fail(error);
    },
    async suggest() {
      const { error } = await supabase.rpc("guardrails_suggest", { _scenario_id: scenarioId! });
      await refresh();
      if (!error) toast.success("Realizado do Omie atualizado no piso sugerido.");
      return fail(error);
    },
    async publish(publish: boolean) {
      const { error } = await supabase.rpc("publish_guardrails", {
        _scenario_id: scenarioId!,
        _publish: publish,
      });
      await refresh();
      if (!error) toast.success(publish ? "Piso e teto publicados para os líderes." : "Reaberto.");
      return fail(error);
    },
  };
}
