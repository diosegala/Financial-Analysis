-- Encargos patronais (INSS patronal, RAT, terceiros, FGTS…) também sobre as provisões de 13º e férias.
-- Cada regra de encargo diz se incide sobre as provisões; a base dela passa a ser remuneração + provisões.
ALTER TABLE public.calc_rules ADD COLUMN on_provisions BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.calc_rules.on_provisions IS
  'Só para regras sobre a remuneração: o encargo incide também sobre as provisões (13º, férias).';
UPDATE public.calc_rules SET on_provisions = true WHERE payroll_group = 'encargo' AND base_kind = 'salario';

-- Soma dos percentuais de provisão que valem para a remuneração de um vínculo, numa conta e numa data.
CREATE OR REPLACE FUNCTION public.provision_rate(_ref DATE, _unit_id UUID, _contract_type_id UUID, _account_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(public.param_value(c.parameter_definition_id, _ref, _unit_id, NULL, _contract_type_id, NULL)), 0)
  FROM public.calc_rules c
  WHERE c.active AND c.payroll_group = 'provisao' AND c.base_kind = 'salario'
    AND (c.contract_type_ids IS NULL OR _contract_type_id = ANY (c.contract_type_ids))
    AND (c.account_ids IS NULL OR _account_id = ANY (c.account_ids))
$$;

CREATE OR REPLACE FUNCTION public.dre_unit_values(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, dre_line_id uuid, month integer, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, _unit_ids)),
  calc AS (
    SELECT b.unit_id, r.target_dre_line_id AS dre_line_id, b.month,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0)
        * CASE WHEN r.on_provisions AND b.row_kind = 'salario'
               THEN 1 + public.provision_rate(make_date(yr.year, b.month, 1), b.unit_id, b.contract_type_id, b.account_id)
               ELSE 1 END AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = b.row_kind
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  ),
  leaf AS (
    SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
    FROM (
      SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b WHERE b.row_kind <> 'headcount'
      UNION ALL
      SELECT c.unit_id, c.dre_line_id, c.month, c.amount FROM calc c
    ) x
    GROUP BY x.unit_id, x.dre_line_id, x.month
  ),
  cells AS (SELECT DISTINCT leaf.unit_id, leaf.month FROM leaf)
  SELECT leaf.unit_id, leaf.dre_line_id, leaf.month, leaf.amount FROM leaf
  UNION ALL
  SELECT c.unit_id, st.id, c.month,
    COALESCE((SELECT SUM(dl.sign * lf.amount) FROM leaf lf JOIN public.dre_lines dl ON dl.id = lf.dre_line_id
              WHERE lf.unit_id = c.unit_id AND lf.month = c.month
                AND dl.kind IN ('lancada', 'calculada') AND dl.sort_order < st.sort_order), 0)
  FROM cells c CROSS JOIN public.dre_lines st
  WHERE st.kind = 'subtotal' AND st.active
