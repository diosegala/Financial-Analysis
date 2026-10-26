import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/lib/catalog";
import { Field } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Um ajuste de app_settings em texto (ex.: lista separada por vírgula), editável pelo financeiro. */
export function AppSettingField({
  settingKey,
  label,
  hint,
}: {
  settingKey: string;
  label: string;
  hint?: string;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["app_settings", settingKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", settingKey)
        .maybeSingle();
      if (error) throw error;
      return data?.value ?? "";
    },
  });
  const [value, setValue] = useState("");
  useEffect(() => setValue(data ?? ""), [data]);

  async function save() {
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: settingKey, value: value.trim(), label }, { onConflict: "key" });
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["app_settings"] }),
      queryClient.invalidateQueries({ queryKey: ["omie_expenses"] }),
    ]);
    toast.success("Salvo.");
  }

  return (
    <div className="flex max-w-2xl items-end gap-2">
      <div className="flex-1">
        <Field label={label} hint={hint}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <Button size="sm" onClick={save} disabled={value === (data ?? "")}>
        Salvar
      </Button>
    </div>
  );
}
