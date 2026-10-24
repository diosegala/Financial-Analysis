-- O líder quebra a meta (docs/mudancas-reuniao-fabio-22-10.md, objetivo 1, passo 5): cada linha de receita é
-- carteira atual, renovação de contrato recorrente ou venda nova.
--   saldo a vender = meta − carteira − renovações · falta = saldo a vender − vendas novas planejadas
-- plan_lines.origin já existe e significa manual/gerada; a origem da receita é outro campo.

ALTER TABLE public.plan_lines
  ADD COLUMN revenue_origin TEXT CHECK (revenue_origin IN ('carteira', 'renovacao', 'nova'));

-- Cria uma linha (ou item de evento, com _event_id) já com os valores dos meses.
-- Item de evento sem origem é venda nova. _values = [{"month": 3, "amount": 5000}, ...]
DROP FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID);
CREATE FUNCTION public.launch_line(
  _version_id UUID, _unit_id UUID, _account_id UUID, _description TEXT, _client_id UUID,
  _product_id UUID, _revenue_type_id UUID, _values JSONB DEFAULT '[]'::JSONB, _event_id UUID DEFAULT NULL,
  _revenue_origin TEXT DEFAULT NULL
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

  INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
    revenue_type_id, event_id, revenue_origin, created_by)
  VALUES (_version_id, _unit_id, _account_id, _description, _client_id, _product_id, _revenue_type_id,
    _event_id, _revenue_origin, auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _id, (v ->> 'month')::INT, (v ->> 'amount')::NUMERIC
  FROM jsonb_array_elements(COALESCE(_values, '[]'::JSONB)) AS v;

  RETURN _id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID, TEXT) FROM anon;

-- Copiar versão: a origem da receita acompanha a linha.
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
      revenue_type_id, event_id, person_id, revenue_origin, origin, sort_order, created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, (_event_map ->> rec.event_id::TEXT)::UUID, (_person_map ->> rec.person_id::TEXT)::UUID,
      rec.revenue_origin, rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  RETURN _new;
END;
$$;

-- Meta × plano por unidade e mês, com os valores lançados pelos líderes (sem a variação do cenário).
-- A meta só aparece para quem pode vê-la: o financeiro sempre; o líder, depois de publicada (RLS).
CREATE OR REPLACE FUNCTION public.target_vs_plan(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, month INT, target NUMERIC, carteira NUMERIC, renovacao NUMERIC, nova NUMERIC, sem_origem NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH lines AS (
    SELECT l.unit_id, v.month,
      SUM(v.amount) FILTER (WHERE l.revenue_origin = 'carteira') AS carteira,
      SUM(v.amount) FILTER (WHERE l.revenue_origin = 'renovacao') AS renovacao,
      SUM(v.amount) FILTER (WHERE l.revenue_origin = 'nova') AS nova,
      SUM(v.amount) FILTER (WHERE l.revenue_origin IS NULL) AS sem_origem
    FROM public.plan_lines l
    JOIN public.accounts a ON a.id = l.account_id AND a.kind = 'receita'
    JOIN public.plan_values v ON v.line_id = l.id
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    GROUP BY l.unit_id, v.month
  ), tg AS (
    SELECT t.unit_id, t.month, t.amount FROM public.revenue_targets t
    WHERE t.scenario_id = _scenario_id AND (_unit_ids IS NULL OR t.unit_id = ANY (_unit_ids))
  )
  SELECT COALESCE(tg.unit_id, l.unit_id), COALESCE(tg.month, l.month), COALESCE(tg.amount, 0),
    COALESCE(l.carteira, 0), COALESCE(l.renovacao, 0), COALESCE(l.nova, 0), COALESCE(l.sem_origem, 0)
  FROM tg FULL JOIN lines l ON l.unit_id = tg.unit_id AND l.month = tg.month
$$;
