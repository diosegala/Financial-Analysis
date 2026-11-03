-- Previsto × realizado: realizado por unidade, previsão do ano com remanejamento, plano travado e quem vê.
BEGIN;
SELECT plan(24);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('comp', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id WHERE v.name = 'Orçamento 2027' AND s.is_official)),
  ('mkt', (SELECT id FROM accounts WHERE name = 'Marketing')),
  ('linha', (SELECT dre_line_id FROM accounts WHERE name = 'Marketing'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.cmp(_col TEXT, _month INT) RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE r NUMERIC;
BEGIN
  EXECUTE format('SELECT %I FROM dre_compare($1, $2, ARRAY[$3]) WHERE dre_line_id = $4 AND month = $5', _col)
    INTO r USING pg_temp.id('versao'), pg_temp.id('cenario'), pg_temp.id('consultoria'), pg_temp.id('linha'), _month;
  RETURN r;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- Plano: Marketing da Consultoria a 100 por mês. Realizado de janeiro: 90 (10 ficaram para março).
INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('comp'), 'Empresa Teste');
INSERT INTO omie_categories (company_id, code, name, is_expense, is_revenue) VALUES
  (pg_temp.id('comp'), '2.01', 'Marketing', true, false), (pg_temp.id('comp'), '2.02', 'Salários CLT', true, false);
INSERT INTO omie_suppliers (company_id, code, name) VALUES (pg_temp.id('comp'), 'f1', 'Fornecedor'), (pg_temp.id('comp'), 'p1', 'Ana Silva');
INSERT INTO omie_category_allocations (category_name, unit_id, share) VALUES ('Marketing', pg_temp.id('consultoria'), 1);
INSERT INTO omie_actuals (company_id, year, month, category_code, department_code, supplier_code, item, amount_paid, amount_open) VALUES
  (pg_temp.id('comp'), 2027, 1, '2.01', '', 'f1', '', 90, 0),
  (pg_temp.id('comp'), 2027, 1, '2.02', '', 'p1', '', 500, 0);
SELECT pg_temp.login('fin');
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana Silva', (SELECT id FROM contract_types WHERE name = 'Estagiário (CIEE)'), 500);
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('mkt'), NULL, NULL, NULL, NULL,
  (SELECT jsonb_agg(jsonb_build_object('month', m, 'amount', 100)) FROM generate_series(1, 12) m));
UPDATE budget_versions SET closed_month = 1 WHERE id = pg_temp.id('versao');

SELECT is(pg_temp.cmp('planned', 1), 100::NUMERIC, 'Previsto de janeiro');
SELECT is(pg_temp.cmp('actual', 1), 90::NUMERIC, 'Realizado de janeiro, pela unidade da categoria');
SELECT is(pg_temp.cmp('actual', 2), 0::NUMERIC, 'Mês aberto não mostra realizado');
SELECT is(pg_temp.cmp('forecast', 0), 1190::NUMERIC, 'Previsão do ano: 90 + 11 × 100');
SELECT is((SELECT SUM(amount) FROM actual_rows(pg_temp.id('versao'), pg_temp.id('cenario')) r
           JOIN accounts a ON a.id = r.account_id WHERE a.name = 'Salários CLT' AND r.unit_id = pg_temp.id('consultoria')),
  500::NUMERIC, 'Salário sem unidade segue a pessoa pelo fornecedor');

-- Com o plano travado, remanejar continua possível e o plano não muda.
UPDATE budget_versions SET status = 'travado' WHERE id = pg_temp.id('versao');
SELECT lives_ok($$ INSERT INTO plan_shifts (version_id, unit_id, account_id, from_month, to_month, amount, note)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('mkt'), 1, 3, 10, 'Pagamento adiado') $$, 'Remaneja com o plano travado');
SELECT is(pg_temp.cmp('forecast', 0), 1200::NUMERIC, 'Previsão com remanejamento: 90 + 1.100 + 10');
SELECT is(pg_temp.cmp('planned', 3), 100::NUMERIC, 'O plano de março não muda');
SELECT lives_ok($$ INSERT INTO actual_adjustments (version_id, unit_id, account_id, month, amount, note)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('mkt'), 1, 5, 'Ajuste') $$, 'Financeiro ajusta o realizado');
SELECT is(pg_temp.cmp('actual', 1), 95::NUMERIC, 'Realizado com o ajuste');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM dre_compare(pg_temp.id('versao'), pg_temp.id('cenario'), ARRAY[pg_temp.id('agencia')])), 0,
  'Diretor não vê outra unidade');
