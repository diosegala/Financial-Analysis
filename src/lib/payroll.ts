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
        .select("*, plan_values(month, amount), people!plan_lines_person_id_fkey!inner(*)")
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
      queryClient.invalidateQueries({ queryKey: ["person_benefits"] }),
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

export const PAYROLL_GROUPS: { group: PayrollGroup; label: string; hint: string }[] = [
  { group: "bruto", label: "Salário bruto", hint: "O que a pessoa tem direito" },
  {
    group: "retencao",
    label: "INSS e IRRF do empregado",
    hint: "Retidos do bruto, não são custo extra",
  },
  { group: "liquido", label: "Salário líquido", hint: "O que a pessoa recebe" },
  { group: "encargo", label: "Encargos patronais", hint: "INSS patronal, RAT, terceiros, FGTS…" },
  { group: "provisao", label: "Provisões", hint: "13º e férias" },
  { group: "beneficio", label: "Benefícios", hint: "Por pessoa ativa" },
  { group: "custo_total", label: "Custo total", hint: "Bruto + encargos + provisões + benefícios" },
];

export type BreakdownMode = "grupo" | "item";

export interface BreakdownLine {
  label: string;
  grupo: PayrollGroup;
  months: number[];
}

/**
 * As linhas abaixo de cada pessoa na Folha: por grupo (retenções, líquido, encargos…) ou item a item.
 * O bruto fica de fora, porque é a própria linha da pessoa. As provisões (13º, férias) saem sempre item a item.
 */
export function groupBreakdown(rows: PayrollDetailRow[], mode: BreakdownMode) {
  const order = PAYROLL_GROUPS.map((g) => g.group);
  const labels = new Map(PAYROLL_GROUPS.map((g) => [g.group, g.label]));
  const byPerson = new Map<string, Map<string, BreakdownLine>>();
  for (const r of rows) {
    if (r.grupo === "bruto") continue;
    const byGroup = mode === "grupo" && r.grupo !== "provisao";
    const key = byGroup ? r.grupo : r.item;
    const lines = byPerson.get(r.person_id) ?? new Map<string, BreakdownLine>();
    byPerson.set(r.person_id, lines);
    let line = lines.get(key);
    if (!line) {
      line = {
        label: byGroup ? (labels.get(r.grupo) ?? r.grupo) : r.item,
        grupo: r.grupo,
        months: Array(12).fill(0),
      };
      lines.set(key, line);
    }
    line.months[r.month - 1] = (line.months[r.month - 1] ?? 0) + r.amount;
  }
  const result = new Map<string, BreakdownLine[]>();
  for (const [person, lines] of byPerson)
    result.set(
      person,
      [...lines.values()].sort((a, b) => order.indexOf(a.grupo) - order.indexOf(b.grupo)),
    );
  const totalCost = Array(12).fill(0) as number[];
  for (const r of rows)
    if (r.grupo === "custo_total")
      totalCost[r.month - 1] = (totalCost[r.month - 1] ?? 0) + r.amount;
  return { byPerson: result, totalCost };
}

/** Valor mensal de cada benefício por pessoa da unidade (pessoa → conta → valor). */
export function usePersonBenefits(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["person_benefits", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("person_benefits")
        .select("person_id, account_id, amount, people!inner(version_id, unit_id)")
        .eq("people.version_id", versionId!)
        .eq("people.unit_id", unitId!);
      if (error) throw error;
      const m = new Map<string, Map<string, number>>();
      for (const r of data ?? []) {
        const row = m.get(r.person_id) ?? new Map<string, number>();
        row.set(r.account_id, Number(r.amount));
        m.set(r.person_id, row);
      }
      return m;
    },
  });
}

/** Total da base do Omie de cada benefício que já passou a ser lançado por pessoa (conta → valor no ano). */
export function useBenefitBases(versionId: string | null, unitId: string | null) {
  return useQuery({
    queryKey: ["benefit_bases", versionId, unitId],
    enabled: !!versionId && !!unitId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("benefit_bases")
        .select("account_id, amount")
        .eq("version_id", versionId!)
        .eq("unit_id", unitId!);
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.account_id, Number(r.amount)]));
    },
  });
}

export function useBenefitMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      [
        "person_benefits",
        "benefit_bases",
        "plan_lines",
        "payroll_detail",
        "dre",
        "target_vs_plan",
      ].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
    );
  const fail = (e: { message: string } | null) => {
    if (e) toast.error(friendlyError(e.message));
    return !e;
  };
  return {
    /** Grava vários valores de uma vez (colar da planilha); zero ou vazio tira o benefício da pessoa. */
    async setBenefits(cells: { personId: string; accountId: string; amount: number }[]) {
      const keep = cells.filter((c) => c.amount > 0);
      const drop = cells.filter((c) => c.amount <= 0);
      let error: { message: string } | null = null;
      if (keep.length) {
        ({ error } = await supabase.from("person_benefits").upsert(
          keep.map((c) => ({ person_id: c.personId, account_id: c.accountId, amount: c.amount })),
          { onConflict: "person_id,account_id" },
        ));
      }
      for (const c of drop) {
        if (error) break;
        ({ error } = await supabase
          .from("person_benefits")
          .delete()
          .eq("person_id", c.personId)
          .eq("account_id", c.accountId));
      }
      await refresh();
      return fail(error);
    },
    /** Cria uma conta de Folha lançável já marcada como benefício por pessoa (ex.: auxílio home office). */
    async addBenefit(name: string, dreLineId: string) {
      const { error } = await supabase.from("accounts").insert({
        name,
        kind: "folha",
        treatment: "lancavel",
        per_person: true,
        dre_line_id: dreLineId,
      });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      if (!error) toast.success(`Benefício "${name}" criado.`);
      return fail(error);
    },
    async distribute(versionId: string, unitId: string) {
      const { data, error } = await supabase.rpc("distribute_benefits", {
        _version_id: versionId,
        _unit_id: unitId,
      });
      await refresh();
      if (!error) toast.success(`${data} benefício(s) distribuído(s) entre as pessoas.`);
      return fail(error);
    },
  };
}
