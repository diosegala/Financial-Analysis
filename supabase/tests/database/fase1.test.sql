-- Testes do modelo da Fase 1: cálculo da DRE, cenários, acesso por perfil e travas.
-- Rodar com: supabase test db
BEGIN;
SELECT plan(32);

-- ───────────── Fixtures (como postgres, sem RLS) ─────────────
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('vp', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista')),
  ('conservador', (SELECT id FROM scenarios WHERE name = 'Conservador')),
  ('produto', gen_random_uuid());

CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.pd(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM parameter_definitions WHERE key = _k $$;
CREATE FUNCTION pg_temp.line(_c TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM dre_lines WHERE code = _c $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste'), (pg_temp.id('vp'), 'vp@teste');
INSERT INTO user_roles (user_id, role) VALUES
  (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider'), (pg_temp.id('vp'), 'vp');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

INSERT INTO products (id, name, unit_id, revenue_type_id)
VALUES (pg_temp.id('produto'), 'Programa X', pg_temp.id('consultoria'), pg_temp.rt('Recorrente 12 meses'));

INSERT INTO parameter_values (definition_id, value, valid_from, unit_id, product_id, contract_type_id) VALUES
  (pg_temp.pd('pis'), 0.0165, '2027-01-01', NULL, NULL, NULL),
  (pg_temp.pd('cofins'), 0.076, '2027-01-01', NULL, NULL, NULL),
  (pg_temp.pd('comissao_comercial'), 0.10, '2027-01-01', NULL, NULL, NULL),
  (pg_temp.pd('comissao_comercial'), 0.05, '2027-01-01', pg_temp.id('consultoria'), pg_temp.id('produto'), NULL),
  (pg_temp.pd('comissao_parceiro'), 0.20, '2027-01-01', NULL, NULL, NULL),
  (pg_temp.pd('encargos'), 0.30, '2027-01-01', NULL, NULL, pg_temp.ct('CLT')),
  (pg_temp.pd('encargos'), 0.32, '2027-07-01', NULL, NULL, pg_temp.ct('CLT')),
  (pg_temp.pd('beneficios_por_pessoa'), 500, '2027-01-01', NULL, NULL, NULL);

-- Receitas de Consultoria em janeiro: 10.000 (produto com comissão específica), 2.000 variável, 1.000 parceiros.
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, product_id, revenue_type_id, description)
  VALUES
    (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), pg_temp.id('produto'), pg_temp.rt('Recorrente 12 meses'), 'a'),
    (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), NULL, pg_temp.rt('Variável (até 3 meses)'), 'b'),
    (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), NULL, pg_temp.rt('Parceiros'), 'c'),
    (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Aluguel e condomínio'), NULL, NULL, 'd'),
    (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.acc('Receita de serviços'), NULL, pg_temp.rt('Variável (até 3 meses)'), 'e')
  RETURNING id, description
)
INSERT INTO plan_values (line_id, month, amount)
SELECT id, 1, CASE description WHEN 'a' THEN 10000 WHEN 'b' THEN 2000 WHEN 'c' THEN 1000 WHEN 'd' THEN 3000 ELSE 999 END FROM l;

-- Uma pessoa CLT: 5.000, reajuste para 6.000 a partir de julho.
WITH p AS (
  INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000) RETURNING id
)
INSERT INTO salary_changes (person_id, month, new_salary) SELECT id, 7, 6000 FROM p;

CREATE FUNCTION pg_temp.dre(_scenario TEXT, _code TEXT, _month INT, _units UUID[] DEFAULT NULL) RETURNS NUMERIC
LANGUAGE sql AS $$
  SELECT ROUND(amount, 4) FROM dre_report(pg_temp.id('versao'), pg_temp.id(_scenario), _units)
  WHERE dre_line_id = pg_temp.line(_code) AND month = _month
$$;
GRANT EXECUTE ON FUNCTION pg_temp.dre(TEXT, TEXT, INT, UUID[]) TO authenticated;
CREATE FUNCTION pg_temp.consultoria() RETURNS UUID[] LANGUAGE sql AS $$ SELECT ARRAY[pg_temp.id('consultoria')] $$;

-- ───────────── Cálculo da DRE ─────────────
SELECT is(pg_temp.dre('realista', 'receita_bruta', 1, pg_temp.consultoria()), 13000.0000, 'Receita bruta de janeiro');
SELECT is(pg_temp.dre('realista', 'impostos', 1, pg_temp.consultoria()), 1202.5000, 'PIS + COFINS = 9,25% da receita');
SELECT is(pg_temp.dre('realista', 'comissionamento', 1, pg_temp.consultoria()), 900.0000,
  'Comissão: 5% no produto específico da unidade, 10% no resto, 20% em parceiros');
SELECT is(pg_temp.dre('realista', 'custos_indiretos', 1, pg_temp.consultoria()), 7000.0000,
  'Folha de janeiro: 5.000 + 30% de encargos + 500 de benefícios');
