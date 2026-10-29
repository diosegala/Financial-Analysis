-- 13º e terço de férias pelo calendário da folha, retenções por vínculo, IRRF informado e reajuste de benefício.
BEGIN;
SELECT plan(17);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('saude', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
INSERT INTO accounts (id, name, kind, treatment, dre_line_id, per_person)
SELECT pg_temp.id('saude'), 'Assistência Médica Teste', 'folha', 'lancavel', dre_line_id, true
FROM accounts WHERE name = 'Benefícios';
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
CREATE FUNCTION pg_temp.dre_custos() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT SUM(v.amount) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')]) v
  JOIN dre_lines dl ON dl.id = v.dre_line_id AND dl.kind IN ('lancada', 'calculada') AND dl.sign < 0
$$;
CREATE FUNCTION pg_temp.det(_item TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM payroll_detail(pg_temp.id('versao')) WHERE item = _item AND month = _month
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
SELECT pg_temp.login('fin');

SELECT is((SELECT count(*)::INT FROM payroll_calendar), 4, 'Calendário: 2 parcelas do 13º e 2 períodos de férias');
SELECT ok(NOT EXISTS (SELECT 1 FROM calc_rules WHERE payroll_group = 'provisao'), 'Sem provisão mensal por percentual');

CREATE TEMP TABLE dre_antes AS SELECT COALESCE(pg_temp.dre_custos(), 0) AS v;

-- CLT com 5.000 o ano todo. Encargos de CLT: 20% + 1% + 5,8% + 8% = 34,8%.
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000);

SELECT is(pg_temp.det('13º salário', 11), 2500::NUMERIC, '13º: 1ª parcela em novembro = 50% do bruto');
SELECT is(pg_temp.det('13º salário', 12), 2500 - 501.51, '13º: 2ª parcela sai líquida (menos INSS 501,51; IRRF zero até 5.000)');
SELECT is(pg_temp.det('13º salário · encargos', 12), 1740 + 501.51, '13º · encargos: 34,8% de 5.000 + INSS descontado');
SELECT is(pg_temp.det('13º salário · encargos', 11), 0::NUMERIC, 'Encargos do 13º ficam todos em dezembro');
SELECT is(pg_temp.det('Férias (1/3)', 10), 555.56, 'Férias de outubro: 5.000 / 30 × 10 dias × 1/3');
SELECT is(pg_temp.det('Férias (1/3)', 12), 1111.11, 'Férias coletivas de dezembro: 20 dias × 1/3');
SELECT is(pg_temp.det('Férias (1/3)', 3), 0::NUMERIC, 'Sem férias fora do calendário');
SELECT is(pg_temp.det('Custo total para a empresa', 12), 5000 + 1740 + 2500 + 1740 + 1111.11 + 386.67,
  'Dezembro: salário, encargos, 13º inteiro com encargos e terço com encargos');
SELECT is(round(pg_temp.dre_custos() - (SELECT v FROM dre_antes)),
  round((SELECT SUM(amount) FROM payroll_detail(pg_temp.id('versao')) WHERE item = 'Custo total para a empresa')),
  'A DRE do ano soma o mesmo que o custo da folha');

-- Entrou em julho: 13º proporcional (6/12)
UPDATE plan_values SET amount = 0 WHERE month <= 6
  AND line_id = (SELECT id FROM plan_lines WHERE person_id = (SELECT id FROM people WHERE name = 'Ana'));
SELECT is(pg_temp.det('13º salário', 11), 1250::NUMERIC, 'Quem entrou em julho recebe 6/12 do 13º');

-- Sócio: sem retenção pela tabela, sem terço de férias; o 13º sai 50/50 do bruto
UPDATE people SET contract_type_id = pg_temp.ct('Sócio (pró-labore)') WHERE name = 'Ana';
SELECT is(pg_temp.det('Salário líquido', 8), 5000::NUMERIC, 'Sócio: sem INSS e IRRF pela tabela');
SELECT is(pg_temp.det('13º salário', 12), 1250::NUMERIC, 'Sócio: 2ª parcela do 13º sem descontos');
SELECT is(pg_temp.det('Férias (1/3)', 10), 0::NUMERIC, 'Sócio não tem férias');
UPDATE people SET irrf_override = 300 WHERE name = 'Ana';
SELECT is(pg_temp.det('IRRF', 8), 300::NUMERIC, 'IRRF informado na pessoa substitui a tabela');

-- Reajuste do benefício: 10% a partir de setembro
INSERT INTO person_benefits (person_id, account_id, amount)
VALUES ((SELECT id FROM people WHERE name = 'Ana'), pg_temp.id('saude'), 1000);
INSERT INTO benefit_adjustments (version_id, account_id, month, pct) VALUES (pg_temp.id('versao'), pg_temp.id('saude'), 9, 0.1);
SELECT is(ARRAY[pg_temp.det('Assistência Médica Teste', 8), pg_temp.det('Assistência Médica Teste', 9)],
  ARRAY[1000, 1100]::NUMERIC[], 'Benefício reajustado a partir do mês do reajuste');

SELECT * FROM finish();
ROLLBACK;
