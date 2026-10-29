-- 13º e férias no mês em que são pagos (calendário da folha), no lugar das provisões mensais por percentual.
-- Também: retenções por vínculo, IRRF informado por pessoa e reajuste dos benefícios por pessoa.

-- ───────────── Calendário da folha ─────────────
-- 13º: cada linha é uma parcela (fração do 13º do ano). Férias: cada linha é um período (dias), pago no mês.
CREATE TABLE public.payroll_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('decimo_terceiro', 'ferias')),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  share NUMERIC CHECK (share > 0 AND share <= 1),
  days INT CHECK (days > 0 AND days <= 30),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_calendar_amount CHECK (
    (kind = 'decimo_terceiro' AND share IS NOT NULL) OR (kind = 'ferias' AND days IS NOT NULL))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_calendar TO authenticated;
GRANT ALL ON public.payroll_calendar TO service_role;
ALTER TABLE public.payroll_calendar ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read payroll_calendar" ON public.payroll_calendar FOR SELECT TO authenticated
  USING (public.has_access(auth.uid()));
CREATE POLICY "Financeiro writes payroll_calendar" ON public.payroll_calendar FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_payroll_calendar AFTER INSERT OR UPDATE OR DELETE ON public.payroll_calendar
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_payroll_calendar BEFORE UPDATE ON public.payroll_calendar
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.payroll_calendar (kind, month, share, days, note) VALUES
  ('decimo_terceiro', 11, 0.5, NULL, '1ª parcela'),
  ('decimo_terceiro', 12, 0.5, NULL, '2ª parcela (com os descontos e os encargos do 13º)'),
  ('ferias', 10, NULL, 10, 'Férias individuais'),
  ('ferias', 12, NULL, 20, 'Férias coletivas (fim de dezembro e início de janeiro)');

-- ───────────── Parâmetros por vínculo: quem recebe 13º e terço de férias ─────────────
UPDATE public.parameter_definitions
SET key = 'decimo_terceiro', label = '13º salário', sort_order = 70,
    description = 'Quanto de um salário mensal a pessoa recebe de 13º no ano (100% = um salário), proporcional aos meses com remuneração. As parcelas ficam no Calendário da folha.'
WHERE key = 'provisao_13';
UPDATE public.parameter_definitions
SET key = 'terco_ferias', label = 'Terço de férias', sort_order = 71,
    description = 'Adicional sobre os dias de férias do Calendário da folha (1/3 = 33,33%). O resto das férias é salário adiantado. Zero para quem não tem férias.'
WHERE key = 'provisao_ferias';
-- As provisões mensais por percentual saem: 13º e férias passam a ser calculados pelo calendário.
DELETE FROM public.calc_rules WHERE payroll_group = 'provisao';
DROP FUNCTION public.provision_rate(DATE, UUID, UUID, UUID);

INSERT INTO public.parameter_values (definition_id, value, valid_from, contract_type_id, note)
SELECT d.id, v.value, DATE '2026-01-01', ct.id, 'Regra do financeiro (out/2026)'
FROM (VALUES ('decimo_terceiro', 'CLT', 1::NUMERIC), ('decimo_terceiro', 'Sócio (pró-labore)', 1),
             ('terco_ferias', 'CLT', 1::NUMERIC / 3)) AS v(key, contract_type, value)
JOIN public.parameter_definitions d ON d.key = v.key
JOIN public.contract_types ct ON ct.name = v.contract_type;

COMMENT ON COLUMN public.calc_rules.on_provisions IS
  'Só para regras sobre a remuneração: o encargo incide também sobre o 13º e o terço de férias.';

-- ───────────── Retenções por vínculo e IRRF informado por pessoa ─────────────
ALTER TABLE public.contract_types ADD COLUMN withholds BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN public.contract_types.withholds IS
  'Desconta INSS e IRRF do empregado pelas tabelas. Desligado (ex.: sócios), só desconta o IRRF informado na pessoa.';
UPDATE public.contract_types SET withholds = false WHERE name = 'Sócio (pró-labore)';

ALTER TABLE public.people ADD COLUMN irrf_override NUMERIC CHECK (irrf_override >= 0);
COMMENT ON COLUMN public.people.irrf_override IS 'IRRF mensal informado à mão; substitui o cálculo pela tabela.';

