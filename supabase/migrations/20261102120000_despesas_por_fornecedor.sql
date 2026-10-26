-- Despesas por fornecedor: o realizado do Omie guarda o fornecedor de cada despesa, e a base de 2027 vira uma linha por
-- fornecedor dentro da conta (ex.: os 9 SaaS de "SAAS - Agência"). A conta passa a ser a soma dos seus lançamentos.

CREATE TABLE public.omie_suppliers (
  company_id UUID NOT NULL REFERENCES public.omie_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (company_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.omie_suppliers TO authenticated;
GRANT ALL ON public.omie_suppliers TO service_role;
ALTER TABLE public.omie_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Financeiro reads omie_suppliers" ON public.omie_suppliers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Financeiro writes omie_suppliers" ON public.omie_suppliers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- O realizado ganha o fornecedor ('' = sem fornecedor) e o item: a observação do título, que nas compras no cartão
-- traz o nome da ferramenta (o fornecedor ali é o banco). A próxima leitura do Omie preenche.
ALTER TABLE public.omie_actuals ADD COLUMN supplier_code TEXT NOT NULL DEFAULT '';
ALTER TABLE public.omie_actuals ADD COLUMN item TEXT NOT NULL DEFAULT '';
ALTER TABLE public.omie_actuals DROP CONSTRAINT omie_actuals_pkey;
ALTER TABLE public.omie_actuals ADD PRIMARY KEY (company_id, year, month, category_code, department_code, supplier_code, item);

-- Fornecedores que são cartão de crédito: para eles, o nome do lançamento é o item (observação), não o banco.
-- Palavras separadas por vírgula, editáveis em Configurações → Avançado → Omie.
INSERT INTO public.app_settings (key, value, label)
VALUES ('card_supplier_keywords', 'Itau Unibanco', 'Fornecedores que são cartão de crédito (o nome vem da observação do título)')
ON CONFLICT (key) DO NOTHING;

-- A atribuição devolve também o fornecedor. As funções que a usam são recriadas abaixo.
DROP FUNCTION public.omie_expense_summary(INT);
DROP FUNCTION public.omie_expense_attribution(INT);
CREATE FUNCTION public.omie_expense_attribution(_year INT)
RETURNS TABLE (category_name TEXT, supplier_name TEXT, unit_id UUID, source TEXT, paid NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT c.name,
      CASE WHEN a.item <> '' AND EXISTS (
             SELECT 1 FROM unnest(string_to_array((SELECT value FROM public.app_settings WHERE key = 'card_supplier_keywords'), ',')) kw
             WHERE trim(kw) <> '' AND public.norm_text(COALESCE(s.name, '')) LIKE '%' || public.norm_text(trim(kw)) || '%')
           THEN a.item ELSE COALESCE(s.name, '') END AS supplier,
      a.month, a.amount_paid AS paid, a.amount_open AS open, du.unit_id AS dept_unit
    FROM public.omie_actuals a
    LEFT JOIN public.omie_suppliers s ON s.company_id = a.company_id AND s.code = a.supplier_code
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
    SELECT b.name, b.supplier, b.month, b.paid * a.share AS paid, b.open * a.share AS open, a.unit_id, 'rateio' AS source
    FROM base b JOIN alloc a ON a.name = b.name
    UNION ALL
    -- 2) o departamento do título
    SELECT b.name, b.supplier, b.month, b.paid, b.open, b.dept_unit, 'departamento'
    FROM base b WHERE b.dept_unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name)
    UNION ALL
    -- 3) a palavra no nome da categoria
    SELECT b.name, b.supplier, b.month, b.paid, b.open, k.unit_id, 'palavra'
    FROM base b JOIN kw k ON k.name = b.name WHERE b.dept_unit IS NULL
    UNION ALL
    SELECT b.name, b.supplier, b.month, b.paid, b.open, NULL::UUID, 'sem'
    FROM base b WHERE b.dept_unit IS NULL
      AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name) AND NOT EXISTS (SELECT 1 FROM kw k WHERE k.name = b.name)
  ), m AS (
    SELECT name, supplier, COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::UUID) AS ukey, unit_id, source, month,
      SUM(paid) AS paid, SUM(open) AS open
    FROM resolved GROUP BY name, supplier, unit_id, source, month
  ), g AS (SELECT DISTINCT name, supplier, ukey, unit_id, source FROM m)
  SELECT g.name, g.supplier, g.unit_id, g.source,
    array_agg(COALESCE(m.paid, 0) ORDER BY k), array_agg(COALESCE(m.open, 0) ORDER BY k)
  FROM g CROSS JOIN generate_series(1, 12) k
  LEFT JOIN m ON m.name = g.name AND m.supplier = g.supplier AND m.ukey = g.ukey AND m.source = g.source AND m.month = k
  GROUP BY g.name, g.supplier, g.unit_id, g.source
$$;
REVOKE EXECUTE ON FUNCTION public.omie_expense_attribution(INT) FROM anon, authenticated;

