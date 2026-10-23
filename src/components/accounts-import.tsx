import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  friendlyError,
  useAccountGroupRules,
  useAccountTreatmentRules,
  useAccounts,
  useDreLines,
  useUnits,
} from "@/lib/catalog";
import {
  KIND_LABELS,
  TREATMENT_LABELS,
  defaultDreLine,
  enrichCategory,
  guessColumns,
  guessExtraColumns,
  guessHasHeader,
  parseTable,
  planAccounts,
  toImportRows,
  type AccountKind,
  type ColumnGuess,
  type ExtraColumns,
  type ImportAction,
  type Treatment,
} from "@/lib/accounts-import";
import { norm } from "@/lib/products-import";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const KINDS = Object.keys(KIND_LABELS) as AccountKind[];
const TREATMENTS = Object.keys(TREATMENT_LABELS) as Treatment[];
const ACTION_LABELS: Record<ImportAction, string> = {
  criar: "Nova",
  vincular: "Já existe pelo nome",
  existente: "Já importada",
};

interface Override {
  kind?: AccountKind | undefined;
  dreLineId?: string | undefined;
  include?: boolean | undefined;
  treatment?: Treatment | undefined;
  /** "" = todas as unidades. */
  unitId?: string | undefined;
  group?: string | undefined;
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60";

/** Botão e diálogo para importar as categorias do Omie como contas, colando a lista exportada. */
export function AccountsImport() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <FileDown className="h-4 w-4" /> Importar do Omie
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: accounts } = useAccounts();
  const { data: dreLines } = useDreLines();
  const { data: units } = useUnits();
  const { data: treatmentRules } = useAccountTreatmentRules();
  const { data: groupRules } = useAccountGroupRules();
  const [text, setText] = useState("");
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(null);
  const [columnChoice, setColumnChoice] = useState<
    Partial<Record<keyof ColumnGuess, number | null>>
  >({});
  const [extraChoice, setExtraChoice] = useState<
    Partial<Record<keyof ExtraColumns, number | null>>
  >({});
  const [minYear, setMinYear] = useState("2026");
  const [skipGroups, setSkipGroups] = useState(true);
  const [deactivateUnused, setDeactivateUnused] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, Override>>({});
  const [bulkKind, setBulkKind] = useState<AccountKind>("despesa");
  const [saving, setSaving] = useState(false);

  const existing = useMemo(() => accounts ?? [], [accounts]);
  const postingLines = (dreLines ?? []).filter((l) => l.active && l.kind === "lancada");
  const calculatedLine = (dreLines ?? []).find((l) => l.active && l.kind === "calculada");
  const activeUnits = (units ?? []).filter((u) => u.active);

  const table = useMemo(() => parseTable(text), [text]);
  const hasHeader = headerChoice ?? guessHasHeader(table);
  const guess = useMemo(() => guessColumns(table, hasHeader), [table, hasHeader]);
  const columns: ColumnGuess = {
    code: columnChoice.code === undefined ? guess.code : columnChoice.code,
    name: columnChoice.name === undefined ? guess.name : columnChoice.name,
    type: columnChoice.type === undefined ? guess.type : columnChoice.type,
  };
  const extraGuess = useMemo(
    () => guessExtraColumns(table, hasHeader, [guess.code, guess.name, guess.type]),
    [table, hasHeader, guess],
  );
  const extra: ExtraColumns = {
    department:
      extraChoice.department === undefined ? extraGuess.department : extraChoice.department,
    group: extraChoice.group === undefined ? extraGuess.group : extraChoice.group,
    include: extraChoice.include === undefined ? extraGuess.include : extraChoice.include,
  };
  const width = Math.max(0, ...table.map((r) => r.length));
  const columnLabel = (i: number) => {
    const head = hasHeader ? (table[0]?.[i] ?? "") : "";
    const sample = (hasHeader ? table[1] : table[0])?.[i] ?? "";
    return `${head || `Coluna ${i + 1}`}${sample ? ` (ex.: ${sample.slice(0, 24)})` : ""}`;
  };

  const parsed = useMemo(
    () => (columns.name === null ? null : toImportRows(table, hasHeader, columns, extra)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      table,
      hasHeader,
      columns.code,
      columns.name,
      columns.type,
      extra.department,
      extra.group,
      extra.include,
    ],
  );
  const plan = useMemo(
    () => (parsed ? planAccounts(parsed.rows, existing, { skipGroups }) : null),
    [parsed, existing, skipGroups],
  );

  const setOverride = (line: number, patch: Override) =>
    setOverrides((o) => ({ ...o, [line]: { ...o[line], ...patch } }));

  const ctx = {
    minYear: Number(minYear) || 0,
    treatmentRules: treatmentRules ?? [],
    groupRules: groupRules ?? [],
    units: (units ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      omie_department_code: u.omie_department_code,
      name_keywords: u.name_keywords,
    })),
  };

  // O que cada linha vai virar: a sugestão do app, com as escolhas feitas na tela por cima.
  const items = (plan?.items ?? []).map((item) => {
    const o = overrides[item.line] ?? {};
    const sug = enrichCategory(item, ctx);
    const kind = o.kind ?? item.kind;
    const treatment = o.treatment ?? sug.treatment;
    const dreLineId =
      treatment === "fora_dre"
        ? null
        : (o.dreLineId ??
          (treatment === "calculada" && calculatedLine
            ? calculatedLine.id
            : kind
              ? defaultDreLine(existing, kind)
              : null));
    const include = o.include ?? (item.action !== "existente" && sug.excluded === null);
    const unitId = o.unitId !== undefined ? o.unitId : (sug.unit.unitId ?? "");
    const group = o.group ?? sug.group ?? "";
    return { ...item, sug, kind, treatment, dreLineId, include, unitId, group };
  });
  const toCreate = items.filter((i) => i.action === "criar" && i.include);
  const toLink = items.filter((i) => i.action === "vincular" && i.include);
  const incomplete = toCreate.filter(
    (i) => !i.kind || (i.treatment !== "fora_dre" && !i.dreLineId),
  );
  const ready = toCreate.length - incomplete.length + toLink.length;

  // Contas atuais que não vieram do arquivo e não estão em uso: podem ser arquivadas.
  const { data: usedIds } = useQuery({
    queryKey: ["accounts_in_use"],
    enabled: deactivateUnused,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("accounts_in_use");
      if (error) throw error;
      return new Set((data ?? []) as unknown as string[]);
    },
  });
  const inFileNames = new Set((parsed?.rows ?? []).map((r) => norm(r.name)));
  const inFileCodes = new Set((parsed?.rows ?? []).map((r) => r.code).filter(Boolean));
  const unusedAccounts =
    deactivateUnused && plan && usedIds
      ? existing.filter(
          (a) =>
            a.active &&
            !inFileNames.has(norm(a.name)) &&
            !(a.omie_category_code && inFileCodes.has(a.omie_category_code)) &&
            !usedIds.has(a.id),
        )
      : [];

  async function save() {
    if (!plan || incomplete.length > 0 || ready === 0) return;
    setSaving(true);
    const base = Math.max(0, ...existing.map((a) => a.sort_order)) + 10;
    if (toCreate.length > 0) {
      const { error } = await supabase.from("accounts").insert(
        toCreate.map((i, n) => ({
          name: i.finalName,
          kind: i.kind!,
          dre_line_id: i.treatment === "fora_dre" ? null : i.dreLineId,
          unit_ids: i.unitId ? [i.unitId] : null,
          treatment: i.treatment,
          group_name: i.group.trim() || null,
          period: i.sug.period,
          base_name: i.sug.baseName,
          omie_category_code: i.code || null,
          active: true,
          sort_order: base + n * 10,
        })),
      );
      if (error) {
        setSaving(false);
        toast.error(friendlyError(error.message));
        return;
      }
    }
    // Conta que já existe pelo nome: recebe grupo, período e, se vier, o código do Omie.
    const results = await Promise.all(
      toLink.map((i) =>
        supabase
          .from("accounts")
          .update({
            ...(i.code ? { omie_category_code: i.code } : {}),
            group_name: i.group.trim() || null,
            period: i.sug.period,
            base_name: i.sug.baseName,
          })
          .eq("id", i.matchId!),
      ),
    );
    const failed = results.find((r) => r.error);
    let archived = 0;
    if (!failed && unusedAccounts.length > 0) {
      const { error } = await supabase
        .from("accounts")
        .update({ active: false })
        .in(
          "id",
          unusedAccounts.map((a) => a.id),
        );
      if (!error) archived = unusedAccounts.length;
    }
    setSaving(false);
    if (failed?.error) {
      toast.error(friendlyError(failed.error.message));
    } else {
      toast.success(
        `${toCreate.length} conta(s) criada(s), ${toLink.length} atualizada(s)${
          archived ? ` e ${archived} arquivada(s)` : ""
        }.`,
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    onClose();
  }

  const columnSelect = (
    value: number | null | undefined,
    onPick: (v: number | null) => void,
    label: string,
    optional = false,
  ) => (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        className={`${selectClass} mt-1`}
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value === "" ? null : Number(e.target.value))}
      >
        {(optional || value === null || value === undefined) && (
          <option value="">{optional ? "Nenhuma" : "Escolha"}</option>
        )}
        {[...Array(width).keys()].map((i) => (
          <option key={i} value={i}>
            {columnLabel(i)}
          </option>
        ))}
      </select>
    </label>
  );

  const allErrors = [...(parsed?.errors ?? []), ...(plan?.errors ?? [])].sort(
    (a, b) => a.line - b.line,
  );
  const groupOptions = [
    ...new Set([
      ...existing.map((a) => a.group_name).filter((g): g is string => !!g),
      ...(groupRules ?? []).map((r) => r.group_name),
    ]),
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-7xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar as categorias do Omie como contas</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            No Omie, exporte a lista de categorias para Excel (ou copie as linhas) e cole abaixo com
            o cabeçalho. Precisa do <strong>nome</strong> da categoria; ajudam o{" "}
            <strong>tipo</strong> (receita ou despesa), o <strong>departamento</strong>, um{" "}
            <strong>grupo</strong> e uma coluna <strong>Importar? sim/não</strong> para o que não
            deve entrar (o colar não leva a cor). O ano no nome (“… - 2027”) vira o período.
          </p>
          <Textarea
            rows={6}
            className="font-mono text-xs"
            value={text}
            placeholder={
              "Categoria\tTipo\tDepartamento\tImportar?\nCUPOLA Summit Ingressos - 2027\tReceita\tEducação\tsim"
            }
            onChange={(e) => {
              setText(e.target.value);
              setHeaderChoice(null);
              setColumnChoice({});
              setExtraChoice({});
              setOverrides({});
            }}
          />

          {table.length > 0 && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {columnSelect(
                  columns.name,
                  (v) => setColumnChoice((c) => ({ ...c, name: v })),
                  "Coluna do nome",
                )}
                {columnSelect(
                  columns.type,
                  (v) => setColumnChoice((c) => ({ ...c, type: v })),
                  "Coluna do tipo",
                  true,
                )}
                {columnSelect(
                  extra.department,
                  (v) => setExtraChoice((c) => ({ ...c, department: v })),
                  "Coluna do departamento",
                  true,
                )}
                {columnSelect(
                  extra.group,
                  (v) => setExtraChoice((c) => ({ ...c, group: v })),
                  "Coluna do grupo",
                  true,
                )}
                {columnSelect(
                  extra.include,
                  (v) => setExtraChoice((c) => ({ ...c, include: v })),
                  "Coluna Importar?",
                  true,
                )}
                {columnSelect(
                  columns.code,
                  (v) => setColumnChoice((c) => ({ ...c, code: v })),
                  "Coluna do código",
                  true,
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox checked={hasHeader} onCheckedChange={(c) => setHeaderChoice(!!c)} />A
                  primeira linha é o cabeçalho
                </label>
                <label className="flex items-center gap-2">
                  Não importar período anterior a
                  <input
                    value={minYear}
                    onChange={(e) => setMinYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    className="h-8 w-20 rounded-md border border-input bg-background px-2 font-mono text-sm"
                    aria-label="Ano mínimo"
                  />
                </label>
                {columns.code !== null && (
                  <label className="flex items-center gap-2">
                    <Checkbox checked={skipGroups} onCheckedChange={(c) => setSkipGroups(!!c)} />
                    Ignorar grupos (contas com subcontas)
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={deactivateUnused}
                    onCheckedChange={(c) => setDeactivateUnused(!!c)}
                  />
                  Arquivar as contas atuais que não vieram do arquivo e não estão em uso
                </label>
              </div>
            </div>
          )}

          {plan && parsed && (
            <div className="space-y-3">
              <p className="text-sm">
                <strong>{items.filter((i) => i.action === "criar").length}</strong> nova(s) ·{" "}
                <strong>{items.filter((i) => i.action === "vincular").length}</strong> já existe(m)
                pelo nome · <strong>{items.filter((i) => i.action === "existente").length}</strong>{" "}
                já importada(s)
                {plan.skippedGroups > 0 && ` · ${plan.skippedGroups} grupo(s) ignorado(s)`} ·{" "}
                <strong>{items.filter((i) => !i.include).length}</strong> fora da importação
                {deactivateUnused &&
                  (usedIds
                    ? ` · ${unusedAccounts.length} conta(s) a arquivar`
                    : " · calculando as contas a arquivar…")}
              </p>

              {allErrors.length > 0 && (
                <ul className="space-y-0.5 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                  {allErrors.map((e, i) => (
                    <li key={i}>
                      Linha {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              )}

              {incomplete.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-2 text-sm">
                  <span>
                    {incomplete.length} conta(s) nova(s) sem grade ou sem linha da DRE. Defina a
                    grade de todas de uma vez ou escolha uma a uma:
                  </span>
                  <select
                    className={`${selectClass} w-36`}
                    value={bulkKind}
                    onChange={(e) => setBulkKind(e.target.value as AccountKind)}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      incomplete
                        .filter((i) => !i.kind)
                        .forEach((i) => setOverride(i.line, { kind: bulkKind }))
                    }
                  >
                    Aplicar
                  </Button>
                </div>
              )}

              {items.length > 0 && (
                <div className="max-h-[42vh] overflow-auto rounded-md border border-border">
                  <datalist id="groups-list">
                    {groupOptions.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-muted">
                      <tr className="text-left">
                        <th className="w-10 px-2 py-2" />
                        <th className="px-2 py-2 font-medium">Categoria</th>
                        <th className="w-28 px-2 py-2 font-medium">Grade</th>
                        <th className="w-40 px-2 py-2 font-medium">Tratamento</th>
                        <th className="w-44 px-2 py-2 font-medium">Linha da DRE</th>
                        <th className="w-36 px-2 py-2 font-medium">Unidade</th>
                        <th className="w-32 px-2 py-2 font-medium">Grupo</th>
                        <th className="px-2 py-2 font-medium">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => {
                        const isNew = i.action === "criar";
                        const notes = [
                          i.sug.excluded === "periodo_anterior" ? `anterior a ${minYear}` : null,
                          i.sug.excluded === "marcada_nao" ? "marcada para não importar" : null,
                          i.sug.treatmentKeyword && i.treatment === i.sug.treatment
                            ? `regra: ${i.sug.treatmentKeyword}`
                            : null,
                          i.sug.unit.source === "nome" && i.unitId === i.sug.unit.unitId
                            ? "unidade pelo nome"
                            : null,
                          i.sug.unit.ambiguous ? "unidade ambígua" : null,
                          i.sug.unit.unknownDepartment ? "departamento desconhecido" : null,
                        ].filter(Boolean);
                        return (
                          <tr
                            key={i.line}
                            className={`border-t border-border ${i.include ? "" : "opacity-50"}`}
                          >
                            <td className="px-2 py-1">
                              <Checkbox
                                checked={i.include}
                                disabled={i.action === "existente"}
                                aria-label={`Incluir ${i.finalName}`}
                                onCheckedChange={(c) => setOverride(i.line, { include: !!c })}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <div>
                                {i.finalName}
                                {i.finalName !== i.name && (
                                  <span className="ml-1 text-xs text-muted-foreground">
                                    (no Omie: {i.name})
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {i.code ? `${i.code} · ` : ""}
                                {i.sug.period ? `período ${i.sug.period}` : "sem período"}
                              </div>
                            </td>
                            <td className="px-2 py-1">
                              {isNew ? (
                                <select
                                  className={selectClass}
                                  aria-label={`Grade de ${i.finalName}`}
                                  value={i.kind ?? ""}
                                  onChange={(e) =>
                                    setOverride(i.line, {
                                      kind: (e.target.value || undefined) as
                                        AccountKind | undefined,
                                      dreLineId: undefined,
                                    })
                                  }
                                >
                                  <option value="">Escolha</option>
                                  {KINDS.map((k) => (
                                    <option key={k} value={k}>
                                      {KIND_LABELS[k]}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              {isNew ? (
                                <select
                                  className={selectClass}
                                  aria-label={`Tratamento de ${i.finalName}`}
                                  value={i.treatment}
                                  onChange={(e) =>
                                    setOverride(i.line, {
                                      treatment: e.target.value as Treatment,
                                      dreLineId: undefined,
                                    })
                                  }
                                >
                                  {TREATMENTS.map((t) => (
                                    <option key={t} value={t}>
                                      {TREATMENT_LABELS[t]}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              {isNew && i.treatment !== "fora_dre" ? (
                                <select
                                  className={selectClass}
                                  aria-label={`Linha da DRE de ${i.finalName}`}
                                  value={i.dreLineId ?? ""}
                                  onChange={(e) =>
                                    setOverride(i.line, { dreLineId: e.target.value })
                                  }
                                >
                                  <option value="">Escolha</option>
                                  {[
                                    ...postingLines,
                                    ...(calculatedLine ? [calculatedLine] : []),
                                  ].map((l) => (
                                    <option key={l.id} value={l.id}>
                                      {l.name}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              {isNew ? (
                                <select
                                  className={selectClass}
                                  aria-label={`Unidade de ${i.finalName}`}
                                  value={i.unitId}
                                  onChange={(e) => setOverride(i.line, { unitId: e.target.value })}
                                >
                                  <option value="">Todas</option>
                                  {activeUnits.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              <input
                                list="groups-list"
                                className={selectClass}
                                aria-label={`Grupo de ${i.finalName}`}
                                value={i.group}
                                onChange={(e) => setOverride(i.line, { group: e.target.value })}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <Badge variant={isNew ? "default" : "secondary"}>
                                {ACTION_LABELS[i.action]}
                              </Badge>
                              {notes.length > 0 && (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {notes.join(" · ")}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {items.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nenhuma conta encontrada com estas colunas.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || ready === 0 || incomplete.length > 0}>
            {saving ? "Importando…" : ready > 0 ? `Importar ${ready} conta(s)` : "Importar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
