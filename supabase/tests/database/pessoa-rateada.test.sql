-- Pessoa rateada entre unidades: a folha, os encargos e os benefícios se dividem pelas partes, e o diretor da unidade que
-- recebe vê a parte dele.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lider', gen_random_uuid()), ('ana', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lider'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lider'), pg_temp.id('agencia'));
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

INSERT INTO people (id, version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('ana'), pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana',
  (SELECT id FROM contract_types WHERE name = 'CLT'), 10000);

CREATE FUNCTION pg_temp.folha(_unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM plan_base_rows(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id(_unit)])
  WHERE row_kind IN ('salario', 'provisao', 'folha') $$;
CREATE FUNCTION pg_temp.custos(_unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id(_unit)]) u
  JOIN dre_lines d ON d.id = u.dre_line_id WHERE d.code = 'custos_indiretos' $$;
CREATE TEMP TABLE antes AS SELECT pg_temp.folha('consultoria') AS folha, pg_temp.custos('consultoria') AS custos;
GRANT SELECT ON antes TO authenticated;

INSERT INTO person_allocations (person_id, unit_id, share) VALUES (pg_temp.id('ana'), pg_temp.id('agencia'), 0.3);

SELECT is(round(pg_temp.folha('consultoria'), 2), round((SELECT folha FROM antes) * 0.7, 2), 'A unidade da Ana fica com 70% da folha');
SELECT is(round(pg_temp.folha('agencia'), 2), round((SELECT folha FROM antes) * 0.3, 2), 'A Agência recebe 30%');
SELECT is(round(pg_temp.custos('consultoria') + pg_temp.custos('agencia'), 2), round((SELECT custos FROM antes), 2),
  'Folha, encargos e benefícios: as partes somam o custo inteiro');
SELECT throws_ok($$ INSERT INTO person_allocations (person_id, unit_id, share)
  VALUES ((SELECT id FROM ids WHERE k = 'ana'), (SELECT id FROM ids WHERE k = 'consultoria'), 0.1) $$,
  'A unidade da pessoa fica com o que sobra: escolha outra unidade.');
SELECT throws_ok($$ INSERT INTO person_allocations (person_id, unit_id, share)
  VALUES ((SELECT id FROM ids WHERE k = 'ana'), (SELECT id FROM units WHERE name = 'Educação'), 0.8) $$,
  'As partes das outras unidades passam de 100%.');
CREATE TEMP TABLE ir_fin AS SELECT SUM(result) AS r FROM income_tax_quarters(pg_temp.id('versao'), NULL);
GRANT SELECT ON ir_fin TO authenticated;

-- O diretor da Agência vê a parte dele e a Ana na lista, mas não a folha da Consultoria.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT is(round(pg_temp.custos('agencia'), 2), round((SELECT custos FROM antes) * 0.3, 2), 'O diretor da Agência vê a parte dele');
SELECT is((SELECT row(name, home_unit, share)::TEXT FROM unit_allocated_people(pg_temp.id('versao'), pg_temp.id('agencia'))),
  row('Ana', 'Consultoria', 0.3)::TEXT, 'E a Ana na lista de pessoas de outras unidades');
SELECT is((SELECT count(*)::INT FROM allocated_payroll_rows(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])), 0,
  'Não vê partes de unidades que não são dele');
SELECT is((SELECT SUM(result) FROM income_tax_quarters(pg_temp.id('versao'), NULL)), (SELECT r FROM ir_fin),
  'O IRPJ/CSLL usa o resultado da empresa inteira, para qualquer um');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
