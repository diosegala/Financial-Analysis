-- Folha no mês do pagamento (regime de caixa). A grade de Pessoas continua por competência: "janeiro" é o salário de
-- janeiro. A DRE, o limite e o custo da folha mostram cada parte no mês em que é paga, pela tabela "Quando cada valor é
-- pago". As férias coletivas que cruzam o ano reduzem os salários de dezembro e de janeiro pelos dias do calendário.
-- Janeiro recebe o que o ano anterior deixou para ele, calculado pelo salário de janeiro de cada pessoa.

-- ───────────── Quando cada valor é pago ─────────────
CREATE TABLE public.payroll_payment_rules (
  event TEXT NOT NULL CHECK (event IN ('salario', 'decimo_1', 'decimo_2', 'ferias_coletivas')),
  part TEXT NOT NULL CHECK (part IN ('liquido', 'fgts', 'inss', 'irrf')),
  lag INT NOT NULL CHECK (lag BETWEEN 0 AND 2),
  note TEXT,
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event, part)
);
COMMENT ON TABLE public.payroll_payment_rules IS
  'Quantos meses depois da competência cada parte da folha é paga. INSS vale para o do empregado e o patronal.';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_payment_rules TO authenticated;
GRANT ALL ON public.payroll_payment_rules TO service_role;
ALTER TABLE public.payroll_payment_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read payroll_payment_rules" ON public.payroll_payment_rules FOR SELECT TO authenticated
  USING (public.has_access(auth.uid()));
CREATE POLICY "Financeiro writes payroll_payment_rules" ON public.payroll_payment_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_payroll_payment_rules AFTER INSERT OR UPDATE OR DELETE ON public.payroll_payment_rules
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_payroll_payment_rules BEFORE UPDATE ON public.payroll_payment_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.payroll_payment_rules (event, part, lag, note) VALUES
  ('salario', 'liquido', 1, 'Folha paga no dia 5 do mês seguinte'),
  ('salario', 'fgts', 1, NULL),
  ('salario', 'inss', 1, NULL),
  ('salario', 'irrf', 1, NULL),
  ('decimo_1', 'liquido', 0, '1ª parcela paga no fim de novembro'),
  ('decimo_1', 'fgts', 1, 'FGTS sobre 50% do 13º no mês seguinte'),
  ('decimo_2', 'liquido', 0, '2ª parcela paga em dezembro'),
  ('decimo_2', 'fgts', 1, 'FGTS sobre 50% do 13º no mês seguinte'),
  ('decimo_2', 'inss', 0, 'INSS do 13º, do empregado e patronal, integral em dezembro'),
  ('decimo_2', 'irrf', 1, 'IR do 13º no mês seguinte'),
  ('ferias_coletivas', 'liquido', 0, 'Férias pagas antes de começar'),
  ('ferias_coletivas', 'fgts', 1, NULL),
  ('ferias_coletivas', 'inss', 1, NULL),
  ('ferias_coletivas', 'irrf', 1, NULL);

-- Atraso de uma parte; sem linha, vale o do valor líquido do evento.
CREATE FUNCTION public.payroll_lag(_event TEXT, _part TEXT) RETURNS INT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT lag FROM public.payroll_payment_rules WHERE event = _event AND part = _part),
    (SELECT lag FROM public.payroll_payment_rules WHERE event = _event AND part = 'liquido'),
    0)
$$;

-- ───────────── Férias coletivas no calendário ─────────────
ALTER TABLE public.payroll_calendar
  ADD COLUMN collective BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN days_next_year INT CHECK (days_next_year >= 0),
  ADD COLUMN salary_days INT CHECK (salary_days BETWEEN 0 AND 31),
  ADD COLUMN next_salary_days INT CHECK (next_salary_days BETWEEN 0 AND 31);
COMMENT ON COLUMN public.payroll_calendar.collective IS
  'Férias coletivas: pagas inteiras (dias + terço) no mês, e reduzem os salários pelos dias de salário informados.';
COMMENT ON COLUMN public.payroll_calendar.days_next_year IS 'Dos dias das férias, quantos caem no ano seguinte.';
COMMENT ON COLUMN public.payroll_calendar.salary_days IS 'Dias de salário na folha do mês das férias coletivas.';
COMMENT ON COLUMN public.payroll_calendar.next_salary_days IS 'Dias de salário na folha de janeiro seguinte.';

