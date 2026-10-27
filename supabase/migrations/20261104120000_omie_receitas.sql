-- Receita realizada do Omie (somente leitura do Omie): recebido e em aberto por mês, categoria, departamento e cliente.
-- Base da carteira de 2027 pré-carregada, do run-rate e dos alertas de receita. O nome dos clientes fica em
-- omie_suppliers, que passa a ser o cadastro de clientes e fornecedores do Omie (é um cadastro só lá).

CREATE TABLE public.omie_receipts (
  company_id UUID NOT NULL REFERENCES public.omie_companies(id) ON DELETE CASCADE,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_code TEXT NOT NULL,
  department_code TEXT NOT NULL DEFAULT '',
  client_code TEXT NOT NULL DEFAULT '',
  amount_received NUMERIC NOT NULL DEFAULT 0,
  amount_open NUMERIC NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year, month, category_code, department_code, client_code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.omie_receipts TO authenticated;
GRANT ALL ON public.omie_receipts TO service_role;
ALTER TABLE public.omie_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Financeiro reads omie_receipts" ON public.omie_receipts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Financeiro writes omie_receipts" ON public.omie_receipts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- Conta de receita do app para uma categoria de receita do Omie (mesma regra da despesa: nome-base e período).
CREATE FUNCTION public.revenue_account_for_category(_name TEXT, _plan_year INT)
RETURNS public.accounts LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT a.* FROM public.accounts a
  WHERE a.active AND a.kind = 'receita'
    AND (public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = public.norm_text(public.category_base_name(_name))
         OR public.norm_text(a.name) = public.norm_text(_name))
  ORDER BY
    (public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = public.norm_text(public.category_base_name(_name))
     AND _plan_year::TEXT = ANY (string_to_array(replace(COALESCE(a.period, ''), ' ', ''), '/'))) DESC,
    (public.norm_text(a.name) = public.norm_text(_name)) DESC,
    a.name
  LIMIT 1
$$;

-- Receita realizada de um ano por categoria, cliente e unidade, mês a mês. A unidade segue a mesma regra das despesas:
-- 1) rateio ou unidade única da categoria (escolha do financeiro); 2) departamento do título; 3) palavra no nome da
-- categoria. Só receitas que entram na DRE (transferências, dividendos, empréstimos ficam fora).
CREATE FUNCTION public.omie_revenue_attribution(_year INT)
RETURNS TABLE (category_name TEXT, client_code TEXT, client_name TEXT, unit_id UUID, source TEXT,
  received NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT c.name, r.month, r.amount_received AS got, r.amount_open AS open, du.unit_id AS dept_unit,
      r.client_code, COALESCE(s.name, '') AS client_name
    FROM public.omie_receipts r
    JOIN public.omie_categories c ON c.company_id = r.company_id AND c.code = r.category_code AND c.is_revenue
    LEFT JOIN public.omie_department_unit du ON du.company_id = r.company_id AND du.department_code = r.department_code
    LEFT JOIN public.omie_suppliers s ON s.company_id = r.company_id AND s.code = r.client_code
    WHERE r.year = _year
      -- Com conta no app, vale o tratamento dela; sem conta, só as receitas operacionais (grupo 1.01 do Omie).
      AND COALESCE((public.revenue_account_for_category(c.name, _year)).treatment,
                   CASE WHEN r.category_code LIKE '1.01.%' THEN 'lancavel' ELSE 'fora_dre' END) <> 'fora_dre'
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
    SELECT b.name, b.client_code, b.client_name, b.month, b.got * a.share AS got, b.open * a.share AS open, a.unit_id, 'rateio' AS source
    FROM base b JOIN alloc a ON a.name = b.name
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, b.dept_unit, 'departamento'
    FROM base b WHERE b.dept_unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name)
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, k.unit_id, 'palavra'
    FROM base b JOIN kw k ON k.name = b.name WHERE b.dept_unit IS NULL
    UNION ALL
    SELECT b.name, b.client_code, b.client_name, b.month, b.got, b.open, NULL::UUID, 'sem'
    FROM base b WHERE b.dept_unit IS NULL
      AND NOT EXISTS (SELECT 1 FROM alloc a WHERE a.name = b.name) AND NOT EXISTS (SELECT 1 FROM kw k WHERE k.name = b.name)
  ), m AS (
    SELECT name, client_code, client_name, unit_id, source, month, SUM(got) AS got, SUM(open) AS open
    FROM resolved GROUP BY 1, 2, 3, 4, 5, 6
  ), g AS (
    SELECT name, client_code, client_name, unit_id, source,
      array_agg(got ORDER BY month) AS gots, array_agg(month ORDER BY month) AS months,
      array_agg(open ORDER BY month) AS opens
    FROM m GROUP BY 1, 2, 3, 4, 5
  )
  SELECT g.name, g.client_code, g.client_name, g.unit_id, g.source,
    ARRAY(SELECT COALESCE(g.gots[array_position(g.months, k)], 0) FROM generate_series(1, 12) k),
    ARRAY(SELECT COALESCE(g.opens[array_position(g.months, k)], 0) FROM generate_series(1, 12) k)
  FROM g
