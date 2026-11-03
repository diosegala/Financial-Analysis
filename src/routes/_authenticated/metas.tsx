import { createFileRoute, Navigate } from "@tanstack/react-router";

// Metas e piso e teto viraram o Plano CUPOLA.
export const Route = createFileRoute("/_authenticated/metas")({
  component: () => <Navigate to="/plano" search={(prev: Record<string, unknown>) => prev} />,
});