SELECT throws_ok($$ INSERT INTO actual_adjustments (version_id, unit_id, account_id, month, amount, note)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('mkt'), 1, 5, 'x') $$, '42501', NULL, 'Diretor não ajusta o realizado');

-- Peso do apoio: RH custa 1.000. Antes de publicar, o diretor não vê; sem receita nem compromisso, divide por igual.
SELECT is((SELECT count(*)::INT FROM support_allocation(pg_temp.id('cenario'))), 0, 'Antes de publicar, o diretor não vê o rateio');
RESET ROLE;
SELECT pg_temp.login('fin');
UPDATE budget_versions SET status = 'em_coleta' WHERE id = pg_temp.id('versao');
SELECT launch_line(pg_temp.id('versao'), (SELECT id FROM units WHERE name = 'RH'), pg_temp.id('mkt'), 'apoio', NULL, NULL, NULL,
  '[{"month": 1, "amount": 1000}]'::JSONB);
INSERT INTO guardrail_settings (scenario_id) VALUES (pg_temp.id('cenario')) ON CONFLICT (scenario_id) DO NOTHING;
INSERT INTO support_shares (scenario_id, unit_id, share) VALUES (pg_temp.id('cenario'), pg_temp.id('consultoria'), 0.6), (pg_temp.id('cenario'), pg_temp.id('agencia'), 0.2);
SELECT is((SELECT round(share, 2) FROM support_allocation(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('consultoria')), 0.75, 'Critério digitado vale mais: 60% de 80% vira 75%');
SELECT ok((SELECT support_cost FROM support_allocation(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('consultoria'))
  = 0.75 * (SELECT SUM(support_cost) FROM support_allocation(pg_temp.id('cenario'))), 'O apoio é dividido na proporção do critério');
SELECT is((SELECT basis FROM support_allocation(pg_temp.id('cenario')) LIMIT 1), 'criterio', 'Mostra qual critério valeu');
SELECT publish_guardrails(pg_temp.id('cenario'));
RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT array_agg(unit_id) FROM support_allocation(pg_temp.id('cenario'))), ARRAY[pg_temp.id('consultoria')], 'Depois de publicar, o diretor vê só a própria unidade');

-- Configuração da IA: diretor não vê nem grava; ninguém logado lê a chave.
SELECT is((SELECT count(*)::INT FROM ai_settings), 0, 'Diretor não vê a configuração da IA');
SELECT throws_ok($$ SELECT set_ai_key('sk-ant-chave-de-teste-123456') $$, 'P0001', 'Somente o financeiro configura a IA.', 'Diretor não grava a chave');
RESET ROLE;
SELECT pg_temp.login('fin');
SELECT throws_ok($$ SELECT set_ai_key('qualquer coisa') $$, 'P0001', 'Esta não parece uma chave da API do Claude.', 'Valor inválido é recusado');
SELECT lives_ok($$ SELECT set_ai_key('sk-ant-chave-de-teste-123456') $$, 'Financeiro grava a chave');
SELECT is((SELECT key_last4 FROM ai_settings), '3456', 'A tela só recebe os 4 últimos caracteres');
SELECT throws_ok($$ SELECT * FROM ai_runtime_config() $$, '42501', NULL, 'Financeiro também não lê a chave pela API');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((SELECT api_key FROM ai_runtime_config()), 'sk-ant-chave-de-teste-123456', 'A função de análise recebe a chave');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
