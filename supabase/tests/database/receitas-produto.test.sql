-- Receitas por produto: linhas de produto, premissa do lançamento e receita planejada por origem e produto.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT, INSERT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

SELECT pg_temp.login('lid');
SELECT lives_ok($$
  WITH x AS (INSERT INTO product_lines (name, unit_id, format)
    VALUES ('Imersão teste', pg_temp.id('consultoria'), 'presencial') RETURNING id)
  INSERT INTO ids SELECT 'linha', id FROM x
$$, 'Líder cria linha de produto na própria unidade');
SELECT throws_ok($$
  INSERT INTO product_lines (name, unit_id) VALUES ('Outra', pg_temp.id('agencia'))
$$, '42501', NULL, 'Líder não cria linha em outra unidade');
SELECT throws_ok($$
  INSERT INTO product_lines (name, unit_id, format) VALUES ('X', pg_temp.id('consultoria'), 'misto')
$$, '23514', NULL, 'Formato fora da lista é recusado');
SELECT lives_ok($$
  WITH x AS (INSERT INTO products (name, unit_id, kind, price, line_id)
    VALUES ('Imersão Vendas teste', pg_temp.id('consultoria'), 'evento', 1000, pg_temp.id('linha')) RETURNING id)
  INSERT INTO ids SELECT 'produto', id FROM x
$$, 'Líder cadastra produto na linha');

-- Lançamentos: um com produto e premissa, um sem produto
INSERT INTO ids SELECT 'l1', launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'),
  'Turma SP', NULL, pg_temp.id('produto'), NULL, '[{"month": 3, "amount": 30000}]'::JSONB, NULL, 'nova', ' 30 alunos × 1.000 ');
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'),
  'Contrato', NULL, NULL, NULL, '[{"month": 3, "amount": 5000}]'::JSONB, NULL, 'carteira', '');

SELECT is((SELECT note FROM plan_lines WHERE id = pg_temp.id('l1')), '30 alunos × 1.000', 'Premissa gravada sem espaços nas pontas');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE version_id = pg_temp.id('versao') AND description = 'Contrato' AND note IS NULL),
  1, 'Premissa vazia vira nula');
SELECT is(
  (SELECT amount FROM revenue_by_product(pg_temp.id('versao'), ARRAY[pg_temp.id('consultoria')])
   WHERE origin = 'nova' AND product_id = pg_temp.id('produto') AND month = 3),
  30000::NUMERIC, 'Venda nova por produto no mês');
SELECT is(
  (SELECT amount FROM revenue_by_product(pg_temp.id('versao'), ARRAY[pg_temp.id('consultoria')])
   WHERE origin = 'carteira' AND product_id IS NULL AND month = 3),
  5000::NUMERIC, 'Carteira sem produto aparece à parte');

-- Copiar a versão leva a premissa
RESET ROLE;
SELECT pg_temp.login('fin');
INSERT INTO ids SELECT 'copia', copy_version(pg_temp.id('versao'), 'Cópia teste', 2027);
SELECT is((SELECT note FROM plan_lines WHERE version_id = pg_temp.id('copia') AND description = 'Turma SP'),
  '30 alunos × 1.000', 'A cópia da versão mantém a premissa');

SELECT * FROM finish();
ROLLBACK;
