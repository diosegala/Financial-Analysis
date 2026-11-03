import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Send } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useDreLines } from "@/lib/catalog";
import { boardLines } from "@/lib/board";
import { dreValue, useDreReport } from "@/lib/dre";
import { fmtBRL } from "@/lib/format";
import { plannedCosts, useGuardrailSettings, useGuardrails } from "@/lib/guardrails";
import { usePersonLines } from "@/lib/payroll";
import { usePlanLines } from "@/lib/plan-data";
import { useSetUnitStatus } from "@/lib/submissions";
import { useCurrentUser } from "@/lib/auth";
import { CategoryGrid } from "@/components/category-grid";
import { DreTable } from "@/components/dre-table";
import { PeopleStep } from "@/components/people-step";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/planejamento")({
  head: pageHead("Planejamento", "O planejamento da unidade: pessoas, despesas, receitas e envio."),
  component: PlanejamentoPage,
});

type Step = 1 | 2 | 3 | 4;

const STEP_HELP: Record<Step, string> = {
  1: "A folha da unidade já vem carregada. Ajuste salários, saídas, entradas e benefícios: o custo com encargos, 13º e férias é calculado sozinho.",
  2: "Cada categoria mostra o gasto do ano anterior e o limite com o corte. Ajuste o valor de 2027: ele é dividido igualmente pelos 12 meses (para valores diferentes, use Mês a mês). Pode passar em uma categoria se sobrar em outra: o que vale é o total.",
  3: "Lance a receita por categoria, com o recebido no ano anterior ao lado. Dentro de cada categoria, adicione um cliente por linha, com o valor por mês e o período.",
  4: "Este é o resultado final da unidade, como será apresentado. Confira e envie para aprovação.",
};

/** O topo que não sai da tela: os números que a unidade precisa fechar. */
function UnitSummary() {
  const { unitId, versionId, scenarioId } = usePlanning();
  const { data: guardrails } = useGuardrails(scenarioId);
  const { data: lines } = useDreLines();
  const { data: values } = useDreReport(versionId, scenarioId, unitId ? [unitId] : []);
  const { data: settings } = useGuardrailSettings(scenarioId);
  const found = guardrails?.find((r) => r.unitId === unitId);
  // Sem o cálculo do Plano CUPOLA, ainda não há limite: o topo não acusa nada.
  const g = settings?.suggested_at ? found : undefined;
  const { revenue, result } = boardLines(lines);
  const costLines = (lines ?? []).filter((l) => l.active && l.kind === "lancada" && l.sign < 0);
  const dreCosts = values ? costLines.reduce((a, l) => a + dreValue(values, l.id, 0), 0) : 0;
  const planned = g ? plannedCosts(g) : dreCosts;
  const diff = g ? planned - g.ceiling : null;
  const items: { label: string; value: string; hint?: string; bad?: boolean; good?: boolean }[] = [
    {
      label: "Receita",
      value: fmtBRL(revenue && values ? dreValue(values, revenue.id, 0) : 0),
      ...(g?.kind === "negocio" ? { hint: `Compromisso: ${fmtBRL(g.floor ?? 0)}` } : {}),
    },
    { label: "Custos", value: fmtBRL(planned) },
    {
      label: "Limite de custos",
      value: g ? fmtBRL(g.ceiling) : "—",
      ...(g
        ? { hint: `Despesas ${fmtBRL(g.expenseLimit)} · Folha ${fmtBRL(g.payrollLimit)}` }
        : { hint: "Aparece quando o financeiro calcular e publicar" }),
    },
    diff !== null && diff > 0
      ? { label: "Falta cortar", value: fmtBRL(diff), bad: true }
      : { label: "Folga", value: diff === null ? "—" : fmtBRL(-diff), good: diff !== null },
    {
      label: "Resultado da unidade",
      value: fmtBRL(result && values ? dreValue(values, result.id, 0) : 0),
    },
  ];
  return (
    <section className="sticky top-0 z-20 grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((it) => (
        <div key={it.label}>
          <div className="text-xs text-muted-foreground">{it.label}</div>
          <div
            className={`font-mono text-lg font-semibold tabular-nums ${
              it.bad ? "text-destructive" : it.good ? "text-emerald-700 dark:text-emerald-400" : ""
            }`}
          >
            {it.value}
          </div>
          {it.hint && <div className="text-xs text-muted-foreground">{it.hint}</div>}
        </div>
      ))}
    </section>
  );
}

