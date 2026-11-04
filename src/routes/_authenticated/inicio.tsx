import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCurrentUser } from "@/lib/auth";

// Quem acompanha a empresa começa pelo Plano CUPOLA; o diretor, pelo planejamento da unidade.
export const Route = createFileRoute("/_authenticated/inicio")({
  component: function Inicio() {
    const { data: user, isLoading } = useCurrentUser();
    if (isLoading) return null;
    return (
      <Navigate
        to={user?.isManagement ? "/plano" : "/planejamento"}
        search={(prev: Record<string, unknown>) => prev}
      />
    );
  },
});
