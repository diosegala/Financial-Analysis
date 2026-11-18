-- Ano base ajustável: o total corrigido pelo financeiro substitui o do Omie, na proporção dos meses do Omie.
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lider', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('desp', gen_random_uuid()), ('nova', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO accounts (id, name, kind, treatment, dre_line_id) VALUES
  (pg_temp.id('desp'), 'Despesa Base Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas')),
  (pg_temp.id('nova'), 'Despesa Nova Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'));

-- O Omie de 2026 desta conta: 100 em janeiro e 300 em fevereiro (o resto, zero).
CREATE OR REPLACE FUNCTION public.reference_rows_omie(_year INT)
RETURNS TABLE (unit_id UUID, account_id UUID, kind TEXT, month INT, amount NUMERIC) LANGUAGE sql AS $$
  SELECT (SELECT id FROM units WHERE name = 'Consultoria'), (SELECT id FROM accounts WHERE name = 'Despesa Base Teste'),
    'despesa', m, a FROM (VALUES (1, 100::NUMERIC), (2, 300::NUMERIC)) v(m, a) WHERE _year = 2026
$$;

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lider'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lider'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.ref(_acc TEXT, _m INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM reference_rows(2026) WHERE account_id = pg_temp.id(_acc) AND (_m = 0 OR month = _m) $$;

SELECT is(pg_temp.ref('desp', 0), 400::NUMERIC, 'Sem ajuste, vale o Omie');

INSERT INTO reference_adjustments (year, unit_id, account_id, amount) VALUES
  (2026, pg_temp.id('consultoria'), pg_temp.id('desp'), 1000),
  (2026, pg_temp.id('consultoria'), pg_temp.id('nova'), 100);
SELECT is(row(pg_temp.ref('desp', 1), pg_temp.ref('desp', 2), pg_temp.ref('desp', 0))::TEXT, row(250.00, 750.00, 1000.00)::TEXT,
  'O total ajustado é repartido na proporção dos meses do Omie');
SELECT is(row(pg_temp.ref('nova', 1), pg_temp.ref('nova', 12), pg_temp.ref('nova', 0))::TEXT, row(8.33, 8.37, 100.00)::TEXT,
  'Sem Omie, igual pelos 12 meses, com os centavos em dezembro');

-- O diretor vê o ajuste ao lado do plano, e o Omie separado; não pode ajustar.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT SUM(amount) FROM unit_reference(pg_temp.id('versao'), pg_temp.id('consultoria')) WHERE account_id = pg_temp.id('desp')),
  1000.00, 'O diretor vê o valor ajustado');
SELECT is((SELECT amount FROM unit_reference_omie(pg_temp.id('versao'), pg_temp.id('consultoria')) WHERE account_id = pg_temp.id('desp')),
  400::NUMERIC, 'E o valor do Omie, para comparar');
SELECT throws_ok($$ INSERT INTO reference_adjustments (year, unit_id, account_id, amount)
  VALUES (2026, (SELECT id FROM ids WHERE k = 'consultoria'), (SELECT id FROM ids WHERE k = 'desp'), 5) $$,
  '42501', NULL, 'Só o financeiro ajusta');
RESET ROLE;

DELETE FROM reference_adjustments WHERE account_id = pg_temp.id('desp');
SELECT is(pg_temp.ref('desp', 0), 400::NUMERIC, 'Apagado o ajuste, volta o Omie');

SELECT * FROM finish();
ROLLBACK;
