import { useEffect, useState, type ReactNode } from "react";
import { Database, Lock, Unlock } from "lucide-react";
import { usePlanning } from "@/lib/planning";
import { byId, useUnits } from "@/lib/catalog";
import {
  DISTRIBUTION_LABELS,
  scenarioResults,
  useGuardrailMutations,
  useGuardrailSettings,
  useGuardrailUnits,
  useGuardrails,
  type Distribution,
  type Guardrail,
} from "@/lib/guardrails";
import { MONTHS, fmtBRL, fmtInput, fmtPct, parseNum } from "@/lib/format";
import { Field, OptionSelect } from "@/components/form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Campo numérico que grava ao sair. Vazio = volta para a sugestão (null). */
function NumberCell({
  value,
  onSave,
  disabled,
  placeholder,
  percent,
  className = "w-32",
}: {
  value: number | null;
  onSave: (v: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  percent?: boolean;
  className?: string;
}) {
  const show = (v: number | null) =>
    v === null ? "" : percent ? fmtInput(v * 100, 2) : fmtInput(v, 0);
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input
      className={`h-8 text-right ${className}`}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() === "") return value !== null && onSave(null);
        const n = parseNum(text);
        if (n === null) return setText(show(value));
        const v = percent ? n / 100 : n;
        if (v !== value) onSave(v);
      }}
    />
  );
}

const money = (v: number | null | undefined, signed = false) =>
  v == null ? (
    "—"
  ) : (
    <span className={`font-mono tabular-nums ${signed && v < 0 ? "text-destructive" : ""}`}>
      {fmtBRL(v)}
    </span>
  );

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Folga (positiva) ou corte necessário (negativa) entre o teto e a despesa lançada sem condicionadas. */
function Slack({ g }: { g: Guardrail }) {
  const v = g.ceiling - g.plannedExpense;
  return v >= 0 ? (
    <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
      folga {fmtBRL(v)}
    </span>
  ) : (
    <span className="font-mono font-semibold tabular-nums text-destructive">
      cortar {fmtBRL(-v)}
    </span>
  );
}

/**
 * Piso e teto: o financeiro define o resultado alvo e o piso de receita de cada unidade (sugerido pelo ano base
 * projetado); o app calcula a contribuição e o teto de despesa de cada uma e o teto das áreas de apoio.
 */
