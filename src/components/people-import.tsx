import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePlanning } from "@/lib/planning";
import { byId, useContractTypes, useUnits } from "@/lib/catalog";
import { useExternalIds, usePeopleMutations } from "@/lib/payroll";
import { PEOPLE_COLUMNS, parsePeople, type PeopleImportResult } from "@/lib/people-import";
import { fmtBRL } from "@/lib/format";
import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const dateBR = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");

/** Cola a planilha da folha (ID, admissão, cargo, equipe, salário), confere e grava uma linha por pessoa. */
export function PeopleImportDialog({ onClose }: { onClose: () => void }) {
  const { versionId } = usePlanning();
  const { data: units } = useUnits();
  const { data: contractTypes } = useContractTypes();
  const { data: existing } = useExternalIds(versionId);
  const { importPeople } = usePeopleMutations();
  const [text, setText] = useState("");
  const [result, setResult] = useState<PeopleImportResult | null>(null);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const unitMap = byId(units);

  function check() {
    setOverrides({});
    setResult(parsePeople(text, { units: units ?? [], contractTypes: contractTypes ?? [] }));
  }

  const rows = useMemo(
    () =>
      (result?.rows ?? []).map((r) => ({
        ...r,
        contract_type_id: overrides[r.line] ?? r.contract_type_id,
      })),
    [result, overrides],
  );
  const updating = rows.filter((r) => existing?.has(r.external_id)).length;
  const perUnit = useMemo(() => {
    const m = new Map<string, { n: number; total: number }>();
    for (const r of rows) {
      const cur = m.get(r.unit_id) ?? { n: 0, total: 0 };
      m.set(r.unit_id, { n: cur.n + 1, total: cur.total + r.salary });
    }
    return [...m.entries()];
  }, [rows]);

  async function save() {
    if (!versionId || rows.length === 0) return;
    setSaving(true);
    const done = await importPeople(versionId, rows, overwrite);
    setSaving(false);
    if (!done) return;
    toast.success(`${done.created} pessoa(s) nova(s) e ${done.updated} atualizada(s).`);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar a folha da planilha</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Copie as linhas da planilha e cole abaixo. Colunas, nesta ordem:{" "}
            <strong>{PEOPLE_COLUMNS.join(" · ")}</strong>. A primeira linha pode ser o cabeçalho;
            linhas de total são ignoradas. A planilha não traz o vínculo: o cargo sugere (ex.:
            estágio) e o restante fica no primeiro vínculo ativo; troque na conferência. Importar de
            novo atualiza quem já existe pelo ID.
          </p>
          <Textarea
            rows={7}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            placeholder={"1\t04/03/2024\tAnalista de conteúdo pleno\tAgência\t5.000,00"}
          />
          {result && (
            <div className="space-y-3">
              {rows.length > 0 && (
                <>
                  <p className="text-sm">
                    <strong>{rows.length}</strong> pessoa(s) prontas: {rows.length - updating}{" "}
                    nova(s) e {updating} já cadastrada(s)
                    {result.ignored > 0
                      ? `; ${result.ignored} linha(s) sem ID ignorada(s)`
                      : ""}.{" "}
                    {perUnit
                      .map(
                        ([u, s]) =>
                          `${unitMap.get(u)?.name ?? "?"}: ${s.n} (${fmtBRL(s.total)}/mês)`,
                      )
                      .join(" · ")}
                  </p>
                  {updating > 0 && (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(!!c)} />
                      Refazer os 12 meses de quem já existe (apaga o que foi editado na grade)
                    </label>
                  )}
                  <div className="max-h-72 overflow-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted text-left">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">ID</th>
                          <th className="px-2 py-1.5 font-medium">Cargo</th>
                          <th className="px-2 py-1.5 font-medium">Equipe</th>
                          <th className="px-2 py-1.5 font-medium">Admissão</th>
                          <th className="px-2 py-1.5 text-right font-medium">Salário</th>
                          <th className="px-2 py-1.5 font-medium">Vínculo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.line} className="border-t border-border">
                            <td className="px-2 py-1 font-mono">
                              {r.external_id}
                              {existing?.has(r.external_id) && (
                                <span className="ml-1 text-xs text-muted-foreground">existe</span>
                              )}
                            </td>
                            <td className="px-2 py-1">{r.role_title}</td>
                            <td className="px-2 py-1">{unitMap.get(r.unit_id)?.name}</td>
                            <td className="px-2 py-1">{dateBR(r.hire_date)}</td>
                            <td className="px-2 py-1 text-right font-mono">{fmtBRL(r.salary)}</td>
                            <td className="px-2 py-1">
                              <OptionSelect
                                value={r.contract_type_id}
                                onChange={(v) => v && setOverrides((o) => ({ ...o, [r.line]: v }))}
                                options={(contractTypes ?? [])
                                  .filter((c) => c.active)
                                  .map((c) => ({ value: c.id, label: c.name }))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {result.errors.length > 0 && (
                <ul className="space-y-0.5 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      Linha {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {rows.length === 0 && result.errors.length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhuma linha encontrada.</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="outline" onClick={check} disabled={text.trim() === ""}>
            Conferir
          </Button>
          <Button onClick={save} disabled={saving || rows.length === 0}>
            {saving
              ? "Importando…"
              : result?.errors.length
                ? `Importar só as ${rows.length} válidas`
                : "Importar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
