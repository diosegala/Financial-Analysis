-- Benefícios por pessoa: valor mensal nos meses com salário, a base do Omie vira referência, fora dos encargos.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT, INSERT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('saude', gen_random_uuid());
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.person(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM people WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
-- Benefício de uma pessoa num mês, como a DRE vê (linhas de folha sem pessoa)
CREATE FUNCTION pg_temp.ben(_person TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(v.amount), 0) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id
  WHERE l.benefit_person_id = pg_temp.person(_person) AND v.month = _month
$$;
GRANT EXECUTE ON FUNCTION pg_temp.ben(TEXT, INT) TO authenticated;

INSERT INTO accounts (id, name, kind, treatment, dre_line_id, per_person)
SELECT pg_temp.id('saude'), 'Assistência Médica Teste', 'folha', 'lancavel', dre_line_id, true
FROM accounts WHERE name = 'Benefícios';

SELECT pg_temp.login('fin');
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Bia', (SELECT id FROM contract_types WHERE name = 'CLT'), 4000);
-- Base do Omie da conta na unidade: 1.000 por mês
WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id, description, origin)
           VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('saude'), 'Base 2026 (Omie)', 'gerada') RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT l.id, m, 1000 FROM l, generate_series(1, 12) m;

INSERT INTO person_benefits (person_id, account_id, amount) VALUES (pg_temp.person('Bia'), pg_temp.id('saude'), 600);
SELECT is(pg_temp.ben('Bia', 1) + pg_temp.ben('Bia', 12), 1200::NUMERIC, 'O valor mensal entra em todos os meses com salário');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE origin = 'gerada' AND account_id = pg_temp.id('saude')), 0,
  'A linha da base do Omie da conta sai da unidade');
SELECT is((SELECT amount FROM benefit_bases WHERE unit_id = pg_temp.id('consultoria') AND account_id = pg_temp.id('saude')),
  12000::NUMERIC, 'O total da base do Omie fica como referência');

-- Saiu em junho: zera o salário de julho a dezembro
DELETE FROM plan_values WHERE line_id = (SELECT id FROM plan_lines WHERE person_id = pg_temp.person('Bia')) AND month > 6;
SELECT is(pg_temp.ben('Bia', 7), 0::NUMERIC, 'Sem salário, sem benefício');
SELECT is(pg_temp.ben('Bia', 6), 600::NUMERIC, 'Os meses com salário continuam');

UPDATE person_benefits SET amount = 650 WHERE person_id = pg_temp.person('Bia');
SELECT is(pg_temp.ben('Bia', 3), 650::NUMERIC, 'Mudar o valor refaz os meses');

SELECT ok(EXISTS (SELECT 1 FROM payroll_detail(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
                  WHERE person_id = pg_temp.person('Bia') AND month = 3 AND grupo = 'beneficio'
                    AND item = 'Assistência Médica Teste' AND amount = 650),
  'Na Folha, o benefício aparece na pessoa, pela conta');
SELECT is((SELECT amount - 4000 - (SELECT COALESCE(SUM(amount), 0) FROM payroll_detail(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
                                   WHERE person_id = pg_temp.person('Bia') AND month = 3 AND grupo IN ('encargo', 'provisao')
                                     AND item <> 'Assistência Médica Teste')
           FROM payroll_detail(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
           WHERE person_id = pg_temp.person('Bia') AND month = 3 AND grupo = 'custo_total'),
  650 + (SELECT COALESCE(SUM(amount), 0) FROM payroll_detail(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
         WHERE person_id = pg_temp.person('Bia') AND month = 3 AND grupo = 'beneficio' AND item <> 'Assistência Médica Teste'),
  'O custo total da pessoa inclui o benefício');
SELECT is((SELECT COALESCE(SUM(amount), 0) FROM plan_base_rows(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')])
           WHERE row_kind = 'salario' AND month = 3), 4000::NUMERIC, 'Benefício não entra na remuneração (base dos encargos)');

-- Transferir a pessoa leva o benefício junto
UPDATE people SET unit_id = pg_temp.id('agencia') WHERE name = 'Bia';
SELECT is((SELECT unit_id FROM plan_lines WHERE benefit_person_id = pg_temp.person('Bia')), pg_temp.id('agencia'),
  'Transferir a pessoa leva o benefício para a outra unidade');

-- Distribuir: a base do Omie dividida pelos meses-pessoa com salário
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Caio', (SELECT id FROM contract_types WHERE name = 'CLT'), 3000),
       (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Duda', (SELECT id FROM contract_types WHERE name = 'CLT'), 3000);
WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id, description, origin)
           VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('saude'), 'Base 2026 (Omie)', 'gerada') RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT l.id, m, 900 FROM l, generate_series(1, 12) m;
SELECT is(distribute_benefits(pg_temp.id('versao'), pg_temp.id('consultoria')), 1, 'Distribui a conta que estava na base');
SELECT is((SELECT amount FROM person_benefits WHERE person_id = pg_temp.person('Caio')), 450::NUMERIC,
  '900 por mês dividido entre 2 pessoas');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT throws_ok($$ INSERT INTO person_benefits (person_id, account_id, amount)
                    VALUES (pg_temp.person('Caio'), pg_temp.id('saude'), 1) $$, '42501', NULL,
  'Líder não lança benefício por pessoa');

RESET ROLE;
SELECT pg_temp.login('fin');
INSERT INTO ids VALUES ('copia', copy_version(pg_temp.id('versao'), 'Cópia', 2027));
SELECT is((SELECT count(*)::INT FROM person_benefits pb JOIN people p ON p.id = pb.person_id
           WHERE p.version_id = pg_temp.id('copia')), 3,
  'Copiar a versão leva os benefícios por pessoa');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
