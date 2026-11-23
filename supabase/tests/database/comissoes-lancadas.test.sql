-- Comissões e repasses lançados pelo financeiro: entram no custo variável e no Comissionamento, ficam fora do limite, e o
-- diretor não lança.
BEGIN;
SELECT plan(8);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lider', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id
               WHERE v.name = 'Orçamento 2027' ORDER BY s.created_at LIMIT 1)),
  ('linha_dre', (SELECT id FROM dre_lines WHERE code = 'comissionamento')),
  ('receita', (SELECT id FROM accounts WHERE kind = 'receita' AND treatment = 'lancavel' AND active AND unit_ids IS NULL
               ORDER BY name LIMIT 1));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO accounts (name, kind, treatment, dre_line_id, variable_cost)
VALUES ('Repasse a parceiros - teste', 'despesa', 'lancavel', pg_temp.id('linha_dre'), true);
INSERT INTO ids VALUES ('repasse', (SELECT id FROM accounts WHERE name = 'Repasse a parceiros - teste'));
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lider'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lider'), pg_temp.id('agencia'));
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);
SELECT guardrails_suggest(pg_temp.id('cenario'));

CREATE FUNCTION pg_temp.bucket(_b TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM plan_split(pg_temp.id('versao'), NULL)
  WHERE unit_id = pg_temp.id('agencia') AND bucket = _b $$;
CREATE FUNCTION pg_temp.comissionamento() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM dre_leaf_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('agencia')])
  WHERE dre_line_id = pg_temp.id('linha_dre') $$;
CREATE FUNCTION pg_temp.base() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT base_expense FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia') $$;
-- Receita de 10.000 por mês e repasse de 1.000 por mês, lançados pelo financeiro.
WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id) VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('receita'))
           RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT l.id, m, 10000 FROM l CROSS JOIN generate_series(1, 12) m;
CREATE TEMP TABLE antes AS
  SELECT pg_temp.bucket('variavel') AS v, pg_temp.bucket('despesa') AS d, pg_temp.comissionamento() AS c, pg_temp.base() AS b;
GRANT SELECT ON antes TO authenticated;
WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id) VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('repasse'))
           RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT l.id, m, 1000 FROM l CROSS JOIN generate_series(1, 12) m;

SELECT is(pg_temp.bucket('variavel') - (SELECT v FROM antes), 12000::NUMERIC, 'O repasse entra no custo variável');
SELECT is(pg_temp.bucket('despesa') - (SELECT d FROM antes), 0::NUMERIC, 'E não nas despesas');
SELECT is(pg_temp.comissionamento() - (SELECT c FROM antes), 12000::NUMERIC, 'Na DRE, na linha Comissionamento');

INSERT INTO reference_adjustments (year, unit_id, account_id, amount) VALUES (2026, pg_temp.id('agencia'), pg_temp.id('repasse'), 50000);
SELECT is(pg_temp.base(), (SELECT b FROM antes), 'O repasse do ano base fica fora da base do limite');

-- Taxa variável: o lançado sobre a receita lançada no ano.
SELECT is((SELECT rate FROM variable_rate_parts(pg_temp.id('agencia'), '2027-06-01') WHERE rule_id IS NULL),
  12000 / (SELECT SUM(v.amount) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id JOIN accounts a ON a.id = l.account_id
    WHERE l.version_id = pg_temp.id('versao') AND l.unit_id = pg_temp.id('agencia') AND a.kind = 'receita'),
  'A taxa variável da unidade soma o lançado sobre a receita');

-- O diretor não lança nem mexe.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ INSERT INTO plan_lines (version_id, unit_id, account_id)
  VALUES ((SELECT id FROM ids WHERE k = 'versao'), (SELECT id FROM ids WHERE k = 'agencia'), (SELECT id FROM ids WHERE k = 'repasse')) $$,
  'Comissões e repasses são lançados pelo financeiro.', 'O diretor não cria lançamento');
SELECT throws_ok($$ UPDATE plan_values SET amount = 1 WHERE line_id IN (SELECT l.id FROM plan_lines l
  WHERE l.account_id = (SELECT id FROM ids WHERE k = 'repasse')) $$,
  'Comissões e repasses são lançados pelo financeiro.', 'Nem muda o valor');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE account_id = (SELECT id FROM ids WHERE k = 'repasse')), 1, 'Mas vê o lançamento');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
