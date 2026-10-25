-- Realizado pelo pagamento efetivo e unidade escolhida pelo financeiro.
-- 1) omie_actuals passa a ter "pago" pela data do pagamento efetivo (títulos e lançamentos direto no extrato) e
--    "em aberto" pelo vencimento (scripts/omie-sync.py), para fechar com a planilha do Fábio.
-- 2) A unidade que o financeiro escolhe para uma categoria (rateio, ou unidade única) vence o departamento do título:
--    é a correção manual de títulos lançados com o departamento errado no Omie.
COMMENT ON COLUMN public.omie_actuals.amount_paid IS 'Pago no mês, pela data do pagamento efetivo';
COMMENT ON COLUMN public.omie_actuals.amount_open IS 'A vencer ou atrasado, pelo mês do vencimento';

CREATE OR REPLACE FUNCTION public.omie_expense_attribution(_year INT)
RETURNS TABLE (category_name TEXT, unit_id UUID, source TEXT, paid NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT c.name, a.month, a.amount_paid AS paid, a.amount_open AS open, du.unit_id AS dept_unit
    FROM public.omie_actuals a
    JOIN public.omie_categories c ON c.company_id = a.company_id AND c.code = a.category_code AND c.is_expense
    LEFT JOIN public.omie_department_unit du ON du.company_id = a.company_id AND du.department_code = a.department_code
    WHERE a.year = _year
  ), names AS (SELECT DISTINCT name FROM base),
  alloc AS (
    SELECT n.name, al.unit_id, al.share / SUM(al.share) OVER (PARTITION BY n.name) AS share
    FROM names n JOIN public.omie_category_allocations al ON public.norm_text(al.category_name) = public.norm_text(n.name)
  ), kw AS (
    SELECT DISTINCT ON (n.name) n.name, k.unit_id
    FROM names n
    JOIN public.omie_keyword_units k ON public.norm_text(n.name) ~
      ('(^|[^a-z0-9])' || regexp_replace(public.norm_text(k.keyword), '([.*+?^${}()|\\[\\]\\\\])', '\\\\\\1', 'g') || 's?($|[^a-z0-9])')
    WHERE NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = n.name)
    ORDER BY n.name, k.priority DESC, length(k.keyword) DESC
  ), resolved AS (
    -- 1) a escolha do financeiro (rateio ou unidade única da categoria) vence tudo
    SELECT b.name, b.month, b.paid * a.share AS paid, b.open * a.share AS open, a.unit_id, 'rateio' AS source
    FROM base b JOIN alloc a ON a.name = b.name
    UNION ALL
    -- 2) o departamento do título
    SELECT b.name, b.month, b.paid, b.open, b.dept_unit, 'departamento'
    FROM base b WHERE b.dept_unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name)
    UNION ALL
    -- 3) a palavra no nome da categoria
    SELECT b.name, b.month, b.paid, b.open, k.unit_id, 'palavra'
    FROM base b JOIN kw k ON k.name = b.name WHERE b.dept_unit IS NULL
    UNION ALL
    SELECT b.name, b.month, b.paid, b.open, NULL::UUID, 'sem'
    FROM base b WHERE b.dept_unit IS NULL
      AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name) AND NOT EXISTS (SELECT 1 FROM kw k WHERE k.name = b.name)
  ), m AS (
    SELECT name, unit_id, source, month, SUM(paid) AS paid, SUM(open) AS open FROM resolved GROUP BY name, unit_id, source, month
  )
  SELECT g.name, g.unit_id, g.source,
    ARRAY(SELECT COALESCE((SELECT m2.paid FROM m m2 WHERE m2.name = g.name AND m2.unit_id IS NOT DISTINCT FROM g.unit_id
                           AND m2.source = g.source AND m2.month = k), 0) FROM generate_series(1, 12) k),
    ARRAY(SELECT COALESCE((SELECT m2.open FROM m m2 WHERE m2.name = g.name AND m2.unit_id IS NOT DISTINCT FROM g.unit_id
                           AND m2.source = g.source AND m2.month = k), 0) FROM generate_series(1, 12) k)
  FROM (SELECT DISTINCT name, unit_id, source FROM m) g
$$;
REVOKE EXECUTE ON FUNCTION public.omie_expense_attribution(INT) FROM anon, authenticated;
