import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export type TableName = keyof Database["public"]["Tables"];

export type Unit = Tables<"units">;
export type Version = Tables<"budget_versions">;
export type Scenario = Tables<"scenarios">;
export type DreLine = Tables<"dre_lines">;
export type Account = Tables<"accounts">;
export type RevenueType = Tables<"revenue_types">;
export type ContractType = Tables<"contract_types">;
export type Product = Tables<"products">;
export type ProductLine = Tables<"product_lines">;
export type Client = Tables<"clients">;
export type ParameterDefinition = Tables<"parameter_definitions">;
export type ParameterValue = Tables<"parameter_values">;
export type CalcRule = Tables<"calc_rules">;

/** Reads a whole configuration table, ordered. Configuration tables are small. */
export async function selectAll<T extends TableName>(
  table: T,
  order: string[] = [],
): Promise<Tables<T>[]> {
  let q = supabase.from(table).select("*");
  for (const col of order) q = q.order(col);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Tables<T>[];
}

function useTable<T extends TableName>(table: T, order: string[], enabled = true) {
  return useQuery({
    queryKey: [table],
    queryFn: () => selectAll(table, order),
    enabled,
    staleTime: 30_000,
  });
}

export const useUnits = () => useTable("units", ["sort_order", "name"]);
export const useVersions = () => useTable("budget_versions", ["year", "name"]);
export const useAllScenarios = () => useTable("scenarios", ["sort_order", "name"]);
export const useDreLines = () => useTable("dre_lines", ["sort_order"]);
export const useAccounts = () => useTable("accounts", ["sort_order", "name"]);
export const useRevenueTypes = () => useTable("revenue_types", ["sort_order", "name"]);
export const useContractTypes = () => useTable("contract_types", ["sort_order", "name"]);
export const useProducts = () => useTable("products", ["name"]);
export const useProductLines = () => useTable("product_lines", ["sort_order", "name"]);
export const useClients = () => useTable("clients", ["name"]);
export const useParameterDefinitions = () =>
  useTable("parameter_definitions", ["sort_order", "label"]);
export const useParameterValues = () => useTable("parameter_values", ["valid_from"]);
export const useAccountTreatmentRules = () => useTable("account_treatment_rules", ["keyword"]);
export const useAccountGroupRules = () => useTable("account_group_rules", ["keyword"]);
export const usePayrollBrackets = () =>
  useTable("payroll_tax_brackets", ["valid_from", "lower_bound"]);
export const usePayrollConstants = () => useTable("payroll_tax_constants", ["key", "valid_from"]);
export const useOmieDepartmentUnits = () => useTable("omie_department_units", ["department_name"]);
export const useOmieKeywordUnits = () => useTable("omie_keyword_units", ["keyword"]);
export const useOmieCategoryAllocations = () =>
  useTable("omie_category_allocations", ["category_name"]);
export const useCalcRules = () => useTable("calc_rules", ["sort_order", "name"]);

export function useScenarios(versionId: string | null) {
  const all = useAllScenarios();
  return { ...all, data: (all.data ?? []).filter((s) => s.version_id === versionId) };
}

/** Generic insert / update / delete for configuration tables, with toast on error. */
export function useTableMutations<T extends TableName>(table: T) {
  const queryClient = useQueryClient();
  const from = () => supabase.from(table as TableName);
  const done = () => queryClient.invalidateQueries({ queryKey: [table] });

  async function run(p: PromiseLike<{ error: { message: string } | null }>, ok?: string) {
    const { error } = await p;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    if (ok) toast.success(ok);
    await done();
    return true;
  }

  return {
    insert: (row: TablesInsert<T>, ok?: string) => run(from().insert(row as never), ok),
    update: (id: string, patch: TablesUpdate<T>, ok?: string) =>
      run(
        from()
          .update(patch as never)
          .eq("id" as never, id as never),
        ok,
      ),
    remove: (id: string, ok?: string) =>
      run(
        from()
          .delete()
          .eq("id" as never, id as never),
        ok,
      ),
  };
}

/** Translates common Postgres errors into Portuguese for the user. */
export function friendlyError(message: string): string {
  if (message.includes("duplicate key")) return "Já existe um registro com esse nome.";
  if (message.includes("violates foreign key"))
    return "Este registro está em uso e não pode ser excluído. Desative-o.";
  if (message.includes("accounts_dre_line_required"))
    return "Escolha a linha da DRE. Só as contas fora da DRE ficam sem linha.";
  if (message.includes("não pode ser lançada")) return message;
  if (message.includes("row-level security")) return "Você não tem permissão para esta alteração.";
  return message;
}

export const byId = <T extends { id: string }>(rows: T[] | undefined) =>
  new Map((rows ?? []).map((r) => [r.id, r]));
