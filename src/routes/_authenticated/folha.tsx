import { createFileRoute, Navigate } from "@tanstack/react-router";

// A Folha agora é o passo Pessoas do Planejamento.
export const Route = createFileRoute("/_authenticated/folha")({
  component: () => <Navigate to="/planejamento" search={(prev: Record<string, unknown>) => prev} />,
});
