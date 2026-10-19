import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

const ROLES = ["financeiro", "vp", "ceo", "lider"] as const;
type Admin = SupabaseClient<Database>;

async function assertFinanceiro(supabase: SupabaseClient<Database>, userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "financeiro" });
  if (!data) throw new Error("Apenas o financeiro pode gerenciar usuários.");
}

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Ids of active (not banned) users with the financeiro role. */
async function activeFinanceiros(db: Admin): Promise<string[]> {
  const { data: roles } = await db.from("user_roles").select("user_id").eq("role", "financeiro");
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  const banned = new Set(
    (users?.users ?? [])
      .filter((u) => u.banned_until && new Date(u.banned_until) > new Date())
      .map((u) => u.id),
  );
  return (roles ?? []).map((r) => r.user_id).filter((id) => !banned.has(id));
}

async function setAccess(
  db: Admin,
  userId: string,
  role: (typeof ROLES)[number],
  unitIds: string[],
) {
  const { error: roleError } = await db
    .from("user_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id,role" });
  if (roleError) throw roleError;
  const { error: delError } = await db
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .neq("role", role);
  if (delError) throw delError;
  await db.from("user_units").delete().eq("user_id", userId);
  if (role === "lider" && unitIds.length > 0) {
    const { error } = await db
      .from("user_units")
      .insert(unitIds.map((unit_id) => ({ user_id: userId, unit_id })));
    if (error) throw error;
  }
}

export const listUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, never>) => input)
  .handler(async ({ context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    const db = await admin();
    const { data: authUsers, error } = await db.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const [profiles, roles, units, allUnits] = await Promise.all([
      db.from("profiles").select("id, full_name"),
      db.from("user_roles").select("user_id, role"),
      db.from("user_units").select("user_id, unit_id"),
      db.from("units").select("id, name").eq("active", true).order("sort_order").order("name"),
    ]);
    return {
      units: allUnits.data ?? [],
      users: authUsers.users.map((u) => ({
        id: u.id,
        email: u.email ?? "",
        fullName: profiles.data?.find((p) => p.id === u.id)?.full_name ?? "",
        roles: (roles.data ?? []).filter((r) => r.user_id === u.id).map((r) => r.role),
        unitIds: (units.data ?? []).filter((x) => x.user_id === u.id).map((x) => x.unit_id),
        active: !(u.banned_until && new Date(u.banned_until) > new Date()),
        invitedPending: !u.last_sign_in_at,
      })),
    };
  });

const inviteSchema = z.object({
  email: z.string().trim().email("E-mail inválido."),
  fullName: z.string().trim().min(1, "Informe o nome."),
  role: z.enum(ROLES),
  unitIds: z.array(z.string().uuid()),
  /** Sem senha: a pessoa entra com a conta Google do mesmo e-mail. Com senha: entra com e-mail e senha. */
  password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres.").optional(),
});

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.input<typeof inviteSchema>) => inviteSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    const db = await admin();
    const meta = { full_name: data.fullName };
    // E-mail já confirmado: no primeiro login com Google, o Supabase liga a conta Google a este usuário.
    const { data: created, error } = await db.auth.admin.createUser({
      email: data.email,
      email_confirm: true,
      user_metadata: meta,
      ...(data.password ? { password: data.password } : {}),
    });
    if (error) throw error;
    try {
      await setAccess(db, created.user.id, data.role, data.unitIds);
    } catch (e) {
      // Sem perfil o usuário não teria acesso a nada: desfaz a criação.
      await db.auth.admin.deleteUser(created.user.id);
      throw e;
    }
    return { id: created.user.id };
  });

const accessSchema = z.object({
  userId: z.string().uuid(),
  fullName: z.string().trim().min(1, "Informe o nome."),
  role: z.enum(ROLES),
  unitIds: z.array(z.string().uuid()),
});

export const updateUserAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.input<typeof accessSchema>) => accessSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    const db = await admin();
    if (data.role !== "financeiro") {
      const fins = await activeFinanceiros(db);
      if (fins.length === 1 && fins[0] === data.userId)
        throw new Error(
          "Este é o último usuário financeiro ativo. Cadastre outro financeiro antes de mudar este perfil.",
        );
    }
    await setAccess(db, data.userId, data.role, data.unitIds);
    await db.from("profiles").update({ full_name: data.fullName }).eq("id", data.userId);
    await db.auth.admin.updateUserById(data.userId, {
      user_metadata: { full_name: data.fullName },
    });
    return { ok: true };
  });

const activeSchema = z.object({ userId: z.string().uuid(), active: z.boolean() });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: z.input<typeof activeSchema>) => activeSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertFinanceiro(context.supabase, context.userId);
    if (!data.active && data.userId === context.userId)
      throw new Error("Você não pode desativar o próprio acesso.");
    const db = await admin();
    if (!data.active) {
      const fins = await activeFinanceiros(db);
      if (fins.length === 1 && fins[0] === data.userId)
        throw new Error("Este é o último usuário financeiro ativo e não pode ser desativado.");
    }
    const { error } = await db.auth.admin.updateUserById(data.userId, {
      ban_duration: data.active ? "none" : "876000h",
    });
    if (error) throw error;
    return { ok: true };
  });
