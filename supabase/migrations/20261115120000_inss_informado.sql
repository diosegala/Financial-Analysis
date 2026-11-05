-- INSS informado em cada pessoa, como o IRRF: varia por sócio (valor e percentual). É retenção: reduz o líquido, não o custo.
ALTER TABLE public.people ADD COLUMN inss_override NUMERIC CHECK (inss_override >= 0);
COMMENT ON COLUMN public.people.inss_override IS 'INSS mensal informado à mão; substitui o cálculo pela tabela.';
COMMENT ON COLUMN public.contract_types.withholds IS
  'Desconta INSS e IRRF do empregado pelas tabelas. Desligado (ex.: sócios), só desconta o INSS e o IRRF informados na pessoa.';

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
    SELECT p.id AS person_id, p.unit_id, v.month, p.contract_type_id, p.dependents, p.irrf_override, p.inss_override, ct.withholds,
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
    SELECT pm.*,
      CASE WHEN pm.gross <= 0 THEN 0
           WHEN pm.inss_override IS NOT NULL THEN pm.inss_override
           WHEN pm.withholds THEN public.inss_empregado(pm.gross, pm.ref)
           ELSE 0 END AS inss
    FROM pm
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
      end_month, external_id, hire_date, dependents, irrf_override, inss_override)
    VALUES (_new, rec.unit_id, rec.name, rec.role_title, rec.contract_type_id, rec.base_salary, rec.start_month,
      rec.end_month, rec.external_id, rec.hire_date, rec.dependents, rec.irrf_override, rec.inss_override)
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
