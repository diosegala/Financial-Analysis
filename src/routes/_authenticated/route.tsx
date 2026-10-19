import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/app-shell";

/** u = unidade, v = versão, s = cenário. Ficam na URL para o link ser compartilhável. */
export interface PlanningSearch {
  u?: string | undefined;
  v?: string | undefined;
  s?: string | undefined;
}

const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): PlanningSearch => ({
    u: str(search["u"]),
    v: str(search["v"]),
    s: str(search["s"]),
  }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
