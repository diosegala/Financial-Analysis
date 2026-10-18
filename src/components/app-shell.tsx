import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { usePlanning } from "@/lib/planning";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";

const NAV = [
  { to: "/inicio", label: "Início", icon: LayoutDashboard },
  { to: "/receitas", label: "Receitas", icon: TrendingUp },
  { to: "/folha", label: "Folha", icon: Users },
  { to: "/despesas", label: "Despesas", icon: Receipt },
  { to: "/dre", label: "DRE prevista", icon: FileBarChart },
  { to: "/cenarios", label: "Cenários", icon: Layers },
  { to: "/parametros", label: "Parâmetros", icon: SlidersHorizontal, financeiro: true },
  { to: "/usuarios", label: "Usuários", icon: UserCog, financeiro: true },
  { to: "/auditoria", label: "Auditoria", icon: History, management: true },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const planning = usePlanning();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const { data: units } = useQuery({
    queryKey: ["units"],
    queryFn: async () => (await supabase.from("units").select("id, name, kind").order("name")).data ?? [],
  });

  const { data: scenarios } = useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => (await supabase.from("scenarios").select("id, name, is_official").order("name")).data ?? [],
  });

  const visibleUnits = user?.isManagement
    ? (units ?? [])
    : (units ?? []).filter((u) => user?.unitIds.includes(u.id));

  const unitId = planning.unitId ?? visibleUnits[0]?.id ?? null;
  const scenarioId =
    planning.scenarioId ?? scenarios?.find((s) => s.is_official)?.id ?? scenarios?.[0]?.id ?? null;

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="border-b border-sidebar-border px-5 py-4">
          <div className="text-lg font-bold tracking-tight text-foreground">CUPOLA</div>
          <div className="text-xs text-muted-foreground">Planejamento financeiro {planning.year}</div>
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
          <div className="truncate px-1 text-sm font-medium text-foreground">{user?.fullName}</div>
          <div className="truncate px-1 text-xs text-muted-foreground">{user?.email}</div>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start gap-2" onClick={handleSignOut}>
            <LogOut className="h-4 w-4" /> Sair
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-border bg-card px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Unidade</span>
            <Select value={unitId ?? undefined} onValueChange={planning.setUnitId}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {visibleUnits.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Cenário</span>
            <Select value={scenarioId ?? undefined} onValueChange={planning.setScenarioId}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {(scenarios ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.is_official ? " (oficial)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-sm text-muted-foreground">Ano {planning.year}</div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <PlanningSetter unitId={unitId} scenarioId={scenarioId} />
          {children}
        </main>
      </div>
    </div>
  );
}

// Keeps the context in sync with the effective defaults shown in the selectors.
function PlanningSetter({ unitId, scenarioId }: { unitId: string | null; scenarioId: string | null }) {
  const planning = usePlanning();
  if (unitId && planning.unitId !== unitId) planning.setUnitId(unitId);
  if (scenarioId && planning.scenarioId !== scenarioId) planning.setScenarioId(scenarioId);
  return null;
}
