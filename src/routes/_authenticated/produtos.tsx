import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardPaste, Pencil, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { pageHead } from "@/lib/head";
import { useCurrentUser } from "@/lib/auth";
import {
  byId,
  friendlyError,
  useAccounts,
  useProducts,
  useRevenueTypes,
  useTableMutations,
  useUnits,
} from "@/lib/catalog";
import { MONTHS, fmtBRL, parseNum } from "@/lib/format";
import {
  KIND_LABELS,
  PRICE_MODEL_LABELS,
  contractPlan,
  describePlan,
  describePrice,
  inputOf,
  type PriceModel,
  type Product,
  type ProductKind,
} from "@/lib/products";
import { IMPORT_COLUMNS, norm, parseProducts, type ImportResult } from "@/lib/products-import";
import { PageHeader } from "@/components/page-header";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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

export const Route = createFileRoute("/_authenticated/produtos")({
  head: pageHead(
    "Produtos",
    "Catálogo de produtos, eventos e treinamentos com preço e prazo para a previsão.",
  ),
  component: ProdutosPage,
});

const ALL = "__all";

function ProdutosPage() {
  const { data: user } = useCurrentUser();
  const { data: products, isLoading } = useProducts();
  const { data: units } = useUnits();
  const { data: types } = useRevenueTypes();
  const { remove } = useTableMutations("products");
  const [chosenUnit, setUnitFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  // Financeiro cadastra tudo; o líder, os produtos das próprias unidades (nunca "todas as unidades").
  const isFin = !!user?.isFinanceiro;
  const ownUnitIds = user?.unitIds ?? [];
  const canCreate = isFin || (!!user?.isLider && ownUnitIds.length > 0);
  const canEditProduct = (p: Product) =>
    isFin || (!!user?.isLider && p.unit_id !== null && ownUnitIds.includes(p.unit_id));
  const unitFilter = chosenUnit ?? (user?.isManagement ? ALL : (ownUnitIds[0] ?? ALL));
  const unitOptions = (units ?? []).filter((u) => u.active && (isFin || ownUnitIds.includes(u.id)));
  const newProductUnit =
    unitFilter !== ALL && unitOptions.some((u) => u.id === unitFilter)
      ? unitFilter
      : isFin
        ? null
        : (unitOptions[0]?.id ?? null);
  const unitMap = byId(units);
  const typeMap = byId(types);

  const rows = (products ?? []).filter(
    (p) => unitFilter === ALL || p.unit_id === unitFilter || p.unit_id === null,
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Produtos"
        subtitle="Ao lançar um produto na previsão, o preço e o prazo daqui são preenchidos automaticamente."
        actions={
          canCreate && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setImporting(true)}
              >
                <ClipboardPaste className="h-4 w-4" /> Colar do Excel
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> Novo produto
              </Button>
            </div>
          )
        }
      />
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Unidade</span>
        <OptionSelect
          className="w-52"
          value={unitFilter}
          onChange={(v) => setUnitFilter(v ?? ALL)}
          options={[
            { value: ALL, label: "Todas as unidades" },
            ...(units ?? []).filter((u) => u.active).map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
        {!isFin && (
          <span className="text-sm text-muted-foreground">
            {user?.isLider
              ? "Você cadastra os produtos das suas unidades; os de todas as unidades são do financeiro."
              : "Somente o financeiro e os líderes de cada unidade alteram o catálogo."}
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Produto</th>
                <th className="px-3 py-2 font-medium">Unidade</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Preço e prazo</th>
                <th className="px-3 py-2 font-medium">Tipo de receita</th>
                <th className="px-3 py-2 font-medium">Eventos: vagas e custos</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-border last:border-0 ${p.active ? "" : "opacity-50"}`}
                >
                  <td className="px-3 py-1.5 font-medium">
                    {p.name} {!p.active && <Badge variant="outline">inativo</Badge>}
                  </td>
                  <td className="px-3 py-1.5">
                    {p.unit_id ? unitMap.get(p.unit_id)?.name : "Todas"}
                  </td>
                  <td className="px-3 py-1.5">
                    {p.kind === "evento" ? "Evento / treinamento" : "Serviço"}
                  </td>
                  <td className="px-3 py-1.5">{describePrice(p)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {p.revenue_type_id ? (typeMap.get(p.revenue_type_id)?.name ?? "—") : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {p.kind === "evento"
                      ? [
                          p.default_seats !== null ? `${p.default_seats} vagas` : null,
                          p.cost_per_participant !== null
                            ? `${fmtBRL(Number(p.cost_per_participant))}/participante`
                            : null,
                          p.fixed_cost !== null ? `${fmtBRL(Number(p.fixed_cost))} fixo` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    {canEditProduct(p) && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Editar ${p.name}`}
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Excluir ${p.name}`}
                          onClick={() => setDeleting(p)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    {canCreate
                      ? "Nenhum produto cadastrado. Use “Novo produto” ou cole uma lista do Excel."
                      : "Nenhum produto cadastrado ainda. Peça ao financeiro para cadastrar."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductDialog
          product={editing === "new" ? null : editing}
          defaultUnitId={newProductUnit}
          unitOptions={unitOptions}
          allowAllUnits={isFin}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && (
        <ImportDialog ownUnitIds={isFin ? null : ownUnitIds} onClose={() => setImporting(false)} />
      )}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se o produto já estiver em lançamentos, a exclusão será recusada. Nesse caso,
              desative-o: ele deixa de aparecer ao lançar, mas os lançamentos antigos continuam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting.id, "Produto excluído.")}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProductDialog({
  product,
  defaultUnitId,
  unitOptions,
  allowAllUnits,
  onClose,
}: {
  product: Product | null;
  defaultUnitId: string | null;
  unitOptions: { id: string; name: string }[];
  allowAllUnits: boolean;
  onClose: () => void;
}) {
  const { insert, update } = useTableMutations("products");
  const { data: types } = useRevenueTypes();
  const { data: accounts } = useAccounts();
  const [name, setName] = useState(product?.name ?? "");
  const [unitId, setUnitId] = useState<string | null>(product ? product.unit_id : defaultUnitId);
  const [kind, setKind] = useState<ProductKind>(
    (product?.kind as ProductKind | undefined) ?? "servico",
  );
  const [typeId, setTypeId] = useState<string | null>(product?.revenue_type_id ?? null);
  const [price, setPrice] = useState(inputOf(product?.price));
  const [model, setModel] = useState<PriceModel>(
    (product?.price_model as PriceModel | undefined) ?? "mensal",
  );
  const [months, setMonths] = useState(
    product?.duration_months ? String(product.duration_months) : "",
  );
  const [seats, setSeats] = useState(inputOf(product?.default_seats));
  const [cpp, setCpp] = useState(inputOf(product?.cost_per_participant));
  const [fixed, setFixed] = useState(inputOf(product?.fixed_cost));
  const [revenueAccountId, setRevenueAccountId] = useState<string | null>(
    product?.revenue_account_id ?? null,
  );
  const [costAccountId, setCostAccountId] = useState<string | null>(
    product?.cost_account_id ?? null,
  );
  const [active, setActive] = useState(product?.active ?? true);
  const [saving, setSaving] = useState(false);

  const num = (s: string) => (s.trim() === "" ? null : parseNum(s));
  const parsed = { price: num(price), seats: num(seats), cpp: num(cpp), fixed: num(fixed) };
  const monthsNum = months.trim() === "" ? null : Number(months);
  const numbersOk =
    [price, seats, cpp, fixed].every((s, i) => {
      const v = [parsed.price, parsed.seats, parsed.cpp, parsed.fixed][i];
      return s.trim() === "" || (v !== null && v !== undefined && v >= 0);
    }) &&
    (monthsNum === null || (Number.isInteger(monthsNum) && monthsNum >= 1 && monthsNum <= 120));
  const valid = name.trim() !== "" && numbersOk && (allowAllUnits || unitId !== null);

  const example =
    kind === "servico" && parsed.price !== null
      ? describePlan(
          contractPlan({ price: parsed.price, price_model: model, duration_months: monthsNum }, 3),
          [...MONTHS],
        )
      : null;

  const accountOptions = (k: "receita" | "despesa") =>
    (accounts ?? [])
      .filter((a) => a.active && a.kind === k)
      .map((a) => ({ value: a.id, label: a.name }));

  async function save() {
    if (!valid) return;
    setSaving(true);
    const isEvent = kind === "evento";
    const row = {
      name: name.trim(),
      unit_id: unitId,
      kind,
      revenue_type_id: typeId,
      price: parsed.price,
      price_model: isEvent ? ("mensal" as const) : model,
      duration_months: isEvent || model === "unico" ? null : monthsNum,
      default_seats: isEvent ? parsed.seats : null,
      cost_per_participant: isEvent ? parsed.cpp : null,
      fixed_cost: isEvent ? parsed.fixed : null,
      revenue_account_id: revenueAccountId,
      cost_account_id: isEvent ? costAccountId : null,
      active,
    };
    const ok = product
      ? await update(product.id, row, "Produto salvo.")
      : await insert(row, "Produto cadastrado.");
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? "Editar produto" : "Novo produto"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Unidade">
            <OptionSelect
              value={unitId}
              onChange={setUnitId}
              {...(allowAllUnits ? { noneLabel: "Todas as unidades" } : {})}
              options={unitOptions.map((u) => ({ value: u.id, label: u.name }))}
            />
          </Field>
          <Field label="Tipo">
            <OptionSelect
              value={kind}
              onChange={(v) => setKind((v as ProductKind) ?? "servico")}
              options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>
          <Field label="Tipo de receita" hint="Define a regra de recorrência e a base da comissão.">
            <OptionSelect
              value={typeId}
              onChange={setTypeId}
              noneLabel="Escolher ao lançar"
              options={(types ?? [])
                .filter((t) => t.active)
                .map((t) => ({ value: t.id, label: t.name }))}
            />
          </Field>

          {kind === "servico" ? (
            <>
              <Field label="Cobrança">
                <OptionSelect
                  value={model}
                  onChange={(v) => setModel((v as PriceModel) ?? "mensal")}
                  options={Object.entries(PRICE_MODEL_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Field>
              <Field
                label={
                  model === "mensal"
                    ? "Preço por mês"
                    : model === "total"
                      ? "Valor do contrato"
                      : "Preço"
                }
              >
                <Input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="font-mono"
                />
              </Field>
              {model !== "unico" && (
                <Field label="Prazo (meses)" hint="Em branco: vale até dezembro.">
                  <Input
                    value={months}
                    onChange={(e) => setMonths(e.target.value.replace(/\D/g, ""))}
                    className="font-mono"
                  />
                </Field>
              )}
              <Field label="Conta da receita" hint="Opcional.">
                <OptionSelect
                  value={revenueAccountId}
                  onChange={setRevenueAccountId}
                  noneLabel="Padrão da unidade"
                  options={accountOptions("receita")}
                />
              </Field>
              {example && (
                <p className="col-span-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                  Exemplo, lançado em março: {example}
                </p>
              )}
            </>
          ) : (
            <>
              <Field label="Preço por participante">
                <Input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Vagas (padrão)">
                <Input
                  value={seats}
                  onChange={(e) => setSeats(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Custo por participante">
                <Input value={cpp} onChange={(e) => setCpp(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Custo fixo do evento">
                <Input
                  value={fixed}
                  onChange={(e) => setFixed(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Conta da receita" hint="Opcional.">
                <OptionSelect
                  value={revenueAccountId}
                  onChange={setRevenueAccountId}
                  noneLabel="Padrão da unidade"
                  options={accountOptions("receita")}
                />
              </Field>
              <Field label="Conta da despesa" hint="Opcional.">
                <OptionSelect
                  value={costAccountId}
                  onChange={setCostAccountId}
                  noneLabel="Padrão da unidade"
                  options={accountOptions("despesa")}
                />
              </Field>
            </>
          )}
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <Switch checked={active} onCheckedChange={setActive} /> Ativo (aparece ao lançar)
          </label>
        </div>
        {!numbersOk && (
          <p className="text-sm text-destructive">
            Confira os números: use valores iguais ou maiores que zero e prazo inteiro de 1 a 120
            meses.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  ownUnitIds,
  onClose,
}: {
  /** null = sem restrição (financeiro); senão, só produtos dessas unidades. */
  ownUnitIds: string[] | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: units } = useUnits();
  const { data: types } = useRevenueTypes();
  const { data: products } = useProducts();
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [saving, setSaving] = useState(false);

  function check() {
    const parsed = parseProducts(text, { units: units ?? [], revenueTypes: types ?? [] });
    // Produtos que já existem na mesma unidade não são cadastrados de novo.
    const existing = new Set((products ?? []).map((p) => `${p.unit_id ?? ""}|${norm(p.name)}`));
    const rows = parsed.rows.filter((r) => {
      if (ownUnitIds && (r.unit_id === null || !ownUnitIds.includes(r.unit_id))) {
        parsed.errors.push({
          line: r.line,
          message: `${r.name}: você só cadastra produtos das suas unidades.`,
        });
        return false;
      }
      const dup = existing.has(`${r.unit_id ?? ""}|${norm(r.name)}`);
      if (dup) parsed.errors.push({ line: r.line, message: `${r.name}: já está cadastrado.` });
      return !dup;
    });
    parsed.errors.sort((a, b) => a.line - b.line);
    setResult({ rows, errors: parsed.errors });
  }

  async function save() {
    if (!result || result.rows.length === 0) return;
    setSaving(true);
    const { error } = await supabase
      .from("products")
      .insert(result.rows.map(({ line: _line, ...row }) => row));
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error.message));
      return;
    }
    toast.success(`${result.rows.length} produto(s) cadastrado(s).`);
    await queryClient.invalidateQueries({ queryKey: ["products"] });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Colar produtos do Excel</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Copie as linhas da planilha e cole abaixo. Colunas, nesta ordem:{" "}
            <strong>{IMPORT_COLUMNS.join(" · ")}</strong>. Para eventos, deixe a cobrança e o prazo
            em branco; para serviços, deixe vagas e custos em branco. A primeira linha pode ser o
            cabeçalho.
          </p>
          <Textarea
            rows={8}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            placeholder={"Diagnóstico\tConsultoria\tserviço\tRecorrente 6 meses\t5000\tmês\t6"}
          />
          {result && (
            <div className="space-y-2">
              {result.rows.length > 0 && (
                <p className="text-sm">
                  <strong>{result.rows.length}</strong> produto(s) prontos para cadastrar:{" "}
                  {result.rows.map((r) => r.name).join(", ")}.
                </p>
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
              {result.rows.length === 0 && result.errors.length === 0 && (
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
          <Button onClick={save} disabled={saving || !result || result.rows.length === 0}>
            {saving
              ? "Cadastrando…"
              : result?.errors.length
                ? `Cadastrar só os ${result.rows.length} válidos`
                : "Cadastrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