CREATE FUNCTION public.omie_expense_summary(_year INT)
RETURNS TABLE (category_name TEXT, supplier_name TEXT, unit_id UUID, source TEXT, paid NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.omie_expense_attribution(_year) g
  WHERE public.has_role(auth.uid(), 'financeiro')
     OR (g.unit_id IS NOT NULL AND public.has_unit(auth.uid(), g.unit_id))
$$;
REVOKE EXECUTE ON FUNCTION public.omie_expense_summary(INT) FROM anon;

-- Base de 2027: uma linha por conta, unidade e fornecedor (a descrição é o fornecedor; sem fornecedor, "Base AAAA (Omie)").
CREATE OR REPLACE FUNCTION public.generate_expense_base(_version_id UUID, _pct NUMERIC DEFAULT 0, _mode TEXT DEFAULT 'mes_a_mes')
RETURNS TABLE (lines INT, total NUMERIC) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _year INT;
  _shared UUID;
  r RECORD;
  _id UUID;
  _lines INT := 0;
  _total NUMERIC := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro gera a base de despesas.';
  END IF;
  IF _pct <= -1 OR _mode NOT IN ('mes_a_mes', 'media') THEN RAISE EXCEPTION 'Reajuste ou distribuição inválidos.'; END IF;
  SELECT year INTO _year FROM public.budget_versions WHERE id = _version_id;
  IF _year IS NULL THEN RAISE EXCEPTION 'Versão não encontrada.'; END IF;
  SELECT NULLIF(value, '')::UUID INTO _shared FROM public.app_settings WHERE key = 'shared_cost_unit_id';

  DELETE FROM public.plan_lines WHERE version_id = _version_id AND origin = 'gerada';

  FOR r IN
    WITH heads AS (
      -- Benefícios e outros custos de folha sem unidade seguem as pessoas: divididos pelo número de pessoas da unidade.
      SELECT p.unit_id, count(*)::NUMERIC / SUM(count(*)) OVER () AS share
      FROM public.people p WHERE p.version_id = _version_id GROUP BY p.unit_id
    ), src AS (
      SELECT x.*, acc.id AS account_id, acc.kind AS account_kind, acc.unit_ids
      FROM public.omie_expense_attribution(_year - 1) x
      CROSS JOIN LATERAL public.account_for_category(x.category_name, _year) acc
      WHERE acc.treatment = 'lancavel' AND public.category_in_year(x.category_name, _year - 1)
    ), placed AS (
      SELECT s.unit_id, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, 1::NUMERIC AS share FROM src s WHERE s.unit_id IS NOT NULL
      UNION ALL
      SELECT h.unit_id, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, h.share
      FROM src s JOIN heads h ON true WHERE s.unit_id IS NULL AND s.account_kind = 'folha'
      UNION ALL
      SELECT _shared, s.account_id, s.supplier_name, s.unit_ids, s.paid, s.open, 1
      FROM src s WHERE s.unit_id IS NULL
        AND (s.account_kind <> 'folha' OR NOT EXISTS (SELECT 1 FROM heads))
    ), att AS (
      SELECT pl.unit_id, pl.account_id, pl.supplier_name AS supplier, k AS month, (pl.paid[k] + pl.open[k]) * pl.share AS amount
      FROM placed pl CROSS JOIN generate_series(1, 12) k
      WHERE pl.unit_id IS NOT NULL AND (pl.unit_ids IS NULL OR pl.unit_id = ANY (pl.unit_ids))
    ), per_month AS (
      SELECT unit_id, account_id, supplier, month, SUM(amount) AS amount FROM att GROUP BY unit_id, account_id, supplier, month
    ), totals AS (
      SELECT unit_id, account_id, supplier, SUM(amount) AS total FROM per_month GROUP BY unit_id, account_id, supplier
    )
    SELECT t.unit_id, t.account_id, t.supplier,
      array_agg(round(CASE WHEN _mode = 'media' THEN t.total / 12 ELSE COALESCE(p.amount, 0) END * (1 + _pct), 2) ORDER BY k) AS months
    FROM totals t CROSS JOIN generate_series(1, 12) k
    LEFT JOIN per_month p ON p.unit_id = t.unit_id AND p.account_id = t.account_id AND p.supplier = t.supplier AND p.month = k
    GROUP BY t.unit_id, t.account_id, t.supplier
  LOOP
    CONTINUE WHEN (SELECT SUM(v) FROM unnest(r.months) v) = 0;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, origin, created_by)
    VALUES (_version_id, r.unit_id, r.account_id, COALESCE(NULLIF(r.supplier, ''), 'Base ' || (_year - 1) || ' (Omie)'), 'gerada', auth.uid())
    RETURNING id INTO _id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _id, k, r.months[k] FROM generate_series(1, 12) k WHERE r.months[k] <> 0;
    _lines := _lines + 1;
    _total := _total + (SELECT SUM(v) FROM unnest(r.months) v);
  END LOOP;
  RETURN QUERY SELECT _lines, _total;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.generate_expense_base(UUID, NUMERIC, TEXT) FROM anon;
