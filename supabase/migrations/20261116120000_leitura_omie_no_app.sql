-- Leitura do Omie pelo app: botão do financeiro e agendamento semanal, pela Edge Function omie-sync.
-- Categorias novas no Omie viram contas sozinhas. As que já existiam hoje e não viraram conta ficam de fora: foram
-- deixadas de fora de propósito na carga inicial.
CREATE TABLE public.omie_sync_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando', 'concluida', 'com_erro')),
  automatic BOOLEAN NOT NULL DEFAULT false,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  companies_done TEXT[] NOT NULL DEFAULT '{}',
  errors TEXT[] NOT NULL DEFAULT '{}',
  new_accounts TEXT[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX omie_sync_runs_one_running ON public.omie_sync_runs ((true)) WHERE status = 'rodando';
GRANT SELECT ON public.omie_sync_runs TO authenticated;
GRANT ALL ON public.omie_sync_runs TO service_role;
ALTER TABLE public.omie_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Financeiro reads omie_sync_runs" ON public.omie_sync_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro'));

-- O que já foi lido de uma empresa, entre as partes da leitura. Some ao gravar a empresa. Ninguém logado acessa.
CREATE TABLE public.omie_sync_cache (
  run_id UUID NOT NULL REFERENCES public.omie_sync_runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  page INT NOT NULL,
  rows JSONB NOT NULL,
  PRIMARY KEY (run_id, step, page)
);
GRANT ALL ON public.omie_sync_cache TO service_role;
ALTER TABLE public.omie_sync_cache ENABLE ROW LEVEL SECURITY;

-- Nome-base das categorias já vistas: o que não está aqui é novo.
CREATE TABLE public.omie_known_categories (
  name_key TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.omie_known_categories TO authenticated;
GRANT ALL ON public.omie_known_categories TO service_role;
ALTER TABLE public.omie_known_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Financeiro reads omie_known_categories" ON public.omie_known_categories FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro'));
INSERT INTO public.omie_known_categories (name_key)
SELECT DISTINCT public.norm_text(public.category_base_name(name)) FROM public.omie_categories
ON CONFLICT DO NOTHING;

-- Começa uma leitura. Uma de cada vez; a que passou de 30 minutos foi interrompida.
CREATE FUNCTION public.omie_sync_start(_by UUID) RETURNS UUID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _id UUID;
BEGIN
  UPDATE public.omie_sync_runs SET status = 'com_erro', finished_at = now(),
    errors = errors || 'A leitura foi interrompida.'::TEXT
  WHERE status = 'rodando' AND started_at < now() - interval '30 minutes';
  DELETE FROM public.omie_sync_cache c USING public.omie_sync_runs r WHERE r.id = c.run_id AND r.status <> 'rodando';
  IF EXISTS (SELECT 1 FROM public.omie_sync_runs WHERE status = 'rodando') THEN
    RAISE EXCEPTION 'Já há uma leitura do Omie em andamento.';
  END IF;
  INSERT INTO public.omie_sync_runs (automatic, started_by) VALUES (_by IS NULL, _by) RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE FUNCTION public.omie_sync_progress(_run_id UUID, _company TEXT, _error TEXT) RETURNS VOID
LANGUAGE sql SET search_path TO 'public' AS $$
  UPDATE public.omie_sync_runs SET
    companies_done = CASE WHEN _error IS NULL THEN companies_done || _company ELSE companies_done END,
    errors = CASE WHEN _error IS NULL THEN errors ELSE errors || (_company || ': ' || _error) END
  WHERE id = _run_id;
$$;

-- Troca o que existe da empresa nos anos lidos, numa transação. Mesma gravação de scripts/omie-sync.py.
CREATE FUNCTION public.omie_store_company(_name TEXT, _years INT[], _departments JSONB, _categories JSONB,
  _suppliers JSONB, _actuals JSONB, _receipts JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _cid UUID;
BEGIN
  INSERT INTO public.omie_companies (name, last_synced_at) VALUES (_name, now())
  ON CONFLICT (name) DO UPDATE SET last_synced_at = now() RETURNING id INTO _cid;

  DELETE FROM public.omie_departments WHERE company_id = _cid;
  INSERT INTO public.omie_departments (company_id, code, name, structure)
  SELECT _cid, x.code, x.name, x.structure FROM jsonb_to_recordset(_departments) AS x(code TEXT, name TEXT, structure TEXT);

  DELETE FROM public.omie_categories WHERE company_id = _cid;
  INSERT INTO public.omie_categories (company_id, code, name, parent_code, is_expense, is_revenue, is_total)
  SELECT _cid, x.code, x.name, x.parent_code, x.is_expense, x.is_revenue, x.is_total
  FROM jsonb_to_recordset(_categories) AS x(code TEXT, name TEXT, parent_code TEXT, is_expense BOOLEAN, is_revenue BOOLEAN, is_total BOOLEAN);

  -- Clientes e fornecedores acumulam: ler um ano só não apaga o nome dos que aparecem em outros anos.
  INSERT INTO public.omie_suppliers (company_id, code, name)
  SELECT _cid, x.code, x.name FROM jsonb_to_recordset(_suppliers) AS x(code TEXT, name TEXT)
  ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name;

  DELETE FROM public.omie_actuals WHERE company_id = _cid AND year = ANY (_years);
  INSERT INTO public.omie_actuals (company_id, year, month, category_code, department_code, supplier_code, item, amount_paid, amount_open)
  SELECT _cid, x.year, x.month, x.category_code, x.department_code, x.supplier_code, x.item, x.amount_paid, x.amount_open
  FROM jsonb_to_recordset(_actuals) AS x(year INT, month INT, category_code TEXT, department_code TEXT, supplier_code TEXT,
    item TEXT, amount_paid NUMERIC, amount_open NUMERIC);

  DELETE FROM public.omie_receipts WHERE company_id = _cid AND year = ANY (_years);
  INSERT INTO public.omie_receipts (company_id, year, month, category_code, department_code, client_code, amount_received, amount_open)
  SELECT _cid, x.year, x.month, x.category_code, x.department_code, x.client_code, x.amount_received, x.amount_open
  FROM jsonb_to_recordset(_receipts) AS x(year INT, month INT, category_code TEXT, department_code TEXT, client_code TEXT,
    amount_received NUMERIC, amount_open NUMERIC);
END $$;

-- Categorias novas viram contas lançáveis para todas as unidades, na linha da DRE mais usada pelo tipo. Ficam de fora
-- os grupos, as de período anterior e as que as regras de tratamento dizem que o app calcula ou que ficam fora da DRE.
-- Tudo pode ser ajustado depois em Plano de contas.
CREATE FUNCTION public.omie_create_new_accounts() RETURNS TEXT[]
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _names TEXT[];
BEGIN
  WITH cats AS (
    SELECT DISTINCT ON (public.norm_text(public.category_base_name(c.name)))
      public.norm_text(public.category_base_name(c.name)) AS name_key, c.name, c.code, c.is_revenue
    FROM public.omie_categories c
    WHERE NOT c.is_total AND (c.is_expense OR c.is_revenue)
    ORDER BY public.norm_text(public.category_base_name(c.name)), c.name DESC
  ), fresh AS (
    SELECT cats.*, CASE WHEN cats.is_revenue THEN 'receita' ELSE 'despesa' END AS kind,
      (regexp_match(cats.name, '(20\d{2})(\s*/\s*(\d{4}|\d{2}))?\s*$'))[1]::INT AS start_year
    FROM cats
    WHERE NOT EXISTS (SELECT 1 FROM public.omie_known_categories k WHERE k.name_key = cats.name_key)
  ), chosen AS (
    SELECT f.* FROM fresh f
    WHERE COALESCE(f.start_year, 9999) >= EXTRACT(YEAR FROM now())::INT
      AND NOT EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = f.name_key)
      AND NOT EXISTS (
        SELECT 1 FROM public.account_treatment_rules r
        WHERE public.norm_text(f.name) ~ ('(^|[^a-z0-9])' ||
          regexp_replace(public.norm_text(r.keyword), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '($|[^a-z0-9])'))
  ), created AS (
    INSERT INTO public.accounts (name, kind, dre_line_id, omie_category_code, base_name, treatment)
    SELECT ch.name, ch.kind,
      (SELECT a.dre_line_id FROM public.accounts a
       WHERE a.kind = ch.kind AND a.active AND a.treatment = 'lancavel' AND a.dre_line_id IS NOT NULL
       GROUP BY a.dre_line_id ORDER BY count(*) DESC LIMIT 1),
      ch.code, public.category_base_name(ch.name), 'lancavel'
    FROM chosen ch
    RETURNING name
  ), seen AS (
    INSERT INTO public.omie_known_categories (name_key)
    SELECT name_key FROM cats ON CONFLICT DO NOTHING
  )
  SELECT COALESCE(array_agg(name ORDER BY name), '{}') INTO _names FROM created;
  RETURN _names;
END $$;

CREATE FUNCTION public.omie_sync_finish(_run_id UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _new TEXT[];
BEGIN
  _new := public.omie_create_new_accounts();
  UPDATE public.omie_sync_runs SET finished_at = now(), new_accounts = _new,
    status = CASE WHEN cardinality(errors) = 0 THEN 'concluida' ELSE 'com_erro' END
  WHERE id = _run_id;
END $$;

REVOKE ALL ON FUNCTION public.omie_sync_start(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_sync_progress(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_store_company(TEXT, INT[], JSONB, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_create_new_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_sync_finish(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omie_sync_start(UUID), public.omie_sync_progress(UUID, TEXT, TEXT),
  public.omie_store_company(TEXT, INT[], JSONB, JSONB, JSONB, JSONB, JSONB), public.omie_create_new_accounts(),
  public.omie_sync_finish(UUID) TO service_role;

-- ───────────── Agendamento: toda segunda, às 6h de Brasília ─────────────
-- O endereço e o token ficam no Vault (omie_sync_url, omie_sync_token), fora do repositório. Sem eles, não faz nada.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE FUNCTION public.omie_sync_fire() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _url TEXT; _token TEXT;
BEGIN
  SELECT decrypted_secret INTO _url FROM vault.decrypted_secrets WHERE name = 'omie_sync_url';
  SELECT decrypted_secret INTO _token FROM vault.decrypted_secrets WHERE name = 'omie_sync_token';
  IF _url IS NULL OR _token IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(url := _url, body := '{}'::JSONB,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-omie-sync-token', _token));
END $$;
REVOKE ALL ON FUNCTION public.omie_sync_fire() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('omie-sync-semanal', '0 9 * * 1', 'SELECT public.omie_sync_fire()');
