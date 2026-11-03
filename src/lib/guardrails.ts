import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type GuardrailSettings = Tables<"guardrail_settings">;
export type GuardrailUnitRow = Tables<"guardrail_units">;
/** Os números de uma unidade no cenário: compromisso, custo-base, limite e o que já está lançado (valores do ano). */
export interface Guardrail {
  unitId: string;
  kind: string;
  floorSuggested: number | null;
  floor: number | null;
  variableRate: number;
  floorNet: number | null;
  baseExpense: number;
  basePayroll: number;
  expenseLimitAuto: number;
  payrollLimitAuto: number;
  expenseLimit: number;
  payrollLimit: number;
  ceiling: number;
  plannedRevenue: number;
  plannedVariable: number;
  plannedExpense: number;
  plannedPayroll: number;
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

/** Calculado no banco. O diretor recebe só a unidade dele, e só depois de publicado. */
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
        baseExpense: Number(r.base_expense ?? 0),
        basePayroll: Number(r.base_payroll ?? 0),
        expenseLimitAuto: Number(r.expense_limit_auto ?? 0),
        payrollLimitAuto: Number(r.payroll_limit_auto ?? 0),
        expenseLimit: Number(r.expense_limit ?? 0),
        payrollLimit: Number(r.payroll_limit ?? 0),
        ceiling: Number(r.ceiling ?? 0),
        plannedRevenue: Number(r.planned_revenue ?? 0),
        plannedVariable: Number(r.planned_variable ?? 0),
        plannedExpense: Number(r.planned_expense ?? 0),
        plannedPayroll: Number(r.planned_payroll ?? 0),
      }));
    },
  });
}

/** Custos lançados da unidade: despesas e folha. */
export const plannedCosts = (g: Guardrail) => g.plannedExpense + g.plannedPayroll;

/** Resultado da unidade com o que está lançado: receita menos impostos e comissões menos custos. */
export const plannedResult = (g: Guardrail) =>
  g.plannedRevenue - g.plannedVariable - plannedCosts(g);

/**
 * Resultado da empresa:
 * compromisso = cada unidade cumpre a receita-compromisso e gasta o limite (o apoio entra com a receita lançada);
 * lancado = o que está no plano agora.
 */
export function companyResults(rows: Guardrail[]) {
  let compromisso = 0;
  let lancado = 0;
  for (const r of rows) {
    lancado += plannedResult(r);
    const net = r.kind === "negocio" ? (r.floorNet ?? 0) : r.plannedRevenue - r.plannedVariable;
    compromisso += net - r.ceiling;
  }
  return { compromisso, lancado };
}

export interface ReferenceRow {
  account_id: string;
  kind: string;
  month: number;
  amount: number;
}

/** Realizado do ano base da unidade, por conta e mês: o que o diretor vê ao lado do plano. */
export function useUnitReference(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["unit_reference", versionId, unitId],
    enabled: !!versionId && !!unitId,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("unit_reference", {
        _version_id: versionId!,
        _unit_id: unitId!,
      });
      if (error) throw error;
      const byAccount = new Map<string, Map<number, number>>();
      for (const r of data ?? []) {
        const m = byAccount.get(r.account_id) ?? new Map<number, number>();
        m.set(r.month, Number(r.amount));
        byAccount.set(r.account_id, m);
      }
      return byAccount;
    },
  });
}

/** Fornecedores do ano base de uma categoria da unidade, só para consulta. */
export function useReferenceSuppliers(
  versionId: string | null,
  unitId: string | null,
  accountId: string | null,
) {
  return useQuery({
    queryKey: ["unit_reference_suppliers", versionId, unitId, accountId],
    enabled: !!versionId && !!unitId && !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("unit_reference_suppliers", {
        _version_id: versionId!,
        _unit_id: unitId!,
        _account_id: accountId!,
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({ supplier: r.supplier, amount: Number(r.amount) }));
    },
  });
}

export const SUPPORT_BASIS_LABELS: Record<string, string> = {
  criterio: "pelo critério digitado",
  receita: "pela receita planejada",
  compromisso: "pela receita-compromisso, até todas as unidades lançarem a receita",
  igual: "por igual, até o cálculo da receita-compromisso",
};

/** Parte de cada unidade de negócio no custo das áreas de apoio. O diretor recebe só a dele, depois de publicado. */
export function useSupportAllocation(scenarioId: string | null) {
  return useQuery({
    queryKey: ["target_vs_plan", "support", scenarioId],
    enabled: !!scenarioId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("support_allocation", {
        _scenario_id: scenarioId!,
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        unitId: r.unit_id,
        share: Number(r.share ?? 0),
        cost: Number(r.support_cost ?? 0),
        basis: r.basis,
      }));
    },
  });
}

/** Critérios digitados pelo financeiro (peso de cada unidade no apoio). */
export function useSupportShares(scenarioId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["target_vs_plan", "support_shares", scenarioId],
    enabled: !!scenarioId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("support_shares")
        .select("unit_id, share")
        .eq("scenario_id", scenarioId!);
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.unit_id, Number(r.share)]));
    },
  });
}

export function useGuardrailMutations(scenarioId: string | null) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["guardrails"] }),
      queryClient.invalidateQueries({ queryKey: ["target_vs_plan"] }),
      queryClient.invalidateQueries({ queryKey: ["plan_lines"] }),
      queryClient.invalidateQueries({ queryKey: ["dre"] }),
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
    /** Peso da unidade no apoio; vazio tira o critério dela. */
    async saveSupportShare(unitId: string, share: number | null) {
      const { error } = share
        ? await supabase
            .from("support_shares")
            .upsert(
              { scenario_id: scenarioId!, unit_id: unitId, share },
              { onConflict: "scenario_id,unit_id" },
            )
        : await supabase
            .from("support_shares")
            .delete()
            .eq("scenario_id", scenarioId!)
            .eq("unit_id", unitId);
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
      if (!error) toast.success("Ano base atualizado com o Omie.");
      return fail(error);
    },
    async publish(publish: boolean) {
      const { error } = await supabase.rpc("publish_guardrails", {
        _scenario_id: scenarioId!,
        _publish: publish,
      });
      await refresh();
      if (!error) toast.success(publish ? "Publicado para os diretores." : "Reaberto.");
      return fail(error);
    },
    /** Traz o ano base para o plano da unidade, só nas categorias sem lançamento. Devolve quantas entraram. */
    async loadReference(versionId: string, unitId: string, accountId?: string) {
      const { data, error } = await supabase.rpc("load_reference", {
        _version_id: versionId,
        _unit_id: unitId,
        ...(accountId ? { _account_id: accountId } : {}),
      });
      await refresh();
      if (error) {
        toast.error(friendlyError(error.message));
        return null;
      }
      return data;
    },
  };
}
