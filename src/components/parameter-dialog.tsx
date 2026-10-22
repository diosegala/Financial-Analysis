import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  friendlyError,
  useAccounts,
  useCalcRules,
  useContractTypes,
  useDreLines,
  useParameterDefinitions,
  useRevenueTypes,
  type ParameterDefinition,
  type ParameterValue,
} from "@/lib/catalog";
import { fmtInput, parseNum } from "@/lib/format";
import {
  BASE_LABELS,
  SCOPE_LABELS,
  uniqueKey,
  uniqueName,
  usedScopes,
  type BaseKind,
  type Scope,
} from "@/lib/parameters";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SCOPES = Object.keys(SCOPE_LABELS) as Scope[];
const NO_FILTER: string[] = [];

function CheckGrid({
  options,
  value,
  onChange,
  empty,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  return (
    <div className="space-y-1">
      <div className="grid max-h-36 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border border-border p-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.includes(o.value)}
              onCheckedChange={(c) =>
                onChange(c ? [...value, o.value] : value.filter((x) => x !== o.value))
              }
            />
            {o.label}
          </label>
        ))}
      </div>
      {value.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
    </div>
  );
}

/**
 * Cria ou edita um parâmetro e, no mesmo lugar, a regra que o leva para a DRE
 * (base × parâmetro → linha da DRE). Só o financeiro chega aqui; o banco também recusa os demais.
 */
