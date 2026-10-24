-- Folha por pessoa: a remuneração é uma linha editável do plano; importação idempotente pelo ID.
BEGIN;
SELECT plan(26);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT, INSERT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
-- Soma da remuneração e headcount de um mês, vistos pelo cálculo da DRE
CREATE FUNCTION pg_temp.base(_kind TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM plan_base_rows(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
  WHERE row_kind = _kind AND month = _month
$$;
GRANT EXECUTE ON FUNCTION pg_temp.base(TEXT, INT) TO authenticated;

SELECT pg_temp.login('fin');

-- ───────────── Cadastro: a pessoa já nasce com a linha ─────────────
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary, start_month)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000, 3);

SELECT is((SELECT count(*)::INT FROM plan_lines WHERE person_id = (SELECT id FROM people WHERE name = 'Ana')), 1,
  'Cadastrar a pessoa cria a linha de remuneração');
SELECT is((SELECT count(*)::INT FROM plan_values v JOIN plan_lines l ON l.id = v.line_id
  JOIN people p ON p.id = l.person_id WHERE p.name = 'Ana'), 10, 'Meses de entrada até dezembro');
SELECT is(pg_temp.base('salario', 2), 0::NUMERIC, 'Antes da entrada não há remuneração');
SELECT is(pg_temp.base('salario', 3), 5000::NUMERIC, 'A remuneração vem da linha da pessoa');
SELECT is(pg_temp.base('headcount', 3), 1::NUMERIC, 'Headcount nos meses com remuneração');
SELECT is(pg_temp.base('headcount', 2), 0::NUMERIC, 'Sem remuneração, sem headcount');

-- ───────────── A célula é editável, como em receitas ─────────────
UPDATE plan_values SET amount = 6500
WHERE month = 4 AND line_id = (SELECT l.id FROM plan_lines l JOIN people p ON p.id = l.person_id WHERE p.name = 'Ana');
SELECT is(pg_temp.base('salario', 4), 6500::NUMERIC, 'Editar um mês muda o custo daquele mês');
SELECT is(pg_temp.base('salario', 5), 5000::NUMERIC, 'Os outros meses ficam como estavam');
UPDATE plan_values SET amount = 0
WHERE month = 6 AND line_id = (SELECT l.id FROM plan_lines l JOIN people p ON p.id = l.person_id WHERE p.name = 'Ana');
SELECT is(pg_temp.base('headcount', 6), 0::NUMERIC, 'Mês zerado (férias, licença) sai do headcount');

-- ───────────── Regras da linha ─────────────
SELECT throws_ok($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, person_id)
  VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Aluguel e condomínio'),
    (SELECT id FROM people WHERE name = 'Ana'))
$$, 'P0001', 'A remuneração de uma pessoa é uma linha de folha.', 'Linha de pessoa precisa ser de folha');
SELECT throws_ok($$
  INSERT INTO plan_lines (version_id, unit_id, account_id, person_id)
  VALUES (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.acc('Salários CLT'),
    (SELECT id FROM people WHERE name = 'Ana'))
$$, 'P0001', 'A linha precisa estar na mesma unidade e versão da pessoa.', 'Linha na unidade da pessoa');

UPDATE people SET contract_type_id = pg_temp.ct('Sócio (pró-labore)') WHERE name = 'Ana';
SELECT is((SELECT a.name FROM plan_lines l JOIN accounts a ON a.id = l.account_id JOIN people p ON p.id = l.person_id
  WHERE p.name = 'Ana'), 'Pró-labore', 'Trocar o vínculo leva a linha para a conta do novo vínculo');
UPDATE people SET contract_type_id = pg_temp.ct('CLT') WHERE name = 'Ana';

-- ───────────── Importação ─────────────
CREATE FUNCTION pg_temp.rows() RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('external_id', '101', 'unit_id', pg_temp.id('consultoria'), 'role_title', 'Analista',
      'contract_type_id', pg_temp.ct('CLT'), 'salary', 4000, 'hire_date', '2027-05-10'),
    jsonb_build_object('external_id', '102', 'unit_id', pg_temp.id('consultoria'), 'name', 'Bia',
      'contract_type_id', pg_temp.ct('CLT'), 'salary', 3000, 'hire_date', '2020-01-01'))
$$;
GRANT EXECUTE ON FUNCTION pg_temp.rows() TO authenticated;

SELECT is(import_people(pg_temp.id('versao'), pg_temp.rows()), '{"created": 2, "updated": 0}'::JSONB, 'Importa duas pessoas');
SELECT is((SELECT name FROM people WHERE external_id = '101'), 'ID 101', 'Sem nome na planilha, o ID identifica a pessoa');
SELECT is((SELECT start_month FROM people WHERE external_id = '101'), 5, 'Admissão no ano da versão define o mês de entrada');
SELECT is((SELECT start_month FROM people WHERE external_id = '102'), NULL::INT, 'Admissão antiga: já está no início do ano');
SELECT is(pg_temp.base('salario', 4), 6500 + 3000::NUMERIC, 'Abril: Ana editada + Bia (101 entra em maio)');
SELECT is(pg_temp.base('salario', 5), 5000 + 3000 + 4000::NUMERIC, 'Maio: a pessoa 101 entra');

UPDATE plan_values SET amount = 3300
WHERE month = 8 AND line_id = (SELECT l.id FROM plan_lines l JOIN people p ON p.id = l.person_id WHERE p.external_id = '102');
SELECT is(import_people(pg_temp.id('versao'), pg_temp.rows()), '{"created": 0, "updated": 2}'::JSONB, 'Repetir a importação não duplica');
SELECT is(pg_temp.base('salario', 8), 5000 + 3300 + 4000::NUMERIC, 'Reimportar sem sobrescrever mantém os meses editados');
SELECT import_people(pg_temp.id('versao'), pg_temp.rows(), true);

SELECT is(pg_temp.base('salario', 8), 5000 + 3000 + 4000::NUMERIC, 'Sobrescrever refaz os meses a partir do salário');

-- ───────────── Copiar versão ─────────────
INSERT INTO ids VALUES ('copia', copy_version(pg_temp.id('versao'), 'Cópia', 2028));
SELECT is((SELECT SUM(v.amount) FROM plan_values v JOIN plan_lines l ON l.id = v.line_id
  WHERE l.version_id = pg_temp.id('copia') AND l.person_id IS NOT NULL),
  (SELECT SUM(v.amount) FROM plan_values v JOIN plan_lines l ON l.id = v.line_id
   WHERE l.version_id = pg_temp.id('versao') AND l.person_id IS NOT NULL),
  'A cópia leva as linhas de pessoas com os mesmos valores');
SELECT is((SELECT count(*)::INT FROM people WHERE version_id = pg_temp.id('copia')), 3, 'A cópia leva as pessoas');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE version_id = pg_temp.id('copia') AND person_id IS NOT NULL), 3,
  'Cada pessoa copiada tem uma única linha');

-- ───────────── Perfis ─────────────
DELETE FROM people WHERE name = 'Ana';
SELECT is((SELECT count(*)::INT FROM plan_lines l WHERE l.description = 'Ana'), 0, 'Excluir a pessoa remove a linha');

SELECT pg_temp.login('lid');
SELECT throws_ok($$ SELECT import_people(pg_temp.id('versao'), pg_temp.rows()) $$, 'P0001',
  'Somente o financeiro importa a folha.', 'Líder não importa folha');

SELECT * FROM finish();
ROLLBACK;
