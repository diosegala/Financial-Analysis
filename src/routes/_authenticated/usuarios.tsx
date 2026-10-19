import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/lib/auth";
import { listUsers, inviteUser } from "@/lib/users.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/usuarios")({
  head: () => ({
    meta: [
      { title: "Usuários — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Convite de usuários e definição de perfis e unidades." },
      { property: "og:title", content: "Usuários — CUPOLA Planejamento Financeiro" },
      {
        property: "og:description",
        content: "Convite de usuários e definição de perfis e unidades.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: UsuariosPage,
});

const ROLES = [
  { value: "financeiro", label: "Financeiro" },
  { value: "vp", label: "VP" },
  { value: "ceo", label: "CEO" },
  { value: "lider", label: "Líder de unidade" },
] as const;

const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

function UsuariosPage() {
  const { data: currentUser, isLoading: loadingUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("lider");
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["users-list"],
    enabled: !!currentUser?.isFinanceiro,
    queryFn: () => listUsers({ data: {} }),
  });

  if (!loadingUser && currentUser && !currentUser.isFinanceiro) {
    return <Navigate to="/inicio" />;
  }

  function toggleUnit(id: string) {
    setUnitIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("A senha precisa de pelo menos 6 caracteres.");
      return;
    }
    setSaving(true);
    try {
      await inviteUser({
        data: {
          email,
          password,
          fullName,
          role: role as "financeiro" | "vp" | "ceo" | "lider",
          unitIds,
        },
      });
      toast.success("Usuário criado. Ele já pode entrar com e-mail e senha.");
      setEmail("");
      setPassword("");
      setFullName("");
      setUnitIds([]);
      queryClient.invalidateQueries({ queryKey: ["users-list"] });
    } catch (err) {
      toast.error("Erro ao criar usuário: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  const unitName = (id: string) => data?.units.find((u) => u.id === id)?.name ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usuários</h1>
        <p className="text-sm text-muted-foreground">
          Convide pessoas, defina o perfil e as unidades de cada uma.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-md border border-border bg-card p-4">
        <h2 className="font-semibold">Novo usuário</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Nome completo</Label>
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>E-mail</Label>
            <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Senha inicial</Label>
            <Input
              required
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Perfil</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {role === "lider" && (
          <div className="space-y-1.5">
            <Label>Unidades do líder</Label>
            <div className="flex flex-wrap gap-4 pt-1">
              {(data?.units ?? []).map((u: { id: string; name: string }) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={unitIds.includes(u.id)}
                    onCheckedChange={() => toggleUnit(u.id)}
                  />
                  {u.name}
                </label>
              ))}
            </div>
          </div>
        )}
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5">
          <Plus className="h-4 w-4" /> {saving ? "Criando…" : "Criar usuário"}
        </Button>
      </form>

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
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map(
                (u: {
                  id: string;
                  fullName: string;
                  email: string;
                  roles: string[];
                  unitIds: string[];
                }) => (
                  <tr key={u.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-medium">{u.fullName || "—"}</td>
                    <td className="px-3 py-1.5">{u.email}</td>
                    <td className="px-3 py-1.5">
                      {u.roles.map((r: string) => (
                        <Badge key={r} variant="secondary" className="mr-1">
                          {ROLE_LABELS[r] ?? r}
                        </Badge>
                      ))}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {u.unitIds.length > 0 ? u.unitIds.map(unitName).join(", ") : "—"}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
