import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "./catalog";

export interface CompareCell {
  planned: number;
  actual: number;
  forecast: number;
}
/** dre_line_id → mês (0 = ano) → previsto, realizado e previsão. */
export type CompareValues = Map<string, Map<number, CompareCell>>;

const KEYS = ["dre_compare", "account_compare", "plan_shifts", "actual_adjustments"];

export function useDreCompare(
  versionId: string | null,
  scenarioId: string | null,
  unitId: string | null,
) {
  return useQuery({
    queryKey: ["dre_compare", versionId, scenarioId, unitId],
    enabled: !!versionId && !!scenarioId,
    queryFn: async (): Promise<CompareValues> => {
      const { data, error } = await supabase.rpc("dre_compare", {
        _version_id: versionId!,
        _scenario_id: scenarioId!,
        ...(unitId ? { _unit_ids: [unitId] } : {}),
      });
      if (error) throw error;
      const out: CompareValues = new Map();
      for (const r of data ?? []) {
        if (!out.has(r.dre_line_id)) out.set(r.dre_line_id, new Map());
        out.get(r.dre_line_id)!.set(r.month, {
          planned: Number(r.planned),
          actual: Number(r.actual),
          forecast: Number(r.forecast),
        });
      }
      return out;
    },
  });
}

export function useAccountCompare(
  versionId: string | null,
  scenarioId: string | null,
  unitId: string | null,
) {
  return useQuery({
    queryKey: ["account_compare", versionId, scenarioId, unitId],
    enabled: !!versionId && !!scenarioId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("account_compare", {
        _version_id: versionId!,
        _scenario_id: scenarioId!,
        ...(unitId ? { _unit_ids: [unitId] } : {}),
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        accountId: r.account_id,
        name: r.name,
        kind: r.kind,
        month: r.month,
        planned: Number(r.planned),
        actual: Number(r.actual),
      }));
    },
  });
}

export function useShifts(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["plan_shifts", versionId, unitId],
    enabled: !!versionId,
    queryFn: async () => {
      const q = supabase
        .from("plan_shifts")
        .select("id, unit_id, from_month, to_month, amount, note, accounts(name), units(name)")
        .eq("version_id", versionId!)
        .order("created_at");
      const { data, error } = await (unitId ? q.eq("unit_id", unitId) : q);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAdjustments(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["actual_adjustments", versionId, unitId],
    enabled: !!versionId,
    queryFn: async () => {
      const q = supabase
        .from("actual_adjustments")
        .select("id, unit_id, month, amount, note, accounts(name), units(name)")
        .eq("version_id", versionId!)
        .order("created_at");
      const { data, error } = await (unitId ? q.eq("unit_id", unitId) : q);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUnmatched(versionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["actual_unmatched", versionId],
    enabled: !!versionId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("actual_unmatched", { _version_id: versionId! });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export interface Analysis {
  resumo: string;
  gargalos: { titulo: string; explicacao: string }[];
  ajustes: { titulo: string; explicacao: string }[];
  previsao: string;
}

export function useAnalysis(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["dre_analyses", versionId, unitId],
    enabled: !!versionId,
    queryFn: async () => {
      const q = supabase
        .from("dre_analyses")
        .select("content, created_at")
        .eq("version_id", versionId!);
      const { data, error } = await (
        unitId ? q.eq("unit_id", unitId) : q.is("unit_id", null)
      ).maybeSingle();
      if (error) throw error;
      return data ? { content: data.content as unknown as Analysis, at: data.created_at } : null;
    },
  });
}

/** Chama a função da IA e devolve a mensagem de erro dela, ou null se deu certo. */
export async function callAi(body: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("dre-analysis", { body });
  if (!error) return (data as { error?: string } | null)?.error ?? null;
  const response = (error as { context?: Response }).context;
  const detail = response
    ? ((await response.json().catch(() => null)) as { error?: string } | null)?.error
    : null;
  return detail ?? "Não foi possível falar com a análise por IA.";
}

export function useCompareMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const done = async (error: { message: string } | null) => {
    await refresh();
    if (error) toast.error(friendlyError(error.message));
    return !error;
  };
  return {
    async addShift(row: {
      version_id: string;
      unit_id: string;
      account_id: string;
      from_month: number;
      to_month: number;
      amount: number;
      note: string;
    }) {
      return done((await supabase.from("plan_shifts").insert(row)).error);
    },
    async deleteShift(id: string) {
      return done((await supabase.from("plan_shifts").delete().eq("id", id)).error);
    },
    async addAdjustment(row: {
      version_id: string;
      unit_id: string;
      account_id: string;
      month: number;
      amount: number;
      note: string;
    }) {
      return done((await supabase.from("actual_adjustments").insert(row)).error);
    },
    async deleteAdjustment(id: string) {
      return done((await supabase.from("actual_adjustments").delete().eq("id", id)).error);
    },
    async setClosedMonth(versionId: string, month: number) {
      const { error } = await supabase
        .from("budget_versions")
        .update({ closed_month: month })
        .eq("id", versionId);
      await queryClient.invalidateQueries({ queryKey: ["budget_versions"] });
      return done(error);
    },
    /** Pede a análise à IA. Demora alguns segundos e tem custo: só roda quando alguém clica. */
    async analyze(versionId: string, scenarioId: string, unitId: string | null) {
      const message = await callAi({
        version_id: versionId,
        scenario_id: scenarioId,
        unit_id: unitId,
      });
      if (message) {
        toast.error(message);
        return false;
      }
      await queryClient.invalidateQueries({ queryKey: ["dre_analyses"] });
      return true;
    },
  };
}
