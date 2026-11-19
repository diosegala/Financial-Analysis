-- Folha da unidade na tela: uma consulta só, com o rateio. A unidade da pessoa vê a parte dela, a que recebe vê a parte
-- rateada, e as duas somam o custo inteiro, igual ao que entra no limite.
BEGIN;
SELECT plan(6);

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

-- Custo total da Ana no ano, pela tela de uma unidade.
CREATE FUNCTION pg_temp.custo(_unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(m), 0) FROM unit_payroll_detail(pg_temp.id('versao'), NULL, pg_temp.id(_unit)) d, unnest(d.months) m
  WHERE d.person_id = pg_temp.id('ana') AND d.grupo = 'custo_total' $$;
CREATE TEMP TABLE antes AS SELECT pg_temp.custo('consultoria') AS custo,
  (SELECT SUM(amount) FROM payroll_detail(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
   WHERE grupo = 'custo_total') AS detalhe;
GRANT SELECT ON antes TO authenticated;

SELECT is(round((SELECT custo FROM antes), 2), round((SELECT detalhe FROM antes), 2),
  'Sem rateio: o mesmo custo da folha detalhada');

INSERT INTO person_allocations (person_id, unit_id, share) VALUES (pg_temp.id('ana'), pg_temp.id('agencia'), 0.3);

SELECT is(round(pg_temp.custo('consultoria'), 2), round((SELECT custo FROM antes) * 0.7, 2),
  'A unidade da Ana vê 70% do custo dela');
SELECT is(round(pg_temp.custo('agencia'), 2), round((SELECT custo FROM antes) * 0.3, 2),
  'A Agência vê a Ana com 30%');
SELECT is((SELECT DISTINCT row(home_unit_id, share)::TEXT FROM unit_payroll_detail(pg_temp.id('versao'), NULL, pg_temp.id('agencia'))
           WHERE person_id = pg_temp.id('ana')), row(pg_temp.id('consultoria'), 0.3)::TEXT,
  'Com a unidade de origem e a parte');

-- O diretor da Agência vê a parte dele, mas não a folha da Consultoria.
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT is(round(pg_temp.custo('agencia'), 2), round((SELECT custo FROM antes) * 0.3, 2), 'O diretor da Agência vê a parte da Ana');
SELECT is((SELECT count(*)::INT FROM unit_payroll_detail(pg_temp.id('versao'), NULL, pg_temp.id('consultoria'))), 0,
  'E não vê a folha da Consultoria');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
