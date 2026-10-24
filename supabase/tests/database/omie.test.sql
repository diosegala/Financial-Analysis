-- Realizado do Omie: departamento herda a unidade do ancestral e o resumo respeita o perfil.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('financeiro', (SELECT id FROM units WHERE name = 'Financeiro'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('agencia'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('empresa'), 'Empresa Teste');
INSERT INTO omie_departments (company_id, code, name, structure) VALUES
  (pg_temp.id('empresa'), 'd1', 'Agência', '001.001'),
  (pg_temp.id('empresa'), 'd2', 'Receitas Fixas Agência', '001.001.001'),
  (pg_temp.id('empresa'), 'd3', 'Áreas de Apoio', '001.009'),
  (pg_temp.id('empresa'), 'd4', 'Financeiro', '001.009.001'),
  (pg_temp.id('empresa'), 'd5', 'Outro', '001.010');
INSERT INTO omie_categories (company_id, code, name, is_expense, is_revenue) VALUES
  (pg_temp.id('empresa'), '2.04.01', 'Marketing', true, false),
  (pg_temp.id('empresa'), '1.01.01', 'Receita de serviços', false, true);
INSERT INTO omie_actuals (company_id, year, month, category_code, department_code, amount_paid, amount_open) VALUES
  (pg_temp.id('empresa'), 2026, 1, '2.04.01', 'd2', 100, 0),
  (pg_temp.id('empresa'), 2026, 1, '2.04.01', 'd4', 0, 50),
  (pg_temp.id('empresa'), 2026, 2, '2.04.01', '', 30, 0),
  (pg_temp.id('empresa'), 2026, 2, '2.04.01', 'd5', 0, 5),
  (pg_temp.id('empresa'), 2026, 1, '1.01.01', 'd2', 999, 0);

SELECT is((SELECT unit_id FROM omie_department_unit WHERE department_code = 'd2'), pg_temp.id('agencia'),
  'Departamento filho herda a unidade do pai (Receitas Fixas Agência → Agência)');
SELECT is((SELECT unit_id FROM omie_department_unit WHERE department_code = 'd4'), pg_temp.id('financeiro'),
  'Departamento de apoio com unidade própria (Financeiro)');
SELECT is((SELECT count(*)::INT FROM omie_department_unit WHERE department_code = 'd5'), 0,
  'Departamento sem unidade mapeada fica de fora');

SELECT pg_temp.login('fin');
SELECT is((SELECT count(*)::INT FROM omie_expense_summary(2026)), 3,
  'Financeiro vê Agência, Financeiro e o que não tem unidade; receita fica de fora');
SELECT is((SELECT paid[1] FROM omie_expense_summary(2026) WHERE unit_id = pg_temp.id('agencia')), 100::NUMERIC,
  'Janeiro pago da Agência (vem do departamento filho)');
SELECT is((SELECT open[1] FROM omie_expense_summary(2026) WHERE unit_id = pg_temp.id('financeiro')), 50::NUMERIC, 'Em aberto do Financeiro');
SELECT is((SELECT paid[2] + open[2] FROM omie_expense_summary(2026) WHERE unit_id IS NULL), 35::NUMERIC,
  'Sem departamento e departamento sem unidade somam no grupo sem unidade');

SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM omie_expense_summary(2026)), 1, 'Líder só vê a própria unidade, nunca o que não tem unidade');
SELECT is((SELECT count(*)::INT FROM omie_actuals), 0, 'Líder não lê o realizado cru');

SELECT * FROM finish();
ROLLBACK;
