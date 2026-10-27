-- Piso e teto: o plano parte do que cada unidade já vende (piso de receita, pelo ano base projetado) e do
-- resultado que a empresa quer. Daí sai quanto cada unidade de negócio precisa contribuir e, com isso, o teto de
-- despesa dela. As áreas de apoio recebem um teto. Receita acima do piso não aumenta o teto: a despesa que conta
-- com ela é lançada como "condicionada" (com o gatilho) e fica fora do cenário de trava.
--
--   piso líquido (u)       = piso × (1 − alíquota variável da unidade)
--   contribuição exigida   = resultado alvo + tetos do apoio − receita líquida do apoio
--   contribuição (u)       = contribuição exigida × participação (u)  [piso, margem ou manual]
--   teto de despesa (u)    = piso líquido − contribuição (u)
--
-- Só acrescenta tabelas, colunas com valor padrão e funções: nada do que já foi lançado muda.

CREATE TABLE public.guardrail_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- a auditoria identifica a linha por id
  scenario_id UUID NOT NULL PRIMARY KEY REFERENCES public.scenarios(id) ON DELETE CASCADE,
  result_target NUMERIC NOT NULL DEFAULT 0,
  floor_adjust_pct NUMERIC NOT NULL DEFAULT 0 CHECK (floor_adjust_pct > -1 AND floor_adjust_pct < 1),
  support_cut_pct NUMERIC NOT NULL DEFAULT 0 CHECK (support_cut_pct >= 0 AND support_cut_pct < 1),
  distribution TEXT NOT NULL DEFAULT 'piso' CHECK (distribution IN ('piso', 'margem', 'manual')),
  base_year INT,
  base_closed_month INT,          -- último mês fechado do ano base usado na sugestão
  unassigned_revenue NUMERIC,     -- receita do Omie sem unidade no ano base (o financeiro distribui nos pisos)
  suggested_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.guardrail_units (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  floor_actual NUMERIC,           -- recebido no ano base até o mês fechado (Omie)
  floor_projected NUMERIC,        -- projeção dos meses que faltam (média dos 3 últimos fechados)
  floor_amount NUMERIC,           -- piso usado; vazio = (realizado + projeção) × (1 + ajuste)
  ceiling_amount NUMERIC,         -- teto da área de apoio; vazio = despesa lançada × (1 − corte sugerido)
  manual_share NUMERIC CHECK (manual_share >= 0 AND manual_share <= 1),
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, unit_id)
);

CREATE FUNCTION public.guardrails_published(_scenario_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.guardrail_settings WHERE scenario_id = _scenario_id AND published_at IS NOT NULL)
$$;
REVOKE EXECUTE ON FUNCTION public.guardrails_published(UUID) FROM anon;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['guardrail_settings', 'guardrail_units'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE POLICY "Management reads %1$s" ON public.%1$I FOR SELECT TO authenticated
      USING (public.has_any_role(auth.uid(), ARRAY[''financeiro'', ''vp'', ''ceo'']::public.app_role[]))', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;
CREATE POLICY "Leader reads published guardrail_settings" ON public.guardrail_settings FOR SELECT TO authenticated
  USING (published_at IS NOT NULL);
CREATE POLICY "Leader reads own published guardrail_units" ON public.guardrail_units FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id) AND public.guardrails_published(scenario_id));

-- Despesa condicionada: só acontece se a receita passar do piso (o gatilho diz quando).
ALTER TABLE public.plan_lines ADD COLUMN conditional BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.plan_lines ADD COLUMN condition_note TEXT;

-- Lançar com a marca de condicionada (o resto igual a 20261103120000_receitas_por_produto).
DROP FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID, TEXT, TEXT);
CREATE FUNCTION public.launch_line(
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
  IF _kind = 'folha' AND NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro lança folha.';
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
REVOKE EXECUTE ON FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID, TEXT, TEXT, BOOLEAN, TEXT) FROM anon;

-- Marcar ou desmarcar uma despesa como condicionada: o líder da unidade também pode (só isso muda na linha).
CREATE FUNCTION public.set_line_condition(_line_id UUID, _conditional BOOLEAN, _condition_note TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l public.plan_lines%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.plan_lines WHERE id = _line_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.can_write_unit(auth.uid(), l.unit_id) THEN
    RAISE EXCEPTION 'Você não altera linhas desta unidade.';
  END IF;
  IF public.account_kind(l.account_id) <> 'despesa' THEN
    RAISE EXCEPTION 'Só despesas podem ser condicionadas.';
  END IF;
  UPDATE public.plan_lines SET conditional = _conditional,
    condition_note = CASE WHEN _conditional THEN NULLIF(btrim(_condition_note), '') END
  WHERE id = _line_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_line_condition(UUID, BOOLEAN, TEXT) FROM anon;

-- Copiar versão: a marca de condicionada acompanha a linha (o resto igual a 20261103120000_receitas_por_produto).
CREATE OR REPLACE FUNCTION public.copy_version(_source_id UUID, _name TEXT, _year INT, _kind TEXT DEFAULT 'forecast')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      end_month, external_id, hire_date, dependents)
    VALUES (_new, rec.unit_id, rec.name, rec.role_title, rec.contract_type_id, rec.base_salary, rec.start_month,
      rec.end_month, rec.external_id, rec.hire_date, rec.dependents)
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

  FOR rec IN SELECT * FROM public.plan_lines WHERE version_id = _source_id LOOP
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

  RETURN _new;
