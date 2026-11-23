-- Comissões e repasses lançados à mão: o financeiro lança mês a mês, por unidade, a comissão de venda e a parte do
-- parceiro (divisão da receita da parceria), em vez de um percentual fixo. As contas marcadas como custo variável:
-- se lançam só pelo financeiro (o diretor vê), entram no custo variável da unidade (como os impostos) e ficam fora do
-- limite de custos.

ALTER TABLE public.accounts ADD COLUMN variable_cost BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.accounts.variable_cost IS
  'Comissão ou repasse: lançado pelo financeiro na tela de Receitas, entra no custo variável e fica fora do limite.';

-- As contas de comissão passam a ser lançadas. As regras de comissão por percentual continuam em Parâmetros, sem valor
-- (calculam zero); cadastrar percentual e lançar a mesma comissão contaria duas vezes.
UPDATE public.accounts a SET treatment = 'lancavel', variable_cost = true
WHERE a.kind = 'despesa' AND a.dre_line_id = (SELECT id FROM public.dre_lines WHERE code = 'comissionamento');

-- Só o financeiro lança nas contas de custo variável.
CREATE FUNCTION public.guard_variable_cost() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _account UUID;
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'financeiro') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'plan_lines' THEN
    _account := COALESCE(NEW.account_id, OLD.account_id);
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.accounts WHERE id = OLD.account_id AND variable_cost) THEN
      _account := OLD.account_id;
    END IF;
  ELSE
    SELECT l.account_id INTO _account FROM public.plan_lines l WHERE l.id = COALESCE(NEW.line_id, OLD.line_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = _account AND variable_cost) THEN
    RAISE EXCEPTION 'Comissões e repasses são lançados pelo financeiro.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER guard_variable_cost_lines BEFORE INSERT OR UPDATE OR DELETE ON public.plan_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_variable_cost();
CREATE TRIGGER guard_variable_cost_values BEFORE INSERT OR UPDATE OR DELETE ON public.plan_values
  FOR EACH ROW EXECUTE FUNCTION public.guard_variable_cost();

-- "Trazer todas as despesas" não traz comissões e repasses.
CREATE OR REPLACE FUNCTION public.load_reference(_version_id UUID, _unit_id UUID, _account_id UUID DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _year INT;
  r RECORD;
  _line UUID;
  _lines INT := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_write_unit(auth.uid(), _unit_id) THEN
    RAISE EXCEPTION 'Você não lança nesta unidade.';
  END IF;
  SELECT year - 1 INTO _year FROM public.budget_versions WHERE id = _version_id;
  CREATE TEMP TABLE IF NOT EXISTS _ref_load (unit_id UUID, account_id UUID, kind TEXT, month INT, amount NUMERIC) ON COMMIT DROP;
  TRUNCATE _ref_load;
  INSERT INTO _ref_load SELECT * FROM public.reference_rows(_year) x WHERE x.unit_id = _unit_id;
  FOR r IN
    SELECT x.account_id FROM _ref_load x
    WHERE x.unit_id = _unit_id AND x.kind = 'despesa' AND (_account_id IS NULL OR x.account_id = _account_id)
      AND (_account_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = x.account_id AND a.variable_cost))
      AND NOT EXISTS (SELECT 1 FROM public.plan_lines l WHERE l.version_id = _version_id AND l.unit_id = _unit_id
                      AND l.account_id = x.account_id)
    GROUP BY x.account_id
  LOOP
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, origin, created_by)
    VALUES (_version_id, _unit_id, r.account_id, 'gerada', auth.uid()) RETURNING id INTO _line;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _line, x.month, x.amount FROM _ref_load x WHERE x.account_id = r.account_id;
    _lines := _lines + 1;
  END LOOP;
  RETURN _lines;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.load_reference(UUID, UUID, UUID) FROM anon;

-- Divisão do plano: comissões e repasses no custo variável (a definição de 20261202120000, com isso).
CREATE OR REPLACE FUNCTION public.plan_split(_version_id uuid, _scenario_id uuid)
 RETURNS TABLE(unit_id uuid, month integer, bucket text, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, NULL)),
  calc AS (
    SELECT b.unit_id, b.month, r.base_kind,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id, b.account_id), 0) AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND (
      (public.rule_matches(r.base_kind, r.payment_component, r.on_provisions, b.row_kind)
       AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
       AND (r.exclude_revenue_type_ids IS NULL
            OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
       AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
       AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids)))
      -- Crédito nas compras: a alíquota do imposto sobre a despesa que gera crédito (base negativa).
      OR (r.credit_on_purchases AND b.row_kind = 'base_credito'))
  )
  SELECT s.unit_id, s.month, s.bucket, SUM(s.amount) FROM (
    SELECT b.unit_id, b.month,
      CASE WHEN b.row_kind = 'despesa' AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = b.account_id AND a.variable_cost)
             THEN 'variavel'
           ELSE CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'receita_planilha' THEN 'receita'
                      WHEN 'deducao' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END END AS bucket, b.amount
    FROM base b
    WHERE b.row_kind IN ('receita', 'receita_planilha', 'deducao', 'despesa', 'folha', 'salario', 'provisao')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$function$;

