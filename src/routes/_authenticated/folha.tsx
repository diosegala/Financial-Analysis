import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, useContractTypes } from "@/lib/catalog";
import { salaryFor, usePeople, usePeopleMutations, type Person } from "@/lib/payroll";
import { MONTHS, MONTHS_FULL, fmtBRL, fmtInput, parseNum } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";
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
    "Pessoas da unidade, remuneração, reajustes e outros lançamentos de folha.",
  ),
  component: FolhaPage,
});

type Dialogs =
  | { type: "person"; person: Person | null }
  | { type: "raises"; person: Person }
  | { type: "delete"; person: Person }
  | null;

function FolhaPage() {
  const { unit, version, versionId, unitId, canEdit: unitEditable, lockReason } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: people, isLoading } = usePeople(versionId, unitId);
  const { data: contractTypes } = useContractTypes();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const canEdit = unitEditable && !!user?.isFinanceiro;
  const ctMap = byId(contractTypes);
  const rows = people ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Folha"
        subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"} · ${
          canEdit
            ? "Encargos, provisões e benefícios por pessoa são calculados pelos parâmetros."
            : (lockReason ?? "Somente o financeiro edita a folha.")
        }`}
        actions={
          canEdit && (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setDialog({ type: "person", person: null })}
            >
              <Plus className="h-4 w-4" /> Adicionar pessoa
            </Button>
          )
        }
      />

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
                  <th key={m} className="min-w-20 px-2 py-2 text-right font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const monthly = MONTHS.map((_, i) => salaryFor(p, i + 1));
                const raises = [...p.salary_changes].sort((a, b) => a.month - b.month);
                return (
                  <tr key={p.id} className="border-b border-border">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[
                          p.role_title,
                          ctMap.get(p.contract_type_id)?.name,
                          p.start_month ? `entra em ${MONTHS[p.start_month - 1]}` : null,
                          p.end_month ? `sai em ${MONTHS[p.end_month - 1]}` : null,
                          raises.length ? `${raises.length} reajuste(s)` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    {monthly.map((v, i) => (
                      <td
                        key={i}
                        className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground"
                      >
                        {v ? fmtBRL(v) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {fmtBRL(monthly.reduce((a, v) => a + v, 0))}
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
                            <DropdownMenuItem
                              onClick={() => setDialog({ type: "raises", person: p })}
                            >
                              Reajustes…
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
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={15} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhuma pessoa cadastrada nesta unidade.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Outros lançamentos de folha</h2>
        <PlanGrid
          kind="folha"
          emptyText="Rescisões, bônus ou benefícios específicos entram aqui."
        />
      </div>

      {dialog?.type === "person" && (
        <PersonDialog person={dialog.person} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "raises" && (
        <RaisesDialog
          person={rows.find((p) => p.id === dialog.person.id) ?? dialog.person}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "delete" && (
        <DeletePersonDialog person={dialog.person} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function PersonDialog({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const { versionId, unitId } = usePlanning();
  const { data: contractTypes } = useContractTypes();
  const { addPerson, updatePerson } = usePeopleMutations();
  const [name, setName] = useState(person?.name ?? "");
  const [roleTitle, setRoleTitle] = useState(person?.role_title ?? "");
  const [contractTypeId, setContractTypeId] = useState<string | null>(
    person?.contract_type_id ?? contractTypes?.[0]?.id ?? null,
  );
  const [salary, setSalary] = useState(person ? fmtInput(Number(person.base_salary)) : "");
  const [start, setStart] = useState<number | null>(person?.start_month ?? null);
  const [end, setEnd] = useState<number | null>(person?.end_month ?? null);
  const salaryValue = parseNum(salary);
  const valid =
    name.trim() !== "" &&
    contractTypeId &&
    salaryValue !== null &&
    (!start || !end || start <= end);

  async function save() {
    if (!valid) return;
    const fields = {
      name: name.trim(),
      role_title: roleTitle.trim() || null,
      contract_type_id: contractTypeId!,
      base_salary: salaryValue!,
      start_month: start,
      end_month: end,
    };
    const ok = person
      ? await updatePerson(person.id, fields)
      : await addPerson({ ...fields, version_id: versionId!, unit_id: unitId! });
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{person ? "Editar pessoa" : "Nova pessoa"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Cargo">
            <Input
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="opcional"
            />
          </Field>
          <Field label="Vínculo">
            <OptionSelect
              value={contractTypeId}
              onChange={setContractTypeId}
              options={(contractTypes ?? [])
                .filter((c) => c.active)
                .map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
          <Field label="Remuneração mensal" hint="Salário, pró-labore ou bolsa.">
            <Input
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Entrada">
            <MonthSelect value={start} onChange={setStart} noneLabel="Já está no início do ano" />
          </Field>
          <Field label="Saída">
            <MonthSelect value={end} onChange={setEnd} noneLabel="Fica até o fim do ano" />
          </Field>
        </div>
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

function RaisesDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const { setSalaryChange, deleteSalaryChange } = usePeopleMutations();
  const [month, setMonth] = useState<number | null>(1);
  const [mode, setMode] = useState<"valor" | "pct">("pct");
  const [input, setInput] = useState("");
  const parsed = parseNum(input);
  const current = month ? salaryFor({ ...person, start_month: null, end_month: null }, month) : 0;
  const newSalary =
    parsed === null || input.trim() === ""
      ? null
      : mode === "pct"
        ? Math.round(current * (1 + parsed / 100) * 100) / 100
        : parsed;
  const raises = [...person.salary_changes].sort((a, b) => a.month - b.month);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reajustes de {person.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            <li className="flex justify-between px-3 py-1.5 text-muted-foreground">
              <span>Base</span>
              <span className="font-mono">{fmtBRL(Number(person.base_salary))}</span>
            </li>
            {raises.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-3 py-1.5">
                <span>A partir de {MONTHS_FULL[r.month - 1]}</span>
                <span className="flex items-center gap-2 font-mono">
                  {fmtBRL(Number(r.new_salary))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => deleteSalaryChange(r.id)}
                  >
                    remover
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-3 gap-3">
            <Field label="A partir de">
              <MonthSelect value={month} onChange={setMonth} />
            </Field>
            <Field label="Tipo">
              <OptionSelect
                value={mode}
                onChange={(v) => setMode((v as "valor" | "pct") ?? "pct")}
                options={[
                  { value: "pct", label: "Percentual" },
                  { value: "valor", label: "Novo valor" },
                ]}
              />
            </Field>
            <Field label={mode === "pct" ? "Reajuste (%)" : "Novo valor"}>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          {newSalary !== null && month && (
            <p className="text-sm text-muted-foreground">
              De {fmtBRL(current)} para <strong>{fmtBRL(newSalary)}</strong> a partir de{" "}
              {MONTHS_FULL[month - 1]}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
          <Button
            disabled={newSalary === null || !month}
            onClick={async () => {
              if (
                newSalary !== null &&
                month &&
                (await setSalaryChange(person.id, month, newSalary))
              )
                setInput("");
            }}
          >
            Adicionar reajuste
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
            Para planejar um desligamento, prefira informar o mês de saída. A exclusão remove a
            pessoa e os reajustes desta versão.
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
