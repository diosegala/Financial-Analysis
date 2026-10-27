import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { pageHead } from "@/lib/head";
import { usePlanning } from "@/lib/planning";
import { useCurrentUser } from "@/lib/auth";
import { useDreLines, useUnits } from "@/lib/catalog";
import { useBoard } from "@/lib/board";
import { dreValue, fmtLine, useDreReport } from "@/lib/dre";
import {
  SUBMISSION_LABELS,
  VERSION_STATUS_LABELS,
  useSetUnitStatus,
  useSubmissions,
  type SubmissionStatus,
} from "@/lib/submissions";
import { PageHeader } from "@/components/page-header";
import { LeaderGoal, SetupSteps } from "@/components/setup-steps";
import { BoardCards } from "@/components/board-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/inicio")({
  head: pageHead("Início", "Resumo do planejamento da unidade e acompanhamento da coleta."),
  component: InicioPage,
});

function InicioPage() {
  const { unit, unitId, version, versionId, scenario, scenarioId } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: lines } = useDreLines();
  const { data: values, isLoading } = useDreReport(versionId, scenarioId, unitId ? [unitId] : []);
  // Cartões: receitas, subtotais e percentuais da estrutura da DRE (configurável).
  const kpis = (lines ?? []).filter(
    (l) =>
      l.active &&
      (l.kind === "subtotal" || l.kind === "percentual" || (l.kind === "lancada" && l.sign > 0)),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Início"
        subtitle={`${unit?.name ?? "…"} · ${version?.name ?? "…"} (${
          VERSION_STATUS_LABELS[version?.status ?? ""] ?? "…"
        }) · Cenário ${scenario?.name ?? "…"}`}
      />
      {user?.isFinanceiro && <SetupSteps />}
      {user && !user.isManagement && <LeaderGoal />}
      {user?.isManagement && <BoardSection />}
      <h2 className="text-lg font-semibold">Resultado da unidade</h2>
      {isLoading || !values ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((line) => {
            const v = dreValue(values, line.id, 0);
            return (
              <Card key={line.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {line.name} no ano
                  </CardTitle>
                </CardHeader>
                <CardContent
                  className={`font-mono text-2xl font-semibold tabular-nums ${
                    line.kind !== "lancada" && v < 0 ? "text-destructive" : ""
                  }`}
                >
                  {fmtLine(line, v)}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {user?.isManagement && <CollectionPanel />}
    </div>
  );
}

function CollectionPanel() {
  const { versionId, version } = usePlanning();
  const { data: user } = useCurrentUser();
  const { data: units } = useUnits();
  const { data: submissions } = useSubmissions(versionId);
  const setUnitStatus = useSetUnitStatus();
  const [returning, setReturning] = useState<{ unitId: string; name: string } | null>(null);
  const [comment, setComment] = useState("");
  const active = (units ?? []).filter((u) => u.active);
  const byUnit = new Map((submissions ?? []).map((s) => [s.unit_id, s]));
  const counts = active.reduce<Record<string, number>>((acc, u) => {
    const s = (byUnit.get(u.id)?.status ?? "rascunho") as SubmissionStatus;
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Coleta do orçamento</h2>
        <p className="text-sm text-muted-foreground">
          {(Object.keys(SUBMISSION_LABELS) as SubmissionStatus[])
            .filter((s) => counts[s])
            .map((s) => `${counts[s]} ${SUBMISSION_LABELS[s].toLowerCase()}`)
            .join(" · ")}
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th className="px-3 py-2 font-medium">Unidade</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Última movimentação</th>
              <th className="px-3 py-2 font-medium">Comentário</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {active.map((u) => {
              const s = byUnit.get(u.id);
              const status = (s?.status ?? "rascunho") as SubmissionStatus;
              const when = s?.reviewed_at ?? s?.submitted_at;
              return (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 font-medium">{u.name}</td>
                  <td className="px-3 py-1.5">
                    <Badge
                      variant={
                        status === "aprovado"
                          ? "default"
                          : status === "devolvido"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {SUBMISSION_LABELS[status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {when ? new Date(when).toLocaleString("pt-BR") : "—"}
                  </td>
                  <td className="max-w-xs truncate px-3 py-1.5 text-muted-foreground">
                    {s?.comment ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {user?.isFinanceiro && version?.status !== "travado" && (
                      <div className="flex justify-end gap-1.5">
                        {status === "enviado" && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => setUnitStatus(versionId!, u.id, "aprovado")}
                            >
                              Aprovar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setComment("");
                                setReturning({ unitId: u.id, name: u.name });
                              }}
                            >
                              Devolver
                            </Button>
                          </>
                        )}
                        {status === "aprovado" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setUnitStatus(versionId!, u.id, "rascunho")}
                          >
                            Reabrir
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={!!returning} onOpenChange={(o) => !o && setReturning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Devolver {returning?.name} para ajuste</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="O que precisa ser revisado?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturning(null)}>
              Cancelar
            </Button>
            <Button
              disabled={!comment.trim()}
              onClick={async () => {
                if (
                  returning &&
                  (await setUnitStatus(versionId!, returning.unitId, "devolvido", comment.trim()))
                )
                  setReturning(null);
              }}
            >
              Devolver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Painel da diretoria: cada unidade de negócio com meta, planejado, recorrente e resultado com e sem apoio. */
function BoardSection() {
  const { version, versionId, scenario, scenarioId } = usePlanning();
  const { data: units } = useUnits();
  const { data: lines } = useDreLines();
  const { data: board } = useBoard(versionId, scenarioId, units, lines);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Painel da diretoria</h2>
        <p className="text-sm text-muted-foreground">
          {version?.name ?? "…"} · Cenário {scenario?.name ?? "…"}. A tabela completa, com o
          critério do rateio, fica na DRE → Todas as unidades → Por unidade.
        </p>
      </div>
      {board ? (
        <BoardCards board={board} />
      ) : (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      )}
    </section>
  );
}
