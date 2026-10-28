import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePlanning } from "@/lib/planning";
import { useAccounts, useUnits } from "@/lib/catalog";
import { useExpenseBase } from "@/lib/expense-base";
import { useScenarioTarget, useTargetVsPlan } from "@/lib/targets";
import { useSubmissions } from "@/lib/submissions";
import { useGuardrailSettings, useGuardrails } from "@/lib/guardrails";
import { listUsers } from "@/lib/users.functions";
import { fmtBRL } from "@/lib/format";
import { ExpenseBasePanel } from "@/components/expense-base-panel";
import { Button } from "@/components/ui/button";

/** Pessoas da folha da versão e o custo de remuneração no ano (todas as unidades). */
function usePayrollTotals(versionId: string | null) {
  return useQuery({
    queryKey: ["people", "totals", versionId],
    enabled: !!versionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("plan_lines")
        .select("id, plan_values(amount)")
        .eq("version_id", versionId!)
        .not("person_id", "is", null);
      if (error) throw error;
      const total = (data ?? []).reduce(
        (a, l) => a + l.plan_values.reduce((b, v) => b + Number(v.amount), 0),
        0,
      );
      return { people: data?.length ?? 0, total };
    },
  });
}

function GoTo({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to={to} search={(prev: Record<string, unknown>) => prev}>
        {children}
      </Link>
    </Button>
  );
}

function Step({
  n,
  done,
  title,
  status,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  status: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-md border border-border bg-card p-3">
      <div className="pt-0.5">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-primary" aria-label="Feito" />
        ) : (
          <Circle className="h-5 w-5 text-muted-foreground" aria-label="A fazer" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="font-medium">
            {n}. {title}
          </div>
          <div className="text-sm text-muted-foreground">{status}</div>
        </div>
        {children}
      </div>
    </li>
  );
}

/** Por onde começar: o caminho do financeiro até liberar os líderes, com o estado de cada passo. */
export function SetupSteps() {
  const { versionId, version, scenarioId, scenario } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: units } = useUnits();
  const { data: payroll } = usePayrollTotals(versionId);
  const { data: base } = useExpenseBase(versionId);
  const { data: target } = useScenarioTarget(scenarioId);
  const { data: submissions } = useSubmissions(versionId);
  const { data: guardSettings } = useGuardrailSettings(scenarioId);
  const { data: guard } = useGuardrails(scenarioId);
  const { data: users } = useQuery({
    queryKey: ["users-list"],
    queryFn: () => listUsers({ data: {} }),
  });

  const posting = (accounts ?? []).filter((a) => a.active && a.treatment === "lancavel").length;
  const leaders = (users?.users ?? []).filter((u) => u.active && u.roles.includes("lider")).length;
  const activeUnits = (units ?? []).filter((u) => u.active).length;
  const sent = (submissions ?? []).filter(
    (s) => s.status === "enviado" || s.status === "aprovado",
  ).length;
  const approved = (submissions ?? []).filter((s) => s.status === "aprovado").length;
  const business = (guard ?? []).filter((g) => g.kind === "negocio");
  const withFloor = business.filter((g) => (g.floor ?? 0) > 0).length;
  const required = business.reduce((a, g) => a + (g.contribution ?? 0), 0);
  const unassigned = Number(guardSettings?.unassigned_revenue ?? 0);
  const guardStatus = guardSettings?.published_at
    ? `Publicado: ${withFloor} unidades com piso e contribuição exigida de ${fmtBRL(required)}. Os líderes já veem o placar.`
    : guardSettings?.suggested_at
      ? `${withFloor} de ${business.length} unidades com piso, contribuição exigida de ${fmtBRL(required)}. Revise pisos e tetos e publique.`
      : "Defina o resultado alvo e busque o realizado do Omie para sugerir os pisos de receita e os tetos de despesa.";

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Por onde começar</h2>
        <p className="text-sm text-muted-foreground">
          O caminho até os líderes lançarem a receita de {version?.year ?? "…"}. O que já está
          carregado aparece marcado; confira e ajuste o que precisar.
        </p>
      </div>
      <ol className="space-y-2">
        <Step
          n={1}
          done={posting > 0}
          title="Contas (categorias do Omie)"
          status={`${posting} contas lançáveis, carregadas da planilha de categorias. Confira grupo, tratamento e linha da DRE.`}
        >
          <GoTo to="/configuracoes">Ver plano de contas</GoTo>
        </Step>
        <Step
          n={2}
          done={(payroll?.people ?? 0) > 0}
          title="Folha"
          status={
            payroll?.people
              ? `${payroll.people} pessoas, ${fmtBRL(payroll.total)} de remuneração no ano. Confira salários e custos (abra cada pessoa).`
              : "Nenhuma pessoa cadastrada. Importe a planilha da folha."
          }
        >
          <GoTo to="/folha">Abrir a folha</GoTo>
        </Step>
        <Step
          n={3}
          done={(base?.lines ?? 0) > 0}
          title={`Despesas de ${version?.year ?? "…"}`}
          status="A base vem do realizado do ano anterior no Omie. Aplique o reajuste geral e edite linha a linha em Despesas."
        >
          <ExpenseBasePanel showUnit={false} />
          <GoTo to="/despesas">Abrir despesas</GoTo>
        </Step>
        <Step
          n={4}
          done={!!guardSettings?.published_at}
          title={`Piso e teto (cenário ${scenario?.name ?? "…"})`}
          status={
            unassigned > 0 && !guardSettings?.published_at
              ? `${guardStatus} Há ${fmtBRL(unassigned)} de receita do Omie sem unidade para distribuir nos pisos.`
              : guardStatus
          }
        >
          <GoTo to="/metas">Abrir piso e teto</GoTo>
        </Step>
        <Step
          n={5}
          done={!!target?.published_at}
          title="Meta de receita acima do piso (opcional)"
          status={
            target?.published_at
              ? `Publicada: receita necessária de ${fmtBRL(Number(target.required_revenue ?? 0))}. Os líderes já veem a meta.`
              : target?.computed_at
                ? `Calculada (${fmtBRL(Number(target.required_revenue ?? 0))}), ainda não publicada.`
                : "Opcional: uma meta de receita além do piso, por unidade. Fica na aba Meta de receita, em Metas."
          }
        >
          <GoTo to="/metas">Abrir metas</GoTo>
        </Step>
        <Step
          n={6}
          done={leaders > 0}
          title="Líderes"
          status={
            leaders
              ? `${leaders} líder(es) com acesso.`
              : "Nenhum líder com acesso ainda. Libere depois de publicar o piso e teto."
          }
        >
          <GoTo to="/usuarios">Dar acesso</GoTo>
        </Step>
        <Step
          n={7}
          done={activeUnits > 0 && approved === activeUnits}
          title="Coleta e aprovação"
          status={`${sent} de ${activeUnits} unidades enviadas, ${approved} aprovadas. Acompanhe na tabela abaixo.`}
        />
      </ol>
    </section>
  );
}

