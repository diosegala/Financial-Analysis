-- Folha no mês do pagamento: salário no mês seguinte, 13º e férias coletivas pelas regras do financeiro, e o que o ano
-- anterior deixa para janeiro.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
CREATE FUNCTION pg_temp.det(_item TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM payroll_detail(pg_temp.id('versao')) WHERE item = _item AND month = _month
$$;
CREATE FUNCTION pg_temp.inss(_v NUMERIC, _y INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT inss_empregado(_v, make_date(_y, 12, 1)) $$;
CREATE FUNCTION pg_temp.ir(_v NUMERIC, _y INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT irrf(_v, inss_empregado(_v, make_date(_y, 12, 1)), 0, make_date(_y, 12, 1)) $$;
-- Encargos patronais de CLT, arredondados regra a regra: FGTS 8%, INSS 20%, RAT 1%, terceiros 5,8%.
CREATE FUNCTION pg_temp.patronal(_v NUMERIC) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT round(_v * 0.08, 2) + round(_v * 0.20, 2) + round(_v * 0.01, 2) + round(_v * 0.058, 2) $$;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

-- CLT com 3.000 o ano todo. Férias coletivas: 19 dias pagos em dezembro (dias + terço = 2.533,33).
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 3000);

SELECT is(pg_temp.det('Salário bruto · 2026', 1), 1900::NUMERIC,
  'Janeiro paga o salário de dezembro/26: 19 dias, porque 11 foram pagos nas férias');
SELECT is(pg_temp.det('Salário bruto', 2), 2300::NUMERIC, 'Fevereiro paga o salário de janeiro: 23 dias');
SELECT is(pg_temp.det('Salário bruto', 3), 3000::NUMERIC, 'Março paga o salário de fevereiro, inteiro');
SELECT is((SELECT SUM(amount) FROM payroll_detail(pg_temp.id('versao')) WHERE grupo = 'bruto'),
  1900 + 2300 + 3000 * 10::NUMERIC, 'O salário de dezembro/27 fica para janeiro/28');
SELECT is(pg_temp.det('13º salário · 2026 · encargos', 1), 120 + pg_temp.ir(3000, 2026),
  'Janeiro: FGTS da 2ª parcela e IR do 13º de 2026');
SELECT is(pg_temp.det('Férias coletivas · 2026 · encargos', 1),
  pg_temp.inss(2533.33, 2026) + pg_temp.ir(2533.33, 2026) + pg_temp.patronal(2533.33),
  'Janeiro: FGTS, INSS, INSS patronal e IR das férias de dezembro/26');
SELECT is(pg_temp.det('13º salário', 11), 1500::NUMERIC, 'Novembro: 1ª parcela, sem descontos');
SELECT is(pg_temp.det('13º salário', 12), 1500 - pg_temp.inss(3000, 2027) - pg_temp.ir(3000, 2027),
  'Dezembro: 2ª parcela líquida');
SELECT is(pg_temp.det('13º salário · encargos', 12), 120 + pg_temp.inss(3000, 2027) + (600 + 30 + 174)::NUMERIC,
  'Dezembro: FGTS da 1ª parcela e INSS integral do 13º (empregado e patronal); o IR fica para janeiro');
SELECT is(pg_temp.det('Férias coletivas', 12), 2533.33 - pg_temp.inss(2533.33, 2027) - pg_temp.ir(2533.33, 2027),
  'Dezembro: férias coletivas pagas antes de começar; os impostos ficam para janeiro');

CREATE FUNCTION pg_temp.dre_ano() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT SUM(v.amount) FROM dre_unit_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('consultoria')]) v
  JOIN dre_lines dl ON dl.id = v.dre_line_id AND dl.kind IN ('lancada', 'calculada') AND dl.sign < 0
$$;
SELECT is(round(pg_temp.dre_ano()),
  round((SELECT SUM(amount) FROM payroll_detail(pg_temp.id('versao')) WHERE item = 'Custo total para a empresa')),
  'A DRE do ano soma o mesmo que o custo da folha');

-- A regra é dado: com o salário pago no próprio mês, nada de dezembro/26 entra
UPDATE payroll_payment_rules SET lag = 0 WHERE event = 'salario';
SELECT is(ARRAY[pg_temp.det('Salário bruto · 2026', 1), pg_temp.det('Salário bruto', 1)], ARRAY[0, 2300]::NUMERIC[],
  'Mudar o atraso na tabela muda o mês');
UPDATE payroll_payment_rules SET lag = 1 WHERE event = 'salario';

-- Sócio: sem férias e sem retenção; só o atraso
UPDATE people SET contract_type_id = pg_temp.ct('Sócio (pró-labore)') WHERE name = 'Ana';
SELECT is(ARRAY[pg_temp.det('Salário bruto · 2026', 1), pg_temp.det('Salário bruto', 2)], ARRAY[3000, 3000]::NUMERIC[],
  'Sócio: pró-labore no mês seguinte, sem os dias de férias');
SELECT is(pg_temp.det('13º salário', 12), 1500::NUMERIC, 'Sócio: 2ª parcela sem descontos');

SELECT * FROM finish();
ROLLBACK;
