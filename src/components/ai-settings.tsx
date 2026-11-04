import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/catalog";
import { callAi } from "@/lib/compare";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 (mais completo)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (equilibrado)" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (mais barato)" },
];

/** Configuração da IA, só para o financeiro. A chave é gravada e nunca volta para a tela. */
export function AiSettingsTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["ai_settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_settings").select("*").maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ai_settings"] });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: { enabled?: boolean; model?: string }) =>
    run(async () => {
      const { error } = await supabase.from("ai_settings").update(patch).eq("id", settings!.id);
      if (error) toast.error(friendlyError(error.message));
      await refresh();
    });

  if (isLoading || !settings) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  return (
    <section className="max-w-2xl space-y-4 rounded-md border border-border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">Análise por IA</h2>
        <p className="text-sm text-muted-foreground">
          Só quem tem perfil financeiro vê esta tela. A chave fica criptografada e não aparece de
          novo depois de salva. Cada análise tem custo na conta da API do Claude.
        </p>
      </div>
      <Field
        label="Chave da API do Claude"
        hint={
          settings.key_last4
            ? `Chave salva, termina em ${settings.key_last4}. Para trocar, cole a nova.`
            : "Nenhuma chave salva."
        }
      >
        <div className="flex gap-2">
          <Input
            aria-label="Chave da API do Claude"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
          />
          <Button
            disabled={busy || key.trim() === ""}
            onClick={() =>
              void run(async () => {
                const { error } = await supabase.rpc("set_ai_key", { _key: key });
                if (error) {
                  toast.error(friendlyError(error.message));
                  return;
                }
                setKey("");
                toast.success("Chave salva.");
                await refresh();
              })
            }
          >
            Salvar
          </Button>
        </div>
      </Field>
      <Field label="Modelo">
        <OptionSelect
          value={settings.model}
          disabled={busy}
          onChange={(v) => v && void update({ model: v })}
          options={MODELS}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !settings.key_last4}
          onClick={() =>
            void run(async () => {
              const message = await callAi({ test: true });
              if (message) toast.error(message);
              else toast.success("A chave funciona.");
            })
          }
        >
          Testar a chave
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void update({ enabled: !settings.enabled })}
        >
          {settings.enabled ? "Desligar a análise" : "Ligar a análise"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={busy || !settings.key_last4}
          onClick={() =>
            void run(async () => {
              const { error } = await supabase.rpc("clear_ai_key");
              if (error) toast.error(friendlyError(error.message));
              await refresh();
            })
          }
        >
          Apagar a chave
        </Button>
      </div>
    </section>
  );
}
