import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePlanning } from "@/lib/planning";
import { byId, friendlyError, useAccounts, useClients } from "@/lib/catalog";
import { useRevenuePortfolio } from "@/lib/omie";
import { usePlanLines, usePlanMutations } from "@/lib/plan-data";
import { unitRevenueAccount } from "@/lib/revenue-paste";
import { norm } from "@/lib/products-import";
import { MONTHS, fmtBRL, parseNum } from "@/lib/format";
import { inputOf } from "@/lib/products";
import { Field, MonthSelect, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const sum = (xs: number[]) => xs.reduce((a, v) => a + v, 0);

interface Choice {
  on: boolean;
  /** contratado: os títulos a receber do ano do plano; media: a média mensal recorrente. */
  base: "contratado" | "media";
  monthly: string;
  /** Último mês do contrato em 2027 (12 = o ano todo). */
  until: number;
}

/**
 * Carteira pré-carregada: os clientes que pagaram a unidade todo mês no ano anterior (Omie) viram linhas de Carteira,
 * com a média dos últimos meses. O líder desmarca quem sai, ajusta o valor e o mês de término, e aplica o reajuste.
 */
export function PortfolioDialog({ onClose }: { onClose: () => void }) {
  const { versionId, unitId, unit, version } = usePlanning();
  const { data: suggestions, isLoading } = useRevenuePortfolio(versionId, unitId);
  const { data: lines } = usePlanLines(versionId, unitId, "receita");
  const { data: accounts } = useAccounts();
  const { data: clients } = useClients();
  const { addLines } = usePlanMutations();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [pct, setPct] = useState("");
  const [fromMonth, setFromMonth] = useState<number | null>(1);
  const [saving, setSaving] = useState(false);
  const baseYear = (version?.year ?? 2027) - 1;

  const accountOptions = (accounts ?? []).filter(
    (a) =>
      a.kind === "receita" &&
      a.active &&
      a.treatment === "lancavel" &&
      (!a.unit_ids || a.unit_ids.includes(unitId!)),
  );
  const accountMap = byId(accounts);
  const fallback = unitRevenueAccount(accountOptions, unit);
  const clientMap = useMemo(() => byId(clients), [clients]);

  // Clientes que já têm linha de carteira na unidade: ficam desmarcados (evita lançar duas vezes).
  const already = useMemo(() => {
    const names = new Set<string>();
    for (const l of lines ?? []) {
      if (l.revenue_origin !== "carteira") continue;
      if (l.client_id) names.add(norm(clientMap.get(l.client_id)?.name ?? ""));
      if (l.description) names.add(norm(l.description));
    }
    return names;
  }, [lines, clientMap]);

  const key = (s: { clientCode: string; categoryName: string }) =>
    `${s.clientCode}|${s.categoryName}`;
  useEffect(() => {
    if (!suggestions) return;
    // Só os clientes novos na lista ganham escolha inicial; sem novidade, o estado fica como está.
    setChoices((c) => {
      const fresh = suggestions.filter((s) => !c[key(s)]);
      if (fresh.length === 0) return c;
      const n = { ...c };
      for (const s of fresh)
        n[key(s)] = {
          on: !already.has(norm(s.clientName)),
          base: sum(s.contracted) > 0 ? "contratado" : "media",
          monthly: inputOf(s.monthly),
          until: 12,
        };
      return n;
    });
  }, [suggestions, already]);

  const pctNum = pct.trim() === "" ? 0 : parseNum(pct);
  const valid = pctNum !== null && pctNum > -100;
  const rows = (suggestions ?? []).map((s) => ({ s, c: choices[key(s)] }));
  const chosen = rows.filter((r) => r.c?.on);
  const scheduleOf = (c: Choice, contracted: number[]) => {
    if (c.base === "contratado")
      return contracted
        .map((amount, i) => ({ month: i + 1, amount }))
        .filter((x) => x.amount !== 0 && x.month <= c.until);
    const v = parseNum(c.monthly) ?? 0;
    return MONTHS.map((_, i) => i + 1)
      .filter((m) => m <= c.until)
      .map((m) => ({
        month: m,
        amount:
          Math.round(
            v * (fromMonth !== null && m >= fromMonth ? 1 + (pctNum ?? 0) / 100 : 1) * 100,
          ) / 100,
      }))
      .filter((x) => x.amount !== 0);
  };
  const total = chosen.reduce(
    (a, r) => a + scheduleOf(r.c!, r.s.contracted).reduce((b, x) => b + x.amount, 0),
    0,
  );
  const set = (k: string, patch: Partial<Choice>) =>
    setChoices((c) => ({ ...c, [k]: { ...c[k]!, ...patch } }));

  /** Ids dos clientes pelo nome, cadastrando os que faltam. */
  async function clientIds(names: string[]): Promise<Map<string, string> | null> {
    const map = new Map((clients ?? []).map((c) => [norm(c.name), c.id]));
    const missing = [...new Set(names.filter((n) => !map.has(norm(n))))];
    if (missing.length > 0) {
      const { data, error } = await supabase
        .from("clients")
        .insert(missing.map((name) => ({ name })))
        .select("id, name");
      if (error) {
        toast.error(friendlyError(error.message));
        return null;
      }
      for (const c of data ?? []) map.set(norm(c.name), c.id);
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
    }
    return map;
  }

  async function save() {
    if (!fallback || chosen.length === 0 || !valid) return;
    setSaving(true);
    const ids = await clientIds(chosen.map((r) => r.s.clientName));
    if (!ids) {
      setSaving(false);
      return;
    }
    const ok = await addLines(
      chosen.map(({ s, c }) => ({
        line: {
          version_id: versionId!,
          unit_id: unitId!,
          account_id:
            s.accountId && accountOptions.some((a) => a.id === s.accountId)
              ? s.accountId
              : fallback.id,
          description: s.clientName,
          client_id: ids.get(norm(s.clientName)) ?? null,
          revenue_origin: "carteira",
          note:
            c!.base === "contratado"
              ? `A receber em ${version?.year ?? ""} (Omie): títulos já contratados`
              : `Carteira ${baseYear} (Omie): média dos últimos 3 meses${
                  pctNum ? `, reajuste de ${pct}% a partir de ${MONTHS[(fromMonth ?? 1) - 1]}` : ""
                }`,
        },
        values: scheduleOf(c!, s.contracted),
      })),
    );
    setSaving(false);
    if (ok > 0) toast.success(`${ok} cliente(s) da carteira lançado(s).`);
    if (ok === chosen.length) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Carregar carteira de {baseYear} (Omie)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Do Omie: o que já está contratado para {version?.year ?? ""} (títulos a receber, como
            parcelas e contratos) e os clientes que pagaram {unit?.name ?? "a unidade"} todo mês no
            fim de {baseYear} (média dos 3 últimos meses; o reajuste vale só para estes). Desmarque
            quem não continua e ajuste valor e término. Quem já tem linha de carteira vem
            desmarcado.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Reajuste (%)" hint="Opcional. Ex.: 5 para IPCA + 1.">
              <Input
                className="w-28 font-mono"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
              />
            </Field>
            <Field label="A partir de">
              <MonthSelect value={fromMonth} onChange={setFromMonth} />
            </Field>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Lendo o realizado do Omie…</p>
          ) : rows.length === 0 ? (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              Nenhum cliente recorrente desta unidade no realizado de {baseYear}. Confira se a
              leitura do Omie trouxe as receitas e se as categorias e departamentos estão ligados à
              unidade.
            </p>
          ) : (
            <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr className="border-b border-border text-left">
                    <th className="w-8 px-2 py-1.5">
                      <Checkbox
                        aria-label="Marcar todos"
                        checked={chosen.length === rows.length}
                        onCheckedChange={(v) =>
                          setChoices((c) =>
                            Object.fromEntries(
                              Object.entries(c).map(([k, x]) => [k, { ...x, on: !!v }]),
                            ),
                          )
                        }
                      />
                    </th>
                    <th className="px-2 py-1.5 font-medium">Cliente</th>
                    <th className="px-2 py-1.5 font-medium">Conta</th>
                    <th className="px-2 py-1.5 font-medium">Base</th>
                    <th className="w-32 px-2 py-1.5 text-right font-medium">Valor por mês</th>
                    <th className="w-32 px-2 py-1.5 font-medium">Até</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ s, c }) => {
                    const k = key(s);
                    if (!c) return null;
                    return (
                      <tr key={k} className="border-b border-border/60 last:border-0">
                        <td className="px-2 py-1">
                          <Checkbox
                            aria-label={`Incluir ${s.clientName}`}
                            checked={c.on}
                            onCheckedChange={(v) => set(k, { on: !!v })}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <div className="font-medium">{s.clientName}</div>
                          <div className="text-xs text-muted-foreground">{s.categoryName}</div>
                        </td>
                        <td className="px-2 py-1 text-xs text-muted-foreground">
                          {(s.accountId && accountMap.get(s.accountId)?.name) ??
                            fallback?.name ??
                            "—"}
                        </td>
                        <td className="px-2 py-1 text-xs">
                          {sum(s.contracted) > 0 && s.monthly > 0 ? (
                            <OptionSelect
                              className="h-8 w-40"
                              value={c.base}
                              onChange={(v) =>
                                set(k, { base: (v as Choice["base"] | null) ?? "media" })
                              }
                              options={[
                                { value: "contratado", label: "A receber" },
                                { value: "media", label: "Média mensal" },
                              ]}
                            />
                          ) : c.base === "contratado" ? (
                            "A receber"
                          ) : (
                            <span className="text-muted-foreground">
                              Média · pagou {s.monthsActive} de 4 meses
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {c.base === "contratado" ? (
                            <div className="text-right font-mono text-xs tabular-nums">
                              {fmtBRL(sum(s.contracted))} no ano
                            </div>
                          ) : (
                            <Input
                              className="h-8 text-right font-mono"
                              value={c.monthly}
                              onChange={(e) => set(k, { monthly: e.target.value })}
                              aria-label={`Valor por mês de ${s.clientName}`}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <MonthSelect
                            value={c.until}
                            onChange={(m) => set(k, { until: m ?? 12 })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <p className="text-sm">
              <strong>{chosen.length}</strong> de {rows.length} cliente(s), {fmtBRL(total)} em{" "}
              {version?.year ?? ""}.
            </p>
          )}
          {!valid && <p className="text-sm text-destructive">Reajuste inválido.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || chosen.length === 0 || !valid || !fallback}>
            {saving ? "Lançando…" : `Lançar ${chosen.length} cliente(s) na carteira`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
