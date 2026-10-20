import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError, useAccounts, useDreLines } from "@/lib/catalog";
import {
  KIND_LABELS,
  defaultDreLine,
  guessColumns,
  guessHasHeader,
  parseTable,
  planAccounts,
  toImportRows,
  type AccountKind,
  type ColumnGuess,
  type ImportAction,
} from "@/lib/accounts-import";
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
const ACTION_LABELS: Record<ImportAction, string> = {
  criar: "Nova",
  vincular: "Já existe pelo nome: recebe o código",
  existente: "Já importada",
};

interface Override {
  kind?: AccountKind | undefined;
  dreLineId?: string | undefined;
  include?: boolean | undefined;
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60";

/** Botão e diálogo para importar o plano de contas do Omie colando a lista exportada. */
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
  const [text, setText] = useState("");
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(null);
  const [columnChoice, setColumnChoice] = useState<
    Partial<Record<keyof ColumnGuess, number | null>>
  >({});
  const [skipGroups, setSkipGroups] = useState(true);
  const [overrides, setOverrides] = useState<Record<number, Override>>({});
  const [bulkKind, setBulkKind] = useState<AccountKind>("despesa");
  const [saving, setSaving] = useState(false);

  const existing = useMemo(() => accounts ?? [], [accounts]);
  const postingLines = (dreLines ?? []).filter((l) => l.active && l.kind === "lancada");

  const table = useMemo(() => parseTable(text), [text]);
  const hasHeader = headerChoice ?? guessHasHeader(table);
  const guess = useMemo(() => guessColumns(table, hasHeader), [table, hasHeader]);
  const columns: ColumnGuess = {
    code: columnChoice.code === undefined ? guess.code : columnChoice.code,
    name: columnChoice.name === undefined ? guess.name : columnChoice.name,
    type: columnChoice.type === undefined ? guess.type : columnChoice.type,
  };
  const width = Math.max(0, ...table.map((r) => r.length));
  const columnLabel = (i: number) => {
    const head = hasHeader ? (table[0]?.[i] ?? "") : "";
    const sample = (hasHeader ? table[1] : table[0])?.[i] ?? "";
    return `${head || `Coluna ${i + 1}`}${sample ? ` (ex.: ${sample.slice(0, 24)})` : ""}`;
  };

  const parsed = useMemo(
    () => (columns.name === null ? null : toImportRows(table, hasHeader, columns)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, hasHeader, columns.code, columns.name, columns.type],
  );
  const plan = useMemo(
    () => (parsed ? planAccounts(parsed.rows, existing, { skipGroups }) : null),
    [parsed, existing, skipGroups],
  );

  const setOverride = (line: number, patch: Override) =>
    setOverrides((o) => ({ ...o, [line]: { ...o[line], ...patch } }));

  // O que cada linha vai virar, com as escolhas feitas na tela.
  const items = (plan?.items ?? []).map((item) => {
    const o = overrides[item.line] ?? {};
    const kind = o.kind ?? item.kind;
    const dreLineId = o.dreLineId ?? (kind ? defaultDreLine(existing, kind) : null);
    const include = o.include ?? item.action !== "existente";
    return { ...item, kind, dreLineId, include };
  });
  const toCreate = items.filter((i) => i.action === "criar" && i.include);
  const toLink = items.filter((i) => i.action === "vincular" && i.include);
  const incomplete = toCreate.filter((i) => !i.kind || !i.dreLineId);
  const ready = toCreate.length - incomplete.length + toLink.length;

