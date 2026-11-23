-- O limite de despesas segue o ano base da tela na hora: a base é a soma das despesas do ano base (Omie com as correções
-- do financeiro), não mais a foto tirada em "Calcular com o realizado". Assim o limite do total é a soma dos limites das
-- categorias, e corrigir um valor do ano base muda o limite na hora. O limite digitado continua valendo no lugar.
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
  _base_year INT;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT s.version_id, bv.year - 1 INTO _version, _base_year
  FROM public.scenarios s JOIN public.budget_versions bv ON bv.id = s.version_id WHERE s.id = _scenario_id;
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
  ref AS (
    SELECT r.unit_id, SUM(r.amount) AS expense
    FROM public.reference_rows(_base_year) r WHERE r.kind = 'despesa' GROUP BY r.unit_id
  ),
  b AS (
    SELECT u.id, u.kind, g.floor_amount AS floor_typed, g.expense_limit AS expense_typed, g.payroll_limit AS payroll_typed,
      -- Antes do primeiro cálculo não há limite: a base fica zerada, como antes.
      CASE WHEN st.suggested_at IS NULL THEN COALESCE(g.base_expense, 0) ELSE COALESCE(rf.expense, 0) END AS base_expense,
      COALESCE(g.base_payroll_typed, g.base_payroll, 0) AS base_payroll, COALESCE(g.base_payroll, 0) AS base_payroll_auto,
      (COALESCE(g.floor_actual, 0) + COALESCE(g.floor_projected, 0)) * (1 + st.floor_adjust_pct) AS floor_sugg,
      COALESCE(pl.revenue, 0) AS revenue, COALESCE(pl.variable, 0) AS variable,
      COALESCE(pl.expense, 0) AS expense, COALESCE(pl.payroll, 0) AS payroll,
      public.unit_variable_rate(_scenario_id, u.id) AS vrate
    FROM public.units u
    LEFT JOIN public.guardrail_units g ON g.scenario_id = _scenario_id AND g.unit_id = u.id
    LEFT JOIN plan pl ON pl.unit_id = u.id
    LEFT JOIN ref rf ON rf.unit_id = u.id
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
