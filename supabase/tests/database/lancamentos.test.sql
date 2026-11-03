-- O diretor responde pela unidade: lança, altera e exclui linhas dela até enviar. Eventos seguem só com o financeiro.
BEGIN;
SELECT plan(20);

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
  SELECT launch_event(pg_temp.id('versao'), pg_temp.id('consultoria'), NULL, 'Workshop', 5,
    ('[{"account_id": "' || pg_temp.acc('Receita de educação') || '", "description": "Ingressos",
        "revenue_type_id": "' || pg_temp.rt('Educação') || '", "values": [{"month": 5, "amount": 10000}]}]')::JSONB)
$$, 'Líder lança um evento novo, já com um item');
SELECT throws_ok($$
  SELECT launch_event(pg_temp.id('versao'), pg_temp.id('agencia'), NULL, 'Evento alheio', 5)
$$, 'P0001', NULL, 'Líder não lança evento de outra unidade');

-- ───────────── Diretor edita tudo da própria unidade, e só dela ─────────────
SELECT lives_ok($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'direto')
$$, 'Diretor grava linha da própria unidade');
UPDATE plan_values SET amount = 7000 WHERE amount = 5000 AND month = 4;
SELECT is((SELECT count(*)::INT FROM plan_values WHERE amount = 7000), 1, 'Diretor altera valor já lançado');
SELECT lives_ok($$
  INSERT INTO plan_values (line_id, month, amount) SELECT id, 6, 1 FROM plan_lines WHERE description = 'Contrato A'
$$, 'Diretor acrescenta mês a uma linha');
UPDATE plan_lines SET description = 'Renomeada' WHERE description = 'direto';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Renomeada'), 1, 'Diretor edita a linha');
DELETE FROM plan_lines WHERE description = 'Renomeada';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Renomeada'), 0, 'Diretor exclui a linha');
-- Pessoas: edita na própria unidade, não em outra; depois de enviar, a unidade trava.
SELECT lives_ok($$
  INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Pessoa da unidade', (SELECT id FROM contract_types WHERE name = 'CLT'), 1000)
$$, 'Diretor adiciona pessoa na própria unidade');
SELECT throws_ok($$
  INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
  VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), 'Pessoa de fora', (SELECT id FROM contract_types WHERE name = 'CLT'), 1000)
$$, '42501', NULL, 'Diretor não adiciona pessoa em outra unidade');
SELECT lives_ok($$ SELECT set_unit_status(pg_temp.id('versao'), pg_temp.id('consultoria'), 'enviado') $$, 'Diretor envia');
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Marketing'), 'tarde', NULL, NULL, NULL)
$$, 'P0001', NULL, 'Depois de enviar, o diretor não lança');
RESET ROLE;
SELECT pg_temp.login('fin');
SELECT set_unit_status(pg_temp.id('versao'), pg_temp.id('consultoria'), 'rascunho');
RESET ROLE;
SELECT pg_temp.login('lid');
UPDATE events SET name = 'Renomeado' WHERE name = 'Workshop';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop'), 1, 'Líder não edita o evento');
DELETE FROM events WHERE name = 'Workshop';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop'), 1, 'Líder não exclui o evento');
RESET ROLE;

-- ───────────── Financeiro edita e exclui ─────────────
SELECT pg_temp.login('fin');
UPDATE plan_values SET amount = 6000 WHERE amount = 5000 AND month = 3;
SELECT is((SELECT amount FROM plan_values WHERE amount = 6000), 6000::NUMERIC, 'Financeiro altera o valor lançado');
UPDATE events SET name = 'Workshop 2' WHERE name = 'Workshop';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop 2'), 1, 'Financeiro edita o evento');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Salários CLT'), 'Folha extra', NULL, NULL, NULL)
$$, 'Financeiro lança folha');
DELETE FROM plan_lines WHERE description = 'Contrato A';
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Contrato A'), 0, 'Financeiro exclui a linha');
DELETE FROM events WHERE name = 'Workshop 2';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Workshop 2'), 0, 'Financeiro exclui o evento');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
