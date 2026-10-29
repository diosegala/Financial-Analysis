import { useState } from "react";
import { usePlanning } from "@/lib/planning";
import { useAccounts } from "@/lib/catalog";
import { usePlanLines } from "@/lib/plan-data";
import {
  useBenefitBases,
  useBenefitMutations,
  usePersonBenefits,
  type PersonLine,
} from "@/lib/payroll";
import { fmtBRL, parseNum } from "@/lib/format";
import { MoneyCell } from "@/components/money-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/**
 * Benefícios por pessoa, como na planilha: uma linha por pessoa, uma coluna por benefício, valor mensal.
 * O valor vale nos meses em que a pessoa tem salário. As contas são as marcadas como "Benefício por pessoa".
 */
export function BenefitsGrid({ people, canEdit }: { people: PersonLine[]; canEdit: boolean }) {
  const { versionId, unitId } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: benefits } = usePersonBenefits(versionId, unitId);
  const { data: bases } = useBenefitBases(versionId, unitId);
  const { data: folhaLines } = usePlanLines(versionId, unitId, "folha");
  const { setBenefits, distribute, addBenefit } = useBenefitMutations();
  const [confirm, setConfirm] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  const cols = (accounts ?? []).filter(
    (a) =>
      a.active &&
      a.kind === "folha" &&
      a.treatment === "lancavel" &&
      a.per_person &&
      (!a.unit_ids || (unitId && a.unit_ids.includes(unitId))),
  );
  if (people.length === 0 || (cols.length === 0 && !canEdit)) return null;
  // O benefício novo soma na mesma linha da DRE dos que já existem.
  const folha = (accounts ?? []).filter((a) => a.kind === "folha" && a.dre_line_id);
  const dreLineId = (
    folha.find((a) => a.per_person) ?? folha.find((a) => a.treatment === "lancavel")
  )?.dre_line_id;

  // Base do Omie: a linha gerada que ainda está na unidade, ou o total guardado quando ela foi substituída.
  const pending = new Map<string, number>();
  for (const l of folhaLines ?? []) {
    if (l.origin !== "gerada") continue;
    const sum = [...l.values.values()].reduce((a, v) => a + v, 0);
    pending.set(l.account_id, (pending.get(l.account_id) ?? 0) + sum);
  }
  const hasPending = cols.some((c) => (pending.get(c.id) ?? 0) > 0);
  const activeMonths = (p: PersonLine) => [...p.line.values.values()].filter((v) => v > 0).length;
  const amount = (personId: string, accountId: string) =>
    benefits?.get(personId)?.get(accountId) ?? 0;
  const yearTotal = (accountId: string) =>
    people.reduce((a, p) => a + amount(p.person.id, accountId) * activeMonths(p), 0);

  function pasteBlock(row: number, col: number, block: string[][]) {
    const cells = block.flatMap((line, r) =>
      line.flatMap((text, c) => {
        const p = people[row + r];
        const acc = cols[col + c];
        const v = parseNum(text);
        return p && acc && v !== null
          ? [{ personId: p.person.id, accountId: acc.id, amount: v }]
          : [];
      }),
    );
    void setBenefits(cells);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Benefícios por pessoa</h2>
          <p className="text-sm text-muted-foreground">
            Valor mensal de cada benefício; vale nos meses em que a pessoa tem salário. Cole da
            planilha (ex.: fatura da Unimed por beneficiário). Quando a unidade passa a ter o valor
            por pessoa, a linha da base do Omie daquela conta sai e fica como referência.
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {dreLineId && (
              <Button size="sm" variant="outline" onClick={() => setNewName("")}>
                + Novo benefício
              </Button>
            )}
            {hasPending && (
              <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
                Distribuir a base do Omie entre as pessoas
              </Button>
            )}
          </div>
        )}
      </div>
      {cols.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium">
                  Pessoa
                </th>
                {cols.map((c) => (
                  <th key={c.id} className="min-w-32 px-2 py-2 text-right font-medium">
                    {c.name}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Por mês</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p, r) => (
                <tr key={p.person.id} className="border-b border-border">
                  <td className="sticky left-0 z-10 bg-card px-3 py-1 font-medium">
                    {p.person.name}
                  </td>
                  {cols.map((c, i) => (
                    <td key={c.id} className="border-l border-border/50 p-0">
                      <MoneyCell
                        value={amount(p.person.id, c.id)}
                        disabled={!canEdit}
                        pos={{ grid: "grid-folha-beneficios", row: r, col: i }}
                        onCommit={(v) =>
                          void setBenefits([{ personId: p.person.id, accountId: c.id, amount: v }])
                        }
                        onPasteBlock={(block) => pasteBlock(r, i, block)}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {fmtBRL(cols.reduce((a, c) => a + amount(p.person.id, c.id), 0))}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Soma no ano</td>
                {cols.map((c) => (
                  <td key={c.id} className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {fmtBRL(yearTotal(c.id))}
                  </td>
                ))}
                <td />
              </tr>
              <tr className="bg-muted/30 text-muted-foreground">
                <td className="sticky left-0 z-10 bg-muted px-3 py-1.5">Base do Omie no ano</td>
                {cols.map((c) => {
                  const base = pending.get(c.id) ?? bases?.get(c.id);
                  return (
                    <td key={c.id} className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {base ? fmtBRL(base) : "—"}
                      {pending.get(c.id) ? (
                        <div className="text-xs font-sans">ainda na base</div>
                      ) : null}
                    </td>
                  );
                })}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={newName !== null} onOpenChange={(o) => !o && setNewName(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo benefício</DialogTitle>
            <DialogDescription>
              Vira uma coluna nesta grade, em todas as unidades, para lançar o valor mensal de cada
              pessoa. Para mudar a linha da DRE, as unidades ou o código no Omie, use Configurações
              → Contas.
            </DialogDescription>
          </DialogHeader>
          <form
            id="novo-beneficio"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName?.trim();
              if (name && dreLineId)
                void addBenefit(name, dreLineId).then((ok) => ok && setNewName(null));
            }}
          >
            <Input
              aria-label="Nome do benefício"
              placeholder="Ex.: Auxílio home office"
              value={newName ?? ""}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewName(null)}>
              Cancelar
            </Button>
            <Button type="submit" form="novo-beneficio" disabled={!newName?.trim()}>
              Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Distribuir a base do Omie entre as pessoas?</AlertDialogTitle>
            <AlertDialogDescription>
              Cada benefício que ainda está na base do Omie é dividido igualmente pelos meses com
              salário das pessoas da unidade. Quem já tem valor não é alterado. Depois, corrija só
              quem foge da média.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void distribute(versionId!, unitId!)}>
              Distribuir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
