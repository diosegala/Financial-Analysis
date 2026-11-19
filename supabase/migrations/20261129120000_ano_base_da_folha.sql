-- Ano base da folha corrigível: o financeiro digita o valor de "Pessoas e benefícios" na coluna do ano base. Ele vale no
-- lugar da foto tirada em "Calcular com o realizado" (que continua guardada e volta quando o valor é apagado), na base e
-- no limite da folha, na hora. Recalcular não mexe no valor digitado.
ALTER TABLE public.guardrail_units ADD COLUMN base_payroll_typed NUMERIC;
COMMENT ON COLUMN public.guardrail_units.base_payroll_typed IS
  'Folha do ano base digitada pelo financeiro; NULL segue a foto (base_payroll).';

DROP FUNCTION public.guardrails(UUID);
CREATE FUNCTION public.guardrails(_scenario_id UUID)
RETURNS TABLE (unit_id UUID, kind TEXT, floor_suggested NUMERIC, floor_amount NUMERIC, variable_rate NUMERIC,
  floor_net NUMERIC, base_expense NUMERIC, base_payroll NUMERIC, base_payroll_auto NUMERIC, expense_limit_auto NUMERIC, payroll_limit_auto NUMERIC,
  expense_limit NUMERIC, payroll_limit NUMERIC, ceiling NUMERIC, planned_revenue NUMERIC, planned_variable NUMERIC, planned_expense NUMERIC, planned_payroll NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  st public.guardrail_settings%ROWTYPE;
  _version UUID;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT s.version_id INTO _version FROM public.scenarios s WHERE s.id = _scenario_id;
  SELECT * INTO st FROM public.guardrail_settings g WHERE g.scenario_id = _scenario_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
     AND st.published_at IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH plan AS (
    SELECT p.unit_id,
      SUM(p.amount) FILTER (WHERE p.bucket = 'receita') AS revenue,
      SUM(p.amount) FILTER (WHERE p.bucket = 'variavel') AS variable,
      SUM(p.amount) FILTER (WHERE p.bucket = 'despesa') AS expense,
      SUM(p.amount) FILTER (WHERE p.bucket = 'folha') AS payroll
    FROM public.plan_split(_version, _scenario_id) p GROUP BY p.unit_id
  ),
  b AS (
    SELECT u.id, u.kind, g.floor_amount AS floor_typed, g.expense_limit AS expense_typed, g.payroll_limit AS payroll_typed,
      COALESCE(g.base_expense, 0) AS base_expense,
      COALESCE(g.base_payroll_typed, g.base_payroll, 0) AS base_payroll, COALESCE(g.base_payroll, 0) AS base_payroll_auto,
      (COALESCE(g.floor_actual, 0) + COALESCE(g.floor_projected, 0)) * (1 + st.floor_adjust_pct) AS floor_sugg,
      COALESCE(pl.revenue, 0) AS revenue, COALESCE(pl.variable, 0) AS variable,
      COALESCE(pl.expense, 0) AS expense, COALESCE(pl.payroll, 0) AS payroll,
      public.unit_variable_rate(_scenario_id, u.id) AS vrate
    FROM public.units u
    LEFT JOIN public.guardrail_units g ON g.scenario_id = _scenario_id AND g.unit_id = u.id
    LEFT JOIN plan pl ON pl.unit_id = u.id
    WHERE u.active
  )
  SELECT b.id, b.kind,
    CASE WHEN b.kind = 'negocio' THEN b.floor_sugg END,
    CASE WHEN b.kind = 'negocio' THEN COALESCE(b.floor_typed, b.floor_sugg) END,
    b.vrate,
    CASE WHEN b.kind = 'negocio' THEN COALESCE(b.floor_typed, b.floor_sugg) * (1 - b.vrate) END,
    b.base_expense, b.base_payroll, b.base_payroll_auto,
    b.base_expense * (1 - st.cost_cut_pct), b.base_payroll * (1 - st.cost_cut_pct),
    COALESCE(b.expense_typed, b.base_expense * (1 - st.cost_cut_pct)),
    COALESCE(b.payroll_typed, b.base_payroll * (1 - st.cost_cut_pct)),
    COALESCE(b.expense_typed, b.base_expense * (1 - st.cost_cut_pct))
      + COALESCE(b.payroll_typed, b.base_payroll * (1 - st.cost_cut_pct)),
    b.revenue, b.variable, b.expense, b.payroll
  FROM b
  WHERE public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
     OR public.has_unit(auth.uid(), b.id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guardrails(UUID) FROM anon;
