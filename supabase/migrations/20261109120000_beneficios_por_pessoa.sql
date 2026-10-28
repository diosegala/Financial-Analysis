-- Benefícios por pessoa (assistência médica, vale-transporte, vale-alimentação…).
-- O Omie não lança por colaborador; a Folha passa a ter o valor mensal de cada benefício por pessoa.
-- person_benefits é a fonte; cada benefício vira uma linha de folha da pessoa (benefit_person_id) nos meses em que
-- ela tem salário, então DRE, piso e teto e cenários seguem sem mudança. Benefício não entra na base de encargos.
-- Quando a unidade passa a ter o benefício por pessoa, a linha da base do Omie daquela conta sai e o total dela fica em
-- benefit_bases, para comparar.

ALTER TABLE public.accounts ADD COLUMN per_person BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.accounts.per_person IS 'Conta de folha lançada por pessoa (benefício).';
UPDATE public.accounts SET per_person = true
WHERE kind = 'folha' AND treatment = 'lancavel'
  AND (name ILIKE 'assist%ncia m%dica%' OR name ILIKE 'vale%transporte%' OR name ILIKE 'vale%alimenta%'
       OR name ILIKE 'vale%refei%' OR name ILIKE 'seguro de vida%' OR name ILIKE 'plano de sa%de%');

