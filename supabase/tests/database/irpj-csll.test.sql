-- IRPJ e CSLL: apuração por trimestre sobre o resultado da empresa, com as despesas não dedutíveis de volta na base, o
-- prejuízo compensado até o limite, o pagamento no mês seguinte e o rateio pela receita das unidades de negócio.
BEGIN;
SELECT plan(16);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lider', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('adm', (SELECT id FROM units WHERE name = 'ADM')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('rec', gen_random_uuid()), ('desp', gen_random_uuid()), ('multa', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;

-- Só os lançamentos do teste: sem impostos sobre a receita nem encargos.
UPDATE calc_rules SET active = false;

INSERT INTO accounts (id, name, kind, treatment, dre_line_id, non_deductible) VALUES
  (pg_temp.id('rec'), 'Receita IR Teste', 'receita', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'receita_bruta'), false),
  (pg_temp.id('desp'), 'Despesa IR Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'), false),
  (pg_temp.id('multa'), 'Multa IR Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'), true);

INSERT INTO parameter_values (definition_id, value, valid_from)
SELECT d.id, v.value, DATE '2027-01-01' FROM (VALUES
  ('irpj', 0.15), ('irpj_adicional', 0.10), ('irpj_adicional_limite', 60000), ('csll', 0.09),
  ('compensacao_prejuizo', 0.30), ('irpj_csll_meses_pagamento', 1), ('irpj_csll_trimestre_anterior', 5000)) v(key, value)
JOIN parameter_definitions d ON d.key = v.key;

CREATE FUNCTION pg_temp.lanca(_unit TEXT, _account TEXT, _month INT, _amount NUMERIC, _nd BOOLEAN DEFAULT NULL)
RETURNS VOID LANGUAGE sql AS $$
  WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id, non_deductible)
    VALUES (pg_temp.id('versao'), pg_temp.id(_unit), pg_temp.id(_account), _nd) RETURNING id)
  INSERT INTO plan_values (line_id, month, amount) SELECT id, _month, _amount FROM l
$$;
-- 1º tri: receita 400 mil (Agência 100, Educação 300), despesa 100 mil no ADM e multa de 10 mil (não dedutível).
SELECT pg_temp.lanca('agencia', 'rec', 1, 100000);
SELECT pg_temp.lanca('educacao', 'rec', 2, 300000);
SELECT pg_temp.lanca('adm', 'desp', 3, 100000);
SELECT pg_temp.lanca('agencia', 'multa', 3, 10000);
-- 2º tri: prejuízo de 200 mil.
SELECT pg_temp.lanca('adm', 'desp', 5, 200000);
-- 3º tri: lucro de 100 mil, só da Agência.
SELECT pg_temp.lanca('agencia', 'rec', 7, 100000);
-- 4º tri: lucro de 40 mil; a multa desta linha foi marcada como dedutível.
SELECT pg_temp.lanca('agencia', 'rec', 10, 50000);
SELECT pg_temp.lanca('agencia', 'multa', 11, 10000, false);

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lider'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lider'), pg_temp.id('agencia'));
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

CREATE TEMP TABLE t AS SELECT * FROM income_tax_quarters(pg_temp.id('versao'), NULL);
GRANT SELECT ON t TO authenticated;

SELECT is((SELECT row(result, additions, taxable)::TEXT FROM t WHERE quarter = 1), row(290000.00, 10000.00, 300000.00)::TEXT,
  '1º tri: resultado, multa não dedutível de volta e lucro real');
SELECT is((SELECT irpj FROM t WHERE quarter = 1), 69000.00, '1º tri: IRPJ de 15% mais o adicional de 10% acima de 60 mil');
SELECT is((SELECT csll FROM t WHERE quarter = 1), 27000.00, '1º tri: CSLL de 9%');
SELECT is((SELECT pay_month FROM t WHERE quarter = 1), 4, '1º tri: pago em abril');
SELECT is((SELECT row(base, loss_balance, total)::TEXT FROM t WHERE quarter = 2), row(0.00, 200000.00, 0.00)::TEXT,
  '2º tri: prejuízo, sem imposto, vira saldo');
SELECT is((SELECT row(loss_used, base, total)::TEXT FROM t WHERE quarter = 3), row(30000.00, 70000.00, 17800.00)::TEXT,
  '3º tri: o prejuízo abate até 30% do lucro');
SELECT is((SELECT row(additions, pay_month)::TEXT FROM t WHERE quarter = 4), row(0.00, 13)::TEXT,
  '4º tri: a exceção da linha deixa a multa dedutível; o pagamento fica para janeiro do ano seguinte');
SELECT is((SELECT row(total, pay_month)::TEXT FROM t WHERE quarter = 0), row(5000, 1)::TEXT,
  'O 4º tri do ano anterior é pago em janeiro');

CREATE FUNCTION pg_temp.parte(_unit TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM income_tax_by_unit(pg_temp.id('versao'), NULL, NULL)
  WHERE unit_id = pg_temp.id(_unit) AND month = _month $$;
SELECT is(round(pg_temp.parte('agencia', 4), 2), 24000.00, 'Abril: a Agência paga 25%, a parte dela na receita do 1º tri');
SELECT is(round(pg_temp.parte('educacao', 4), 2), 72000.00, 'Abril: a Educação paga 75%');
SELECT is(pg_temp.parte('adm', 4), 0::NUMERIC, 'A área de apoio não recebe imposto');
SELECT is(round(pg_temp.parte('agencia', 1), 2), round(5000 * 250000 / 550000.0, 2),
  'Janeiro: o 4º tri anterior pela receita do ano');

CREATE FUNCTION pg_temp.dre(_code TEXT, _unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id(_unit)]) u
  JOIN dre_lines d ON d.id = u.dre_line_id WHERE d.code = _code $$;
SELECT is(round(pg_temp.dre('irpj_csll', 'educacao'), 2), round(72000 + 5000 * 300000 / 550000.0, 2),
  'A DRE da Educação mostra a parte dela do IRPJ e CSLL');
SELECT is(round(pg_temp.dre('resultado_liquido', 'educacao'), 2),
  round(pg_temp.dre('contribuicao_liquida', 'educacao') - pg_temp.dre('irpj_csll', 'educacao'), 2),
  'Resultado líquido = Contribuição líquida menos o IRPJ e CSLL');

-- O diretor da Agência: a parte dele é calculada sobre o total da empresa, e ele não vê as outras unidades.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT round(SUM(amount), 2) FROM dre_unit_values(pg_temp.id('versao'), NULL, NULL) u
           JOIN dre_lines d ON d.id = u.dre_line_id WHERE d.code = 'irpj_csll' AND u.month = 4), 24000.00,
  'O diretor vê a parte da Agência, calculada sobre o resultado da empresa');
SELECT is((SELECT count(*)::INT FROM income_tax_by_unit(pg_temp.id('versao'), NULL, NULL)
           WHERE unit_id <> pg_temp.id('agencia')), 0, 'E não vê a parte das outras unidades');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
