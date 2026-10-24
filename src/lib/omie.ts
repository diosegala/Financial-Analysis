import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { splitPeriod } from "./accounts-import";
import { norm } from "./products-import";

export interface OmieExpense {
  categoryName: string;
  /** Unidade do departamento do Omie; null quando o título não tem departamento (quase sempre). */
  unitId: string | null;
  paid: number[];
  open: number[];
}

/** Despesas do ano lidas do Omie, por categoria e unidade, com os 12 meses (índice 0 = janeiro). */
export function useOmieExpenses(year: number | undefined) {
  return useQuery({
    queryKey: ["omie_expenses", year],
    enabled: !!year,
    queryFn: async (): Promise<OmieExpense[]> => {
      const { data, error } = await supabase.rpc("omie_expense_summary", { _year: year! });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        categoryName: r.category_name,
        unitId: r.unit_id,
        paid: (r.paid ?? []).map(Number),
        open: (r.open ?? []).map(Number),
      }));
    },
  });
}

export interface MatchableAccount {
  id: string;
  name: string;
  base_name: string | null;
  period: string | null;
  treatment: string;
  kind: string;
  active: boolean;
}

export type AccountMatch =
  | { status: "conta"; account: MatchableAccount }
  | { status: "calculada" | "fora_dre"; account: MatchableAccount }
  | { status: "sem_conta" };

/**
 * Conta do app que corresponde a uma categoria do Omie. Nome igual vale; senão, o mesmo nome sem o período
 * ("CUPOLA Summit Ingressos - 2026" encontra "… - 2027"), preferindo a conta cujo período inclui o ano planejado.
 */
export function matchAccount(
  categoryName: string,
  accounts: MatchableAccount[],
  planYear: number,
): AccountMatch {
  const live = accounts.filter((a) => a.active && a.kind !== "receita");
  const exact = live.find((a) => norm(a.name) === norm(categoryName));
  const base = norm(splitPeriod(categoryName).baseName);
  const candidates = exact
    ? [exact]
    : live.filter((a) => norm(a.base_name ?? splitPeriod(a.name).baseName) === base);
  if (candidates.length === 0) return { status: "sem_conta" };
  const account =
    candidates.find((a) => a.period?.split("/").includes(String(planYear))) ?? candidates[0]!;
  return account.treatment === "lancavel"
    ? { status: "conta", account }
    : { status: account.treatment as "calculada" | "fora_dre", account };
}

/** Meses a lançar: o realizado de cada mês × participação × (1 + reajuste). */
export function planFromActuals(
  actual: number[],
  share: number,
  adjustment: number,
  mode: "mes_a_mes" | "media",
): { month: number; amount: number }[] {
  const total = actual.reduce((a, v) => a + v, 0);
  return actual
    .map((v, i) => ({
      month: i + 1,
      amount:
        Math.round((mode === "media" ? total / 12 : v) * share * (1 + adjustment) * 100) / 100,
    }))
    .filter((m) => m.amount !== 0);
}