ALTER TABLE public.plan_lines DROP CONSTRAINT plan_lines_origin_check;
ALTER TABLE public.plan_lines ADD CONSTRAINT plan_lines_origin_check CHECK (origin IN ('manual', 'gerada', 'beneficio'));
ALTER TABLE public.plan_lines ADD COLUMN benefit_person_id UUID REFERENCES public.people(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX plan_lines_benefit ON public.plan_lines (benefit_person_id, account_id) WHERE benefit_person_id IS NOT NULL;

CREATE TABLE public.person_benefits (
  person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  PRIMARY KEY (person_id, account_id)
);
CREATE TABLE public.benefit_bases (
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  PRIMARY KEY (version_id, unit_id, account_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.person_benefits, public.benefit_bases TO authenticated;
GRANT ALL ON public.person_benefits, public.benefit_bases TO service_role;
ALTER TABLE public.person_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benefit_bases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read person_benefits by unit" ON public.person_benefits FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.has_unit(auth.uid(), p.unit_id)));
CREATE POLICY "Financeiro writes person_benefits" ON public.person_benefits FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Read benefit_bases by unit" ON public.benefit_bases FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes benefit_bases" ON public.benefit_bases FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_person_benefits AFTER INSERT OR DELETE OR UPDATE ON public.person_benefits
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_person_benefits BEFORE UPDATE ON public.person_benefits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_benefit_bases BEFORE UPDATE ON public.benefit_bases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Refaz as linhas de benefício da pessoa: o valor mensal em cada mês com salário. Só grava o que mudou (os meses
-- fechados não são tocados se nada mudou neles). A base do Omie da conta, na unidade, sai e vira referência.
CREATE OR REPLACE FUNCTION public.sync_person_benefits(_person_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  FOR b IN SELECT account_id, amount FROM public.person_benefits WHERE person_id = _person_id LOOP
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
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _line, sv.month, b.amount
    FROM public.plan_lines s JOIN public.plan_values sv ON sv.line_id = s.id
    WHERE s.person_id = _person_id AND sv.amount > 0
      AND NOT EXISTS (SELECT 1 FROM public.plan_values x WHERE x.line_id = _line AND x.month = sv.month AND x.amount = b.amount)
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
$$;
REVOKE EXECUTE ON FUNCTION public.sync_person_benefits(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.person_benefits_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.sync_person_benefits(CASE WHEN TG_OP = 'DELETE' THEN OLD.person_id ELSE NEW.person_id END);
  IF TG_OP = 'UPDATE' AND OLD.person_id <> NEW.person_id THEN PERFORM public.sync_person_benefits(OLD.person_id); END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER person_benefits_sync AFTER INSERT OR UPDATE OR DELETE ON public.person_benefits
  FOR EACH ROW EXECUTE FUNCTION public.person_benefits_sync();

-- Mudou o salário (inclusive zerar meses de quem sai): os benefícios acompanham.
CREATE OR REPLACE FUNCTION public.salary_values_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _person UUID;
BEGIN
  SELECT person_id INTO _person FROM public.plan_lines
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.line_id ELSE NEW.line_id END;
  IF _person IS NOT NULL AND EXISTS (SELECT 1 FROM public.person_benefits WHERE person_id = _person) THEN
    PERFORM public.sync_person_benefits(_person);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER salary_values_sync AFTER INSERT OR UPDATE OR DELETE ON public.plan_values
  FOR EACH ROW EXECUTE FUNCTION public.salary_values_sync();

-- Ponto de partida: divide o total da base do Omie de cada benefício da unidade pelos meses-pessoa com salário.
-- Só as contas que ainda estão na base (as já lançadas por pessoa não são tocadas). Devolve quantas contas distribuiu.
CREATE OR REPLACE FUNCTION public.distribute_benefits(_version_id UUID, _unit_id UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  _months NUMERIC;
  _n INT := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro lança benefícios por pessoa.';
  END IF;
  SELECT count(*) INTO _months
  FROM public.plan_lines s JOIN public.people p ON p.id = s.person_id JOIN public.plan_values v ON v.line_id = s.id
  WHERE p.version_id = _version_id AND p.unit_id = _unit_id AND v.amount > 0;
  IF _months = 0 THEN RAISE EXCEPTION 'A unidade não tem pessoas com salário nesta versão.'; END IF;

  FOR r IN
    SELECT l.account_id, SUM(v.amount) AS total
    FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id JOIN public.accounts a ON a.id = l.account_id
    WHERE l.version_id = _version_id AND l.unit_id = _unit_id AND l.origin = 'gerada' AND a.per_person
    GROUP BY l.account_id HAVING SUM(v.amount) > 0
  LOOP
    INSERT INTO public.person_benefits (person_id, account_id, amount)
    SELECT p.id, r.account_id, round(r.total / _months, 2)
    FROM public.people p
    WHERE p.version_id = _version_id AND p.unit_id = _unit_id
      AND EXISTS (SELECT 1 FROM public.plan_lines s JOIN public.plan_values v ON v.line_id = s.id
                  WHERE s.person_id = p.id AND v.amount > 0)
    ON CONFLICT (person_id, account_id) DO NOTHING;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.distribute_benefits(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distribute_benefits(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_plan_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NEW.benefit_person_id IS NOT NULL THEN
    SELECT * INTO p FROM public.people WHERE id = NEW.benefit_person_id;
    IF a.kind <> 'folha' OR NEW.event_id IS NOT NULL OR NEW.person_id IS NOT NULL THEN
      RAISE EXCEPTION 'O benefício de uma pessoa é uma linha de folha.';
    END IF;
    IF NOT FOUND OR p.version_id <> NEW.version_id OR p.unit_id <> NEW.unit_id THEN
      RAISE EXCEPTION 'A linha precisa estar na mesma unidade e versão da pessoa.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.people_sync_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.plan_lines l
  SET unit_id = NEW.unit_id,
      account_id = COALESCE((SELECT ct.account_id FROM public.contract_types ct WHERE ct.id = NEW.contract_type_id), l.account_id),
      description = NEW.name
  WHERE l.person_id = NEW.id;
  -- Os benefícios vão junto para a unidade nova (e absorvem a base do Omie de lá).
  UPDATE public.plan_lines SET unit_id = NEW.unit_id, description = NEW.name WHERE benefit_person_id = NEW.id;
  PERFORM public.sync_person_benefits(NEW.id);
  RETURN NEW;
END;
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
  INSERT INTO public.person_benefits (person_id, account_id, amount)
  SELECT (_person_map ->> pb.person_id::TEXT)::UUID, pb.account_id, pb.amount
  FROM public.person_benefits pb JOIN public.people p ON p.id = pb.person_id
  WHERE p.version_id = _source_id;

  RETURN _new;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_expense_base(_version_id uuid, _pct numeric DEFAULT 0, _mode text DEFAULT 'mes_a_mes'::text)
 RETURNS TABLE(lines integer, total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _year INT;
  _shared UUID;
  r RECORD;
  _id UUID;
  _lines INT := 0;
  _total NUMERIC := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro gera a base de despesas.';
  END IF;
  IF _pct <= -1 OR _mode NOT IN ('mes_a_mes', 'media') THEN RAISE EXCEPTION 'Reajuste ou distribuição inválidos.'; END IF;
  SELECT year INTO _year FROM public.budget_versions WHERE id = _version_id;
  IF _year IS NULL THEN RAISE EXCEPTION 'Versão não encontrada.'; END IF;
  SELECT NULLIF(value, '')::UUID INTO _shared FROM public.app_settings WHERE key = 'shared_cost_unit_id';

  DELETE FROM public.plan_lines WHERE version_id = _version_id AND origin = 'gerada';
  DELETE FROM public.benefit_bases WHERE version_id = _version_id;

  FOR r IN
    WITH heads AS (
      -- Benefícios e outros custos de folha sem unidade seguem as pessoas: divididos pelo número de pessoas da unidade.
      SELECT p.unit_id, count(*)::NUMERIC / SUM(count(*)) OVER () AS share
      FROM public.people p WHERE p.version_id = _version_id GROUP BY p.unit_id
    ), src AS (
      SELECT x.*, acc.id AS account_id, acc.kind AS account_kind, acc.unit_ids
      FROM public.omie_expense_attribution(_year - 1) x
      CROSS JOIN LATERAL public.account_for_category(x.category_name, _year) acc
      WHERE acc.treatment = 'lancavel' AND public.category_in_year(x.category_name, _year - 1)
    ), placed AS (
      SELECT s.unit_id, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, 1::NUMERIC AS share FROM src s WHERE s.unit_id IS NOT NULL
      UNION ALL
      SELECT h.unit_id, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, h.share
      FROM src s JOIN heads h ON true WHERE s.unit_id IS NULL AND s.account_kind = 'folha'
      UNION ALL
      SELECT _shared, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, 1
      FROM src s WHERE s.unit_id IS NULL
        AND (s.account_kind <> 'folha' OR NOT EXISTS (SELECT 1 FROM heads))
    ), att AS (
      SELECT pl.unit_id, pl.account_id, pl.supplier_name AS supplier, k AS month, (pl.paid[k] + pl.open[k]) * pl.share AS amount
      FROM placed pl CROSS JOIN generate_series(1, 12) k
      WHERE pl.unit_id IS NOT NULL AND (pl.unit_ids IS NULL OR pl.unit_id = ANY (pl.unit_ids))
    ), per_month AS (
      SELECT unit_id, account_id, supplier, month, SUM(amount) AS amount FROM att GROUP BY unit_id, account_id, supplier, month
    ), totals AS (
      SELECT unit_id, account_id, supplier, SUM(amount) AS total FROM per_month GROUP BY unit_id, account_id, supplier
    )
    SELECT t.unit_id, t.account_id, t.supplier,
      array_agg(round(CASE WHEN _mode = 'media' THEN t.total / 12 ELSE COALESCE(p.amount, 0) END * (1 + _pct), 2) ORDER BY k) AS months
    FROM totals t CROSS JOIN generate_series(1, 12) k
    LEFT JOIN per_month p ON p.unit_id = t.unit_id AND p.account_id = t.account_id AND p.supplier = t.supplier AND p.month = k
    GROUP BY t.unit_id, t.account_id, t.supplier
  LOOP
    CONTINUE WHEN (SELECT SUM(v) FROM unnest(r.months) v) = 0;
    -- Benefício já lançado por pessoa na unidade: a base do Omie fica só como referência.
    IF EXISTS (SELECT 1 FROM public.person_benefits pb JOIN public.people p ON p.id = pb.person_id
               WHERE p.version_id = _version_id AND p.unit_id = r.unit_id AND pb.account_id = r.account_id) THEN
      INSERT INTO public.benefit_bases (version_id, unit_id, account_id, amount)
      VALUES (_version_id, r.unit_id, r.account_id, (SELECT SUM(v) FROM unnest(r.months) v))
      ON CONFLICT (version_id, unit_id, account_id) DO UPDATE SET amount = benefit_bases.amount + EXCLUDED.amount;
      CONTINUE;
    END IF;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, origin, created_by)
    VALUES (_version_id, r.unit_id, r.account_id, COALESCE(NULLIF(r.supplier, ''), 'Base ' || (_year - 1) || ' (Omie)'), 'gerada', auth.uid())
    RETURNING id INTO _id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _id, k, r.months[k] FROM generate_series(1, 12) k WHERE r.months[k] <> 0;
    _lines := _lines + 1;
    _total := _total + (SELECT SUM(v) FROM unnest(r.months) v);
  END LOOP;
  RETURN QUERY SELECT _lines, _total;
END;
$function$;

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
    SELECT p.id AS person_id, p.unit_id, v.month, p.contract_type_id, p.dependents, l.account_id,
           make_date(yr.year, v.month, 1) AS ref,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
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
    SELECT pm.*, public.inss_empregado(pm.gross, pm.ref) AS inss FROM pm
  ), ret2 AS (
    SELECT ret.*, public.irrf(ret.gross, ret.inss, ret.dependents, ret.ref) AS ir FROM ret
  ), rules AS (
    SELECT r2.person_id, r2.unit_id, r2.month, c.payroll_group AS grupo, c.name AS item,
      CASE c.base_kind WHEN 'salario' THEN r2.gross ELSE CASE WHEN r2.gross > 0 THEN 1 ELSE 0 END END
        * COALESCE(public.param_value(c.parameter_definition_id, r2.ref, r2.unit_id, NULL, r2.contract_type_id, NULL), 0) AS amount
    FROM ret2 r2
    JOIN public.calc_rules c ON c.active AND c.base_kind IN ('salario', 'headcount')
      AND (c.contract_type_ids IS NULL OR r2.contract_type_id = ANY (c.contract_type_ids))
      AND (c.account_ids IS NULL OR r2.account_id = ANY (c.account_ids))
  )
  SELECT person_id, unit_id, month, 'bruto', 'Salário bruto', gross FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'INSS do empregado', inss FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'IRRF', ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'liquido', 'Salário líquido', gross - inss - ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, COALESCE(grupo, 'encargo'), item, amount FROM rules
  UNION ALL SELECT person_id, unit_id, month, 'beneficio', item, amount FROM ben
  UNION ALL SELECT r2.person_id, r2.unit_id, r2.month, 'custo_total', 'Custo total para a empresa',
    r2.gross + COALESCE((SELECT sum(x.amount) FROM rules x WHERE x.person_id = r2.person_id AND x.month = r2.month), 0)
      + COALESCE((SELECT sum(b.amount) FROM ben b WHERE b.person_id = r2.person_id AND b.month = r2.month), 0)
  FROM ret2 r2
$function$;