/** Início do líder: a meta da unidade, o que já foi lançado e o que falta. */
export function LeaderGoal() {
  const { versionId, scenarioId, unitId, unit } = usePlanning();
  const { data: months } = useTargetVsPlan(versionId, scenarioId, unitId);
  // O líder só recebe o piso e teto depois de publicado.
  const { data: guard } = useGuardrails(scenarioId);
  const hasGuardrail = (guard ?? []).some((g) => g.unitId === unitId);
  const sum = (f: (m: NonNullable<typeof months>[number]) => number) =>
    (months ?? []).reduce((a, m) => a + f(m), 0);
  const target = sum((m) => m.target);
  const planned = sum((m) => m.carteira + m.renovacao + m.nova + m.semOrigem);

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">Sua meta de receita · {unit?.name ?? "…"}</h2>
      {target > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">Meta no ano</div>
            <div className="font-mono text-2xl tabular-nums">{fmtBRL(target)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Já lançado</div>
            <div className="font-mono text-2xl tabular-nums">{fmtBRL(planned)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {target - planned > 0 ? "Falta lançar" : "Acima da meta"}
            </div>
            <div
              className={`font-mono text-2xl tabular-nums ${target - planned > 0 ? "text-destructive" : ""}`}
            >
              {fmtBRL(Math.abs(target - planned))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {hasGuardrail
            ? "O compromisso da unidade é o piso e teto logo abaixo: receita no piso, despesa dentro do teto. Lance a carteira atual, as renovações e as vendas novas."
            : "O financeiro ainda não publicou a meta. Enquanto isso, você já pode lançar a carteira atual e as renovações."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/receitas" search={(prev: Record<string, unknown>) => prev}>
            Lançar receitas
          </Link>
        </Button>
        <GoTo to="/despesas">Ver despesas</GoTo>
        <GoTo to="/eventos">Eventos</GoTo>
      </div>
    </section>
  );
}
