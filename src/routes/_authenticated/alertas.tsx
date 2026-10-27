import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Check, RefreshCw, Sparkles } from "lucide-react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { byId, useUnits } from "@/lib/catalog";
import {
  ALERT_SETTINGS,
  SEVERITY_LABELS,
  useAlertActions,
  useAlertSummaries,
  useAlerts,
  type Severity,
} from "@/lib/alerts";
import { fmtBRL, fmtPct } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { OptionSelect } from "@/components/form-fields";
import { AppSettingField } from "@/components/app-setting-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/alertas")({
  head: pageHead(
    "Alertas",
    "Quedas de receita, despesas fora do padrão e pendências do plano, com resumo por unidade.",
  ),
  component: AlertasPage,
});

const SEVERITY_STYLE: Record<Severity, string> = {
  alta: "bg-destructive text-destructive-foreground",
  media: "bg-amber-500 text-white",
  baixa: "bg-muted text-muted-foreground",
};
// Na concentração, a variação é a participação do cliente; no plano sem origem, o valor é uma contagem.
const PCT_KINDS = new Set(["concentracao"]);
const COUNT_KINDS = new Set(["plano_sem_origem"]);

function AlertasPage() {
  const { versionId, scenarioId, version, scenario } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: alerts, isLoading } = useAlerts();
  const { data: summaries } = useAlertSummaries();
  const { data: units } = useUnits();
  const unitMap = byId(units);
  const actions = useAlertActions();
  const [unitFilter, setUnitFilter] = useState<string | null>(null);
  const [status, setStatus] = useState<"novo" | "todos">("novo");
  const [busy, setBusy] = useState<"update" | "digest" | null>(null);
  const [showLimits, setShowLimits] = useState(false);

  const visibleUnits = useMemo(
    () => [...new Set((alerts ?? []).map((a) => a.unit_id).filter((u): u is string => !!u))],
    [alerts],
  );
  const rows = (alerts ?? []).filter(
    (a) => (status === "todos" || a.status === "novo") && (!unitFilter || a.unit_id === unitFilter),
  );
  const unitName = (id: string | null) => (id ? (unitMap.get(id)?.name ?? "—") : "Sem unidade");
  const run = async (kind: "update" | "digest") => {
    setBusy(kind);
    try {
      if (kind === "update") await actions.update(versionId, scenarioId);
      else await actions.digest(versionId, scenarioId);
    } finally {
      setBusy(null);
    }
  };
  const company = summaries?.find((s) => !s.unit_id);
  const unitSummaries = (summaries ?? []).filter(
    (s) => s.unit_id && (!unitFilter || s.unit_id === unitFilter),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Alertas"
        subtitle={`Realizado do Omie (último mês fechado) e plano: ${version?.name ?? "…"} · Cenário ${scenario?.name ?? "…"}`}
        actions={
          user?.isFinanceiro && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!!busy}
                onClick={() => run("update")}
              >
                <RefreshCw className={`h-4 w-4 ${busy === "update" ? "animate-spin" : ""}`} />
                Atualizar alertas
              </Button>
              <Button size="sm" className="gap-1.5" disabled={!!busy} onClick={() => run("digest")}>
                <Sparkles className={`h-4 w-4 ${busy === "digest" ? "animate-pulse" : ""}`} />
                {busy === "digest" ? "Gerando resumo…" : "Gerar resumo com IA"}
              </Button>
            </div>
          )
        }
      />

      {(company || unitSummaries.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" /> Resumo da IA
              <span className="text-xs font-normal text-muted-foreground">
                {summaries?.[0] &&
                  `mês ${summaries[0].period.slice(5, 7)}/${summaries[0].period.slice(0, 4)} · gerado em ${new Date(summaries[0].created_at).toLocaleString("pt-BR")}`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {company && !unitFilter && <p className="leading-relaxed">{company.text}</p>}
            {unitSummaries.map((s) => (
              <div key={s.id}>
                <div className="font-medium">{unitName(s.unit_id)}</div>
                <p className="leading-relaxed text-muted-foreground">{s.text}</p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Texto escrito pela IA a partir dos alertas abaixo. Confira os números na lista antes
              de decidir.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          className="w-52"
          value={unitFilter}
          onChange={setUnitFilter}
          noneLabel="Todas as unidades"
          options={visibleUnits.map((id) => ({ value: id, label: unitName(id) }))}
        />
        <OptionSelect
          className="w-40"
          value={status}
          onChange={(v) => setStatus((v as "novo" | "todos") ?? "novo")}
          options={[
            { value: "novo", label: "Só os novos" },
            { value: "todos", label: "Todos" },
          ]}
        />
        <span className="text-sm text-muted-foreground">{rows.length} alerta(s)</span>
        {user?.isFinanceiro && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setShowLimits((v) => !v)}
          >
            {showLimits ? "Fechar limites" : "Limites dos alertas"}
          </Button>
        )}
      </div>

      {showLimits && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm text-muted-foreground">
              Os detectores usam estes limites. Depois de mudar, clique em Atualizar alertas.
            </p>
            {ALERT_SETTINGS.map((s) => (
              <AppSettingField key={s.key} settingKey={s.key} label={s.label} />
            ))}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          {(alerts ?? []).length === 0
            ? user?.isFinanceiro
              ? "Nenhum alerta ainda. Clique em Atualizar alertas para rodar os detectores."
              : "Nenhum alerta para as suas unidades."
            : "Nenhum alerta neste filtro."}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border bg-card">
          {rows.map((a) => {
            const sev = a.severity as Severity;
            const value =
              a.value === null
                ? null
                : COUNT_KINDS.has(a.kind)
                  ? String(a.value)
                  : fmtBRL(Number(a.value));
            return (
              <div
                key={a.id}
                className={`flex flex-wrap items-start gap-3 px-4 py-3 ${a.status === "visto" ? "opacity-60" : ""}`}
              >
                <Badge className={`mt-0.5 w-14 justify-center ${SEVERITY_STYLE[sev]}`}>
                  {SEVERITY_LABELS[sev]}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{a.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {unitName(a.unit_id)}
                    {a.period && ` · ${a.period.slice(5, 7)}/${a.period.slice(0, 4)}`}
                    {a.version_id && " · plano"}
                    {a.detail && ` · ${a.detail}`}
                  </div>
                </div>
                <div className="text-right text-sm">
                  {value && <div className="font-mono tabular-nums">{value}</div>}
                  {a.change !== null && (
                    <div
                      className={`font-mono text-xs tabular-nums ${Number(a.change) < 0 ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {Number(a.change) > 0 && !PCT_KINDS.has(a.kind) ? "+" : ""}
                      {fmtPct(Number(a.change))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {a.link && (
                    <Button asChild variant="ghost" size="sm">
                      <Link to={a.link}>Abrir</Link>
                    </Button>
                  )}
                  {a.status === "novo" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      onClick={() => void actions.markSeen(a.id)}
                    >
                      <Check className="h-3.5 w-3.5" /> Visto
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
