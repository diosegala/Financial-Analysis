-- App pronto para usar: contas carregadas das categorias do Omie e base de despesas de 2027 a partir do realizado de 2026.

-- No Omie a mesma palavra é categoria de receita e de despesa (Imobi Report, Insider Aluguel, Funil de Vendas…).
-- A conta passa a ser única por nome e tipo, para que as duas existam com o nome do Omie.
ALTER TABLE public.accounts DROP CONSTRAINT accounts_name_key;
CREATE UNIQUE INDEX accounts_name_kind ON public.accounts (name, kind);

-- Ajustes do app que não cabem em outra tabela (chave → valor), editáveis em Configurações.
CREATE TABLE public.app_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT,
  label TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read app_settings" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Financeiro writes app_settings" ON public.app_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE TRIGGER upd_app_settings BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Despesa do Omie sem unidade (nem departamento, nem rateio, nem palavra) entra nesta unidade ao gerar a base.
-- Decisão de 24/10: a ADM, área de apoio; a meta cobre os custos de apoio, então nada some do cálculo.
INSERT INTO public.app_settings (key, value, label)
SELECT 'shared_cost_unit_id', id::TEXT, 'Unidade das despesas do Omie sem unidade' FROM public.units WHERE name = 'ADM';

-- Atribuição do realizado às unidades, sem filtro de perfil, para uso interno (geração da base). O resumo da página
-- Realizado Omie continua em omie_expense_summary, que aplica o perfil por cima desta.
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
    SELECT name, month, paid, open, dept_unit AS unit_id, 'departamento' AS source FROM base WHERE dept_unit IS NOT NULL
    UNION ALL
    SELECT b.name, b.month, b.paid * a.share, b.open * a.share, a.unit_id, 'rateio'
    FROM base b JOIN alloc a ON a.name = b.name WHERE b.dept_unit IS NULL
    UNION ALL
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

