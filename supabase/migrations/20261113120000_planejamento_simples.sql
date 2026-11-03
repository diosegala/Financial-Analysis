-- Planejamento simples: o diretor responde por toda a unidade (edita receitas, despesas, folha e benefícios dela até
-- enviar), e cada unidade recebe receita-compromisso e limite de custos.
--
--   custo-base (u) = despesas do ano base no Omie + custo atual da folha da unidade
--   limite (u)     = custo-base × (1 − corte), ou o valor digitado pelo financeiro
--
-- Só acrescenta colunas e funções; nada do que já foi lançado muda.

-- ───────────── O diretor edita tudo da própria unidade (o bloqueio depois do envio continua em assert_editable) ─────────────
CREATE OR REPLACE FUNCTION public.can_write_line(_user_id uuid, _line_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.plan_lines l WHERE l.id = _line_id AND public.can_write_unit(_user_id, l.unit_id))
$function$;

DROP POLICY "Financeiro writes lines" ON public.plan_lines;
CREATE POLICY "Write lines by unit" ON public.plan_lines FOR ALL TO authenticated
  USING (public.can_write_unit(auth.uid(), unit_id)) WITH CHECK (public.can_write_unit(auth.uid(), unit_id));
DROP POLICY "Financeiro writes values" ON public.plan_values;
CREATE POLICY "Write values by line" ON public.plan_values FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro') OR public.can_write_line(auth.uid(), line_id))
  WITH CHECK (public.has_role(auth.uid(), 'financeiro') OR public.can_write_line(auth.uid(), line_id));
DROP POLICY "Financeiro writes people" ON public.people;
CREATE POLICY "Write people by unit" ON public.people FOR ALL TO authenticated
  USING (public.can_write_unit(auth.uid(), unit_id)) WITH CHECK (public.can_write_unit(auth.uid(), unit_id));
DROP POLICY "Financeiro writes person_benefits" ON public.person_benefits;
CREATE POLICY "Write person_benefits by unit" ON public.person_benefits FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.can_write_unit(auth.uid(), p.unit_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.can_write_unit(auth.uid(), p.unit_id)));

