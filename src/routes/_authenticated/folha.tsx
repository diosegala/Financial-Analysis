import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { usePlanning } from "@/lib/planning";
import { MONTHS, fmtBRL } from "@/lib/format";
import { MoneyCell } from "@/components/money-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/folha")({
  head: () => ({
    meta: [
      { title: "Folha — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Pessoas da unidade e valores mensais de salário, pró-labore e CIEE." },
      { property: "og:title", content: "Folha — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Pessoas da unidade e valores mensais de salário, pró-labore e CIEE." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FolhaPage,
});

const CONTRACTS = [
  { value: "socio", label: "Sócio (pró-labore)" },
  { value: "clt", label: "CLT" },
  { value: "estagiario", label: "Estagiário (CIEE)" },
] as const;

const CONTRACT_LABELS = Object.fromEntries(CONTRACTS.map((c) => [c.value, c.label]));

const EXTRA_ROWS = [
  { kind: "beneficios", label: "Benefícios" },
  { kind: "rescisao", label: "Rescisões" },
] as const;

interface PayEntry {
  id: string;
  month: number;
  amount: number;
  kind: string;
  person_id: string | null;
}

function FolhaPage() {
  const { unitId, year } = usePlanning();
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [contract, setContract] = useState("clt");

  const canEdit = !!user?.isFinanceiro;

  const { data: people } = useQuery({
    queryKey: ["people", unitId],
    enabled: !!unitId,
    queryFn: async () =>
      (await supabase.from("people").select("id, name, contract_type").eq("unit_id", unitId!).order("name")).data ?? [],
  });

  const personIds = (people ?? []).map((p) => p.id);

  const { data: entries, isLoading } = useQuery({
    queryKey: ["payroll", unitId, year, personIds.join(",")],
    enabled: !!unitId && !!people,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_entries")
        .select("id, month, amount, kind, person_id, unit_id")
        .eq("year", year);
      if (error) throw error;
      return (data ?? []).filter(
        (e) => (e.unit_id === unitId) || (e.person_id != null && personIds.includes(e.person_id)),
      ) as PayEntry[];
    },
  });

  function entryFor(personId: string | null, kind: string, month: number) {
    return (entries ?? []).find(
      (e) => e.person_id === personId && e.kind === kind && e.month === month,
    );
  }

  async function commit(personId: string | null, kind: string, month: number, value: number) {
    const existing = entryFor(personId, kind, month);
    if (existing) {
      const { error } = await supabase.from("payroll_entries").update({ amount: value }).eq("id", existing.id);
      if (error) { toast.error("Erro ao salvar: " + error.message);
    } else if (value !== 0) {
      const { error } = await supabase.from("payroll_entries").insert({
        person_id: personId,
        unit_id: personId ? null : unitId!,
        year,
        month,
        amount: value,
        kind,
      });
      if (error) { toast.error("Erro ao salvar: " + error.message);
    }
    queryClient.invalidateQueries({ queryKey: ["payroll", unitId, year] });
    queryClient.invalidateQueries({ queryKey: ["dre-data", unitId, year] });
  }

  async function addPerson() {
    if (!name.trim()) return toast.error("Informe o nome.");
    const { error } = await supabase.from("people").insert({
      unit_id: unitId!,
      name: name.trim(),
      contract_type: contract,
    });
    if (error) { toast.error("Erro ao adicionar: " + error.message);
    setName("");
    queryClient.invalidateQueries({ queryKey: ["people", unitId] });
  }

  function rowTotal(personId: string | null, kind: string) {
    return (entries ?? [])
      .filter((e) => e.person_id === personId && e.kind === kind)
      .reduce((a, e) => a + Number(e.amount), 0);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Folha</h1>
        <p className="text-sm text-muted-foreground">
          Pessoas da unidade × 12 meses · {year}
          {canEdit
            ? " · Para reajuste, altere o valor a partir do mês desejado."
            : " · Somente o financeiro edita a folha."}
        </p>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
          <Input placeholder="Nome da pessoa" value={name} onChange={(e) => setName(e.target.value)} className="w-56" />
          <Select value={contract} onValueChange={setContract}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTRACTS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={addPerson} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> Adicionar pessoa
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 bg-muted/50 px-3 py-2 font-medium">Pessoa</th>
                <th className="px-3 py-2 font-medium">Vínculo</th>
                {MONTHS.map((m) => (
                  <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">{m}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {(people ?? []).map((p) => (
                <tr key={p.id} className="border-b border-border">
                  <td className="sticky left-0 bg-card px-3 py-1 font-medium">{p.name}</td>
                  <td className="px-3 py-1 text-muted-foreground">{CONTRACT_LABELS[p.contract_type] ?? p.contract_type}</td>
                  {MONTHS.map((_, i) => (
                    <td key={i} className="border-l border-border/50 p-0">
                      <MoneyCell
                        value={Number(entryFor(p.id, "salario", i + 1)?.amount ?? 0)}
                        disabled={!canEdit}
                        onCommit={(v) => commit(p.id, "salario", i + 1, v)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">{fmtBRL(rowTotal(p.id, "salario"))}</td>
                </tr>
              ))}
              {EXTRA_ROWS.map((r) => (
                <tr key={r.kind} className="border-b border-border bg-muted/20 last:border-0">
                  <td className="sticky left-0 bg-muted/20 px-3 py-1 font-medium">{r.label}</td>
                  <td className="px-3 py-1 text-muted-foreground">unidade</td>
                  {MONTHS.map((_, i) => (
                    <td key={i} className="border-l border-border/50 p-0">
                      <MoneyCell
                        value={Number(entryFor(null, r.kind, i + 1)?.amount ?? 0)}
                        disabled={!canEdit}
                        onCommit={(v) => commit(null, r.kind, i + 1, v)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">{fmtBRL(rowTotal(null, r.kind))}</td>
                </tr>
              ))}
              {(people ?? []).length === 0 && (
                <tr>
                  <td colSpan={15} className="px-3 py-4 text-center text-muted-foreground">
                    Nenhuma pessoa cadastrada nesta unidade.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
