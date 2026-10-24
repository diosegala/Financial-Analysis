import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useAccounts, useUnits, byId } from "@/lib/catalog";
import { usePlanMutations } from "@/lib/plan-data";
import {
  matchAccount,
  planFromActuals,
  useOmieExpenses,
  type AccountMatch,
  type OmieExpense,
} from "@/lib/omie";
import { norm } from "@/lib/products-import";
import { MONTHS, fmtBRL, fmtInput, parseNum } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/realizado")({
  head: pageHead(
    "Realizado do Omie",
    "Despesas do ano anterior lidas do Omie, como base para planejar o próximo ano.",
  ),
  component: RealizadoPage,
});

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);
const monthly = (r: OmieExpense) => r.paid.map((p, i) => p + (r.open[i] ?? 0));

type Row = OmieExpense & { match: AccountMatch; total: number };
type Filter = "lancaveis" | "sem_conta" | "calculadas" | "todas";

function RealizadoPage() {
  const { data: user, isLoading: loadingUser } = useCurrentUser();
  const { version } = usePlanning();
  const year = version ? version.year - 1 : undefined;
  const { data: expenses, isLoading } = useOmieExpenses(year);
  const { data: accounts } = useAccounts();
  const { data: units } = useUnits();
  const [filter, setFilter] = useState<Filter>("lancaveis");
  const [search, setSearch] = useState("");
  const [planning, setPlanning] = useState<Row | null>(null);
  const unitMap = byId(units);

  const rows: Row[] = useMemo(
    () =>
      (expenses ?? [])
        .map((e) => ({
          ...e,
          match: matchAccount(e.categoryName, accounts ?? [], version?.year ?? 0),
          total: sum(monthly(e)),
        }))
        .filter((r) => r.total !== 0)
        .sort((a, b) => b.total - a.total),
    [expenses, accounts, version],
  );

  if (!loadingUser && user && !user.isFinanceiro) return <Navigate to="/inicio" />;

  const byStatus = (s: AccountMatch["status"]) => rows.filter((r) => r.match.status === s);
  const shown = rows
    .filter((r) =>
      filter === "todas"
        ? true
        : filter === "lancaveis"
          ? r.match.status === "conta"
          : filter === "sem_conta"
            ? r.match.status === "sem_conta"
            : r.match.status === "calculada" || r.match.status === "fora_dre",
    )
    .filter((r) => search.trim() === "" || norm(r.categoryName).includes(norm(search)));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Realizado ${year ?? ""} (Omie)`}
        subtitle="Contas a pagar das três empresas, somadas por categoria, pela data de emissão. Somente leitura: o app nunca escreve no Omie. Use como base para planejar a versão aberta."
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          Nenhum realizado de {year} no banco. Rode a leitura do Omie (`python3
          scripts/omie-sync.py`) e volte aqui.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Total do ano", rows, "Tudo que foi lido"],
              ["Com conta no app", byStatus("conta"), "Pode virar linha do plano"],
              ["Sem conta no app", byStatus("sem_conta"), "Importe ou crie a conta primeiro"],
              [
                "Calculado pelo app ou fora da DRE",
                [...byStatus("calculada"), ...byStatus("fora_dre")],
                "Folha, encargos e impostos não se lançam",
              ],
            ].map(([label, list, hint]) => (
              <div key={label as string} className="rounded-md border border-border bg-card p-3">
                <div className="text-xs text-muted-foreground">{label as string}</div>
                <div className="font-mono text-lg tabular-nums">
                  {fmtBRL(sum((list as Row[]).map((r) => r.total)))}
                </div>
                <div className="text-xs text-muted-foreground">{hint as string}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <OptionSelect
                value={filter}
                onChange={(v) => v && setFilter(v as Filter)}
                options={[
                  { value: "lancaveis", label: "Com conta no app" },
                  { value: "sem_conta", label: "Sem conta no app" },
                  { value: "calculadas", label: "Calculadas ou fora da DRE" },
                  { value: "todas", label: "Todas" },
                ]}
              />
            </div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar categoria"
              aria-label="Buscar categoria"
              className="w-64"
            />
          </div>

          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="px-3 py-2 font-medium">Categoria do Omie</th>
                  <th className="px-3 py-2 font-medium">Unidade no Omie</th>
                  <th className="px-3 py-2 font-medium">Conta no app</th>
                  <th className="px-3 py-2 text-right font-medium">Pago</th>
                  <th className="px-3 py-2 text-right font-medium">Em aberto</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={`${r.categoryName}|${r.unitId}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-3 py-1.5 font-medium">{r.categoryName}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {r.unitId ? (unitMap.get(r.unitId)?.name ?? "—") : "Sem departamento"}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.match.status === "sem_conta" ? (
                        <Badge variant="outline">sem conta</Badge>
                      ) : (
                        <span className={r.match.status === "conta" ? "" : "text-muted-foreground"}>
                          {r.match.account.name}
                          {r.match.status !== "conta" && (
                            <span className="ml-1 text-xs">
                              (
                              {r.match.status === "calculada"
                                ? "calculada pelo app"
                                : "fora da DRE"}
                              )
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(sum(r.paid))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(sum(r.open))}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(r.total)}
                    </td>
                    <td className="px-2">
                      {r.match.status === "conta" && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Planejar ${r.categoryName}`}
                          onClick={() => setPlanning(r)}
                        >
                          Planejar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      Nada neste filtro.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {planning && year && (
        <PlanDialog row={planning} year={year} onClose={() => setPlanning(null)} />
      )}
    </div>
  );
}

function PlanDialog({ row, year, onClose }: { row: Row; year: number; onClose: () => void }) {
  const { version, versionId } = usePlanning();
  const { data: units } = useUnits();
  const { addLine } = usePlanMutations();
  const [unitId, setUnitId] = useState<string | null>(row.unitId);
  const [share, setShare] = useState("100");
  const [adjust, setAdjust] = useState("0");
  const [mode, setMode] = useState<"mes_a_mes" | "media">("mes_a_mes");
  const [saving, setSaving] = useState(false);
  const shareN = parseNum(share);
  const adjustN = parseNum(adjust);
  const valid =
    !!unitId && shareN !== null && shareN > 0 && adjustN !== null && row.match.status === "conta";
  const schedule = valid ? planFromActuals(monthly(row), shareN! / 100, adjustN! / 100, mode) : [];
  const total = schedule.reduce((a, m) => a + m.amount, 0);

  async function save() {
    if (!valid || row.match.status !== "conta" || !versionId) return;
    setSaving(true);
    const id = await addLine(
      {
        version_id: versionId,
        unit_id: unitId!,
        account_id: row.match.account.id,
        description: `Base ${year} (Omie)`,
      },
      schedule,
    );
    setSaving(false);
    if (id) {
      toast.success(`Linha criada em ${version?.name ?? "a versão"}: ${fmtBRL(total)}.`);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Planejar {version?.year} a partir de {year}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {row.categoryName} →{" "}
            <strong>{row.match.status === "conta" ? row.match.account.name : ""}</strong> ·
            realizado {fmtBRL(sum(monthly(row)))}. A maior parte das contas a pagar não tem
            departamento no Omie: escolha a unidade e quanto desta despesa pertence a ela.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unidade">
              <OptionSelect
                value={unitId}
                onChange={setUnitId}
                options={(units ?? [])
                  .filter((u) => u.active)
                  .map((u) => ({ value: u.id, label: u.name }))}
              />
            </Field>
            <Field
              label="Parte do realizado (%)"
              hint="100 = tudo; 40 = 40% desta despesa vai para a unidade."
            >
              <Input
                value={share}
                onChange={(e) => setShare(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Reajuste sobre o realizado (%)">
              <Input
                value={adjust}
                onChange={(e) => setAdjust(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Distribuição">
              <OptionSelect
                value={mode}
                onChange={(v) => v && setMode(v as "mes_a_mes" | "media")}
                options={[
                  { value: "mes_a_mes", label: `Mês a mês, como em ${year}` },
                  { value: "media", label: "Média dos 12 meses" },
                ]}
              />
            </Field>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  {MONTHS.map((m) => (
                    <th key={m} className="px-1.5 py-1 text-right font-medium">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {MONTHS.map((_, i) => (
                    <td key={i} className="px-1.5 py-1 text-right font-mono tabular-nums">
                      {fmtInput(schedule.find((m) => m.month === i + 1)?.amount ?? 0, 0)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            Total planejado: <strong>{fmtBRL(total)}</strong>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            Criar linha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
