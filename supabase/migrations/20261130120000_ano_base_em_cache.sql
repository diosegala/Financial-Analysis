-- Ano base guardado: o cálculo do ano base a partir do Omie lia todos os lançamentos do ano a cada tela aberta (5 a 6 s,
-- com gravação em disco temporário), e gastava o orçamento de disco do banco. O resultado passa a ficar numa tabela,
-- refeita por um agendamento quando os dados do Omie, as contas ou as regras de atribuição mudam, e na virada do mês
-- (os meses fechados mudam). Enquanto a tabela está desatualizada, o cálculo é feito na hora, como antes: nada mostra
-- valor velho.

CREATE TABLE public.reference_omie_cache (
  year INT NOT NULL,
  unit_id UUID NOT NULL,
  account_id UUID NOT NULL,
  kind TEXT NOT NULL,
  month INT NOT NULL,
  amount NUMERIC NOT NULL
);
CREATE INDEX reference_omie_cache_year ON public.reference_omie_cache (year, unit_id);
ALTER TABLE public.reference_omie_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reference_omie_cache FROM anon, authenticated;
COMMENT ON TABLE public.reference_omie_cache IS 'Ano base do Omie já calculado (reference_rows_omie). Só as funções leem.';

CREATE TABLE public.reference_cache_state (
  year INT PRIMARY KEY,
  computed_at TIMESTAMPTZ,
  stale BOOLEAN NOT NULL DEFAULT true,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.reference_cache_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reference_cache_state FROM anon, authenticated;
COMMENT ON TABLE public.reference_cache_state IS
  'Situação do ano base guardado por ano: quando foi calculado e se algum dado de origem mudou depois.';

-- O cálculo de sempre, com outro nome.
ALTER FUNCTION public.reference_rows_omie(INT) RENAME TO reference_rows_omie_live;
REVOKE ALL ON FUNCTION public.reference_rows_omie_live(INT) FROM PUBLIC, anon, authenticated;

-- Vale o guardado quando está em dia e foi calculado neste mês; senão, calcula na hora.
CREATE FUNCTION public.reference_rows_omie(_year INT)
RETURNS TABLE (unit_id UUID, account_id UUID, kind TEXT, month INT, amount NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reference_cache_state s WHERE s.year = _year AND NOT s.stale
             AND date_trunc('month', s.computed_at) = date_trunc('month', now())) THEN
    RETURN QUERY SELECT c.unit_id, c.account_id, c.kind, c.month, c.amount
                 FROM public.reference_omie_cache c WHERE c.year = _year;
  ELSE
    RETURN QUERY SELECT * FROM public.reference_rows_omie_live(_year);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.reference_rows_omie(INT) FROM PUBLIC, anon, authenticated;

-- Refaz o ano base guardado de um ano.
CREATE FUNCTION public.reference_cache_refresh_year(_year INT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _started TIMESTAMPTZ := now();
BEGIN
  DELETE FROM public.reference_omie_cache WHERE year = _year;
  INSERT INTO public.reference_omie_cache (year, unit_id, account_id, kind, month, amount)
  SELECT _year, r.unit_id, r.account_id, r.kind, r.month, r.amount FROM public.reference_rows_omie_live(_year) r;
  INSERT INTO public.reference_cache_state (year, computed_at, stale, changed_at)
  VALUES (_year, _started, false, _started)
  ON CONFLICT (year) DO UPDATE SET computed_at = _started,
    -- Se algo mudou durante o cálculo, continua desatualizado.
    stale = public.reference_cache_state.changed_at > _started;
END $$;
REVOKE ALL ON FUNCTION public.reference_cache_refresh_year(INT) FROM PUBLIC, anon, authenticated;

-- Agendamento: refaz os anos base das versões do orçamento que mudaram (depois de 5 minutos sem mudança, para não
-- refazer no meio de uma leitura do Omie) ou que ainda são do mês anterior.
CREATE FUNCTION public.reference_cache_refresh() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE y INT;
BEGIN
  FOR y IN
    SELECT DISTINCT bv.year - 1 FROM public.budget_versions bv
    LEFT JOIN public.reference_cache_state s ON s.year = bv.year - 1
    WHERE s.year IS NULL
       OR (s.stale AND s.changed_at < now() - interval '5 minutes')
       OR date_trunc('month', s.computed_at) <> date_trunc('month', now())
  LOOP
    PERFORM public.reference_cache_refresh_year(y);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.reference_cache_refresh() FROM PUBLIC, anon, authenticated;

-- Qualquer mudança nos dados de origem marca o guardado como desatualizado (uma vez por comando, não por linha).
CREATE FUNCTION public.reference_cache_touch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.reference_cache_state SET stale = true, changed_at = now()
  WHERE NOT stale OR changed_at < now() - interval '1 minute';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.reference_cache_touch() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['omie_actuals', 'omie_receipts', 'omie_categories', 'omie_category_allocations',
    'omie_departments', 'omie_department_units', 'omie_keyword_units', 'omie_suppliers', 'accounts', 'app_settings', 'units'] LOOP
    EXECUTE format('CREATE TRIGGER reference_cache_touch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.reference_cache_touch()', t);
  END LOOP;
END $$;

SELECT cron.schedule('ano-base-cache', '*/10 * * * *', 'SELECT public.reference_cache_refresh()');
SELECT public.reference_cache_refresh();
