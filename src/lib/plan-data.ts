import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type AccountKind = "receita" | "despesa" | "folha";

export interface NewLine {
  version_id: string;
  unit_id: string;
  account_id: string;
  description?: string | null;
  client_id?: string | null;
  product_id?: string | null;
  revenue_type_id?: string | null;
  event_id?: string | null;
  revenue_origin?: string | null;
  note?: string | null;
}

export type PlanLine = Tables<"plan_lines"> & {
  /** month (1–12) → amount */
  values: Map<number, number>;
};

/**
 * Linhas de uma grade. Sem `eventId`, só as linhas avulsas (os itens de evento aparecem em Eventos);
 * com `eventId`, só os itens daquele evento.
 */
export function usePlanLines(
  versionId: string | null,
  unitId: string | null,
  kind: AccountKind,
  eventId: string | null = null,
) {
  return useQuery({
    queryKey: ["plan_lines", versionId, unitId, kind, eventId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<PlanLine[]> => {
      // Em páginas de 1.000 (limite do Supabase por consulta): uma unidade pode ter centenas de lançamentos.
      const data = [];
      for (let from = 0; ; from += 1000) {
        const base = supabase
          .from("plan_lines")
          .select("*, plan_values(month, amount), accounts!inner(kind)")
          .eq("version_id", versionId!)
          .eq("unit_id", unitId!)
          .eq("accounts.kind", kind)
          // A remuneração das pessoas tem grade própria, na Folha.
          .is("person_id", null);
        const { data: page, error } = await (
          eventId ? base.eq("event_id", eventId) : base.is("event_id", null)
        )
          .order("sort_order")
          .order("created_at")
          .order("id")
          .range(from, from + 999);
        if (error) throw error;
        data.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      return (data ?? []).map(({ plan_values, accounts: _account, ...line }) => ({
        ...line,
        values: new Map(plan_values.map((v) => [v.month, Number(v.amount)])),
      }));
    },
  });
}

export function usePlanMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["plan_lines"] }),
      queryClient.invalidateQueries({ queryKey: ["dre"] }),
      queryClient.invalidateQueries({ queryKey: ["event_items"] }),
      queryClient.invalidateQueries({ queryKey: ["people"] }),
      queryClient.invalidateQueries({ queryKey: ["payroll_detail"] }),
      queryClient.invalidateQueries({ queryKey: ["target_vs_plan"] }),
    ]);

  function fail(error: { message: string } | null) {
    if (!error) return false;
    toast.error(friendlyError(error.message));
    return true;
  }

  /** Upserts month values; amount 0 is stored as 0 (keeps the cell explicit). */
  async function setValues(lineId: string, values: { month: number; amount: number }[]) {
    if (values.length === 0) return true;
    const { error } = await supabase.from("plan_values").upsert(
      values.map((v) => ({ line_id: lineId, ...v })),
      { onConflict: "line_id,month" },
    );
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  /**
   * Cria a linha já com os meses. Passa pela função launch_line do banco: o líder só consegue lançar
   * linhas novas; alterar ou excluir o que já foi lançado é do financeiro.
   */
  async function addLine(
    line: NewLine,
    values: { month: number; amount: number }[] = [],
  ): Promise<string | null> {
    const id = await launch(line, values);
    if (id) await refresh();
    return id;
  }

  /** Várias linhas de uma vez (ex.: coladas da planilha), atualizando a tela uma vez só. Devolve quantas entraram. */
  async function addLines(rows: { line: NewLine; values: { month: number; amount: number }[] }[]) {
    let ok = 0;
    for (const r of rows) {
      if (!(await launch(r.line, r.values))) break;
      ok++;
    }
    await refresh();
    return ok;
  }

  async function launch(line: NewLine, values: { month: number; amount: number }[]) {
    // As colunas opcionais aceitam null; os tipos gerados as marcam como obrigatórias.
    const orNull = <T>(v: T | null | undefined) => (v ?? null) as T;
    const { data, error } = await supabase.rpc("launch_line", {
      _version_id: line.version_id,
      _unit_id: line.unit_id,
      _account_id: line.account_id,
      _description: orNull(line.description),
      _client_id: orNull(line.client_id),
      _product_id: orNull(line.product_id),
      _revenue_type_id: orNull(line.revenue_type_id),
      _values: values,
      _event_id: orNull(line.event_id),
      _revenue_origin: orNull(line.revenue_origin),
      _note: orNull(line.note),
    });
    if (fail(error) || !data) return null;
    return data;
  }

  async function updateLine(id: string, patch: TablesUpdate<"plan_lines">) {
    const { error } = await supabase.from("plan_lines").update(patch).eq("id", id);
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  async function deleteLine(id: string) {
    const { error } = await supabase.from("plan_lines").delete().eq("id", id);
    if (fail(error)) return false;
    await refresh();
    return true;
  }

  return { setValues, addLine, addLines, updateLine, deleteLine };
}

/** Months [start, start + count) clipped to December. */
export function monthRange(start: number, count: number): number[] {
  return Array.from({ length: Math.max(0, Math.min(count, 13 - start)) }, (_, i) => start + i);
}

/** Applies a % adjustment from a month on: every month >= from gets amount × (1 + pct). */
export function adjustFrom(values: Map<number, number>, from: number, pct: number) {
  return [...values.entries()]
    .filter(([m]) => m >= from)
    .map(([month, amount]) => ({ month, amount: Math.round(amount * (1 + pct) * 100) / 100 }));
}
