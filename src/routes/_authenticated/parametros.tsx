import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import {
  useContractTypes,
  useParameterDefinitions,
  useParameterValues,
  useProducts,
  useRevenueTypes,
  useTableMutations,
  useUnits,
  type ParameterDefinition,
  type ParameterValue,
} from "@/lib/catalog";
import { fmtBRL, parseNum } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/parametros")({
  head: pageHead(
    "Parâmetros",
    "Impostos, comissões, encargos e benefícios, com escopo e vigência.",
  ),
  component: ParametrosPage,
});

type Scope = "unit" | "product" | "contract_type" | "revenue_type";
const SCOPE_LABELS: Record<Scope, string> = {
  unit: "Unidade",
  product: "Produto",
  contract_type: "Vínculo",
  revenue_type: "Tipo de receita",
};
const SCOPE_COLUMN = {
  unit: "unit_id",
  product: "product_id",
  contract_type: "contract_type_id",
  revenue_type: "revenue_type_id",
} as const;

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

  if (!loadingUser && user && !user.isFinanceiro) return <Navigate to="/inicio" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parâmetros"
        subtitle="Cada valor vale a partir do mês escolhido. O valor mais específico prevalece: um valor por produto e unidade vence o valor por unidade, que vence o geral."
      />
      {(definitions ?? [])
        .filter((d) => d.active)
        .map((def) => (
          <ParameterSection
            key={def.id}
            def={def}
            values={(values ?? []).filter((v) => v.definition_id === def.id)}
          />
        ))}
      <p className="text-xs text-muted-foreground">
        Para criar novos parâmetros ou mudar como entram no cálculo, use Configurações → Regras de
        cálculo.
      </p>
    </div>
  );
}

function ParameterSection({ def, values }: { def: ParameterDefinition; values: ParameterValue[] }) {
  const { year } = usePlanning();
  const { data: user } = useCurrentUser();
  const { insert, remove } = useTableMutations("parameter_values");
  const scopeOptions = useScopeOptions();
  const scopes = def.allowed_scopes.filter((s): s is Scope => s !== "global");
  const [scopeIds, setScopeIds] = useState<Partial<Record<Scope, string | null>>>({});
  const [value, setValue] = useState("");
  const [month, setMonth] = useState<number | null>(1);
  const [validYear, setValidYear] = useState(String(year ?? new Date().getFullYear() + 1));
  const [note, setNote] = useState("");
  const nameOf = (s: Scope, id: string) =>
    scopeOptions[s].find((o) => o.value === id)?.label ?? "?";

  const parsed = value.trim() === "" ? null : parseNum(value);
  const stored = parsed === null ? null : def.value_type === "percent" ? parsed / 100 : parsed;
  const outOfRange =
    stored !== null &&
    ((def.min_value !== null && stored < Number(def.min_value)) ||
      (def.max_value !== null && stored > Number(def.max_value)));
  const yearNum = Number(validYear);
  const valid =
    stored !== null && !outOfRange && month !== null && yearNum >= 2000 && yearNum <= 2100;

  async function add() {
    if (!valid) return;
    const ok = await insert(
      {
        definition_id: def.id,
        value: stored!,
        valid_from: `${yearNum}-${String(month).padStart(2, "0")}-01`,
        unit_id: scopeIds.unit ?? null,
        product_id: scopeIds.product ?? null,
        contract_type_id: scopeIds.contract_type ?? null,
        revenue_type_id: scopeIds.revenue_type ?? null,
        note: note.trim() || null,
        created_by: user?.id ?? null,
      },
      `${def.label}: valor registrado.`,
    );
    if (ok) {
      setValue("");
      setNote("");
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
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-semibold">{def.label}</h2>
          {def.description && <p className="text-sm text-muted-foreground">{def.description}</p>}
        </div>
        {values.length === 0 && (
          <Badge variant="destructive">Sem valor: entra como zero no cálculo</Badge>
        )}
      </div>

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
        <Button size="sm" className="gap-1.5" onClick={add} disabled={!valid}>
          <Plus className="h-4 w-4" /> Adicionar vigência
        </Button>
      </div>
      {outOfRange && (
        <p className="text-sm text-destructive">
          Valor fora do intervalo permitido
          {def.min_value !== null && ` (mín. ${fmtValue(def, Number(def.min_value))})`}
          {def.max_value !== null && ` (máx. ${fmtValue(def, Number(def.max_value))})`}.
        </p>
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
              <tr key={v.id} className="border-b border-border last:border-0">
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
                <td className="py-1.5 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Excluir valor"
                    onClick={() => remove(v.id, "Valor excluído.")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
