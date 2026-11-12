-- Planilha de Educação: a leitura troca os lançamentos do produto, a receita dela não recebe as regras de imposto,
-- taxas e impostos entram como dedução, e com a versão travada só a previsão muda.
BEGIN;
SELECT plan(13);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('edu', (SELECT id FROM units WHERE name = 'Educação')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('rec', gen_random_uuid()), ('custo', gen_random_uuid()), ('prod', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;

INSERT INTO accounts (id, name, kind, treatment, dre_line_id)
SELECT pg_temp.id('rec'), 'Receita Produto Teste', 'receita', 'lancavel', (SELECT id FROM dre_lines WHERE name = 'Receita bruta')
UNION ALL
SELECT pg_temp.id('custo'), 'Custo Produto Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE name = 'Despesas de produtos');
INSERT INTO products (id, name, unit_id, revenue_account_id, cost_account_id)
VALUES (pg_temp.id('prod'), 'GPL', pg_temp.id('edu'), pg_temp.id('rec'), pg_temp.id('custo'));
UPDATE edu_sheet_settings SET spreadsheet_id = 'teste', version_id = pg_temp.id('versao');

-- Um lançamento manual do produto, que a planilha substitui
WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('edu'), pg_temp.id('custo'), 'manual') RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT id, 1, 999 FROM l;

CREATE FUNCTION pg_temp.blocos(_ingresso NUMERIC) RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'receita', 'label', 'INGRESSOS', 'months', to_jsonb(ARRAY[_ingresso, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'receita', 'label', 'PATROCINIO', 'months', to_jsonb(ARRAY[0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'taxa', 'label', 'Taxas sobre ROB (-)', 'months', to_jsonb(ARRAY[30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'imposto', 'label', 'Impostos sobre ROB (-)', 'months', to_jsonb(ARRAY[130, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'custo', 'label', 'CUSTO PARCEIRO sobre ROB (-)', 'months', to_jsonb(ARRAY[0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'despesa', 'label', 'Despesas Administrativas', 'months', to_jsonb(ARRAY[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))
$$;
CREATE FUNCTION pg_temp.split(_bucket TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM plan_split(pg_temp.id('versao'), NULL)
  WHERE unit_id = pg_temp.id('edu') AND bucket = _bucket
$$;
CREATE TEMP TABLE antes AS SELECT pg_temp.split('receita') AS rec, pg_temp.split('variavel') AS var, pg_temp.split('despesa') AS desp;

-- Aba ainda não ligada: só aparece na lista
SELECT is(edu_sheet_store(NULL, 'GPL Plan. ', 'GPL - 24/02', pg_temp.blocos(1000), '{}', NULL), 'nao_ligada',
  'Aba nova aparece sem gravar nada');
UPDATE edu_sheet_tabs SET active = true, product_id = pg_temp.id('prod') WHERE tab_name = 'GPL Plan.';

SELECT is(edu_sheet_store(NULL, 'GPL Plan.', 'GPL - 24/02', pg_temp.blocos(1000), '{}', NULL), 'plano',
  'Versão aberta: grava no plano');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE sheet_tab_id IS NOT NULL), 5,
  'Uma linha por bloco com valor (a despesa zerada não entra)');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE account_id = pg_temp.id('custo') AND sheet_tab_id IS NULL), 0,
  'O lançamento manual do produto sai');
SELECT is(pg_temp.split('receita') - (SELECT rec FROM antes), 1500::NUMERIC, 'Receita da planilha entra na receita');
SELECT is(pg_temp.split('variavel') - (SELECT var FROM antes), 225::NUMERIC,
  'Só as taxas e os impostos da planilha: as regras do app não incidem nessa receita');
SELECT is(pg_temp.split('despesa') - (SELECT desp FROM antes), 400 - 999::NUMERIC,
  'Custos do produto entram como despesa, no lugar do lançamento manual');
SELECT is((SELECT description FROM plan_lines WHERE sheet_tab_id IS NOT NULL AND account_id = pg_temp.id('rec')
           AND description LIKE '%Ingressos'), 'GPL · Ingressos', 'A linha leva o produto e o bloco');

SELECT edu_sheet_store(NULL, 'GPL Plan.', 'GPL - 24/02', pg_temp.blocos(2000), '{}', NULL);
SELECT is(pg_temp.split('receita') - (SELECT rec FROM antes), 2500::NUMERIC, 'Ler de novo troca, sem somar');

SELECT is(edu_sheet_store(NULL, 'GPL Plan.', NULL, '[]', '{}', 'As datas da linha 2 não trazem os 12 meses de 2027.'), 'erro',
  'Aba com erro não mexe no plano');
SELECT is(pg_temp.split('receita') - (SELECT rec FROM antes), 2500::NUMERIC, 'O plano continua como estava');

-- Versão travada: o plano fica, a previsão muda
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000f1', 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000f1', 'financeiro');
SELECT set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000000f1", "role": "authenticated"}', true);
UPDATE budget_versions SET status = 'travado', closed_month = 0 WHERE id = pg_temp.id('versao');
SELECT is(edu_sheet_store(NULL, 'GPL Plan.', 'GPL - 24/02', pg_temp.blocos(3000), '{}', NULL), 'previsao',
  'Versão travada: grava a previsão');
SELECT is(
  (SELECT forecast - planned FROM dre_compare(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('edu')])
   WHERE month = 1 AND dre_line_id = (SELECT id FROM dre_lines WHERE name = 'Receita bruta')),
  1000::NUMERIC, 'A previsão de janeiro tem a receita nova; o plano, a antiga');

SELECT * FROM finish();
ROLLBACK;
