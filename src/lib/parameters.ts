import type { CalcRule, ParameterValue } from "./catalog";
import { norm } from "./products-import";

export type Scope = "unit" | "product" | "contract_type" | "revenue_type";

export const SCOPE_LABELS: Record<Scope, string> = {
  unit: "Unidade",
  product: "Produto",
  contract_type: "Vínculo",
  revenue_type: "Tipo de receita",
};

export const SCOPE_COLUMN = {
  unit: "unit_id",
  product: "product_id",
  contract_type: "contract_type_id",
  revenue_type: "revenue_type_id",
} as const;

export type BaseKind = "receita" | "despesa" | "salario" | "headcount";

export const BASE_LABELS: Record<BaseKind, string> = {
  receita: "Receita",
  despesa: "Despesa",
  salario: "Remuneração das pessoas",
  headcount: "Pessoas ativas no mês",
};

/** Chave técnica a partir do nome: "IBS (estadual)" → "ibs_estadual". Repetida ganha um número. */
export function uniqueKey(label: string, existing: string[]): string {
  const base =
    norm(label)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "parametro";
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Nome da regra (único): repetido ganha " (2)". */
export function uniqueName(label: string, existing: string[]): string {
  const taken = new Set(existing.map(norm));
  if (!taken.has(norm(label))) return label;
  let n = 2;
  while (taken.has(norm(`${label} (${n})`))) n++;
  return `${label} (${n})`;
}

/** Escopos que os valores já cadastrados usam: não podem ser retirados do parâmetro. */
export function usedScopes(
  values: Pick<ParameterValue, "unit_id" | "product_id" | "contract_type_id" | "revenue_type_id">[],
): Set<Scope> {
  const used = new Set<Scope>();
  for (const v of values) {
    for (const s of Object.keys(SCOPE_COLUMN) as Scope[]) if (v[SCOPE_COLUMN[s]]) used.add(s);
  }
  return used;
}

interface Lookups {
  dreLine: (id: string) => string | undefined;
  revenueType: (id: string) => string | undefined;
  contractType: (id: string) => string | undefined;
  account: (id: string) => string | undefined;
}

const names = (ids: string[] | null, lookup: (id: string) => string | undefined) =>
  (ids ?? []).map((id) => lookup(id) ?? "?").join(", ");

/** Texto curto de como a regra entra no cálculo: "Receita (exceto Parceiros) → Impostos sobre a receita". */
export function describeRule(
  rule: Pick<
    CalcRule,
    | "base_kind"
    | "target_dre_line_id"
    | "revenue_type_ids"
    | "exclude_revenue_type_ids"
    | "contract_type_ids"
    | "account_ids"
    | "active"
  >,
  lookups: Lookups,
): string {
  const filters: string[] = [];
  if (rule.revenue_type_ids?.length)
    filters.push(`só ${names(rule.revenue_type_ids, lookups.revenueType)}`);
  if (rule.exclude_revenue_type_ids?.length)
    filters.push(`exceto ${names(rule.exclude_revenue_type_ids, lookups.revenueType)}`);
  if (rule.contract_type_ids?.length)
    filters.push(`só ${names(rule.contract_type_ids, lookups.contractType)}`);
  if (rule.account_ids?.length)
    filters.push(`só as contas ${names(rule.account_ids, lookups.account)}`);
  const base = BASE_LABELS[rule.base_kind as BaseKind] ?? rule.base_kind;
  const line = lookups.dreLine(rule.target_dre_line_id) ?? "?";
  return `${base}${filters.length ? ` (${filters.join("; ")})` : ""} → ${line}${rule.active ? "" : " (regra desativada)"}`;
}
