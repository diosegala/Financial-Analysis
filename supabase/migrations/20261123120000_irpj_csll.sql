-- IRPJ e CSLL (lucro real), apurados por trimestre sobre o resultado da empresa e pagos em cota única depois do
-- trimestre. O resultado inteiro é tratado como da empresa do lucro real. As despesas não dedutíveis voltam para a base.
-- O imposto aparece em cada unidade de negócio, proporcional à receita bruta dela; as áreas de apoio ficam com zero.
-- Alíquotas, limites e prazo ficam em Parâmetros, sem valor: o financeiro informa.

-- ───────────── Despesas não dedutíveis ─────────────
ALTER TABLE public.accounts ADD COLUMN non_deductible BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.accounts.non_deductible IS
  'Não dedutível no IRPJ/CSLL: as despesas desta conta voltam para a base do lucro real.';
ALTER TABLE public.plan_lines ADD COLUMN non_deductible BOOLEAN;
COMMENT ON COLUMN public.plan_lines.non_deductible IS
  'Exceção da linha para o IRPJ/CSLL. NULL = segue a conta.';

-- ───────────── Parâmetros ─────────────
ALTER TABLE public.parameter_definitions DROP CONSTRAINT parameter_definitions_value_type_check;
ALTER TABLE public.parameter_definitions ADD CONSTRAINT parameter_definitions_value_type_check
  CHECK (value_type IN ('percent', 'currency', 'number'));

INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order)
VALUES
  ('irpj', 'IRPJ', 'Lucro real: alíquota sobre a base do trimestre.', 'percent', ARRAY['global'], 0, 1, 100),
  ('irpj_adicional', 'Adicional do IRPJ', 'Sobre a parte da base do trimestre acima do limite do adicional.',
   'percent', ARRAY['global'], 0, 1, 101),
  ('irpj_adicional_limite', 'Limite do adicional do IRPJ (R$ por trimestre)',
   'O adicional incide sobre o que passar deste valor no trimestre.', 'currency', ARRAY['global'], 0, NULL, 102),
  ('csll', 'CSLL', 'Lucro real: alíquota sobre a base do trimestre.', 'percent', ARRAY['global'], 0, 1, 103),
  ('compensacao_prejuizo', 'Compensação de prejuízo (limite)',
   'Parte do lucro real do trimestre que o prejuízo de trimestres anteriores pode abater.', 'percent', ARRAY['global'], 0, 1, 104),
  ('irpj_csll_meses_pagamento', 'Meses até o pagamento do IRPJ/CSLL',
   'Depois do fim do trimestre. Cota única no mês seguinte = 1.', 'number', ARRAY['global'], 0, 3, 105),
  ('irpj_csll_trimestre_anterior', 'IRPJ e CSLL do 4º trimestre do ano anterior (R$)',
   'Pago no começo do ano, no mês dado por "Meses até o pagamento".', 'currency', ARRAY['global'], 0, NULL, 106)
ON CONFLICT (key) DO NOTHING;

-- ───────────── DRE ─────────────
INSERT INTO public.dre_lines (code, name, sort_order, kind, sign)
SELECT x.code, x.name, x.ord, x.kind, x.sign FROM (VALUES
  ('irpj_csll', 'IRPJ e CSLL', 90, 'calculada', -1),
  ('resultado_liquido', 'Resultado líquido', 100, 'subtotal', 1)) x(code, name, ord, kind, sign)
WHERE NOT EXISTS (SELECT 1 FROM public.dre_lines d WHERE d.code = x.code);

-- O realizado de IRPJ e CSLL vai para a linha nova.
UPDATE public.accounts SET dre_line_id = (SELECT id FROM public.dre_lines WHERE code = 'irpj_csll')
WHERE public.norm_text(name) IN ('irpj', 'csll');