CREATE OR REPLACE FUNCTION public.omie_expense_summary(_year INT)
RETURNS TABLE (category_name TEXT, unit_id UUID, source TEXT, paid NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.omie_expense_attribution(_year) g
  WHERE public.has_role(auth.uid(), 'financeiro')
     OR (g.unit_id IS NOT NULL AND public.has_unit(auth.uid(), g.unit_id))
$$;

-- Nome da categoria sem o período no fim ("CUPOLA Summit - 2026" → "CUPOLA Summit"), como splitPeriod no app.
CREATE OR REPLACE FUNCTION public.category_base_name(_name TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(regexp_replace(_name, '(\s*[-–—]\s*|\s+)20\d{2}(\s*/\s*(\d{4}|\d{2}))?\s*$', ''))
$$;

-- A categoria vale para o ano? Sem período no nome, sempre; com período ("- 2026", "- 2026/2027"), só se o incluir.
-- Na base de 2027, "CUPOLA Summit - 2026" entra (a edição do ano) e "- 2027" (pago antes, da próxima edição) ou
-- "- 2025" (sobra da anterior) não, para não contar a mesma edição duas vezes.
CREATE OR REPLACE FUNCTION public.category_in_year(_name TEXT, _year INT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN m IS NULL THEN true
              ELSE _year BETWEEN m[1]::INT AND COALESCE(CASE WHEN length(m[3]) = 2 THEN 2000 + m[3]::INT ELSE m[3]::INT END, m[1]::INT) END
  FROM (SELECT regexp_match(_name, '(20\d{2})(\s*/\s*(\d{4}|\d{2}))?\s*$') AS m) x
$$;

-- Conta de despesa do app para uma categoria do Omie no ano planejado: a do mesmo nome-base cujo período inclui o ano
-- ("… - 2026" vai para "… - 2027"); senão a de nome igual; senão a de mesmo nome-base. Só contas ativas, sem receita.
CREATE OR REPLACE FUNCTION public.account_for_category(_name TEXT, _plan_year INT)
RETURNS public.accounts LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT a.* FROM public.accounts a
  WHERE a.active AND a.kind <> 'receita'
    AND (public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = public.norm_text(public.category_base_name(_name))
         OR public.norm_text(a.name) = public.norm_text(_name))
  ORDER BY
    (public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = public.norm_text(public.category_base_name(_name))
     AND _plan_year::TEXT = ANY (string_to_array(replace(COALESCE(a.period, ''), ' ', ''), '/'))) DESC,
    (public.norm_text(a.name) = public.norm_text(_name)) DESC,
    a.name
  LIMIT 1
$$;

-- Base de despesas do ano a partir do realizado do ano anterior: uma linha "Base AAAA (Omie)" por conta e unidade, com os
-- meses do realizado × (1 + reajuste). Despesa sem unidade vai para a unidade de app_settings (ADM); custo de folha sem
-- unidade (benefícios, rescisões) é dividido pelas pessoas de cada unidade. Só contas lançáveis:
-- folha, encargos, impostos e comissões são calculados pelo app. Gerar de novo troca só as linhas geradas da versão.
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
      SELECT s.unit_id, s.account_id, s.unit_ids, s.paid, s.open, 1::NUMERIC AS share FROM src s WHERE s.unit_id IS NOT NULL
      UNION ALL
      SELECT h.unit_id, s.account_id, s.unit_ids, s.paid, s.open, h.share
      FROM src s JOIN heads h ON true WHERE s.unit_id IS NULL AND s.account_kind = 'folha'
      UNION ALL
      SELECT _shared, s.account_id, s.unit_ids, s.paid, s.open, 1
      FROM src s WHERE s.unit_id IS NULL
        AND (s.account_kind <> 'folha' OR NOT EXISTS (SELECT 1 FROM heads))
    ), att AS (
      SELECT pl.unit_id, pl.account_id, k AS month, (pl.paid[k] + pl.open[k]) * pl.share AS amount
      FROM placed pl CROSS JOIN generate_series(1, 12) k
      WHERE pl.unit_id IS NOT NULL AND (pl.unit_ids IS NULL OR pl.unit_id = ANY (pl.unit_ids))
    ), per_month AS (
      SELECT unit_id, account_id, month, SUM(amount) AS amount FROM att GROUP BY unit_id, account_id, month
    )
    SELECT unit_id, account_id,
      ARRAY(SELECT round(CASE WHEN _mode = 'media' THEN (SELECT SUM(p2.amount) FROM per_month p2
                                                         WHERE p2.unit_id = p.unit_id AND p2.account_id = p.account_id) / 12
                              ELSE (SELECT p2.amount FROM per_month p2 WHERE p2.unit_id = p.unit_id
                                    AND p2.account_id = p.account_id AND p2.month = k) END * (1 + _pct), 2)
            FROM generate_series(1, 12) k) AS months
    FROM (SELECT DISTINCT unit_id, account_id FROM per_month) p
  LOOP
    CONTINUE WHEN (SELECT SUM(v) FROM unnest(r.months) v) = 0;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, origin, created_by)
    VALUES (_version_id, r.unit_id, r.account_id, 'Base ' || (_year - 1) || ' (Omie)', 'gerada', auth.uid())
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

-- Reajuste geral da base: multiplica os meses das linhas geradas, mantendo as edições feitas uma a uma.
CREATE OR REPLACE FUNCTION public.adjust_generated_lines(_version_id UUID, _pct NUMERIC)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _n INT;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro reajusta a base de despesas.';
  END IF;
  IF _pct <= -1 THEN RAISE EXCEPTION 'Reajuste inválido.'; END IF;
  UPDATE public.plan_values v SET amount = round(v.amount * (1 + _pct), 2)
  FROM public.plan_lines l
  WHERE l.id = v.line_id AND l.version_id = _version_id AND l.origin = 'gerada';
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.adjust_generated_lines(UUID, NUMERIC) FROM anon;
