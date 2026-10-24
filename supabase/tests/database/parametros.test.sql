-- Parâmetros livres (ex.: IBS, CBS): só o financeiro cria e edita; o cálculo da DRE usa o que ele cadastra.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('vp', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.line(_c TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM dre_lines WHERE code = _c $$;
CREATE FUNCTION pg_temp.impostos(_month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT ROUND(amount, 4) FROM dre_report(pg_temp.id('versao'), pg_temp.id('realista'), ARRAY[pg_temp.id('consultoria')])
  WHERE dre_line_id = pg_temp.line('impostos') AND month = _month
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste'), (pg_temp.id('vp'), 'vp@teste');
INSERT INTO user_roles (user_id, role) VALUES
  (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider'), (pg_temp.id('vp'), 'vp');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- ───────────── Financeiro cria o IBS, com o cálculo ─────────────
SELECT pg_temp.login('fin');
SELECT lives_ok($$
  INSERT INTO parameter_definitions (key, label, value_type, allowed_scopes, min_value, sort_order)
  VALUES ('ibs', 'IBS', 'percent', ARRAY['global'], 0, 100)
$$, 'Financeiro cria um parâmetro novo');
SELECT lives_ok($$
  INSERT INTO calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, sort_order)
  VALUES ('IBS', pg_temp.line('impostos'), (SELECT id FROM parameter_definitions WHERE key = 'ibs'), 'receita', 100)
$$, 'E a regra que o leva para a linha de impostos da DRE');
SELECT lives_ok($$
  INSERT INTO parameter_values (definition_id, value, valid_from)
  VALUES ((SELECT id FROM parameter_definitions WHERE key = 'ibs'), 0.02, '2027-01-01')
$$, 'E o valor, com a vigência');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Contrato',
    NULL, NULL, pg_temp.rt('Variável (até 3 meses)'), '[{"month": 3, "amount": 10000}]'::JSONB)
$$, 'Uma receita de 10.000 em março');
SELECT is(pg_temp.impostos(3), 200.0000, 'O IBS de 2% entra nos impostos da DRE: 200');

UPDATE parameter_values SET value = 0.03 WHERE definition_id = (SELECT id FROM parameter_definitions WHERE key = 'ibs');
SELECT is(pg_temp.impostos(3), 300.0000, 'Editar o valor muda o cálculo: 300');

UPDATE calc_rules SET active = false WHERE name = 'IBS';
SELECT is(pg_temp.impostos(3), 0.0000, 'Desligar a regra tira o IBS da DRE');
RESET ROLE;

-- ───────────── Líder e VP só leem ─────────────
SELECT pg_temp.login('lid');
SELECT throws_ok($$
  INSERT INTO parameter_definitions (key, label, value_type, allowed_scopes) VALUES ('cbs', 'CBS', 'percent', ARRAY['global'])
$$, '42501', NULL, 'Líder não cria parâmetro');
SELECT throws_ok($$
  INSERT INTO calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind)
  VALUES ('Regra do líder', pg_temp.line('impostos'), (SELECT id FROM parameter_definitions WHERE key = 'ibs'), 'receita')
$$, '42501', NULL, 'Líder não cria regra de cálculo');
SELECT throws_ok($$
  INSERT INTO parameter_values (definition_id, value, valid_from)
  VALUES ((SELECT id FROM parameter_definitions WHERE key = 'ibs'), 0.5, '2027-01-01')
$$, '42501', NULL, 'Líder não cadastra valor');
UPDATE parameter_values SET value = 0.5 WHERE definition_id = (SELECT id FROM parameter_definitions WHERE key = 'ibs');
SELECT is((SELECT value FROM parameter_values WHERE definition_id = (SELECT id FROM parameter_definitions WHERE key = 'ibs')), 0.03::NUMERIC,
  'Líder não altera o valor');
UPDATE parameter_definitions SET active = false WHERE key = 'ibs';
SELECT is((SELECT active FROM parameter_definitions WHERE key = 'ibs'), true, 'Líder não desativa parâmetro');
SELECT cmp_ok((SELECT count(*)::INT FROM parameter_values), '>', 0, 'Mas lê os valores (a DRE da unidade precisa deles)');
RESET ROLE;

SELECT pg_temp.login('vp');
SELECT throws_ok($$
  INSERT INTO parameter_definitions (key, label, value_type, allowed_scopes) VALUES ('cbs', 'CBS', 'percent', ARRAY['global'])
$$, '42501', NULL, 'VP não cria parâmetro');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
