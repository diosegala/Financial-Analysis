import { byId, useUnits } from "@/lib/catalog";
import type { ScenarioTarget } from "@/lib/targets";
import { fmtBRL } from "@/lib/format";

const brl2 = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});
const money = (v: number) => brl2.format(v);
const pct = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

interface Breakdown {
  payroll?: number;
  expenses?: number;
  units?: { unit_id: string; share: number; variable_pct: number; override: boolean }[];
}

/**
 * Passo a passo da receita necessária, com os números guardados no momento do cálculo:
 * custos que não dependem da receita, receita das áreas de apoio, alíquota variável ponderada e a fórmula.
 */
export function TargetExplanation({ target }: { target: ScenarioTarget }) {
  const { data: units } = useUnits();
  const unitMap = byId(units);
  const b = (target.breakdown ?? {}) as Breakdown;
  const F = Number(target.fixed_costs ?? 0);
  const payroll = Number(b.payroll ?? 0);
  const expenses = Number(b.expenses ?? F - payroll);
  const rfin = Number(target.financial_revenue ?? 0);
  const vfin = Number(target.financial_variable_pct ?? 0);
  const v = Number(target.variable_pct ?? 0);
  const R = target.required_revenue == null ? null : Number(target.required_revenue);
  const A = target.target_amount == null ? null : Number(target.target_amount);
  const m = target.target_margin == null ? null : Number(target.target_margin);
  const supportNet = rfin * (1 - vfin);
  const byMargin = target.target_kind === "margem";

  return (
    <details className="rounded-md border border-border" open>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Como a receita necessária é calculada
      </summary>
      <div className="space-y-4 border-t border-border p-3 text-sm">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <div className="font-medium">Custos que não dependem da receita (F)</div>
            <div className="text-muted-foreground">
              Tudo o que está lançado nas grades de todas as unidades e áreas de apoio, com a
              variação de despesa do cenário:
            </div>
            <div className="font-mono">
              folha, encargos, provisões e benefícios {money(payroll)} + despesas {money(expenses)}{" "}
              = <strong>{money(F)}</strong>
            </div>
          </li>
          <li>
            <div className="font-medium">Receita das áreas de apoio (ex.: receita financeira)</div>
            <div className="font-mono">
              {money(rfin)} × (1 − {pct(vfin)}) = <strong>{money(supportNet)}</strong>
            </div>
            <div className="text-muted-foreground">
              Ela ajuda a cobrir os custos, então reduz a receita que as unidades de negócio
              precisam trazer.
            </div>
          </li>
          <li>
            <div className="font-medium">Alíquota variável ponderada (v)</div>
            <div className="text-muted-foreground">
              Impostos e comissões sobre a receita de cada unidade de negócio, pesados pela
              participação dela na meta:
            </div>
            {(b.units ?? []).length > 0 ? (
              <table className="mt-1 w-full max-w-xl text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 font-normal">Unidade</th>
                    <th className="py-1 text-right font-normal">Participação</th>
                    <th className="py-1 text-right font-normal">Alíquota</th>
                    <th className="py-1 text-right font-normal">Peso na média</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {(b.units ?? []).map((u) => (
                    <tr key={u.unit_id} className="border-t border-border/60">
                      <td className="py-1 font-sans">
                        {unitMap.get(u.unit_id)?.name ?? "—"}
                        {u.override && (
                          <span className="ml-1 text-xs text-muted-foreground">(digitada)</span>
                        )}
                      </td>
                      <td className="py-1 text-right">{pct(Number(u.share))}</td>
                      <td className="py-1 text-right">{pct(Number(u.variable_pct))}</td>
                      <td className="py-1 text-right">
                        {pct(Number(u.share) * Number(u.variable_pct))}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td className="py-1 font-sans">v</td>
                    <td />
                    <td />
                    <td className="py-1 text-right">{pct(v)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div className="font-mono">v = {pct(v)}</div>
            )}
            <div className="text-muted-foreground">
              A alíquota de cada unidade soma as regras de cálculo sobre a receita (composição na
              seção 2), ponderada pelos meses.
            </div>
          </li>
          <li>
            <div className="font-medium">Receita necessária (R)</div>
            {byMargin ? (
              <>
                <div className="text-muted-foreground">
                  Alvo em margem: o resultado tem de ser {m == null ? "—" : pct(m)} de toda a
                  receita (unidades de negócio + apoio).
                </div>
                <div className="font-mono">
                  R = (F − apoio × (1 − alíquota do apoio − margem)) ÷ (1 − v − margem)
                </div>
                <div className="font-mono">
                  R = ({money(F)} − {money(rfin)} × (1 − {pct(vfin)} − {m == null ? "—" : pct(m)}))
                  ÷ (1 − {pct(v)} − {m == null ? "—" : pct(m)}) ={" "}
                  <strong>{R == null ? "inviável" : money(R)}</strong>
                </div>
              </>
            ) : (
              <>
                <div className="text-muted-foreground">
                  Alvo em reais: a receita, depois dos impostos e comissões, precisa cobrir os
                  custos e deixar o resultado.
                </div>
                <div className="font-mono">R = (alvo + F − apoio líquido) ÷ (1 − v)</div>
                <div className="font-mono">
                  R = ({A == null ? "—" : money(A)} + {money(F)} − {money(supportNet)}) ÷ (1 −{" "}
                  {pct(v)}) = <strong>{R == null ? "inviável" : money(R)}</strong>
                </div>
              </>
            )}
          </li>
          {R != null && A != null && (
            <li>
              <div className="font-medium">Conferência</div>
              <div className="font-mono">
                {money(R)} × (1 − {pct(v)}) + {money(supportNet)} − {money(F)} ={" "}
                <strong>{money(R * (1 - v) + supportNet - F)}</strong> de resultado
              </div>
              <div className="text-muted-foreground">
                É o alvo ({fmtBRL(A)}),{" "}
                {m == null ? "" : `margem de ${pct(m)} sobre ${money(R + rfin)} de receita total`}.
              </div>
            </li>
          )}
          <li>
            <div className="font-medium">Distribuição</div>
            <div className="text-muted-foreground">
              A meta de cada unidade no mês = R × participação da unidade × peso do mês (seção 3). A
              tabela abaixo soma R.
            </div>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Números do momento do cálculo
          {target.computed_at ? ` (${new Date(target.computed_at).toLocaleString("pt-BR")})` : ""}.
          Se os custos ou as participações mudarem, calcule de novo.
        </p>
      </div>
    </details>
  );
}