-- ───────────── Cálculo ─────────────
-- Linhas da DRE por unidade e mês, sem subtotais e sem o IRPJ/CSLL (o que era o "leaf" de dre_unit_values).
CREATE FUNCTION public.dre_leaf_values(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
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
    JOIN public.calc_rules r ON r.active
      AND public.rule_matches(r.base_kind, r.payment_component, r.on_provisions, b.row_kind)
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
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

-- Apuração por trimestre da empresa inteira (1 a 4; 0 = o 4º trimestre do ano anterior, pago no começo do ano).
-- SECURITY DEFINER: o imposto depende do total da empresa, mesmo para quem só enxerga a própria unidade. O detalhe só
-- sai para o financeiro; a parte de cada unidade sai em income_tax_by_unit.
CREATE FUNCTION public.income_tax_quarters(_version_id uuid, _scenario_id uuid)
 RETURNS TABLE(quarter integer, result numeric, additions numeric, taxable numeric, loss_used numeric,
   loss_balance numeric, base numeric, irpj numeric, csll numeric, total numeric, pay_month integer, shares jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _year INT;
  _ev NUMERIC;
  _tax_sort INT;
  _rev_line UUID;
  _res NUMERIC[] := ARRAY[0, 0, 0, 0];
  _add NUMERIC[] := ARRAY[0, 0, 0, 0];
  _shares JSONB[] := ARRAY['{}', '{}', '{}', '{}']::JSONB[];
  _year_shares JSONB;
  _balance NUMERIC := 0;
  _lr NUMERIC;
  _used NUMERIC;
  _b NUMERIC;
  _ref DATE;
  _lag INT;
  q INT;
  p RECORD;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_access(auth.uid()) THEN RETURN; END IF;
  SELECT v.year INTO _year FROM public.budget_versions v WHERE v.id = _version_id;
  IF _year IS NULL THEN RETURN; END IF;
  SELECT COALESCE(s.expense_variation, 0) INTO _ev FROM (SELECT 1) one LEFT JOIN public.scenarios s ON s.id = _scenario_id;
  SELECT d.sort_order INTO _tax_sort FROM public.dre_lines d WHERE d.code = 'irpj_csll';
  SELECT d.id INTO _rev_line FROM public.dre_lines d WHERE d.active AND d.kind = 'lancada' AND d.sign > 0
  ORDER BY d.sort_order LIMIT 1;

  -- Resultado do trimestre: as linhas da DRE antes do IRPJ/CSLL (a Contribuição líquida de todas as unidades).
  -- Rateio: receita bruta das unidades de negócio no trimestre; sem receita no trimestre, a do ano.
  WITH leaf AS (SELECT * FROM public.dre_leaf_values(_version_id, _scenario_id, NULL)),
  res AS (
    SELECT (l.month - 1) / 3 + 1 AS q, SUM(d.sign * l.amount) AS v
    FROM leaf l JOIN public.dre_lines d ON d.id = l.dre_line_id
    WHERE d.kind IN ('lancada', 'calculada') AND d.sort_order < COALESCE(_tax_sort, 2147483647)
    GROUP BY 1),
  rev AS (
    SELECT (l.month - 1) / 3 + 1 AS q, l.unit_id, SUM(l.amount) AS v
    FROM leaf l JOIN public.units u ON u.id = l.unit_id AND u.kind = 'negocio'
    WHERE l.dre_line_id = _rev_line GROUP BY 1, 2)
  SELECT
    ARRAY(SELECT COALESCE((SELECT res.v FROM res WHERE res.q = g), 0) FROM generate_series(1, 4) g ORDER BY g),
    (SELECT COALESCE(jsonb_object_agg(y.unit_id, y.v / y.t), '{}') FROM (
       SELECT rev.unit_id, SUM(rev.v) AS v, SUM(SUM(rev.v)) OVER () AS t FROM rev GROUP BY rev.unit_id
       HAVING SUM(rev.v) > 0) y WHERE y.t > 0),
    ARRAY(SELECT COALESCE((SELECT jsonb_object_agg(z.unit_id, z.v / z.t) FROM (
       SELECT rev.unit_id, rev.v, SUM(rev.v) OVER () AS t FROM rev WHERE rev.q = g AND rev.v > 0) z WHERE z.t > 0), '{}')
     FROM generate_series(1, 4) g ORDER BY g)
  INTO _res, _year_shares, _shares;
  -- Sem receita no ano: divide igual entre as unidades de negócio.
  IF _year_shares = '{}' THEN
    SELECT COALESCE(jsonb_object_agg(x.id, 1.0 / x.n), '{}') INTO _year_shares
    FROM (SELECT u.id, count(*) OVER () AS n FROM public.units u WHERE u.active AND u.kind = 'negocio') x;
  END IF;

  -- Adições: despesas não dedutíveis (pela conta, ou pela exceção da linha), com a variação do cenário.
  FOR p IN
    SELECT (v.month - 1) / 3 + 1 AS q, SUM(v.amount * (1 + _ev)) AS v
    FROM public.plan_lines l
    JOIN public.plan_values v ON v.line_id = l.id
    JOIN public.accounts a ON a.id = l.account_id
    WHERE l.version_id = _version_id AND l.person_id IS NULL AND l.benefit_person_id IS NULL
      AND a.kind = 'despesa' AND COALESCE(l.origin, '') <> 'planilha_deducao'
      AND COALESCE(l.non_deductible, a.non_deductible)
    GROUP BY 1
  LOOP _add[p.q] := p.v; END LOOP;

  -- 4º trimestre do ano anterior, informado pelo financeiro.
  _lag := COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj_csll_meses_pagamento'),
    make_date(_year, 1, 1), NULL, NULL, NULL, NULL), 1)::INT;
  quarter := 0; result := NULL; additions := NULL; taxable := NULL; loss_used := NULL; loss_balance := NULL;
  base := NULL; irpj := NULL; csll := NULL;
  total := COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj_csll_trimestre_anterior'),
    make_date(_year, 1, 1), NULL, NULL, NULL, NULL), 0);
  pay_month := _lag; shares := _year_shares;
  IF _lag >= 1 THEN RETURN NEXT; END IF;

  FOR q IN 1..4 LOOP
    _ref := make_date(_year, q * 3, 1);
    _lr := _res[q] + _add[q];
    IF _lr <= 0 THEN
      _balance := _balance - _lr; _used := 0; _b := 0;
    ELSE
      _used := LEAST(_balance, round(_lr * COALESCE(public.param_value(
        (SELECT id FROM public.parameter_definitions WHERE key = 'compensacao_prejuizo'), _ref, NULL, NULL, NULL, NULL), 0), 2));
      _balance := _balance - _used; _b := _lr - _used;
    END IF;
    quarter := q; result := round(_res[q], 2); additions := round(_add[q], 2); taxable := round(_lr, 2);
    loss_used := round(_used, 2); loss_balance := round(_balance, 2); base := round(_b, 2);
    irpj := round(_b * COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj'),
              _ref, NULL, NULL, NULL, NULL), 0)
            + GREATEST(_b - COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj_adicional_limite'),
              _ref, NULL, NULL, NULL, NULL), 0), 0)
              * COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj_adicional'),
              _ref, NULL, NULL, NULL, NULL), 0), 2);
    csll := round(_b * COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'csll'),
              _ref, NULL, NULL, NULL, NULL), 0), 2);
    total := irpj + csll;
    pay_month := q * 3 + COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'irpj_csll_meses_pagamento'),
      _ref, NULL, NULL, NULL, NULL), 1)::INT;
    shares := CASE WHEN _shares[q] = '{}' THEN _year_shares ELSE _shares[q] END;
    RETURN NEXT;
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.income_tax_quarters(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.income_tax_quarters(uuid, uuid) TO authenticated, service_role;

-- A parte de cada unidade, no mês do pagamento (dentro do ano). Só as unidades que quem chama enxerga.
CREATE FUNCTION public.income_tax_by_unit(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, month integer, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.key::UUID, q.pay_month, q.total * s.value::NUMERIC
  FROM public.income_tax_quarters(_version_id, _scenario_id) q
  CROSS JOIN LATERAL jsonb_each_text(q.shares) s
  WHERE q.pay_month BETWEEN 1 AND 12 AND q.total <> 0
    AND (_unit_ids IS NULL OR s.key::UUID = ANY (_unit_ids))
    AND (auth.uid() IS NULL OR public.has_unit(auth.uid(), s.key::UUID))
$function$;
REVOKE ALL ON FUNCTION public.income_tax_by_unit(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.income_tax_by_unit(uuid, uuid, uuid[]) TO authenticated, service_role;

-- A DRE por unidade passa a ter o IRPJ/CSLL e o resultado líquido.
CREATE OR REPLACE FUNCTION public.dre_unit_values(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, dre_line_id uuid, month integer, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH leaf AS (
    SELECT * FROM public.dre_leaf_values(_version_id, _scenario_id, _unit_ids)
    UNION ALL
    SELECT t.unit_id, d.id, t.month, t.amount
    FROM public.income_tax_by_unit(_version_id, _scenario_id, _unit_ids) t
    JOIN public.dre_lines d ON d.code = 'irpj_csll' AND d.active
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
