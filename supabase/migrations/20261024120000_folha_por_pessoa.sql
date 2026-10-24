-- Folha por pessoa (docs/mudancas-reuniao-fabio-22-10.md, objetivo 3).
-- A remuneração de cada pessoa passa a ser uma linha do plano (12 meses editáveis, como em receitas).
-- people.base_salary, entrada e saída viram só ajuda de preenchimento: geram os meses ao cadastrar.
-- As linhas mandam; salary_changes fica na tabela, sem uso.

ALTER TABLE public.people
  ADD COLUMN external_id TEXT,          -- ID da planilha da folha (não guardamos CPF)
  ADD COLUMN hire_date DATE,
  ADD COLUMN dependents INT NOT NULL DEFAULT 0 CHECK (dependents >= 0);
CREATE UNIQUE INDEX people_version_external_id ON public.people (version_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE public.plan_lines
  ADD COLUMN person_id UUID REFERENCES public.people(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX plan_lines_person ON public.plan_lines (person_id) WHERE person_id IS NOT NULL;

-- Uma linha de remuneração por pessoa, com os meses do salário base dentro de entrada e saída.
-- Sem _reset, mantém os valores que já existem.
CREATE OR REPLACE FUNCTION public.seed_person_line(_person_id UUID, _reset BOOLEAN DEFAULT false) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.people%ROWTYPE;
  _line UUID;
BEGIN
  SELECT * INTO p FROM public.people WHERE id = _person_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pessoa não encontrada.'; END IF;
  SELECT id INTO _line FROM public.plan_lines WHERE person_id = _person_id;
  IF _line IS NULL THEN
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, person_id, description, created_by)
    SELECT p.version_id, p.unit_id, ct.account_id, p.id, p.name, auth.uid()
    FROM public.contract_types ct WHERE ct.id = p.contract_type_id
    RETURNING id INTO _line;
  ELSIF _reset THEN
    DELETE FROM public.plan_values WHERE line_id = _line;
  ELSE
    RETURN _line;
  END IF;
  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _line, m, p.base_salary FROM generate_series(1, 12) AS m
  WHERE m >= COALESCE(p.start_month, 1) AND m <= COALESCE(p.end_month, 12);
  RETURN _line;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.seed_person_line(UUID, BOOLEAN) FROM anon, authenticated;

-- Quem já está cadastrado ganha a linha com os valores de hoje, incluindo os reajustes.
DO $$
DECLARE
  p RECORD;
  c RECORD;
  _line UUID;
BEGIN
  FOR p IN SELECT id FROM public.people LOOP
    _line := public.seed_person_line(p.id);
    FOR c IN SELECT month, new_salary FROM public.salary_changes WHERE person_id = p.id ORDER BY month LOOP
      UPDATE public.plan_values SET amount = c.new_salary WHERE line_id = _line AND month >= c.month;
    END LOOP;
  END LOOP;
END $$;

-- Cadastrar uma pessoa já cria a linha. A cópia de versão desliga isso e copia as linhas como estão.
CREATE OR REPLACE FUNCTION public.people_seed_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('app.skip_person_seed', true), '') = 'on' THEN RETURN NEW; END IF;
  PERFORM public.seed_person_line(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER people_seed_line AFTER INSERT ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.people_seed_line();

-- Trocar vínculo ou unidade da pessoa leva a linha junto.
CREATE OR REPLACE FUNCTION public.people_sync_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.plan_lines l
  SET unit_id = NEW.unit_id,
      account_id = COALESCE((SELECT ct.account_id FROM public.contract_types ct WHERE ct.id = NEW.contract_type_id), l.account_id),
      description = NEW.name
  WHERE l.person_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER people_sync_line AFTER UPDATE OF unit_id, contract_type_id, name ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.people_sync_line();

-- A linha de uma pessoa é de folha e fica na unidade e na versão dela.
CREATE OR REPLACE FUNCTION public.validate_plan_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.accounts%ROWTYPE;
  p public.people%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.accounts WHERE id = NEW.account_id;
  IF a.treatment = 'calculada' THEN
    RAISE EXCEPTION 'A conta "%" é calculada pelo app e não pode ser lançada.', a.name;
  ELSIF a.treatment = 'fora_dre' THEN
    RAISE EXCEPTION 'A conta "%" fica fora da DRE e não pode ser lançada.', a.name;
  END IF;
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
  IF NEW.person_id IS NOT NULL THEN
    SELECT * INTO p FROM public.people WHERE id = NEW.person_id;
    IF a.kind <> 'folha' OR NEW.event_id IS NOT NULL THEN
      RAISE EXCEPTION 'A remuneração de uma pessoa é uma linha de folha.';
    END IF;
    IF NOT FOUND OR p.version_id <> NEW.version_id OR p.unit_id <> NEW.unit_id THEN
      RAISE EXCEPTION 'A linha precisa estar na mesma unidade e versão da pessoa.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Importação da folha: uma linha por pessoa, idempotente pelo ID da planilha.
-- _rows = [{external_id, unit_id, name?, role_title?, contract_type_id, hire_date?, salary, dependents?}]
-- Pessoa que já existe tem os dados atualizados; os 12 meses só são refeitos com _overwrite.
CREATE OR REPLACE FUNCTION public.import_people(_version_id UUID, _rows JSONB, _overwrite BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r JSONB;
  _year INT;
  _id UUID;
  _ext TEXT;
  _hire DATE;
  _start INT;
  _created INT := 0;
  _updated INT := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro importa a folha.';
  END IF;
  SELECT year INTO _year FROM public.budget_versions WHERE id = _version_id;
  IF _year IS NULL THEN RAISE EXCEPTION 'Versão não encontrada.'; END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::JSONB)) LOOP
    _ext := NULLIF(trim(r ->> 'external_id'), '');
    IF _ext IS NULL THEN RAISE EXCEPTION 'Toda pessoa importada precisa de um ID.'; END IF;
    _hire := NULLIF(r ->> 'hire_date', '')::DATE;
    IF _hire IS NOT NULL AND EXTRACT(YEAR FROM _hire) > _year THEN
      RAISE EXCEPTION 'A admissão de % é depois de %.', _ext, _year;
    END IF;
    _start := CASE WHEN _hire IS NOT NULL AND EXTRACT(YEAR FROM _hire) = _year THEN EXTRACT(MONTH FROM _hire)::INT END;

    SELECT id INTO _id FROM public.people WHERE version_id = _version_id AND external_id = _ext;
    IF _id IS NULL THEN
      INSERT INTO public.people (version_id, unit_id, name, role_title, contract_type_id, base_salary,
        start_month, external_id, hire_date, dependents)
      VALUES (_version_id, (r ->> 'unit_id')::UUID, COALESCE(NULLIF(trim(r ->> 'name'), ''), 'ID ' || _ext),
        NULLIF(trim(r ->> 'role_title'), ''), (r ->> 'contract_type_id')::UUID, COALESCE((r ->> 'salary')::NUMERIC, 0),
        _start, _ext, _hire, COALESCE((r ->> 'dependents')::INT, 0));
      _created := _created + 1;
    ELSE
      UPDATE public.people SET
        unit_id = (r ->> 'unit_id')::UUID,
        name = COALESCE(NULLIF(trim(r ->> 'name'), ''), name),
        role_title = NULLIF(trim(r ->> 'role_title'), ''),
        contract_type_id = (r ->> 'contract_type_id')::UUID,
        base_salary = COALESCE((r ->> 'salary')::NUMERIC, base_salary),
        start_month = _start, hire_date = _hire,
        dependents = COALESCE((r ->> 'dependents')::INT, dependents)
      WHERE id = _id;
      PERFORM public.seed_person_line(_id, _overwrite);
      _updated := _updated + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('created', _created, 'updated', _updated);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.import_people(UUID, JSONB, BOOLEAN) FROM anon;

