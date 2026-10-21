-- Eventos com itens (ex.: Cupola Summit): um evento tem vários itens de receita (lotes de ingresso, cotas e
-- valores negociados de patrocínio, itens adicionais) e de custo por categoria, cada um com seus meses e parcelas.
--
-- O evento passa a ser só o cabeçalho; cada item é uma linha comum do plano (plan_lines) ligada ao evento. Assim o
-- item usa as contas como categorias, o tipo de receita (comissão e impostos), as travas e a auditoria de sempre.
-- Os eventos do modelo antigo (vagas × preço) não têm dados no banco real (conferido em 20/10/2026).

-- ───────────── Regra de cálculo: "todos os tipos, exceto…" ─────────────
-- A comissão comercial listava os tipos de receita um a um; um tipo novo (ex.: Patrocínio) ficaria sem comissão
-- sem ninguém notar. Passa a valer "todos os tipos, exceto os listados".
ALTER TABLE public.calc_rules ADD COLUMN exclude_revenue_type_ids UUID[];

INSERT INTO public.revenue_types (name, sort_order) VALUES ('Ingressos', 60), ('Patrocínio', 70)
ON CONFLICT (name) DO NOTHING;

-- Só converte a regra se ela ainda estiver exatamente como foi criada (todos os tipos, menos Parceiros).
UPDATE public.calc_rules r
SET revenue_type_ids = NULL,
    exclude_revenue_type_ids = ARRAY(SELECT id FROM public.revenue_types WHERE name = 'Parceiros')
WHERE r.name = 'Comissão comercial'
  AND r.revenue_type_ids IS NOT NULL
  AND (SELECT array_agg(id ORDER BY id) FROM public.revenue_types
       WHERE name NOT IN ('Parceiros', 'Ingressos', 'Patrocínio'))
      = (SELECT array_agg(x ORDER BY x) FROM unnest(r.revenue_type_ids) AS x);

-- ───────────── Evento = cabeçalho; itens = linhas do plano ─────────────
DROP FUNCTION public.launch_event(UUID, UUID, UUID, UUID, TEXT, INT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID);

ALTER TABLE public.events
  DROP COLUMN quantity,
  DROP COLUMN price,
  DROP COLUMN cost_per_participant,
  DROP COLUMN fixed_cost,
  DROP COLUMN revenue_type_id,
  DROP COLUMN revenue_account_id,
  DROP COLUMN cost_account_id;

ALTER TABLE public.plan_lines
  ADD COLUMN event_id UUID REFERENCES public.events(id) ON DELETE CASCADE;
CREATE INDEX plan_lines_event ON public.plan_lines (event_id) WHERE event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_plan_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.accounts WHERE id = NEW.account_id;
  IF a.unit_ids IS NOT NULL AND NOT NEW.unit_id = ANY (a.unit_ids) THEN
    RAISE EXCEPTION 'A conta "%" não está disponível para esta unidade.', a.name;
  END IF;
  IF a.kind = 'receita' AND NEW.revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Linhas de receita precisam de um tipo de receita.';
  END IF;
  IF NEW.event_id IS NOT NULL THEN
    IF a.kind = 'folha' THEN
      RAISE EXCEPTION 'Um evento só tem itens de receita e de custo.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.events e
                   WHERE e.id = NEW.event_id AND e.version_id = NEW.version_id AND e.unit_id = NEW.unit_id) THEN
      RAISE EXCEPTION 'O item precisa estar na mesma unidade e versão do evento.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Cria uma linha (ou item de evento, com _event_id) já com os valores dos meses.