UPDATE public.payroll_calendar
SET collective = true, days = 19, days_next_year = 8, salary_days = 19, next_salary_days = 23,
    note = 'Férias coletivas: 11 dias em dezembro e 8 em janeiro, pagas em dezembro'
WHERE kind = 'ferias' AND month = 12;

-- ───────────── Cada regra de encargo diz a que parte pertence ─────────────
ALTER TABLE public.calc_rules ADD COLUMN payment_component TEXT CHECK (payment_component IN ('fgts', 'inss'));
COMMENT ON COLUMN public.calc_rules.payment_component IS
  'Encargo sobre a remuneração: paga junto com o FGTS ou com o INSS (tabela Quando cada valor é pago). Vazio = INSS.';
UPDATE public.calc_rules SET payment_component = CASE WHEN name = 'FGTS' THEN 'fgts' ELSE 'inss' END
WHERE base_kind = 'salario';

-- ───────────── A folha por mês de pagamento ─────────────
-- Uma linha por pessoa, mês de pagamento, origem e parte. As partes liquido, inss_emp, irrf, inss_inf e irrf_inf somam o
-- que a pessoa custa de remuneração; base_fgts e base_inss são a base dos encargos de cada parte.
-- prior = veio do ano anterior (calculado pelo salário de janeiro da pessoa).
CREATE FUNCTION public.payroll_cash(_version_id UUID, _scenario_id UUID DEFAULT NULL, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (person_id UUID, unit_id UUID, contract_type_id UUID, account_id UUID, month INT, source TEXT,
               prior BOOLEAN, part TEXT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(expense_variation, 0) AS ev, COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ), yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  defs AS (
    SELECT (SELECT id FROM public.parameter_definitions WHERE key = 'terco_ferias') AS terco,
           (SELECT id FROM public.parameter_definitions WHERE key = 'decimo_terceiro') AS d13
  ),
  col AS (
    SELECT c.month, c.days, c.salary_days, c.next_salary_days FROM public.payroll_calendar c
    WHERE c.kind = 'ferias' AND c.collective ORDER BY c.month LIMIT 1
  ),
  pm AS (
    SELECT p.id AS person_id, p.unit_id, p.contract_type_id, ct.account_id, ct.withholds, p.dependents,
           p.inss_override, p.irrf_override, v.month,
           SUM(v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END) AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.contract_types ct ON ct.id = p.contract_type_id
    JOIN public.plan_values v ON v.line_id = l.id
    CROSS JOIN s
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    GROUP BY p.id, p.unit_id, p.contract_type_id, ct.account_id, ct.withholds, p.dependents,
             p.inss_override, p.irrf_override, v.month
  ),
  person AS (
    -- Uma linha por pessoa, com o salário de janeiro (base do ano anterior) e o 13º do ano.
    SELECT pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id, pm.withholds, pm.dependents,
      COALESCE(MAX(pm.gross) FILTER (WHERE pm.month = 1), 0) AS jan,
      COALESCE(MAX(pm.gross) FILTER (WHERE pm.month = 12), 0) * COUNT(*) FILTER (WHERE pm.gross > 0) / 12.0 AS months13
    FROM pm GROUP BY 1, 2, 3, 4, 5, 6
  ),
  -- Quem tem férias: terço de férias no vínculo.
  fer AS (
    SELECT p.person_id, y.year,
      COALESCE(public.param_value(d.terco, make_date(y.year, 1, 1), p.unit_id, NULL, p.contract_type_id, NULL), 0) AS terco
    FROM person p CROSS JOIN yr y0 CROSS JOIN defs d
    CROSS JOIN LATERAL (VALUES (y0.year), (y0.year - 1)) y(year)
  ),
  -- Salário por competência, com os dias da coletiva. Do ano anterior, só os meses pagos neste ano.
  sal AS (
    SELECT pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id, pm.withholds, pm.dependents,
      pm.inss_override, pm.irrf_override, false AS prior, yr.year, pm.month AS comp,
      round(pm.gross * CASE
        WHEN f.terco > 0 AND pm.month = col.month AND col.salary_days IS NOT NULL THEN col.salary_days / 30.0
        WHEN f.terco > 0 AND pm.month = 1 AND col.next_salary_days IS NOT NULL THEN col.next_salary_days / 30.0
        ELSE 1 END, 2) AS g
    FROM pm CROSS JOIN yr
    LEFT JOIN col ON true
    JOIN fer f ON f.person_id = pm.person_id AND f.year = yr.year
    UNION ALL
    SELECT p.person_id, p.unit_id, p.contract_type_id, p.account_id, p.withholds, p.dependents,
      pp.inss_override, pp.irrf_override, true, yr.year - 1, m.comp,
      round(p.jan * CASE
        WHEN f.terco > 0 AND m.comp = col.month AND col.salary_days IS NOT NULL THEN col.salary_days / 30.0
        ELSE 1 END, 2)
    FROM person p CROSS JOIN yr
    JOIN public.people pp ON pp.id = p.person_id
    LEFT JOIN col ON true
    JOIN fer f ON f.person_id = p.person_id AND f.year = yr.year - 1
    CROSS JOIN LATERAL generate_series(13 - public.payroll_lag('salario', 'liquido'), 12) m(comp)
    WHERE p.jan > 0
  ),
  sal2 AS (
    SELECT sal.*, make_date(sal.year, sal.comp, 1) AS ref,
      CASE WHEN sal.g <= 0 OR NOT sal.withholds THEN 0
           WHEN sal.inss_override IS NOT NULL THEN sal.inss_override
           ELSE public.inss_empregado(sal.g, make_date(sal.year, sal.comp, 1)) END AS inss
    FROM sal
  ),
  sal3 AS (
    SELECT sal2.*,
      CASE WHEN sal2.g <= 0 OR NOT sal2.withholds THEN 0
           WHEN sal2.irrf_override IS NOT NULL THEN sal2.irrf_override
           ELSE public.irrf(sal2.g, sal2.inss, sal2.dependents, sal2.ref) END AS ir
    FROM sal2
  ),
  -- 13º: a 1ª parcela sai sem descontos; a 2ª leva o INSS e o IRRF do 13º inteiro. O FGTS vai por parcela.
  d13 AS (
    SELECT p.person_id, p.unit_id, p.contract_type_id, p.account_id, p.withholds, p.dependents, x.prior, x.year,
      round(x.base * COALESCE(public.param_value(d.d13, make_date(x.year, 12, 1), p.unit_id, NULL,
        p.contract_type_id, NULL), 0), 2) AS total
    FROM person p CROSS JOIN yr CROSS JOIN defs d
    CROSS JOIN LATERAL (VALUES (false, yr.year, p.months13), (true, yr.year - 1, p.jan)) x(prior, year, base)
  ),
  parcels AS (
    SELECT c.month, c.share, c.month = MAX(c.month) OVER () AS is_last
    FROM public.payroll_calendar c WHERE c.kind = 'decimo_terceiro'
  ),
  d13b AS (
    SELECT d.*, pc.month AS comp, pc.share, pc.is_last,
      CASE WHEN pc.is_last THEN 'decimo_2' ELSE 'decimo_1' END AS event,
      CASE WHEN pc.is_last AND d.withholds THEN public.inss_empregado(d.total, make_date(d.year, 12, 1)) ELSE 0 END AS inss
    FROM d13 d CROSS JOIN parcels pc WHERE d.total > 0
  ),
  d13c AS (
    SELECT d13b.*,
      CASE WHEN d13b.is_last AND d13b.withholds
           THEN public.irrf(d13b.total, d13b.inss, d13b.dependents, make_date(d13b.year, 12, 1)) ELSE 0 END AS ir
    FROM d13b
  ),
  -- Férias coletivas: os dias e o terço, pagos inteiros no mês.
  fc AS (
    SELECT p.person_id, p.unit_id, p.contract_type_id, p.account_id, p.withholds, p.dependents, x.prior, x.year,
      col.month AS comp, round(x.base / 30.0 * col.days * (1 + f.terco), 2) AS total
    FROM person p CROSS JOIN yr CROSS JOIN col
    CROSS JOIN LATERAL (VALUES
      (false, yr.year, COALESCE((SELECT pm.gross FROM pm WHERE pm.person_id = p.person_id AND pm.month = col.month), 0)),
      (true, yr.year - 1, p.jan)) x(prior, year, base)
    JOIN fer f ON f.person_id = p.person_id AND f.year = x.year
    WHERE f.terco > 0 AND x.base > 0
  ),
  fc2 AS (
    SELECT fc.*, CASE WHEN fc.withholds THEN public.inss_empregado(fc.total, make_date(fc.year, fc.comp, 1)) ELSE 0 END AS inss
    FROM fc
  ),
  fc3 AS (
    SELECT fc2.*, CASE WHEN fc2.withholds
      THEN public.irrf(fc2.total, fc2.inss, fc2.dependents, make_date(fc2.year, fc2.comp, 1)) ELSE 0 END AS ir
    FROM fc2
  ),
  -- Férias individuais: só o terço, no mês, como antes.
  fi AS (
    SELECT pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id, pm.month,
      round(pm.gross / 30 * SUM(c.days) * COALESCE(public.param_value(d.terco, make_date(yr.year, pm.month, 1),
        pm.unit_id, NULL, pm.contract_type_id, NULL), 0), 2) AS amount
    FROM pm CROSS JOIN yr CROSS JOIN defs d
    JOIN public.payroll_calendar c ON c.kind = 'ferias' AND NOT c.collective AND c.month = pm.month
    WHERE pm.gross > 0
    GROUP BY pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id, pm.month, pm.gross, yr.year, d.terco
  ),
  parts AS (
    -- Salário
    SELECT x.person_id, x.unit_id, x.contract_type_id, x.account_id, x.prior, x.comp, 'salario' AS source,
      'salario' AS event, y.part, y.lagpart, y.amount
    FROM sal3 x CROSS JOIN LATERAL (VALUES
      ('liquido', 'liquido', x.g - x.inss - x.ir),
      ('inss_emp', 'inss', x.inss),
      ('irrf', 'irrf', x.ir),
      ('inss_inf', 'inss', CASE WHEN NOT x.withholds AND x.g > 0 THEN x.inss_override END),
      ('irrf_inf', 'irrf', CASE WHEN NOT x.withholds AND x.g > 0 THEN x.irrf_override END),
      ('base_fgts', 'fgts', x.g),
      ('base_inss', 'inss', x.g)) y(part, lagpart, amount)
    UNION ALL
    SELECT x.person_id, x.unit_id, x.contract_type_id, x.account_id, x.prior, x.comp, 'decimo_terceiro', x.event,
      y.part, y.lagpart, y.amount
    FROM d13c x CROSS JOIN LATERAL (VALUES
      ('liquido', 'liquido', round(x.total * x.share, 2) - x.inss - x.ir),
      ('inss_emp', 'inss', x.inss),
      ('irrf', 'irrf', x.ir),
      ('base_fgts', 'fgts', round(x.total * x.share, 2)),
      ('base_inss', 'inss', CASE WHEN x.is_last THEN x.total ELSE 0 END)) y(part, lagpart, amount)
    UNION ALL
    SELECT x.person_id, x.unit_id, x.contract_type_id, x.account_id, x.prior, x.comp, 'ferias_coletivas',
      'ferias_coletivas', y.part, y.lagpart, y.amount
    FROM fc3 x CROSS JOIN LATERAL (VALUES
      ('liquido', 'liquido', x.total - x.inss - x.ir),
      ('inss_emp', 'inss', x.inss),
      ('irrf', 'irrf', x.ir),
      ('base_fgts', 'fgts', x.total),
      ('base_inss', 'inss', x.total)) y(part, lagpart, amount)
  )
  SELECT p.person_id, p.unit_id, p.contract_type_id, p.account_id,
    p.comp + public.payroll_lag(p.event, p.lagpart) - CASE WHEN p.prior THEN 12 ELSE 0 END, p.source, p.prior, p.part,
    p.amount
  FROM parts p
  WHERE COALESCE(p.amount, 0) <> 0
    AND p.comp + public.payroll_lag(p.event, p.lagpart) - CASE WHEN p.prior THEN 12 ELSE 0 END BETWEEN 1 AND 12
  UNION ALL
  SELECT fi.person_id, fi.unit_id, fi.contract_type_id, fi.account_id, fi.month, 'ferias', false, y.part, fi.amount
  FROM fi CROSS JOIN LATERAL (VALUES ('liquido'), ('base_fgts'), ('base_inss')) y(part)
  WHERE fi.amount > 0
$$;
REVOKE EXECUTE ON FUNCTION public.payroll_cash(UUID, UUID, UUID[]) FROM anon;

-- ───────────── Base do plano pelo mês do pagamento ─────────────
-- Remuneração (salario), 13º e férias (provisao) e INSS/IRRF informado do sócio (folha) somam na DRE. As linhas
-- base_fgts/base_inss (salário) e pbase_fgts/pbase_inss (13º e férias) só alimentam as regras de encargo da mesma parte.
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
  )
  -- Linhas lançadas nas grades e itens de eventos (a remuneração de pessoas vem abaixo)
  SELECT l.unit_id, v.month, a.kind, a.id, a.dre_line_id, l.revenue_type_id, l.product_id, NULL::UUID,
    v.amount * CASE a.kind WHEN 'receita' THEN 1 + s.rv
                           WHEN 'despesa' THEN 1 + s.ev
                           ELSE CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END END
  FROM public.plan_lines l
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts a ON a.id = l.account_id
  CROSS JOIN s
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    AND l.person_id IS NULL
  UNION ALL
  -- Pessoas, no mês do pagamento
  SELECT c.unit_id, c.month, k.row_kind, c.account_id,
    CASE WHEN k.row_kind LIKE '%base\_%' THEN NULL ELSE a.dre_line_id END,
    NULL::UUID, NULL::UUID, c.contract_type_id, SUM(c.amount)
  FROM public.payroll_cash(_version_id, _scenario_id, _unit_ids) c
  JOIN public.accounts a ON a.id = c.account_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN c.part IN ('base_fgts', 'base_inss') THEN
      CASE WHEN c.source = 'salario' THEN '' ELSE 'p' END || 'base_' || substr(c.part, 6)
    WHEN c.part IN ('inss_inf', 'irrf_inf') THEN 'folha'
    WHEN c.source = 'salario' THEN 'salario'
    ELSE 'provisao' END AS row_kind) k
  GROUP BY c.unit_id, c.month, k.row_kind, c.account_id, a.dre_line_id, c.contract_type_id
  UNION ALL
  -- Headcount: 1 por pessoa nos meses em que há remuneração (base para benefícios por pessoa)
  SELECT l.unit_id, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
