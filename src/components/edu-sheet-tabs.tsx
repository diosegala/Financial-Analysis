import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  friendlyError,
  useAccounts,
  useEduSheetSettings,
  useEduSheetTabs,
  useProducts,
  useUnits,
} from "@/lib/catalog";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** Nome sugerido para o produto: o nome da aba sem o "Plan." do fim (ex.: "ICL Plan" → "ICL"). */
const suggestedName = (tab: string) => tab.replace(/\s*plan\.?\s*$/i, "").trim();

type Tab = NonNullable<ReturnType<typeof useEduSheetTabs>["data"]>[number];

/**
 * As abas da planilha, como a leitura encontrou. Para cada uma: escolher o produto (ou criar um, já ligado) ou deixar
 * sem produto, e a aba é ignorada.
 */
export function EduSheetTabs() {
  const queryClient = useQueryClient();
  const { data: tabs } = useEduSheetTabs();
  const { data: settings } = useEduSheetSettings();
  const { data: products } = useProducts();
  const [creating, setCreating] = useState<Tab | null>(null);
  const unitId = settings?.[0]?.unit_id ?? null;
  const unitProducts = (products ?? [])
    .filter((p) => p.active && (!unitId || p.unit_id === unitId))
    .map((p) => ({ value: p.id, label: p.name }));
  const productName = new Map((products ?? []).map((p) => [p.id, p.name]));

  async function link(tab: Tab, productId: string | null) {
    const { error } = await supabase
      .from("edu_sheet_tabs")
      .update({ product_id: productId, active: !!productId })
      .eq("id", tab.id);
    if (error) return void toast.error(friendlyError(error.message));
    await queryClient.invalidateQueries({ queryKey: ["edu_sheet_tabs"] });
    toast.success(
      productId
        ? "Aba ligada. Clique em Ler a planilha agora para trazer os valores."
        : "Aba desligada: a próxima leitura não usa esta aba.",
    );
  }

  if (!tabs?.length)
    return (
      <p className="text-sm text-muted-foreground">
        As abas aparecem aqui depois da primeira leitura da planilha.
      </p>
    );

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th className="px-3 py-2 font-medium">Aba da planilha</th>
            <th className="px-3 py-2 font-medium">Produto no app</th>
            <th className="px-3 py-2 font-medium">Situação</th>
          </tr>
        </thead>
        <tbody>
          {tabs.map((t) => (
            <tr key={t.id} className="border-b border-border last:border-0 align-top">
              <td className="px-3 py-2">
                <div className="font-medium">{t.tab_name}</div>
                {t.title && <div className="text-xs text-muted-foreground">{t.title}</div>}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <OptionSelect
                    className="w-56"
                    value={t.product_id}
                    onChange={(v) => void link(t, v)}
                    options={unitProducts}
                    noneLabel="Não usar esta aba"
                  />
                  {!t.product_id && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={() => setCreating(t)}
                    >
                      <Plus className="h-3.5 w-3.5" /> Criar produto
                    </Button>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 text-xs">
                {t.last_error ? (
                  <span className="text-destructive">{t.last_error}</span>
                ) : t.product_id ? (
                  <span>Ligada a {productName.get(t.product_id) ?? "—"}</span>
                ) : (
                  <span className="text-muted-foreground">Sem produto: ignorada</span>
                )}
                {t.warnings.map((w) => (
                  <div key={w} className="text-amber-700 dark:text-amber-400">
                    {w}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && (
        <CreateProductDialog tab={creating} unitId={unitId} onClose={() => setCreating(null)} />
      )}
    </div>
  );
}

/** Cria o produto (evento da unidade, com as contas) e já liga à aba. */
function CreateProductDialog({
  tab,
  unitId,
  onClose,
}: {
  tab: Tab;
  unitId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: accounts } = useAccounts();
  const { data: products } = useProducts();
  const { data: units } = useUnits();
  const [name, setName] = useState(suggestedName(tab.tab_name));
  const forUnit = (accounts ?? []).filter(
    (a) =>
      a.active &&
      a.treatment === "lancavel" &&
      (!a.unit_ids || (unitId && a.unit_ids.includes(unitId))),
  );
  const options = (kind: string) =>
    forUnit
      .filter((a) => a.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((a) => ({ value: a.id, label: a.name }));
  // Sugestões pelo nome do produto, como as categorias do Omie ("ICL Ingressos - 2027", "ICL Patrocínio - 2027",
  // "ICL - 2027"); o ano mais recente primeiro. Enquanto o usuário não escolhe, a sugestão acompanha o nome.
  const named = (kind: string, word?: string) =>
    forUnit
      .filter(
        (a) =>
          a.kind === kind &&
          norm(a.name).startsWith(norm(name)) &&
          (!word || norm(a.name).includes(word)),
      )
      .sort((a, b) => b.name.localeCompare(a.name, "pt-BR"))[0]?.id ?? null;
  const unitName = norm(units?.find((u) => u.id === unitId)?.name ?? "");
  const guess = {
    cost:
      forUnit
        .filter((a) => a.kind === "despesa" && norm(a.name).startsWith(norm(name)))
        .sort((a, b) => b.name.localeCompare(a.name, "pt-BR"))[0]?.id ?? null,
    revenue:
      named("receita", "ingresso") ??
      forUnit.find((a) => a.kind === "receita" && unitName && norm(a.name).includes(unitName))
        ?.id ??
      (products ?? []).find((p) => p.unit_id === unitId && p.revenue_account_id)
        ?.revenue_account_id ??
      null,
    sponsor: named("receita", "patroc"),
    extra: null as string | null,
  };
  type Pick = Record<keyof typeof guess, string | null | undefined>;
  const [picked, setPicked] = useState<Pick>({
    cost: undefined,
    revenue: undefined,
    sponsor: undefined,
    extra: undefined,
  });
  const value = (k: keyof Pick) => (picked[k] === undefined ? guess[k] : picked[k]) ?? null;
  const choose = (k: keyof Pick) => (v: string | null) => setPicked((p) => ({ ...p, [k]: v }));
  const costId = value("cost");
  const revenueId = value("revenue");
  const [saving, setSaving] = useState(false);
  const valid = name.trim() !== "" && !!costId && !!revenueId && !!unitId;

  async function save() {
    if (!valid) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("products")
      .insert({
        name: name.trim(),
        unit_id: unitId,
        kind: "evento",
        price_model: "mensal",
        revenue_account_id: revenueId,
        sponsor_account_id: value("sponsor"),
        extra_account_id: value("extra"),
        cost_account_id: costId,
        active: true,
      })
      .select("id")
      .single();
    if (error || !data) {
      setSaving(false);
      return void toast.error(friendlyError(error?.message ?? ""));
    }
    const linked = await supabase
      .from("edu_sheet_tabs")
      .update({ product_id: data.id, active: true })
      .eq("id", tab.id);
    setSaving(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["edu_sheet_tabs"] }),
    ]);
    if (linked.error) return void toast.error(friendlyError(linked.error.message));
    toast.success(
      "Produto criado e ligado. Clique em Ler a planilha agora para trazer os valores.",
    );
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Criar produto para a aba {tab.tab_name}</DialogTitle>
          <DialogDescription>
            O produto fica na unidade da planilha, como evento. Escolha as categorias do evento no
            Omie (ingressos, patrocínio e despesa), para o realizado casar com o planejado.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Nome do produto">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Receita de ingressos"
            hint="A categoria do Omie dos ingressos do evento, por exemplo “ICL Ingressos - 2027”."
          >
            <OptionSelect
              value={revenueId}
              onChange={choose("revenue")}
              options={options("receita")}
            />
          </Field>
          <Field
            label="Receita de patrocínio"
            hint="O bloco PATROCÍNIO da aba. Sem categoria própria, vai para a de ingressos."
          >
            <OptionSelect
              value={value("sponsor")}
              onChange={choose("sponsor")}
              noneLabel="Mesma dos ingressos"
              options={options("receita")}
            />
          </Field>
          <Field
            label="Receita variável e vagas extras"
            hint="Os outros blocos de receita da aba (VARIÁVEL, VAGAS EXTRAS)."
          >
            <OptionSelect
              value={value("extra")}
              onChange={choose("extra")}
              noneLabel="Mesma dos ingressos"
              options={options("receita")}
            />
          </Field>
          <Field
            label="Despesa do evento"
            hint="A categoria do Omie onde caem os custos deste evento, por exemplo “ICL - 2027”. Precisa ser só deste produto: a leitura substitui o que for lançado à mão nela."
          >
            <OptionSelect value={costId} onChange={choose("cost")} options={options("despesa")} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!valid || saving}>
            Criar e ligar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