SELECT is(pg_temp.dre('realista', 'custos_indiretos', 6, pg_temp.consultoria()), 7000.0000, 'Junho mantém salário e encargos');
SELECT is(pg_temp.dre('realista', 'custos_indiretos', 7, pg_temp.consultoria()), 8420.0000,
  'Julho: reajuste para 6.000 e encargos de 32% a partir do mês');
SELECT is(pg_temp.dre('realista', 'despesas', 1, pg_temp.consultoria()), 3000.0000, 'Despesas de janeiro');
SELECT is(pg_temp.dre('realista', 'contribuicao_liquida', 1, pg_temp.consultoria()), 897.5000, 'Contribuição líquida de janeiro');
SELECT is(pg_temp.dre('realista', 'mcl', 1, pg_temp.consultoria()), ROUND(897.5 / 13000, 4), '%MCL de janeiro');
SELECT is(pg_temp.dre('realista', 'contribuicao_liquida', 2, pg_temp.consultoria()), -7000.0000,
  'Mês sem receita: contribuição = -folha');
SELECT is(pg_temp.dre('realista', 'custos_indiretos', 0, pg_temp.consultoria()), 6 * 7000 + 6 * 8420.0000,
  'Total do ano soma os 12 meses');
SELECT is(pg_temp.dre('realista', 'receita_bruta', 1), 13999.0000, 'Sem filtro, soma todas as unidades');

-- ───────────── Cenários ─────────────
UPDATE scenarios SET revenue_variation = -0.1, expense_variation = 0.1 WHERE id = pg_temp.id('conservador');
SELECT is(pg_temp.dre('conservador', 'receita_bruta', 1, pg_temp.consultoria()), 11700.0000, 'Conservador: receita -10%');
SELECT is(pg_temp.dre('conservador', 'despesas', 1, pg_temp.consultoria()), 3300.0000, 'Conservador: despesas +10%');
SELECT is(pg_temp.dre('conservador', 'custos_indiretos', 1, pg_temp.consultoria()), 7000.0000,
  'D3: a variação de despesa não afeta a folha por padrão');
UPDATE scenarios SET applies_to_payroll = true WHERE id = pg_temp.id('conservador');
SELECT is(pg_temp.dre('conservador', 'custos_indiretos', 1, pg_temp.consultoria()), 7650.0000,
  'Com a opção ligada, a folha também varia (benefício por pessoa não)');

-- ───────────── Acesso por perfil ─────────────
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

SELECT pg_temp.login('lid');
SELECT is(pg_temp.dre('realista', 'receita_bruta', 1), 13000.0000, 'Líder: a DRE só soma as unidades dele');
SELECT is((SELECT count(*)::INT FROM profiles), 1, 'D6: líder só vê o próprio perfil');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'lider ok', NULL, NULL, NULL,
    '[{"month": 1, "amount": 100}]'::JSONB)
$$, 'Líder lança despesa na própria unidade');
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.acc('Marketing'), 'x', NULL, NULL, NULL)
$$, 'P0001', NULL, 'Líder não lança em outra unidade');
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Rescisões'), 'x', NULL, NULL, NULL)
$$, 'P0001', NULL, 'Líder não lança folha');
SELECT throws_ok($$ SELECT set_official_scenario(pg_temp.id('conservador')) $$, 'P0001', NULL,
  'Líder não define o cenário oficial');

-- Envio trava a unidade para o líder
SELECT lives_ok($$ SELECT set_unit_status(pg_temp.id('versao'), pg_temp.id('consultoria'), 'enviado') $$,
  'Líder envia a unidade');
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'depois do envio', NULL, NULL, NULL)
$$, 'P0001', NULL, 'Depois de enviar, o líder não lança mais');
RESET ROLE;

SELECT pg_temp.login('vp');
SELECT throws_ok($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.acc('Marketing'), 'x')
$$, '42501', NULL, 'D4: VP só lê');
SELECT is(pg_temp.dre('realista', 'receita_bruta', 1), 13999.0000, 'VP vê todas as unidades');
RESET ROLE;

SELECT pg_temp.login('fin');
SELECT lives_ok($$ SELECT set_unit_status(pg_temp.id('versao'), pg_temp.id('consultoria'), 'devolvido', 'Revisar') $$,
  'Financeiro devolve a unidade');
SELECT lives_ok($$ SELECT set_official_scenario(pg_temp.id('conservador')) $$, 'Financeiro troca o cenário oficial');
SELECT is((SELECT array_agg(name) FROM scenarios WHERE is_official), ARRAY['Conservador'], 'Só um cenário oficial');
RESET ROLE;

SELECT pg_temp.login('lid');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'depois da devolução', NULL, NULL, NULL)
$$, 'Unidade devolvida volta a aceitar lançamentos novos do líder');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'depois da devolução'), 1, 'A linha nova existe');
RESET ROLE;

-- ───────────── Último financeiro ─────────────
SELECT throws_ok($$ DELETE FROM user_roles WHERE role = 'financeiro' $$, 'P0001', NULL,
  'Não é possível remover o último financeiro');

SELECT * FROM finish();
ROLLBACK;
