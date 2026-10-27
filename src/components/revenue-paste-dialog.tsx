import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePlanning } from "@/lib/planning";
import { useAccounts, useProducts } from "@/lib/catalog";
import { usePlanMutations } from "@/lib/plan-data";
import { REVENUE_ORIGINS, parseRevenuePaste, unitRevenueAccount } from "@/lib/revenue-paste";
import { MONTHS, fmtBRL } from "@/lib/format";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Lança várias receitas de uma vez a partir da planilha do líder: uma linha por lançamento, com descrição, produto e
 * origem (opcionais, em qualquer ordem) e os meses. A conta é a do produto ou a padrão da unidade.
 */
export function RevenuePasteDialog({ onClose }: { onClose: () => void }) {
  const { versionId, unitId, unit } = usePlanning();
  const { data: accounts } = useAccounts();
  const { data: products } = useProducts();
  const { addLines } = usePlanMutations();
  const [text, setText] = useState("");
  const [defaultOrigin, setDefaultOrigin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const accountOptions = (accounts ?? []).filter(
    (a) =>
      a.kind === "receita" &&
      a.active &&
      a.treatment === "lancavel" &&
      (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  const fallbackAccount = unitRevenueAccount(accountOptions, unit);
  const productOptions = (products ?? []).filter(
    (p) => p.active && (!p.unit_id || p.unit_id === unitId),
  );
  const rows = useMemo(
    () => parseRevenuePaste(text, productOptions, defaultOrigin),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, defaultOrigin, products, unitId],
  );
  const valid = rows.filter((r) => r.errors.length === 0);
  const invalid = rows.filter((r) => r.errors.length > 0);
  const total = valid.reduce((a, r) => a + r.values.reduce((b, v) => b + v.amount, 0), 0);
  const productName = (id: string | null) => productOptions.find((p) => p.id === id)?.name;

  async function save() {
    if (valid.length === 0 || !fallbackAccount) return;
    setSaving(true);
    const ok = await addLines(
      valid.map((r) => {
        const product = productOptions.find((p) => p.id === r.productId);
        const accountId =
          product?.revenue_account_id &&
          accountOptions.some((a) => a.id === product.revenue_account_id)
            ? product.revenue_account_id
            : fallbackAccount.id;
        return {
          line: {
            version_id: versionId!,
            unit_id: unitId!,
            account_id: accountId,
            description: r.description || null,
            product_id: r.productId,
            revenue_type_id: product?.revenue_type_id ?? null,
            revenue_origin: r.origin,
          },
          values: r.values,
        };
      }),
    );
    setSaving(false);
    if (ok > 0) toast.success(`${ok} lançamento(s) incluído(s).`);
    if (ok === valid.length) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Colar receitas da planilha</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Copie as linhas da sua planilha (Excel ou Google Sheets) e cole abaixo, uma linha por
            lançamento. Colunas: <strong>Descrição</strong>, <strong>Produto</strong> e{" "}
            <strong>Origem</strong> (opcionais) e os meses de <strong>Jan a Dez</strong>. Com
            cabeçalho (Jan, Fev…), as colunas podem estar em qualquer ordem; sem cabeçalho, os
            números depois da descrição são os meses a partir de janeiro.
          </p>
          <Field
            label="Origem para as linhas sem origem"
            hint="Carteira: contratos que já existem. Renovação: contratos que vencem e renovam. Nova: venda a fazer."
          >
            <OptionSelect
              className="w-56"
              value={defaultOrigin}
              onChange={setDefaultOrigin}
              noneLabel="Exigir na planilha"
              options={REVENUE_ORIGINS}
            />
          </Field>
          <Textarea
            rows={8}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "Descrição\tProduto\tOrigem\tJan\tFev\tMar\nContrato X\t\tCarteira\t10.000\t10.000\t10.000"
            }
          />
          {rows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left">
                    <th className="px-2 py-1 font-medium">Linha</th>
                    <th className="px-2 py-1 font-medium">Descrição</th>
                    <th className="px-2 py-1 font-medium">Produto</th>
                    <th className="px-2 py-1 font-medium">Origem</th>
                    <th className="px-2 py-1 font-medium">Meses</th>
                    <th className="px-2 py-1 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row} className="border-b border-border/60 align-top last:border-0">
                      <td className="px-2 py-1 text-muted-foreground">{r.row}</td>
                      <td className="px-2 py-1">
                        {r.description || "—"}
                        {r.errors.map((e) => (
                          <div key={e} className="text-destructive">
                            {e}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1">{productName(r.productId) ?? "—"}</td>
                      <td className="px-2 py-1">
                        {REVENUE_ORIGINS.find((o) => o.value === r.origin)?.label ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.values.length > 0
                          ? `${MONTHS[r.values[0]!.month - 1]}–${MONTHS[r.values.at(-1)!.month - 1]}`
                          : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">
                        {fmtBRL(r.values.reduce((a, v) => a + v.amount, 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <p className="text-sm">
              <strong>{valid.length}</strong> pronta(s) para lançar, {fmtBRL(total)} no ano
              {invalid.length > 0 && (
                <span className="text-destructive">
                  {" "}
                  · {invalid.length} com erro (ficam de fora; corrija na planilha e cole de novo)
                </span>
              )}
              .
            </p>
          )}
          {!fallbackAccount && (
            <p className="text-sm text-destructive">
              Nenhuma conta de receita disponível para {unit?.name ?? "esta unidade"}. Peça ao
              financeiro para liberar uma em Configurações.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || valid.length === 0 || !fallbackAccount}>
            {saving ? "Lançando…" : `Lançar ${valid.length} linha(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
