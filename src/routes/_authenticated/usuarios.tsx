import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { pageHead } from "@/lib/head";
import { useCurrentUser } from "@/lib/auth";
import { inviteUser, listUsers, setUserActive, updateUserAccess } from "@/lib/users.functions";
import { PageHeader } from "@/components/page-header";
import { Field, OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/usuarios")({
  head: pageHead("Usuários", "Convite de usuários e definição de perfis e unidades."),
  component: UsuariosPage,
});

const ROLES = [
  { value: "financeiro", label: "Financeiro (administrador)" },
  { value: "vp", label: "VP (leitura)" },
  { value: "ceo", label: "CEO (leitura)" },
  { value: "lider", label: "Líder de unidade" },
] as const;
type Role = (typeof ROLES)[number]["value"];
const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

type UserRow = Awaited<ReturnType<typeof listUsers>>["users"][number];

const errorText = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    // Erros de validação (zod) chegam como JSON.
    const parsed = JSON.parse(msg) as { message?: string }[];
    return parsed[0]?.message ?? msg;
  } catch {
    return msg;
  }
};

function UsuariosPage() {
  const { data: currentUser, isLoading: loadingUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<UserRow | "new" | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["users-list"],
    enabled: !!currentUser?.isFinanceiro,
    queryFn: () => listUsers({ data: {} }),
  });

  if (!loadingUser && currentUser && !currentUser.isFinanceiro) return <Navigate to="/inicio" />;

  const unitName = (id: string) => data?.units.find((u) => u.id === id)?.name ?? "";

  async function toggleActive(u: UserRow) {
    try {
      await setUserActive({ data: { userId: u.id, active: !u.active } });
      toast.success(u.active ? "Acesso desativado." : "Acesso reativado.");
      await queryClient.invalidateQueries({ queryKey: ["users-list"] });
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usuários"
        subtitle="Cadastre o e-mail da pessoa, o perfil e as unidades. Ela entra com a conta Google desse e-mail. Sempre precisa existir pelo menos um financeiro ativo."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setDialog("new")}>
            <Plus className="h-4 w-4" /> Dar acesso
          </Button>
        }
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">E-mail</th>
                <th className="px-3 py-2 font-medium">Perfil</th>
                <th className="px-3 py-2 font-medium">Unidades</th>
                <th className="px-3 py-2 font-medium">Situação</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map((u) => (
                <tr
                  key={u.id}
                  className={`border-b border-border last:border-0 ${u.active ? "" : "opacity-50"}`}
                >
                  <td className="px-3 py-1.5 font-medium">{u.fullName || "—"}</td>
                  <td className="px-3 py-1.5">{u.email}</td>
                  <td className="px-3 py-1.5">
                    {u.roles.map((r) => (
                      <Badge key={r} variant="secondary" className="mr-1">
                        {ROLE_LABELS[r] ?? r}
                      </Badge>
                    ))}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {u.unitIds.length > 0 ? u.unitIds.map(unitName).join(", ") : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {!u.active ? (
                      <Badge variant="outline">Inativo</Badge>
                    ) : u.invitedPending ? (
                      <Badge variant="outline">Nunca entrou</Badge>
                    ) : (
                      <Badge variant="secondary">Ativo</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setDialog(u)}>
                      Editar acesso
                    </Button>
                    {u.id !== currentUser?.id && (
                      <Button variant="ghost" size="sm" onClick={() => toggleActive(u)}>
                        {u.active ? "Desativar" : "Reativar"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog && data && (
        <UserDialog
          user={dialog === "new" ? null : dialog}
          units={data.units}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function UserDialog({
  user,
  units,
  onClose,
}: {
  user: UserRow | null;
  units: { id: string; name: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>((user?.roles[0] as Role | undefined) ?? "lider");
  const [unitIds, setUnitIds] = useState<string[]>(user?.unitIds ?? []);
  const [mode, setMode] = useState<"google" | "senha">("google");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      if (user) {
        await updateUserAccess({ data: { userId: user.id, fullName, role, unitIds } });
        toast.success("Acesso atualizado.");
      } else {
        await inviteUser({
          data: {
            email,
            fullName,
            role,
            unitIds,
            password: mode === "senha" ? password : undefined,
          },
        });
        toast.success(
          mode === "google"
            ? `Acesso criado. ${email} já pode entrar com o Google.`
            : "Acesso criado. A pessoa já pode entrar com a senha informada.",
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["users-list"] });
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const valid =
    fullName.trim() !== "" &&
    (user || /.+@.+\..+/.test(email)) &&
    (role !== "lider" || unitIds.length > 0) &&
    (user || mode === "google" || password.length >= 8);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {user ? `Acesso de ${user.fullName || user.email}` : "Dar acesso"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Nome completo">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          {!user && (
            <Field label="E-mail">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          )}
          <Field label="Perfil">
            <OptionSelect
              value={role}
              onChange={(v) => setRole((v as Role) ?? "lider")}
              options={[...ROLES]}
            />
          </Field>
          {role === "lider" && (
            <Field label="Unidades do líder">
              <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border p-2">
                {units.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={unitIds.includes(u.id)}
                      onCheckedChange={(c) =>
                        setUnitIds((prev) => (c ? [...prev, u.id] : prev.filter((x) => x !== u.id)))
                      }
                    />
                    {u.name}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {!user && (
            <>
              <Field label="Como dar o acesso">
                <OptionSelect
                  value={mode}
                  onChange={(v) => setMode((v as "google" | "senha") ?? "google")}
                  options={[
                    { value: "google", label: "Entra com a conta Google (recomendado)" },
                    { value: "senha", label: "Sem conta Google: definir uma senha inicial" },
                  ]}
                />
              </Field>
              {mode === "senha" && (
                <Field
                  label="Senha inicial"
                  hint="Mínimo de 8 caracteres. Peça para a pessoa trocar no primeiro acesso."
                >
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? "Salvando…" : user ? "Salvar" : "Dar acesso"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
