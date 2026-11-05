import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Database, Lock, Unlock } from "lucide-react";
import { pageHead } from "@/lib/head";
import { OmieSync } from "@/components/omie-sync";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, useUnits } from "@/lib/catalog";
import {
  companyResults,
  plannedCosts,
  plannedResult,
  SUPPORT_BASIS_LABELS,
  useGuardrailMutations,
  useSupportAllocation,
  useSupportShares,
  useGuardrailSettings,
  useGuardrailUnits,
  useGuardrails,
} from "@/lib/guardrails";
import { fmtBRL, fmtPct } from "@/lib/format";
import {
  SUBMISSION_LABELS,
  useSetUnitStatus,
  useSubmissions,
  type SubmissionStatus,
} from "@/lib/submissions";
import { Situation } from "@/components/category-grid";
import { DreTable } from "@/components/dre-table";
import { Field } from "@/components/form-fields";
import { NumberCell } from "@/components/number-cell";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/plano")({
  head: pageHead(
    "Plano CUPOLA",
    "O plano da empresa por unidade: receita, custos, limite e resultado.",
  ),
  component: PlanoPage,
});

function Big({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-mono text-xl font-semibold tabular-nums ${bad ? "text-destructive" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function PlanoPage() {
  const { versionId, scenarioId, version } = usePlanning();
  const { data: user, isLoading } = useCurrentUser();
  const { data: units } = useUnits();
  const { data: settings } = useGuardrailSettings(scenarioId);
  const { data: rows } = useGuardrailUnits(scenarioId);
  const { data: guardrails } = useGuardrails(scenarioId);
  const { data: submissions } = useSubmissions(versionId);
  const { data: allocation } = useSupportAllocation(scenarioId);
  const { data: customShares } = useSupportShares(scenarioId, !!user?.isFinanceiro);
  const setUnitStatus = useSetUnitStatus();
  const m = useGuardrailMutations(scenarioId);
  const [busy, setBusy] = useState(false);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [returning, setReturning] = useState<{ id: string; name: string } | null>(null);
  const [comment, setComment] = useState("");
  const [showDre, setShowDre] = useState(false);

  if (!isLoading && user && !user.isManagement) return <Navigate to="/planejamento" />;

  const isFin = !!user?.isFinanceiro;
  const published = !!settings?.published_at;
  const locked = !isFin || published;
  const unitMap = byId(units);
  const typed = new Map((rows ?? []).map((r) => [r.unit_id, r]));
  const statusOf = new Map((submissions ?? []).map((s) => [s.unit_id, s]));
  const list = [...(guardrails ?? [])].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) * -1 ||
      (unitMap.get(a.unitId)?.sort_order ?? 0) - (unitMap.get(b.unitId)?.sort_order ?? 0),
  );
  const target = Number(settings?.result_target ?? 0);
  const { compromisso, lancado } = companyResults(list);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const sumBy = (fn: (g: (typeof list)[number]) => number) => list.reduce((a, g) => a + fn(g), 0);
  const supportTotal = (allocation ?? []).reduce((t, x) => t + x.cost, 0);
  const cutOf = (kind: string) =>
    list
      .filter((g) => (kind === "negocio" ? g.kind === "negocio" : g.kind !== "negocio"))
      .reduce((t, g) => t + (g.baseExpense + g.basePayroll - g.ceiling), 0);
  const activeIds = (units ?? []).filter((u) => u.active).map((u) => u.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Plano CUPOLA"
        subtitle={`${version?.name ?? "…"} · Cada unidade recebe receita-compromisso e limite de custos; o diretor preenche o Planejamento da unidade.`}
        actions={
          isFin && (
            <div className="flex flex-wrap items-center gap-2">
              {published ? (
                <Badge className="gap-1">
                  <Lock className="h-3 w-3" /> Publicado para os diretores
                </Badge>
              ) : (
                <Badge variant="outline">Rascunho</Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={busy || published}
                onClick={() => void run(m.suggest)}
              >
                <Database className="h-4 w-4" /> Calcular com o realizado de 2026
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || published}
                onClick={() => setConfirmLoad(true)}
              >
                Trazer despesas do ano anterior
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy || !settings?.suggested_at}
                onClick={() => void run(() => m.publish(!published))}
              >
                {published ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {published ? "Reabrir" : "Publicar para os diretores"}
              </Button>
            </div>
          )
        }
      />

      <section className="grid gap-4 rounded-md border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Resultado alvo da empresa (R$ no ano)">
          <NumberCell
            className="w-full"
            label="Resultado alvo"
            value={settings ? target : null}
            disabled={locked}
            onSave={(v) => void m.saveSettings({ result_target: v ?? 0 })}
          />
        </Field>
        <Field label="Corte de custos (%)">
          <NumberCell
            className="w-full"
            percent
            label="Corte de custos"
            value={settings ? Number(settings.cost_cut_pct) : null}
            disabled={locked}
            onSave={(v) => void m.saveSettings({ cost_cut_pct: v ?? 0 })}
          />
        </Field>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {settings?.suggested_at
            ? `Ano base ${settings.base_year}: realizado do Omie até o último mês fechado, com os meses que faltam projetados. Limite de despesas = despesas de 2026 no Omie menos o corte. Limite de folha = custo atual da folha menos o corte. Para um caso especial, digite o valor; vazio volta para o cálculo.`
            : "Clique em Calcular com o realizado de 2026 para obter a receita e o custo-base de cada unidade."}
          {Number(settings?.unassigned_revenue ?? 0) > 0 &&
            ` Há ${fmtBRL(Number(settings?.unassigned_revenue))} de receita do Omie sem unidade: distribua digitando a receita das unidades.`}
        </p>
      </section>

      <OmieSync />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Big label="Resultado alvo" value={fmtBRL(target)} />
        <Big
          label="Resultado se todos cumprirem"
          value={fmtBRL(compromisso)}
          bad={compromisso < target}
        />
        <Big
          label="Diferença para o alvo"
          value={fmtBRL(compromisso - target)}
          bad={compromisso < target}
        />
        <Big label="Resultado com o que já foi lançado" value={fmtBRL(lancado)} />
      </section>

      <p className="text-sm text-muted-foreground">
        Os campos de receita-compromisso e de limite vêm calculados. Para fixar outro valor em uma
        unidade, clique no campo e digite. Vazio, vale o cálculo.
      </p>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="px-3 py-2 font-medium">Unidade</th>
              <th className="px-3 py-2 text-right font-medium">Receita-compromisso</th>
              <th className="px-3 py-2 text-right font-medium">Receita lançada</th>
              <th className="px-3 py-2 text-right font-medium">Limite de despesas</th>
              <th className="px-3 py-2 text-right font-medium">Limite de folha</th>
              <th className="px-3 py-2 text-right font-medium">Custos lançados</th>
              <th className="px-3 py-2 text-right font-medium">Situação</th>
              <th className="px-3 py-2 text-right font-medium">Resultado</th>
              <th className="px-3 py-2 font-medium">Envio</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.map((g) => {
              const t = typed.get(g.unitId);
              const name = unitMap.get(g.unitId)?.name ?? "—";
              const s = statusOf.get(g.unitId);
              const status = (s?.status ?? "rascunho") as SubmissionStatus;
              return (
                <tr key={g.unitId} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 font-medium">
                    <Link
                      to="/planejamento"
                      search={(prev: Record<string, unknown>) => ({ ...prev, u: g.unitId })}
                      className="underline-offset-2 hover:underline"
                    >
                      {name}
                    </Link>
                    {s?.comment && (
                      <div
                        className="max-w-56 truncate text-xs font-normal text-muted-foreground"
                        title={s.comment}
                      >
                        {s.comment}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {g.kind === "negocio" ? (
                      <NumberCell
                        label={`Receita-compromisso de ${name}`}
                        value={t?.floor_amount != null ? Number(t.floor_amount) : null}
                        placeholder={fmtBRL(g.floorSuggested ?? 0)}
                        className="w-32 placeholder:text-foreground"
                        disabled={locked}
                        onSave={(v) => void m.saveUnit(g.unitId, { floor_amount: v })}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(g.plannedRevenue)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <NumberCell
                      label={`Limite de despesas de ${name}`}
                      value={t?.expense_limit != null ? Number(t.expense_limit) : null}
                      placeholder={fmtBRL(g.expenseLimitAuto)}
                      className="w-32 placeholder:text-foreground"
                      disabled={locked}
                      onSave={(v) => void m.saveUnit(g.unitId, { expense_limit: v })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <NumberCell
                      label={`Limite de folha de ${name}`}
                      value={t?.payroll_limit != null ? Number(t.payroll_limit) : null}
                      placeholder={fmtBRL(g.payrollLimitAuto)}
                      className="w-32 placeholder:text-foreground"
                      disabled={locked}
                      onSave={(v) => void m.saveUnit(g.unitId, { payroll_limit: v })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(plannedCosts(g))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    <Situation
                      planned={plannedCosts(g)}
                      limit={g.ceiling}
                      pending={!settings?.suggested_at}
                    />
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                      plannedResult(g) < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {fmtBRL(plannedResult(g))}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge
                      variant={
                        status === "aprovado"
                          ? "default"
                          : status === "devolvido"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {SUBMISSION_LABELS[status]}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {isFin && version?.status !== "travado" && status === "enviado" && (
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          onClick={() => void setUnitStatus(versionId!, g.unitId, "aprovado")}
                        >
                          Aprovar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setComment("");
                            setReturning({ id: g.unitId, name });
                          }}
                        >
                          Devolver
                        </Button>
                      </div>
                    )}
                    {isFin && version?.status !== "travado" && status === "aprovado" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void setUnitStatus(versionId!, g.unitId, "rascunho")}
                      >
                        Reabrir
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {list.length > 0 && (
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="px-3 py-1.5">CUPOLA</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(sumBy((g) => g.floor ?? 0))}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(sumBy((g) => g.plannedRevenue))}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(sumBy((g) => g.expenseLimit))}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(sumBy((g) => g.payrollLimit))}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                  {fmtBRL(sumBy(plannedCosts))}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {fmtPct(
                    sumBy((g) => g.ceiling) ? sumBy(plannedCosts) / sumBy((g) => g.ceiling) : 0,
                  )}{" "}
                  do limite
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmtBRL(lancado)}</td>
                <td colSpan={2} />
              </tr>
            )}
            {list.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                  Clique em Calcular com o realizado de 2026 para começar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <div>
          <h2 className="text-lg font-semibold">Peso das áreas de apoio nas unidades</h2>
          <p className="text-sm text-muted-foreground">
            As áreas de apoio custam {fmtBRL(supportTotal)} no plano, divididos{" "}
            {SUPPORT_BASIS_LABELS[allocation?.[0]?.basis ?? "igual"]}.
            {isFin &&
              " Digite o percentual em Critério para mudar a divisão; vazio em todas volta para o cálculo pela receita."}
          </p>
        </div>
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Unidade</th>
                <th className="px-3 py-2 text-right font-medium">Receita lançada</th>
                <th className="px-3 py-2 text-right font-medium">Resultado direto</th>
                <th className="px-3 py-2 text-right font-medium">Parte do apoio</th>
                <th className="px-3 py-2 text-right font-medium">Apoio rateado</th>
                <th className="px-3 py-2 text-right font-medium">Resultado após apoio</th>
                <th className="px-3 py-2 text-right font-medium">Apoio / receita</th>
                {isFin && <th className="px-3 py-2 text-right font-medium">Critério (%)</th>}
              </tr>
            </thead>
            <tbody>
              {list
                .filter((g) => g.kind === "negocio")
                .map((g) => {
                  const a = allocation?.find((x) => x.unitId === g.unitId);
                  const name = unitMap.get(g.unitId)?.name ?? "—";
                  const after = plannedResult(g) - (a?.cost ?? 0);
                  return (
                    <tr key={g.unitId} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5 font-medium">{name}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(g.plannedRevenue)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(plannedResult(g))}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtPct(a?.share ?? 0)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(a?.cost ?? 0)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${after < 0 ? "text-destructive" : ""}`}
                      >
                        {fmtBRL(after)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {g.plannedRevenue ? fmtPct((a?.cost ?? 0) / g.plannedRevenue) : "—"}
                      </td>
                      {isFin && (
                        <td className="px-3 py-1.5 text-right">
                          <NumberCell
                            className="ml-auto w-24"
                            percent
                            label={`Critério de ${name}`}
                            value={customShares?.get(g.unitId) ?? null}
                            disabled={locked}
                            onSave={(v) => void m.saveSupportShare(g.unitId, v)}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Big
            label="O corte nas unidades de negócio representa"
            value={fmtBRL(cutOf("negocio"))}
          />
          <Big label="O corte nas áreas de apoio representa" value={fmtBRL(cutOf("apoio"))} />
        </div>
      </section>

      <div className="space-y-2">
        <Button variant="outline" size="sm" onClick={() => setShowDre(!showDre)}>
          {showDre ? "Esconder a DRE da empresa" : "Ver a DRE da empresa"}
        </Button>
        {showDre && <DreTable unitIds={activeIds} title="CUPOLA" />}
      </div>

      <Dialog open={confirmLoad} onOpenChange={setConfirmLoad}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trazer as despesas do ano anterior?</DialogTitle>
            <DialogDescription>
              Em todas as unidades, cada categoria sem lançamento recebe uma linha com os valores do
              ano anterior, para o diretor reduzir o que precisar. O que já foi lançado não muda.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLoad(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                setConfirmLoad(false);
                void run(async () => {
                  for (const id of activeIds) await m.loadReference(versionId!, id);
                });
              }}
            >
              Trazer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!returning} onOpenChange={(o) => !o && setReturning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Devolver {returning?.name} para ajuste</DialogTitle>
          </DialogHeader>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="O que precisa ser ajustado?"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturning(null)}>
              Cancelar
            </Button>
            <Button
              disabled={!comment.trim()}
              onClick={async () => {
                if (returning)
                  await setUnitStatus(versionId!, returning.id, "devolvido", comment.trim());
                setReturning(null);
              }}
            >
              Devolver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
