-- A leitura do Omie agora continua de onde parou: cada página lida marca a posição, e um vigia retoma a execução que
-- morreu sem avisar. Sem conseguir avançar depois de três tentativas, a leitura termina com erro e libera o botão.
ALTER TABLE public.omie_sync_runs
  ADD COLUMN progress_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN resume JSONB,
  ADD COLUMN stalls INT NOT NULL DEFAULT 0;

-- A leitura que ficou presa antes desta versão não tem posição para retomar.
UPDATE public.omie_sync_runs SET status = 'com_erro', finished_at = now(),
  errors = errors || 'A leitura foi interrompida.'::TEXT
WHERE status = 'rodando';

CREATE FUNCTION public.omie_sync_checkpoint(_run_id UUID, _index INT, _step INT, _page INT) RETURNS VOID
LANGUAGE sql SET search_path TO 'public' AS $$
  UPDATE public.omie_sync_runs SET progress_at = now(), stalls = 0,
    resume = jsonb_build_object('index', _index, 'step', _step, 'page', _page)
  WHERE id = _run_id;
$$;

-- Empresa terminada: a posição já passa para a próxima, para a retomada não gravar a mesma empresa duas vezes.
CREATE OR REPLACE FUNCTION public.omie_sync_progress(_run_id UUID, _company TEXT, _error TEXT) RETURNS VOID
LANGUAGE sql SET search_path TO 'public' AS $$
  UPDATE public.omie_sync_runs SET
    companies_done = CASE WHEN _error IS NULL THEN companies_done || _company ELSE companies_done END,
    errors = CASE WHEN _error IS NULL THEN errors ELSE errors || (_company || ': ' || _error) END,
    progress_at = now(), stalls = 0,
    resume = jsonb_build_object('index', COALESCE((resume->>'index')::INT, 0) + 1, 'step', 0, 'page', 1)
  WHERE id = _run_id;
$$;

CREATE OR REPLACE FUNCTION public.omie_sync_start(_by UUID) RETURNS UUID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _id UUID;
BEGIN
  UPDATE public.omie_sync_runs SET status = 'com_erro', finished_at = now(),
    errors = errors || 'A leitura foi interrompida.'::TEXT
  WHERE status = 'rodando' AND progress_at < now() - interval '30 minutes';
  DELETE FROM public.omie_sync_cache c USING public.omie_sync_runs r WHERE r.id = c.run_id AND r.status <> 'rodando';
  IF EXISTS (SELECT 1 FROM public.omie_sync_runs WHERE status = 'rodando') THEN
    RAISE EXCEPTION 'Já há uma leitura do Omie em andamento.';
  END IF;
  INSERT INTO public.omie_sync_runs (automatic, started_by) VALUES (_by IS NULL, _by) RETURNING id INTO _id;
  RETURN _id;
END $$;

-- Sete minutos sem avançar: nenhuma execução dura tanto, então a anterior morreu e é seguro retomar.
CREATE FUNCTION public.omie_sync_watchdog() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r public.omie_sync_runs%ROWTYPE;
  _url TEXT;
  _token TEXT;
BEGIN
  SELECT * INTO r FROM public.omie_sync_runs
  WHERE status = 'rodando' AND progress_at < now() - interval '7 minutes' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT decrypted_secret INTO _url FROM vault.decrypted_secrets WHERE name = 'omie_sync_url';
  SELECT decrypted_secret INTO _token FROM vault.decrypted_secrets WHERE name = 'omie_sync_token';
  IF r.stalls >= 3 OR _url IS NULL OR _token IS NULL THEN
    UPDATE public.omie_sync_runs SET status = 'com_erro', finished_at = now(),
      errors = errors || 'A leitura parou e não conseguiu continuar. As empresas já lidas foram gravadas.'::TEXT
    WHERE id = r.id;
    DELETE FROM public.omie_sync_cache WHERE run_id = r.id;
    RETURN;
  END IF;
  UPDATE public.omie_sync_runs SET stalls = stalls + 1, progress_at = now() WHERE id = r.id;
  PERFORM net.http_post(url := _url,
    body := jsonb_build_object('run_id', r.id) || COALESCE(r.resume, '{"index": 0, "step": 0, "page": 1}'::JSONB),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-omie-sync-token', _token));
END $$;

REVOKE ALL ON FUNCTION public.omie_sync_checkpoint(UUID, INT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_sync_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omie_sync_checkpoint(UUID, INT, INT, INT) TO service_role;

SELECT cron.schedule('omie-sync-vigia', '*/5 * * * *', 'SELECT public.omie_sync_watchdog()');
