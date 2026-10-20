-- O líder lança linhas e eventos novos; alterar ou excluir o que já foi lançado é do financeiro.
BEGIN;
SELECT plan(16);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- ───────────── Líder lança ─────────────
SELECT pg_temp.login('lid');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'),
    'Contrato A', NULL, NULL, pg_temp.rt('Recorrente 6 meses'),
    '[{"month": 3, "amount": 5000}, {"month": 4, "amount": 5000}]'::JSONB)
$$, 'Líder lança uma receita nova já com os meses');
SELECT is((SELECT count(*)::INT FROM plan_values v JOIN plan_lines l ON l.id = v.line_id WHERE l.description = 'Contrato A'), 2,
  'Os dois meses foram gravados');
SELECT lives_ok($$
  SELECT launch_event(pg_temp.id('versao'), pg_temp.id('consultoria'), NULL, pg_temp.rt('Educação'), 'Workshop', 5,
    20, 500, 100, 2000, pg_temp.acc('Receita de educação'), pg_temp.acc('Despesas de produtos'))
$$, 'Líder lança um evento novo');
SELECT throws_ok($$
  SELECT launch_event(pg_temp.id('versao'), pg_temp.id('agencia'), NULL, pg_temp.rt('Educação'), 'Evento alheio', 5,
    1, 1, 0, 0, pg_temp.acc('Receita de educação'), pg_temp.acc('Despesas de produtos'))
$$, 'P0001', NULL, 'Líder não lança evento de outra unidade');

-- ───────────── Líder não escreve direto nem edita ─────────────
SELECT throws_ok($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'direto')
$$, '42501', NULL, 'Líder não grava linha direto na tabela');
UPDATE plan_values SET amount = 1 WHERE amount = 5000;
SELECT is((SELECT count(*)::INT FROM plan_values WHERE amount = 5000), 2, 'Líder não altera valor já lançado');
SELECT throws_ok($$
  INSERT INTO plan_values (line_id, month, amount) SELECT id, 6, 1 FROM plan_lines WHERE description = 'Contrato A'
$$, '42501', NULL, 'Líder não acrescenta mês a uma linha já lançada');
UPDATE plan_lines SET description = 'Renomeada' WHERE description = 'Contrato A';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Contrato A'), 1, 'Líder não edita a linha');
DELETE FROM plan_lines WHERE description = 'Contrato A';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Contrato A'), 1, 'Líder não exclui a linha');
UPDATE events SET price = 1 WHERE name = 'Workshop';
SELECT is((SELECT price FROM events WHERE name = 'Workshop'), 500::NUMERIC, 'Líder não edita o evento');
DELETE FROM events WHERE name = 'Workshop';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop'), 1, 'Líder não exclui o evento');
RESET ROLE;

-- ───────────── Financeiro edita e exclui ─────────────
SELECT pg_temp.login('fin');
UPDATE plan_values SET amount = 6000 WHERE amount = 5000 AND month = 3;
SELECT is((SELECT amount FROM plan_values WHERE amount = 6000), 6000::NUMERIC, 'Financeiro altera o valor lançado');
UPDATE events SET price = 600 WHERE name = 'Workshop';
SELECT is((SELECT price FROM events WHERE name = 'Workshop'), 600::NUMERIC, 'Financeiro edita o evento');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Salários CLT'), 'Folha extra', NULL, NULL, NULL)
$$, 'Financeiro lança folha');
DELETE FROM plan_lines WHERE description = 'Contrato A';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Contrato A'), 0, 'Financeiro exclui a linha');
DELETE FROM events WHERE name = 'Workshop';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop'), 0, 'Financeiro exclui o evento');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
