-- INSS e IRRF por tabela com vigência, encargos patronais por item e detalhe por colaborador.
BEGIN;
SELECT plan(18);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
SELECT pg_temp.login('fin');

-- ───────────── INSS (valores calculados à mão com a tabela de 2026) ─────────────
SELECT is(inss_empregado(1500, '2026-06-01'), 112.50, 'INSS na 1ª faixa: 1.500 × 7,5%');
SELECT is(inss_empregado(5000, '2026-06-01'), 501.51, 'INSS na 4ª faixa: 5.000 × 14% − 198,49');
SELECT is(inss_empregado(10000, '2026-06-01'), 988.09, 'INSS limitado ao teto de 8.475,55');
SELECT is(inss_empregado(5000, '2025-12-01'), 0::NUMERIC, 'Sem tabela vigente na data, não calcula');

-- ───────────── IRRF ─────────────
SELECT is(irrf(3000, 248.60, 0, '2026-06-01'), 0.00, 'Base abaixo de 2.428,80: isento');
SELECT is(irrf(5000, 501.51, 0, '2026-06-01'), 0.00, 'Até 5.000 a redução zera o imposto');
SELECT is(irrf(6000, 641.51, 2, '2026-06-01'), 280.83,
  '6.000 com 2 dependentes: tabela 460,58 menos a redução decrescente de 179,75');
SELECT is(irrf(10000, 988.09, 0, '2026-06-01'), 1569.55, 'Acima de 7.350 não há redução');

-- ───────────── Vigência: valor novo vale a partir da data ─────────────
INSERT INTO payroll_tax_constants (key, label, valid_from, value) VALUES ('irrf_dependente', 'x', '2027-01-01', 400);
SELECT is(irrf(6000, 641.51, 2, '2026-12-01'), 280.83, 'Antes da nova vigência, vale a dedução antiga');
SELECT is(irrf(6000, 641.51, 2, '2027-01-01'), 170.42,
  'Na nova vigência: base 4.558,49 × 22,5% − 675,49 = 350,17, menos a redução de 179,75');

-- ───────────── Detalhe por colaborador ─────────────
INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary)
VALUES (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000);
CREATE FUNCTION pg_temp.det(_item TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT amount FROM payroll_detail(pg_temp.id('versao')) WHERE item = _item AND month = 3
$$;
GRANT EXECUTE ON FUNCTION pg_temp.det(TEXT) TO authenticated;

SELECT is(pg_temp.det('Salário bruto'), 5000::NUMERIC, 'Detalhe: bruto');
SELECT is(pg_temp.det('Salário líquido'), 5000 - 501.51, 'Detalhe: líquido = bruto − INSS − IRRF');
SELECT is(pg_temp.det('INSS patronal (CPP)'), 1000::NUMERIC, 'Encargo patronal: 20% de 5.000');
SELECT is(pg_temp.det('FGTS'), 400::NUMERIC, 'FGTS: 8% de 5.000');
SELECT is(pg_temp.det('Custo total para a empresa'), 5000 + 1000 + 50 + 290 + 400::NUMERIC,
  'Custo total = bruto + INSS patronal + RAT + terceiros + FGTS');

-- Estagiário não tem os encargos de CLT (valores são por vínculo)
UPDATE people SET contract_type_id = pg_temp.ct('Estagiário (CIEE)') WHERE name = 'Ana';
SELECT is(pg_temp.det('Custo total para a empresa'), 5000::NUMERIC, 'Sem parâmetros para o vínculo, o custo é só a remuneração');

-- ───────────── Perfis ─────────────
SELECT pg_temp.login('lid');
UPDATE payroll_tax_constants SET value = 1 WHERE key = 'irrf_dependente' AND valid_from = '2026-01-01';
SELECT is((SELECT value FROM payroll_tax_constants WHERE key = 'irrf_dependente' AND valid_from = '2026-01-01'), 189.59,
  'Líder não altera as tabelas');
SELECT is((SELECT count(*)::INT FROM payroll_tax_brackets WHERE table_key = 'inss'), 4, 'Líder lê as tabelas');
SELECT * FROM finish();
ROLLBACK;