CREATE OR REPLACE FUNCTION public.launch_line(
  _version_id UUID, _unit_id UUID, _account_id UUID, _description TEXT, _client_id UUID,
  _product_id UUID, _revenue_type_id UUID, _values JSONB DEFAULT '[]'::JSONB, _event_id UUID DEFAULT NULL,
  _revenue_origin TEXT DEFAULT NULL, _note TEXT DEFAULT NULL, _conditional BOOLEAN DEFAULT false,
  _condition_note TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id UUID;
  _kind TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_write_unit(auth.uid(), _unit_id) THEN
    RAISE EXCEPTION 'Você não lança nesta unidade.';
  END IF;
  _kind := public.account_kind(_account_id);
  IF _kind IS NULL THEN
    RAISE EXCEPTION 'Conta não encontrada.';
  END IF;
  IF _kind <> 'receita' THEN
    _revenue_origin := NULL;
  ELSIF _revenue_origin IS NULL AND _event_id IS NOT NULL THEN
    _revenue_origin := 'nova';
  END IF;
  IF _kind <> 'despesa' THEN
    _conditional := false;
  END IF;

  INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
    revenue_type_id, event_id, revenue_origin, note, conditional, condition_note, created_by)
  VALUES (_version_id, _unit_id, _account_id, _description, _client_id, _product_id, _revenue_type_id,
    _event_id, _revenue_origin, NULLIF(btrim(_note), ''), COALESCE(_conditional, false),
    CASE WHEN _conditional THEN NULLIF(btrim(_condition_note), '') END, auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _id, (v ->> 'month')::INT, (v ->> 'amount')::NUMERIC
  FROM jsonb_array_elements(COALESCE(_values, '[]'::JSONB)) AS v;

  RETURN _id;
END;
$$;

-- ───────────── Corte e custo-base ─────────────
ALTER TABLE public.guardrail_settings
  ADD COLUMN cost_cut_pct NUMERIC NOT NULL DEFAULT 0 CHECK (cost_cut_pct >= 0 AND cost_cut_pct < 1);
UPDATE public.guardrail_settings SET cost_cut_pct = support_cut_pct;
ALTER TABLE public.guardrail_units ADD COLUMN base_expense NUMERIC, ADD COLUMN base_payroll NUMERIC;

-- ───────────── Recebimentos do Omie por unidade, mais rápido ─────────────
CREATE OR REPLACE FUNCTION public.omie_revenue_attribution(_year INT)
RETURNS TABLE (category_name TEXT, client_code TEXT, client_name TEXT, unit_id UUID, source TEXT,
  received NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- O tratamento de cada categoria é procurado uma vez só: há milhares de recebimentos por ano.
  WITH treat AS MATERIALIZED (
    SELECT n.name, a.treatment FROM (SELECT DISTINCT name FROM public.omie_categories WHERE is_revenue) n
    LEFT JOIN LATERAL public.revenue_account_for_category(n.name, _year) a ON true
  ), base AS (
    SELECT c.name, r.month, r.amount_received AS got, r.amount_open AS open, du.unit_id AS dept_unit,
      r.client_code, COALESCE(s.name, '') AS client_name
    FROM public.omie_receipts r
    JOIN public.omie_categories c ON c.company_id = r.company_id AND c.code = r.category_code AND c.is_revenue
    LEFT JOIN public.omie_department_unit du ON du.company_id = r.company_id AND du.department_code = r.department_code
    LEFT JOIN public.omie_suppliers s ON s.company_id = r.company_id AND s.code = r.client_code
    LEFT JOIN treat t ON t.name = c.name
    WHERE r.year = _year
      -- Com conta no app, vale o tratamento dela; sem conta, só as receitas operacionais (grupo 1.01 do Omie).
      AND COALESCE(t.treatment, CASE WHEN r.category_code LIKE '1.01.%' THEN 'lancavel' ELSE 'fora_dre' END) <> 'fora_dre'
  ), names AS (SELECT DISTINCT name FROM base),
  alloc AS (
    SELECT n.name, al.unit_id, al.share / SUM(al.share) OVER (PARTITION BY n.name) AS share
    FROM names n JOIN public.omie_category_allocations al ON public.norm_text(al.category_name) = public.norm_text(n.name)
  ), kw AS (
    SELECT DISTINCT ON (n.name) n.name, k.unit_id
    FROM names n
    JOIN public.omie_keyword_units k ON public.norm_text(n.name) ~
      ('(^|[^a-z0-9])' || regexp_replace(public.norm_text(k.keyword), '([.*+?^${}()|\\[\\]\\\\])', '\\\\\\1', 'g') || 's?($|[^a-z0-9])')
    WHERE NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = n.name)
    ORDER BY n.name, k.priority DESC, length(k.keyword) DESC
  ), resolved AS (
    SELECT b.name, b.client_code, b.client_name, b.month, b.got * a.share AS got, b.open * a.share AS open, a.unit_id, 'rateio' AS source
    FROM base b JOIN alloc a ON a.name = b.name
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, b.dept_unit, 'departamento'
    FROM base b WHERE b.dept_unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name)
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, k.unit_id, 'palavra'
    FROM base b JOIN kw k ON k.name = b.name WHERE b.dept_unit IS NULL
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, NULL::UUID, 'sem'
    FROM base b WHERE b.dept_unit IS NULL
      AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name) AND NOT EXISTS (SELECT 1 FROM kw k WHERE k.name = b.name)
  ), m AS (
    SELECT name, client_code, client_name, unit_id, source, month, SUM(got) AS got, SUM(open) AS open
    FROM resolved GROUP BY 1, 2, 3, 4, 5, 6
  ), g AS (
    SELECT name, client_code, client_name, unit_id, source,
      array_agg(got ORDER BY month) AS gots, array_agg(month ORDER BY month) AS months,
      array_agg(open ORDER BY month) AS opens
    FROM m GROUP BY 1, 2, 3, 4, 5
  )
  SELECT g.name, g.client_code, g.client_name, g.unit_id, g.source,
    ARRAY(SELECT COALESCE(g.gots[array_position(g.months, k)], 0) FROM generate_series(1, 12) k),
    ARRAY(SELECT COALESCE(g.opens[array_position(g.months, k)], 0) FROM generate_series(1, 12) k)
  FROM g
