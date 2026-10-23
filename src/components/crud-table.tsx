import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { useTableMutations, type TableName } from "@/lib/catalog";
import { fmtInput, parseNum } from "@/lib/format";
import { Field, OptionSelect, type Option } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
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

type Base = { key: string; label: string; hint?: string; hideInTable?: boolean };
export type FieldDef = Base &
  (
    | { type: "text"; required?: boolean }
    | { type: "number"; required?: boolean; integer?: boolean }
    | { type: "boolean" }
    | { type: "select"; options: Option[]; required?: boolean; noneLabel?: string }
    | { type: "multi"; options: Option[]; emptyLabel?: string }
    /** Lista de palavras separadas por vírgula, guardada como array de texto. */
    | { type: "tags" }
  );

type Row = { id: string } & Record<string, unknown>;
type Draft = Record<string, unknown>;

interface CrudTableProps {
  table: TableName;
  rows: Row[];
  fields: FieldDef[];
  /** Valores iniciais de um registro novo. */
  defaults?: Draft;
  /** Ajusta o registro antes de gravar (ex.: desmarcar o padrão anterior). Retorne false para cancelar. */
  beforeSave?: (draft: Draft, row: Row | null) => Promise<boolean> | boolean;
  description?: string;
  addLabel?: string;
}

function display(field: FieldDef, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "")
    return <span className="text-muted-foreground">—</span>;
  switch (field.type) {
    case "boolean":
      return value ? "Sim" : "Não";
    case "number":
      return <span className="font-mono tabular-nums">{fmtInput(Number(value), 6)}</span>;
    case "select":
      return field.options.find((o) => o.value === String(value))?.label ?? String(value);
    case "multi": {
      const ids = value as string[];
      if (ids.length === 0)
        return <span className="text-muted-foreground">{field.emptyLabel ?? "—"}</span>;
      return ids.map((id) => field.options.find((o) => o.value === id)?.label ?? id).join(", ");
    }
    case "tags": {
      const tags = value as string[];
      return tags.length ? tags.join(", ") : <span className="text-muted-foreground">—</span>;
    }
    default:
      return String(value);
  }
}

/** Generic list + form for a configuration table. Writes go through RLS (financeiro). */
export function CrudTable({
  table,
  rows,
  fields,
  defaults = {},
  beforeSave,
  description,
  addLabel = "Adicionar",
}: CrudTableProps) {
  const { insert, update, remove } = useTableMutations(table);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const first = fields.find((f) => f.type === "text")?.key ?? "id";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : (
          <span />
        )}
        <Button size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> {addLabel}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              {fields
                .filter((f) => !f.hideInTable)
                .map((f) => (
                  <th key={f.key} className="px-3 py-2 font-medium">
                    {f.label}
                  </th>
                ))}
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-border last:border-0 ${row["active"] === false ? "opacity-50" : ""}`}
              >
                {fields
                  .filter((f) => !f.hideInTable)
                  .map((f) => (
                    <td key={f.key} className="px-3 py-1.5">
                      {f.key === first && row["active"] === false ? (
                        <span className="flex items-center gap-2">
                          {display(f, row[f.key])} <Badge variant="outline">inativo</Badge>
                        </span>
                      ) : (
                        display(f, row[f.key])
                      )}
                    </td>
                  ))}
                <td className="whitespace-nowrap px-2 py-1 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Editar"
                    onClick={() => setEditing(row)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Excluir"
                    onClick={() => setDeleting(row)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={fields.length + 1}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Nenhum registro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <RowDialog
          fields={fields}
          row={editing === "new" ? null : editing}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const row = editing === "new" ? null : editing;
            if (beforeSave && !(await beforeSave(draft, row))) return false;
            return row
              ? update(row.id, draft as TablesUpdate<typeof table>, "Alterações salvas.")
              : insert(draft as TablesInsert<typeof table>, "Registro criado.");
          }}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir este registro?</AlertDialogTitle>
            <AlertDialogDescription>
              Se ele já estiver em uso, a exclusão será recusada. Nesse caso, desative-o para que
              deixe de aparecer nas listas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && remove(deleting.id, "Registro excluído.")}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RowDialog({
  fields,
  row,
  defaults,
  onClose,
  onSave,
}: {
  fields: FieldDef[];
  row: Row | null;
  defaults: Draft;
  onClose: () => void;
  onSave: (draft: Draft) => Promise<boolean>;
}) {
  const initial = row ?? defaults;
  // Números são editados como texto e convertidos ao salvar.
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const v = initial[f.key];
        if (f.type === "number")
          return [f.key, v === null || v === undefined ? "" : fmtInput(Number(v), 6)];
        if (f.type === "multi") return [f.key, (v as string[] | null) ?? []];
        if (f.type === "tags") return [f.key, ((v as string[] | null) ?? []).join(", ")];
        if (f.type === "boolean") return [f.key, v ?? false];
        if (f.type === "select") return [f.key, v === null || v === undefined ? null : String(v)];
        return [f.key, v ?? null];
      }),
    ),
  );
  const [saving, setSaving] = useState(false);
  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));

  const errors = fields.flatMap((f) => {
    const v = draft[f.key];
    if (f.type === "number") {
      const text = String(v ?? "").trim();
      if (text === "") return f.required ? [`${f.label} é obrigatório.`] : [];
      const n = parseNum(text);
      if (n === null) return [`${f.label}: número inválido.`];
      if (f.integer && !Number.isInteger(n)) return [`${f.label}: use um número inteiro.`];
      return [];
    }
    if (
      (f.type === "text" || f.type === "select") &&
      f.required &&
      (v === null || String(v).trim() === "")
    )
      return [`${f.label} é obrigatório.`];
    return [];
  });

  async function save() {
    if (errors.length) return;
    const out: Draft = {};
    for (const f of fields) {
      const v = draft[f.key];
      if (f.type === "number")
        out[f.key] = String(v ?? "").trim() === "" ? null : parseNum(String(v));
      else if (f.type === "text")
        out[f.key] = v === null || String(v).trim() === "" ? null : String(v).trim();
      else if (f.type === "multi") out[f.key] = (v as string[]).length ? v : null;
      else if (f.type === "tags") {
        const tags = String(v ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        out[f.key] = tags.length ? tags : null;
      } else out[f.key] = v;
    }
    setSaving(true);
    const ok = await onSave(out);
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{row ? "Editar" : "Novo registro"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.type === "text" && (
                <Input
                  value={(draft[f.key] as string | null) ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.type === "number" && (
                <Input
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="font-mono"
                />
              )}
              {f.type === "tags" && (
                <Input
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder="palavra, outra palavra"
                />
              )}
              {f.type === "boolean" && (
                <div>
                  <Switch checked={!!draft[f.key]} onCheckedChange={(v) => set(f.key, v)} />
                </div>
              )}
              {f.type === "select" && (
                <OptionSelect
                  value={(draft[f.key] as string | null) ?? null}
                  onChange={(v) => set(f.key, v)}
                  options={f.options}
                  noneLabel={f.required ? undefined : (f.noneLabel ?? "Nenhum")}
                />
              )}
              {f.type === "multi" && (
                <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border border-border p-2">
                  {f.options.map((o) => {
                    const selected = draft[f.key] as string[];
                    return (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected.includes(o.value)}
                          onCheckedChange={(c) =>
                            set(
                              f.key,
                              c ? [...selected, o.value] : selected.filter((x) => x !== o.value),
                            )
                          }
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              )}
            </Field>
          ))}
          {errors.length > 0 && <p className="text-sm text-destructive">{errors[0]}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || errors.length > 0}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
