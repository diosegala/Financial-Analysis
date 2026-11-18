-- Ordem dos lançamentos na grade, escolhida por quem planeja: grava a posição de cada linha na ordem dada.
-- SECURITY INVOKER: só muda as linhas que o usuário pode editar (RLS de plan_lines).
CREATE FUNCTION public.plan_lines_reorder(_line_ids UUID[]) RETURNS VOID
LANGUAGE sql SET search_path TO 'public' AS $$
  UPDATE public.plan_lines l SET sort_order = x.ord
  FROM unnest(_line_ids) WITH ORDINALITY AS x(id, ord)
  WHERE l.id = x.id AND l.sort_order IS DISTINCT FROM x.ord
$$;
REVOKE ALL ON FUNCTION public.plan_lines_reorder(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_lines_reorder(UUID[]) TO authenticated, service_role;