$$;

-- ───────────── Referência do ano base, por unidade, conta e mês ─────────────
-- A unidade de um valor do Omie: a da atribuição, a menos que a conta seja de outra unidade (a conta manda).
CREATE OR REPLACE FUNCTION public.owner_unit(_attributed UUID, _account_units UUID[]) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _account_units IS NOT NULL AND array_length(_account_units, 1) > 0
                AND (_attributed IS NULL OR NOT _attributed = ANY (_account_units))
              THEN _account_units[1] ELSE _attributed END
$$;

-- Meses fechados: pago ou recebido (com o que ficou em aberto). Meses que faltam: o que já está em aberto ou a média dos 3
-- últimos meses fechados, o maior dos dois. Categoria com o ano no nome (edição de evento) não é projetada.
CREATE OR REPLACE FUNCTION public.reference_rows(_year INT)
RETURNS TABLE (unit_id UUID, account_id UUID, kind TEXT, month INT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH closed AS (
    SELECT CASE WHEN _year < extract(year FROM now())::INT THEN 12
                WHEN _year = extract(year FROM now())::INT THEN extract(month FROM now())::INT - 1
                ELSE 0 END AS m
  ), shared AS (
    SELECT NULLIF(value, '')::UUID AS id FROM public.app_settings WHERE key = 'shared_cost_unit_id'
  ), ex AS MATERIALIZED (SELECT * FROM public.omie_expense_attribution(_year)
  ), re AS MATERIALIZED (SELECT * FROM public.omie_revenue_attribution(_year)
  -- A conta de cada categoria é procurada uma vez só: a busca é cara e há centenas de linhas por categoria.
  ), ex_acc AS MATERIALIZED (
    SELECT c.category_name, acc.* FROM (SELECT DISTINCT category_name FROM ex) c
    CROSS JOIN LATERAL public.account_for_category(c.category_name, _year + 1) acc
    WHERE acc.treatment = 'lancavel' AND acc.kind = 'despesa' AND public.category_in_year(c.category_name, _year)
  ), re_acc AS MATERIALIZED (
    SELECT c.category_name, acc.* FROM (SELECT DISTINCT category_name FROM re) c
    CROSS JOIN LATERAL public.revenue_account_for_category(c.category_name, _year + 1) acc
    WHERE acc.treatment = 'lancavel' AND public.category_in_year(c.category_name, _year)
  ), src AS (
    SELECT COALESCE(public.owner_unit(x.unit_id, acc.unit_ids), (SELECT id FROM shared)) AS unit_id,
      acc.id AS account_id, acc.kind, x.category_name, x.paid AS got, x.open
    FROM ex x JOIN ex_acc acc ON acc.category_name = x.category_name
    UNION ALL
    SELECT public.owner_unit(r.unit_id, acc.unit_ids), acc.id, acc.kind, r.category_name, r.received, r.open
    FROM re r JOIN re_acc acc ON acc.category_name = r.category_name
  ), months AS (
    SELECT s.unit_id, s.account_id, s.kind, k AS month,
      -- Receita em aberto de mês fechado não entrou: conta só o recebido.
      CASE WHEN k <= c.m THEN s.got[k] + CASE WHEN s.kind = 'despesa' THEN s.open[k] ELSE 0 END
           WHEN s.category_name ~ '20\d{2}' THEN s.open[k]
           ELSE GREATEST(s.open[k], COALESCE(
             (SELECT SUM(x) FROM unnest(s.got[GREATEST(c.m - 2, 1):c.m]) x) / NULLIF(LEAST(c.m, 3), 0), 0))
      END AS amount
    FROM src s CROSS JOIN closed c CROSS JOIN generate_series(1, 12) k
    WHERE s.unit_id IS NOT NULL
  )
  SELECT m.unit_id, m.account_id, m.kind, m.month, round(SUM(m.amount), 2)
  FROM months m GROUP BY m.unit_id, m.account_id, m.kind, m.month
  HAVING SUM(m.amount) <> 0
$$;
REVOKE EXECUTE ON FUNCTION public.reference_rows(INT) FROM anon, authenticated;

-- O que o diretor vê ao lado do plano: só a própria unidade.
CREATE OR REPLACE FUNCTION public.unit_reference(_version_id UUID, _unit_id UUID)
RETURNS TABLE (account_id UUID, kind TEXT, month INT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.account_id, r.kind, r.month, r.amount
  FROM public.budget_versions bv
  CROSS JOIN LATERAL public.reference_rows(bv.year - 1) r
  WHERE bv.id = _version_id AND r.unit_id = _unit_id AND public.has_unit(auth.uid(), _unit_id)
$$;
REVOKE EXECUTE ON FUNCTION public.unit_reference(UUID, UUID) FROM anon;

-- Fornecedores do ano base de uma categoria da unidade, só para consulta.
CREATE OR REPLACE FUNCTION public.unit_reference_suppliers(_version_id UUID, _unit_id UUID, _account_id UUID)
RETURNS TABLE (supplier TEXT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(x.supplier_name, ''), 'Sem fornecedor'),
    round(SUM((SELECT COALESCE(SUM(v), 0) FROM unnest(x.paid) v) + (SELECT COALESCE(SUM(v), 0) FROM unnest(x.open) v)), 2)
  FROM public.budget_versions bv
  CROSS JOIN LATERAL public.omie_expense_attribution(bv.year - 1) x
  JOIN LATERAL (SELECT a.id, a.unit_ids FROM public.accounts a WHERE a.id = _account_id) acc
    ON (public.account_for_category(x.category_name, bv.year)).id = acc.id
  WHERE bv.id = _version_id AND public.has_unit(auth.uid(), _unit_id)
    AND COALESCE(public.owner_unit(x.unit_id, acc.unit_ids),
                 (SELECT NULLIF(value, '')::UUID FROM public.app_settings WHERE key = 'shared_cost_unit_id')) = _unit_id
  GROUP BY 1 ORDER BY 2 DESC
$$;
REVOKE EXECUTE ON FUNCTION public.unit_reference_suppliers(UUID, UUID, UUID) FROM anon;

-- Traz o ano base para o plano: uma linha por categoria, só onde a categoria ainda não tem lançamento na unidade.
-- Com _account_id, só aquela categoria. Nunca apaga nem sobrescreve o que foi lançado.
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

-- ───────────── Atualizar o ano base: receita (como antes) e a foto do custo-base de todas as unidades ─────────────
CREATE OR REPLACE FUNCTION public.guardrails_suggest(_scenario_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _year INT;
  _version UUID;
  _closed INT;
  _unassigned NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro atualiza o ano base.';
  END IF;
  SELECT bv.year - 1, bv.id INTO _year, _version FROM public.scenarios s JOIN public.budget_versions bv ON bv.id = s.version_id
  WHERE s.id = _scenario_id;
  IF _year IS NULL THEN RAISE EXCEPTION 'Cenário não encontrado.'; END IF;
  _closed := CASE WHEN _year < extract(year FROM now())::INT THEN 12
                  WHEN _year = extract(year FROM now())::INT THEN extract(month FROM now())::INT - 1
                  ELSE 0 END;

  INSERT INTO public.guardrail_settings (scenario_id) VALUES (_scenario_id) ON CONFLICT (scenario_id) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS _gr_rev (unit_id UUID, actual NUMERIC, last3 NUMERIC) ON COMMIT DROP;
  TRUNCATE _gr_rev;
  INSERT INTO _gr_rev
  WITH re AS MATERIALIZED (SELECT * FROM public.omie_revenue_attribution(_year)),
  acc AS MATERIALIZED (
    SELECT c.category_name, ac.unit_ids FROM (SELECT DISTINCT category_name FROM re) c
    LEFT JOIN LATERAL public.revenue_account_for_category(c.category_name, _year + 1) ac ON true
  )
  SELECT public.owner_unit(a.unit_id, acc.unit_ids),
    SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(a.received[1:_closed]) x)),
    SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(a.received[GREATEST(_closed - 2, 1):_closed]) x))
      / NULLIF(LEAST(_closed, 3), 0)
  FROM re a JOIN acc ON acc.category_name = a.category_name
  GROUP BY 1;

  SELECT COALESCE(SUM(actual + COALESCE(last3, 0) * (12 - _closed)), 0) INTO _unassigned FROM _gr_rev WHERE unit_id IS NULL;
  UPDATE public.guardrail_settings SET base_year = _year, base_closed_month = _closed,
    unassigned_revenue = _unassigned, suggested_at = now()
  WHERE scenario_id = _scenario_id;

  CREATE TEMP TABLE IF NOT EXISTS _gr_exp (unit_id UUID, amount NUMERIC) ON COMMIT DROP;
  TRUNCATE _gr_exp;
  INSERT INTO _gr_exp SELECT x.unit_id, SUM(x.amount) FROM public.reference_rows(_year) x WHERE x.kind = 'despesa' GROUP BY x.unit_id;
  CREATE TEMP TABLE IF NOT EXISTS _gr_pay (unit_id UUID, amount NUMERIC) ON COMMIT DROP;
  TRUNCATE _gr_pay;
  INSERT INTO _gr_pay SELECT p.unit_id, SUM(p.amount) FROM public.plan_split(_version, _scenario_id) p WHERE p.bucket = 'folha' GROUP BY p.unit_id;

  INSERT INTO public.guardrail_units (scenario_id, unit_id, floor_actual, floor_projected, base_expense, base_payroll)
  SELECT _scenario_id, u.id,
    CASE WHEN u.kind = 'negocio' THEN COALESCE(r.actual, 0) END,
    CASE WHEN u.kind = 'negocio' THEN COALESCE(r.last3, 0) * (12 - _closed) END,
    COALESCE(e.amount, 0), COALESCE(f.amount, 0)
  FROM public.units u LEFT JOIN _gr_rev r ON r.unit_id = u.id
  LEFT JOIN _gr_exp e ON e.unit_id = u.id LEFT JOIN _gr_pay f ON f.unit_id = u.id
  WHERE u.active
  ON CONFLICT (scenario_id, unit_id) DO UPDATE
    SET floor_actual = EXCLUDED.floor_actual, floor_projected = EXCLUDED.floor_projected,
        base_expense = EXCLUDED.base_expense, base_payroll = EXCLUDED.base_payroll;
