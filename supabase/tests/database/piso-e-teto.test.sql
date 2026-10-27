-- Piso e teto: contrato por unidade, despesa condicionada fora da trava, quem vê e quem altera.
BEGIN;
SELECT plan(16);

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
  ('despesa', (SELECT id FROM accounts WHERE kind = 'despesa' ORDER BY sort_order LIMIT 1));
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

SELECT pg_temp.login('fin');
SELECT guardrails_suggest(pg_temp.id('cenario'));
SELECT is((SELECT floor_actual + floor_projected FROM guardrail_units
           WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia')), 12000::NUMERIC,
  'Sugestão do piso: realizado do ano base + projeção dos meses que faltam');
SELECT is((SELECT unassigned_revenue FROM guardrail_settings WHERE scenario_id = pg_temp.id('cenario')), 12000::NUMERIC,
  'Receita do Omie sem unidade fica à parte, para o financeiro distribuir');
UPDATE guardrail_settings SET result_target = 100, support_cut_pct = 0.1 WHERE scenario_id = pg_temp.id('cenario');
DELETE FROM guardrail_units WHERE scenario_id = pg_temp.id('cenario');
INSERT INTO guardrail_units (scenario_id, unit_id, floor_amount) VALUES
  (pg_temp.id('cenario'), pg_temp.id('agencia'), 1000),
  (pg_temp.id('cenario'), pg_temp.id('consultoria'), 1000),
  (pg_temp.id('cenario'), pg_temp.id('educacao'), 2000);
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('rh'), pg_temp.id('despesa'), 'apoio', NULL, NULL, NULL,
  '[{"month": 1, "amount": 300}]'::JSONB);
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('despesa'), 'fixa', NULL, NULL, NULL,
  '[{"month": 1, "amount": 200}]'::JSONB);
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('despesa'), 'contratação', NULL, NULL, NULL,
  '[{"month": 6, "amount": 50}]'::JSONB, NULL, NULL, NULL, true, 'se o realizado passar do piso em 10%');

SELECT is((SELECT ceiling FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('rh')), 270::NUMERIC,
  'Teto da área de apoio = despesa lançada menos o corte sugerido');
SELECT is((SELECT round(contribution, 2) FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('educacao')),
  185::NUMERIC, 'Contribuição = (resultado alvo + tetos do apoio) × participação no piso');
SELECT is((SELECT round(ceiling, 2) FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')),
  907.5::NUMERIC, 'Teto da unidade = piso líquido − contribuição');
SELECT is((SELECT round(SUM(floor_net - ceiling) FILTER (WHERE kind = 'negocio') - SUM(ceiling) FILTER (WHERE kind <> 'negocio'), 2)
           FROM guardrails(pg_temp.id('cenario'))), 100::NUMERIC, 'Os tetos fecham com o resultado alvo');
SELECT is((SELECT planned_expense FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 200::NUMERIC,
  'Despesa condicionada fica fora da despesa da trava');
SELECT is((SELECT conditional_expense FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 50::NUMERIC,
  'Despesa condicionada aparece separada');

UPDATE guardrail_settings SET distribution = 'manual' WHERE scenario_id = pg_temp.id('cenario');
UPDATE guardrail_units SET manual_share = CASE WHEN unit_id = pg_temp.id('agencia') THEN 1 ELSE 0 END
WHERE scenario_id = pg_temp.id('cenario');
SELECT is((SELECT round(contribution, 2) FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')),
  370::NUMERIC, 'Divisão manual: a Agência leva toda a contribuição');

SELECT throws_ok($$ SELECT launch_line(pg_temp.id('versao'), pg_temp.id('agencia'),
  (SELECT id FROM accounts WHERE kind = 'receita' LIMIT 1), 'r', NULL, NULL, NULL, '[]'::JSONB, NULL, 'nova', NULL, true, 'x');
  SELECT set_line_condition((SELECT id FROM plan_lines WHERE description = 'r'), true) $$,
  'P0001', 'Só despesas podem ser condicionadas.', 'Receita não é condicionada');

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
SELECT lives_ok($$ SELECT set_line_condition((SELECT id FROM plan_lines WHERE description = 'fixa'), true, 'só com o piso batido') $$,
  'Líder marca uma despesa da unidade como condicionada');
SELECT throws_ok($$ SELECT set_line_condition((SELECT id FROM plan_lines WHERE description = 'apoio'), true) $$,
  'P0001', 'Você não altera linhas desta unidade.', 'Líder não mexe na linha de outra unidade');
SELECT throws_ok($$ INSERT INTO guardrail_units (scenario_id, unit_id, floor_amount) VALUES (pg_temp.id('cenario'), pg_temp.id('rh'), 1) $$,
  '42501', NULL, 'Líder não altera o piso nem o teto');

SELECT * FROM finish();
ROLLBACK;
