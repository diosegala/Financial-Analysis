import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DreLine } from "./catalog";
import { MONTHS, fmtBRL, fmtPct } from "./format";

/** dre_line_id → month (0 = ano, 1–12) → valor. Calculado no banco por dre_report. */
export type DreValues = Map<string, Map<number, number>>;

export function useDreReport(
  versionId: string | null,
  scenarioId: string | null,
  unitIds: string[] | null,
) {
  return useQuery({
    queryKey: ["dre", versionId, scenarioId, unitIds?.join(",") ?? "all"],
    enabled: !!versionId && !!scenarioId && (unitIds === null || unitIds.length > 0),
    queryFn: async (): Promise<DreValues> => {
      const { data, error } = await supabase.rpc("dre_report", {
        _version_id: versionId!,
        _scenario_id: scenarioId!,
        ...(unitIds ? { _unit_ids: unitIds } : {}),
      });
      if (error) throw error;
      const out: DreValues = new Map();
      for (const r of data ?? []) {
        if (!out.has(r.dre_line_id)) out.set(r.dre_line_id, new Map());
        out.get(r.dre_line_id)!.set(r.month, Number(r.amount));
      }
      return out;
    },
  });
}

export const dreValue = (
  values: DreValues | undefined,
  lineId: string | undefined,
  month: number,
) => (lineId && values?.get(lineId)?.get(month)) || 0;

export function lineLabel(line: DreLine) {
  if (line.kind === "subtotal") return `(=) ${line.name}`;
  if (line.kind === "percentual") return line.name;
  return line.sign < 0 ? `(-) ${line.name}` : line.name;
}

export const fmtLine = (line: DreLine, v: number) =>
  line.kind === "percentual" ? fmtPct(v) : fmtBRL(v);

/** CSV (separador ;) que o Excel em português abre direto, com BOM para acentos. */
export function dreCsv(lines: DreLine[], values: DreValues): string {
  const num = (line: DreLine, v: number) =>
    line.kind === "percentual"
      ? (v * 100).toFixed(2).replace(".", ",") + "%"
      : v.toFixed(2).replace(".", ",");
  const header = ["Linha", ...MONTHS, "Total"].join(";");
  const rows = lines.map((l) =>
    [
      `"${lineLabel(l)}"`,
      ...[...MONTHS.keys()].map((i) => num(l, dreValue(values, l.id, i + 1))),
      num(l, dreValue(values, l.id, 0)),
    ].join(";"),
  );
  return "﻿" + [header, ...rows].join("\n");
}

export function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
