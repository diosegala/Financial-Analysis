import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "./catalog";

export interface Allocation {
  unit_id: string;
  share: number;
}

/** Partes de pessoas rateadas para outras unidades, por pessoa (o que o usuário pode ver). */
export function usePersonAllocations(versionId: string | null) {
  return useQuery({
    queryKey: ["person_allocations", versionId],
    enabled: !!versionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("person_allocations")
        .select("person_id, unit_id, share, people!inner(version_id)")
        .eq("people.version_id", versionId!);
      if (error) throw error;
      const out = new Map<string, Allocation[]>();
      for (const r of data ?? [])
        out.set(r.person_id, [
          ...(out.get(r.person_id) ?? []),
          { unit_id: r.unit_id, share: Number(r.share) },
        ]);
      return out;
    },
  });
}

/** Pessoas de outras unidades com parte do custo nesta unidade. */
export function useUnitAllocatedPeople(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["unit_allocated_people", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("unit_allocated_people", {
        _version_id: versionId!,
        _unit_id: unitId!,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Troca as partes de uma pessoa nas outras unidades. */
export function useSaveAllocations() {
  const queryClient = useQueryClient();
  return async (personId: string, allocations: Allocation[]) => {
    const del = await supabase.from("person_allocations").delete().eq("person_id", personId);
    if (del.error) {
      toast.error(friendlyError(del.error.message));
      return false;
    }
    if (allocations.length) {
      const ins = await supabase
        .from("person_allocations")
        .insert(allocations.map((a) => ({ person_id: personId, ...a })));
      if (ins.error) {
        toast.error(friendlyError(ins.error.message));
        return false;
      }
    }
    await queryClient.invalidateQueries();
    return true;
  };
}