$function$;

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
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0)
        * CASE WHEN r.on_provisions AND b.row_kind = 'salario'
               THEN 1 + public.provision_rate(make_date(yr.year, b.month, 1), b.unit_id, b.contract_type_id, b.account_id)
               ELSE 1 END AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = b.row_kind
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  )
  SELECT s.unit_id, s.month, s.bucket, SUM(s.amount) FROM (
    SELECT b.unit_id, b.month,
      CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END AS bucket, b.amount
    FROM base b WHERE b.row_kind IN ('receita', 'despesa', 'folha', 'salario')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$function$;

-- Na Folha, os encargos sobre cada provisão aparecem logo abaixo dela ("Provisão de 13º salário · encargos").
CREATE OR REPLACE FUNCTION public.payroll_detail(_version_id uuid, _scenario_id uuid DEFAULT NULL::uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(person_id uuid, unit_id uuid, month integer, grupo text, item text, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT COALESCE(expense_variation, 0) AS ev, COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ), yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  pm AS (
    SELECT p.id AS person_id, p.unit_id, v.month, p.contract_type_id, p.dependents, l.account_id,
           make_date(yr.year, v.month, 1) AS ref,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.plan_values v ON v.line_id = l.id
    CROSS JOIN s CROSS JOIN yr
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  ), ben AS (
    -- Benefícios lançados por pessoa (assistência médica, vale-transporte…), item a item pela conta.
    SELECT l.benefit_person_id AS person_id, l.unit_id, v.month, a.name AS item,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS amount
    FROM public.plan_lines l
    JOIN public.plan_values v ON v.line_id = l.id
    JOIN public.accounts a ON a.id = l.account_id
    CROSS JOIN s
    WHERE l.version_id = _version_id AND l.benefit_person_id IS NOT NULL
      AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  ), ret AS (
    SELECT pm.*, public.inss_empregado(pm.gross, pm.ref) AS inss FROM pm
  ), ret2 AS (
    SELECT ret.*, public.irrf(ret.gross, ret.inss, ret.dependents, ret.ref) AS ir FROM ret
  ), rules AS (
    SELECT r2.person_id, r2.unit_id, r2.month, r2.ref, r2.contract_type_id, r2.account_id,
      c.payroll_group AS grupo, c.name AS item,
      CASE c.base_kind WHEN 'salario' THEN r2.gross ELSE CASE WHEN r2.gross > 0 THEN 1 ELSE 0 END END
        * COALESCE(public.param_value(c.parameter_definition_id, r2.ref, r2.unit_id, NULL, r2.contract_type_id, NULL), 0) AS amount
    FROM ret2 r2
    JOIN public.calc_rules c ON c.active AND c.base_kind IN ('salario', 'headcount')
      AND (c.contract_type_ids IS NULL OR r2.contract_type_id = ANY (c.contract_type_ids))
      AND (c.account_ids IS NULL OR r2.account_id = ANY (c.account_ids))
  ), prov_enc AS (
    -- Cada provisão × soma dos encargos que incidem sobre as provisões para aquele vínculo.
    SELECT pr.person_id, pr.unit_id, pr.month, pr.item || ' · encargos' AS item,
      pr.amount * COALESCE((
        SELECT SUM(public.param_value(c.parameter_definition_id, pr.ref, pr.unit_id, NULL, pr.contract_type_id, NULL))
        FROM public.calc_rules c
        WHERE c.active AND c.on_provisions AND c.base_kind = 'salario'
          AND (c.contract_type_ids IS NULL OR pr.contract_type_id = ANY (c.contract_type_ids))
          AND (c.account_ids IS NULL OR pr.account_id = ANY (c.account_ids))), 0) AS amount
    FROM rules pr WHERE pr.grupo = 'provisao'
  )
  SELECT person_id, unit_id, month, 'bruto', 'Salário bruto', gross FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'INSS do empregado', inss FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'IRRF', ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'liquido', 'Salário líquido', gross - inss - ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, COALESCE(grupo, 'encargo'), item, amount FROM rules
  UNION ALL SELECT person_id, unit_id, month, 'provisao', item, amount FROM prov_enc
  UNION ALL SELECT person_id, unit_id, month, 'beneficio', item, amount FROM ben
  UNION ALL SELECT r2.person_id, r2.unit_id, r2.month, 'custo_total', 'Custo total para a empresa',
    r2.gross + COALESCE((SELECT sum(x.amount) FROM rules x WHERE x.person_id = r2.person_id AND x.month = r2.month), 0)
      + COALESCE((SELECT sum(e.amount) FROM prov_enc e WHERE e.person_id = r2.person_id AND e.month = r2.month), 0)
      + COALESCE((SELECT sum(b.amount) FROM ben b WHERE b.person_id = r2.person_id AND b.month = r2.month), 0)
  FROM ret2 r2
$function$;
