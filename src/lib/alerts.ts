import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type Alert = Tables<"alerts">;
export type AlertSummary = Tables<"alert_summaries">;
export type Severity = "alta" | "media" | "baixa";

export const SEVERITY_LABELS: Record<Severity, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};
export const SEVERITY_ORDER: Record<string, number> = { alta: 0, media: 1, baixa: 2 };

/** Limites dos detectores (app_settings), editáveis pelo financeiro na página Alertas. */
export const ALERT_SETTINGS = [
  { key: "alert_revenue_drop_pct", label: "Queda de receita (%)" },
  { key: "alert_concentration_pct", label: "Concentração em um cliente (%)" },
  { key: "alert_expense_rise_pct", label: "Alta de despesa (%)" },
  { key: "alert_expense_min", label: "Alta de despesa: diferença mínima (R$)" },
  { key: "alert_new_supplier_min", label: "Fornecedor novo: valor mínimo no mês (R$)" },
  { key: "alert_plan_gap_pct", label: "Plano abaixo da meta (%)" },
];

/** Alertas visíveis ao usuário (o banco filtra por unidade), dos mais graves para os mais leves. */
export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: async (): Promise<Alert[]> => {
      const { data, error } = await supabase
        .from("alerts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []).sort(
        (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
      );
    },
  });
}

/** Resumo da IA do mês mais recente: empresa (unit_id nulo) e cada unidade visível. */
export function useAlertSummaries() {
  return useQuery({
    queryKey: ["alerts", "summaries"],
    queryFn: async (): Promise<AlertSummary[]> => {
      const { data, error } = await supabase
        .from("alert_summaries")
        .select("*")
        .order("period", { ascending: false })
        .limit(50);
      if (error) throw error;
      const latest = data?.[0]?.period;
      return (data ?? []).filter((s) => s.period === latest);
    },
  });
}

export function useAlertActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alerts"] });
  return {
    async markSeen(id: string) {
      const { error } = await supabase.rpc("mark_alert_seen", { _id: id });
      if (error) toast.error(friendlyError(error.message));
      await refresh();
    },
    async update(versionId: string | null, scenarioId: string | null) {
      const { data, error } = await supabase.rpc("alerts_refresh", {
        ...(versionId ? { _version_id: versionId } : {}),
        ...(scenarioId ? { _scenario_id: scenarioId } : {}),
      });
      if (error) {
        toast.error(friendlyError(error.message));
        return;
      }
      toast.success(`Alertas atualizados: ${data} no mês e no plano.`);
      await refresh();
    },
    /** Atualiza os alertas e pede o resumo ao Claude (Edge Function alerts-digest). */
    async digest(versionId: string | null, scenarioId: string | null) {
      const { data, error } = await supabase.functions.invoke("alerts-digest", {
        body: { version_id: versionId, scenario_id: scenarioId },
      });
      if (error) {
        const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
        toast.error(body?.error ?? friendlyError(error.message));
        await refresh();
        return;
      }
      if (data?.summary) toast.success("Resumo da IA gerado.");
      else if (data?.reason === "sem chave")
        toast.warning(
          "Alertas atualizados. Para o resumo com IA, cadastre o secret ANTHROPIC_API_KEY nas Edge Functions do Supabase.",
        );
      else toast.success("Alertas atualizados. Nenhum alerta novo para resumir.");
      await refresh();
    },
  };
}