-- Copiar versão: as linhas de remuneração vão junto com as pessoas, sem refazer os meses.
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
      revenue_type_id, event_id, person_id, origin, sort_order, created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, (_event_map ->> rec.event_id::TEXT)::UUID, (_person_map ->> rec.person_id::TEXT)::UUID,
      rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  RETURN _new;
END;
$$;

-- Cálculo: a remuneração vem das linhas com pessoa; o headcount, dos meses com valor.
CREATE OR REPLACE FUNCTION public.plan_base_rows(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, month INT, row_kind TEXT, account_id UUID, dre_line_id UUID,
  revenue_type_id UUID, product_id UUID, contract_type_id UUID, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
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
  -- Headcount: 1 por pessoa nos meses em que há remuneração (base para benefícios por pessoa)
  SELECT l.unit_id, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
$$;

-- A planilha da folha não traz o vínculo: o cargo ajuda a sugerir (ex.: "Estagio Desing" → estágio).
-- Quem não bate com nenhuma palavra fica no primeiro vínculo ativo; a conferência da importação deixa trocar.
ALTER TABLE public.contract_types ADD COLUMN role_keywords TEXT[];
UPDATE public.contract_types SET role_keywords = ARRAY['estagio', 'estagiario', 'estagiaria']
WHERE name = 'Estagiário (CIEE)';
