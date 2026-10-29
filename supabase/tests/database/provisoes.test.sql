-- Provisão de 13º e de férias em linhas separadas no detalhe da folha.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.def(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM parameter_definitions WHERE key = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
SELECT pg_temp.login('fin');

SELECT is((SELECT array_agg(name ORDER BY sort_order) FROM calc_rules WHERE payroll_group = 'provisao'),
  ARRAY['Provisão de 13º salário', 'Provisão de férias (com 1/3)'], 'Duas regras de provisão');
SELECT ok(NOT EXISTS (SELECT 1 FROM parameter_definitions WHERE key = 'provisao_13_ferias'),
  'O parâmetro único deixou de existir');

INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000);
CREATE FUNCTION pg_temp.dre_custos() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT SUM(v.amount) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')]) v
  JOIN dre_lines dl ON dl.id = v.dre_line_id AND dl.kind IN ('lancada', 'calculada') AND dl.sign < 0
  WHERE v.month = 3
$$;
GRANT EXECUTE ON FUNCTION pg_temp.dre_custos() TO authenticated;
CREATE TEMP TABLE dre_antes AS SELECT pg_temp.dre_custos() AS v;
GRANT SELECT ON dre_antes TO authenticated;
INSERT INTO parameter_values (definition_id, value, valid_from, contract_type_id) VALUES
  (pg_temp.def('provisao_13'), 0.10, '2026-01-01', pg_temp.ct('CLT')),
  (pg_temp.def('provisao_ferias'), 0.20, '2026-01-01', pg_temp.ct('CLT'));
CREATE FUNCTION pg_temp.det(_item TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT amount FROM payroll_detail(pg_temp.id('versao')) WHERE item = _item AND month = 3
$$;
GRANT EXECUTE ON FUNCTION pg_temp.det(TEXT) TO authenticated;

SELECT is(pg_temp.det('Provisão de 13º salário'), 500::NUMERIC, '13º: 10% de 5.000');
SELECT is(pg_temp.det('Provisão de férias (com 1/3)'), 1000::NUMERIC, 'Férias: 20% de 5.000');
-- Encargos de CLT que incidem sobre as provisões: 20% + 1% + 5,8% + 8% = 34,8%
SELECT is(pg_temp.det('Provisão de 13º salário · encargos'), 174::NUMERIC, 'Encargos sobre o 13º: 34,8% de 500');
SELECT is(pg_temp.det('Provisão de férias (com 1/3) · encargos'), 348::NUMERIC, 'Encargos sobre as férias: 34,8% de 1.000');
SELECT is(pg_temp.det('Custo total para a empresa'), 5000 + 1000 + 50 + 290 + 400 + 500 + 1000 + 174 + 348::NUMERIC,
  'Custo total soma as provisões e os encargos sobre elas');
SELECT is(pg_temp.dre_custos() - (SELECT v FROM dre_antes), 500 + 1000 + 174 + 348::NUMERIC,
  'A DRE sobe o mesmo que o custo da folha');

UPDATE calc_rules SET on_provisions = false WHERE name = 'FGTS';
SELECT is(pg_temp.det('Provisão de 13º salário · encargos'), 134::NUMERIC, 'Sem o FGTS marcado: 26,8% de 500');

SELECT * FROM finish();
ROLLBACK;