END;
$$;

-- Alíquota variável da unidade no ano (a mesma das metas: a definida à mão, senão a das regras, ponderada pelos
-- pesos dos meses).
CREATE FUNCTION public.unit_variable_rate(_scenario_id UUID, _unit_id UUID) RETURNS NUMERIC
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT variable_pct_override FROM public.target_unit_shares WHERE scenario_id = _scenario_id AND unit_id = _unit_id),
    (SELECT SUM(w.weight * COALESCE((SELECT SUM(p.rate) FROM public.variable_rate_parts(_unit_id, make_date(v.year, w.month, 1)) p
                                     WHERE p.included), 0))
     FROM public.target_weights(_scenario_id, _unit_id) w
     CROSS JOIN (SELECT bv.year FROM public.scenarios s JOIN public.budget_versions bv ON bv.id = s.version_id
                 WHERE s.id = _scenario_id) v),
    0)
$$;
REVOKE EXECUTE ON FUNCTION public.unit_variable_rate(UUID, UUID) FROM anon;

-- Busca o realizado do ano base no Omie (ano da versão − 1) e projeta os meses que faltam pela média dos 3 últimos
-- meses fechados. Grava a sugestão; o piso que o financeiro digitou não muda.
CREATE FUNCTION public.guardrails_suggest(_scenario_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _year INT;
  _closed INT;
  _unassigned NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro calcula o piso e o teto.';
  END IF;
  SELECT bv.year - 1 INTO _year FROM public.scenarios s JOIN public.budget_versions bv ON bv.id = s.version_id
  WHERE s.id = _scenario_id;
  IF _year IS NULL THEN RAISE EXCEPTION 'Cenário não encontrado.'; END IF;
  _closed := CASE WHEN _year < extract(year FROM now())::INT THEN 12
                  WHEN _year = extract(year FROM now())::INT THEN extract(month FROM now())::INT - 1
                  ELSE 0 END;

  INSERT INTO public.guardrail_settings (scenario_id) VALUES (_scenario_id) ON CONFLICT (scenario_id) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS _gr_rev (unit_id UUID, actual NUMERIC, last3 NUMERIC) ON COMMIT DROP;
  TRUNCATE _gr_rev;
  INSERT INTO _gr_rev
  SELECT a.unit_id,
    SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(a.received[1:_closed]) x)),
    SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(a.received[GREATEST(_closed - 2, 1):_closed]) x))
      / NULLIF(LEAST(_closed, 3), 0)
  FROM public.omie_revenue_attribution(_year) a
  GROUP BY a.unit_id;

  SELECT COALESCE(SUM(actual + COALESCE(last3, 0) * (12 - _closed)), 0) INTO _unassigned FROM _gr_rev WHERE unit_id IS NULL;
  UPDATE public.guardrail_settings SET base_year = _year, base_closed_month = _closed,
    unassigned_revenue = _unassigned, suggested_at = now()
  WHERE scenario_id = _scenario_id;

  INSERT INTO public.guardrail_units (scenario_id, unit_id, floor_actual, floor_projected)
  SELECT _scenario_id, u.id, COALESCE(r.actual, 0), COALESCE(r.last3, 0) * (12 - _closed)
  FROM public.units u LEFT JOIN _gr_rev r ON r.unit_id = u.id
  WHERE u.active AND u.kind = 'negocio'
  ON CONFLICT (scenario_id, unit_id) DO UPDATE
    SET floor_actual = EXCLUDED.floor_actual, floor_projected = EXCLUDED.floor_projected;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guardrails_suggest(UUID) FROM anon;

