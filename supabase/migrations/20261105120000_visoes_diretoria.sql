-- Visões da diretoria: receita recorrente × variável e resultado por unidade com e sem o rateio das áreas de apoio.

-- Natureza da receita. Vale, nesta ordem: o tipo de receita da linha, a linha do produto, a origem (carteira e
-- renovação são contratos que já existem) e, por fim, variável. Os dois cadastros são editáveis.
ALTER TABLE public.revenue_types ADD COLUMN nature TEXT CHECK (nature IN ('recorrente', 'variavel'));
ALTER TABLE public.product_lines ADD COLUMN nature TEXT CHECK (nature IN ('recorrente', 'variavel'));

UPDATE public.revenue_types SET nature = CASE WHEN recurrence_months IS NOT NULL THEN 'recorrente' ELSE 'variavel' END;
UPDATE public.product_lines SET nature = CASE WHEN name IN ('Consultoria recorrente', 'Fee mensal', 'Comunidade')
  THEN 'recorrente' ELSE 'variavel' END;

-- Receita planejada por natureza, com a variação de receita do cenário (a mesma base da DRE).
-- Roda com as permissões de quem consulta.
CREATE FUNCTION public.revenue_by_nature(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, nature TEXT, month INT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(revenue_variation, 0) AS rv FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  )
  SELECT l.unit_id,
    COALESCE(rt.nature, pl.nature,
      CASE WHEN l.revenue_origin IN ('carteira', 'renovacao') THEN 'recorrente' END, 'variavel'),
    v.month, SUM(v.amount * (1 + s.rv))
  FROM public.plan_lines l
  JOIN public.accounts a ON a.id = l.account_id AND a.kind = 'receita'
  JOIN public.plan_values v ON v.line_id = l.id
  CROSS JOIN s
  LEFT JOIN public.revenue_types rt ON rt.id = l.revenue_type_id
  LEFT JOIN public.events e ON e.id = l.event_id
  LEFT JOIN public.products p ON p.id = COALESCE(l.product_id, e.product_id)
  LEFT JOIN public.product_lines pl ON pl.id = p.line_id
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  GROUP BY 1, 2, 3
$$;
REVOKE EXECUTE ON FUNCTION public.revenue_by_nature(UUID, UUID, UUID[]) FROM anon;

-- Quanto do custo das áreas de apoio cada unidade de negócio recebe no rateio, por cenário.
-- Sem linhas no cenário, o app usa a participação na meta e, sem meta, a receita planejada.
CREATE TABLE public.support_shares (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- a auditoria registra pelo id
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  share NUMERIC NOT NULL CHECK (share >= 0 AND share <= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, unit_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_shares TO authenticated;
GRANT ALL ON public.support_shares TO service_role;
ALTER TABLE public.support_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Management reads support_shares" ON public.support_shares FOR SELECT TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[]));
CREATE POLICY "Financeiro writes support_shares" ON public.support_shares FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_support_shares AFTER INSERT OR UPDATE OR DELETE ON public.support_shares
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_support_shares BEFORE UPDATE ON public.support_shares
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
