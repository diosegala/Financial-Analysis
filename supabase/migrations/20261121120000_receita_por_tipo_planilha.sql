-- Receita da planilha de Educação por tipo, como no Omie (ex.: "ICL Ingressos - 2027" e "ICL Patrocínio - 2027").
-- O produto ganha a conta de patrocínio e a da receita variável (vagas extras). Sem elas, o bloco vai para a conta da
-- receita do produto, como antes.

ALTER TABLE public.products
  ADD COLUMN sponsor_account_id UUID REFERENCES public.accounts(id),
  ADD COLUMN extra_account_id UUID REFERENCES public.accounts(id);

COMMENT ON COLUMN public.products.revenue_account_id IS 'Conta da receita (na planilha de Educação: ingressos).';
COMMENT ON COLUMN public.products.sponsor_account_id IS
  'Planilha de Educação: conta do bloco de patrocínio. Vazio = conta da receita.';
COMMENT ON COLUMN public.products.extra_account_id IS
  'Planilha de Educação: conta dos outros blocos de receita (variável, vagas extras). Vazio = conta da receita.';

-- Conta de um bloco da planilha, pelo tipo e pelo rótulo.
CREATE FUNCTION public.edu_sheet_account(p public.products, st public.edu_sheet_settings, _kind TEXT, _label TEXT)
RETURNS UUID LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE _kind
    WHEN 'receita' THEN CASE
      WHEN lower(btrim(_label)) LIKE 'ingresso%' THEN p.revenue_account_id
      WHEN lower(btrim(_label)) LIKE 'patroc%' THEN COALESCE(p.sponsor_account_id, p.revenue_account_id)
      ELSE COALESCE(p.extra_account_id, p.revenue_account_id) END
    WHEN 'taxa' THEN st.fee_account_id
    WHEN 'imposto' THEN st.tax_account_id
    ELSE p.cost_account_id END
$$;
REVOKE ALL ON FUNCTION public.edu_sheet_account(public.products, public.edu_sheet_settings, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edu_sheet_account(public.products, public.edu_sheet_settings, TEXT, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.edu_sheet_store(_run_id UUID, _tab TEXT, _title TEXT, _blocks JSONB,
  _warnings TEXT[], _error TEXT) RETURNS TEXT
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  st public.edu_sheet_settings%ROWTYPE;
  t public.edu_sheet_tabs%ROWTYPE;
  p public.products%ROWTYPE;
  v public.budget_versions%ROWTYPE;
  b JSONB;
  _account UUID;
  _origin TEXT;
  _line UUID;
BEGIN
  SELECT * INTO st FROM public.edu_sheet_settings ORDER BY created_at LIMIT 1;
  INSERT INTO public.edu_sheet_tabs (tab_name) VALUES (btrim(_tab)) ON CONFLICT (tab_name) DO NOTHING;
  UPDATE public.edu_sheet_tabs SET title = _title, last_read_at = now(), last_error = _error,
    warnings = COALESCE(_warnings, '{}')
  WHERE tab_name = btrim(_tab) RETURNING * INTO t;
  IF _error IS NOT NULL THEN RETURN 'erro'; END IF;
  IF NOT t.active OR t.product_id IS NULL THEN RETURN 'nao_ligada'; END IF;
  SELECT * INTO p FROM public.products WHERE id = t.product_id;
  SELECT * INTO v FROM public.budget_versions WHERE id = st.version_id;
  IF st.unit_id IS NULL OR v.id IS NULL THEN RAISE EXCEPTION 'Configure a unidade e a versão da planilha.'; END IF;
  IF p.revenue_account_id IS NULL OR p.cost_account_id IS NULL THEN
    UPDATE public.edu_sheet_tabs SET last_error = 'O produto não tem conta de receita e conta de custo.' WHERE id = t.id;
    RETURN 'erro';
  END IF;

  IF v.status = 'travado' THEN
    DELETE FROM public.edu_sheet_forecast WHERE version_id = v.id AND tab_id = t.id;
    INSERT INTO public.edu_sheet_forecast (version_id, tab_id, unit_id, account_id, month, amount)
    SELECT v.id, t.id, st.unit_id, public.edu_sheet_account(p, st, e->>'kind', e->>'label'), m.month, SUM(m.amount)
    FROM jsonb_array_elements(_blocks) e
    CROSS JOIN LATERAL (SELECT ord::INT AS month, val::NUMERIC AS amount
                        FROM jsonb_array_elements_text(e->'months') WITH ORDINALITY AS z(val, ord)) m
    GROUP BY 4, m.month;
    RETURN 'previsao';
  END IF;

  -- Versão aberta: a planilha substitui o que havia do produto na unidade.
  DELETE FROM public.plan_lines WHERE version_id = v.id AND sheet_tab_id = t.id;
  DELETE FROM public.plan_lines l
  WHERE l.version_id = v.id AND l.unit_id = st.unit_id AND l.sheet_tab_id IS NULL AND l.person_id IS NULL
    AND l.benefit_person_id IS NULL AND l.event_id IS NULL
    AND (l.account_id = p.cost_account_id
         OR (l.product_id = p.id
             AND l.account_id IN (p.revenue_account_id, p.sponsor_account_id, p.extra_account_id)));

  FOR b IN SELECT * FROM jsonb_array_elements(_blocks) LOOP
    _account := public.edu_sheet_account(p, st, b->>'kind', b->>'label');
    _origin := CASE WHEN b->>'kind' IN ('taxa', 'imposto') THEN 'planilha_deducao' ELSE 'planilha' END;
    IF _account IS NULL THEN RAISE EXCEPTION 'Configure as contas de taxas e de impostos da planilha.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b->'months') z WHERE z::NUMERIC <> 0) THEN CONTINUE; END IF;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, product_id, description, origin, sheet_tab_id)
    VALUES (v.id, st.unit_id, _account, CASE WHEN b->>'kind' = 'receita' THEN p.id END,
      p.name || ' · ' || initcap(lower(b->>'label')), _origin, t.id)
    RETURNING id INTO _line;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _line, ord::INT, val::NUMERIC FROM jsonb_array_elements_text(b->'months') WITH ORDINALITY AS z(val, ord);
  END LOOP;
  RETURN 'plano';
END $$;

-- As contas novas também contam como em uso.
CREATE OR REPLACE FUNCTION public.accounts_in_use() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT id FROM (
    SELECT account_id AS id FROM public.plan_lines
    UNION ALL SELECT account_id FROM public.contract_types
    UNION ALL SELECT revenue_account_id FROM public.products WHERE revenue_account_id IS NOT NULL
    UNION ALL SELECT cost_account_id FROM public.products WHERE cost_account_id IS NOT NULL
    UNION ALL SELECT sponsor_account_id FROM public.products WHERE sponsor_account_id IS NOT NULL
    UNION ALL SELECT extra_account_id FROM public.products WHERE extra_account_id IS NOT NULL
    UNION ALL SELECT unnest(account_ids) FROM public.calc_rules WHERE account_ids IS NOT NULL
  ) used
  WHERE public.has_role(auth.uid(), 'financeiro')
$$;