$$;
REVOKE EXECUTE ON FUNCTION public.omie_revenue_attribution(INT) FROM anon, authenticated;

-- O que a tela lê: o financeiro vê tudo; o líder, as receitas das próprias unidades.
CREATE FUNCTION public.omie_revenue_summary(_year INT)
RETURNS TABLE (category_name TEXT, client_code TEXT, client_name TEXT, unit_id UUID, source TEXT,
  received NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.omie_revenue_attribution(_year) g
  WHERE public.has_role(auth.uid(), 'financeiro')
     OR (g.unit_id IS NOT NULL AND public.has_unit(auth.uid(), g.unit_id))
$$;
REVOKE EXECUTE ON FUNCTION public.omie_revenue_summary(INT) FROM anon;

-- Carteira sugerida para o plano, por cliente e categoria da unidade:
-- - já contratado: títulos a receber com vencimento no ano da versão (ex.: parcelas de cursos vendidos, contratos);
-- - recorrente: recebimento em pelo menos N dos 4 últimos meses do ano anterior (padrão 3), com a média mensal dos 3
--   últimos meses (recebido + em aberto).
-- O líder escolhe o que entra; nada é gravado aqui. N é editável em app_settings.
INSERT INTO public.app_settings (key, value, label) VALUES
  ('portfolio_min_months', '3', 'Carteira sugerida: meses com recebimento (dos 4 últimos) para o cliente contar como recorrente')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION public.revenue_portfolio(_version_id UUID, _unit_id UUID)
RETURNS TABLE (client_code TEXT, client_name TEXT, category_name TEXT, account_id UUID, months_active INT,
  monthly NUMERIC, last_month INT, year_total NUMERIC, contracted NUMERIC[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _year INT;
  _last INT;
  _min INT;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'financeiro') OR public.has_unit(auth.uid(), _unit_id)) THEN
    RAISE EXCEPTION 'Você não vê a carteira desta unidade.';
  END IF;
  SELECT year - 1 INTO _year FROM public.budget_versions WHERE id = _version_id;
  SELECT NULLIF(value, '')::INT INTO _min FROM public.app_settings WHERE key = 'portfolio_min_months';
  _min := COALESCE(_min, 3);
  -- Último mês com recebimento no ano anterior (o mês corrente, enquanto o ano não fecha).
  SELECT max(month) INTO _last FROM public.omie_receipts WHERE year = _year AND amount_received <> 0;
  _last := COALESCE(_last, 12);
  RETURN QUERY
  WITH per AS (
    SELECT x.client_code, max(x.client_name) AS cname, x.category_name, k AS month,
      SUM(x.received[k] + x.open[k]) AS amt
    FROM public.omie_revenue_attribution(_year) x CROSS JOIN generate_series(1, 12) k
    WHERE x.unit_id = _unit_id AND x.client_code <> ''
    GROUP BY x.client_code, x.category_name, k
  ), agg AS (
    SELECT p.client_code, max(p.cname) AS cname, p.category_name,
      (count(*) FILTER (WHERE p.month BETWEEN _last - 3 AND _last AND p.amt > 0))::INT AS active,
      round(COALESCE(SUM(p.amt) FILTER (WHERE p.month BETWEEN _last - 2 AND _last), 0) / 3, 2) AS monthly,
      max(p.month) FILTER (WHERE p.amt > 0) AS last_m,
      round(SUM(p.amt), 2) AS total
    FROM per p GROUP BY p.client_code, p.category_name
  ), nxt_m AS (
    SELECT y.client_code, max(y.client_name) AS cname, y.category_name, k AS month, SUM(y.open[k]) AS amt
    FROM public.omie_revenue_attribution(_year + 1) y CROSS JOIN generate_series(1, 12) k
    WHERE y.unit_id = _unit_id AND y.client_code <> ''
    GROUP BY y.client_code, y.category_name, k
  ), nxt AS (
    SELECT m.client_code, max(m.cname) AS cname, m.category_name, array_agg(round(m.amt, 2) ORDER BY m.month) AS c
    FROM nxt_m m GROUP BY m.client_code, m.category_name
  ), keys AS (
    SELECT a.client_code, a.category_name FROM agg a WHERE a.active >= _min AND a.monthly > 0
    UNION
    SELECT n.client_code, n.category_name FROM nxt n
    WHERE (SELECT SUM(v) FROM unnest(n.c) v) > 0
  )
  SELECT k.client_code, COALESCE(a.cname, n.cname), k.category_name,
    (public.revenue_account_for_category(k.category_name, _year + 1)).id,
    COALESCE(a.active, 0), COALESCE(a.monthly, 0), a.last_m, COALESCE(a.total, 0),
    COALESCE(n.c, ARRAY_FILL(0::NUMERIC, ARRAY[12]))
  FROM keys k
  LEFT JOIN agg a ON a.client_code = k.client_code AND a.category_name = k.category_name
  LEFT JOIN nxt n ON n.client_code = k.client_code AND n.category_name = k.category_name
  ORDER BY GREATEST(COALESCE(a.monthly, 0) * 12, (SELECT COALESCE(SUM(v), 0) FROM unnest(n.c) v)) DESC;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.revenue_portfolio(UUID, UUID) FROM anon;
