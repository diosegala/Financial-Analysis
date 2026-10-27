-- Alertas: detectores em SQL sobre o realizado do Omie e o plano, com limites editáveis (app_settings), e o resumo
-- por unidade escrito pela IA (gravado pela Edge Function alerts-digest).

CREATE TABLE public.alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('alta', 'media', 'baixa')),
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  period DATE,                                    -- mês do realizado que gerou o alerta
  version_id UUID REFERENCES public.budget_versions(id) ON DELETE CASCADE, -- alertas do plano
  ref TEXT NOT NULL UNIQUE,                       -- evita repetir o mesmo alerta
  title TEXT NOT NULL,
  detail TEXT,
  value NUMERIC,
  change NUMERIC,                                 -- variação (ex.: -0,35 = 35% abaixo)
  link TEXT,
  status TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'visto')),
  seen_at TIMESTAMPTZ,
  seen_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_unit_idx ON public.alerts (unit_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read alerts" ON public.alerts FOR SELECT TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
    OR (unit_id IS NOT NULL AND public.has_unit(auth.uid(), unit_id)));
CREATE POLICY "Financeiro writes alerts" ON public.alerts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- Resumo escrito pela IA: um por unidade (unit_id nulo = empresa) e mês de referência.
CREATE TABLE public.alert_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  period DATE NOT NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  model TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_summaries TO authenticated;
GRANT ALL ON public.alert_summaries TO service_role;
ALTER TABLE public.alert_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read alert_summaries" ON public.alert_summaries FOR SELECT TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
    OR (unit_id IS NOT NULL AND public.has_unit(auth.uid(), unit_id)));
CREATE POLICY "Financeiro writes alert_summaries" ON public.alert_summaries FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- Limites dos detectores (o financeiro ajusta na página Alertas).
INSERT INTO public.app_settings (key, value, label) VALUES
  ('alert_revenue_drop_pct', '25', 'Alerta de receita: queda em % contra a média dos 3 meses anteriores ou o mesmo mês do ano anterior'),
  ('alert_concentration_pct', '30', 'Alerta de concentração: % da receita da unidade em um só cliente (12 meses)'),
  ('alert_expense_rise_pct', '50', 'Alerta de despesa: alta em % contra a média dos 3 meses anteriores'),
  ('alert_expense_min', '3000', 'Alerta de despesa: diferença mínima em R$ para avisar'),
  ('alert_new_supplier_min', '5000', 'Alerta de fornecedor novo: valor mínimo em R$ no mês'),
  ('alert_plan_gap_pct', '10', 'Alerta do plano: receita planejada abaixo da meta em mais de %')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION public.alert_setting(_key TEXT, _default NUMERIC) RETURNS NUMERIC
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT NULLIF(replace(value, ',', '.'), '')::NUMERIC FROM public.app_settings WHERE key = _key), _default)
$$;

