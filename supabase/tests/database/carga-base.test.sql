-- Base de despesas de 2027 a partir do realizado de 2026 e contas únicas por nome e tipo.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('adm', (SELECT id FROM units WHERE name = 'ADM')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.line(_c TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM dre_lines WHERE code = _c $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('agencia'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
-- Total gerado de uma conta numa unidade
CREATE FUNCTION pg_temp.base(_acc TEXT, _unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(v.amount), 0) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id JOIN accounts a ON a.id = l.account_id
  WHERE l.origin = 'gerada' AND a.name = _acc AND l.unit_id = pg_temp.id(_unit)
$$;
GRANT EXECUTE ON FUNCTION pg_temp.base(TEXT, TEXT) TO authenticated;

INSERT INTO accounts (name, kind, treatment, dre_line_id, base_name, period) VALUES
  ('CUPOLA Summit - 2027', 'despesa', 'lancavel', pg_temp.line('despesas_produtos'), 'CUPOLA Summit', '2027'),
  ('Marketing e Publicidade', 'despesa', 'lancavel', pg_temp.line('despesas'), 'Marketing e Publicidade', NULL),
  ('Vale Alimentação', 'folha', 'lancavel', pg_temp.line('custos_indiretos'), 'Vale Alimentação', NULL),
  ('ISS', 'despesa', 'calculada', pg_temp.line('impostos'), 'ISS', NULL);

INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('empresa'), 'Empresa Teste');
INSERT INTO omie_categories (company_id, code, name, is_expense) VALUES
  (pg_temp.id('empresa'), 'c1', 'CUPOLA Summit - 2026', true),
  (pg_temp.id('empresa'), 'c2', 'CUPOLA Summit - 2027', true),
  (pg_temp.id('empresa'), 'c3', 'Marketing e Publicidade', true),
  (pg_temp.id('empresa'), 'c4', 'Vale Alimentação', true),
  (pg_temp.id('empresa'), 'c5', 'ISS', true);
INSERT INTO omie_actuals (company_id, year, month, category_code, amount_paid, amount_open) VALUES
  (pg_temp.id('empresa'), 2026, 3, 'c1', 1000, 0),
  (pg_temp.id('empresa'), 2026, 3, 'c2', 500, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c3', 100, 20),
  (pg_temp.id('empresa'), 2026, 1, 'c4', 400, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c5', 999, 0);

SELECT pg_temp.login('fin');
-- Pessoas: 3 na Agência e 1 na Consultoria (benefícios sem unidade seguem as pessoas)
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
SELECT pg_temp.id('versao'), CASE WHEN g <= 3 THEN pg_temp.id('agencia') ELSE pg_temp.id('consultoria') END, 'P' || g,
  (SELECT id FROM contract_types WHERE name = 'CLT'), 1000
FROM generate_series(1, 4) g;

-- ───────────── Conta única por nome e tipo ─────────────
SELECT lives_ok($$
  INSERT INTO accounts (name, kind, treatment, dre_line_id) VALUES ('Marketing e Publicidade', 'receita', 'lancavel', pg_temp.line('receita_bruta'))
$$, 'Receita e despesa podem ter o mesmo nome (como no Omie)');
SELECT throws_ok($$
  INSERT INTO accounts (name, kind, treatment, dre_line_id) VALUES ('Marketing e Publicidade', 'despesa', 'lancavel', pg_temp.line('despesas'))
$$, '23505', NULL, 'O mesmo nome não se repete no mesmo tipo');

-- ───────────── Geração ─────────────
SELECT is((SELECT lines FROM generate_expense_base(pg_temp.id('versao'), 0)), 4,
  'Quatro linhas: Summit (Educação), Marketing (ADM) e Vale Alimentação dividido em duas unidades');
SELECT is(pg_temp.base('CUPOLA Summit - 2027', 'educacao'), 1000::NUMERIC,
  'A edição de 2026 vira a base da conta de 2027; o que já foi pago da edição de 2027 não conta duas vezes');
SELECT is(pg_temp.base('Marketing e Publicidade', 'adm'), 120::NUMERIC, 'Sem unidade vai para a ADM (pago + em aberto)');
SELECT is(pg_temp.base('Vale Alimentação', 'agencia'), 300::NUMERIC, 'Benefício sem unidade segue as pessoas: 3 de 4 na Agência');
SELECT is(pg_temp.base('Vale Alimentação', 'consultoria'), 100::NUMERIC, 'e 1 de 4 na Consultoria');
SELECT is((SELECT count(*)::INT FROM plan_lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = 'ISS'), 0,
  'Imposto calculado pelo app não vira linha');

SELECT generate_expense_base(pg_temp.id('versao'), 0.10, 'media');
SELECT is((SELECT round(v.amount, 2) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id JOIN accounts a ON a.id = l.account_id
           WHERE l.origin = 'gerada' AND a.name = 'CUPOLA Summit - 2027' AND v.month = 7), round(1000 / 12.0 * 1.1, 2),
  'Média dos 12 meses com reajuste de 10%');

-- ───────────── Edição, reajuste geral e nova geração ─────────────
SELECT generate_expense_base(pg_temp.id('versao'), 0);
UPDATE plan_values SET amount = 2000 WHERE month = 3 AND line_id =
  (SELECT l.id FROM plan_lines l JOIN accounts a ON a.id = l.account_id WHERE l.origin = 'gerada' AND a.name = 'CUPOLA Summit - 2027');
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('adm'), (SELECT id FROM accounts WHERE name = 'Marketing e Publicidade' AND kind = 'despesa'), 'manual')
  RETURNING id
)
INSERT INTO plan_values (line_id, month, amount) SELECT id, 1, 50 FROM l;
SELECT adjust_generated_lines(pg_temp.id('versao'), 0.10);
SELECT is(pg_temp.base('CUPOLA Summit - 2027', 'educacao'), 2200::NUMERIC, 'O reajuste geral mantém a edição feita na linha (2.000 × 1,10)');
SELECT is((SELECT SUM(v.amount) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id WHERE l.description = 'manual'), 50::NUMERIC,
  'Linha lançada à mão não é reajustada');
SELECT generate_expense_base(pg_temp.id('versao'), 0);
SELECT is(pg_temp.base('CUPOLA Summit - 2027', 'educacao'), 1000::NUMERIC, 'Gerar de novo refaz só as linhas geradas');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'manual'), 1, 'e mantém as lançadas à mão');

SELECT pg_temp.login('lid');
SELECT throws_ok($$ SELECT generate_expense_base(pg_temp.id('versao'), 0) $$, 'P0001',
  'Somente o financeiro gera a base de despesas.', 'Líder não gera a base');
SELECT * FROM finish();
ROLLBACK;
