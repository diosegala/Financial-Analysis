import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/catalog";
import { useCurrentUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** A última leitura do Omie e o botão para ler de novo. A leitura também roda sozinha, toda segunda de manhã. */
export function OmieSync() {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const { data: last } = useQuery({
    queryKey: ["omie_sync_last"],
    enabled: !!user?.isFinanceiro,
    refetchInterval: (query) => (query.state.data?.status === "rodando" ? 5000 : false),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("omie_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const { data: lastRead } = useQuery({
    queryKey: ["omie_last_read"],
    enabled: !!user?.isFinanceiro,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("omie_companies")
        .select("last_synced_at")
        .order("last_synced_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.last_synced_at ?? null;
    },
  });
  const running = last?.status === "rodando";

  // Quando a leitura em andamento termina, avisa e recarrega os números da tela.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (!last) return;
    if (last.status === "rodando") watched.current = last.id;
    else if (watched.current === last.id) {
      watched.current = null;
      void queryClient.invalidateQueries();
      const news = last.new_accounts.length;
      const added = news ? ` ${news} categoria(s) nova(s) em Adicionar categoria.` : "";
      if (last.status === "concluida")
        toast.success(
          `Leitura do Omie concluída.${added} Para refletir nos limites, clique em Calcular.`,
        );
      else toast.error(`A leitura do Omie teve problema: ${last.errors.join(" ")}`);
    }
  }, [last, queryClient]);

  if (!user?.isFinanceiro) return null;

  async function start() {
    setStarting(true);
    const { error } = await supabase.functions.invoke("omie-sync", { body: {} });
    setStarting(false);
    if (error) toast.error(friendlyError(error));
    await queryClient.invalidateQueries({ queryKey: ["omie_sync_last"] });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted-foreground">
        {running
          ? `Lendo o Omie: ${last.companies_done.length} empresa(s) prontas. Leva alguns minutos e pode sair desta tela.`
          : lastRead
            ? `Omie lido em ${fmtWhen(lastRead)}. Lê sozinho toda segunda de manhã.`
            : "O Omie ainda não foi lido. Lê sozinho toda segunda de manhã."}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={running || starting}
        onClick={() => void start()}
      >
        <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} /> Ler o Omie agora
      </Button>
      {!running && last?.status === "com_erro" && (
        <span className="text-destructive">
          Última leitura com problema: {last.errors.join(" ")}
        </span>
      )}
    </div>
  );
}
