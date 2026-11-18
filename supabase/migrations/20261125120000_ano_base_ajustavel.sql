-- Ano base (o ano anterior ao plano) ajustável pelo financeiro: o total do ano de uma categoria na unidade substitui o
-- que veio do Omie, repartido pelos meses na proporção do Omie (sem Omie, igual). Vale para a comparação na grade,
-- "Trazer valores", fornecedores e a base do limite ("Calcular com o realizado").

CREATE TABLE public.reference_adjustments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  note TEXT,
  updated_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, unit_id, account_id)
);
COMMENT ON TABLE public.reference_adjustments IS
  'Total do ano base corrigido pelo financeiro, por unidade e conta, no lugar do Omie.';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reference_adjustments TO authenticated;
GRANT ALL ON public.reference_adjustments TO service_role;
ALTER TABLE public.reference_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read reference_adjustments by unit" ON public.reference_adjustments FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes reference_adjustments" ON public.reference_adjustments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_reference_adjustments AFTER INSERT OR UPDATE OR DELETE ON public.reference_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_reference_adjustments BEFORE UPDATE ON public.reference_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- O ano base como veio do Omie fica com outro nome; reference_rows passa a aplicar os ajustes.
ALTER FUNCTION public.reference_rows(INT) RENAME TO reference_rows_omie;

CREATE FUNCTION public.reference_rows(_year INT)
RETURNS TABLE (unit_id UUID, account_id UUID, kind TEXT, month INT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH o AS MATERIALIZED (SELECT * FROM public.reference_rows_omie(_year)),
  adj AS (
    SELECT r.unit_id, r.account_id, a.kind, r.amount,
      (SELECT SUM(o.amount) FROM o WHERE o.unit_id = r.unit_id AND o.account_id = r.account_id) AS omie
    FROM public.reference_adjustments r JOIN public.accounts a ON a.id = r.account_id
    WHERE r.year = _year
  ),
  spread AS (
    SELECT adj.unit_id, adj.account_id, adj.kind, k AS month, adj.amount AS total,
      round(CASE WHEN COALESCE(adj.omie, 0) <> 0
        THEN adj.amount * COALESCE((SELECT o.amount FROM o WHERE o.unit_id = adj.unit_id
               AND o.account_id = adj.account_id AND o.month = k), 0) / adj.omie
        ELSE adj.amount / 12 END, 2) AS amount
    FROM adj CROSS JOIN generate_series(1, 12) k
  )
  SELECT o.unit_id, o.account_id, o.kind, o.month, o.amount FROM o
  WHERE NOT EXISTS (SELECT 1 FROM adj WHERE adj.unit_id = o.unit_id AND adj.account_id = o.account_id)
  UNION ALL
  -- Os centavos do arredondamento ficam em dezembro, para o ano somar o total ajustado.
  SELECT s.unit_id, s.account_id, s.kind, s.month,
    CASE WHEN s.month = 12
      THEN s.total - (SELECT SUM(x.amount) FROM spread x WHERE x.unit_id = s.unit_id AND x.account_id = s.account_id
                      AND x.month < 12)
      ELSE s.amount END
  FROM spread s
  WHERE s.total <> 0
$$;
REVOKE EXECUTE ON FUNCTION public.reference_rows(INT) FROM PUBLIC, anon, authenticated;

-- Total do Omie por conta no ano base da unidade, para a tela mostrar ao lado do valor ajustado.
CREATE FUNCTION public.unit_reference_omie(_version_id UUID, _unit_id UUID)
RETURNS TABLE (account_id UUID, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.account_id, SUM(r.amount)
  FROM public.budget_versions bv
  CROSS JOIN LATERAL public.reference_rows_omie(bv.year - 1) r
  WHERE bv.id = _version_id AND r.unit_id = _unit_id AND public.has_unit(auth.uid(), _unit_id)
  GROUP BY r.account_id
$$;
REVOKE EXECUTE ON FUNCTION public.unit_reference_omie(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_reference_omie(UUID, UUID) TO authenticated;
