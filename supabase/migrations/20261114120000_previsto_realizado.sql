-- Previsto × realizado: o realizado do Omie na estrutura da DRE, por unidade e mês, e a previsão do ano
-- (realizado dos meses fechados + previsto dos abertos + remanejamentos). Remanejamentos e ajustes valem com o plano
-- travado: não alteram o plano aprovado. Análise por IA guardada por unidade.

ALTER TABLE public.budget_versions
  ADD COLUMN closed_month INT NOT NULL DEFAULT 0 CHECK (closed_month BETWEEN 0 AND 12);
COMMENT ON COLUMN public.budget_versions.closed_month IS 'Último mês com o realizado fechado; o financeiro define.';

-- Pagamento que mudou de mês dentro do ano: o plano não muda, a previsão sim.
CREATE TABLE public.plan_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  from_month INT NOT NULL CHECK (from_month BETWEEN 1 AND 12),
  to_month INT NOT NULL CHECK (to_month BETWEEN 1 AND 12),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL CHECK (btrim(note) <> ''),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_month <> to_month)
);
-- Correção do realizado quando o Omie não reflete o fato (positivo soma, negativo tira, na conta e no mês).
CREATE TABLE public.actual_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC NOT NULL CHECK (amount <> 0),
  note TEXT NOT NULL CHECK (btrim(note) <> ''),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Última análise da IA de cada unidade (unit_id vazio = empresa).
