import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

async function assertFinanceiro(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "financeiro" });
  if (!data) throw new Error("Apenas o financeiro pode gerenciar usuários.");
}

export const listUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, never>) => input)
  .handler(async ({ context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: authUsers, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw error;

    const [profiles, roles, units, allUnits] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, full_name"),
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin.from("user_units").select("user_id, unit_id"),
      supabaseAdmin.from("units").select("id, name").order("name"),
    ]);

    return {
      units: allUnits.data ?? [],
      users: authUsers.users.map((u) => ({
        id: u.id,
        email: u.email ?? "",
        fullName: profiles.data?.find((p) => p.id === u.id)?.full_name ?? "",
        roles: (roles.data ?? []).filter((r) => r.user_id === u.id).map((r) => r.role),
        unitIds: (units.data ?? []).filter((x) => x.user_id === u.id).map((x) => x.unit_id),
      })),
    };
  });

interface InviteInput {
  email: string;
  password: string;
  fullName: string;
  role: "financeiro" | "vp" | "ceo" | "lider";
  unitIds: string[];
}

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: InviteInput) => input)
  .handler(async ({ data, context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName },
    });
    if (error) throw error;

    const userId = created.user.id;
    const { error: roleError } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: data.role });
    if (roleError) throw roleError;

    if (data.unitIds.length > 0) {
      const { error: unitsError } = await supabaseAdmin
        .from("user_units")
        .insert(data.unitIds.map((unit_id) => ({ user_id: userId, unit_id })));
      if (unitsError) throw unitsError;
    }

    return { id: userId };
  });