export function ParameterDialog({
  def,
  values,
  onClose,
  onSaved,
}: {
  def: ParameterDefinition | null;
  values: ParameterValue[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: allDefs } = useParameterDefinitions();
  const { data: allRules } = useCalcRules();
  const { data: dreLines } = useDreLines();
  const { data: revenueTypes } = useRevenueTypes();
  const { data: contractTypes } = useContractTypes();
  const { data: accounts } = useAccounts();

  const rules = def ? (allRules ?? []).filter((r) => r.parameter_definition_id === def.id) : [];
  const rule = rules.length === 1 ? rules[0]! : null;
  const manyRules = rules.length > 1;
  const inUseScopes = usedScopes(values);
  const hasValues = values.length > 0;

  const percent = (def?.value_type ?? "percent") === "percent";
  const shown = (n: number | null, pct: boolean) =>
    n === null ? "" : fmtInput(pct ? Number(n) * 100 : Number(n), 6);

  const [label, setLabel] = useState(def?.label ?? "");
  const [description, setDescription] = useState(def?.description ?? "");
  const [valueType, setValueType] = useState<"percent" | "currency">(
    (def?.value_type as "percent" | "currency" | undefined) ?? "percent",
  );
  const [scopes, setScopes] = useState<Record<Scope, boolean>>(
    Object.fromEntries(SCOPES.map((s) => [s, def?.allowed_scopes.includes(s) ?? false])) as Record<
      Scope,
      boolean
    >,
  );
  const [minText, setMinText] = useState(shown(def?.min_value ?? 0, percent));
  const [maxText, setMaxText] = useState(shown(def?.max_value ?? null, percent));
  const [active, setActive] = useState(def?.active ?? true);

  const [hasRule, setHasRule] = useState(def ? (rule?.active ?? false) : true);
  const [lineId, setLineId] = useState<string | null>(rule?.target_dre_line_id ?? null);
  const [base, setBase] = useState<BaseKind>(
    (rule?.base_kind as BaseKind | undefined) ?? "receita",
  );
  const [onlyTypes, setOnlyTypes] = useState<string[]>(rule?.revenue_type_ids ?? NO_FILTER);
  const [exceptTypes, setExceptTypes] = useState<string[]>(
    rule?.exclude_revenue_type_ids ?? NO_FILTER,
  );
  const [onlyContracts, setOnlyContracts] = useState<string[]>(
    rule?.contract_type_ids ?? NO_FILTER,
  );
  const [onlyAccounts, setOnlyAccounts] = useState<string[]>(rule?.account_ids ?? NO_FILTER);
  const [saving, setSaving] = useState(false);

  const pct = valueType === "percent";
  const num = (t: string, asPct: boolean): number | null | "invalid" => {
    if (t.trim() === "") return null;
    const n = parseNum(t);
    return n === null ? "invalid" : asPct ? n / 100 : n;
  };
  const min = num(minText, pct);
  const max = num(maxText, pct);
  const limitsOk =
    min !== "invalid" &&
    max !== "invalid" &&
    (min === null || max === null || min <= max) &&
    (min === null || min >= 0);
  const ruleOk = !hasRule || manyRules || (lineId !== null && base !== undefined);
  const valid = label.trim() !== "" && limitsOk && ruleOk;

  const lineOptions = (dreLines ?? [])
    .filter((l) => l.active && (l.kind === "calculada" || l.kind === "lancada"))
    .map((l) => ({ value: l.id, label: l.name }));
  const typeOptions = (revenueTypes ?? [])
    .filter((t) => t.active)
    .map((t) => ({ value: t.id, label: t.name }));

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      const allowed = ["global", ...SCOPES.filter((s) => scopes[s])];
      const defPayload = {
        label: label.trim(),
        description: description.trim() || null,
        value_type: valueType,
        allowed_scopes: allowed,
        min_value: min, // já validado acima: número ou vazio
        max_value: max,
        active,
      };
      let defId: string;
      if (def) {
        const { error } = await supabase
          .from("parameter_definitions")
          .update(defPayload)
          .eq("id", def.id);
        if (error) throw error;
        defId = def.id;
      } else {
        const sort = Math.max(0, ...(allDefs ?? []).map((d) => d.sort_order)) + 10;
        const { data, error } = await supabase
          .from("parameter_definitions")
          .insert({
            ...defPayload,
            key: uniqueKey(
              label,
              (allDefs ?? []).map((d) => d.key),
            ),
            sort_order: sort,
          })
          .select("id")
          .single();
        if (error) throw error;
        defId = data.id;
      }

      // Parâmetro desativado não pode continuar calculando escondido na DRE: as regras dele também desligam.
      if (def && def.active && !active) {
        const { error } = await supabase
          .from("calc_rules")
          .update({ active: false })
          .eq("parameter_definition_id", def.id);
        if (error) throw error;
      }

      if (!manyRules) {
        const ruleActive = hasRule && active;
        const rulePayload = {
          target_dre_line_id: lineId!,
          base_kind: base,
          revenue_type_ids: base === "receita" && onlyTypes.length ? onlyTypes : null,
          exclude_revenue_type_ids: base === "receita" && exceptTypes.length ? exceptTypes : null,
          contract_type_ids:
            (base === "salario" || base === "headcount") && onlyContracts.length
              ? onlyContracts
              : null,
          account_ids:
            (base === "receita" || base === "despesa") && onlyAccounts.length ? onlyAccounts : null,
        };
        if (rule) {
          const { error } = await supabase
            .from("calc_rules")
            .update(hasRule ? { ...rulePayload, active: ruleActive } : { active: false })
            .eq("id", rule.id);
          if (error) throw error;
        } else if (hasRule) {
          const names = (allRules ?? []).map((r) => r.name);
          const sort = Math.max(0, ...(allRules ?? []).map((r) => r.sort_order)) + 10;
          const { error } = await supabase.from("calc_rules").insert({
            ...rulePayload,
            name: uniqueName(label.trim(), names),
            parameter_definition_id: defId,
            active: ruleActive,
            sort_order: sort,
          });
          if (error) throw error;
        }
      }

      await Promise.all(
        ["parameter_definitions", "calc_rules", "dre"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      toast.success(
        def ? "Parâmetro salvo." : "Parâmetro criado. Agora informe o valor e a vigência.",
      );
      onSaved();
      onClose();
    } catch (err) {
      toast.error(
        friendlyError(
          err instanceof Error ? err.message : String((err as { message?: string }).message),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{def ? `Editar ${def.label}` : "Novo parâmetro"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nome" hint="Ex.: IBS, CBS, Comissão de indicação.">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field
              label="Tipo do valor"
              hint={hasValues ? "Não dá para mudar: já há valores cadastrados." : undefined}
            >
              <OptionSelect
                value={valueType}
                disabled={hasValues}
                onChange={(v) => setValueType((v as "percent" | "currency") ?? "percent")}
                options={[
                  { value: "percent", label: "Percentual (%)" },
                  { value: "currency", label: "Valor em reais (R$)" },
                ]}
              />
            </Field>
            <div className="col-span-2">
              <Field
                label="Descrição"
                hint="Opcional. Aparece abaixo do nome na tela de parâmetros."
              >
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div>
          </div>

          <Field
            label="Pode ter valores diferentes por"
            hint="Sempre existe o valor geral. Escolha o que mais pode variar; o valor mais específico prevalece."
          >
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 rounded-md border border-border p-2">
              {SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={scopes[s]}
                    disabled={inUseScopes.has(s)}
                    onCheckedChange={(c) => setScopes((p) => ({ ...p, [s]: !!c }))}
                  />
                  {SCOPE_LABELS[s]}
                  {inUseScopes.has(s) && (
                    <span className="text-xs text-muted-foreground">(em uso)</span>
                  )}
                </label>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={`Mínimo permitido ${pct ? "(%)" : "(R$)"}`}
              hint="Opcional. Evita erro de digitação."
            >
              <Input
                value={minText}
                onChange={(e) => setMinText(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label={`Máximo permitido ${pct ? "(%)" : "(R$)"}`} hint="Opcional.">
              <Input
                value={maxText}
                onChange={(e) => setMaxText(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          {!limitsOk && (
            <p className="text-sm text-destructive">
              Confira o mínimo e o máximo (números, mínimo menor que o máximo).
            </p>
          )}

          <div className="space-y-3 rounded-md border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={hasRule} disabled={manyRules} onCheckedChange={setHasRule} />
              Entra no cálculo da DRE
            </label>
            {manyRules ? (
              <p className="text-sm text-muted-foreground">
                Este parâmetro tem {rules.length} regras. Edite-as em Configurações → Regras de
                cálculo.
              </p>
            ) : hasRule ? (
              <>
                <p className="text-sm text-muted-foreground">
                  O app calcula <strong>base × valor do parâmetro</strong>, mês a mês, e soma na
                  linha da DRE escolhida.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Base de cálculo">
                    <OptionSelect
                      value={base}
                      onChange={(v) => setBase((v as BaseKind) ?? "receita")}
                      options={(Object.keys(BASE_LABELS) as BaseKind[]).map((b) => ({
                        value: b,
                        label: BASE_LABELS[b],
                      }))}
                    />
                  </Field>
                  <Field label="Aparece na linha da DRE">
                    <OptionSelect value={lineId} onChange={setLineId} options={lineOptions} />
                  </Field>
                </div>
                {base === "receita" && (
                  <>
                    <Field label="Só estes tipos de receita" hint="Em branco: todos os tipos.">
                      <CheckGrid
                        options={typeOptions}
                        value={onlyTypes}
                        onChange={setOnlyTypes}
                        empty="Todos os tipos de receita."
                      />
                    </Field>
                    <Field
                      label="Exceto estes tipos de receita"
                      hint="Um tipo criado depois entra sozinho, a menos que esteja aqui."
                    >
                      <CheckGrid
                        options={typeOptions}
                        value={exceptTypes}
                        onChange={setExceptTypes}
                        empty="Nenhuma exceção."
                      />
                    </Field>
                  </>
                )}
                {(base === "salario" || base === "headcount") && (
                  <Field label="Só estes vínculos" hint="Em branco: todos.">
                    <CheckGrid
                      options={(contractTypes ?? [])
                        .filter((c) => c.active)
                        .map((c) => ({ value: c.id, label: c.name }))}
                      value={onlyContracts}
                      onChange={setOnlyContracts}
                      empty="Todos os vínculos."
                    />
                  </Field>
                )}
                {(base === "receita" || base === "despesa") && (
                  <Field label="Só estas contas" hint="Opcional.">
                    <CheckGrid
                      options={(accounts ?? [])
                        .filter((a) => a.active && a.kind === base)
                        .map((a) => ({ value: a.id, label: a.name }))}
                      value={onlyAccounts}
                      onChange={setOnlyAccounts}
                      empty="Todas as contas."
                    />
                  </Field>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sem cálculo, o parâmetro só é cadastrado e não muda a DRE.
              </p>
            )}
          </div>

          {def && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={active} onCheckedChange={setActive} /> Parâmetro ativo
              <span className="text-xs text-muted-foreground">
                (desativado, some da tela e a regra deixa de calcular; os valores ficam guardados)
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
