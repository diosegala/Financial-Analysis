-- IBS/CBS com crédito nas compras: o débito sobre a receita, o crédito sobre as despesas que geram crédito dois meses
-- depois, e a exceção da linha (fornecedor do Simples).
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('rec', gen_random_uuid()), ('desp', gen_random_uuid()), ('ibs', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

UPDATE calc_rules SET active = false;
INSERT INTO accounts (id, name, kind, treatment, dre_line_id, generates_tax_credit) VALUES
  (pg_temp.id('rec'), 'Receita IBS Teste', 'receita', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'receita_bruta'), false),
  (pg_temp.id('desp'), 'Serviço IBS Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'), true);
INSERT INTO parameter_definitions (id, key, label, value_type, allowed_scopes, sort_order)
VALUES (pg_temp.id('ibs'), 'ibs_teste', 'IBS teste', 'percent', ARRAY['global'], 999);
INSERT INTO parameter_values (definition_id, value, valid_from) VALUES (pg_temp.id('ibs'), 0.10, '2027-01-01');
INSERT INTO calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, credit_on_purchases)
VALUES ('IBS teste', (SELECT id FROM dre_lines WHERE code = 'impostos'), pg_temp.id('ibs'), 'receita', true);

CREATE FUNCTION pg_temp.lanca(_acc TEXT, _month INT, _amount NUMERIC, _credit BOOLEAN DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id, tax_credit)
    VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id(_acc), _credit) RETURNING id)
  INSERT INTO plan_values (line_id, month, amount) SELECT id, _month, _amount FROM l $$;
SELECT pg_temp.lanca('rec', 1, 2000);
SELECT pg_temp.lanca('desp', 1, 1000);
SELECT pg_temp.lanca('desp', 2, 500, false);
SELECT pg_temp.lanca('desp', 11, 1000);

CREATE FUNCTION pg_temp.imp(_m INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(u.amount), 0) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('agencia')]) u
  JOIN dre_lines d ON d.id = u.dre_line_id WHERE d.code = 'impostos' AND (_m = 0 OR u.month = _m) $$;

SELECT is(pg_temp.imp(1), 200::NUMERIC, 'Janeiro: o débito sobre a receita');
SELECT is(pg_temp.imp(3), -100::NUMERIC, 'Março: o crédito da despesa de janeiro, 60 dias depois');
SELECT is(pg_temp.imp(4), 0::NUMERIC, 'Abril: a despesa de fevereiro é de fornecedor do Simples, sem crédito');
SELECT is(pg_temp.imp(0), 100::NUMERIC, 'O crédito da despesa de novembro fica para o ano seguinte');

UPDATE parameter_values SET value = 1 WHERE definition_id = (SELECT id FROM parameter_definitions WHERE key = 'credito_meses');
INSERT INTO parameter_values (definition_id, value, valid_from)
SELECT id, 1, '2027-01-01' FROM parameter_definitions WHERE key = 'credito_meses';
SELECT is(pg_temp.imp(2), -100::NUMERIC, 'Com prazo de 1 mês, o crédito vem em fevereiro');
SELECT is((SELECT SUM(amount) FROM plan_split(pg_temp.id('versao'), NULL) WHERE unit_id = pg_temp.id('agencia') AND bucket = 'variavel'),
  200 - 100 - 100::NUMERIC, 'No limite, o crédito reduz o custo variável (novembro já cai em dezembro)');

SELECT * FROM finish();
ROLLBACK;
