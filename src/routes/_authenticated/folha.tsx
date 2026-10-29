import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Upload } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, useContractTypes, useUnits } from "@/lib/catalog";
import { usePersonLines, usePeopleMutations, type Person, type PersonLine } from "@/lib/payroll";
import { usePlanMutations } from "@/lib/plan-data";
import { MONTHS, fmtBRL, parseNum } from "@/lib/format";
import { parseDate } from "@/lib/people-import";
import { PageHeader } from "@/components/page-header";
import { AdjustDialog, FillDialog, PlanGrid } from "@/components/plan-grid";
import { NamesImportDialog, PeopleImportDialog } from "@/components/people-import";
import { PayrollSummary } from "@/components/payroll-detail";
import { BenefitsGrid } from "@/components/benefits-grid";
import { groupBreakdown, usePayrollDetail, type BreakdownMode } from "@/lib/payroll";
import { MoneyCell } from "@/components/money-cell";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/folha")({
  head: pageHead(
    "Folha",
    "Pessoas da unidade com a remuneração mês a mês, importação da planilha e outros lançamentos de folha.",
  ),
  component: FolhaPage,
});

type Dialogs =
  | { type: "person"; person: Person | null }
  | { type: "fill"; item: PersonLine }
  | { type: "adjust"; item: PersonLine }
  | { type: "delete"; person: Person }
  | { type: "import" }
  | { type: "names" }
  | null;

interface OpenState {
  mode: BreakdownMode;
  open: string[];
}

/** Os dados da folha calculada da unidade: as linhas de cada pessoa e os totais do ano por grupo. */
function usePayrollBreakdown(mode: BreakdownMode) {
  const { versionId, scenarioId, unitId } = usePlanning();
  const { data, isLoading } = usePayrollDetail(versionId, scenarioId, unitId);
  const breakdown = useMemo(() => groupBreakdown(data ?? [], mode), [data, mode]);
  const yearTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data ?? []) m.set(r.grupo, (m.get(r.grupo) ?? 0) + r.amount);
    return m;
  }, [data]);
  return { ...breakdown, yearTotals, isLoading };
}

/** Pessoas abertas e o modo das linhas de custo, lembrados neste navegador. */
function useOpenPeople() {
  const [state, setState] = useState<OpenState>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("folha.abertas") ?? "null") as OpenState | null;
      if (saved && Array.isArray(saved.open)) return saved;
    } catch {
      // sem armazenamento ou valor inválido: começa fechado
    }
    return { mode: "grupo", open: [] };
  });
  const save = (next: OpenState) => {
    setState(next);
    try {
      localStorage.setItem("folha.abertas", JSON.stringify(next));
    } catch {
      // sem armazenamento: só não lembra
    }
  };
  return { ...state, save };
}

