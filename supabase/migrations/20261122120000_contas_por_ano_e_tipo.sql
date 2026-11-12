-- Categorias do Omie viram contas por nome, tipo e ano, como na carga inicial ("CUPOLA Summit - 2026" e "- 2027").
-- Antes, a criação automática comparava só o nome sem o ano: a categoria de 2027 não virava conta quando já havia a de
-- 2026, e a receita com o mesmo nome de uma despesa (ou o contrário) ficava sem conta.

-- Ano ou período no fim do nome: "X - 2027" → '2027'; "X - 2026/ 27" → '2026/2027'. Sem ano, NULL.
CREATE FUNCTION public.category_period(_name TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN m IS NULL THEN NULL WHEN m[3] IS NULL THEN m[1]
    ELSE m[1] || '/' || CASE WHEN length(m[3]) = 2 THEN '20' || m[3] ELSE m[3] END END
  FROM regexp_match(_name, '(20\d{2})(\s*/\s*(\d{4}|\d{2}))?\s*$') m
$$;

-- Chave da categoria já vista: nome sem o ano, tipo e ano.
CREATE FUNCTION public.omie_category_key(_name TEXT, _kind TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT public.norm_text(public.category_base_name(_name)) || '|' || _kind || '|' || COALESCE(public.category_period(_name), '')
$$;

-- As contas criadas pela leitura ficaram sem o ano.
UPDATE public.accounts SET period = public.category_period(name)
WHERE period IS NULL AND public.category_period(name) IS NOT NULL;

-- Categorias já lidas, na chave nova. Ficam de fora as que a regra antiga deixou sem conta e que entram agora
-- (eventos de 2027 da Educação); a próxima leitura do Omie cria essas contas.
INSERT INTO public.omie_known_categories (name_key)
SELECT DISTINCT public.omie_category_key(c.name, x.kind)
FROM public.omie_categories c
CROSS JOIN LATERAL (SELECT 'receita' AS kind WHERE c.is_revenue UNION ALL SELECT 'despesa' WHERE c.is_expense) x
WHERE NOT c.is_total
  AND (public.norm_text(c.name), x.kind) NOT IN (
    SELECT public.norm_text(n), k FROM (VALUES
      ('Imersão CUPOLA Lançamentos - 2027', 'despesa'),
      ('Imersão CUPOLA Lançamentos Ingressos - 2027', 'receita'),
      ('Imersão CUPOLA Lançamentos Patrocínio - 2027', 'receita'),
      ('Imersão CUPOLA Aluguel - 2027', 'despesa'),
      ('Imersão CUPOLA Aluguel Ingressos - 2027', 'receita'),
      ('Imersão CUPOLA Aluguel Patrocínio - 2027', 'receita'),
      ('Gestão de Pessoas Lago Imóveis - 2027', 'receita'),
      ('Imersão Lago Imóveis - 2ª Edição', 'despesa'),
      ('Imersão Lago Imóveis - 3ª Edição', 'receita'),
      ('Imersão Lago Imóveis - 4ª Edição', 'receita')) v(n, k))
ON CONFLICT DO NOTHING;

-- Categorias novas viram contas lançáveis para todas as unidades, na linha da DRE mais usada pelo tipo. Ficam de fora
-- os grupos, as de período anterior e as que as regras de tratamento dizem que o app calcula ou que ficam fora da DRE.
-- Uma conta por nome, tipo e ano. Tudo pode ser ajustado depois em Plano de contas.
CREATE OR REPLACE FUNCTION public.omie_create_new_accounts() RETURNS TEXT[]
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _names TEXT[];
BEGIN
  WITH cats AS (
    SELECT DISTINCT ON (public.omie_category_key(c.name, x.kind))
      public.omie_category_key(c.name, x.kind) AS name_key, c.name, c.code, x.kind,
      public.norm_text(public.category_base_name(c.name)) AS base_key, public.category_period(c.name) AS period
    FROM public.omie_categories c
    CROSS JOIN LATERAL (SELECT 'receita' AS kind WHERE c.is_revenue UNION ALL SELECT 'despesa' WHERE c.is_expense) x
    WHERE NOT c.is_total
    ORDER BY public.omie_category_key(c.name, x.kind), c.name DESC
  ), chosen AS (
    SELECT f.* FROM cats f
    WHERE NOT EXISTS (SELECT 1 FROM public.omie_known_categories k WHERE k.name_key = f.name_key)
      AND COALESCE(left(f.period, 4)::INT, 9999) >= EXTRACT(YEAR FROM now())::INT
      AND NOT EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE (a.kind = 'receita') = (f.kind = 'receita')
          AND (public.norm_text(a.name) = public.norm_text(f.name)
               OR (public.norm_text(COALESCE(a.base_name, public.category_base_name(a.name))) = f.base_key
                   AND COALESCE(replace(a.period, ' ', ''), '') = COALESCE(f.period, ''))))
      AND NOT EXISTS (
        SELECT 1 FROM public.account_treatment_rules r
        WHERE public.norm_text(f.name) ~ ('(^|[^a-z0-9])' ||
          regexp_replace(public.norm_text(r.keyword), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '($|[^a-z0-9])'))
  ), created AS (
    INSERT INTO public.accounts (name, kind, dre_line_id, omie_category_code, base_name, period, treatment)
    SELECT ch.name, ch.kind,
      (SELECT a.dre_line_id FROM public.accounts a
       WHERE a.kind = ch.kind AND a.active AND a.treatment = 'lancavel' AND a.dre_line_id IS NOT NULL
       GROUP BY a.dre_line_id ORDER BY count(*) DESC LIMIT 1),
      ch.code, public.category_base_name(ch.name), ch.period, 'lancavel'
    FROM chosen ch
    RETURNING name
  ), seen AS (
    INSERT INTO public.omie_known_categories (name_key)
    SELECT name_key FROM cats ON CONFLICT DO NOTHING
  )
  SELECT COALESCE(array_agg(name ORDER BY name), '{}') INTO _names FROM created;
  RETURN _names;
END $$;
