-- Receitas por produto: o líder lança pelo produto e vê a receita por linha de produto (online × presencial).
-- Linha de produto = agrupamento editável (ex.: Treinamento online, Imersão, Fee mensal), com o formato de entrega.
-- Premissa por lançamento: o "de onde veio esse número" que a diretoria pergunta.

CREATE TABLE public.product_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  unit_id UUID REFERENCES public.units(id),
  format TEXT NOT NULL DEFAULT 'nenhum' CHECK (format IN ('online', 'presencial', 'hibrido', 'nenhum')),
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_lines_unit_name_unique
  ON public.product_lines (COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_lines TO authenticated;
GRANT ALL ON public.product_lines TO service_role;
ALTER TABLE public.product_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_lines" ON public.product_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Financeiro writes product_lines" ON public.product_lines FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
-- Como nos produtos: o líder mantém as linhas das próprias unidades.
CREATE POLICY "Lider writes product_lines of own units" ON public.product_lines FOR ALL TO authenticated
  USING (unit_id IS NOT NULL AND public.can_write_unit(auth.uid(), unit_id))
  WITH CHECK (unit_id IS NOT NULL AND public.can_write_unit(auth.uid(), unit_id));

CREATE TRIGGER audit_product_lines AFTER INSERT OR UPDATE OR DELETE ON public.product_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_product_lines BEFORE UPDATE ON public.product_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.products ADD COLUMN line_id UUID REFERENCES public.product_lines(id) ON DELETE SET NULL;
ALTER TABLE public.plan_lines ADD COLUMN note TEXT;

-- Linhas iniciais por unidade de negócio (dados: o financeiro e os líderes renomeiam, criam e desativam).
INSERT INTO public.product_lines (name, unit_id, format, sort_order)
SELECT l.name, u.id, l.format, l.sort_order
FROM (VALUES
  ('Educação', 'Treinamento online', 'online', 1),
  ('Educação', 'Treinamento presencial', 'presencial', 2),
  ('Educação', 'Imersão', 'presencial', 3),
  ('Educação', 'Evento', 'presencial', 4),
  ('Educação', 'Comunidade', 'online', 5),
  ('Consultoria', 'Consultoria recorrente', 'nenhum', 1),
  ('Consultoria', 'Projeto', 'nenhum', 2),
  ('Agência', 'Fee mensal', 'nenhum', 1),
  ('Agência', 'Job', 'nenhum', 2)
) AS l(unit_name, name, format, sort_order)
JOIN public.units u ON u.name = l.unit_name AND u.kind = 'negocio';

-- Lançar com a premissa.
DROP FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID, TEXT);
CREATE FUNCTION public.launch_line(
  _version_id UUID, _unit_id UUID, _account_id UUID, _description TEXT, _client_id UUID,
  _product_id UUID, _revenue_type_id UUID, _values JSONB DEFAULT '[]'::JSONB, _event_id UUID DEFAULT NULL,
  _revenue_origin TEXT DEFAULT NULL, _note TEXT DEFAULT NULL
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
    revenue_type_id, event_id, revenue_origin, note, created_by)
  VALUES (_version_id, _unit_id, _account_id, _description, _client_id, _product_id, _revenue_type_id,
    _event_id, _revenue_origin, NULLIF(btrim(_note), ''), auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _id, (v ->> 'month')::INT, (v ->> 'amount')::NUMERIC
  FROM jsonb_array_elements(COALESCE(_values, '[]'::JSONB)) AS v;

  RETURN _id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB, UUID, TEXT, TEXT) FROM anon;

-- Copiar versão: a premissa acompanha a linha (o resto igual a 20261026120000_origem_da_receita).
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
      revenue_type_id, event_id, person_id, revenue_origin, note, origin, sort_order, created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, (_event_map ->> rec.event_id::TEXT)::UUID, (_person_map ->> rec.person_id::TEXT)::UUID,
      rec.revenue_origin, rec.note, rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  RETURN _new;
END;
$$;

-- Receita planejada por origem e produto, mês a mês (linhas avulsas e itens de evento, que levam o produto do
-- evento). Abre o painel da meta por produto. Roda com as permissões de quem consulta.
CREATE FUNCTION public.revenue_by_product(_version_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, origin TEXT, product_id UUID, month INT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.unit_id, COALESCE(l.revenue_origin, 'sem_origem'), COALESCE(l.product_id, e.product_id), v.month,
    SUM(v.amount)
  FROM public.plan_lines l
  JOIN public.accounts a ON a.id = l.account_id AND a.kind = 'receita'
  JOIN public.plan_values v ON v.line_id = l.id
  LEFT JOIN public.events e ON e.id = l.event_id
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  GROUP BY 1, 2, 3, 4
$$;
REVOKE EXECUTE ON FUNCTION public.revenue_by_product(UUID, UUID[]) FROM anon;
