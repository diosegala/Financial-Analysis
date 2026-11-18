-- IBS e CBS (e PIS/COFINS) com crédito nas compras: as despesas de contas que geram crédito (salvo exceção na linha, como
-- fornecedor do Simples) devolvem a alíquota do imposto, N meses depois (o crédito retido na fonte volta em 60 dias).
-- O crédito reduz a linha do imposto, na unidade da despesa. As alíquotas ficam em Parâmetros.

ALTER TABLE public.plan_lines ADD COLUMN tax_credit BOOLEAN;
COMMENT ON COLUMN public.plan_lines.tax_credit IS
  'Exceção da linha para o crédito de IBS/CBS (ex.: fornecedor do Simples, sem crédito). NULL = segue a conta.';
COMMENT ON COLUMN public.accounts.generates_tax_credit IS
  'As despesas desta conta geram crédito dos impostos marcados com crédito nas compras (IBS/CBS, PIS/COFINS).';
ALTER TABLE public.calc_rules ADD COLUMN credit_on_purchases BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.calc_rules.credit_on_purchases IS
  'Imposto sobre a receita com crédito nas compras: a mesma alíquota volta sobre as despesas que geram crédito.';

INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order)
VALUES ('credito_meses', 'Meses até o crédito de IBS/CBS',
  'Depois do mês da despesa: o crédito retido na fonte volta em 60 dias = 2. Sem valor, 2.', 'number', ARRAY['global'], 0, 6, 35)
ON CONFLICT (key) DO NOTHING;

-- Conta para o realizado dos créditos, quando a categoria existir no Omie.
INSERT INTO public.accounts (name, kind, treatment, dre_line_id)
SELECT 'Créditos de IBS/CBS', 'despesa', 'calculada', d.id FROM public.dre_lines d
WHERE d.code = 'impostos' AND NOT EXISTS (SELECT 1 FROM public.accounts WHERE name = 'Créditos de IBS/CBS');

CREATE OR REPLACE FUNCTION public.plan_base_rows(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, month integer, row_kind text, account_id uuid, dre_line_id uuid, revenue_type_id uuid, product_id uuid, contract_type_id uuid, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT COALESCE(revenue_variation, 0) AS rv, COALESCE(expense_variation, 0) AS ev,
           COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ),
  home AS (SELECT * FROM public.person_home_shares(_version_id))
  -- Linhas lançadas nas grades e itens de eventos (a remuneração de pessoas vem abaixo). Da planilha de Educação:
  -- a receita entra como receita_planilha (sem as regras de imposto e comissão) e as taxas e impostos como dedução.
  -- Benefício de pessoa rateada: só a parte da unidade dela.
  SELECT l.unit_id, v.month,
    CASE WHEN l.origin = 'planilha_deducao' THEN 'deducao'
         WHEN l.origin = 'planilha' AND a.kind = 'receita' THEN 'receita_planilha'
         ELSE a.kind END,
    a.id, a.dre_line_id, l.revenue_type_id, l.product_id, NULL::UUID,
    v.amount * CASE a.kind WHEN 'receita' THEN 1 + s.rv
                           WHEN 'despesa' THEN 1 + s.ev
                           ELSE CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END END
      * COALESCE(h.share, 1)
  FROM public.plan_lines l
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts a ON a.id = l.account_id
  LEFT JOIN home h ON h.person_id = l.benefit_person_id
  CROSS JOIN s
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    AND l.person_id IS NULL
  UNION ALL
  -- Pessoas, no mês do pagamento (a parte da unidade da pessoa)
  SELECT c.unit_id, c.month, k.row_kind, c.account_id,
    CASE WHEN k.row_kind LIKE '%base\_%' THEN NULL ELSE a.dre_line_id END,
    NULL::UUID, NULL::UUID, c.contract_type_id, SUM(c.amount * COALESCE(h.share, 1))
  FROM public.payroll_cash(_version_id, _scenario_id, _unit_ids) c
  JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN home h ON h.person_id = c.person_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN c.part IN ('base_fgts', 'base_inss') THEN
      CASE WHEN c.source = 'salario' THEN '' ELSE 'p' END || 'base_' || substr(c.part, 6)
    WHEN c.part IN ('inss_inf', 'irrf_inf') THEN 'folha'
    WHEN c.source = 'salario' THEN 'salario'
    ELSE 'provisao' END AS row_kind) k
  GROUP BY c.unit_id, c.month, k.row_kind, c.account_id, a.dre_line_id, c.contract_type_id
  UNION ALL
  -- Headcount: 1 por pessoa nos meses em que há remuneração (base para benefícios por pessoa), na parte da unidade
  SELECT l.unit_id, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id,
    COALESCE(h.share, 1)
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  LEFT JOIN home h ON h.person_id = l.person_id
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  UNION ALL
  -- Base do crédito de IBS/CBS (e PIS/COFINS): as despesas que geram crédito, negativas, no mês em que o crédito volta.
  SELECT l.unit_id, v.month + lag.m, 'base_credito', a.id, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID,
    -v.amount * (1 + s.ev)
  FROM public.plan_lines l
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts a ON a.id = l.account_id
  CROSS JOIN s
  CROSS JOIN LATERAL (SELECT COALESCE(public.param_value(
    (SELECT id FROM public.parameter_definitions WHERE key = 'credito_meses'),
    make_date((SELECT year FROM public.budget_versions WHERE id = _version_id), 1, 1), NULL, NULL, NULL, NULL), 2)::INT AS m) lag
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    AND l.person_id IS NULL AND l.benefit_person_id IS NULL AND a.kind = 'despesa'
    AND COALESCE(l.origin, '') <> 'planilha_deducao'
    AND COALESCE(l.tax_credit, a.generates_tax_credit)
    AND v.month + lag.m <= 12
  UNION ALL
  -- A parte das pessoas de outras unidades
  SELECT * FROM public.allocated_payroll_rows(_version_id, _scenario_id, _unit_ids)
$function$;

CREATE OR REPLACE FUNCTION public.dre_leaf_values(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
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
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
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
  SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
  FROM (
    SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b
    WHERE b.row_kind <> 'headcount' AND b.row_kind NOT LIKE '%base\_%'
    UNION ALL
    SELECT c.unit_id, c.dre_line_id, c.month, c.amount FROM calc c
  ) x
  GROUP BY x.unit_id, x.dre_line_id, x.month
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
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
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
      CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'receita_planilha' THEN 'receita'
                      WHEN 'deducao' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END AS bucket, b.amount
    FROM base b
    WHERE b.row_kind IN ('receita', 'receita_planilha', 'deducao', 'despesa', 'folha', 'salario', 'provisao')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$function$;
