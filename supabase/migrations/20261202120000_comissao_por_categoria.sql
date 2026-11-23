-- Parâmetro por categoria de receita: na Agência e na Consultoria a receita é lançada direto nas categorias (receita fixa,
-- receita variável), sem produto. O percentual de comissão (ou de qualquer regra) pode valer para uma categoria de receita.

ALTER TABLE public.parameter_values ADD COLUMN account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
COMMENT ON COLUMN public.parameter_values.account_id IS 'Categoria (conta) de receita a que o valor se aplica; vazio = todas.';

ALTER TABLE public.parameter_definitions DROP CONSTRAINT parameter_definitions_allowed_scopes_check;
ALTER TABLE public.parameter_definitions ADD CONSTRAINT parameter_definitions_allowed_scopes_check
  CHECK (allowed_scopes <@ ARRAY['global', 'unit', 'product', 'contract_type', 'revenue_type', 'account']);

-- O valor mais específico vale; a categoria entra como mais um recorte. Chamadas sem categoria continuam iguais.
DROP FUNCTION public.param_value(UUID, DATE, UUID, UUID, UUID, UUID);
CREATE FUNCTION public.param_value(_definition_id UUID, _ref DATE, _unit_id UUID, _product_id UUID,
  _contract_type_id UUID, _revenue_type_id UUID, _account_id UUID DEFAULT NULL)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT pv.value FROM public.parameter_values pv
  WHERE pv.definition_id = _definition_id AND pv.valid_from <= _ref
    AND (pv.unit_id IS NULL OR pv.unit_id = _unit_id)
    AND (pv.product_id IS NULL OR pv.product_id = _product_id)
    AND (pv.contract_type_id IS NULL OR pv.contract_type_id = _contract_type_id)
    AND (pv.revenue_type_id IS NULL OR pv.revenue_type_id = _revenue_type_id)
    AND (pv.account_id IS NULL OR pv.account_id = _account_id)
  ORDER BY (pv.unit_id IS NOT NULL)::INT + (pv.product_id IS NOT NULL)::INT
         + (pv.contract_type_id IS NOT NULL)::INT + (pv.revenue_type_id IS NOT NULL)::INT
         + (pv.account_id IS NOT NULL)::INT DESC,
           pv.valid_from DESC, pv.created_at DESC
  LIMIT 1
$$;

-- DRE e divisão do plano: a regra recebe a categoria da linha (as definições de 20261127120000, só com a categoria).
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

-- Alíquota variável da unidade (custo variável da receita-compromisso): com valores por categoria, a taxa de cada regra é
-- a média dos percentuais das categorias, pesada pela receita planejada de cada uma na versão mais recente do ano; sem
-- receita planejada, pela receita do ano base. Sem valor por categoria, como antes.
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
  ORDER BY r.sort_order, r.name
$$;
REVOKE ALL ON FUNCTION public.variable_rate_parts(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.variable_rate_parts(UUID, DATE) TO authenticated, service_role;
