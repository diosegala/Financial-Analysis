import { createFileRoute, Navigate } from "@tanstack/react-router";

// Agora é um passo do Planejamento.
export const Route = createFileRoute("/_authenticated/despesas")({
  component: () => <Navigate to="/planejamento" search={(prev: Record<string, unknown>) => prev} />,
});