-- Limite: a base de despesas não tem comissões e repasses (a definição de 20261201130000, com isso).
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
    FROM public.reference_rows(_base_year) r
    WHERE r.kind = 'despesa' AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = r.account_id AND a.variable_cost)
    GROUP BY r.unit_id
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

-- Alíquota variável da unidade: mais as comissões e repasses lançados sobre a receita lançada no ano.
-- SECURITY DEFINER: o peso vem da receita da unidade (plano ou ano base), mas só sai a taxa.
CREATE OR REPLACE FUNCTION public.variable_rate_parts(_unit_id UUID, _ref DATE)
RETURNS TABLE (rule_id UUID, rule_name TEXT, rate NUMERIC, included BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (SELECT count(*) AS total FROM public.revenue_types),
  -- Só procura o peso das categorias quando alguma regra sobre a receita tem valor por categoria.
  by_acc AS (SELECT EXISTS (SELECT 1 FROM public.parameter_values pv JOIN public.calc_rules r
                            ON r.parameter_definition_id = pv.definition_id AND r.active AND r.base_kind = 'receita'
                            WHERE pv.account_id IS NOT NULL) AS yes),
  yr AS (SELECT extract(year FROM _ref)::INT AS y),
  ver AS (SELECT bv.id FROM public.budget_versions bv, yr WHERE bv.year = yr.y ORDER BY bv.created_at DESC LIMIT 1),
  planned AS (
    SELECT l.account_id, SUM(v.amount) AS amount
    FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id JOIN public.accounts a ON a.id = l.account_id
    WHERE (SELECT yes FROM by_acc) AND l.version_id = (SELECT id FROM ver) AND l.unit_id = _unit_id AND a.kind = 'receita'
      AND COALESCE(l.origin, '') NOT IN ('planilha', 'planilha_deducao')
    GROUP BY l.account_id HAVING SUM(v.amount) > 0
  ),
  mix AS (
    SELECT p.account_id, p.amount / SUM(p.amount) OVER () AS w FROM planned p
    UNION ALL
    SELECT r.account_id, SUM(r.amount) / SUM(SUM(r.amount)) OVER () FROM public.reference_rows((SELECT y FROM yr) - 1) r
    WHERE (SELECT yes FROM by_acc) AND NOT EXISTS (SELECT 1 FROM planned) AND r.unit_id = _unit_id AND r.kind = 'receita'
    GROUP BY r.account_id HAVING SUM(r.amount) > 0
  )
  SELECT r.id, r.name,
    CASE WHEN EXISTS (SELECT 1 FROM public.parameter_values pv
                      WHERE pv.definition_id = r.parameter_definition_id AND pv.account_id IS NOT NULL)
              AND EXISTS (SELECT 1 FROM mix)
      THEN (SELECT SUM(m.w * COALESCE(public.param_value(r.parameter_definition_id, _ref, _unit_id, NULL, NULL, NULL,
                                                         m.account_id), 0)) FROM mix m)
      ELSE COALESCE(public.param_value(r.parameter_definition_id, _ref, _unit_id, NULL, NULL, NULL), 0) END,
    CASE WHEN r.revenue_type_ids IS NOT NULL THEN cardinality(r.revenue_type_ids)
         ELSE n.total - COALESCE(cardinality(r.exclude_revenue_type_ids), 0) END * 2 >= n.total
  FROM public.calc_rules r CROSS JOIN n
  WHERE r.active AND r.base_kind = 'receita'
  UNION ALL
  -- Comissões e repasses lançados: o total do ano sobre a receita lançada no ano.
  SELECT NULL::UUID, 'Comissões e repasses lançados',
    COALESCE((SELECT SUM(v.amount) FILTER (WHERE a.variable_cost)
                     / NULLIF(SUM(v.amount) FILTER (WHERE a.kind = 'receita'), 0)
              FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id
              JOIN public.accounts a ON a.id = l.account_id
              WHERE l.version_id = (SELECT id FROM ver) AND l.unit_id = _unit_id), 0),
    true
$$;
REVOKE ALL ON FUNCTION public.variable_rate_parts(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.variable_rate_parts(UUID, DATE) TO authenticated, service_role;