  async function save() {
    if (!plan || incomplete.length > 0 || ready === 0) return;
    setSaving(true);
    const base = Math.max(0, ...existing.map((a) => a.sort_order)) + 10;
    if (toCreate.length > 0) {
      const { error } = await supabase.from("accounts").insert(
        toCreate.map((i, n) => ({
          name: i.finalName,
          kind: i.kind!,
          dre_line_id: i.dreLineId!,
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
    const results = await Promise.all(
      toLink.map((i) =>
        supabase
          .from("accounts")
          .update({ omie_category_code: i.code || null })
          .eq("id", i.matchId!),
      ),
    );
    setSaving(false);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      toast.error(friendlyError(failed.error.message));
    } else {
      toast.success(
        `${toCreate.length} conta(s) criada(s) e ${toLink.length} vinculada(s) ao Omie.`,
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    onClose();
  }

  const columnSelect = (field: keyof ColumnGuess, label: string, optional = false) => (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        className={`${selectClass} mt-1`}
        value={columns[field] ?? ""}
        onChange={(e) =>
          setColumnChoice((c) => ({
            ...c,
            [field]: e.target.value === "" ? null : Number(e.target.value),
          }))
        }
      >
        {(optional || columns[field] === null) && (
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar plano de contas do Omie</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            No Omie, abra a lista de categorias (plano de contas), exporte para Excel ou copie as
            linhas, e cole abaixo com o cabeçalho. Serve qualquer planilha com o{" "}
            <strong>código</strong>, o <strong>nome</strong> e, de preferência, o{" "}
            <strong>tipo</strong> (receita ou despesa) de cada conta.
          </p>
          <Textarea
            rows={6}
            className="font-mono text-xs"
            value={text}
            placeholder={
              "Código\tDescrição\tTipo\n1.01\tReceita de serviços\tReceita\n2.01\tAluguel\tDespesa"
            }
            onChange={(e) => {
              setText(e.target.value);
              setHeaderChoice(null);
              setColumnChoice({});
              setOverrides({});
            }}
          />

          {table.length > 0 && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {columnSelect("code", "Coluna do código", true)}
                {columnSelect("name", "Coluna do nome")}
                {columnSelect("type", "Coluna do tipo", true)}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox checked={hasHeader} onCheckedChange={(c) => setHeaderChoice(!!c)} />A
                  primeira linha é o cabeçalho
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox checked={skipGroups} onCheckedChange={(c) => setSkipGroups(!!c)} />
                  Ignorar grupos (contas que têm subcontas, onde não se lança)
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
                {plan.skippedGroups > 0 && ` · ${plan.skippedGroups} grupo(s) ignorado(s)`}
              </p>

              {[...parsed.errors, ...plan.errors].length > 0 && (
                <ul className="space-y-0.5 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                  {[...parsed.errors, ...plan.errors]
                    .sort((a, b) => a.line - b.line)
                    .map((e, i) => (
                      <li key={i}>
                        Linha {e.line}: {e.message}
                      </li>
                    ))}
                </ul>
              )}

              {incomplete.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-2 text-sm">
                  <span>
                    {incomplete.length} conta(s) nova(s) sem grade. Defina a grade de todas de uma
                    vez ou escolha uma a uma:
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
                      incomplete.forEach((i) => setOverride(i.line, { kind: bulkKind }))
                    }
                  >
                    Aplicar
                  </Button>
                </div>
              )}

              {items.length > 0 && (
                <div className="max-h-[40vh] overflow-auto rounded-md border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 bg-muted">
                      <tr className="text-left">
                        <th className="w-10 px-2 py-2" />
                        <th className="px-2 py-2 font-medium">Código</th>
                        <th className="px-2 py-2 font-medium">Nome no app</th>
                        <th className="w-32 px-2 py-2 font-medium">Grade</th>
                        <th className="w-52 px-2 py-2 font-medium">Linha da DRE</th>
                        <th className="px-2 py-2 font-medium">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => {
                        const isNew = i.action === "criar";
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
                            <td className="px-2 py-1 font-mono text-xs">{i.code || "—"}</td>
                            <td className="px-2 py-1">
                              {i.finalName}
                              {i.finalName !== i.name && (
                                <span className="ml-1 text-xs text-muted-foreground">
                                  (no Omie: {i.name})
                                </span>
                              )}
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
                                  aria-label={`Linha da DRE de ${i.finalName}`}
                                  value={i.dreLineId ?? ""}
                                  onChange={(e) =>
                                    setOverride(i.line, { dreLineId: e.target.value })
                                  }
                                >
                                  <option value="">Escolha</option>
                                  {postingLines.map((l) => (
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
                              <Badge variant={isNew ? "default" : "secondary"}>
                                {ACTION_LABELS[i.action]}
                              </Badge>
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