function FolhaPage() {
  const { unit, version, versionId, unitId, canEdit: unitEditable, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: items, isLoading } = usePersonLines(versionId, unitId);
  const { data: contractTypes } = useContractTypes();
  const { setValues } = usePlanMutations();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const opened = useOpenPeople();
  const breakdown = usePayrollBreakdown(opened.mode);
  const canEdit = unitEditable && !!user?.isFinanceiro;
  const ctMap = byId(contractTypes);
  const rows = items ?? [];
  const monthTotals = MONTHS.map((_, i) =>
    rows.reduce((a, r) => a + (r.line.values.get(i + 1) ?? 0), 0),
  );
  const openSet = new Set(opened.open);
  const allOpen = rows.length > 0 && rows.every((r) => openSet.has(r.person.id));
  const toggle = (id: string) =>
    opened.save({
      ...opened,
      open: openSet.has(id) ? opened.open.filter((o) => o !== id) : [...opened.open, id],
    });

  function pasteBlock(rowIndex: number, month: number, block: string[][]) {
    block.forEach((cells, r) => {
      const item = rows[rowIndex + r];
      if (!item) return;
      const values = cells
        .map((text, c) => ({ month: month + c, amount: parseNum(text) }))
        .filter((v): v is { month: number; amount: number } => v.month <= 12 && v.amount !== null);
      void setValues(item.line.id, values);
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Folha"
        subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"} · ${
          canEdit
            ? "A remuneração de cada pessoa é editável mês a mês. Encargos, 13º, férias e benefícios são calculados pelos parâmetros."
            : (lockReason ?? "Somente o financeiro edita a folha.")
        }`}
        actions={
          canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog({ type: "names" })}>
                Nomes
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setDialog({ type: "import" })}
              >
                <Upload className="h-4 w-4" /> Importar planilha
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setDialog({ type: "person", person: null })}
              >
                <Plus className="h-4 w-4" /> Adicionar pessoa
              </Button>
            </div>
          )
        }
      />

      {rows.length > 0 && <PayrollSummary yearTotals={breakdown.yearTotals} />}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              opened.save({ ...opened, open: allOpen ? [] : rows.map((r) => r.person.id) })
            }
          >
            {allOpen ? "Fechar todos" : "Abrir todos"}
          </Button>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Nas linhas abertas:</span>
            <div className="w-48">
              <OptionSelect
                value={opened.mode}
                onChange={(v) => v && opened.save({ ...opened, mode: v as BreakdownMode })}
                options={[
                  { value: "grupo", label: "Resumo por grupo" },
                  { value: "item", label: "Item a item" },
                ]}
              />
            </div>
          </div>
        </div>
      )}
      <div className="space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium">
                    Pessoa
                  </th>
                  {MONTHS.map((m) => (
                    <th key={m} className="min-w-24 px-2 py-2 text-right font-medium">
                      {m}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((item, r) => {
                  const { person: p, line } = item;
                  const total = [...line.values.values()].reduce((a, v) => a + v, 0);
                  const isOpen = openSet.has(p.id);
                  return (
                    <Fragment key={line.id}>
                      <tr className="border-b border-border">
                        <td className="sticky left-0 z-10 bg-card px-3 py-1">
                          <div className="flex items-center gap-1 font-medium">
                            <button
                              type="button"
                              className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
                              aria-label={isOpen ? `Fechar ${p.name}` : `Abrir ${p.name}`}
                              aria-expanded={isOpen}
                              onClick={() => toggle(p.id)}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                            {p.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {[
                              p.external_id && !p.name.startsWith("ID ")
                                ? `ID ${p.external_id}`
                                : null,
                              p.role_title,
                              ctMap.get(p.contract_type_id)?.name,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </td>
                        {MONTHS.map((_, i) => (
                          <td key={i} className="border-l border-border/50 p-0">
                            <MoneyCell
                              value={line.values.get(i + 1) ?? 0}
                              disabled={!canEdit}
                              pos={{ grid: "grid-folha-pessoas", row: r, col: i }}
                              onCommit={(v) => setValues(line.id, [{ month: i + 1, amount: v }])}
                              onPasteBlock={(block) => pasteBlock(r, i + 1, block)}
                            />
                          </td>
                        ))}
                        <td className="px-3 py-1 text-right font-mono text-sm tabular-nums">
                          {fmtBRL(total)}
                        </td>
                        <td className="px-1">
                          {canEdit && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label="Ações"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => setDialog({ type: "person", person: p })}
                                >
                                  Editar pessoa
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setDialog({ type: "fill", item })}>
                                  Preencher meses…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setDialog({ type: "adjust", item })}
                                >
                                  Reajustar a partir de um mês…
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => setDialog({ type: "delete", person: p })}
                                >
                                  Excluir
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </td>
                      </tr>
                      {isOpen &&
                        (breakdown.byPerson.get(p.id) ?? []).map((b) => (
                          <tr
                            key={b.label}
                            className={`border-b border-border/50 bg-muted/20 text-xs ${
                              b.grupo === "custo_total" ? "font-semibold" : "text-muted-foreground"
                            }`}
                          >
                            <td className="sticky left-0 z-10 bg-muted/40 py-1 pl-9 pr-3">
                              {b.label}
                            </td>
                            {b.months.map((v, i) => (
                              <td key={i} className="px-2 py-1 text-right font-mono tabular-nums">
                                {v ? fmtBRL(v) : "—"}
                              </td>
                            ))}
                            <td className="px-3 py-1 text-right font-mono tabular-nums">
                              {fmtBRL(b.months.reduce((a, v) => a + v, 0))}
                            </td>
                            <td />
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="px-3 py-8 text-center text-muted-foreground">
                      Nenhuma pessoa cadastrada nesta unidade.
                    </td>
                  </tr>
                ) : (
                  <tr className="border-t border-border bg-muted/30 font-semibold">
                    <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">
                      Total ({rows.length} pessoa{rows.length === 1 ? "" : "s"})
                    </td>
                    {monthTotals.map((t, i) => (
                      <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(t)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(monthTotals.reduce((a, t) => a + t, 0))}
                    </td>
                    <td />
                  </tr>
                )}
                {rows.length > 0 && (
                  <tr className="bg-muted/30 font-semibold">
                    <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">
                      Custo total para a empresa
                    </td>
                    {breakdown.totalCost.map((t, i) => (
                      <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {fmtBRL(t)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(breakdown.totalCost.reduce((a, t) => a + t, 0))}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <BenefitsGrid people={rows} canEdit={canEdit} />

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Outros lançamentos de folha</h2>
          <PlanGrid
            kind="folha"
            emptyText="Rescisões, confraternizações e outros custos de folha que não são por pessoa entram aqui."
          />
        </div>
      </div>

      {dialog?.type === "person" && (
        <PersonDialog person={dialog.person} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "fill" && (
        <FillDialog line={dialog.item.line} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "adjust" && (
        <AdjustDialog line={dialog.item.line} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "delete" && (
        <DeletePersonDialog person={dialog.person} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "import" && <PeopleImportDialog onClose={() => setDialog(null)} />}
      {dialog?.type === "names" && <NamesImportDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function PersonDialog({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const { versionId, unitId } = usePlanning();
  const { data: contractTypes } = useContractTypes();
  const { data: units } = useUnits();
  const { addPerson, updatePerson } = usePeopleMutations();
  const [personUnitId, setPersonUnitId] = useState<string | null>(person?.unit_id ?? unitId);
  const [externalId, setExternalId] = useState(person?.external_id ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [roleTitle, setRoleTitle] = useState(person?.role_title ?? "");
  const [contractTypeId, setContractTypeId] = useState<string | null>(
    person?.contract_type_id ?? contractTypes?.find((c) => c.active)?.id ?? null,
  );
  const [hire, setHire] = useState(person?.hire_date ?? "");
  const [dependents, setDependents] = useState(String(person?.dependents ?? 0));
  const [irrf, setIrrf] = useState(
    person?.irrf_override == null ? "" : String(person.irrf_override).replace(".", ","),
  );
  const [salary, setSalary] = useState("");
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const salaryValue = parseNum(salary);
  const dependentsValue = Number(dependents);
  const irrfValue = irrf.trim() === "" ? null : parseNum(irrf);
  const label = name.trim() || (externalId.trim() ? `ID ${externalId.trim()}` : "");
  const valid =
    label !== "" &&
    contractTypeId &&
    (hire === "" || parseDate(hire) !== null) &&
    Number.isInteger(dependentsValue) &&
    dependentsValue >= 0 &&
    (irrf.trim() === "" || (irrfValue !== null && irrfValue >= 0)) &&
    (!!person || (salaryValue !== null && (!start || !end || start <= end)));

  async function save() {
    if (!valid) return;
    const fields = {
      name: label,
      external_id: externalId.trim() || null,
      role_title: roleTitle.trim() || null,
      contract_type_id: contractTypeId!,
      hire_date: hire === "" ? null : parseDate(hire),
      dependents: dependentsValue,
      irrf_override: irrfValue,
    };
    const ok = person
      ? await updatePerson(person.id, { ...fields, unit_id: personUnitId ?? person.unit_id })
      : await addPerson({
          ...fields,
          version_id: versionId!,
          unit_id: unitId!,
          base_salary: salaryValue!,
          start_month: start,
          end_month: end,
        });
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{person ? "Editar pessoa" : "Nova pessoa"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ID" hint="O mesmo da planilha da folha.">
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </Field>
          <Field label="Nome" hint="Opcional: sem nome, a pessoa aparece pelo ID.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Cargo">
            <Input
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="opcional"
            />
          </Field>
          {person && (
            <Field
              label="Unidade"
              hint="Para transferir a pessoa. A remuneração do ano inteiro vai junto para a unidade escolhida."
            >
              <OptionSelect
                value={personUnitId}
                onChange={setPersonUnitId}
                options={(units ?? [])
                  .filter((u) => u.active)
                  .map((u) => ({ value: u.id, label: u.name }))}
              />
            </Field>
          )}
          <Field label="Vínculo">
            <OptionSelect
              value={contractTypeId}
              onChange={setContractTypeId}
              options={(contractTypes ?? [])
                .filter((c) => c.active)
                .map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
          <Field label="Data de admissão" hint="dd/mm/aaaa. Opcional.">
            <Input
              value={hire}
              onChange={(e) => setHire(e.target.value)}
              placeholder="01/03/2024"
            />
          </Field>
          <Field label="Dependentes" hint="Entram no cálculo do IRRF.">
            <Input
              value={dependents}
              onChange={(e) => setDependents(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="IRRF informado (R$/mês)"
            hint="Opcional. Substitui o cálculo pela tabela (ex.: sócios)."
          >
            <Input
              value={irrf}
              onChange={(e) => setIrrf(e.target.value)}
              className="font-mono"
              placeholder="pela tabela"
            />
          </Field>
          {!person && (
            <>
              <Field
                label="Remuneração mensal"
                hint="Salário, pró-labore ou bolsa. Preenche os meses; depois edite na grade."
              >
                <Input
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Entrada">
                  <MonthSelect value={start} onChange={setStart} noneLabel="Início do ano" />
                </Field>
                <Field label="Saída">
                  <MonthSelect value={end} onChange={setEnd} noneLabel="Fim do ano" />
                </Field>
              </div>
            </>
          )}
        </div>
        {person && (
          <p className="text-xs text-muted-foreground">
            A remuneração de cada mês se edita direto na grade da Folha.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeletePersonDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const { deletePerson } = usePeopleMutations();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir {person.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Para planejar um desligamento, zere os meses seguintes na grade. A exclusão remove a
            pessoa e a linha de remuneração desta versão.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={async () => (await deletePerson(person.id)) && onClose()}>
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
