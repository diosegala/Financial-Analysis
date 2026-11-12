import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError, useEduSheetSettings } from "@/lib/catalog";
import { useCurrentUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** A última leitura da planilha de Educação e o botão para ler de novo. Também lê sozinha, todo dia de manhã. */
export function EduSheetSync({ unitId }: { unitId?: string | null }) {
  const { data: user } = useCurrentUser();
  const { data: settings } = useEduSheetSettings();
  const queryClient = useQueryClient();
  const [reading, setReading] = useState(false);
  const config = settings?.[0];
  const { data: last } = useQuery({
    queryKey: ["edu_sheet_last"],
    enabled: !!user?.isFinanceiro,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("edu_sheet_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Fora da unidade da planilha (ou sem planilha configurada), não aparece.
  if (!user?.isFinanceiro || !config?.spreadsheet_id) return null;
  if (unitId !== undefined && unitId !== config.unit_id) return null;

  async function read() {
    setReading(true);
    const { data, error } = await supabase.functions.invoke("edu-sheet-sync", { body: {} });
    setReading(false);
    await queryClient.invalidateQueries();
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    const errors = (data?.errors ?? []) as string[];
    if (errors.length) toast.error(`A leitura da planilha teve problema: ${errors.join(" ")}`);
    else toast.success(`Planilha lida: ${(data?.tabs ?? []).length} produto(s) atualizados.`);
  }

  const when = last?.finished_at ?? last?.started_at;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted-foreground">
        {when
          ? `Planilha de Educação lida em ${fmtWhen(when)}${
              last?.target === "previsao" ? " (versão travada: atualiza a previsão)" : ""
            }. Lê sozinha todo dia de manhã.`
          : "A planilha de Educação ainda não foi lida. Lê sozinha todo dia de manhã."}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={reading}
        onClick={() => void read()}
      >
        <RefreshCw className={`h-4 w-4 ${reading ? "animate-spin" : ""}`} /> Ler a planilha agora
      </Button>
      {!reading && last?.status === "com_erro" && (
        <span className="text-destructive">
          Última leitura com problema: {last.errors.join(" ")}
        </span>
      )}
    </div>
  );
}
