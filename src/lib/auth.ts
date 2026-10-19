import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "financeiro" | "vp" | "ceo" | "lider";

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  roles: AppRole[];
  unitIds: string[];
  isFinanceiro: boolean;
  isCeo: boolean;
  isManagement: boolean; // financeiro, vp ou ceo — veem todas as unidades
  isLider: boolean;
  canWrite: boolean; // lança valores: financeiro ou líder (VP e CEO só leem — D4)
}

async function loadCurrentUser(): Promise<CurrentUser | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;

  const [profileRes, rolesRes, unitsRes] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", user.id),
    supabase.from("user_units").select("unit_id").eq("user_id", user.id),
  ]);

  const roles = (rolesRes.data ?? []).map((r) => r.role as AppRole);
  const isFinanceiro = roles.includes("financeiro");
  const isCeo = roles.includes("ceo");
  const isManagement = isFinanceiro || isCeo || roles.includes("vp");

  return {
    id: user.id,
    email: user.email ?? "",
    fullName: profileRes.data?.full_name ?? user.email ?? "",
    roles,
    unitIds: (unitsRes.data ?? []).map((u) => u.unit_id),
    isFinanceiro,
    isCeo,
    isManagement,
    isLider: roles.includes("lider"),
    canWrite: isFinanceiro || roles.includes("lider"),
  };
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: loadCurrentUser,
    staleTime: 60_000,
  });
}
