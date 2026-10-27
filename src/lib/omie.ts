import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { splitPeriod } from "./accounts-import";
import { friendlyError, useOmieCategoryAllocations } from "./catalog";
import { norm } from "./products-import";

export interface OmieExpense {
  categoryName: string;
  /** Unidade atribuída; null = sem unidade, a ratear. */
  unitId: string | null;
  /** De onde veio a unidade: departamento do título, rateio da categoria, palavra no nome ou nenhuma. */
  source: "departamento" | "rateio" | "palavra" | "sem";
  paid: number[];
  open: number[];
  /** Os lançamentos que compõem a categoria: fornecedor, ou o item quando foi pago no cartão. */
  suppliers: { name: string; paid: number[]; open: number[] }[];
}

/** Despesas do ano lidas do Omie, por categoria e unidade, com os 12 meses (índice 0 = janeiro). */
export function useOmieExpenses(year: number | undefined) {
  return useQuery({
    queryKey: ["omie_expenses", year],
    enabled: !!year,
    queryFn: async (): Promise<OmieExpense[]> => {
      // Uma linha por categoria, fornecedor e unidade: passa de mil, e o Supabase entrega no máximo 1.000 por consulta.
      const data = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .rpc("omie_expense_summary", { _year: year! })
          .order("category_name")
          .order("supplier_name")
          .order("unit_id")
          .order("source")
          .range(from, from + 999);
        if (error) throw error;
        data.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      // Uma linha por categoria, unidade e origem da unidade, com o detalhe por fornecedor dentro.
      const add = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));
      const out = new Map<string, OmieExpense>();
      for (const r of data) {
        const paid = (r.paid ?? []).map(Number);
        const open = (r.open ?? []).map(Number);
        const key = `${r.category_name}|${r.unit_id ?? ""}|${r.source}`;
        const row: OmieExpense = out.get(key) ?? {
          categoryName: r.category_name,
          unitId: r.unit_id,
          source: r.source as OmieExpense["source"],
          paid: Array(12).fill(0) as number[],
          open: Array(12).fill(0) as number[],
          suppliers: [],
        };
        row.paid = add(row.paid, paid);
        row.open = add(row.open, open);
        row.suppliers.push({ name: r.supplier_name || "Sem fornecedor", paid, open });
        out.set(key, row);
      }
      return [...out.values()];
    },
  });
}

export interface OmieRevenue {
  categoryName: string;
  clientCode: string;
  clientName: string;
  /** Unidade atribuída; null = sem unidade. */
  unitId: string | null;
  source: OmieExpense["source"];
  /** Recebido (pela data do recebimento) e em aberto (pelo vencimento), índice 0 = janeiro. */
  received: number[];
  open: number[];
}

/** Receitas do ano lidas do Omie, por categoria, cliente e unidade. O líder recebe só as das suas unidades. */
export function useOmieRevenue(year: number | undefined) {
  return useQuery({
    queryKey: ["omie_revenue", year],
    enabled: !!year,
    queryFn: async (): Promise<OmieRevenue[]> => {
      const data = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .rpc("omie_revenue_summary", { _year: year! })
          .order("category_name")
          .order("client_code")
          .order("unit_id")
          .order("source")
          .range(from, from + 999);
        if (error) throw error;
        data.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      return data.map((r) => ({
        categoryName: r.category_name,
        clientCode: r.client_code,
        clientName: r.client_name || "Sem cliente",
        unitId: r.unit_id,
        source: r.source as OmieExpense["source"],
        received: (r.received ?? []).map(Number),
        open: (r.open ?? []).map(Number),
      }));
    },
  });
}

/** Clientes recorrentes do ano anterior ao da versão, sugeridos como carteira da unidade. */
export function useRevenuePortfolio(
  versionId: string | null,
  unitId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["revenue_portfolio", versionId, unitId],
    enabled: enabled && !!versionId && !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("revenue_portfolio", {
        _version_id: versionId!,
        _unit_id: unitId!,
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        clientCode: r.client_code,
        clientName: r.client_name || "Sem nome",
        categoryName: r.category_name,
        accountId: r.account_id as string | null,
        monthsActive: r.months_active,
        monthly: Number(r.monthly),
        lastMonth: r.last_month,
        yearTotal: Number(r.year_total),
        /** Já contratado: títulos a receber com vencimento no ano do plano, mês a mês. */
        contracted: (r.contracted ?? []).map(Number),
      }));
    },
  });
}

export const SOURCE_LABELS: Record<OmieExpense["source"], string> = {
  departamento: "departamento do Omie",
  rateio: "rateio",
  palavra: "palavra no nome",
  sem: "a ratear",
};

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
 * Conta do app que corresponde a uma categoria do Omie: a de mesmo nome sem o período cujo período inclui o ano planejado
 * ("CUPOLA Summit Ingressos - 2026" encontra "… - 2027"); senão a de nome igual; senão a de mesmo nome-base.
 */
export function matchAccount(
  categoryName: string,
  accounts: MatchableAccount[],
  planYear: number,
): AccountMatch {
  const live = accounts.filter((a) => a.active && a.kind !== "receita");
  const base = norm(splitPeriod(categoryName).baseName);
  const sameBase = live.filter((a) => norm(a.base_name ?? splitPeriod(a.name).baseName) === base);
  // Mesma ordem da geração da base no banco (account_for_category): a do ano planejado, a de nome igual, a de mesmo nome-base.
  const account =
    sameBase.find((a) => a.period?.replace(/\s/g, "").split("/").includes(String(planYear))) ??
    live.find((a) => norm(a.name) === norm(categoryName)) ??
    sameBase[0];
  if (!account) return { status: "sem_conta" };
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

/**
 * Grava a unidade de uma categoria do Omie: uma unidade (100%) ou um rateio. A escolha do financeiro vence o
 * departamento do título e a palavra no nome. Lista vazia remove a escolha.
 */
export function useCategoryUnitSaver() {
  const queryClient = useQueryClient();
  const { data: allocations } = useOmieCategoryAllocations();
  return async (category: string, shares: { unit_id: string; share: number }[]) => {
    const mine = (allocations ?? []).filter((a) => norm(a.category_name) === norm(category));
    const del =
      mine.length > 0
        ? await supabase
            .from("omie_category_allocations")
            .delete()
            .in(
              "id",
              mine.map((a) => a.id),
            )
        : { error: null };
    const ins =
      !del.error && shares.length > 0
        ? await supabase
            .from("omie_category_allocations")
            .insert(shares.map((s) => ({ category_name: category, ...s })))
        : null;
    const error = del.error ?? ins?.error;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["omie_category_allocations"] }),
      queryClient.invalidateQueries({ queryKey: ["omie_expenses"] }),
    ]);
    return true;
  };
}