END;
$$;

-- ───────────── Os números de cada unidade ─────────────
DROP FUNCTION public.guardrails(UUID);
CREATE FUNCTION public.guardrails(_scenario_id UUID)
RETURNS TABLE (unit_id UUID, kind TEXT, floor_suggested NUMERIC, floor_amount NUMERIC, variable_rate NUMERIC,
  floor_net NUMERIC, base_expense NUMERIC, base_payroll NUMERIC, ceiling_suggested NUMERIC, ceiling NUMERIC,
  planned_revenue NUMERIC, planned_variable NUMERIC, planned_expense NUMERIC, planned_payroll NUMERIC)
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
    SELECT u.id, u.kind, g.floor_amount AS floor_typed, g.ceiling_amount AS ceiling_typed,
      COALESCE(g.base_expense, 0) AS base_expense, COALESCE(g.base_payroll, 0) AS base_payroll,
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
    b.base_expense, b.base_payroll,
    (b.base_expense + b.base_payroll) * (1 - st.cost_cut_pct),
    COALESCE(b.ceiling_typed, (b.base_expense + b.base_payroll) * (1 - st.cost_cut_pct)),
    b.revenue, b.variable, b.expense, b.payroll
  FROM b
  WHERE public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
     OR public.has_unit(auth.uid(), b.id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guardrails(UUID) FROM anon;

-- ───────────── Despesas de produtos: só onde há produtos ─────────────
-- Contas exclusivas de outras unidades (consultoria, Imobi Report) passam para a linha Despesas. Editável em Configurações.
UPDATE public.accounts a SET dre_line_id = (SELECT id FROM public.dre_lines WHERE code = 'despesas')
WHERE a.kind = 'despesa' AND a.unit_ids IS NOT NULL
  AND a.dre_line_id = (SELECT id FROM public.dre_lines WHERE code = 'despesas_produtos')
  AND NOT (SELECT id FROM public.units WHERE name = 'Educação') = ANY (a.unit_ids);
