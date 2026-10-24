-- Atribuição do realizado do Omie às unidades do app. Quase nenhum título tem departamento no Omie, então a unidade
-- vem, nesta ordem, de: 1) departamento do título · 2) rateio da categoria (ex.: Marketing 40/30/30) · 3) palavra no
-- nome da categoria (SAAS - Agência → Agência; Summit → Educação) · 4) sem unidade, a ratear pelo financeiro.

-- Minúsculas e sem acento, para comparar nomes escritos de jeitos diferentes.
CREATE OR REPLACE FUNCTION public.norm_text(_s TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(translate(_s, 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn'))
$$;

-- Palavra (inteira ou frase) no nome da categoria → unidade. Vence a de maior prioridade; empatando, a mais longa.
CREATE TABLE public.omie_keyword_units (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword TEXT NOT NULL,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX omie_keyword_units_keyword ON public.omie_keyword_units (public.norm_text(keyword));

-- Rateio explícito de uma categoria entre unidades (as partes são normalizadas para somar 100%).
CREATE TABLE public.omie_category_allocations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  category_name TEXT NOT NULL,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  share NUMERIC NOT NULL CHECK (share > 0 AND share <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX omie_category_allocations_key ON public.omie_category_allocations (public.norm_text(category_name), unit_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['omie_keyword_units', 'omie_category_allocations']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Financeiro reads %1$s" ON public.%1$I FOR SELECT TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- Valores iniciais, todos editáveis em Configurações → Omie. Eventos e treinamentos são da Educação (decisão de
-- 28/10); prioridade 20 faz "Financeiro Essencial" (treinamento) vencer "Financeiro" (a unidade).
INSERT INTO public.omie_keyword_units (keyword, unit_id, priority)
SELECT k.keyword, u.id, k.priority FROM (VALUES
  ('Agência', 'Agência', 0), ('Consultoria', 'Consultoria', 0), ('Educação', 'Educação', 0), ('Growth', 'Growth', 0),
  ('Financeiro', 'Financeiro', 0), ('RH', 'RH', 0), ('Adm', 'ADM', 0), ('CRO', 'CRO', 0),
  ('Summit', 'Educação', 10), ('Imersão', 'Educação', 10), ('Insider', 'Educação', 10), ('Imobi Report', 'Educação', 10),
  ('Aluguel Day', 'Educação', 10), ('Aluguel Essencial', 'Educação', 10), ('Aluguel Master', 'Educação', 10),
  ('Conference', 'Educação', 10), ('Gestor de Vendas', 'Educação', 10), ('Gestão de Vendas', 'Educação', 10),
  ('Mentoria', 'Educação', 10), ('Workshop', 'Educação', 10), ('Virada de Lançamentos', 'Educação', 10),
  ('Vision', 'Educação', 10), ('Curso Online', 'Educação', 10), ('IA para Imobiliárias', 'Educação', 10),
  ('Financeiro Essencial', 'Educação', 20),
  ('Processos Administrativos e Financeiros da Locação', 'Educação', 20)
) AS k(keyword, unit_name, priority)
JOIN public.units u ON u.name = k.unit_name;

-- Resumo por categoria e unidade. source: departamento · rateio · palavra · sem (sem unidade, a ratear).
DROP FUNCTION public.omie_expense_summary(INT);
CREATE FUNCTION public.omie_expense_summary(_year INT)
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
  WHERE public.has_role(auth.uid(), 'financeiro')
     OR (g.unit_id IS NOT NULL AND public.has_unit(auth.uid(), g.unit_id))
$$;
REVOKE EXECUTE ON FUNCTION public.omie_expense_summary(INT) FROM anon;
