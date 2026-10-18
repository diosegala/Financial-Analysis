import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CUPOLA — Planejamento Financeiro 2027" },
      { name: "description", content: "Planejamento financeiro CUPOLA 2027: receitas, folha, despesas, cenários e DRE prevista por unidade." },
      { property: "og:title", content: "CUPOLA — Planejamento Financeiro 2027" },
      { property: "og:description", content: "Planejamento financeiro CUPOLA 2027: receitas, folha, despesas, cenários e DRE prevista por unidade." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      navigate({ to: data.user ? "/inicio" : "/auth", replace: true });
    });
  }, [navigate]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">Carregando…</p>
    </div>
  );
}
