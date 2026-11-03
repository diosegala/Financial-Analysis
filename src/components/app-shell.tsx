import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser, type CurrentUser } from "@/lib/auth";
import { useScenarios, useUnits, useVersions, type Version } from "@/lib/catalog";
import { PlanningProvider, type PlanningState } from "@/lib/planning";
import { SUBMISSION_LABELS, useSubmissions, type SubmissionStatus } from "@/lib/submissions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Eye, LayoutDashboard, LineChart, LogOut, Settings } from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Só o financeiro vê. */
  financeiro?: boolean;
  /** Financeiro, VP e CEO veem (o líder não). */
  management?: boolean;
}

// O menu inteiro. Parâmetros, usuários, realizado e auditoria abrem de Configurações.
const NAV_ITEMS: (NavItem & { also?: string[] })[] = [
  { to: "/plano", label: "Plano CUPOLA", icon: LayoutDashboard, management: true },
  { to: "/planejamento", label: "Planejamento", icon: ClipboardList },
  { to: "/acompanhamento", label: "Acompanhamento", icon: LineChart },
  {
    to: "/configuracoes",
    label: "Configurações",
    icon: Settings,
    financeiro: true,
    also: ["/parametros", "/usuarios", "/realizado", "/auditoria"],
  },
];

const VIEW_KEY = "ver.como.diretor";

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
  if (status === "enviado") return "Unidade enviada: aguardando o financeiro.";
  if (status === "aprovado") return "Unidade aprovada.";
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ from: "/_authenticated" });
  const [asDirector, setAsDirector] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "1";
    } catch {
      return false; // sem armazenamento: começa no modo normal
    }
  });
  const directorView = asDirector && !!user?.isFinanceiro;
  const planningPage = pathname.startsWith("/planejamento");
  const unitPage = planningPage || pathname.startsWith("/acompanhamento");
  function chooseView(next: boolean) {
    setAsDirector(next);
    try {
      localStorage.setItem(VIEW_KEY, next ? "1" : "0");
    } catch {
      // sem armazenamento: vale só nesta tela
    }
    navigate({
      to: next ? "/planejamento" : "/plano",
      search: (prev: Record<string, unknown>) => prev,
    });
  }

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
    isAdmin: !!user?.isFinanceiro && !directorView,
    setUnitId: (id) => setSearch({ u: id }),
    setVersionId: (id) => setSearch({ v: id, s: undefined }),
    setScenarioId: (id) => setSearch({ s: id }),
  };

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  // Entrou (ex.: com Google) mas o financeiro ainda não deu perfil ou unidade.
  if (user && units && (user.roles.length === 0 || visibleUnits.length === 0)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md space-y-4 rounded-md border border-border bg-card p-6 text-center">
          <img src="/brand/cupola.png" alt="CUPOLA" className="mx-auto h-9 w-auto" />
          <h1 className="text-lg font-semibold">Seu acesso ainda não foi liberado</h1>
          <p className="text-sm text-muted-foreground">
            Você entrou como <strong>{user.email}</strong>, mas ainda não tem perfil ou unidade no
            planejamento. Peça ao financeiro para liberar o seu acesso.
          </p>
          <Button variant="outline" onClick={handleSignOut} className="gap-2">
            <LogOut className="h-4 w-4" /> Sair
          </Button>
        </div>
      </div>
    );
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
            {NAV_ITEMS.filter((item) =>
              directorView
                ? !item.financeiro && !item.management
                : item.financeiro
                  ? user?.isFinanceiro
                  : item.management
                    ? user?.isManagement
                    : true,
            ).map((item) => {
              const active = [item.to, ...(item.also ?? [])].some((p) => pathname.startsWith(p));
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
            {unitPage && visibleUnits.length > 1 && (
              <HeaderSelect
                label="Unidade"
                value={unit?.id}
                onChange={planning.setUnitId}
                options={visibleUnits.map((u) => ({ value: u.id, label: u.name }))}
              />
            )}
            <div className="ml-auto flex items-center gap-2">
              {planningPage && (
                <Badge variant={submissionStatus === "aprovado" ? "default" : "secondary"}>
                  {SUBMISSION_LABELS[submissionStatus]}
                </Badge>
              )}
              {user?.isFinanceiro && (
                <Button
                  size="sm"
                  variant={directorView ? "default" : "outline"}
                  className="gap-1.5"
                  onClick={() => chooseView(!directorView)}
                >
                  <Eye className="h-4 w-4" />
                  {directorView ? "Voltar ao financeiro" : "Ver como diretor"}
                </Button>
              )}
            </div>
          </header>
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </div>
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