$function$;

-- Regra sobre a remuneração: incide na base da mesma parte (FGTS ou INSS); com on_provisions, também no 13º e nas férias.
CREATE FUNCTION public.rule_matches(_rule_base_kind TEXT, _rule_component TEXT, _on_provisions BOOLEAN, _row_kind TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _rule_base_kind = 'salario'
    THEN _row_kind = 'base_' || COALESCE(_rule_component, 'inss')
      OR (_on_provisions AND _row_kind = 'pbase_' || COALESCE(_rule_component, 'inss'))
    ELSE _rule_base_kind = _row_kind END
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
  ),
  leaf AS (
    SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
    FROM (
      SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b
      WHERE b.row_kind <> 'headcount' AND b.row_kind NOT LIKE '%base\_%'
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
  SELECT s.unit_id, s.month, s.bucket, SUM(s.amount) FROM (
    SELECT b.unit_id, b.month,
      CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END AS bucket, b.amount
    FROM base b WHERE b.row_kind IN ('receita', 'despesa', 'folha', 'salario', 'provisao')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$function$;

-- ───────────── Detalhe por pessoa, no mês do pagamento ─────────────
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
  c AS (
    SELECT c.*,
      CASE WHEN c.prior THEN ' · ' || (yr.year - 1) ELSE '' END AS suffix,
      CASE c.source WHEN 'decimo_terceiro' THEN '13º salário' WHEN 'ferias_coletivas' THEN 'Férias coletivas'
                    WHEN 'ferias' THEN 'Férias (1/3)' END AS label
    FROM public.payroll_cash(_version_id, _scenario_id, _unit_ids) c CROSS JOIN yr
  ),
  ben AS (
    -- Benefícios lançados por pessoa (assistência médica, vale-transporte…), item a item pela conta.
    SELECT l.benefit_person_id AS person_id, l.unit_id, v.month, a.name AS item,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS amount
    FROM public.plan_lines l
    JOIN public.plan_values v ON v.line_id = l.id
    JOIN public.accounts a ON a.id = l.account_id
    CROSS JOIN s
    WHERE l.version_id = _version_id AND l.benefit_person_id IS NOT NULL
      AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  ),
  hc AS (
    -- Regras por pessoa ativa, no mês da remuneração.
    SELECT p.id AS person_id, l.unit_id, v.month, r.payroll_group AS grupo, r.name AS item,
      COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, v.month, 1), l.unit_id, NULL,
        p.contract_type_id, NULL), 0) AS amount
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.contract_types ct ON ct.id = p.contract_type_id
    JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = 'headcount'
      AND (r.contract_type_ids IS NULL OR p.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR ct.account_id = ANY (r.account_ids))
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  ),
  charges AS (
    -- Encargos sobre a base de cada parte.
    SELECT c.person_id, c.unit_id, c.month, c.source, c.suffix, c.label, r.payroll_group AS grupo, r.name AS item,
      round(c.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, c.month, 1),
        c.unit_id, NULL, c.contract_type_id, NULL), 0), 2) AS amount
    FROM c CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = 'salario'
      AND c.part = 'base_' || COALESCE(r.payment_component, 'inss')
      AND (c.source = 'salario' OR r.on_provisions)
      AND (r.contract_type_ids IS NULL OR c.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR c.account_id = ANY (r.account_ids))
  ),
  out AS (
    -- Salário: bruto pago no mês, retenções e líquido
    SELECT c.person_id, c.unit_id, c.month, 'bruto' AS grupo, 'Salário bruto' || c.suffix AS item, c.amount
    FROM c WHERE c.source = 'salario' AND c.part IN ('liquido', 'inss_emp', 'irrf')
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'retencao', 'INSS do empregado' || c.suffix, c.amount
    FROM c WHERE c.source = 'salario' AND c.part = 'inss_emp'
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'retencao', 'IRRF' || c.suffix, c.amount
    FROM c WHERE c.source = 'salario' AND c.part = 'irrf'
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'liquido', 'Salário líquido' || c.suffix, c.amount
    FROM c WHERE c.source = 'salario' AND c.part = 'liquido'
    -- Sócio: INSS e IRRF informados são gasto da empresa
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'encargo',
      CASE c.part WHEN 'inss_inf' THEN 'INSS informado' ELSE 'IRRF informado' END || c.suffix, c.amount
    FROM c WHERE c.part IN ('inss_inf', 'irrf_inf')
    -- Encargos sobre o salário
    UNION ALL SELECT x.person_id, x.unit_id, x.month, COALESCE(x.grupo, 'encargo'), x.item || x.suffix, x.amount
    FROM charges x WHERE x.source = 'salario'
    -- 13º e férias: o que a pessoa recebe e, à parte, retenções e encargos
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'provisao', c.label || c.suffix, c.amount
    FROM c WHERE c.source <> 'salario' AND c.part = 'liquido'
    UNION ALL SELECT c.person_id, c.unit_id, c.month, 'provisao', c.label || c.suffix || ' · encargos', c.amount
    FROM c WHERE c.source <> 'salario' AND c.part IN ('inss_emp', 'irrf')
    UNION ALL SELECT x.person_id, x.unit_id, x.month, 'provisao', x.label || x.suffix || ' · encargos', x.amount
    FROM charges x WHERE x.source <> 'salario'
    UNION ALL SELECT h.person_id, h.unit_id, h.month, COALESCE(h.grupo, 'beneficio'), h.item, h.amount FROM hc h
    UNION ALL SELECT b.person_id, b.unit_id, b.month, 'beneficio', b.item, b.amount FROM ben b
  )
  SELECT o.person_id, o.unit_id, o.month, o.grupo, o.item, SUM(o.amount)
  FROM out o WHERE o.amount <> 0
  GROUP BY o.person_id, o.unit_id, o.month, o.grupo, o.item
  UNION ALL
  SELECT o.person_id, o.unit_id, o.month, 'custo_total', 'Custo total para a empresa', SUM(o.amount)
  FROM out o WHERE o.grupo NOT IN ('retencao', 'liquido')
  GROUP BY o.person_id, o.unit_id, o.month
$function$;