function ReviewStep() {
  const { unit, unitId, version, versionId, submissionStatus } = usePlanning();
  const { data: user } = useCurrentUser();
  const setUnitStatus = useSetUnitStatus();
  const [note, setNote] = useState("");
  const canSend =
    !!unit &&
    version?.status === "em_coleta" &&
    (submissionStatus === "rascunho" || submissionStatus === "devolvido") &&
    (user?.isFinanceiro || (user?.isLider && user.unitIds.includes(unit.id)));
  return (
    <div className="space-y-4">
      <DreTable unitIds={unitId ? [unitId] : []} title={unit?.name ?? "unidade"} hideEmpty />
      {canSend && (
        <section className="space-y-2 rounded-md border border-border bg-card p-4">
          <h2 className="font-semibold">Enviar para aprovação</h2>
          <p className="text-sm text-muted-foreground">
            Depois de enviar, a unidade fica bloqueada até o financeiro aprovar ou devolver. Se algo
            ficou acima do limite, explique aqui (opcional).
          </p>
          <Textarea
            aria-label="Observação"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Observação para o financeiro"
          />
          <Button
            className="gap-1.5"
            onClick={() => void setUnitStatus(versionId!, unitId!, "enviado", note.trim())}
          >
            <Send className="h-4 w-4" /> Enviar para aprovação
          </Button>
        </section>
      )}
    </div>
  );
}

function PlanejamentoPage() {
  const { unit, unitId, versionId, lockReason } = usePlanning();
  const [step, setStep] = useState<Step>(1);
  const { data: people } = usePersonLines(versionId, unitId);
  const { data: expenses } = usePlanLines(versionId, unitId, "despesa");
  const { data: revenues } = usePlanLines(versionId, unitId, "receita");
  const steps: { n: Step; label: string; done: boolean }[] = [
    { n: 1, label: "Pessoas", done: (people?.length ?? 0) > 0 },
    { n: 2, label: "Despesas", done: (expenses?.length ?? 0) > 0 },
    { n: 3, label: "Receitas", done: (revenues?.length ?? 0) > 0 },
    { n: 4, label: "Revisar e enviar", done: false },
  ];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Planejamento · {unit?.name ?? "…"}</h1>
        {lockReason && <p className="text-sm text-muted-foreground">{lockReason}</p>}
      </div>
      <UnitSummary />
      <nav className="flex flex-wrap gap-2" aria-label="Passos do planejamento">
        {steps.map((s) => (
          <button
            key={s.n}
            type="button"
            aria-current={step === s.n ? "step" : undefined}
            onClick={() => setStep(s.n)}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${
              step === s.n
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:bg-muted"
            }`}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-xs">
              {s.done ? <Check className="h-3 w-3" /> : s.n}
            </span>
            {s.label}
          </button>
        ))}
      </nav>
      <p className="text-sm text-muted-foreground">{STEP_HELP[step]}</p>
      {step === 1 && <PeopleStep />}
      {step === 2 && <CategoryGrid kind="despesa" onOpenPeople={() => setStep(1)} />}
      {step === 3 && <CategoryGrid kind="receita" />}
      {step === 4 && <ReviewStep />}
      {step < 4 && (
        <div className="flex justify-end">
          <Button onClick={() => setStep((step + 1) as Step)}>Próximo: {steps[step]?.label}</Button>
        </div>
      )}
    </div>
  );
}