-- Roda os detectores para o último mês fechado (ou _ref) e para a versão/cenário do plano. Troca os alertas ainda
-- não vistos daquele mês e daquela versão; os já vistos ficam. Devolve quantos alertas há agora.
CREATE FUNCTION public.alerts_refresh(_version_id UUID DEFAULT NULL, _scenario_id UUID DEFAULT NULL, _ref DATE DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m DATE := COALESCE(date_trunc('month', _ref), date_trunc('month', now()) - INTERVAL '1 month')::DATE;
  y INT := extract(year FROM m)::INT;
  drop_pct NUMERIC := public.alert_setting('alert_revenue_drop_pct', 25) / 100;
  conc_pct NUMERIC := public.alert_setting('alert_concentration_pct', 30) / 100;
  rise_pct NUMERIC := public.alert_setting('alert_expense_rise_pct', 50) / 100;
  exp_min NUMERIC := public.alert_setting('alert_expense_min', 3000);
  sup_min NUMERIC := public.alert_setting('alert_new_supplier_min', 5000);
  gap_pct NUMERIC := public.alert_setting('alert_plan_gap_pct', 10) / 100;
  mes TEXT := to_char(m, 'MM/YYYY');
  n INT;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro atualiza os alertas.';
  END IF;
  DELETE FROM public.alerts WHERE status = 'novo'
    AND (period = m OR (_version_id IS NOT NULL AND version_id = _version_id));

  -- Séries mensais do realizado (ano anterior e ano do mês de referência).
  PERFORM set_config('client_min_messages', 'warning', true);
  DROP TABLE IF EXISTS rev, exp;
  CREATE TEMP TABLE rev ON COMMIT DROP AS
  SELECT a.unit_id, a.client_name, make_date(a.yr, i, 1) AS d, a.received[i] AS amt
  FROM (SELECT y - 1 AS yr, * FROM public.omie_revenue_attribution(y - 1)
        UNION ALL SELECT y, * FROM public.omie_revenue_attribution(y)) a
  CROSS JOIN generate_series(1, 12) i
  WHERE COALESCE(a.received[i], 0) <> 0;
  CREATE TEMP TABLE exp ON COMMIT DROP AS
  SELECT a.unit_id, a.category_name, a.supplier_name, make_date(a.yr, i, 1) AS d, a.paid[i] AS amt
  FROM (SELECT y - 1 AS yr, * FROM public.omie_expense_attribution(y - 1)
        UNION ALL SELECT y, * FROM public.omie_expense_attribution(y)) a
  CROSS JOIN generate_series(1, 12) i
  WHERE COALESCE(a.paid[i], 0) <> 0;

  -- Receita da unidade abaixo da média dos 3 meses anteriores.
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, change, link)
  SELECT 'receita_queda_media', CASE WHEN cur < avg3 * (1 - 2 * drop_pct) THEN 'alta' ELSE 'media' END,
    unit_id, m, concat_ws('|', 'receita_queda_media', unit_id, m),
    'Receita abaixo da média dos 3 meses anteriores',
    format('Recebido em %s: %s%% da média de %s a %s.', mes, round(cur / avg3 * 100),
      to_char(m - INTERVAL '3 months', 'MM/YYYY'), to_char(m - INTERVAL '1 month', 'MM/YYYY')),
    cur, cur / avg3 - 1, '/realizado'
  FROM (SELECT unit_id,
          SUM(amt) FILTER (WHERE d = m) AS cur,
          SUM(amt) FILTER (WHERE d >= m - INTERVAL '3 months' AND d < m) / 3 AS avg3
        FROM rev WHERE unit_id IS NOT NULL GROUP BY unit_id) s
  WHERE avg3 > 0 AND COALESCE(cur, 0) < avg3 * (1 - drop_pct)
  ON CONFLICT (ref) DO NOTHING;

  -- Receita da unidade abaixo do mesmo mês do ano anterior.
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, change, link)
  SELECT 'receita_queda_ano', CASE WHEN COALESCE(cur, 0) < prev * (1 - 2 * drop_pct) THEN 'alta' ELSE 'media' END,
    unit_id, m, concat_ws('|', 'receita_queda_ano', unit_id, m),
    'Receita abaixo do mesmo mês do ano anterior',
    format('Recebido em %s: %s%% do recebido em %s.', mes, round(COALESCE(cur, 0) / prev * 100),
      to_char(m - INTERVAL '1 year', 'MM/YYYY')),
    COALESCE(cur, 0), COALESCE(cur, 0) / prev - 1, '/realizado'
  FROM (SELECT unit_id,
          SUM(amt) FILTER (WHERE d = m) AS cur,
          SUM(amt) FILTER (WHERE d = m - INTERVAL '1 year') AS prev
        FROM rev WHERE unit_id IS NOT NULL GROUP BY unit_id) s
  WHERE prev > 0 AND COALESCE(cur, 0) < prev * (1 - drop_pct)
  ON CONFLICT (ref) DO NOTHING;

  -- Cliente recorrente sem recebimento nos 2 últimos meses (sinal de perda).
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, link)
  SELECT 'cliente_parou', 'media', unit_id, m, concat_ws('|', 'cliente_parou', unit_id, client_name, m),
    format('%s sem recebimento há 2 meses', client_name),
    format('Pagou em %s dos 4 meses anteriores (média de %s por mês) e nada em %s e %s.', months,
      to_char(round(avg_amt), 'FM999G999G999'), to_char(m - INTERVAL '1 month', 'MM/YYYY'), mes),
    avg_amt, '/realizado'
  FROM (SELECT unit_id, client_name,
          count(DISTINCT d) FILTER (WHERE d >= m - INTERVAL '5 months' AND d < m - INTERVAL '1 month') AS months,
          SUM(amt) FILTER (WHERE d >= m - INTERVAL '5 months' AND d < m - INTERVAL '1 month')
            / NULLIF(count(DISTINCT d) FILTER (WHERE d >= m - INTERVAL '5 months' AND d < m - INTERVAL '1 month'), 0) AS avg_amt,
          SUM(amt) FILTER (WHERE d >= m - INTERVAL '1 month' AND d <= m) AS recent
        FROM rev WHERE unit_id IS NOT NULL AND client_name IS NOT NULL GROUP BY unit_id, client_name) s
  WHERE months >= 3 AND COALESCE(recent, 0) <= 0 AND avg_amt > 0
  ON CONFLICT (ref) DO NOTHING;

  -- Concentração: um cliente com mais de X% da receita da unidade nos últimos 12 meses.
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, change, link)
  SELECT 'concentracao', CASE WHEN share > 0.5 THEN 'media' ELSE 'baixa' END, unit_id, m,
    concat_ws('|', 'concentracao', unit_id, client_name, m),
    format('%s concentra %s%% da receita', client_name, round(share * 100)),
    format('Nos 12 meses até %s. Perder este cliente afeta a meta da unidade.', mes), amt, share, '/realizado'
  FROM (SELECT unit_id, client_name, SUM(amt) AS amt,
          SUM(amt) / NULLIF(SUM(SUM(amt)) OVER (PARTITION BY unit_id), 0) AS share,
          count(*) OVER (PARTITION BY unit_id) AS clients
        FROM rev WHERE unit_id IS NOT NULL AND d > m - INTERVAL '12 months' AND d <= m
        GROUP BY unit_id, client_name) s
  -- Com menos de 3 clientes a concentração é óbvia e não ajuda.
  WHERE share > conc_pct AND client_name IS NOT NULL AND clients >= 3
  ON CONFLICT (ref) DO NOTHING;

  -- Despesa da categoria acima da média dos 3 meses anteriores.
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, change, link)
  SELECT 'despesa_alta', CASE WHEN cur > avg3 * (1 + 2 * rise_pct) THEN 'alta' ELSE 'media' END,
    unit_id, m, concat_ws('|', 'despesa_alta', unit_id, category_name, m),
    format('%s acima da média', category_name),
    format('Pago em %s: %s%% acima da média dos 3 meses anteriores.', mes, round((cur / avg3 - 1) * 100)),
    cur, cur / avg3 - 1, '/realizado'
  FROM (SELECT unit_id, category_name,
          SUM(amt) FILTER (WHERE d = m) AS cur,
          SUM(amt) FILTER (WHERE d >= m - INTERVAL '3 months' AND d < m) / 3 AS avg3
        FROM exp GROUP BY unit_id, category_name) s
  WHERE avg3 > 0 AND cur > avg3 * (1 + rise_pct) AND cur - avg3 >= exp_min
  ON CONFLICT (ref) DO NOTHING;

  -- Fornecedor novo: pago no mês, sem pagamento nos 12 meses anteriores.
  INSERT INTO public.alerts (kind, severity, unit_id, period, ref, title, detail, value, link)
  SELECT 'fornecedor_novo', 'baixa', unit_id, m, concat_ws('|', 'fornecedor_novo', unit_id, supplier_name, m),
    format('Fornecedor novo: %s', supplier_name),
    format('Primeiro pagamento em 12 meses, em %s (%s).', mes, categories), cur, '/realizado'
  FROM (SELECT unit_id, supplier_name, string_agg(DISTINCT category_name, ', ') FILTER (WHERE d = m) AS categories,
          SUM(amt) FILTER (WHERE d = m) AS cur,
          SUM(amt) FILTER (WHERE d >= m - INTERVAL '12 months' AND d < m) AS before
        FROM exp WHERE supplier_name IS NOT NULL AND supplier_name <> '' GROUP BY unit_id, supplier_name) s
  WHERE cur >= sup_min AND COALESCE(before, 0) = 0
  ON CONFLICT (ref) DO NOTHING;

  IF _version_id IS NOT NULL THEN
    -- Unidade de negócio sem receita lançada no plano.
    INSERT INTO public.alerts (kind, severity, unit_id, version_id, ref, title, detail, link)
    SELECT 'plano_sem_receita', 'media', u.id, _version_id, concat_ws('|', 'plano_sem_receita', u.id, _version_id),
      'Unidade sem receita lançada', 'Nenhuma linha de receita nesta versão do plano.', '/receitas'
    FROM public.units u
    WHERE u.kind = 'negocio' AND u.active AND NOT EXISTS (
      SELECT 1 FROM public.plan_lines l JOIN public.accounts a ON a.id = l.account_id AND a.kind = 'receita'
      WHERE l.version_id = _version_id AND l.unit_id = u.id)
    ON CONFLICT (ref) DO NOTHING;

    -- Linhas de receita sem origem (carteira, renovação ou nova).
    INSERT INTO public.alerts (kind, severity, unit_id, version_id, ref, title, detail, value, link)
    SELECT 'plano_sem_origem', 'baixa', l.unit_id, _version_id, concat_ws('|', 'plano_sem_origem', l.unit_id, _version_id),
      format('%s linha(s) de receita sem origem', count(*)),
      'Sem a origem, a linha não entra em Carteira, Renovações ou Vendas novas no painel da meta.', count(*), '/receitas'
    FROM public.plan_lines l JOIN public.accounts a ON a.id = l.account_id AND a.kind = 'receita'
    WHERE l.version_id = _version_id AND l.revenue_origin IS NULL
    GROUP BY l.unit_id
    ON CONFLICT (ref) DO NOTHING;

    -- Receita planejada abaixo da meta.
    IF _scenario_id IS NOT NULL THEN
      INSERT INTO public.alerts (kind, severity, unit_id, version_id, ref, title, detail, value, change, link)
      SELECT 'plano_abaixo_meta', CASE WHEN planned < target * (1 - 3 * gap_pct) THEN 'alta' ELSE 'media' END,
        t.unit_id, _version_id, concat_ws('|', 'plano_abaixo_meta', t.unit_id, _version_id, _scenario_id),
        format('Planejado em %s%% da meta', round(planned / target * 100)),
        'A receita lançada ainda não cobre a meta de receita da unidade no ano.', planned, planned / target - 1, '/receitas'
      FROM (SELECT unit_id, SUM(amount) AS target FROM public.revenue_targets
            WHERE scenario_id = _scenario_id GROUP BY unit_id) t
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(r.amount), 0) AS planned
        FROM public.revenue_by_nature(_version_id, _scenario_id, ARRAY[t.unit_id]) r) p
      WHERE t.target > 0 AND planned > 0 AND planned < t.target * (1 - gap_pct) -- sem receita: alerta acima
      ON CONFLICT (ref) DO NOTHING;
    END IF;
  END IF;

  SELECT count(*) INTO n FROM public.alerts WHERE period = m OR version_id = _version_id;
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.alerts_refresh(UUID, UUID, DATE) FROM anon;

-- Marcar como visto: quem vê o alerta (financeiro, gestão ou o líder da unidade).
CREATE FUNCTION public.mark_alert_seen(_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.alerts SET status = 'visto', seen_at = now(), seen_by = auth.uid()
  WHERE id = _id AND (public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
    OR (unit_id IS NOT NULL AND public.has_unit(auth.uid(), unit_id)));
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_alert_seen(UUID) FROM anon;
