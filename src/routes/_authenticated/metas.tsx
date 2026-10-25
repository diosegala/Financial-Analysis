import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Calculator, Lock, Unlock } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useUnits } from "@/lib/catalog";
import {
  useRevenueTargets,
  useScenarioTarget,
  useTargetGap,
  useTargetMutations,
  useTargetShares,
  useTargetWeights,
  useVariableParts,
} from "@/lib/targets";
import { MONTHS, fmtBRL, fmtInput, fmtPct, parseNum } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { TargetExplanation } from "@/components/target-explanation";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/metas")({
  head: pageHead(
    "Metas",
    "Alvo de resultado por cenário, receita necessária e distribuição por unidade e mês.",
  ),
  component: MetasPage,
});

const pct = (v: number | null | undefined) => (v == null ? "" : fmtInput(v * 100, 4));
/** Percentual digitado ("60" ou "60%") para fração. null = inválido; "" = vazio. */
const fromPct = (s: string): number | null | "" => {
  if (s.trim() === "") return "";
  const n = parseNum(s);
  return n === null ? null : n / 100;
};

function Card({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function MetasPage() {
  const { data: user, isLoading: loadingUser } = useCurrentUser();
  const { scenario, scenarioId, version } = usePlanning();
  const { data: units } = useUnits();
  const { data: target } = useScenarioTarget(scenarioId);
  const { data: shares } = useTargetShares(scenarioId);
  const { data: weights } = useTargetWeights(scenarioId);
  const { data: revenue } = useRevenueTargets(scenarioId);
  const m = useTargetMutations();
  const business = useMemo(
    () => (units ?? []).filter((u) => u.kind === "negocio" && u.active),
    [units],
  );
  const { data: parts } = useVariableParts(
    business.map((u) => u.id),
    version?.year,
  );
  const computed = !!target?.computed_at;
  const { data: gap } = useTargetGap(scenarioId, computed);

  // Formulários locais, reiniciados quando o cenário ou os dados salvos mudam
  const [kind, setKind] = useState<"resultado" | "margem">("resultado");
  const [value, setValue] = useState("");
  const [finPct, setFinPct] = useState("");
  const [shareText, setShareText] = useState<Record<string, string>>({});
  const [overrideText, setOverrideText] = useState<Record<string, string>>({});
  const [weightText, setWeightText] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setKind((target?.target_kind as "resultado" | "margem" | undefined) ?? "resultado");
    setValue(
      target
        ? target.target_kind === "margem"
          ? pct(Number(target.target_value))
          : fmtInput(Number(target.target_value))
        : "",
    );
    setFinPct(pct(target ? Number(target.financial_variable_pct) : 0));
  }, [target]);
  useEffect(() => {
    setShareText(Object.fromEntries((shares ?? []).map((s) => [s.unit_id, pct(Number(s.share))])));
    setOverrideText(
      Object.fromEntries(
        (shares ?? [])
          .filter((s) => s.variable_pct_override != null)
          .map((s) => [s.unit_id, pct(Number(s.variable_pct_override))]),
      ),
    );
  }, [shares]);
  useEffect(() => {
    const out: Record<string, string[]> = {};
    for (const w of weights ?? []) {
      const key = w.unit_id ?? "padrao";
      out[key] ??= Array(12).fill("");
      out[key]![w.month - 1] = fmtInput(Number(w.weight));
    }
    setWeightText(out);
  }, [weights]);

  if (!loadingUser && user && !user.isFinanceiro) return <Navigate to="/inicio" />;
  if (!scenarioId)
    return <p className="text-sm text-muted-foreground">Escolha um cenário no topo da página.</p>;

  const published = !!target?.published_at;
  const locked = published;
  const sumShares = business.reduce((a, u) => {
    const f = fromPct(shareText[u.id] ?? "");
    return a + (typeof f === "number" ? f : 0);
  }, 0);
  const targetValue = kind === "margem" ? fromPct(value) : parseNum(value);
  const finValue = fromPct(finPct);

  async function act(fn: () => Promise<boolean>) {
    setBusy(true);
    await fn();
    setBusy(false);
  }

  const saveTarget = () =>
    act(() =>
      m.saveTarget(scenarioId!, {
        target_kind: kind,
        target_value: typeof targetValue === "number" ? targetValue : 0,
        financial_variable_pct: typeof finValue === "number" ? finValue : 0,
      }),
    );

  const saveShares = () =>
    act(() =>
      m.saveShares(
        scenarioId!,
        business
          .map((u) => ({
            unit_id: u.id,
            share: fromPct(shareText[u.id] ?? ""),
            variable_pct_override: fromPct(overrideText[u.id] ?? ""),
          }))
          .filter((r) => typeof r.share === "number" && r.share > 0)
          .map((r) => ({
            unit_id: r.unit_id,
            share: r.share as number,
            variable_pct_override:
              typeof r.variable_pct_override === "number" ? r.variable_pct_override : null,
          })),
      ),
    );

  const saveWeights = () =>
    act(() => {
      const rows: { unit_id: string | null; month: number; weight: number }[] = [];
      for (const [key, arr] of Object.entries(weightText)) {
        arr.forEach((t, i) => {
          const n = t.trim() === "" ? null : parseNum(t);
          if (n !== null && n >= 0 && t.trim() !== "")
            rows.push({ unit_id: key === "padrao" ? null : key, month: i + 1, weight: n });
        });
      }
      return m.saveWeights(scenarioId!, rows);
    });

  const meta = new Map<string, number[]>();
  for (const r of revenue ?? []) {
    const arr = meta.get(r.unit_id) ?? Array(12).fill(0);
    arr[r.month - 1] = (arr[r.month - 1] ?? 0) + r.amount;
    meta.set(r.unit_id, arr);
  }
  const monthTotals = MONTHS.map((_, i) =>
    [...meta.values()].reduce((a, arr) => a + (arr[i] ?? 0), 0),
  );
  const rowsOfWeights = [
    { key: "padrao", name: "Padrão (todas as unidades)" },
    ...business.map((u) => ({ key: u.id, name: u.name })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Metas"
        subtitle={`${scenario?.name ?? "…"} · ${version?.name ?? "…"} · O financeiro define o alvo; o app calcula a receita necessária e distribui por unidade e mês. Os líderes só veem a meta depois de publicada.`}
        actions={
          published ? (
            <Badge className="gap-1">
              <Lock className="h-3 w-3" /> Meta publicada
            </Badge>
          ) : (
            <Badge variant="outline">Rascunho</Badge>
          )
        }
      />

      <Card
        title="1. Alvo do cenário"
        hint="Preencha o resultado em reais ou a margem em %: o outro valor é calculado. Cubra a empresa toda (unidades de negócio e áreas de apoio)."
      >
        <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
          <Field label="Tipo de alvo">
            <OptionSelect
              value={kind}
              onChange={(v) => v && setKind(v as "resultado" | "margem")}
              options={[
                { value: "resultado", label: "Resultado em R$" },
                { value: "margem", label: "Margem (%MCL)" },
              ]}
              disabled={locked}
            />
          </Field>
          <Field label={kind === "margem" ? "Margem alvo (%)" : "Resultado alvo (R$)"}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono"
              disabled={locked}
            />
          </Field>
          <Field
            label="Alíquota sobre a receita de apoio (%)"
            hint="Impostos sobre a receita financeira etc. Começa em 0 até a contabilidade definir."
          >
            <Input
              value={finPct}
              onChange={(e) => setFinPct(e.target.value)}
              className="font-mono"
              disabled={locked}
            />
          </Field>
        </div>
        <Button
          onClick={saveTarget}
          disabled={busy || locked || targetValue === null || finValue === null || finValue === ""}
        >
          Salvar alvo
        </Button>
      </Card>

      <Card
        title="2. Participação de cada unidade de negócio"
        hint="Quanto da receita necessária cada unidade assume (somam 100%). A alíquota variável de cada unidade vem das regras de cálculo sobre a receita; digite um valor para trocá-la."
      >
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Unidade</th>
                <th className="px-3 py-2 font-medium">Participação (%)</th>
                <th className="px-3 py-2 font-medium">Alíquota variável (%)</th>
                <th className="px-3 py-2 font-medium">Composição (regras de cálculo)</th>
              </tr>
            </thead>
            <tbody>
              {business.map((u) => {
                const p = parts?.get(u.id) ?? [];
                const calc = p.filter((x) => x.included).reduce((a, x) => a + x.rate, 0);
                return (
                  <tr key={u.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-medium">{u.name}</td>
                    <td className="px-3 py-2">
                      <Input
                        value={shareText[u.id] ?? ""}
                        onChange={(e) => setShareText((s) => ({ ...s, [u.id]: e.target.value }))}
                        className="w-28 font-mono"
                        disabled={locked}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={overrideText[u.id] ?? ""}
                        onChange={(e) => setOverrideText((s) => ({ ...s, [u.id]: e.target.value }))}
                        placeholder={pct(calc)}
                        className="w-28 font-mono"
                        disabled={locked}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {p.length === 0
                        ? "Nenhuma regra sobre a receita."
                        : p
                            .map(
                              (x) =>
                                `${x.rule_name} ${fmtPct(x.rate)}${x.included ? "" : " (fora: vale só para alguns tipos)"}`,
                            )
                            .join(" · ")}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="px-3 py-2">Total</td>
                <td
                  className={`px-3 py-2 font-mono ${Math.abs(sumShares - 1) > 0.0001 ? "text-destructive" : ""}`}
                >
                  {fmtPct(sumShares)}
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
        <Button onClick={saveShares} disabled={busy || locked}>
          Salvar participações
        </Button>
      </Card>

      <Card
        title="3. Sazonalidade por mês"
        hint="Peso de cada mês na meta, em qualquer escala (ex.: 1, 1, 2…). Em branco, os 12 meses valem igual. A linha de uma unidade vale no lugar do padrão."
      >
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="min-w-48 px-3 py-2 font-medium">Unidade</th>
                {MONTHS.map((mo) => (
                  <th key={mo} className="px-1 py-2 text-right font-medium">
                    {mo}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsOfWeights.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="px-3 py-1.5">{r.name}</td>
                  {MONTHS.map((mo, i) => (
                    <td key={mo} className="px-1 py-1">
                      <Input
                        value={weightText[r.key]?.[i] ?? ""}
                        onChange={(e) =>
                          setWeightText((w) => {
                            const arr = [...(w[r.key] ?? Array(12).fill(""))];
                            arr[i] = e.target.value;
                            return { ...w, [r.key]: arr };
                          })
                        }
                        aria-label={`Peso de ${mo} para ${r.name}`}
                        className="h-8 w-16 px-2 text-right font-mono text-xs"
                        disabled={locked}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button onClick={saveWeights} disabled={busy || locked}>
          Salvar sazonalidade
        </Button>
      </Card>

      <Card
        title="4. Receita necessária e meta por unidade e mês"
        hint="Calcule depois de salvar o alvo, as participações e a sazonalidade. Os custos vêm do que já foi lançado nas grades (folha, encargos, despesas) de todas as unidades."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            className="gap-1.5"
            onClick={() => act(() => m.compute(scenarioId))}
            disabled={busy || locked || !target}
          >
            <Calculator className="h-4 w-4" /> Calcular meta
          </Button>
          {published ? (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => act(() => m.publish(scenarioId, false))}
              disabled={busy}
            >
              <Unlock className="h-4 w-4" /> Reabrir meta
            </Button>
          ) : (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => act(() => m.publish(scenarioId, true))}
              disabled={busy || !target?.feasible}
            >
              <Lock className="h-4 w-4" /> Publicar meta
            </Button>
          )}
        </div>
        {!computed && <p className="text-sm text-muted-foreground">Ainda não calculada.</p>}
        {computed && target && (
          <>
            {!target.feasible && (
              <p className="flex items-center gap-2 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> Alvo inviável: com{" "}
                {fmtPct(Number(target.variable_pct))} de custos variáveis, nenhuma receita fecha
                esta margem. Reduza o alvo ou as alíquotas.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat
                label="Receita necessária (unidades de negócio)"
                value={
                  target.required_revenue == null ? "—" : fmtBRL(Number(target.required_revenue))
                }
              />
              <Stat
                label="Custos que não dependem da receita"
                value={fmtBRL(Number(target.fixed_costs))}
                hint="Todas as unidades: folha, encargos, provisões, benefícios e despesas"
              />
              <Stat
                label="Receita das áreas de apoio"
                value={fmtBRL(Number(target.financial_revenue))}
              />
              <Stat
                label="Alíquota variável ponderada"
                value={fmtPct(Number(target.variable_pct))}
                hint="Impostos e comissões sobre a receita"
              />
              <Stat
                label="Resultado alvo"
                value={target.target_amount == null ? "—" : fmtBRL(Number(target.target_amount))}
              />
              <Stat
                label="Margem alvo"
                value={target.target_margin == null ? "—" : fmtPct(Number(target.target_margin))}
              />
            </div>
            <TargetExplanation target={target} />
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="min-w-40 px-3 py-2 font-medium">Unidade</th>
                    {MONTHS.map((mo) => (
                      <th key={mo} className="px-2 py-2 text-right font-medium">
                        {mo}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {business
                    .filter((u) => meta.has(u.id))
                    .map((u) => {
                      const arr = meta.get(u.id)!;
                      return (
                        <tr key={u.id} className="border-t border-border">
                          <td className="px-3 py-1.5 font-medium">{u.name}</td>
                          {arr.map((v, i) => (
                            <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                              {fmtBRL(v)}
                            </td>
                          ))}
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                            {fmtBRL(arr.reduce((a, v) => a + v, 0))}
                          </td>
                        </tr>
                      );
                    })}
                  <tr className="border-t border-border bg-muted/30 font-semibold">
                    <td className="px-3 py-1.5">Total</td>
                    {monthTotals.map((t, i) => (
                      <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(t)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(monthTotals.reduce((a, t) => a + t, 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {computed && gap && (
        <Card
          title="5. Caminho para o alvo"
          hint="Com o que já foi lançado até agora (receita dos líderes e custos), quanto falta para o alvo e que parte poderia vir de redução de custos."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Receita lançada" value={fmtBRL(gap.revenue)} />
            <Stat label="Custos variáveis" value={fmtBRL(gap.variable_costs)} />
            <Stat label="Folha, encargos e benefícios" value={fmtBRL(gap.payroll)} />
            <Stat label="Despesas" value={fmtBRL(gap.expenses)} />
            <Stat label="Resultado com o plano de hoje" value={fmtBRL(gap.result)} />
            <Stat label="Resultado alvo" value={fmtBRL(gap.target_amount)} />
            <Stat
              label={gap.gap > 0 ? "Falta para o alvo" : "Acima do alvo"}
              value={fmtBRL(Math.abs(gap.gap))}
            />
          </div>
          {gap.gap > 0 && gap.payroll + gap.expenses > 0 && (
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                Se a receita lançada não crescer, o fechamento por custos pede:
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                <li>
                  Só folha: reduzir <strong className="text-foreground">{fmtBRL(gap.gap)}</strong> (
                  {gap.gap > gap.payroll
                    ? "mais que toda a folha: inviável só por aqui"
                    : `${fmtPct(gap.gap / gap.payroll)} da folha e encargos`}
                  ).
                </li>
                <li>
                  Só despesas: reduzir{" "}
                  <strong className="text-foreground">{fmtBRL(gap.gap)}</strong> (
                  {gap.gap > gap.expenses
                    ? "mais que todas as despesas: inviável só por aqui"
                    : `${fmtPct(gap.gap / gap.expenses)} das despesas`}
                  ).
                </li>
                <li>
                  Proporcional: {fmtPct(gap.gap / (gap.payroll + gap.expenses))} em ambos, ou seja{" "}
                  {fmtBRL((gap.gap * gap.payroll) / (gap.payroll + gap.expenses))} em folha e{" "}
                  {fmtBRL((gap.gap * gap.expenses) / (gap.payroll + gap.expenses))} em despesas.
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                Para testar um corte, use as variações de despesa e de folha do cenário na página
                Cenários e calcule de novo.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
