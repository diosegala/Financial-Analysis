import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import {
  byId,
  useAccounts,
  useCalcRules,
  useContractTypes,
  useDreLines,
  useParameterDefinitions,
  useParameterValues,
  useProducts,
  useRevenueTypes,
  useTableMutations,
  useUnits,
  type ParameterDefinition,
  type ParameterValue,
} from "@/lib/catalog";
import { fmtBRL, fmtInput, parseNum } from "@/lib/format";
import { SCOPE_COLUMN, SCOPE_LABELS, describeRule, type Scope } from "@/lib/parameters";
import { PageHeader } from "@/components/page-header";
import { ParameterDialog } from "@/components/parameter-dialog";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/parametros")({
  head: pageHead(
    "Parâmetros",
    "Impostos, comissões, encargos e benefícios, com escopo e vigência.",
  ),
  component: ParametrosPage,
});

function useScopeOptions() {
  const { data: units } = useUnits();
  const { data: products } = useProducts();
  const { data: contractTypes } = useContractTypes();
  const { data: revenueTypes } = useRevenueTypes();
  const opts = (rows: { id: string; name: string }[] | undefined) =>
    (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
  return {
    unit: opts(units),
    product: opts(products),
    contract_type: opts(contractTypes),
    revenue_type: opts(revenueTypes),
  } satisfies Record<Scope, { value: string; label: string }[]>;
}

const fmtValue = (def: ParameterDefinition, v: number) =>
  def.value_type === "percent"
    ? `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%`
    : fmtBRL(v);

function ParametrosPage() {
  const { data: user, isLoading: loadingUser } = useCurrentUser();
  const { data: definitions } = useParameterDefinitions();
  const { data: values } = useParameterValues();
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  // Só o financeiro cria e edita parâmetros (o banco também recusa os demais perfis).
  if (!loadingUser && user && !user.isFinanceiro) return <Navigate to="/inicio" />;

  const shown = (definitions ?? []).filter((d) => d.active || showInactive);
  const hasInactive = (definitions ?? []).some((d) => !d.active);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parâmetros"
        subtitle="Cada valor vale a partir do mês escolhido. O valor mais específico prevalece: um valor por produto e unidade vence o valor por unidade, que vence o geral."
        actions={
          <div className="flex items-center gap-3">
            {hasInactive && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={showInactive} onCheckedChange={(c) => setShowInactive(!!c)} />
                Mostrar desativados
              </label>
            )}
            <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Novo parâmetro
            </Button>
          </div>
        }
      />
      {shown.map((def) => (
        <ParameterSection
          key={def.id}
          def={def}
          values={(values ?? []).filter((v) => v.definition_id === def.id)}
        />
      ))}
      {creating && (
        <ParameterDialog
          def={null}
          values={[]}
          onClose={() => setCreating(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  );
}

function ParameterSection({ def, values }: { def: ParameterDefinition; values: ParameterValue[] }) {
  const { year } = usePlanning();
  const { data: user } = useCurrentUser();
  const { insert, update, remove } = useTableMutations("parameter_values");
  const queryClient = useQueryClient();
  // Mudou um valor: a DRE em cache deixa de valer e precisa ser recalculada.
  const refreshDre = () => queryClient.invalidateQueries({ queryKey: ["dre"] });
  const scopeOptions = useScopeOptions();
  const { data: rules } = useCalcRules();
  const { data: dreLines } = useDreLines();
  const { data: revenueTypes } = useRevenueTypes();
  const { data: contractTypes } = useContractTypes();
  const { data: accounts } = useAccounts();
  const scopes = def.allowed_scopes.filter((s): s is Scope => s !== "global");
  const [editingDef, setEditingDef] = useState(false);
  const [editingValue, setEditingValue] = useState<ParameterValue | null>(null);
  const [scopeIds, setScopeIds] = useState<Partial<Record<Scope, string | null>>>({});
  const [value, setValue] = useState("");
  const [month, setMonth] = useState<number | null>(1);
  const [validYear, setValidYear] = useState(String(year ?? new Date().getFullYear() + 1));
  const [note, setNote] = useState("");
  const nameOf = (s: Scope, id: string) =>
    scopeOptions[s].find((o) => o.value === id)?.label ?? "?";

  const lookups = {
    dreLine: (id: string) => byId(dreLines).get(id)?.name,
    revenueType: (id: string) => byId(revenueTypes).get(id)?.name,
    contractType: (id: string) => byId(contractTypes).get(id)?.name,
    account: (id: string) => byId(accounts).get(id)?.name,
  };
  const myRules = (rules ?? []).filter((r) => r.parameter_definition_id === def.id);

  const parsed = value.trim() === "" ? null : parseNum(value);
  const stored = parsed === null ? null : def.value_type === "percent" ? parsed / 100 : parsed;
  const outOfRange =
    stored !== null &&
    ((def.min_value !== null && stored < Number(def.min_value)) ||
      (def.max_value !== null && stored > Number(def.max_value)));
  const yearNum = Number(validYear);
  const valid =
    stored !== null && !outOfRange && month !== null && yearNum >= 2000 && yearNum <= 2100;

  function reset() {
    setEditingValue(null);
    setScopeIds({});
    setValue("");
    setNote("");
  }

  function startEdit(v: ParameterValue) {
    setEditingValue(v);
    setValue(fmtInput(def.value_type === "percent" ? Number(v.value) * 100 : Number(v.value), 6));
    setMonth(Number(v.valid_from.slice(5, 7)));
    setValidYear(v.valid_from.slice(0, 4));
    setNote(v.note ?? "");
    setScopeIds(
      Object.fromEntries(
        (Object.keys(SCOPE_COLUMN) as Scope[]).map((s) => [s, v[SCOPE_COLUMN[s]]]),
      ) as Partial<Record<Scope, string | null>>,
    );
  }

  async function save() {
    if (!valid) return;
    const fields = {
      value: stored!,
      valid_from: `${yearNum}-${String(month).padStart(2, "0")}-01`,
      unit_id: scopeIds.unit ?? null,
      product_id: scopeIds.product ?? null,
      contract_type_id: scopeIds.contract_type ?? null,
      revenue_type_id: scopeIds.revenue_type ?? null,
      note: note.trim() || null,
    };
    const ok = editingValue
      ? await update(editingValue.id, fields, `${def.label}: valor alterado.`)
      : await insert(
          { definition_id: def.id, ...fields, created_by: user?.id ?? null },
          `${def.label}: valor registrado.`,
        );
    if (ok) {
      reset();
      await refreshDre();
    }
  }

  const scopeText = (v: ParameterValue) => {
    const parts = scopes
      .map((s) => {
        const id = v[SCOPE_COLUMN[s]];
        return id ? `${SCOPE_LABELS[s]}: ${nameOf(s, id)}` : null;
      })
      .filter(Boolean);
    return parts.length ? parts.join(" · ") : "Geral";
  };

  const sorted = [...values].sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));

  return (
    <section
      className={`space-y-3 rounded-md border border-border bg-card p-4 ${def.active ? "" : "opacity-70"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">
            {def.label} {!def.active && <Badge variant="outline">desativado</Badge>}
          </h2>
          {def.description && <p className="text-sm text-muted-foreground">{def.description}</p>}
          <p className="text-xs text-muted-foreground">
            {myRules.length === 0
              ? "Não entra no cálculo da DRE."
              : `Cálculo: ${myRules.map((r) => describeRule(r, lookups)).join(" · ")}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {values.length === 0 && def.active && (
            <Badge variant="destructive">Sem valor: entra como zero no cálculo</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setEditingDef(true)}
          >
            <Settings2 className="h-4 w-4" /> Editar parâmetro
          </Button>
        </div>
      </div>

      {def.active && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            {scopes.map((s) => (
              <Field key={s} label={SCOPE_LABELS[s]}>
                <OptionSelect
                  className="w-44"
                  value={scopeIds[s] ?? null}
                  onChange={(v) => setScopeIds((prev) => ({ ...prev, [s]: v }))}
                  noneLabel="Todos"
                  options={scopeOptions[s]}
                />
              </Field>
            ))}
            <Field label={def.value_type === "percent" ? "Valor (%)" : "Valor (R$)"}>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-28 font-mono"
                aria-label={`Valor de ${def.label}`}
              />
            </Field>
            <Field label="A partir de">
              <div className="flex gap-1">
                <MonthSelect className="w-32" value={month} onChange={setMonth} />
                <Input
                  value={validYear}
                  onChange={(e) => setValidYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  className="w-20 font-mono"
                />
              </div>
            </Field>
            <Field label="Observação">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-48"
                placeholder="opcional"
              />
            </Field>
            <Button size="sm" className="gap-1.5" onClick={save} disabled={!valid}>
              {editingValue ? (
                "Salvar alteração"
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Adicionar vigência
                </>
              )}
            </Button>
            {editingValue && (
              <Button size="sm" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
            )}
          </div>
          {outOfRange && (
            <p className="text-sm text-destructive">
              Valor fora do intervalo permitido
              {def.min_value !== null && ` (mín. ${fmtValue(def, Number(def.min_value))})`}
              {def.max_value !== null && ` (máx. ${fmtValue(def, Number(def.max_value))})`}.
            </p>
          )}
        </>
      )}

      {sorted.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1.5 font-medium">Escopo</th>
              <th className="py-1.5 text-right font-medium">Valor</th>
              <th className="py-1.5 pl-6 font-medium">Vigente a partir de</th>
              <th className="py-1.5 font-medium">Observação</th>
              <th className="py-1.5 font-medium">Registrado em</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => (
              <tr
                key={v.id}
                className={`border-b border-border last:border-0 ${editingValue?.id === v.id ? "bg-accent" : ""}`}
              >
                <td className="py-1.5">{scopeText(v)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">
                  {fmtValue(def, Number(v.value))}
                </td>
                <td className="py-1.5 pl-6">
                  {new Date(v.valid_from + "T00:00:00").toLocaleDateString("pt-BR", {
                    month: "long",
                    year: "numeric",
                  })}
                </td>
                <td className="py-1.5 text-muted-foreground">{v.note ?? "—"}</td>
                <td className="py-1.5 text-muted-foreground">
                  {new Date(v.created_at).toLocaleDateString("pt-BR")}
                </td>
                <td className="whitespace-nowrap py-1.5 text-right">
                  {def.active && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Editar valor"
                      onClick={() => startEdit(v)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Excluir valor"
                    onClick={async () => {
                      if (await remove(v.id, "Valor excluído.")) await refreshDre();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editingDef && (
        <ParameterDialog
          def={def}
          values={values}
          onClose={() => setEditingDef(false)}
          onSaved={() => {}}
        />
      )}
    </section>
  );
}
