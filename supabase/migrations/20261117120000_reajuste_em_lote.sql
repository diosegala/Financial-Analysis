-- Reajuste em lote da folha: o financeiro informa o percentual e o mês; encargos, 13º e férias saem do valor do mês,
-- então recalculam sozinhos. A folha reajustada entra na base do limite, porque o dissídio é obrigatório.
-- Com _apply = false só mostra o que aconteceria. Fica de fora quem já mudou de valor no mês de início (já reajustado,
-- o que também impede aplicar duas vezes) e quem está em unidade enviada ou aprovada.
CREATE OR REPLACE FUNCTION public.payroll_bulk_adjust(
  _version_id UUID, _from_month INT, _pct NUMERIC, _apply BOOLEAN DEFAULT false
) RETURNS TABLE (
  unit_name TEXT, person_name TEXT, situation TEXT, amount_before NUMERIC, amount_after NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro reajusta a folha em lote.';
  END IF;
  IF _from_month NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'Mês inválido.'; END IF;
  IF _pct IS NULL OR _pct <= 0 THEN RAISE EXCEPTION 'Informe um percentual maior que zero.'; END IF;
  IF _apply AND EXISTS (
    SELECT 1 FROM public.guardrail_settings gs JOIN public.scenarios s ON s.id = gs.scenario_id
    WHERE s.version_id = _version_id AND gs.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'O plano está publicado para os diretores. Reabra antes de reajustar em lote.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _bulk (line_id UUID, unit_id UUID, unit_name TEXT, person_name TEXT, situation TEXT,
    amount_before NUMERIC, amount_after NUMERIC) ON COMMIT DROP;
  TRUNCATE _bulk;
  INSERT INTO _bulk
  SELECT l.id, l.unit_id, u.name, p.name,
    CASE
      WHEN f.amount IS NULL THEN 'sem_valor'
      WHEN EXISTS (SELECT 1 FROM public.unit_submissions us WHERE us.version_id = _version_id AND us.unit_id = l.unit_id
                   AND us.status IN ('enviado', 'aprovado')) THEN 'unidade_enviada'
      WHEN COALESCE(cur.amount, 0) > 0 AND COALESCE(prev.amount, 0) > 0 AND cur.amount <> prev.amount THEN 'ja_reajustado'
      ELSE 'reajusta'
    END,
    f.amount, round(f.amount * (1 + _pct), 2)
  FROM public.plan_lines l
  JOIN public.people p ON p.id = l.person_id
  JOIN public.units u ON u.id = l.unit_id
  LEFT JOIN public.plan_values cur ON cur.line_id = l.id AND cur.month = _from_month
  LEFT JOIN public.plan_values prev ON prev.line_id = l.id AND prev.month = _from_month - 1
  LEFT JOIN LATERAL (
    SELECT v.amount FROM public.plan_values v WHERE v.line_id = l.id AND v.month >= _from_month AND v.amount > 0
    ORDER BY v.month LIMIT 1
  ) f ON true
  WHERE l.version_id = _version_id AND l.person_id IS NOT NULL;

  IF _apply THEN
    CREATE TEMP TABLE IF NOT EXISTS _bulk_folha (scenario_id UUID, unit_id UUID, amount NUMERIC) ON COMMIT DROP;
    TRUNCATE _bulk_folha;
    INSERT INTO _bulk_folha
    SELECT s.id, x.unit_id, SUM(x.amount) FROM public.scenarios s
    CROSS JOIN LATERAL public.plan_split(_version_id, s.id) x
    WHERE s.version_id = _version_id AND x.bucket = 'folha' GROUP BY 1, 2;

    UPDATE public.plan_values v SET amount = round(v.amount * (1 + _pct), 2)
    FROM _bulk b
    WHERE b.situation = 'reajusta' AND v.line_id = b.line_id AND v.month >= _from_month AND v.amount > 0;

    -- Só o efeito do reajuste entra na base: o que o diretor mudou continua fora dela.
    UPDATE public.guardrail_units g SET base_payroll = g.base_payroll + d.diff
    FROM (
      SELECT s.id AS scenario_id, x.unit_id, SUM(x.amount) - COALESCE(MAX(a.amount), 0) AS diff
      FROM public.scenarios s
      CROSS JOIN LATERAL public.plan_split(_version_id, s.id) x
      LEFT JOIN _bulk_folha a ON a.scenario_id = s.id AND a.unit_id = x.unit_id
      WHERE s.version_id = _version_id AND x.bucket = 'folha' GROUP BY 1, 2
    ) d
    WHERE g.scenario_id = d.scenario_id AND g.unit_id = d.unit_id AND g.base_payroll IS NOT NULL;
  END IF;

  RETURN QUERY SELECT b.unit_name, b.person_name, b.situation, b.amount_before, b.amount_after
  FROM _bulk b ORDER BY b.unit_name, b.person_name;
END $$;

REVOKE ALL ON FUNCTION public.payroll_bulk_adjust(UUID, INT, NUMERIC, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payroll_bulk_adjust(UUID, INT, NUMERIC, BOOLEAN) TO authenticated;
