import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Percent } from "lucide-react";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useExpenseBase, useExpenseBaseMutations } from "@/lib/expense-base";
import { fmtBRL, parseNum } from "@/lib/format";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Base de despesas do ano a partir do realizado do ano anterior no Omie. O financeiro gera uma vez (com um reajuste
 * geral), depois edita linha a linha na grade ou aplica um reajuste geral sobre o que já está lá.
 */
export function ExpenseBasePanel({ showUnit = true }: { showUnit?: boolean }) {
  const { version, versionId, unitId, unit, canEdit } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: base } = useExpenseBase(versionId);
  const [dialog, setDialog] = useState<"generate" | "adjust" | null>(null);
  if (!user?.isFinanceiro || !version) return null;
  const prev = version.year - 1;
  const has = (base?.lines ?? 0) > 0;

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-3">
      <div className="text-sm">
        <div className="font-medium">
          Base de despesas {version.year} a partir do realizado de {prev}
        </div>
        <div className="text-muted-foreground">
          {has
            ? `${base!.lines} linhas geradas do Omie · ${fmtBRL(base!.total)} no ano, todas as unidades` +
              (showUnit && unitId
                ? ` · ${unit?.name}: ${fmtBRL(base!.byUnit.get(unitId) ?? 0)}`
                : "") +
              ". Edite qualquer linha na grade."
            : `As despesas de ${prev} já estão no app (lidas do Omie). Gere a base de ${version.year} com um reajuste geral; depois edite o que precisar.`}
        </div>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          {has && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setDialog("adjust")}
            >
              <Percent className="h-4 w-4" /> Reajustar a base
            </Button>
          )}
          <Button
            size="sm"
            variant={has ? "ghost" : "default"}
            className="gap-1.5"
            onClick={() => setDialog("generate")}
          >
            <RefreshCw className="h-4 w-4" />{" "}
            {has ? "Gerar de novo" : `Gerar base de ${version.year}`}
          </Button>
        </div>
      )}
      {dialog === "generate" && <GenerateDialog regenerate={has} onClose={() => setDialog(null)} />}
      {dialog === "adjust" && <AdjustDialog onClose={() => setDialog(null)} />}
    </section>
  );
}

function GenerateDialog({ regenerate, onClose }: { regenerate: boolean; onClose: () => void }) {
  const { version, versionId } = usePlanning();
  const { generate } = useExpenseBaseMutations();
  const [pct, setPct] = useState("0");
  const [mode, setMode] = useState<"mes_a_mes" | "media">("mes_a_mes");
  const [saving, setSaving] = useState(false);
  const pctN = parseNum(pct);
  const prev = (version?.year ?? 0) - 1;

  async function save() {
    if (pctN === null || !versionId) return;
    setSaving(true);
    const r = await generate(versionId, pctN / 100, mode);
    setSaving(false);
    if (r) {
      toast.success(`${r.lines} linhas geradas: ${fmtBRL(r.total)} no ano.`);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Gerar a base de {version?.year}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Cada despesa de {prev} lida do Omie vira uma linha “Base {prev} (Omie)” na conta e na
            unidade dela. Folha, encargos, impostos e comissões ficam de fora, porque o app calcula.
            Despesas sem unidade vão para a ADM; benefícios e rescisões sem unidade são divididos
            pelas pessoas de cada unidade.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reajuste geral (%)" hint="Ex.: 5 para 5% sobre o realizado.">
              <Input value={pct} onChange={(e) => setPct(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Distribuição nos meses">
              <OptionSelect
                value={mode}
                onChange={(v) => v && setMode(v as "mes_a_mes" | "media")}
                options={[
                  { value: "mes_a_mes", label: `Mês a mês, como em ${prev}` },
                  { value: "media", label: "Média dos 12 meses" },
                ]}
              />
            </Field>
          </div>
          {regenerate && (
            <p className="rounded-md border border-destructive/40 p-2 text-destructive">
              A base já existe. Gerar de novo refaz todas as linhas geradas e desfaz as edições
              feitas nelas. As linhas lançadas à mão ficam. Para só mudar o percentual, use
              “Reajustar a base”.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || pctN === null}>
            {saving ? "Gerando…" : regenerate ? "Gerar de novo" : "Gerar base"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ onClose }: { onClose: () => void }) {
  const { versionId } = usePlanning();
  const { adjust } = useExpenseBaseMutations();
  const [pct, setPct] = useState("");
  const [saving, setSaving] = useState(false);
  const pctN = pct.trim() === "" ? null : parseNum(pct);

  async function save() {
    if (pctN === null || !versionId) return;
    setSaving(true);
    const ok = await adjust(versionId, pctN / 100);
    setSaving(false);
    if (ok) {
      toast.success(`Base reajustada em ${pct}%.`);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reajustar a base</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Aplica o percentual sobre todas as linhas geradas do Omie, em todas as unidades,
            mantendo as edições que você já fez em cada uma. Use negativo para reduzir. Linhas
            lançadas à mão não mudam.
          </p>
          <Field label="Reajuste (%)">
            <Input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              className="font-mono"
              placeholder="5"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || pctN === null}>
            Reajustar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
