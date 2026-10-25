-- Metas: guardar o detalhe do cálculo (custos por tipo e a alíquota de cada unidade) para a tela explicar, passo a
-- passo, como se chega à receita necessária, com os números do momento do cálculo.
ALTER TABLE public.scenario_targets ADD COLUMN breakdown JSONB;

CREATE OR REPLACE FUNCTION public.compute_targets(_scenario_id UUID) RETURNS public.scenario_targets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sc public.scenarios%ROWTYPE;
  st public.scenario_targets%ROWTYPE;
  _year INT;
  _f NUMERIC;
  _rfin NUMERIC;
  _v NUMERIC := 0;
  _vu NUMERIC;
  _sum_shares NUMERIC;
  _a NUMERIC;
  _m NUMERIC;
  _r NUMERIC;
  _den NUMERIC;
  _pay NUMERIC;
  _exp NUMERIC;
  _units JSONB := '[]'::JSONB;
  u RECORD;
  w RECORD;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro calcula metas.';
  END IF;
  SELECT * INTO sc FROM public.scenarios WHERE id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cenário não encontrado.'; END IF;
  SELECT * INTO st FROM public.scenario_targets WHERE scenario_id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Defina o alvo do cenário antes de calcular.'; END IF;
  IF st.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'A meta deste cenário está publicada. Reabra a meta para recalcular.';
  END IF;
  SELECT year INTO _year FROM public.budget_versions WHERE id = sc.version_id;

  SELECT COALESCE(SUM(amount) FILTER (WHERE bucket = 'folha'), 0), COALESCE(SUM(amount) FILTER (WHERE bucket = 'despesa'), 0)
  INTO _pay, _exp
  FROM public.plan_split(sc.version_id, _scenario_id);
  _f := _pay + _exp;
  SELECT COALESCE(SUM(s.amount), 0) INTO _rfin
  FROM public.plan_split(sc.version_id, _scenario_id) s
  JOIN public.units un ON un.id = s.unit_id AND un.kind = 'apoio' WHERE s.bucket = 'receita';

  SELECT COALESCE(SUM(share), 0) INTO _sum_shares
  FROM public.target_unit_shares sh JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
  WHERE sh.scenario_id = _scenario_id;
  IF abs(_sum_shares - 1) > 0.0001 THEN
    RAISE EXCEPTION 'As participações das unidades de negócio somam % por cento, e precisam somar 100.', round(_sum_shares * 100, 2);
  END IF;

  -- Alíquota variável ponderada: participação da unidade × (alíquota dela, ponderada pelos meses)
  FOR u IN SELECT sh.unit_id, sh.share, sh.variable_pct_override
           FROM public.target_unit_shares sh JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
           WHERE sh.scenario_id = _scenario_id AND sh.share > 0
  LOOP
    IF u.variable_pct_override IS NOT NULL THEN
      _vu := u.variable_pct_override;
    ELSE
      _vu := 0;
      FOR w IN SELECT * FROM public.target_weights(_scenario_id, u.unit_id) LOOP
        _vu := _vu + w.weight * COALESCE((SELECT SUM(p.rate) FROM public.variable_rate_parts(u.unit_id, make_date(_year, w.month, 1)) p
                                          WHERE p.included), 0);
      END LOOP;
    END IF;
    _v := _v + u.share * _vu;
    _units := _units || jsonb_build_array(jsonb_build_object('unit_id', u.unit_id, 'share', u.share,
      'variable_pct', _vu, 'override', u.variable_pct_override IS NOT NULL));
  END LOOP;

  IF st.target_kind = 'resultado' THEN
    _a := st.target_value;
    _den := 1 - _v;
    _r := CASE WHEN _den > 0 THEN (_a + _f - _rfin * (1 - st.financial_variable_pct)) / _den END;
    _m := CASE WHEN _r IS NOT NULL AND (_r + _rfin) > 0 THEN _a / (_r + _rfin) END;
  ELSE
    _m := st.target_value;
    _den := 1 - _v - _m;
    _r := CASE WHEN _den > 0 THEN (_f - _rfin * (1 - st.financial_variable_pct - _m)) / _den END;
    _a := CASE WHEN _r IS NOT NULL THEN _m * (_r + _rfin) END;
  END IF;

  DELETE FROM public.revenue_targets WHERE scenario_id = _scenario_id;
  IF _r IS NOT NULL AND _r >= 0 THEN
    INSERT INTO public.revenue_targets (scenario_id, unit_id, month, amount)
    SELECT _scenario_id, sh.unit_id, w2.month, _r * sh.share * w2.weight
    FROM public.target_unit_shares sh
    JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
    CROSS JOIN LATERAL public.target_weights(_scenario_id, sh.unit_id) w2
    WHERE sh.scenario_id = _scenario_id AND sh.share > 0;
  END IF;

  UPDATE public.scenario_targets SET
    required_revenue = CASE WHEN _r >= 0 THEN _r END, fixed_costs = _f, financial_revenue = _rfin,
    variable_pct = _v, target_amount = _a, target_margin = _m,
    feasible = (_r IS NOT NULL AND _r >= 0), computed_at = now(),
    breakdown = jsonb_build_object('payroll', _pay, 'expenses', _exp, 'units', _units)
  WHERE scenario_id = _scenario_id
  RETURNING * INTO st;
  RETURN st;
END;
$$;

