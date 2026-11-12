-- Planilha de Educação: cada bloco de receita vai para a conta do seu tipo (ingressos, patrocínio, variável),
-- e sem a conta do tipo cai na conta da receita do produto.
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('edu', (SELECT id FROM units WHERE name = 'Educação')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('ing', gen_random_uuid()), ('pat', gen_random_uuid()), ('var', gen_random_uuid()),
  ('custo', gen_random_uuid()), ('prod', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;

INSERT INTO accounts (id, name, kind, treatment, dre_line_id)
SELECT pg_temp.id(k), n, 'receita', 'lancavel', (SELECT id FROM dre_lines WHERE name = 'Receita bruta')
FROM (VALUES ('ing', 'ICL Ingressos - teste'), ('pat', 'ICL Patrocínio - teste'), ('var', 'ICL Vagas - teste')) x(k, n)
UNION ALL
SELECT pg_temp.id('custo'), 'ICL - teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE name = 'Despesas de produtos');
INSERT INTO products (id, name, unit_id, kind, revenue_account_id, sponsor_account_id, cost_account_id)
VALUES (pg_temp.id('prod'), 'ICL', pg_temp.id('edu'), 'evento', pg_temp.id('ing'), pg_temp.id('pat'), pg_temp.id('custo'));
UPDATE edu_sheet_settings SET spreadsheet_id = 'teste', version_id = pg_temp.id('versao');
INSERT INTO edu_sheet_tabs (tab_name, product_id, active) VALUES ('ICL Plan.', pg_temp.id('prod'), true);

CREATE FUNCTION pg_temp.blocos() RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'receita', 'label', 'INGRESSOS', 'months', to_jsonb(ARRAY[1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'receita', 'label', 'PATROCÍNIO', 'months', to_jsonb(ARRAY[0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'receita', 'label', 'VAGAS EXTRAS', 'months', to_jsonb(ARRAY[0, 0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'taxa', 'label', 'Taxas sobre ROB (-)', 'months', to_jsonb(ARRAY[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    jsonb_build_object('kind', 'imposto', 'label', 'Impostos sobre ROB (-)', 'months', to_jsonb(ARRAY[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))
$$;
CREATE FUNCTION pg_temp.na_conta(_k TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(v.amount), 0) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id
  WHERE l.sheet_tab_id IS NOT NULL AND l.account_id = pg_temp.id(_k)
$$;

SELECT edu_sheet_store(NULL, 'ICL Plan.', 'ICL', pg_temp.blocos(), '{}', NULL);
SELECT is(pg_temp.na_conta('ing'), 1200::NUMERIC, 'Ingressos e, sem conta própria, as vagas extras na conta de ingressos');
SELECT is(pg_temp.na_conta('pat'), 500::NUMERIC, 'Patrocínio na conta de patrocínio');

UPDATE products SET extra_account_id = pg_temp.id('var') WHERE id = pg_temp.id('prod');
SELECT edu_sheet_store(NULL, 'ICL Plan.', 'ICL', pg_temp.blocos(), '{}', NULL);
SELECT is(pg_temp.na_conta('ing'), 1000::NUMERIC, 'Com a conta da variável: ingressos ficam sozinhos');
SELECT is(pg_temp.na_conta('var'), 200::NUMERIC, 'Vagas extras na conta da variável');

UPDATE products SET sponsor_account_id = NULL, extra_account_id = NULL WHERE id = pg_temp.id('prod');
SELECT edu_sheet_store(NULL, 'ICL Plan.', 'ICL', pg_temp.blocos(), '{}', NULL);
SELECT is(pg_temp.na_conta('ing'), 1700::NUMERIC, 'Sem as contas por tipo, toda a receita na conta do produto, como antes');
SELECT is(pg_temp.na_conta('pat') + pg_temp.na_conta('var'), 0::NUMERIC, 'Ler de novo tira as linhas das contas antigas');

SELECT * FROM finish();
ROLLBACK;
