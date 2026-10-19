import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useDreLines, useScenarios, useTableMutations, type Scenario } from "@/lib/catalog";
import { dreValue, fmtLine, lineLabel, useDreReport } from "@/lib/dre";
import { fmtInput, parseNum } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authenticated/cenarios")({
  head: pageHead("Cenários", "Variações de cenário e comparação lado a lado."),
  component: CenariosPage,
});

function CenariosPage() {
  const { unit, unitId, version, versionId } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: scenarios } = useScenarios(versionId);
  const { data: lines } = useDreLines();
  const { update } = useTableMutations("scenarios");
  const queryClient = useQueryClient();
  const canEdit = !!user?.isFinanceiro && version?.status !== "travado";

  async function saveVariation(
    s: Scenario,
    field: "revenue_variation" | "expense_variation",
    input: HTMLInputElement,
  ) {
    const current = Number(s[field]);
    const pct = parseNum(input.value);
    if (pct === null) {
      toast.error("Valor inválido. Use, por exemplo, 10 ou -5,5.");
      input.value = fmtInput(current * 100);
      return;
    }
    if (Math.abs(pct / 100 - current) < 1e-9) return;
    await update(s.id, { [field]: pct / 100 });
    await queryClient.invalidateQueries({ queryKey: ["dre"] });
  }

  async function setOfficial(id: string) {
    const { error } = await supabase.rpc("set_official_scenario", { _scenario_id: id });
    if (error) {
      toast.error(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
  }

  const compareLines = (lines ?? []).filter((l) => l.active);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cenários"
        subtitle={`${version?.name ?? "…"} · O cenário base é lançado; os outros são variações percentuais.`}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {scenarios.map((s) => (
          <div key={s.id} className="space-y-3 rounded-md border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{s.name}</span>
              {s.is_official ? (
                <Badge>Oficial</Badge>
              ) : canEdit ? (
                <Button variant="outline" size="sm" onClick={() => setOfficial(s.id)}>
                  Marcar oficial
                </Button>
              ) : null}
            </div>
            {(["revenue_variation", "expense_variation"] as const).map((field) => (
              <label key={field} className="block text-sm">
                <span className="text-muted-foreground">
                  {field === "revenue_variation"
                    ? "Variação de receita (%)"
                    : "Variação de despesa (%)"}
                </span>
                <input
                  key={`${s.id}-${field}-${s[field]}`}
                  type="text"
                  inputMode="decimal"
                  disabled={!canEdit}
                  defaultValue={fmtInput(Number(s[field]) * 100)}
                  onBlur={(e) => saveVariation(s, field, e.target)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums disabled:opacity-60"
                />
              </label>
            ))}
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                A variação de despesa também se aplica à folha
              </span>
              <Switch
                checked={s.applies_to_payroll}
                disabled={!canEdit}
                onCheckedChange={async (v) => {
                  await update(s.id, { applies_to_payroll: v });
                  await queryClient.invalidateQueries({ queryKey: ["dre"] });
                }}
              />
            </label>
          </div>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Comparação no ano · {unit?.name ?? "…"}</h2>
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Linha</th>
                {scenarios.map((s) => (
                  <th key={s.id} className="px-3 py-2 text-right font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compareLines.map((line) => (
                <tr key={line.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">{lineLabel(line)}</td>
                  {scenarios.map((s) => (
                    <ScenarioCell
                      key={s.id}
                      scenarioId={s.id}
                      versionId={versionId}
                      unitId={unitId}
                      lineId={line.id}
                    >
                      {(v) => (
                        <span
                          className={
                            line.kind !== "lancada" && line.kind !== "calculada" && v < 0
                              ? "text-destructive"
                              : ""
                          }
                        >
                          {fmtLine(line, v)}
                        </span>
                      )}
                    </ScenarioCell>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ScenarioCell({
  scenarioId,
  versionId,
  unitId,
  lineId,
  children,
}: {
  scenarioId: string;
  versionId: string | null;
  unitId: string | null;
  lineId: string;
  children: (v: number) => React.ReactNode;
}) {
  // React Query deduplica: uma consulta por cenário, compartilhada entre as linhas.
  const { data: values } = useDreReport(versionId, scenarioId, unitId ? [unitId] : []);
  return (
    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
      {values ? children(dreValue(values, lineId, 0)) : "—"}
    </td>
  );
}
