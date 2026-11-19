-- Folha da unidade na tela: uma linha por pessoa, grupo e item, com os 12 meses juntos. Numa só chamada (a leitura em
-- páginas recalculava a folha inteira a cada página e passava de 15 s nas unidades grandes) e com o rateio de pessoas:
-- a unidade da pessoa fica com a parte dela, e a pessoa de outra unidade entra com a parte rateada para esta.
-- SECURITY DEFINER: o diretor da unidade que recebe a parte não lê as pessoas da outra unidade; a checagem é has_unit.
CREATE FUNCTION public.unit_payroll_detail(_version_id UUID, _scenario_id UUID, _unit_id UUID)
RETURNS TABLE (person_id UUID, home_unit_id UUID, share NUMERIC, grupo TEXT, item TEXT, months NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH ok AS (SELECT auth.uid() IS NULL OR public.has_unit(auth.uid(), _unit_id) AS ok),
  incoming AS (
    SELECT pa.person_id, p.unit_id AS home, pa.share
    FROM public.person_allocations pa JOIN public.people p ON p.id = pa.person_id
    WHERE pa.unit_id = _unit_id AND p.version_id = _version_id AND p.unit_id <> _unit_id
  ),
  home AS (SELECT * FROM public.person_home_shares(_version_id)),
  d AS (
    SELECT x.*, COALESCE(h.share, 1) AS share
    FROM public.payroll_detail(_version_id, _scenario_id, ARRAY[_unit_id]) x
    LEFT JOIN home h ON h.person_id = x.person_id
    UNION ALL
    SELECT x.*, i.share
    FROM public.payroll_detail(_version_id, _scenario_id,
      (SELECT COALESCE(array_agg(DISTINCT home), '{}') FROM incoming)) x
    JOIN incoming i ON i.person_id = x.person_id
  )
  SELECT d.person_id, d.unit_id, d.share, d.grupo, d.item,
    ARRAY(SELECT COALESCE(SUM(y.amount) FILTER (WHERE y.month = g), 0) * d.share FROM unnest(array_agg(d.month), array_agg(d.amount)) AS y(month, amount)
          CROSS JOIN generate_series(1, 12) g GROUP BY g ORDER BY g)
  FROM d CROSS JOIN ok WHERE ok.ok
  GROUP BY d.person_id, d.unit_id, d.share, d.grupo, d.item
$$;
REVOKE ALL ON FUNCTION public.unit_payroll_detail(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_payroll_detail(UUID, UUID, UUID) TO authenticated, service_role;
