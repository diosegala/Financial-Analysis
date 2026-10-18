import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Parameter, ParamName, Scenario, MonthInputs, DreMonth } from "./dre";
import { computeMonth } from "./dre";

export interface DreData {
  parameters: Parameter[];
  scenarios: { id: string; name: string; revenue_variation: number; expense_variation: number; is_official: boolean }[];
  months: MonthInputs[];
}

export function useDreData(unitId: string | null, year: number) {
  return useQuery({
    queryKey: ["dre-data", unitId, year],
    enabled: !!unitId,
    queryFn: async (): Promise<DreData> => {
      const [revRes, peopleRes, payRes, catRes, expRes, parRes, sceRes] = await Promise.all([
        supabase.from("revenue_entries").select("month, amount, revenue_type").eq("unit_id", unitId!).eq("year", year),
        supabase.from("people").select("id").eq("unit_id", unitId!),
        supabase.from("payroll_entries").select("month, amount, kind, person_id, unit_id").eq("year", year),
        supabase.from("expense_categories").select("id, dre_line").eq("unit_id", unitId!),
        supabase.from("expense_entries").select("month, amount, category_id").eq("year", year),
        supabase.from("parameters").select("key, value, valid_from"),
        supabase.from("scenarios").select("id, name, revenue_variation, expense_variation, is_official").order("name"),
      ]);

      const personIds = new Set((peopleRes.data ?? []).map((p) => p.id));
      const catLines = new Map((catRes.data ?? []).map((c) => [c.id, c.dre_line]));

      const months: MonthInputs[] = Array.from({ length: 12 }, () => ({
        receitaComercial: 0,
        receitaParceiro: 0,
        despesasProdutos: 0,
        folhaBase: 0,
        beneficios: 0,
        rescisoes: 0,
        despesas: 0,
      }));

      for (const r of revRes.data ?? []) {
        const m = months[r.month - 1]!;
        if (r.revenue_type === "parceiros") m.receitaParceiro += Number(r.amount);
        else m.receitaComercial += Number(r.amount);
      }

      for (const p of payRes.data ?? []) {
        const belongs = p.unit_id === unitId || (p.person_id != null && personIds.has(p.person_id));
        if (!belongs) continue;
        const m = months[p.month - 1]!;
        if (p.kind === "beneficios") m.beneficios += Number(p.amount);
        else if (p.kind === "rescisao") m.rescisoes += Number(p.amount);
        else m.folhaBase += Number(p.amount);
      }

      for (const e of expRes.data ?? []) {
        const line = catLines.get(e.category_id);
        if (!line) continue;
        const m = months[e.month - 1]!;
        if (line === "despesas_produtos") m.despesasProdutos += Number(e.amount);
        else m.despesas += Number(e.amount);
      }

      const parameters: Parameter[] = (parRes.data ?? []).map((p) => ({
        name: p.key as ParamName,
        value: Number(p.value),
        validFrom: p.valid_from,
      }));

      return { parameters, scenarios: sceRes.data ?? [], months };
    },
  });
}

export function scenarioOf(s: { revenue_variation: number; expense_variation: number }): Scenario {
  return { receitaPct: Number(s.revenue_variation), despesaPct: Number(s.expense_variation) };
}

export function computeYear(data: DreData, year: number, scenario: Scenario): DreMonth[] {
  return data.months.map((m, i) => computeMonth(m, data.parameters, year, i + 1, scenario));
}

export function totals(months: DreMonth[]): DreMonth {
  const sum = (k: keyof Omit<DreMonth, "mcl">) => months.reduce((a, m) => a + m[k], 0);
  const receitaBruta = sum("receitaBruta");
  const contribuicaoLiquida = sum("contribuicaoLiquida");
  return {
    receitaBruta,
    despesasProdutos: sum("despesasProdutos"),
    custosIndiretos: sum("custosIndiretos"),
    despesas: sum("despesas"),
    comissionamento: sum("comissionamento"),
    impostos: sum("impostos"),
    contribuicaoLiquida,
    mcl: receitaBruta === 0 ? 0 : contribuicaoLiquida / receitaBruta,
  };
}
