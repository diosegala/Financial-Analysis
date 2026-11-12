-- Planilha de produtos de Educação (Google Sheets) integrada ao planejamento. Cada aba é um produto; a Edge Function
-- edu-sheet-sync lê a DRE de cada aba ligada e grava receitas, taxas, impostos, custos e despesas por mês.
-- Antes de travar a versão, a leitura troca os lançamentos que vieram da planilha. Depois de travada, o plano não muda:
-- a leitura grava a previsão, que o Acompanhamento usa nos meses abertos.

-- ───────────── Configuração ─────────────
CREATE TABLE public.edu_sheet_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spreadsheet_id TEXT,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  version_id UUID REFERENCES public.budget_versions(id) ON DELETE SET NULL,
  fee_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  tax_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.edu_sheet_settings IS
  'Planilha de produtos de Educação: o link (id), a unidade e a versão que ela alimenta e as contas de taxas e impostos.';

-- Uma aba por produto. As abas aparecem sozinhas na primeira leitura; o financeiro liga cada uma a um produto.
CREATE TABLE public.edu_sheet_tabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_name TEXT NOT NULL UNIQUE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  title TEXT,
  last_read_at TIMESTAMPTZ,
  last_error TEXT,
  warnings TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.edu_sheet_tabs.active IS 'Ligada: a leitura grava os valores desta aba no produto.';

CREATE TABLE public.edu_sheet_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando', 'concluida', 'com_erro')),
  automatic BOOLEAN NOT NULL DEFAULT false,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  tabs_read TEXT[] NOT NULL DEFAULT '{}',
  errors TEXT[] NOT NULL DEFAULT '{}',
  target TEXT CHECK (target IN ('plano', 'previsao'))
);