-- _values = [{"month": 3, "amount": 5000}, ...]
DROP FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB);
CREATE FUNCTION public.launch_line(
  _version_id UUID, _unit_id UUID, _account_id UUID, _description TEXT, _client_id UUID,
  _product_id UUID, _revenue_type_id UUID, _values JSONB DEFAULT '[]'::JSONB, _event_id UUID DEFAULT NULL
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

  INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
    revenue_type_id, event_id, created_by)
  VALUES (_version_id, _unit_id, _account_id, _description, _client_id, _product_id, _revenue_type_id,
    _event_id, auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _id, (v ->> 'month')::INT, (v ->> 'amount')::NUMERIC
  FROM jsonb_array_elements(COALESCE(_values, '[]'::JSONB)) AS v;

  RETURN _id;
END;
$$;

-- Cria o evento e, se vierem, os itens iniciais (_lines = [{account_id, description, revenue_type_id, values}]).
CREATE FUNCTION public.launch_event(
  _version_id UUID, _unit_id UUID, _product_id UUID, _name TEXT, _month INT, _lines JSONB DEFAULT '[]'::JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id UUID;
  l JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_write_unit(auth.uid(), _unit_id) THEN
    RAISE EXCEPTION 'Você não lança nesta unidade.';
  END IF;
  INSERT INTO public.events (version_id, unit_id, product_id, name, month, created_by)
  VALUES (_version_id, _unit_id, _product_id, _name, _month, auth.uid())
  RETURNING id INTO _id;

  FOR l IN SELECT value FROM jsonb_array_elements(COALESCE(_lines, '[]'::JSONB)) LOOP
    PERFORM public.launch_line(
      _version_id, _unit_id, (l ->> 'account_id')::UUID, l ->> 'description',
      NULLIF(l ->> 'client_id', '')::UUID, _product_id, NULLIF(l ->> 'revenue_type_id', '')::UUID,
      COALESCE(l -> 'values', '[]'::JSONB), _id);
  END LOOP;
  RETURN _id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.launch_event(UUID, UUID, UUID, TEXT, INT, JSONB) FROM anon;

-- ───────────── Copiar versão: eventos e seus itens ─────────────
CREATE OR REPLACE FUNCTION public.copy_version(_source_id UUID, _name TEXT, _year INT, _kind TEXT DEFAULT 'forecast')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _new UUID;
  _old_id UUID;
  _new_id UUID;
  _event_map JSONB := '{}'::JSONB;
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

  FOR rec IN SELECT * FROM public.people WHERE version_id = _source_id LOOP
    INSERT INTO public.people (version_id, unit_id, name, role_title, contract_type_id, base_salary, start_month, end_month)
    VALUES (_new, rec.unit_id, rec.name, rec.role_title, rec.contract_type_id, rec.base_salary, rec.start_month, rec.end_month)
    RETURNING id INTO _new_id;
    INSERT INTO public.salary_changes (person_id, month, new_salary)
    SELECT _new_id, month, new_salary FROM public.salary_changes WHERE person_id = rec.id;
  END LOOP;

  FOR rec IN SELECT * FROM public.events WHERE version_id = _source_id LOOP
    INSERT INTO public.events (version_id, unit_id, product_id, name, month, created_by)
    VALUES (_new, rec.unit_id, rec.product_id, rec.name, rec.month, auth.uid())
    RETURNING id INTO _new_id;
    _event_map := _event_map || jsonb_build_object(rec.id::TEXT, _new_id);
  END LOOP;

  FOR rec IN SELECT * FROM public.plan_lines WHERE version_id = _source_id LOOP
    _old_id := rec.id;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
      revenue_type_id, event_id, origin, sort_order, created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, (_event_map ->> rec.event_id::TEXT)::UUID, rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  RETURN _new;
END;
$$;

-- ───────────── Cálculo da DRE ─────────────
-- Os itens dos eventos já são linhas do plano: saem as parcelas "vagas × preço" do modelo antigo.
CREATE OR REPLACE FUNCTION public.plan_base_rows(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, month INT, row_kind TEXT, account_id UUID, dre_line_id UUID,
  revenue_type_id UUID, product_id UUID, contract_type_id UUID, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(revenue_variation, 0) AS rv, COALESCE(expense_variation, 0) AS ev,
           COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  )
  -- Linhas lançadas nas grades e itens de eventos
  SELECT l.unit_id, v.month, a.kind, a.id, a.dre_line_id, l.revenue_type_id, l.product_id, NULL::UUID,
    v.amount * CASE a.kind WHEN 'receita' THEN 1 + s.rv
                           WHEN 'despesa' THEN 1 + s.ev
                           ELSE CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END END
  FROM public.plan_lines l
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts a ON a.id = l.account_id
  CROSS JOIN s
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  UNION ALL
  -- Pessoas: remuneração do mês (último reajuste até o mês, senão o salário base)
  SELECT p.unit_id, m.month, 'salario', ct.account_id, a.dre_line_id, NULL::UUID, NULL::UUID, p.contract_type_id,
    COALESCE((SELECT sc.new_salary FROM public.salary_changes sc
              WHERE sc.person_id = p.id AND sc.month <= m.month ORDER BY sc.month DESC LIMIT 1), p.base_salary)
    * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END
  FROM public.people p
  JOIN public.contract_types ct ON ct.id = p.contract_type_id
  JOIN public.accounts a ON a.id = ct.account_id
  CROSS JOIN generate_series(1, 12) AS m(month)
  CROSS JOIN s
  WHERE p.version_id = _version_id AND (_unit_ids IS NULL OR p.unit_id = ANY (_unit_ids))
    AND m.month >= COALESCE(p.start_month, 1) AND m.month <= COALESCE(p.end_month, 12)
  UNION ALL
  -- Headcount: 1 por pessoa ativa no mês (base para benefícios por pessoa)
  SELECT p.unit_id, m.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.people p
  CROSS JOIN generate_series(1, 12) AS m(month)
  WHERE p.version_id = _version_id AND (_unit_ids IS NULL OR p.unit_id = ANY (_unit_ids))
    AND m.month >= COALESCE(p.start_month, 1) AND m.month <= COALESCE(p.end_month, 12)
$$;

CREATE OR REPLACE FUNCTION public.dre_unit_values(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, dre_line_id UUID, month INT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, _unit_ids)),
  calc AS (
    SELECT b.unit_id, r.target_dre_line_id AS dre_line_id, b.month,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = b.row_kind
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  ),
  leaf AS (
    SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
    FROM (
      SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b WHERE b.row_kind <> 'headcount'
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
$$;
