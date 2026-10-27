import type { Tables } from "@/integrations/supabase/types";
import { fmtBRL, fmtInput } from "./format";

export type Product = Tables<"products">;
export type PriceModel = "mensal" | "total" | "unico";
export type ProductKind = "servico" | "evento";

export const PRICE_MODEL_LABELS: Record<PriceModel, string> = {
  mensal: "Por mês",
  total: "Valor total do contrato",
  unico: "Pagamento único",
};

export const KIND_LABELS: Record<ProductKind, string> = {
  servico: "Serviço (contrato)",
  evento: "Evento / treinamento",
};

export type ProductFormat = "online" | "presencial" | "hibrido" | "nenhum";

export const FORMAT_LABELS: Record<ProductFormat, string> = {
  online: "Online",
  presencial: "Presencial",
  hibrido: "Híbrido",
  nenhum: "Sem formato",
};

/** Natureza da receita: recorrente (contratos, assinaturas) ou variável. Vazio = decide a linha do produto. */
export const NATURE_OPTIONS = [
  { value: "recorrente", label: "Recorrente" },
  { value: "variavel", label: "Variável" },
];

export type ContractTerms = Pick<Product, "price" | "price_model" | "duration_months">;

export interface ContractPlan {
  /** Valor lançado em cada mês, já cortado em dezembro. */
  schedule: { month: number; amount: number }[];
  /** Prazo do contrato em meses (1 para pagamento único). */
  months: number;
  /** Valor do contrato inteiro, inclusive meses que caem depois de dezembro. */
  contractTotal: number;
  /** Quanto cai dentro do ano. */
  yearTotal: number;
  /** Meses do contrato que ficam depois de dezembro. */
  monthsAfterYear: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Distribui o preço do produto pelos meses a partir de `startMonth` (1–12).
 * - mensal: o preço em cada mês do prazo.
 * - total: o valor do contrato dividido igualmente; a sobra de centavos vai para o último mês do contrato.
 * - unico: tudo no mês de início.
 * Sem prazo, vale até dezembro. O que passa de dezembro não é lançado (é do ano seguinte).
 */
export function contractPlan(
  terms: ContractTerms,
  startMonth: number,
  overrides: { price?: number; months?: number } = {},
): ContractPlan {
  const price = overrides.price ?? Number(terms.price ?? 0);
  const model = (terms.price_model ?? "mensal") as PriceModel;
  const untilDecember = 13 - startMonth;
  const months = Math.max(
    1,
    model === "unico" ? 1 : (overrides.months ?? terms.duration_months ?? untilDecember),
  );

  const amounts: number[] = [];
  if (model === "total") {
    const each = cents(price / months);
    for (let i = 0; i < months; i++) amounts.push(each);
    amounts[months - 1] = cents(price - each * (months - 1));
  } else {
    for (let i = 0; i < months; i++) amounts.push(price);
  }

  const schedule = amounts
    .map((amount, i) => ({ month: startMonth + i, amount }))
    .filter((m) => m.month <= 12);
  const contractTotal = cents(amounts.reduce((a, v) => a + v, 0));
  const yearTotal = cents(schedule.reduce((a, m) => a + m.amount, 0));
  return {
    schedule,
    months,
    contractTotal,
    yearTotal,
    monthsAfterYear: Math.max(0, months - schedule.length),
  };
}

/** Texto curto do preço para listas: "R$ 5.000/mês · 6 meses". */
export function describePrice(
  p: Pick<Product, "kind" | "price" | "price_model" | "duration_months">,
) {
  if (p.price === null) return "Sem preço";
  const price = fmtBRL(Number(p.price));
  if (p.kind === "evento") return `${price} por participante`;
  const months = p.duration_months;
  switch (p.price_model as PriceModel) {
    case "mensal":
      return `${price}/mês${months ? ` · ${months} ${months === 1 ? "mês" : "meses"}` : ""}`;
    case "total":
      return `${price} no contrato${months ? ` · ${months} ${months === 1 ? "mês" : "meses"}` : ""}`;
    case "unico":
      return `${price} (pagamento único)`;
  }
}

/** Resumo de um contrato já calculado: "6 meses × R$ 5.000 = R$ 30.000 (Mar–Ago)". */
export function describePlan(plan: ContractPlan, monthNames: string[]) {
  if (plan.schedule.length === 0) return "Nenhum mês cai dentro do ano.";
  const first = plan.schedule[0]!;
  const last = plan.schedule.at(-1)!;
  const range =
    first.month === last.month
      ? monthNames[first.month - 1]
      : `${monthNames[first.month - 1]}–${monthNames[last.month - 1]}`;
  const same = plan.schedule.every((m) => m.amount === first.amount);
  const per = same
    ? `${plan.schedule.length} × ${fmtBRL(first.amount)}`
    : `${plan.schedule.length} parcelas`;
  const after =
    plan.monthsAfterYear > 0
      ? ` · ${plan.monthsAfterYear} ${plan.monthsAfterYear === 1 ? "mês cai" : "meses caem"} no ano seguinte`
      : "";
  return `${per} = ${fmtBRL(plan.yearTotal)} (${range})${after}`;
}

export const inputOf = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : fmtInput(Number(n), 2);
