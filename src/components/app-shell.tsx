import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser, type CurrentUser } from "@/lib/auth";
import { useScenarios, useUnits, useVersions, type Version } from "@/lib/catalog";
import { PlanningProvider, type PlanningState } from "@/lib/planning";
import {
  SUBMISSION_LABELS,
  useSetUnitStatus,
  useSubmissions,
  type SubmissionStatus,
} from "@/lib/submissions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  LayoutDashboard,
  TrendingUp,
  Users,
  Receipt,
  SlidersHorizontal,
  Layers,
  FileBarChart,
  UserCog,
  History,
  LogOut,
  CalendarDays,
  Settings,
  Send,
} from "lucide-react";

const NAV = [
  { to: "/inicio", label: "Início", icon: LayoutDashboard },
  { to: "/receitas", label: "Receitas", icon: TrendingUp },
  { to: "/eventos", label: "Eventos", icon: CalendarDays },
  { to: "/folha", label: "Folha", icon: Users },
  { to: "/despesas", label: "Despesas", icon: Receipt },
  { to: "/dre", label: "DRE prevista", icon: FileBarChart },
  { to: "/cenarios", label: "Cenários", icon: Layers },
  { to: "/parametros", label: "Parâmetros", icon: SlidersHorizontal, financeiro: true },
  { to: "/configuracoes", label: "Configurações", icon: Settings, financeiro: true },
  { to: "/usuarios", label: "Usuários", icon: UserCog, financeiro: true },
  { to: "/auditoria", label: "Auditoria", icon: History, management: true },
] as const;

/** Why the user cannot enter values in this unit/version right now (null = can edit). */
function lockReasonFor(
  user: CurrentUser | null | undefined,
  version: Version | null,
  unitId: string | null,
  status: SubmissionStatus,
): string | null {
  if (!user || !version || !unitId) return "Carregando…";
  if (!user.canWrite) return "Seu perfil é somente leitura.";
  if (version.status === "travado") return "Esta versão está travada.";
  if (user.isFinanceiro) return null;
  if (!user.unitIds.includes(unitId)) return "Você não lança nesta unidade.";
  if (version.status !== "em_coleta") return "A versão não está aberta para lançamentos.";
  if (status === "enviado" || status === "aprovado")
    return `Unidade ${SUBMISSION_LABELS[status].toLowerCase()}.`;
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ from: "/_authenticated" });
  const [confirmSend, setConfirmSend] = useState(false);

  const { data: units } = useUnits();
  const { data: versions } = useVersions();

  const visibleUnits = (units ?? []).filter(
    (u) => u.active && (user?.isManagement || user?.unitIds.includes(u.id)),
  );
  const unit = visibleUnits.find((u) => u.id === search.u) ?? visibleUnits[0] ?? null;
  const version =
    (versions ?? []).find((v) => v.id === search.v) ??
    (versions ?? []).find((v) => v.is_default) ??
    (versions ?? []).at(-1) ??
    null;
  const { data: scenarios } = useScenarios(version?.id ?? null);
  const scenario =
    scenarios.find((s) => s.id === search.s) ??
    scenarios.find((s) => s.is_official) ??
    scenarios[0] ??
    null;

  const { data: submissions } = useSubmissions(version?.id ?? null);
  const submissionStatus = ((submissions ?? []).find((s) => s.unit_id === unit?.id)?.status ??
    "rascunho") as SubmissionStatus;
  const setUnitStatus = useSetUnitStatus();

  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) });

  const lockReason = lockReasonFor(user, version, unit?.id ?? null, submissionStatus);
  const planning: PlanningState = {
    unitId: unit?.id ?? null,
    unit,
    versionId: version?.id ?? null,
    version,
    scenarioId: scenario?.id ?? null,
    scenario,
    year: version?.year ?? null,
    submissionStatus,
    canEdit: lockReason === null,
    lockReason,
    setUnitId: (id) => setSearch({ u: id }),
    setVersionId: (id) => setSearch({ v: id, s: undefined }),
    setScenarioId: (id) => setSearch({ s: id }),
  };

  const canSend =
    !!unit &&
    !!version &&
    version.status === "em_coleta" &&
    (submissionStatus === "rascunho" || submissionStatus === "devolvido") &&
    (user?.isFinanceiro || (user?.isLider && user.unitIds.includes(unit.id)));

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <PlanningProvider value={planning}>
      <div className="flex min-h-screen">
        <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          <div className="border-b border-sidebar-border px-5 py-4">
            <img src="/brand/cupola-branca.png" alt="CUPOLA" className="h-7 w-auto" />
            <div className="mt-1 text-xs text-sidebar-foreground/60">Planejamento financeiro</div>
          </div>
          <nav className="flex-1 space-y-0.5 p-2">
            {NAV.filter((item) => {
              if ("financeiro" in item && item.financeiro) return user?.isFinanceiro;
              if ("management" in item && item.management) return user?.isManagement;
              return true;
            }).map((item) => {
              const active = pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  search={(prev: Record<string, unknown>) => prev}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50"
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-sidebar-border p-3">
            <div className="truncate px-1 text-sm font-medium text-sidebar-foreground">
              {user?.fullName}
            </div>
            <div className="truncate px-1 text-xs text-sidebar-foreground/60">{user?.email}</div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-start gap-2 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={handleSignOut}
            >
              <LogOut className="h-4 w-4" /> Sair
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-4 border-b border-border bg-card px-6 py-3">
            <HeaderSelect
              label="Unidade"
              value={unit?.id}
              onChange={planning.setUnitId}
              options={visibleUnits.map((u) => ({ value: u.id, label: u.name }))}
            />
            <HeaderSelect
              label="Versão"
              value={version?.id}
              onChange={planning.setVersionId}
              options={(versions ?? []).map((v) => ({ value: v.id, label: v.name }))}
            />
            <HeaderSelect
              label="Cenário"
              value={scenario?.id}
              onChange={planning.setScenarioId}
              options={scenarios.map((s) => ({
                value: s.id,
                label: s.name + (s.is_official ? " (oficial)" : ""),
              }))}
            />
            <div className="ml-auto flex items-center gap-2">
              <Badge variant={submissionStatus === "aprovado" ? "default" : "secondary"}>
                {SUBMISSION_LABELS[submissionStatus]}
              </Badge>
              {canSend && (
                <Button size="sm" className="gap-1.5" onClick={() => setConfirmSend(true)}>
                  <Send className="h-4 w-4" /> Enviar para aprovação
                </Button>
              )}
            </div>
          </header>
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </div>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enviar {unit?.name} para aprovação?</AlertDialogTitle>
            <AlertDialogDescription>
              Depois de enviar, os lançamentos da unidade ficam bloqueados até o financeiro aprovar
              ou devolver para ajuste.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unit && version && setUnitStatus(version.id, unit.id, "enviado")}
            >
              Enviar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PlanningProvider>
  );
}

function HeaderSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Selecione" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