-- O contrato de cada unidade (piso, contribuição, teto) e o que já está lançado no plano. A gestão vê todas; o
-- líder vê as unidades dele depois de publicado. Valores do ano.
CREATE FUNCTION public.guardrails(_scenario_id UUID)
RETURNS TABLE (unit_id UUID, kind TEXT, floor_suggested NUMERIC, floor_amount NUMERIC, variable_rate NUMERIC,
  floor_net NUMERIC, share NUMERIC, contribution NUMERIC, ceiling_suggested NUMERIC, ceiling NUMERIC,
  planned_revenue NUMERIC, planned_variable NUMERIC, planned_expense NUMERIC, conditional_expense NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  st public.guardrail_settings%ROWTYPE;
  _version UUID;
  _ev NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT s.version_id, COALESCE(s.expense_variation, 0) INTO _version, _ev FROM public.scenarios s WHERE s.id = _scenario_id;
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
      SUM(p.amount) FILTER (WHERE p.bucket IN ('folha', 'despesa')) AS expense
    FROM public.plan_split(_version, _scenario_id) p GROUP BY p.unit_id
  ),
  cond AS (
    SELECT l.unit_id, SUM(v.amount) * (1 + _ev) AS amount
    FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id
    WHERE l.version_id = _version AND l.conditional GROUP BY l.unit_id
  ),
  base AS (
    SELECT u.id, u.kind, g.floor_amount AS floor_typed, g.ceiling_amount AS ceiling_typed, g.manual_share,
      (COALESCE(g.floor_actual, 0) + COALESCE(g.floor_projected, 0)) * (1 + st.floor_adjust_pct) AS floor_sugg,
      COALESCE(pl.revenue, 0) AS revenue, COALESCE(pl.variable, 0) AS variable,
      COALESCE(pl.expense, 0) - COALESCE(c.amount, 0) AS expense, COALESCE(c.amount, 0) AS cond,
      public.unit_variable_rate(_scenario_id, u.id) AS vrate
    FROM public.units u
    LEFT JOIN public.guardrail_units g ON g.scenario_id = _scenario_id AND g.unit_id = u.id
    LEFT JOIN plan pl ON pl.unit_id = u.id
    LEFT JOIN cond c ON c.unit_id = u.id
    WHERE u.active
  ),
  b2 AS (
    SELECT base.*,
      CASE WHEN base.kind = 'negocio' THEN COALESCE(base.floor_typed, base.floor_sugg) END AS floor_final,
      CASE WHEN base.kind = 'negocio' THEN COALESCE(base.floor_typed, base.floor_sugg) * (1 - base.vrate) END AS fnet,
      CASE WHEN base.kind <> 'negocio' THEN base.expense * (1 - st.support_cut_pct) END AS ceil_sugg
    FROM base
  ),
  totals AS (
    SELECT
      st.result_target
        + COALESCE(SUM(COALESCE(ceiling_typed, ceil_sugg)) FILTER (WHERE kind <> 'negocio'), 0)
        - COALESCE(SUM(revenue - variable) FILTER (WHERE kind <> 'negocio'), 0) AS required,
      SUM(fnet) FILTER (WHERE kind = 'negocio' AND fnet > 0) AS sum_floor,
      SUM(GREATEST(fnet - expense, 0)) FILTER (WHERE kind = 'negocio') AS sum_margin,
      SUM(manual_share) FILTER (WHERE kind = 'negocio') AS sum_manual
    FROM b2
  ),
  shares AS (
    SELECT b2.id,
      CASE
        WHEN b2.kind <> 'negocio' THEN NULL
        WHEN st.distribution = 'manual' AND t.sum_manual > 0 THEN COALESCE(b2.manual_share, 0) / t.sum_manual
        WHEN st.distribution = 'margem' AND t.sum_margin > 0 THEN GREATEST(b2.fnet - b2.expense, 0) / t.sum_margin
        WHEN t.sum_floor > 0 THEN GREATEST(b2.fnet, 0) / t.sum_floor
        ELSE 0 END AS sh
    FROM b2 CROSS JOIN totals t
  )
  SELECT b2.id, b2.kind,
    CASE WHEN b2.kind = 'negocio' THEN b2.floor_sugg END, b2.floor_final, b2.vrate, b2.fnet,
    s.sh, t.required * s.sh, b2.ceil_sugg,
    CASE WHEN b2.kind = 'negocio' THEN b2.fnet - t.required * s.sh ELSE COALESCE(b2.ceiling_typed, b2.ceil_sugg) END,
    b2.revenue, b2.variable, b2.expense, b2.cond
  FROM b2 JOIN shares s ON s.id = b2.id CROSS JOIN totals t
  WHERE public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
     OR public.has_unit(auth.uid(), b2.id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guardrails(UUID) FROM anon;

-- Publicar (os líderes passam a ver o contrato da unidade) ou reabrir.
CREATE FUNCTION public.publish_guardrails(_scenario_id UUID, _publish BOOLEAN DEFAULT true) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro publica o piso e o teto.';
  END IF;
  UPDATE public.guardrail_settings SET published_at = CASE WHEN _publish THEN now() END WHERE scenario_id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Calcule o piso e o teto antes de publicar.'; END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.publish_guardrails(UUID, BOOLEAN) FROM anon;
