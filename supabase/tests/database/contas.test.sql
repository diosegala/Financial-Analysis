-- Categorias do Omie como contas: tratamento (lançável, calculada, fora da DRE), grupo e período.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.line(_c TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM dre_lines WHERE code = _c $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

SELECT pg_temp.login('fin');

-- ───────────── Tratamento da conta ─────────────
SELECT lives_ok($$
  INSERT INTO accounts (name, kind, treatment, group_name, period, base_name)
  VALUES ('Transferência entre contas - 2027', 'despesa', 'fora_dre', NULL, '2027', 'Transferência entre contas')
$$, 'Conta fora da DRE não precisa de linha da DRE');
SELECT throws_ok($$
  INSERT INTO accounts (name, kind, treatment) VALUES ('Sem linha', 'despesa', 'lancavel')
$$, '23514', NULL, 'Conta lançável precisa de linha da DRE');
SELECT lives_ok($$
  INSERT INTO accounts (name, kind, treatment, dre_line_id) VALUES ('ISS sobre serviços', 'despesa', 'calculada', pg_temp.line('impostos'))
$$, 'Conta calculada pelo app tem linha da DRE');
SELECT lives_ok($$
  INSERT INTO accounts (name, kind, treatment, dre_line_id, group_name, period, base_name)
  VALUES ('CUPOLA Summit Ingressos - 2027', 'receita', 'lancavel', pg_temp.line('receita_bruta'), 'Summit', '2027', 'CUPOLA Summit Ingressos')
$$, 'Conta lançável com grupo e período');

-- ───────────── Só conta lançável entra numa grade ─────────────
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('CUPOLA Summit Ingressos - 2027'), 'Lote 1',
    NULL, NULL, pg_temp.rt('Ingressos'), '[{"month": 3, "amount": 1000}]'::JSONB)
$$, 'Conta lançável aceita lançamento');
SELECT throws_like($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('ISS sobre serviços'), 'x', NULL, NULL, NULL)
$$, '%calculada pelo app%', 'Conta calculada pelo app não pode ser lançada');
SELECT throws_like($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Transferência entre contas - 2027'), 'x', NULL, NULL, NULL)
$$, '%fora da DRE%', 'Conta fora da DRE não pode ser lançada');
SELECT throws_like($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('ISS sobre serviços'), 'direto')
$$, '%calculada pelo app%', 'Nem gravando direto na tabela (financeiro)');

-- ───────────── Contas em uso ─────────────
SELECT is((SELECT count(*)::INT FROM accounts_in_use() u WHERE u = pg_temp.acc('CUPOLA Summit Ingressos - 2027')), 1,
  'Conta com lançamento aparece como em uso');
SELECT is((SELECT count(*)::INT FROM accounts_in_use() u WHERE u = pg_temp.acc('ISS sobre serviços')), 0,
  'Conta sem uso não aparece');

-- ───────────── Regras da importação ─────────────
SELECT cmp_ok((SELECT count(*)::INT FROM account_treatment_rules), '>=', 12, 'As regras de tratamento já vêm cadastradas');
SELECT throws_ok($$
  INSERT INTO account_treatment_rules (keyword, treatment) VALUES ('iss', 'calculada')
$$, '23505', NULL, 'A mesma palavra não se repete, nem com maiúscula diferente');
UPDATE units SET name_keywords = ARRAY['Summit'] WHERE name = 'Educação';
RESET ROLE;

-- ───────────── Líder só lê ─────────────
SELECT pg_temp.login('lid');
SELECT throws_ok($$
  INSERT INTO account_group_rules (keyword, group_name) VALUES ('Outro', 'Outro')
$$, '42501', NULL, 'Líder não cria regra de grupo');
SELECT is((SELECT count(*)::INT FROM accounts_in_use()), 0, 'Líder não enxerga quais contas estão em uso');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