-- ───────────── Eventos da folha: 13º e terço de férias por pessoa e mês ─────────────
-- amount: o que é pago no mês. charge_base: base dos encargos naquele mês (o 13º inteiro na última parcela).
CREATE OR REPLACE FUNCTION public.payroll_events(_version_id UUID, _scenario_id UUID DEFAULT NULL, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (person_id UUID, unit_id UUID, month INT, kind TEXT, contract_type_id UUID, account_id UUID,
               amount NUMERIC, charge_base NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(expense_variation, 0) AS ev, COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ), yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  pm AS (
    SELECT p.id AS person_id, p.unit_id, p.contract_type_id, ct.account_id, v.month,
           SUM(v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END) AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.contract_types ct ON ct.id = p.contract_type_id
    JOIN public.plan_values v ON v.line_id = l.id
    CROSS JOIN s
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    GROUP BY p.id, p.unit_id, p.contract_type_id, ct.account_id, v.month
  ),
  d13 AS (
    -- 13º do ano: salário de dezembro × meses com remuneração / 12 × percentual do vínculo.
    SELECT pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id,
      COALESCE(MAX(pm.gross) FILTER (WHERE pm.month = 12), 0) * COUNT(*) FILTER (WHERE pm.gross > 0) / 12.0
        * COALESCE(public.param_value((SELECT id FROM public.parameter_definitions WHERE key = 'decimo_terceiro'),
            make_date(yr.year, 12, 1), pm.unit_id, NULL, pm.contract_type_id, NULL), 0) AS total
    FROM pm CROSS JOIN yr
    GROUP BY pm.person_id, pm.unit_id, pm.contract_type_id, pm.account_id, yr.year
  ),
  last13 AS (SELECT MAX(c.month) AS month FROM public.payroll_calendar c WHERE c.kind = 'decimo_terceiro')
  SELECT d.person_id, d.unit_id, c.month, 'decimo_terceiro', d.contract_type_id, d.account_id,
    round(d.total * c.share, 2), CASE WHEN c.month = last13.month THEN round(d.total, 2) ELSE 0 END
  FROM d13 d CROSS JOIN last13
  JOIN public.payroll_calendar c ON c.kind = 'decimo_terceiro'
  WHERE d.total > 0
  UNION ALL
  SELECT f.person_id, f.unit_id, f.month, 'ferias', f.contract_type_id, f.account_id, f.amount, f.amount
  FROM (
    SELECT pm.person_id, pm.unit_id, pm.month, pm.contract_type_id, pm.account_id,
      round(pm.gross / 30 * SUM(c.days) * COALESCE(public.param_value(
        (SELECT id FROM public.parameter_definitions WHERE key = 'terco_ferias'),
        make_date(yr.year, pm.month, 1), pm.unit_id, NULL, pm.contract_type_id, NULL), 0), 2) AS amount
    FROM pm CROSS JOIN yr
    JOIN public.payroll_calendar c ON c.kind = 'ferias' AND c.month = pm.month
    WHERE pm.gross > 0
    GROUP BY pm.person_id, pm.unit_id, pm.month, pm.contract_type_id, pm.account_id, pm.gross, yr.year
  ) f
  WHERE f.amount > 0
$$;
REVOKE EXECUTE ON FUNCTION public.payroll_events(UUID, UUID, UUID[]) FROM anon;

-- ───────────── Base do plano: 13º e férias entram na DRE; os encargos incidem sobre eles ─────────────
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
  -- Pessoas: a remuneração é a linha da pessoa
  SELECT l.unit_id, v.month, 'salario', ct.account_id, a.dre_line_id, NULL::UUID, NULL::UUID, p.contract_type_id,
    v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.contract_types ct ON ct.id = p.contract_type_id
  JOIN public.accounts a ON a.id = ct.account_id
  CROSS JOIN s
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  UNION ALL
  -- 13º e terço de férias, no mês em que são pagos, na linha da DRE da remuneração
  SELECT e.unit_id, e.month, 'provisao', e.account_id, a.dre_line_id, NULL::UUID, NULL::UUID, e.contract_type_id, e.amount
  FROM public.payroll_events(_version_id, _scenario_id, _unit_ids) e
  JOIN public.accounts a ON a.id = e.account_id
  UNION ALL
  -- Base dos encargos sobre o 13º e o terço (não soma na DRE; só alimenta as regras marcadas)
  SELECT e.unit_id, e.month, 'provisao_base', e.account_id, NULL::UUID, NULL::UUID, NULL::UUID, e.contract_type_id, e.charge_base
  FROM public.payroll_events(_version_id, _scenario_id, _unit_ids) e
  WHERE e.charge_base > 0
  UNION ALL
  -- Headcount: 1 por pessoa nos meses em que há remuneração (base para benefícios por pessoa)
  SELECT l.unit_id, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
$function$;

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
      AND (r.base_kind = b.row_kind OR (b.row_kind = 'provisao_base' AND r.base_kind = 'salario' AND r.on_provisions))
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  ),
  leaf AS (
    SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
    FROM (
      SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b WHERE b.row_kind NOT IN ('headcount', 'provisao_base')
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
      AND (r.base_kind = b.row_kind OR (b.row_kind = 'provisao_base' AND r.base_kind = 'salario' AND r.on_provisions))
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

-- ───────────── Detalhe por pessoa na Folha ─────────────
-- 13º: a 2ª parcela sai líquida (menos INSS e IRRF do 13º, para quem tem retenção); esses descontos e os encargos
-- patronais aparecem em "13º salário · encargos". Férias: o terço e os encargos sobre ele.
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
    SELECT p.id AS person_id, p.unit_id, v.month, p.contract_type_id, p.dependents, p.irrf_override, ct.withholds,
           l.account_id, make_date(yr.year, v.month, 1) AS ref,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.contract_types ct ON ct.id = p.contract_type_id
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
    SELECT pm.*, CASE WHEN pm.withholds THEN public.inss_empregado(pm.gross, pm.ref) ELSE 0 END AS inss FROM pm
  ), ret2 AS (
    SELECT ret.*,
      CASE WHEN ret.gross <= 0 THEN 0
           WHEN ret.irrf_override IS NOT NULL THEN ret.irrf_override
           WHEN ret.withholds THEN public.irrf(ret.gross, ret.inss, ret.dependents, ret.ref)
           ELSE 0 END AS ir
    FROM ret
  ), rules AS (
    SELECT r2.person_id, r2.unit_id, r2.month, c.payroll_group AS grupo, c.name AS item,
      CASE c.base_kind WHEN 'salario' THEN r2.gross ELSE CASE WHEN r2.gross > 0 THEN 1 ELSE 0 END END
        * COALESCE(public.param_value(c.parameter_definition_id, r2.ref, r2.unit_id, NULL, r2.contract_type_id, NULL), 0) AS amount
    FROM ret2 r2
    JOIN public.calc_rules c ON c.active AND c.base_kind IN ('salario', 'headcount')
      AND (c.contract_type_ids IS NULL OR r2.contract_type_id = ANY (c.contract_type_ids))
      AND (c.account_ids IS NULL OR r2.account_id = ANY (c.account_ids))
  ), ev AS (
    SELECT e.*, p.dependents, ct.withholds, make_date(yr.year, e.month, 1) AS ref,
      CASE e.kind WHEN 'decimo_terceiro' THEN '13º salário' ELSE 'Férias (1/3)' END AS label
    FROM public.payroll_events(_version_id, _scenario_id, _unit_ids) e
    JOIN public.people p ON p.id = e.person_id
    JOIN public.contract_types ct ON ct.id = e.contract_type_id
    CROSS JOIN yr
  ), ev2 AS (
    SELECT ev.*,
      round(ev.charge_base * COALESCE((
        SELECT SUM(public.param_value(c.parameter_definition_id, ev.ref, ev.unit_id, NULL, ev.contract_type_id, NULL))
        FROM public.calc_rules c
        WHERE c.active AND c.on_provisions AND c.base_kind = 'salario'
          AND (c.contract_type_ids IS NULL OR ev.contract_type_id = ANY (c.contract_type_ids))
          AND (c.account_ids IS NULL OR ev.account_id = ANY (c.account_ids))), 0), 2) AS charges,
      CASE WHEN ev.kind = 'decimo_terceiro' AND ev.charge_base > 0 AND ev.withholds
           THEN public.inss_empregado(ev.charge_base, ev.ref) ELSE 0 END AS inss
    FROM ev
  ), ev3 AS (
    SELECT ev2.*,
      CASE WHEN ev2.kind = 'decimo_terceiro' AND ev2.charge_base > 0 AND ev2.withholds
           THEN public.irrf(ev2.charge_base, ev2.inss, ev2.dependents, ev2.ref) ELSE 0 END AS ir
    FROM ev2
  ), cost AS (
    SELECT r2.person_id, r2.unit_id, r2.month, r2.gross AS amount FROM ret2 r2
    UNION ALL SELECT x.person_id, x.unit_id, x.month, x.amount FROM rules x
    UNION ALL SELECT e.person_id, e.unit_id, e.month, e.amount + e.charges FROM ev3 e
    UNION ALL SELECT b.person_id, b.unit_id, b.month, b.amount FROM ben b
  )
  SELECT person_id, unit_id, month, 'bruto', 'Salário bruto', gross FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'INSS do empregado', inss FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'IRRF', ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'liquido', 'Salário líquido', gross - inss - ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, COALESCE(grupo, 'encargo'), item, amount FROM rules
  UNION ALL SELECT person_id, unit_id, month, 'provisao', label, amount - inss - ir FROM ev3
  UNION ALL SELECT person_id, unit_id, month, 'provisao', label || ' · encargos', charges + inss + ir FROM ev3
    WHERE charge_base > 0
  UNION ALL SELECT person_id, unit_id, month, 'beneficio', item, amount FROM ben
  UNION ALL SELECT person_id, unit_id, month, 'custo_total', 'Custo total para a empresa', SUM(amount)
    FROM cost GROUP BY person_id, unit_id, month
$function$;

-- ───────────── Reajuste dos benefícios por pessoa ─────────────
-- Um reajuste por benefício e versão: o valor de cada pessoa sobe X% a partir do mês.
CREATE TABLE public.benefit_adjustments (
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  pct NUMERIC NOT NULL CHECK (pct > -1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  PRIMARY KEY (version_id, account_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.benefit_adjustments TO authenticated;
GRANT ALL ON public.benefit_adjustments TO service_role;
ALTER TABLE public.benefit_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read benefit_adjustments" ON public.benefit_adjustments FOR SELECT TO authenticated
  USING (public.has_access(auth.uid()));
CREATE POLICY "Financeiro writes benefit_adjustments" ON public.benefit_adjustments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_benefit_adjustments AFTER INSERT OR DELETE OR UPDATE ON public.benefit_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_benefit_adjustments BEFORE UPDATE ON public.benefit_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.sync_person_benefits(_person_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.people%ROWTYPE;
  b RECORD;
  _line UUID;
BEGIN
  SELECT * INTO p FROM public.people WHERE id = _person_id;
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM public.plan_lines l
  WHERE l.benefit_person_id = _person_id
    AND NOT EXISTS (SELECT 1 FROM public.person_benefits pb WHERE pb.person_id = _person_id AND pb.account_id = l.account_id);

  FOR b IN SELECT pb.account_id, pb.amount, ba.month AS adj_month, ba.pct AS adj_pct
           FROM public.person_benefits pb
           LEFT JOIN public.benefit_adjustments ba ON ba.version_id = p.version_id AND ba.account_id = pb.account_id
           WHERE pb.person_id = _person_id LOOP
    SELECT id INTO _line FROM public.plan_lines WHERE benefit_person_id = _person_id AND account_id = b.account_id;
    IF _line IS NULL THEN
      INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, origin, benefit_person_id, created_by)
      VALUES (p.version_id, p.unit_id, b.account_id, p.name, 'beneficio', _person_id, auth.uid())
      RETURNING id INTO _line;
    END IF;

    DELETE FROM public.plan_values v
    WHERE v.line_id = _line
      AND NOT EXISTS (SELECT 1 FROM public.plan_lines s JOIN public.plan_values sv ON sv.line_id = s.id
                      WHERE s.person_id = _person_id AND sv.month = v.month AND sv.amount > 0);
    -- Valor do mês: o valor mensal, com o reajuste do benefício a partir do mês dele.
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _line, m.month, m.amount
    FROM (
      SELECT DISTINCT sv.month,
        round(b.amount * CASE WHEN sv.month >= b.adj_month THEN 1 + b.adj_pct ELSE 1 END, 2) AS amount
      FROM public.plan_lines s JOIN public.plan_values sv ON sv.line_id = s.id
      WHERE s.person_id = _person_id AND sv.amount > 0
    ) m
    WHERE NOT EXISTS (SELECT 1 FROM public.plan_values x WHERE x.line_id = _line AND x.month = m.month AND x.amount = m.amount)
    ON CONFLICT (line_id, month) DO UPDATE SET amount = EXCLUDED.amount;

    -- A base do Omie desta conta na unidade passa a ser só referência.
    IF EXISTS (SELECT 1 FROM public.plan_lines WHERE version_id = p.version_id AND unit_id = p.unit_id
               AND account_id = b.account_id AND origin = 'gerada') THEN
      INSERT INTO public.benefit_bases (version_id, unit_id, account_id, amount)
      SELECT p.version_id, p.unit_id, b.account_id, COALESCE(SUM(v.amount), 0)
      FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id
      WHERE l.version_id = p.version_id AND l.unit_id = p.unit_id AND l.account_id = b.account_id AND l.origin = 'gerada'
      ON CONFLICT (version_id, unit_id, account_id) DO UPDATE SET amount = EXCLUDED.amount;
      DELETE FROM public.plan_lines WHERE version_id = p.version_id AND unit_id = p.unit_id
        AND account_id = b.account_id AND origin = 'gerada';
    END IF;
  END LOOP;
END;
$function$;

-- Reajuste criado, mudado ou apagado: refaz o benefício de quem tem aquela conta na versão.
CREATE OR REPLACE FUNCTION public.benefit_adjustments_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _version UUID := COALESCE(NEW.version_id, OLD.version_id);
  _account UUID := COALESCE(NEW.account_id, OLD.account_id);
  r RECORD;
BEGIN
  FOR r IN SELECT pb.person_id FROM public.person_benefits pb JOIN public.people p ON p.id = pb.person_id
           WHERE p.version_id = _version AND pb.account_id = _account LOOP
    PERFORM public.sync_person_benefits(r.person_id);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.benefit_adjustments_sync() FROM anon, authenticated;
CREATE TRIGGER benefit_adjustments_sync AFTER INSERT OR UPDATE OR DELETE ON public.benefit_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.benefit_adjustments_sync();

-- ───────────── Cópia de versão: leva o IRRF informado e os reajustes dos benefícios ─────────────
CREATE OR REPLACE FUNCTION public.copy_version(_source_id uuid, _name text, _year integer, _kind text DEFAULT 'forecast'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new UUID;
  _old_id UUID;
  _new_id UUID;
  _event_map JSONB := '{}'::JSONB;
  _person_map JSONB := '{}'::JSONB;
  rec RECORD;
BEGIN
  IF NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Apenas o financeiro cria versões.';
  END IF;
  INSERT INTO public.budget_versions (year, name, kind, status, base_version_id, first_editable_month)
  SELECT _year, _name, _kind, 'rascunho', id, first_editable_month FROM public.budget_versions WHERE id = _source_id
  RETURNING id INTO _new;
  IF _new IS NULL THEN RAISE EXCEPTION 'Versão de origem não encontrada.'; END IF;

  INSERT INTO public.scenarios (version_id, name, revenue_variation, expense_variation, applies_to_payroll, is_official, sort_order)
  SELECT _new, name, revenue_variation, expense_variation, applies_to_payroll, is_official, sort_order
  FROM public.scenarios WHERE version_id = _source_id;

  PERFORM set_config('app.skip_person_seed', 'on', true);
  FOR rec IN SELECT * FROM public.people WHERE version_id = _source_id LOOP
    INSERT INTO public.people (version_id, unit_id, name, role_title, contract_type_id, base_salary, start_month,
      end_month, external_id, hire_date, dependents, irrf_override)
    VALUES (_new, rec.unit_id, rec.name, rec.role_title, rec.contract_type_id, rec.base_salary, rec.start_month,
      rec.end_month, rec.external_id, rec.hire_date, rec.dependents, rec.irrf_override)
    RETURNING id INTO _new_id;
    _person_map := _person_map || jsonb_build_object(rec.id::TEXT, _new_id);
  END LOOP;
  PERFORM set_config('app.skip_person_seed', 'off', true);

  FOR rec IN SELECT * FROM public.events WHERE version_id = _source_id LOOP
    INSERT INTO public.events (version_id, unit_id, product_id, name, month, created_by)
    VALUES (_new, rec.unit_id, rec.product_id, rec.name, rec.month, auth.uid())
    RETURNING id INTO _new_id;
    _event_map := _event_map || jsonb_build_object(rec.id::TEXT, _new_id);
  END LOOP;

  -- Os benefícios por pessoa são refeitos a partir de person_benefits, abaixo.
  FOR rec IN SELECT * FROM public.plan_lines WHERE version_id = _source_id AND benefit_person_id IS NULL LOOP
    _old_id := rec.id;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
      revenue_type_id, event_id, person_id, revenue_origin, note, conditional, condition_note, origin, sort_order,
      created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, (_event_map ->> rec.event_id::TEXT)::UUID, (_person_map ->> rec.person_id::TEXT)::UUID,
      rec.revenue_origin, rec.note, rec.conditional, rec.condition_note, rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  INSERT INTO public.benefit_bases (version_id, unit_id, account_id, amount)
  SELECT _new, unit_id, account_id, amount FROM public.benefit_bases WHERE version_id = _source_id;
  INSERT INTO public.benefit_adjustments (version_id, account_id, month, pct)
  SELECT _new, account_id, month, pct FROM public.benefit_adjustments WHERE version_id = _source_id;
  INSERT INTO public.person_benefits (person_id, account_id, amount)
  SELECT (_person_map ->> pb.person_id::TEXT)::UUID, pb.account_id, pb.amount
  FROM public.person_benefits pb JOIN public.people p ON p.id = pb.person_id
  WHERE p.version_id = _source_id;

  RETURN _new;
END;
$function$;
