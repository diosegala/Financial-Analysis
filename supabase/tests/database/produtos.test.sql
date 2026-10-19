-- Produtos com preço e prazo, e cadastro de clientes pelo líder.
BEGIN;
SELECT plan(13);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('vp', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES
  (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste'), (pg_temp.id('vp'), 'vp@teste');
INSERT INTO user_roles (user_id, role) VALUES
  (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider'), (pg_temp.id('vp'), 'vp');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- ───────────── Financeiro cadastra ─────────────
SELECT pg_temp.login('fin');
SELECT lives_ok($$
  INSERT INTO products (name, unit_id, kind, price, price_model, duration_months)
  VALUES ('Diagnóstico', pg_temp.id('consultoria'), 'servico', 5000, 'mensal', 6)
$$, 'Financeiro cadastra serviço com preço e prazo');
SELECT lives_ok($$
  INSERT INTO products (name, unit_id, kind, price, default_seats, cost_per_participant, fixed_cost)
  VALUES ('Treinamento X', pg_temp.id('educacao'), 'evento', 500, 20, 100, 2000)
$$, 'Financeiro cadastra evento com vagas e custos');
SELECT lives_ok($$
  INSERT INTO products (name, unit_id, kind) VALUES ('Diagnóstico', pg_temp.id('educacao'), 'servico')
$$, 'O mesmo nome pode existir em outra unidade');
SELECT throws_ok($$
  INSERT INTO products (name, unit_id, kind) VALUES ('DIAGNÓSTICO', pg_temp.id('consultoria'), 'servico')
$$, '23505', NULL, 'Mas não duas vezes na mesma unidade, mesmo com maiúsculas diferentes');
SELECT throws_ok($$
  INSERT INTO products (name, kind, price_model) VALUES ('Evento com cobrança', 'evento', 'total')
$$, '23514', NULL, 'Evento não tem forma de cobrança');
SELECT throws_ok($$
  INSERT INTO products (name, kind, price) VALUES ('Preço negativo', 'servico', -1)
$$, '23514', NULL, 'Preço negativo é recusado');
SELECT throws_ok($$
  INSERT INTO products (name, kind, duration_months) VALUES ('Prazo zero', 'servico', 0)
$$, '23514', NULL, 'Prazo zero é recusado');
RESET ROLE;

-- ───────────── Líder: só lê produtos e cria clientes ─────────────
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM products WHERE name = 'Diagnóstico'), 2, 'Líder lê o catálogo');
SELECT throws_ok($$
  INSERT INTO products (name, kind) VALUES ('Produto do líder', 'servico')
$$, '42501', NULL, 'Líder não cadastra produto');
SELECT lives_ok($$ INSERT INTO clients (name) VALUES ('Cliente Novo') $$, 'Líder cadastra cliente na hora de lançar');
UPDATE clients SET name = 'Renomeado' WHERE name = 'Cliente Novo';
SELECT is((SELECT count(*)::INT FROM clients WHERE name = 'Cliente Novo'), 1, 'Líder não renomeia cliente');
DELETE FROM clients WHERE name = 'Cliente Novo';
SELECT is((SELECT count(*)::INT FROM clients WHERE name = 'Cliente Novo'), 1, 'Líder não exclui cliente');
RESET ROLE;

-- ───────────── VP só lê ─────────────
SELECT pg_temp.login('vp');
SELECT throws_ok($$ INSERT INTO clients (name) VALUES ('Cliente do VP') $$, '42501', NULL, 'VP não cadastra cliente');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
