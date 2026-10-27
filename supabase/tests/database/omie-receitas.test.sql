-- Receita realizada do Omie: unidade pelas regras da despesa, fora o que não é DRE, e carteira sugerida para o plano.
BEGIN;
SELECT plan(8);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('educacao'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('empresa'), 'Empresa Teste');
INSERT INTO omie_departments (company_id, code, name, structure) VALUES (pg_temp.id('empresa'), 'd1', 'Agência', '001.001');
INSERT INTO omie_categories (company_id, code, name, is_revenue) VALUES
  (pg_temp.id('empresa'), '1.01.02', 'Receitas Fixas', true),
  (pg_temp.id('empresa'), '1.01.84', 'Aluguel Essencial', true),
  (pg_temp.id('empresa'), '1.04.98', 'Transferências CUPOLA - Entrada', true);
INSERT INTO omie_suppliers (company_id, code, name) VALUES
  (pg_temp.id('empresa'), 'cli1', 'Cliente A'), (pg_temp.id('empresa'), 'cli2', 'Cliente B');
INSERT INTO omie_receipts (company_id, year, month, category_code, department_code, client_code, amount_received, amount_open)
SELECT pg_temp.id('empresa'), 2026, m, '1.01.02', 'd1', 'cli1', 1000, 0 FROM generate_series(7, 10) m
UNION ALL SELECT pg_temp.id('empresa'), 2026, m, '1.01.84', '', 'cli2', 500, 0 FROM generate_series(9, 10) m
UNION ALL SELECT pg_temp.id('empresa'), 2026, 10, '1.04.98', '', 'cli1', 9999, 0
UNION ALL SELECT pg_temp.id('empresa'), 2027, m, '1.01.84', '', 'cli2', 0, 300 FROM generate_series(1, 3) m;

SELECT pg_temp.login('fin');
CREATE FUNCTION pg_temp.total(_cat TEXT, _unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT SUM((SELECT SUM(v) FROM unnest(received) v)) FROM omie_revenue_summary(2026)
  WHERE category_name = _cat AND unit_id IS NOT DISTINCT FROM pg_temp.id(_unit)
$$;
SELECT is(pg_temp.total('Receitas Fixas', 'agencia'), 4000::NUMERIC, 'Receita vai para a unidade do departamento');
SELECT is(pg_temp.total('Aluguel Essencial', 'educacao'), 1000::NUMERIC, 'Sem departamento, vale a palavra no nome');
SELECT is((SELECT count(*)::INT FROM omie_revenue_summary(2026) WHERE category_name LIKE 'Transfer%'), 0,
  'Transferências (fora do grupo 1.01, sem conta no app) ficam de fora');
SELECT is((SELECT client_name FROM omie_revenue_summary(2026) WHERE category_name = 'Receitas Fixas'), 'Cliente A',
  'Nome do cliente vem do cadastro do Omie');

SELECT is((SELECT monthly FROM revenue_portfolio(pg_temp.id('versao'), pg_temp.id('agencia')) WHERE client_code = 'cli1'),
  1000::NUMERIC, 'Carteira: cliente recorrente com a média dos 3 últimos meses');
SELECT is((SELECT (SELECT SUM(v) FROM unnest(contracted) v) FROM revenue_portfolio(pg_temp.id('versao'), pg_temp.id('educacao'))
           WHERE client_code = 'cli2'),
  900::NUMERIC, 'Carteira: títulos a receber no ano do plano entram como já contratados');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM omie_revenue_summary(2026) WHERE unit_id IS DISTINCT FROM pg_temp.id('educacao')), 0,
  'Líder vê só a receita das suas unidades');
SELECT throws_ok($$ SELECT * FROM revenue_portfolio(pg_temp.id('versao'), pg_temp.id('agencia')) $$,
  'P0001', 'Você não vê a carteira desta unidade.', 'Líder não vê a carteira de outra unidade');

SELECT * FROM finish();
ROLLBACK;
