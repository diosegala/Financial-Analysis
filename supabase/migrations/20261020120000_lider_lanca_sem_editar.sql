-- O líder lança linhas e eventos novos, mas não altera nem exclui o que já foi lançado: isso é do financeiro.
-- Como o líder não escreve mais direto nas tabelas, a criação passa por funções (launch_line, launch_event)
-- que checam unidade, tipo de conta e o status da versão e da unidade (as mesmas travas de antes).

DROP POLICY "Write lines by unit" ON public.plan_lines;
CREATE POLICY "Financeiro writes lines" ON public.plan_lines FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

DROP POLICY "Write values by line" ON public.plan_values;
CREATE POLICY "Financeiro writes values" ON public.plan_values FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

DROP POLICY "Write events by unit" ON public.events;
CREATE POLICY "Financeiro writes events" ON public.events FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- Cria uma linha de receita ou despesa (ou folha, só para o financeiro) já com os valores dos meses.
-- _values = [{"month": 3, "amount": 5000}, ...]
CREATE OR REPLACE FUNCTION public.launch_line(
  _version_id UUID, _unit_id UUID, _account_id UUID, _description TEXT, _client_id UUID,
  _product_id UUID, _revenue_type_id UUID, _values JSONB DEFAULT '[]'::JSONB
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
    revenue_type_id, created_by)
  VALUES (_version_id, _unit_id, _account_id, _description, _client_id, _product_id, _revenue_type_id, auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.plan_values (line_id, month, amount)
  SELECT _id, (v ->> 'month')::INT, (v ->> 'amount')::NUMERIC
  FROM jsonb_array_elements(COALESCE(_values, '[]'::JSONB)) AS v;

  RETURN _id;
END;
$$;

CREATE OR REPLACE FUNCTION public.launch_event(
  _version_id UUID, _unit_id UUID, _product_id UUID, _revenue_type_id UUID, _name TEXT, _month INT,
  _quantity NUMERIC, _price NUMERIC, _cost_per_participant NUMERIC, _fixed_cost NUMERIC,
  _revenue_account_id UUID, _cost_account_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_write_unit(auth.uid(), _unit_id) THEN
    RAISE EXCEPTION 'Você não lança nesta unidade.';
  END IF;
  INSERT INTO public.events (version_id, unit_id, product_id, revenue_type_id, name, month, quantity, price,
    cost_per_participant, fixed_cost, revenue_account_id, cost_account_id, created_by)
  VALUES (_version_id, _unit_id, _product_id, _revenue_type_id, _name, _month, _quantity, _price,
    _cost_per_participant, _fixed_cost, _revenue_account_id, _cost_account_id, auth.uid())
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.launch_line(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.launch_event(UUID, UUID, UUID, UUID, TEXT, INT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, UUID, UUID) FROM anon;
