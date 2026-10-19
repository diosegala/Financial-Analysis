import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/auditoria")({
  head: () => ({
    meta: [
      { title: "Auditoria — CUPOLA Planejamento Financeiro" },
      { name: "description", content: "Registro de quem alterou o quê e quando." },
      { property: "og:title", content: "Auditoria — CUPOLA Planejamento Financeiro" },
      { property: "og:description", content: "Registro de quem alterou o quê e quando." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuditoriaPage,
});

const TABLE_LABELS: Record<string, string> = {
  plan_lines: "Linhas de lançamento",
  plan_values: "Valores mensais",
  people: "Pessoas",
  salary_changes: "Reajustes",
  events: "Eventos",
  parameter_values: "Valores de parâmetros",
  parameter_definitions: "Parâmetros",
  calc_rules: "Regras de cálculo",
  scenarios: "Cenários",
  budget_versions: "Versões",
  unit_submissions: "Envio e aprovação",
  units: "Unidades",
  dre_lines: "Estrutura da DRE",
  accounts: "Plano de contas",
  revenue_types: "Tipos de receita",
  contract_types: "Vínculos",
  products: "Produtos",
  clients: "Clientes",
  user_roles: "Perfis de usuário",
  user_units: "Unidades de usuário",
  // Tabelas da Fase 0 (registros antigos)
  revenue_entries: "Receitas",
  payroll_entries: "Folha",
  expense_entries: "Despesas",
  expense_categories: "Categorias de despesa",
  parameters: "Parâmetros",
};

const ACTION_LABELS: Record<string, string> = {
  insert: "criação",
  update: "alteração",
  delete: "exclusão",
};

interface Row {
  [field: string]: unknown;
  client_name?: unknown;
  description?: unknown;
  label?: unknown;
  status?: unknown;
  product_name?: unknown;
  name?: unknown;
  key?: unknown;
  month?: unknown;
  amount?: unknown;
  value?: unknown;
}

function asRow(v: unknown): Row | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
}

function summarize(action: string, oldJson: unknown, newJson: unknown): string {
  const oldData = asRow(oldJson);
  const newData = asRow(newJson);
  const d: Row = newData ?? oldData ?? {};
  if (action === "update" && oldData && newData) {
    const changes = Object.keys(newData).filter(
      (k) =>
        !["updated_at", "created_at", "id", "created_by"].includes(k) &&
        JSON.stringify(oldData[k]) !== JSON.stringify(newData[k]),
    );
    if (changes.length > 0) {
      return changes.map((k) => `${k}: ${String(oldData[k])} → ${String(newData[k])}`).join("; ");
    }
  }
  const parts = [
    d.client_name,
    d.description,
    d.label,
    d.status,
    d.product_name,
    d.name,
    d.key,
    d.month != null ? `mês ${d.month}` : null,
    d.amount != null ? `valor ${d.amount}` : null,
    d.value != null ? `valor ${d.value}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function AuditoriaPage() {
  const { data: user, isLoading: loadingUser } = useCurrentUser();

  const { data: rows, isLoading } = useQuery({
    queryKey: ["audit"],
    enabled: !!user?.isManagement,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_log")
        .select("id, table_name, action, old_data, new_data, created_at, changed_by")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const ids = [...new Set((data ?? []).map((r) => r.changed_by).filter(Boolean))] as string[];
      const profiles = ids.length
        ? ((await supabase.from("profiles").select("id, full_name").in("id", ids)).data ?? [])
        : [];
      const nameOf = new Map(profiles.map((p) => [p.id, p.full_name]));
      return (data ?? []).map((r) => ({
        ...r,
        who: r.changed_by ? (nameOf.get(r.changed_by) ?? "Usuário") : "Sistema",
      }));
    },
  });

  if (!loadingUser && user && !user.isManagement) {
    return <Navigate to="/inicio" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Auditoria</h1>
        <p className="text-sm text-muted-foreground">
          Quem alterou o quê e quando (últimos 200 registros).
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Quem</th>
                <th className="px-3 py-2 font-medium">Onde</th>
                <th className="px-3 py-2 font-medium">Ação</th>
                <th className="px-3 py-2 font-medium">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                    {new Date(r.created_at).toLocaleString("pt-BR")}
                  </td>
                  <td className="px-3 py-1.5 font-medium">{r.who}</td>
                  <td className="px-3 py-1.5">{TABLE_LABELS[r.table_name] ?? r.table_name}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={r.action === "delete" ? "destructive" : "secondary"}>
                      {ACTION_LABELS[r.action] ?? r.action}
                    </Badge>
                  </td>
                  <td className="max-w-md truncate px-3 py-1.5 font-mono text-xs text-muted-foreground">
                    {summarize(r.action, r.old_data, r.new_data)}
                  </td>
                </tr>
              ))}
              {(rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    Nenhuma alteração registrada ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
