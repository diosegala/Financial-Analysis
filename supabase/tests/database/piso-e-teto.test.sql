-- Receita-compromisso e limite de custos por unidade, referência do ano base, quem vê e quem altera.
BEGIN;
SELECT plan(21);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('rh', (SELECT id FROM units WHERE name = 'RH')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id
               WHERE v.name = 'Orçamento 2027' AND s.name = 'Realista')),
  ('despesa', (SELECT id FROM accounts WHERE name = 'Marketing'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('agencia'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- Sem impostos nem variação, para a conta ficar redonda.
UPDATE scenarios SET revenue_variation = 0, expense_variation = 0 WHERE id = pg_temp.id('cenario');
INSERT INTO target_unit_shares (scenario_id, unit_id, share, variable_pct_override)
SELECT pg_temp.id('cenario'), id, 0, 0 FROM units WHERE kind = 'negocio';

INSERT INTO omie_companies (id, name) VALUES (gen_random_uuid(), 'Empresa Teste');
INSERT INTO omie_departments (company_id, code, name, structure)
SELECT id, 'd1', 'Agência', '001.001' FROM omie_companies WHERE name = 'Empresa Teste';
INSERT INTO omie_categories (company_id, code, name, is_revenue)
SELECT id, '1.01.02', 'Receitas Fixas', true FROM omie_companies WHERE name = 'Empresa Teste';
INSERT INTO omie_receipts (company_id, year, month, category_code, department_code, client_code, amount_received, amount_open)
SELECT c.id, 2026, m, '1.01.02', dep, 'c1', 1000, 0
FROM omie_companies c CROSS JOIN generate_series(1, 12) m CROSS JOIN (VALUES ('d1'), ('')) d(dep)
WHERE c.name = 'Empresa Teste';

-- Despesa de 1.000 por mês em 2026 (ano fechado), na categoria Marketing, da Agência pelo departamento.
INSERT INTO omie_categories (company_id, code, name, is_expense)
SELECT id, '2.01', 'Marketing', true FROM omie_companies WHERE name = 'Empresa Teste';
INSERT INTO omie_suppliers (company_id, code, name)
SELECT id, 'f1', 'Fornecedor A' FROM omie_companies WHERE name = 'Empresa Teste';
INSERT INTO omie_actuals (company_id, year, month, category_code, department_code, supplier_code, item, amount_paid, amount_open)
SELECT c.id, 2026, m, '2.01', 'd1', 'f1', '', 1000, 0
FROM omie_companies c CROSS JOIN generate_series(1, 12) m WHERE c.name = 'Empresa Teste';
-- Uma pessoa na Agência sem encargos no vínculo: 1.000 por mês.
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), 'Bia', (SELECT id FROM contract_types WHERE name = 'Estagiário (CIEE)'), 1000);

SELECT pg_temp.login('fin');
SELECT guardrails_suggest(pg_temp.id('cenario'));
SELECT is((SELECT floor_actual + floor_projected FROM guardrail_units
           WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia')), 12000::NUMERIC,
  'Sugestão do piso: realizado do ano base + projeção dos meses que faltam');
SELECT is((SELECT unassigned_revenue FROM guardrail_settings WHERE scenario_id = pg_temp.id('cenario')), 12000::NUMERIC,
  'Receita do Omie sem unidade fica à parte, para o financeiro distribuir');
SELECT is((SELECT base_expense FROM guardrail_units WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia')),
  12000::NUMERIC, 'Custo-base: despesas do ano base no Omie');
SELECT is((SELECT base_payroll FROM guardrail_units WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia')),
  12000::NUMERIC, 'Custo-base: custo atual da folha da unidade');
UPDATE guardrail_settings SET cost_cut_pct = 0.1 WHERE scenario_id = pg_temp.id('cenario');
SELECT is((SELECT ceiling FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 21600::NUMERIC,
  'Limite = custo-base menos o corte');
SELECT is((SELECT ceiling_suggested FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('rh')), 0::NUMERIC,
  'Área de apoio segue a mesma regra');
UPDATE guardrail_units SET ceiling_amount = 20000 WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');
SELECT is((SELECT ceiling FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 20000::NUMERIC,
  'Limite digitado vale mais que o calculado');
UPDATE guardrail_units SET ceiling_amount = NULL, floor_amount = 3000 WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');
SELECT is((SELECT floor_amount FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 3000::NUMERIC,
  'Receita-compromisso digitada vale mais que a sugerida');

-- Referência e carga do ano base
SELECT is((SELECT SUM(amount) FROM unit_reference(pg_temp.id('versao'), pg_temp.id('agencia')) WHERE kind = 'despesa'), 12000::NUMERIC,
  'Referência de despesa da unidade');
SELECT is((SELECT array_agg(supplier) FROM unit_reference_suppliers(pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('despesa'))),
  ARRAY['Fornecedor A'], 'Fornecedores do ano base, para consulta');
SELECT is(load_reference(pg_temp.id('versao'), pg_temp.id('agencia')), 1, 'Carrega uma linha por categoria');
SELECT is((SELECT SUM(v.amount) FROM plan_values v JOIN plan_lines l ON l.id = v.line_id
           WHERE l.unit_id = pg_temp.id('agencia') AND l.account_id = pg_temp.id('despesa')), 12000::NUMERIC, 'Com os valores do ano base');
UPDATE plan_values SET amount = 500 WHERE month = 1 AND line_id = (SELECT id FROM plan_lines
  WHERE unit_id = pg_temp.id('agencia') AND account_id = pg_temp.id('despesa'));
SELECT is(load_reference(pg_temp.id('versao'), pg_temp.id('agencia')), 0, 'Carregar de novo não mexe no que já existe');
SELECT is((SELECT planned_expense FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 11500::NUMERIC,
  'Custos lançados da unidade');
SELECT is((SELECT planned_payroll FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 12000::NUMERIC,
  'Folha lançada da unidade');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM guardrails(pg_temp.id('cenario'))), 0, 'Antes de publicar, o líder não vê o contrato');
RESET ROLE;
SELECT pg_temp.login('fin');
SELECT lives_ok($$ SELECT publish_guardrails(pg_temp.id('cenario')) $$, 'Financeiro publica');
RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT array_agg(unit_id) FROM guardrails(pg_temp.id('cenario'))), ARRAY[pg_temp.id('agencia')],
  'Depois de publicar, o líder vê só a unidade dele');
SELECT is((SELECT count(*)::INT FROM unit_reference(pg_temp.id('versao'), pg_temp.id('rh'))), 0,
  'Líder não vê a referência de outra unidade');
SELECT throws_ok($$ SELECT load_reference(pg_temp.id('versao'), pg_temp.id('rh')) $$, 'P0001', 'Você não lança nesta unidade.',
  'Líder não carrega outra unidade');
SELECT throws_ok($$ INSERT INTO guardrail_units (scenario_id, unit_id, floor_amount) VALUES (pg_temp.id('cenario'), pg_temp.id('rh'), 1) $$,
  '42501', NULL, 'Líder não altera a receita-compromisso nem o limite');

SELECT * FROM finish();
ROLLBACK;