CREATE TABLE public.dre_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  model TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dre_analyses_scope ON public.dre_analyses (version_id, COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::UUID));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['plan_shifts', 'actual_adjustments', 'dre_analyses'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;
CREATE POLICY "Read shifts by unit" ON public.plan_shifts FOR SELECT TO authenticated USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Write shifts by unit" ON public.plan_shifts FOR ALL TO authenticated
  USING (public.can_write_unit(auth.uid(), unit_id)) WITH CHECK (public.can_write_unit(auth.uid(), unit_id));
CREATE POLICY "Read adjustments by unit" ON public.actual_adjustments FOR SELECT TO authenticated USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes adjustments" ON public.actual_adjustments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Read analyses" ON public.dre_analyses FOR SELECT TO authenticated
  USING (CASE WHEN unit_id IS NULL THEN public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
              ELSE public.has_unit(auth.uid(), unit_id) END);
CREATE POLICY "Write analyses" ON public.dre_analyses FOR ALL TO authenticated
  USING (CASE WHEN unit_id IS NULL THEN public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
              ELSE public.has_unit(auth.uid(), unit_id) END)
  WITH CHECK (CASE WHEN unit_id IS NULL THEN public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
              ELSE public.has_unit(auth.uid(), unit_id) END);

-- ───────────── O realizado na estrutura do plano ─────────────
-- Unidade de cada valor pago: a da conta ou da atribuição; folha sem unidade segue a pessoa pelo fornecedor. O que ainda
-- ficar sem unidade é dividido: folha pela folha planejada do mês; impostos e comissões pela receita realizada do mês;
-- o resto vai para a unidade de custos compartilhados. Receita sem unidade fica sem unidade (aparece na conferência).
CREATE OR REPLACE FUNCTION public.actual_rows(_version_id UUID, _scenario_id UUID)
RETURNS TABLE (unit_id UUID, account_id UUID, dre_line_id UUID, month INT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  shared AS (SELECT NULLIF(value, '')::UUID AS id FROM public.app_settings WHERE key = 'shared_cost_unit_id'),
  who AS (
    SELECT DISTINCT ON (public.norm_text(p.name)) public.norm_text(p.name) AS name, p.unit_id
    FROM public.people p WHERE p.version_id = _version_id ORDER BY public.norm_text(p.name), p.id
  ),
  exp AS (
    SELECT COALESCE(public.owner_unit(x.unit_id, acc.unit_ids),
             CASE WHEN acc.kind = 'folha' THEN w.unit_id END) AS unit_id,
      acc.id AS account_id, acc.dre_line_id, acc.kind, dl.kind AS line_kind, k AS month, x.paid[k] AS amount
    FROM v CROSS JOIN LATERAL public.omie_expense_attribution(v.year) x
    CROSS JOIN LATERAL public.account_for_category(x.category_name, v.year) acc
    JOIN public.dre_lines dl ON dl.id = acc.dre_line_id
    LEFT JOIN who w ON w.name = public.norm_text(x.supplier_name)
    CROSS JOIN generate_series(1, 12) k
    WHERE acc.treatment <> 'fora_dre' AND public.category_in_year(x.category_name, v.year) AND x.paid[k] <> 0
  ),
  rev AS (
    SELECT public.owner_unit(r.unit_id, acc.unit_ids) AS unit_id, acc.id AS account_id, acc.dre_line_id, k AS month,
      r.received[k] AS amount
    FROM v CROSS JOIN LATERAL public.omie_revenue_attribution(v.year) r
    CROSS JOIN LATERAL public.revenue_account_for_category(r.category_name, v.year) acc
    CROSS JOIN generate_series(1, 12) k
    WHERE acc.treatment <> 'fora_dre' AND public.category_in_year(r.category_name, v.year) AND r.received[k] <> 0
  ),
  folha_share AS (
    SELECT p.unit_id, p.month, p.amount / NULLIF(SUM(p.amount) OVER (PARTITION BY p.month), 0) AS share
    FROM public.plan_split(_version_id, _scenario_id) p WHERE p.bucket = 'folha' AND p.amount > 0
  ),
  rev_share AS (
    SELECT t.unit_id, t.month, t.amount / NULLIF(SUM(t.amount) OVER (PARTITION BY t.month), 0) AS share
    FROM (SELECT r.unit_id, r.month, SUM(r.amount) AS amount FROM rev r WHERE r.unit_id IS NOT NULL
          GROUP BY r.unit_id, r.month HAVING SUM(r.amount) > 0) t
  ),
  loose AS (
    SELECT e.*, CASE WHEN e.kind = 'folha' THEN 'folha' WHEN e.line_kind = 'calculada' THEN 'receita' ELSE 'resto' END AS rule
    FROM exp e WHERE e.unit_id IS NULL
  ),
  spread AS (
    SELECT s.unit_id, l.account_id, l.dre_line_id, l.month, l.amount * s.share AS amount
    FROM loose l JOIN folha_share s ON s.month = l.month WHERE l.rule = 'folha'
    UNION ALL
    SELECT s.unit_id, l.account_id, l.dre_line_id, l.month, l.amount * s.share
    FROM loose l JOIN rev_share s ON s.month = l.month WHERE l.rule = 'receita'
    UNION ALL
    SELECT (SELECT id FROM shared), l.account_id, l.dre_line_id, l.month, l.amount
    FROM loose l
    WHERE l.rule = 'resto'
       OR (l.rule = 'folha' AND NOT EXISTS (SELECT 1 FROM folha_share s WHERE s.month = l.month))
       OR (l.rule = 'receita' AND NOT EXISTS (SELECT 1 FROM rev_share s WHERE s.month = l.month))
  ),
  adj AS (
    SELECT a.unit_id, a.account_id, ac.dre_line_id, a.month, a.amount
    FROM public.actual_adjustments a JOIN public.accounts ac ON ac.id = a.account_id
    WHERE a.version_id = _version_id
  )
  SELECT x.unit_id, x.account_id, x.dre_line_id, x.month, SUM(x.amount) FROM (
    SELECT e.unit_id, e.account_id, e.dre_line_id, e.month, e.amount FROM exp e WHERE e.unit_id IS NOT NULL
    UNION ALL SELECT r.unit_id, r.account_id, r.dre_line_id, r.month, r.amount FROM rev r
    UNION ALL SELECT * FROM spread
    UNION ALL SELECT * FROM adj
  ) x GROUP BY x.unit_id, x.account_id, x.dre_line_id, x.month
$$;
REVOKE EXECUTE ON FUNCTION public.actual_rows(UUID, UUID) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_see_units(_unit_ids UUID[]) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[])
    OR (_unit_ids IS NOT NULL AND array_length(_unit_ids, 1) > 0
        AND NOT EXISTS (SELECT 1 FROM unnest(_unit_ids) u WHERE NOT public.has_unit(auth.uid(), u)))
$$;
REVOKE EXECUTE ON FUNCTION public.can_see_units(UUID[]) FROM anon;

-- Previsto, realizado e previsão por linha da DRE e mês (0 = ano). Sem unidades = empresa inteira.
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

-- Por categoria: base do ano anterior, previsto e realizado, por mês. Mostra onde estão as diferenças.
CREATE OR REPLACE FUNCTION public.account_compare(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (account_id UUID, name TEXT, kind TEXT, month INT, base NUMERIC, planned NUMERIC, actual NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT year, closed_month FROM public.budget_versions WHERE id = _version_id),
  p AS (
    SELECT l.account_id, m.month, SUM(m.amount) AS amount
    FROM public.plan_lines l JOIN public.plan_values m ON m.line_id = l.id
    WHERE l.version_id = _version_id AND l.person_id IS NULL AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
    GROUP BY 1, 2
  ),
  a AS (
    SELECT r.account_id, r.month, SUM(r.amount) AS amount FROM public.actual_rows(_version_id, _scenario_id) r, v
    WHERE r.month <= v.closed_month AND (_unit_ids IS NULL OR r.unit_id = ANY (_unit_ids)) GROUP BY 1, 2
  ),
  b AS (
    SELECT r.account_id, r.month, SUM(r.amount) AS amount FROM v, public.reference_rows(v.year - 1) r
    WHERE _unit_ids IS NULL OR r.unit_id = ANY (_unit_ids) GROUP BY 1, 2
  ),
  keys AS (SELECT p.account_id, p.month FROM p UNION SELECT a.account_id, a.month FROM a UNION SELECT b.account_id, b.month FROM b)
  SELECT k.account_id, ac.name, ac.kind, k.month, COALESCE(b.amount, 0), COALESCE(p.amount, 0), COALESCE(a.amount, 0)
  FROM keys k JOIN public.accounts ac ON ac.id = k.account_id
  LEFT JOIN p ON p.account_id = k.account_id AND p.month = k.month
  LEFT JOIN a ON a.account_id = k.account_id AND a.month = k.month
  LEFT JOIN b ON b.account_id = k.account_id AND b.month = k.month
  WHERE public.can_see_units(_unit_ids)
$$;
REVOKE EXECUTE ON FUNCTION public.account_compare(UUID, UUID, UUID[]) FROM anon;

-- Conferência do financeiro: o que veio do Omie no ano e não encontrou conta ou unidade.
CREATE OR REPLACE FUNCTION public.actual_unmatched(_version_id UUID)
RETURNS TABLE (issue TEXT, category_name TEXT, amount NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT year FROM public.budget_versions WHERE id = _version_id)
  SELECT 'Despesa sem conta', x.category_name, SUM((SELECT COALESCE(SUM(e), 0) FROM unnest(x.paid) e))
  FROM v CROSS JOIN LATERAL public.omie_expense_attribution(v.year) x
  LEFT JOIN LATERAL public.account_for_category(x.category_name, v.year) acc ON true
  WHERE acc.id IS NULL AND public.has_role(auth.uid(), 'financeiro') GROUP BY 2
  HAVING SUM((SELECT COALESCE(SUM(e), 0) FROM unnest(x.paid) e)) <> 0
  UNION ALL
  SELECT CASE WHEN acc.id IS NULL THEN 'Receita sem conta' ELSE 'Receita sem unidade' END, r.category_name,
    SUM((SELECT COALESCE(SUM(e), 0) FROM unnest(r.received) e))
  FROM v CROSS JOIN LATERAL public.omie_revenue_attribution(v.year) r
  LEFT JOIN LATERAL public.revenue_account_for_category(r.category_name, v.year) acc ON true
  WHERE (acc.id IS NULL OR public.owner_unit(r.unit_id, acc.unit_ids) IS NULL) AND public.has_role(auth.uid(), 'financeiro')
  GROUP BY 1, 2
  HAVING SUM((SELECT COALESCE(SUM(e), 0) FROM unnest(r.received) e)) <> 0
$$;
REVOKE EXECUTE ON FUNCTION public.actual_unmatched(UUID) FROM anon;

-- ───────────── Configuração da IA pela tela ─────────────
-- A chave fica criptografada no Vault. Só o financeiro grava ou apaga; ninguém lê pela API: a tela mostra só os 4 últimos
-- caracteres e só a função de análise, no servidor, recebe a chave.
CREATE TABLE public.ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL DEFAULT true,
  model TEXT NOT NULL DEFAULT 'claude-opus-5-5',
  key_last4 TEXT,
  key_updated_at TIMESTAMPTZ,
  key_updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_settings_single ON public.ai_settings ((true));
INSERT INTO public.ai_settings DEFAULT VALUES;
GRANT SELECT, UPDATE ON public.ai_settings TO authenticated;
GRANT ALL ON public.ai_settings TO service_role;
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Financeiro reads ai_settings" ON public.ai_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Financeiro updates ai_settings" ON public.ai_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER audit_ai_settings AFTER INSERT OR UPDATE OR DELETE ON public.ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER upd_ai_settings BEFORE UPDATE ON public.ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.set_ai_key(_key TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _secret UUID;
  _clean TEXT := btrim(_key);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro configura a IA.';
  END IF;
  IF _clean IS NULL OR length(_clean) < 20 OR _clean !~ '^sk-' THEN
    RAISE EXCEPTION 'Esta não parece uma chave da API do Claude.';
  END IF;
  SELECT id INTO _secret FROM vault.secrets WHERE name = 'anthropic_api_key';
  IF _secret IS NULL THEN
    PERFORM vault.create_secret(_clean, 'anthropic_api_key', 'Chave da API do Claude');
  ELSE
    PERFORM vault.update_secret(_secret, _clean);
  END IF;
  UPDATE public.ai_settings SET key_last4 = right(_clean, 4), key_updated_at = now(), key_updated_by = auth.uid() WHERE true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_ai_key(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ai_key(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_ai_key() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro configura a IA.';
  END IF;
  DELETE FROM vault.secrets WHERE name = 'anthropic_api_key';
  UPDATE public.ai_settings SET key_last4 = NULL, key_updated_at = now(), key_updated_by = auth.uid() WHERE true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.clear_ai_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_ai_key() TO authenticated;

-- Só a função de análise, com a service role, recebe a chave.
CREATE OR REPLACE FUNCTION public.ai_runtime_config()
RETURNS TABLE (api_key TEXT, model TEXT, enabled BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anthropic_api_key'), s.model, s.enabled
  FROM public.ai_settings s
$$;
REVOKE EXECUTE ON FUNCTION public.ai_runtime_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_runtime_config() TO service_role;
