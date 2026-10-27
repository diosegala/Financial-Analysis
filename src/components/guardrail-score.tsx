import { usePlanning } from "@/lib/planning";
import { useGuardrails, type Guardrail } from "@/lib/guardrails";
import { fmtBRL, fmtPct } from "@/lib/format";

function Bar({
  label,
  value,
  limit,
  over,
  detail,
}: {
  label: string;
  value: number;
  limit: number;
  /** "bom" acima do limite (receita) ou "ruim" acima do limite (despesa). */
  over: "bom" | "ruim";
  detail: string;
}) {
  const pct = limit > 0 ? value / limit : 0;
  const bad = over === "ruim" ? pct > 1 : pct < 1;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={`font-mono text-xs tabular-nums ${bad ? "text-destructive" : ""}`}>
          {fmtBRL(value)} de {fmtBRL(limit)} ({fmtPct(pct)})
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${bad ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${Math.min(pct, 1) * 100}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function Score({ g }: { g: Guardrail }) {
  const slack = g.ceiling - g.plannedExpense;
  const business = g.kind === "negocio";
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {business && (
        <Bar
          label="Receita planejada × piso"
          value={g.plannedRevenue}
          limit={g.floor ?? 0}
          over="bom"
          detail={
            g.plannedRevenue >= (g.floor ?? 0)
              ? "Acima do piso: o que passar dele não aumenta o teto de despesa."
              : "Abaixo do piso: lance a carteira e as vendas que a unidade já faz."
          }
        />
      )}
      <Bar
        label="Despesa lançada × teto"
        value={g.plannedExpense}
        limit={g.ceiling}
        over="ruim"
        detail={
          slack >= 0
            ? `Folga de ${fmtBRL(slack)}.`
            : `Passou ${fmtBRL(-slack)} do teto: corte ou marque como condicionada (com o gatilho).`
        }
      />
      {business ? (
        <Bar
          label="Contribuição com o piso × exigida"
          value={(g.floorNet ?? 0) - g.plannedExpense}
          limit={g.contribution ?? 0}
          over="bom"
          detail={`Piso líquido de impostos e comissões menos a despesa lançada. ${
            g.conditionalExpense
              ? `Condicionadas fora da conta: ${fmtBRL(g.conditionalExpense)}.`
              : ""
          }`}
        />
      ) : (
        <div className="text-sm text-muted-foreground">
          {g.conditionalExpense
            ? `Condicionadas fora do teto: ${fmtBRL(g.conditionalExpense)}.`
            : "Área de apoio: o teto vale para a soma das despesas e da folha."}
        </div>
      )}
    </div>
  );
}

/** Placar do contrato da unidade selecionada: aparece quando o piso e o teto estão publicados (ou para a gestão). */
export function GuardrailScore() {
  const { unitId, scenarioId } = usePlanning();
  const { data } = useGuardrails(scenarioId);
  const g = data?.find((r) => r.unitId === unitId);
  if (!g) return null;
  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h2 className="font-semibold">Piso e teto da unidade</h2>
        <p className="text-xs text-muted-foreground">
          {g.kind === "negocio"
            ? `Piso de receita ${fmtBRL(g.floor ?? 0)} · contribuição exigida ${fmtBRL(g.contribution ?? 0)} · teto de despesa ${fmtBRL(g.ceiling)} no ano.`
            : `Teto de despesa ${fmtBRL(g.ceiling)} no ano.`}
        </p>
      </div>
      <Score g={g} />
    </section>
  );
}
