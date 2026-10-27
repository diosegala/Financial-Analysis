import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DreLine, Unit } from "./catalog";

const zero = () => Array(12).fill(0) as number[];
const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);

/** Linha da receita (primeira lançada positiva) e do resultado (último subtotal) na estrutura da DRE. */
export function boardLines(lines: DreLine[] | undefined) {
  const active = (lines ?? []).filter((l) => l.active).sort((a, b) => a.sort_order - b.sort_order);
  return {
    revenue: active.find((l) => l.kind === "lancada" && l.sign > 0),
    result: active.filter((l) => l.kind === "subtotal").at(-1),
  };
}

/**
 * Participação de cada unidade de negócio no custo das áreas de apoio. Usa, nesta ordem, o critério gravado no
 * cenário, a participação na meta e a receita planejada; sem nada disso, divide igual. Soma 1.
 */
export function supportShares(
  businessIds: string[],
  custom: Map<string, number>,
  targetShares: Map<string, number>,
  revenue: Map<string, number>,
): { shares: Map<string, number>; basis: "criterio" | "meta" | "receita" | "igual" } {
  const pick = (m: Map<string, number>) => businessIds.map((id) => Math.max(m.get(id) ?? 0, 0));
  const options = [
    ["criterio", pick(custom)],
    ["meta", pick(targetShares)],
    ["receita", pick(revenue)],
  ] as const;
  const found = options.find(([, xs]) => sum(xs) > 0);
  const weights = found ? found[1] : businessIds.map(() => 1);
  const total = sum(weights);
  return {
    shares: new Map(businessIds.map((id, i) => [id, total ? (weights[i] ?? 0) / total : 0])),
    basis: found ? found[0] : "igual",
  };
}

export interface BoardUnit {
  unit: Unit;
  target: number[];
  revenue: number[];
  recurring: number[];
  result: number[];
  /** Parte do resultado das áreas de apoio (negativo quando elas custam). */
  support: number[];
  share: number;
}

export interface Board {
  units: BoardUnit[];
  /** Resultado somado das áreas de apoio, por mês. */
  supportResult: number[];
  basis: ReturnType<typeof supportShares>["basis"];
}

/** Monta o painel: unidades de negócio com meta, receita, recorrente e resultado, mais o rateio do apoio. */
export function buildBoard(input: {
  units: Unit[];
  revenue: Map<string, number[]>;
  recurring: Map<string, number[]>;
  result: Map<string, number[]>;
  target: Map<string, number[]>;
  custom: Map<string, number>;
  targetShares: Map<string, number>;
}): Board {
  const active = input.units.filter((u) => u.active);
  const business = active.filter((u) => u.kind === "negocio");
  const supportResult = zero();
  for (const u of active.filter((x) => x.kind !== "negocio"))
    (input.result.get(u.id) ?? zero()).forEach(
      (v, i) => (supportResult[i] = (supportResult[i] ?? 0) + v),
    );
  const { shares, basis } = supportShares(
    business.map((u) => u.id),
    input.custom,
    input.targetShares,
    new Map(business.map((u) => [u.id, sum(input.revenue.get(u.id) ?? [])])),
  );
  return {
    supportResult,
    basis,
    units: business.map((unit) => {
      const share = shares.get(unit.id) ?? 0;
      return {
        unit,
        share,
        target: input.target.get(unit.id) ?? zero(),
        revenue: input.revenue.get(unit.id) ?? zero(),
        recurring: input.recurring.get(unit.id) ?? zero(),
        result: input.result.get(unit.id) ?? zero(),
        support: supportResult.map((v) => v * share),
      };
    }),
  };
}

const addTo = (m: Map<string, number[]>, key: string, month: number, v: number) => {
  if (!m.has(key)) m.set(key, zero());
  const row = m.get(key)!;
  row[month - 1] = (row[month - 1] ?? 0) + v;
};

/** Receita planejada por natureza (recorrente × variável): unidade → natureza → 12 meses. */
export function useRevenueByNature(
  versionId: string | null,
  scenarioId: string | null,
  unitIds: string[] | null,
) {
  return useQuery({
    queryKey: ["dre", "nature", versionId, scenarioId, unitIds?.join(",") ?? "all"],
    enabled: !!versionId && !!scenarioId && (unitIds === null || unitIds.length > 0),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("revenue_by_nature", {
        _version_id: versionId!,
        _scenario_id: scenarioId!,
        ...(unitIds ? { _unit_ids: unitIds } : {}),
      });
      if (error) throw error;
      const out = new Map<string, number[]>();
      for (const r of data ?? []) addTo(out, r.nature, r.month, Number(r.amount));
      return out;
    },
  });
}

/** Painel da diretoria para a versão e o cenário (gestão: lê todas as unidades). */
export function useBoard(
  versionId: string | null,
  scenarioId: string | null,
  units: Unit[] | undefined,
  lines: DreLine[] | undefined,
) {
  const { revenue: revLine, result: resLine } = boardLines(lines);
  return useQuery({
    queryKey: ["dre", "board", versionId, scenarioId, revLine?.id, resLine?.id],
    enabled: !!versionId && !!scenarioId && !!units && !!revLine && !!resLine,
    queryFn: async (): Promise<Board> => {
      const unitIds = units!.filter((u) => u.active).map((u) => u.id);
      const [values, nature, targets, custom, targetShares] = await Promise.all([
        supabase.rpc("dre_unit_values", {
          _version_id: versionId!,
          _scenario_id: scenarioId!,
          _unit_ids: unitIds,
        }),
        supabase.rpc("revenue_by_nature", {
          _version_id: versionId!,
          _scenario_id: scenarioId!,
          _unit_ids: unitIds,
        }),
        supabase
          .from("revenue_targets")
          .select("unit_id, month, amount")
          .eq("scenario_id", scenarioId!),
        supabase.from("support_shares").select("unit_id, share").eq("scenario_id", scenarioId!),
        supabase.from("target_unit_shares").select("unit_id, share").eq("scenario_id", scenarioId!),
      ]);
      for (const r of [values, nature, targets, custom, targetShares]) if (r.error) throw r.error;
      const revenue = new Map<string, number[]>();
      const result = new Map<string, number[]>();
      for (const r of values.data ?? []) {
        if (r.dre_line_id === revLine!.id) addTo(revenue, r.unit_id, r.month, Number(r.amount));
        if (r.dre_line_id === resLine!.id) addTo(result, r.unit_id, r.month, Number(r.amount));
      }
      const recurring = new Map<string, number[]>();
      for (const r of nature.data ?? [])
        if (r.nature === "recorrente") addTo(recurring, r.unit_id, r.month, Number(r.amount));
      const target = new Map<string, number[]>();
      for (const r of targets.data ?? []) addTo(target, r.unit_id, r.month, Number(r.amount));
      const toMap = (rows: { unit_id: string; share: number }[] | null) =>
        new Map((rows ?? []).map((r) => [r.unit_id, Number(r.share)]));
      return buildBoard({
        units: units!,
        revenue,
        recurring,
        result,
        target,
        custom: toMap(custom.data),
        targetShares: toMap(targetShares.data),
      });
    },
  });
}

export const BASIS_LABELS: Record<Board["basis"], string> = {
  criterio: "o critério definido pelo financeiro",
  meta: "a participação de cada unidade na meta",
  receita: "a receita planejada de cada unidade",
  igual: "partes iguais",
};
