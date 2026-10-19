import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";

export type SalaryChange = Tables<"salary_changes">;
export type Person = Tables<"people"> & { salary_changes: SalaryChange[] };

/**
 * Remuneração no mês: 0 fora do período (entrada/saída); senão o último reajuste até o mês,
 * ou o salário base. Mesma regra de plan_base_rows no banco.
 */
export function salaryFor(
  person: Pick<Person, "base_salary" | "start_month" | "end_month" | "salary_changes">,
  month: number,
): number {
  if (month < (person.start_month ?? 1) || month > (person.end_month ?? 12)) return 0;
  const change = person.salary_changes
    .filter((c) => c.month <= month)
    .sort((a, b) => b.month - a.month)[0];
  return Number(change?.new_salary ?? person.base_salary);
}

export function usePeople(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["people", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<Person[]> => {
      const { data, error } = await supabase
        .from("people")
        .select("*, salary_changes(*)")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePeopleMutations() {
  const queryClient = useQueryClient();
  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["people"] }),
      queryClient.invalidateQueries({ queryKey: ["dre"] }),
    ]);
    return true;
  }
  return {
    addPerson: (row: TablesInsert<"people">) => run(supabase.from("people").insert(row)),
    updatePerson: (id: string, patch: TablesUpdate<"people">) =>
      run(supabase.from("people").update(patch).eq("id", id)),
    deletePerson: (id: string) => run(supabase.from("people").delete().eq("id", id)),
    setSalaryChange: (personId: string, month: number, newSalary: number) =>
      run(
        supabase
          .from("salary_changes")
          .upsert(
            { person_id: personId, month, new_salary: newSalary },
            { onConflict: "person_id,month" },
          ),
      ),
    deleteSalaryChange: (id: string) => run(supabase.from("salary_changes").delete().eq("id", id)),
  };
}
