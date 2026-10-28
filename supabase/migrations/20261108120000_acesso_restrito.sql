-- Acesso só para quem tem perfil. Login sozinho (alguém do Google da CUPOLA que não foi convidado) não lê nada.

CREATE OR REPLACE FUNCTION public.has_access(_user_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
$$;
REVOKE EXECUTE ON FUNCTION public.has_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_access(UUID) TO authenticated;

-- Cadastros que qualquer usuário logado lia (USING true): passam a exigir um perfil.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND cmd = 'SELECT' AND roles @> '{authenticated}' AND qual = 'true'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I USING (public.has_access(auth.uid()))',
                   p.policyname, p.tablename);
  END LOOP;
END $$;

ALTER POLICY "Leader reads published guardrail_settings" ON public.guardrail_settings
  USING (published_at IS NOT NULL AND public.has_access(auth.uid()));

-- O realizado do Omie por cliente e fornecedor só sai pelas funções que já conferem o perfil
-- (resumos do Omie, carteira, base de despesas, alertas, piso e teto). Chamada direta, não.
REVOKE EXECUTE ON FUNCTION public.omie_revenue_attribution(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.omie_expense_attribution(INTEGER) FROM PUBLIC, anon, authenticated;