-- Depois de travada a versão: o valor de cada mês pela planilha (a previsão), por aba e conta.
CREATE TABLE public.edu_sheet_forecast (
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  tab_id UUID NOT NULL REFERENCES public.edu_sheet_tabs(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, tab_id, account_id, month)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['edu_sheet_settings', 'edu_sheet_tabs', 'edu_sheet_runs', 'edu_sheet_forecast'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Read %s" ON public.%I FOR SELECT TO authenticated USING (public.has_access(auth.uid()))', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['edu_sheet_settings', 'edu_sheet_tabs'] LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %s" ON public.%I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t, t);
    EXECUTE format('CREATE TRIGGER audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t, t);
    EXECUTE format('CREATE TRIGGER upd_%s BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
END $$;
CREATE UNIQUE INDEX edu_sheet_runs_one_running ON public.edu_sheet_runs ((true)) WHERE status = 'rodando';

-- ───────────── Lançamentos que vêm da planilha ─────────────
ALTER TABLE public.plan_lines DROP CONSTRAINT plan_lines_origin_check;
ALTER TABLE public.plan_lines ADD CONSTRAINT plan_lines_origin_check
  CHECK (origin IN ('manual', 'gerada', 'beneficio', 'planilha', 'planilha_deducao'));
ALTER TABLE public.plan_lines ADD COLUMN sheet_tab_id UUID REFERENCES public.edu_sheet_tabs(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.plan_lines.sheet_tab_id IS
  'Aba da planilha de Educação que gerou a linha. Linhas da planilha se corrigem na planilha, não no app.';

-- Taxas e impostos da planilha vão para contas calculadas (fora das grades): a validação deixa só a planilha lançar nelas.
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
  IF a.treatment = 'calculada' AND NEW.origin <> 'planilha_deducao' THEN
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

-- Contas das taxas e dos impostos que vêm prontos da planilha, na linha de impostos sobre a receita.
INSERT INTO public.accounts (name, kind, treatment, dre_line_id, unit_ids)
SELECT x.name, 'despesa', 'calculada', (SELECT id FROM public.dre_lines WHERE name = 'Impostos sobre a receita'),
  (SELECT array_agg(id) FROM public.units WHERE name = 'Educação')
FROM (VALUES ('Taxas sobre a receita - planilha de Educação'), ('Impostos sobre a receita - planilha de Educação')) x(name)
WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.name = x.name);

INSERT INTO public.edu_sheet_settings (unit_id, version_id, fee_account_id, tax_account_id)
SELECT (SELECT id FROM public.units WHERE name = 'Educação'),
  (SELECT id FROM public.budget_versions WHERE status <> 'travado' ORDER BY year DESC, created_at DESC LIMIT 1),
  (SELECT id FROM public.accounts WHERE name = 'Taxas sobre a receita - planilha de Educação'),
  (SELECT id FROM public.accounts WHERE name = 'Impostos sobre a receita - planilha de Educação');

-- ───────────── Base do plano: a receita da planilha não recebe as regras; taxas e impostos dela são dedução ─────────────
CREATE OR REPLACE FUNCTION public.plan_base_rows(_version_id uuid, _scenario_id uuid, _unit_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(unit_id uuid, month integer, row_kind text, account_id uuid, dre_line_id uuid, revenue_type_id uuid, product_id uuid, contract_type_id uuid, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT COALESCE(revenue_variation, 0) AS rv, COALESCE(expense_variation, 0) AS ev,
           COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  )
  -- Linhas lançadas nas grades e itens de eventos (a remuneração de pessoas vem abaixo). Da planilha de Educação:
  -- a receita entra como receita_planilha (sem as regras de imposto e comissão) e as taxas e impostos como dedução.
  SELECT l.unit_id, v.month,
    CASE WHEN l.origin = 'planilha_deducao' THEN 'deducao'
         WHEN l.origin = 'planilha' AND a.kind = 'receita' THEN 'receita_planilha'
         ELSE a.kind END,
    a.id, a.dre_line_id, l.revenue_type_id, l.product_id, NULL::UUID,
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
  -- Pessoas, no mês do pagamento
  SELECT c.unit_id, c.month, k.row_kind, c.account_id,
    CASE WHEN k.row_kind LIKE '%base\_%' THEN NULL ELSE a.dre_line_id END,
    NULL::UUID, NULL::UUID, c.contract_type_id, SUM(c.amount)
  FROM public.payroll_cash(_version_id, _scenario_id, _unit_ids) c
  JOIN public.accounts a ON a.id = c.account_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN c.part IN ('base_fgts', 'base_inss') THEN
      CASE WHEN c.source = 'salario' THEN '' ELSE 'p' END || 'base_' || substr(c.part, 6)
    WHEN c.part IN ('inss_inf', 'irrf_inf') THEN 'folha'
    WHEN c.source = 'salario' THEN 'salario'
    ELSE 'provisao' END AS row_kind) k
  GROUP BY c.unit_id, c.month, k.row_kind, c.account_id, a.dre_line_id, c.contract_type_id
  UNION ALL
  -- Headcount: 1 por pessoa nos meses em que há remuneração (base para benefícios por pessoa)
  SELECT l.unit_id, v.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.plan_values v ON v.line_id = l.id AND v.amount > 0
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
$function$;

CREATE OR REPLACE FUNCTION public.plan_split(_version_id uuid, _scenario_id uuid)
 RETURNS TABLE(unit_id uuid, month integer, bucket text, amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, NULL)),
  calc AS (
    SELECT b.unit_id, b.month, r.base_kind,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active
      AND public.rule_matches(r.base_kind, r.payment_component, r.on_provisions, b.row_kind)
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  )
  SELECT s.unit_id, s.month, s.bucket, SUM(s.amount) FROM (
    SELECT b.unit_id, b.month,
      CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'receita_planilha' THEN 'receita'
                      WHEN 'deducao' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END AS bucket, b.amount
    FROM base b
    WHERE b.row_kind IN ('receita', 'receita_planilha', 'deducao', 'despesa', 'folha', 'salario', 'provisao')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$function$;

-- ───────────── Gravação de uma aba ─────────────
-- _blocks: [{"kind": "receita|taxa|imposto|custo|despesa", "label": "...", "months": [12 valores]}].
-- Versão aberta: troca os lançamentos da aba (e tira os manuais do produto). Versão travada: grava a previsão.
CREATE FUNCTION public.edu_sheet_store(_run_id UUID, _tab TEXT, _title TEXT, _blocks JSONB, _warnings TEXT[],
  _error TEXT) RETURNS TEXT
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
    SELECT v.id, t.id, st.unit_id, x.account_id, m.month, SUM(m.amount)
    FROM jsonb_array_elements(_blocks) e
    CROSS JOIN LATERAL (SELECT CASE e->>'kind' WHEN 'receita' THEN p.revenue_account_id WHEN 'taxa' THEN st.fee_account_id
      WHEN 'imposto' THEN st.tax_account_id ELSE p.cost_account_id END AS account_id) x
    CROSS JOIN LATERAL (SELECT ord::INT AS month, val::NUMERIC AS amount
                        FROM jsonb_array_elements_text(e->'months') WITH ORDINALITY AS z(val, ord)) m
    GROUP BY x.account_id, m.month;
    RETURN 'previsao';
  END IF;

  -- Versão aberta: a planilha substitui o que havia do produto na unidade.
  DELETE FROM public.plan_lines WHERE version_id = v.id AND sheet_tab_id = t.id;
  DELETE FROM public.plan_lines l
  WHERE l.version_id = v.id AND l.unit_id = st.unit_id AND l.sheet_tab_id IS NULL AND l.person_id IS NULL
    AND l.benefit_person_id IS NULL AND l.event_id IS NULL
    AND (l.account_id = p.cost_account_id OR (l.account_id = p.revenue_account_id AND l.product_id = p.id));

  FOR b IN SELECT * FROM jsonb_array_elements(_blocks) LOOP
    _account := CASE b->>'kind' WHEN 'receita' THEN p.revenue_account_id WHEN 'taxa' THEN st.fee_account_id
      WHEN 'imposto' THEN st.tax_account_id ELSE p.cost_account_id END;
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

CREATE FUNCTION public.edu_sheet_start(_by UUID) RETURNS UUID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _id UUID;
BEGIN
  UPDATE public.edu_sheet_runs SET status = 'com_erro', finished_at = now(),
    errors = errors || 'A leitura foi interrompida.'::TEXT
  WHERE status = 'rodando' AND started_at < now() - interval '10 minutes';
  IF EXISTS (SELECT 1 FROM public.edu_sheet_runs WHERE status = 'rodando') THEN
    RAISE EXCEPTION 'Já há uma leitura da planilha em andamento.';
  END IF;
  INSERT INTO public.edu_sheet_runs (automatic, started_by) VALUES (_by IS NULL, _by) RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE FUNCTION public.edu_sheet_finish(_run_id UUID, _tabs TEXT[], _errors TEXT[], _target TEXT) RETURNS VOID
LANGUAGE sql SET search_path TO 'public' AS $$
  UPDATE public.edu_sheet_runs SET finished_at = now(), tabs_read = COALESCE(_tabs, '{}'),
    errors = COALESCE(_errors, '{}'), target = _target,
    status = CASE WHEN cardinality(COALESCE(_errors, '{}')) = 0 THEN 'concluida' ELSE 'com_erro' END
  WHERE id = _run_id;
$$;

REVOKE ALL ON FUNCTION public.edu_sheet_store(UUID, TEXT, TEXT, JSONB, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.edu_sheet_start(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.edu_sheet_finish(UUID, TEXT[], TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edu_sheet_store(UUID, TEXT, TEXT, JSONB, TEXT[], TEXT), public.edu_sheet_start(UUID),
  public.edu_sheet_finish(UUID, TEXT[], TEXT[], TEXT) TO service_role;

-- ───────────── Previsão do ano com a planilha (versão travada) ─────────────
CREATE OR REPLACE FUNCTION public.dre_compare(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (dre_line_id UUID, month INT, planned NUMERIC, actual NUMERIC, forecast NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH closed AS (SELECT closed_month AS m FROM public.budget_versions WHERE id = _version_id),
  months AS (SELECT generate_series(1, 12) AS month),
  leaf AS (SELECT * FROM public.dre_lines dl WHERE dl.active AND dl.kind IN ('lancada', 'calculada')),
  p AS (
    SELECT u.dre_line_id, u.month, SUM(u.amount) AS amount
    FROM public.dre_unit_values(_version_id, _scenario_id, _unit_ids) u GROUP BY 1, 2
  ),
  a AS (
    SELECT r.dre_line_id, r.month, SUM(r.amount) AS amount
    FROM public.actual_rows(_version_id, _scenario_id) r
    WHERE (_unit_ids IS NULL OR r.unit_id = ANY (_unit_ids)) GROUP BY 1, 2
  ),
  s AS (
    SELECT ac.dre_line_id, x.month, SUM(x.amount) AS amount FROM (
      SELECT account_id, to_month AS month, amount FROM public.plan_shifts
      WHERE version_id = _version_id AND (_unit_ids IS NULL OR unit_id = ANY (_unit_ids))
      UNION ALL
      SELECT account_id, from_month, -amount FROM public.plan_shifts
      WHERE version_id = _version_id AND (_unit_ids IS NULL OR unit_id = ANY (_unit_ids))
      UNION ALL
      -- Planilha de Educação: a previsão lida depois de travar, no lugar do que a aba tinha no plano.
      SELECT f.account_id, f.month, f.amount FROM public.edu_sheet_forecast f
      WHERE f.version_id = _version_id AND (_unit_ids IS NULL OR f.unit_id = ANY (_unit_ids))
      UNION ALL
      SELECT l.account_id, v.month, -v.amount FROM public.plan_lines l JOIN public.plan_values v ON v.line_id = l.id
      WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
        AND l.sheet_tab_id IN (SELECT DISTINCT tab_id FROM public.edu_sheet_forecast WHERE version_id = _version_id)
    ) x JOIN public.accounts ac ON ac.id = x.account_id GROUP BY 1, 2
  ),
  g AS (
    SELECT l.id AS dre_line_id, m.month, COALESCE(p.amount, 0) AS planned,
      CASE WHEN m.month <= c.m THEN COALESCE(a.amount, 0) ELSE 0 END AS actual,
      CASE WHEN m.month <= c.m THEN COALESCE(a.amount, 0) ELSE COALESCE(p.amount, 0) + COALESCE(s.amount, 0) END AS forecast
    FROM leaf l CROSS JOIN months m CROSS JOIN closed c
    LEFT JOIN p ON p.dre_line_id = l.id AND p.month = m.month
    LEFT JOIN a ON a.dre_line_id = l.id AND a.month = m.month
    LEFT JOIN s ON s.dre_line_id = l.id AND s.month = m.month
  ),
  sub AS (
    SELECT st.id AS dre_line_id, m.month,
      SUM(l.sign * g.planned) AS planned, SUM(l.sign * g.actual) AS actual, SUM(l.sign * g.forecast) AS forecast
    FROM public.dre_lines st CROSS JOIN months m
    JOIN leaf l ON l.sort_order < st.sort_order
    JOIN g ON g.dre_line_id = l.id AND g.month = m.month
    WHERE st.active AND st.kind = 'subtotal'
    GROUP BY st.id, m.month
  ),
  monthly AS (SELECT * FROM g UNION ALL SELECT * FROM sub),
  full_grid AS (
    SELECT * FROM monthly
    UNION ALL
    SELECT monthly.dre_line_id, 0, SUM(monthly.planned), SUM(monthly.actual), SUM(monthly.forecast) FROM monthly GROUP BY 1
  )
  SELECT f.dre_line_id, f.month, f.planned, f.actual, f.forecast FROM full_grid f
  WHERE public.can_see_units(_unit_ids)
  UNION ALL
  SELECT pc.id, n.month,
    COALESCE(n.planned / NULLIF(d.planned, 0), 0), COALESCE(n.actual / NULLIF(d.actual, 0), 0), COALESCE(n.forecast / NULLIF(d.forecast, 0), 0)
  FROM public.dre_lines pc
  JOIN full_grid n ON n.dre_line_id = pc.numerator_line_id
  JOIN full_grid d ON d.dre_line_id = pc.denominator_line_id AND d.month = n.month
  WHERE pc.kind = 'percentual' AND pc.active AND public.can_see_units(_unit_ids)
$$;
REVOKE EXECUTE ON FUNCTION public.dre_compare(UUID, UUID, UUID[]) FROM anon;

-- ───────────── Leitura diária, às 6h de Brasília ─────────────
-- Usa o endereço e o token do agendamento do Omie (Vault), trocando o nome da função.
CREATE FUNCTION public.edu_sheet_fire() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _url TEXT; _token TEXT;
BEGIN
  SELECT replace(decrypted_secret, 'omie-sync', 'edu-sheet-sync') INTO _url FROM vault.decrypted_secrets WHERE name = 'omie_sync_url';
  SELECT decrypted_secret INTO _token FROM vault.decrypted_secrets WHERE name = 'omie_sync_token';
  IF _url IS NULL OR _token IS NULL OR NOT EXISTS (SELECT 1 FROM public.edu_sheet_settings WHERE spreadsheet_id IS NOT NULL) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(url := _url, body := '{}'::JSONB,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-omie-sync-token', _token));
END $$;
REVOKE ALL ON FUNCTION public.edu_sheet_fire() FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('edu-sheet-diaria', '0 9 * * *', 'SELECT public.edu_sheet_fire()');
