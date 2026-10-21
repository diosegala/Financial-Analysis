import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";
import type { Product } from "./products";

export type PlanEvent = Tables<"events">;

export function useEvents(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["events", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<PlanEvent[]> => {
      const { data, error } = await supabase
        .from("events")
        .select("*")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .order("month")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Item de evento já com o total do ano, para resumir resultados. */
export interface EventItem {
  eventId: string;
  kind: "receita" | "despesa";
  accountId: string;
  revenueTypeId: string | null;
  total: number;
}

export function useEventItems(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["event_items", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<EventItem[]> => {
      const { data, error } = await supabase
        .from("plan_lines")
        .select("event_id, account_id, revenue_type_id, accounts!inner(kind), plan_values(amount)")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .not("event_id", "is", null);
      if (error) throw error;
      return (data ?? []).map((l) => ({
        eventId: l.event_id!,
        kind: l.accounts.kind as EventItem["kind"],
        accountId: l.account_id,
        revenueTypeId: l.revenue_type_id,
        total: l.plan_values.reduce((a, v) => a + Number(v.amount), 0),
      }));
    },
  });
}

export interface EventSummary {
  receita: number;
  custo: number;
  resultado: number;
  /** Resultado ÷ receita; null quando não há receita. */
  margem: number | null;
  /** Receita por tipo de receita (ex.: Ingressos, Patrocínio). */
  porOrigem: Map<string, number>;
  /** Custo por categoria (conta). */
  porCategoria: Map<string, number>;
}

export function summarizeEvent(items: EventItem[]): EventSummary {
  const porOrigem = new Map<string, number>();
  const porCategoria = new Map<string, number>();
  let receita = 0;
  let custo = 0;
  for (const i of items) {
    if (i.kind === "receita") {
      receita += i.total;
      const key = i.revenueTypeId ?? "";
      porOrigem.set(key, (porOrigem.get(key) ?? 0) + i.total);
    } else {
      custo += i.total;
      porCategoria.set(i.accountId, (porCategoria.get(i.accountId) ?? 0) + i.total);
    }
  }
  return {
    receita,
    custo,
    resultado: receita - custo,
    margem: receita === 0 ? null : (receita - custo) / receita,
    porOrigem,
    porCategoria,
  };
}

export interface StandardItem {
  kind: "receita" | "despesa";
  description: string;
  amount: number;
}

/**
 * Itens iniciais de um evento a partir do que o produto traz (vagas, preço e custos), todos no mês do
 * evento. Só entra o que o produto informa.
 */
export function standardItems(
  product: Pick<Product, "default_seats" | "price" | "cost_per_participant" | "fixed_cost">,
  fmt: (n: number) => string,
): StandardItem[] {
  const seats = Number(product.default_seats ?? 0);
  const price = Number(product.price ?? 0);
  const cpp = Number(product.cost_per_participant ?? 0);
  const fixed = Number(product.fixed_cost ?? 0);
  const items: StandardItem[] = [];
  if (seats > 0 && price > 0)
    items.push({
      kind: "receita",
      description: `Ingressos (${seats} × ${fmt(price)})`,
      amount: seats * price,
    });
  if (seats > 0 && cpp > 0)
    items.push({
      kind: "despesa",
      description: `Custo por participante (${seats} × ${fmt(cpp)})`,
      amount: seats * cpp,
    });
  if (fixed > 0)
    items.push({ kind: "despesa", description: "Custo fixo do evento", amount: fixed });
  return items;
}

export function useEventMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      ["events", "event_items", "plan_lines", "dre"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );

  async function run<T>(
    p: PromiseLike<{ data?: T; error: { message: string } | null }>,
  ): Promise<T | null | false> {
    const { data, error } = await p;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await refresh();
    return (data ?? null) as T | null;
  }

  return {
    /** Cria o evento e, se vierem, os itens iniciais. Devolve o id, ou false se falhou. */
    async createEvent(args: {
      versionId: string;
      unitId: string;
      productId: string | null;
      name: string;
      month: number;
      lines?: {
        account_id: string;
        description: string;
        revenue_type_id: string | null;
        values: { month: number; amount: number }[];
      }[];
    }) {
      return run(
        supabase.rpc("launch_event", {
          _version_id: args.versionId,
          _unit_id: args.unitId,
          _product_id: args.productId as string,
          _name: args.name,
          _month: args.month,
          _lines: args.lines ?? [],
        }),
      );
    },
    updateEvent: (id: string, patch: { name: string; product_id: string | null; month: number }) =>
      run(supabase.from("events").update(patch).eq("id", id)),
    deleteEvent: (id: string) => run(supabase.from("events").delete().eq("id", id)),
  };
}
