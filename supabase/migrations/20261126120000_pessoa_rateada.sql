-- Pessoa rateada entre unidades: o financeiro informa a parte do custo de uma pessoa que vai para outras unidades. A
-- unidade da pessoa fica com o que sobra. Salário, encargos, provisões e benefícios por pessoa seguem a mesma divisão.

CREATE TABLE public.person_allocations (
  person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  share NUMERIC NOT NULL CHECK (share > 0 AND share <= 1),
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, unit_id)
);
COMMENT ON TABLE public.person_allocations IS
  'Parte do custo da pessoa em outra unidade. A unidade da pessoa fica com 1 menos a soma.';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.person_allocations TO authenticated;
GRANT ALL ON public.person_allocations TO service_role;
ALTER TABLE public.person_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read person_allocations by unit" ON public.person_allocations FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id)
         OR EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.has_unit(auth.uid(), p.unit_id)));
CREATE POLICY "Financeiro writes person_allocations" ON public.person_allocations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_person_allocations AFTER INSERT OR UPDATE OR DELETE ON public.person_allocations
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_person_allocations BEFORE UPDATE ON public.person_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Outra unidade, e a soma das partes até 100%.
CREATE FUNCTION public.validate_person_allocation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.people p WHERE p.id = NEW.person_id AND p.unit_id = NEW.unit_id) THEN
    RAISE EXCEPTION 'A unidade da pessoa fica com o que sobra: escolha outra unidade.';
  END IF;
  IF (SELECT COALESCE(SUM(share), 0) FROM public.person_allocations
      WHERE person_id = NEW.person_id AND unit_id <> NEW.unit_id) + NEW.share > 1 THEN
    RAISE EXCEPTION 'As partes das outras unidades passam de 100%%.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_person_allocations BEFORE INSERT OR UPDATE ON public.person_allocations
  FOR EACH ROW EXECUTE FUNCTION public.validate_person_allocation();

-- Parte do custo que fica na unidade da pessoa.
CREATE FUNCTION public.person_home_shares(_version_id UUID)
RETURNS TABLE (person_id UUID, share NUMERIC)
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT pa.person_id, 1 - SUM(pa.share)
  FROM public.person_allocations pa JOIN public.people p ON p.id = pa.person_id
  WHERE p.version_id = _version_id
  GROUP BY pa.person_id
$$;

-- O custo das pessoas de outras unidades rateado para as unidades pedidas, nas mesmas linhas de plan_base_rows.
-- SECURITY DEFINER: o diretor da unidade que recebe a parte não enxerga as pessoas da outra unidade; só sai a parte das
-- unidades que quem chama pode ver (salvo no cálculo do IRPJ/CSLL, que é da empresa inteira e só devolve totais).
CREATE FUNCTION public.allocated_payroll_rows(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, month integer, row_kind text, account_id uuid, dre_line_id uuid, revenue_type_id uuid,
   product_id uuid, contract_type_id uuid, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT COALESCE(expense_variation, 0) AS ev, COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ),
  a AS (
    SELECT pa.person_id, pa.unit_id AS to_unit, pa.share, p.unit_id AS home
    FROM public.person_allocations pa JOIN public.people p ON p.id = pa.person_id
    WHERE p.version_id = _version_id AND pa.unit_id <> p.unit_id
      AND (_unit_ids IS NULL OR pa.unit_id = ANY (_unit_ids))
      AND (auth.uid() IS NULL OR public.has_unit(auth.uid(), pa.unit_id)
           OR current_setting('app.company_scope', true) = 'on')
  ),
  homes AS (SELECT COALESCE(array_agg(DISTINCT a.home), '{}') AS ids FROM a)
  -- Folha (salário, provisões, encargos e bases), no mês do pagamento
  SELECT a.to_unit, c.month, k.row_kind, c.account_id,
    CASE WHEN k.row_kind LIKE '%base\_%' THEN NULL ELSE ac.dre_line_id END,
    NULL::UUID, NULL::UUID, c.contract_type_id, SUM(c.amount * a.share)
  FROM homes h
  CROSS JOIN LATERAL public.payroll_cash(_version_id, _scenario_id, h.ids) c
  JOIN a ON a.person_id = c.person_id
  JOIN public.accounts ac ON ac.id = c.account_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN c.part IN ('base_fgts', 'base_inss') THEN
      CASE WHEN c.source = 'salario' THEN '' ELSE 'p' END || 'base_' || substr(c.part, 6)
    WHEN c.part IN ('inss_inf', 'irrf_inf') THEN 'folha'
    WHEN c.source = 'salario' THEN 'salario'
    ELSE 'provisao' END AS row_kind) k
  GROUP BY a.to_unit, c.month, k.row_kind, c.account_id, ac.dre_line_id, c.contract_type_id
  UNION ALL
  -- Benefícios lançados para a pessoa
  SELECT a.to_unit, v.month, ac.kind, ac.id, ac.dre_line_id, NULL::UUID, NULL::UUID, NULL::UUID,
    v.amount * a.share * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END
  FROM public.plan_lines l
  JOIN a ON a.person_id = l.benefit_person_id
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts ac ON ac.id = l.account_id
  CROSS JOIN s
  WHERE l.version_id = _version_id
  UNION ALL
  -- Headcount (base dos benefícios por pessoa), na proporção
  SELECT a.to_unit, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, a.share
  FROM public.plan_lines l
  JOIN a ON a.person_id = l.person_id
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  WHERE l.version_id = _version_id
$function$;
REVOKE ALL ON FUNCTION public.allocated_payroll_rows(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.allocated_payroll_rows(uuid, uuid, uuid[]) TO authenticated, service_role;

-- As linhas-base do plano com o rateio: a unidade da pessoa fica com a parte dela, e as outras recebem a delas.
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
  -- A parte das pessoas de outras unidades
  SELECT * FROM public.allocated_payroll_rows(_version_id, _scenario_id, _unit_ids)
$function$;

-- Pessoas de outras unidades com parte do custo nesta unidade, para a tela (só leitura).
CREATE FUNCTION public.unit_allocated_people(_version_id UUID, _unit_id UUID)
RETURNS TABLE (person_id UUID, name TEXT, home_unit TEXT, share NUMERIC, salary NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id, p.name, u.name, pa.share,
    (SELECT round(SUM(v.amount) * pa.share, 2) FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id
     WHERE l.person_id = p.id AND l.version_id = _version_id)
  FROM public.person_allocations pa
  JOIN public.people p ON p.id = pa.person_id AND p.version_id = _version_id
  JOIN public.units u ON u.id = p.unit_id
  WHERE pa.unit_id = _unit_id AND public.has_unit(auth.uid(), _unit_id)
  ORDER BY p.name
$$;
REVOKE ALL ON FUNCTION public.unit_allocated_people(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_allocated_people(UUID, UUID) TO authenticated;

-- IRPJ/CSLL: a apuração da empresa inclui o rateio de pessoas de todas as unidades.
CREATE OR REPLACE FUNCTION public.income_tax_quarters(_version_id uuid, _scenario_id uuid)
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

  -- O imposto é da empresa inteira: o rateio de pessoas entra para todas as unidades, não só as de quem pergunta.
  PERFORM set_config('app.company_scope', 'on', true);
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
  PERFORM set_config('app.company_scope', '', true);
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
