import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Submission = Tables<"unit_submissions">;
export type SubmissionStatus = "rascunho" | "enviado" | "aprovado" | "devolvido";

export const SUBMISSION_LABELS: Record<SubmissionStatus, string> = {
  rascunho: "Em preenchimento",
  enviado: "Enviado para aprovação",
  aprovado: "Aprovado",
  devolvido: "Devolvido para ajuste",
};

export const VERSION_STATUS_LABELS: Record<string, string> = {
  rascunho: "Rascunho",
  em_coleta: "Em coleta",
  em_aprovacao: "Em aprovação",
  aprovado: "Aprovado",
  travado: "Travado",
};

export function useSubmissions(versionId: string | null) {
  return useQuery({
    queryKey: ["unit_submissions", versionId],
    enabled: !!versionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("unit_submissions")
        .select("*")
        .eq("version_id", versionId!);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSetUnitStatus() {
  const queryClient = useQueryClient();
  return async (versionId: string, unitId: string, status: SubmissionStatus, comment?: string) => {
    const { error } = await supabase.rpc("set_unit_status", {
      _version_id: versionId,
      _unit_id: unitId,
      _status: status,
      ...(comment ? { _comment: comment } : {}),
    });
    if (error) {
      toast.error(error.message);
      return false;
    }
    toast.success(
      status === "enviado"
        ? "Unidade enviada para aprovação."
        : `Status alterado: ${SUBMISSION_LABELS[status]}.`,
    );
    await queryClient.invalidateQueries({ queryKey: ["unit_submissions"] });
    return true;
  };
}
