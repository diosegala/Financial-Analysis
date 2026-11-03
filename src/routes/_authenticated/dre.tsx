import { createFileRoute, Navigate } from "@tanstack/react-router";

// Agora é um passo do Planejamento.
export const Route = createFileRoute("/_authenticated/dre")({
  component: () => <Navigate to="/planejamento" search={(prev: Record<string, unknown>) => prev} />,
});
