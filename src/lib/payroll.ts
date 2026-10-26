import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { friendlyError } from "./catalog";
import type { PlanLine } from "./plan-data";
import type { ImportedName, ImportedPerson } from "./people-import";

export type Person = Tables<"people">;

/** A pessoa e a linha do plano com a remuneração mês a mês (a linha é a fonte da verdade). */
export interface PersonLine {
  person: Person;
  line: PlanLine;
}

/** Pessoas da unidade, cada uma com a sua linha de remuneração. */
export function usePersonLines(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["people", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<PersonLine[]> => {
      const { data, error } = await supabase
        .from("plan_lines")
        .select("*, plan_values(month, amount), people!inner(*)")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!)
        .not("person_id", "is", null);
      if (error) throw error;
      return (data ?? [])
        .map(({ plan_values, people, ...line }) => ({
          person: people,
          line: { ...line, values: new Map(plan_values.map((v) => [v.month, Number(v.amount)])) },
        }))
        .sort((a, b) => a.person.name.localeCompare(b.person.name, "pt-BR", { numeric: true }));
    },
  });
}

/** IDs das pessoas já cadastradas na versão (todas as unidades), para a importação saber quem já existe. */
export function useExternalIds(versionId: string | null) {
  return useQuery({
    queryKey: ["people", "external_ids", versionId],
    enabled: !!versionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("people")
        .select("external_id")
        .eq("version_id", versionId!)
        .not("external_id", "is", null);
      if (error) throw error;
      return new Set((data ?? []).map((p) => p.external_id!));
    },
  });
}

export function usePeopleMutations() {
  const queryClient = useQueryClient();
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["people"] }),
      queryClient.invalidateQueries({ queryKey: ["plan_lines"] }),
      queryClient.invalidateQueries({ queryKey: ["dre"] }),
      queryClient.invalidateQueries({ queryKey: ["payroll_detail"] }),
    ]);
  }
  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    if (error) {
      toast.error(friendlyError(error.message));
      return false;
    }
    await refresh();
    return true;
  }
  return {
    // Cadastrar a pessoa já cria a linha de remuneração, com os meses do salário informado.
    addPerson: (row: TablesInsert<"people">) => run(supabase.from("people").insert(row)),
    updatePerson: (id: string, patch: TablesUpdate<"people">) =>
      run(supabase.from("people").update(patch).eq("id", id)),
    deletePerson: (id: string) => run(supabase.from("people").delete().eq("id", id)),
    /** Troca o "ID 12" pelo nome da pessoa, casando pelo ID da planilha. Devolve quantas foram atualizadas. */
    importNames: async (versionId: string, rows: ImportedName[]) => {
      let updated = 0;
      for (const r of rows) {
        const { data, error } = await supabase
          .from("people")
          .update({ name: r.name })
          .eq("version_id", versionId)
          .eq("external_id", r.external_id)
          .select("id");
        if (error) {
          toast.error(friendlyError(error.message));
          await refresh();
          return null;
        }
        updated += data?.length ?? 0;
      }
      await refresh();
      return updated;
    },
    importPeople: async (versionId: string, rows: ImportedPerson[], overwrite: boolean) => {
      const { data, error } = await supabase.rpc("import_people", {
        _version_id: versionId,
        _rows: rows.map(({ line: _line, ...row }) => ({
          external_id: row.external_id,
          unit_id: row.unit_id,
          role_title: row.role_title,
          contract_type_id: row.contract_type_id,
          hire_date: row.hire_date,
          salary: row.salary,
        })),
        _overwrite: overwrite,
      });
      if (error) {
        toast.error(friendlyError(error.message));
        return null;
      }
      await refresh();
      return data as { created: number; updated: number };
    },
  };
}

export type PayrollGroup =
  "bruto" | "retencao" | "liquido" | "encargo" | "provisao" | "beneficio" | "custo_total";

export interface PayrollDetailRow {
  person_id: string;
  month: number;
  grupo: PayrollGroup;
  item: string;
  amount: number;
}

/** Bruto, retenções, líquido, encargos, provisões, benefícios e custo total por pessoa e mês. */
export function usePayrollDetail(
  versionId: string | null,
  scenarioId: string | null,
  unitId: string | null,
) {
  return useQuery({
    queryKey: ["payroll_detail", versionId, scenarioId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async (): Promise<PayrollDetailRow[]> => {
      // Uma linha por pessoa, mês e item: uma unidade com 20 pessoas passa de 3 mil linhas, e o Supabase entrega no
      // máximo 1.000 por consulta. Lê em páginas, em ordem fixa.
      const data = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .rpc("payroll_detail", {
            _version_id: versionId!,
            ...(scenarioId ? { _scenario_id: scenarioId } : {}),
            _unit_ids: [unitId!],
          })
          .order("person_id")
          .order("month")
          .order("item")
          .range(from, from + 999);
        if (error) throw error;
        data.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      return data.map((r) => ({
        person_id: r.person_id,
        month: r.month,
        grupo: r.grupo as PayrollGroup,
        item: r.item,
        amount: Number(r.amount),
      }));
    },
  });
}