export function GuardrailsPanel() {
  const { scenarioId, version, scenario } = usePlanning();
  const { data: settings } = useGuardrailSettings(scenarioId);
  const { data: unitRows } = useGuardrailUnits(scenarioId);
  const { data: rows, isLoading } = useGuardrails(scenarioId);
  const { data: units } = useUnits();
  const unitMap = byId(units);
  const m = useGuardrailMutations(scenarioId);
  const [busy, setBusy] = useState(false);
  const published = !!settings?.published_at;
  const typed = new Map((unitRows ?? []).map((r) => [r.unit_id, r]));
  const name = (id: string) => unitMap.get(id)?.name ?? "—";
  const business = (rows ?? []).filter((r) => r.kind === "negocio");
  const support = (rows ?? []).filter((r) => r.kind !== "negocio");
  const required = business.reduce((a, r) => a + (r.contribution ?? 0), 0);
  const { trava, plano } = scenarioResults(rows ?? []);
  const target = Number(settings?.result_target ?? 0);
  const closed = settings?.base_closed_month ?? 0;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Piso e teto</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {scenario?.name ?? "…"} · {version?.name ?? "…"}. Cada unidade de negócio planeja com o
            piso de receita (o que já vende) e recebe um teto de despesa que garante o resultado
            alvo. Receita acima do piso não aumenta o teto: a despesa que depende dela é lançada
            como condicionada.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {published ? (
            <Badge className="gap-1">
              <Lock className="h-3 w-3" /> Publicado para os líderes
            </Badge>
          ) : (
            <Badge variant="outline">Rascunho</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy || published}
            onClick={() => run(m.suggest)}
          >
            <Database className="h-4 w-4" /> Buscar realizado do Omie
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || !settings}
            onClick={() => run(() => m.publish(!published))}
          >
            {published ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            {published ? "Reabrir" : "Publicar para os líderes"}
          </Button>
        </div>
      </div>

      <section className="grid gap-4 rounded-md border border-border bg-card p-4 md:grid-cols-4">
        <Field label="Resultado alvo da empresa (R$ no ano)">
          <NumberCell
            className="w-full"
            value={settings ? target : null}
            disabled={published}
            onSave={(v) => void m.saveSettings({ result_target: v ?? 0 })}
          />
        </Field>
        <Field
          label="Ajuste do piso (%)"
          hint="Aplicado sobre o ano base projetado. Ex.: −10 para ser conservador."
        >
          <NumberCell
            className="w-full"
            percent
            value={settings ? Number(settings.floor_adjust_pct) : null}
            disabled={published}
            onSave={(v) => void m.saveSettings({ floor_adjust_pct: v ?? 0 })}
          />
        </Field>
        <Field
          label="Corte sugerido no apoio (%)"
          hint="Teto sugerido de cada área = despesa lançada menos este %."
        >
          <NumberCell
            className="w-full"
            percent
            value={settings ? Number(settings.support_cut_pct) : null}
            disabled={published}
            onSave={(v) => void m.saveSettings({ support_cut_pct: v ?? 0 })}
          />
        </Field>
        <Field label="Divisão da contribuição entre as unidades">
          <OptionSelect
            value={settings?.distribution ?? "piso"}
            disabled={published}
            onChange={(v) => void m.saveSettings({ distribution: (v as Distribution) ?? "piso" })}
            options={Object.entries(DISTRIBUTION_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Field>
        <p className="text-xs text-muted-foreground md:col-span-4">
          {settings?.suggested_at
            ? `Piso sugerido = recebido em ${settings.base_year} até ${MONTHS[closed - 1] ?? "—"} (Omie)${
                closed < 12 ? ` + ${12 - closed} mês(es) projetados pela média dos 3 últimos` : ""
              }, com o ajuste. Digite o piso para incluir o que não está no Omie; vazio volta para a sugestão.`
            : "Clique em Buscar realizado do Omie para sugerir o piso de cada unidade pelo ano base projetado."}
          {Number(settings?.unassigned_revenue ?? 0) > 0 &&
            ` Há ${fmtBRL(Number(settings?.unassigned_revenue))} de receita do Omie sem unidade: distribua digitando os pisos.`}
        </p>
      </section>

      {!settings ? null : isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Contribuição exigida das unidades"
              value={money(required)}
              hint="Resultado alvo + tetos do apoio − receita do apoio"
            />
            <Stat
              label="Cenário trava (só o piso)"
              value={money(trava, true)}
              hint={
                trava >= target
                  ? "Atinge o alvo com a despesa lançada"
                  : `${fmtBRL(target - trava)} abaixo do alvo`
              }
            />
            <Stat
              label="Cenário plano (tudo o que foi lançado)"
              value={money(plano, true)}
              hint="Receita planejada e todas as despesas, inclusive condicionadas"
            />
            <Stat
              label="Plano − trava"
              value={money(plano - trava, true)}
              hint={
                plano >= trava
                  ? "Quanto do plano depende de vender acima do piso"
                  : "O plano lançado ainda está abaixo do piso: faltam receitas a lançar"
              }
            />
          </div>

          <section className="space-y-2">
            <h3 className="font-semibold">Unidades de negócio</h3>
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-right">
                    <th className="px-3 py-2 text-left font-medium">Unidade</th>
                    <th className="px-3 py-2 font-medium">Piso sugerido</th>
                    <th className="px-3 py-2 font-medium">Piso</th>
                    <th className="px-3 py-2 font-medium">Variável</th>
                    <th className="px-3 py-2 font-medium">Participação</th>
                    <th className="px-3 py-2 font-medium">Contribuição</th>
                    <th className="px-3 py-2 font-medium">Teto de despesa</th>
                    <th className="px-3 py-2 font-medium">Despesa lançada</th>
                    <th className="px-3 py-2 font-medium">Condicionadas</th>
                    <th className="px-3 py-2 font-medium">Folga / corte</th>
                  </tr>
                </thead>
                <tbody>
                  {business.map((g) => (
                    <tr key={g.unitId} className="border-b border-border text-right">
                      <td className="px-3 py-1.5 text-left">{name(g.unitId)}</td>
                      <td className="px-3 py-1.5">{money(g.floorSuggested)}</td>
                      <td className="px-3 py-1.5">
                        <NumberCell
                          value={typed.get(g.unitId)?.floor_amount ?? null}
                          placeholder={
                            g.floorSuggested != null ? fmtInput(g.floorSuggested, 0) : ""
                          }
                          disabled={published}
                          onSave={(v) => void m.saveUnit(g.unitId, { floor_amount: v })}
                        />
                      </td>
                      <td className="px-3 py-1.5">{fmtPct(g.variableRate)}</td>
                      <td className="px-3 py-1.5">
                        {settings.distribution === "manual" ? (
                          <NumberCell
                            className="w-20"
                            percent
                            value={typed.get(g.unitId)?.manual_share ?? null}
                            disabled={published}
                            onSave={(v) => void m.saveUnit(g.unitId, { manual_share: v })}
                          />
                        ) : (
                          fmtPct(g.share ?? 0)
                        )}
                      </td>
                      <td className="px-3 py-1.5">{money(g.contribution)}</td>
                      <td className="px-3 py-1.5 font-semibold">{money(g.ceiling, true)}</td>
                      <td className="px-3 py-1.5">{money(g.plannedExpense)}</td>
                      <td className="px-3 py-1.5">
                        {g.conditionalExpense ? money(g.conditionalExpense) : "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <Slack g={g} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Áreas de apoio</h3>
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-right">
                    <th className="px-3 py-2 text-left font-medium">Área</th>
                    <th className="px-3 py-2 font-medium">Despesa lançada</th>
                    <th className="px-3 py-2 font-medium">Teto sugerido</th>
                    <th className="px-3 py-2 font-medium">Teto</th>
                    <th className="px-3 py-2 font-medium">Condicionadas</th>
                    <th className="px-3 py-2 font-medium">Folga / corte</th>
                  </tr>
                </thead>
                <tbody>
                  {support.map((g) => (
                    <tr key={g.unitId} className="border-b border-border text-right">
                      <td className="px-3 py-1.5 text-left">{name(g.unitId)}</td>
                      <td className="px-3 py-1.5">{money(g.plannedExpense)}</td>
                      <td className="px-3 py-1.5">{money(g.ceilingSuggested)}</td>
                      <td className="px-3 py-1.5">
                        <NumberCell
                          value={typed.get(g.unitId)?.ceiling_amount ?? null}
                          placeholder={
                            g.ceilingSuggested != null ? fmtInput(g.ceilingSuggested, 0) : ""
                          }
                          disabled={published}
                          onSave={(v) => void m.saveUnit(g.unitId, { ceiling_amount: v })}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        {g.conditionalExpense ? money(g.conditionalExpense) : "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <Slack g={g} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Despesa lançada = folha, encargos e despesas do plano, sem as condicionadas. Teto da
              unidade = piso × (1 − variável) − contribuição. A soma fecha com o resultado alvo.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
