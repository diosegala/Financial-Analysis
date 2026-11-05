-- Leitura do Omie pelo app: gravação por empresa, categorias novas viram contas e uma leitura de cada vez.
BEGIN;
SELECT plan(11);

WITH c AS (INSERT INTO omie_companies (name) VALUES ('Empresa Antiga') RETURNING id)
INSERT INTO omie_categories (company_id, code, name, is_expense, is_revenue, is_total)
SELECT c.id, '9.99', 'Categoria Antiga Teste', true, false, false FROM c;
-- A que já existia não vira conta. A marcação foi feita na migration; aqui, igual.
INSERT INTO omie_known_categories (name_key) VALUES (norm_text('Categoria Antiga Teste'));

CREATE FUNCTION pg_temp.guardar() RETURNS VOID LANGUAGE sql AS $$
  SELECT omie_store_company('Empresa Teste', ARRAY[2026],
    '[{"code":"D1","name":"Dep","structure":"001"}]',
    '[{"code":"2.01","name":"Ferramenta Nova Teste","parent_code":null,"is_expense":true,"is_revenue":false,"is_total":false},
      {"code":"2.02","name":"Receita Nova Teste","parent_code":null,"is_expense":false,"is_revenue":true,"is_total":false},
      {"code":"2","name":"Grupo Novo Teste","parent_code":null,"is_expense":true,"is_revenue":false,"is_total":true},
      {"code":"2.03","name":"Evento Passado Teste - 2020","parent_code":"2","is_expense":true,"is_revenue":false,"is_total":false},
      {"code":"2.04","name":"FGTS Novo Teste","parent_code":"2","is_expense":true,"is_revenue":false,"is_total":false}]',
    '[{"code":"7","name":"Fornecedor"}]',
    '[{"year":2026,"month":3,"category_code":"2.01","department_code":"","supplier_code":"7","item":"","amount_paid":100,"amount_open":5}]',
    '[{"year":2026,"month":3,"category_code":"2.02","department_code":"","client_code":"7","amount_received":200,"amount_open":0}]');
$$;
SELECT pg_temp.guardar();
SELECT is((SELECT amount_paid FROM omie_actuals a JOIN omie_companies c ON c.id = a.company_id WHERE c.name = 'Empresa Teste'),
  100::NUMERIC, 'Grava as despesas da empresa');
SELECT is((SELECT amount_received FROM omie_receipts a JOIN omie_companies c ON c.id = a.company_id WHERE c.name = 'Empresa Teste'),
  200::NUMERIC, 'Grava as receitas da empresa');
SELECT pg_temp.guardar();
SELECT is((SELECT count(*)::INT FROM omie_actuals a JOIN omie_companies c ON c.id = a.company_id WHERE c.name = 'Empresa Teste'),
  1, 'Ler de novo troca o ano, sem duplicar');

-- Ano fora da leitura fica como estava
INSERT INTO omie_actuals (company_id, year, month, category_code, amount_paid)
SELECT id, 2024, 1, '2.01', 50 FROM omie_companies WHERE name = 'Empresa Teste';
SELECT pg_temp.guardar();
SELECT is((SELECT count(*)::INT FROM omie_actuals a JOIN omie_companies c ON c.id = a.company_id WHERE c.name = 'Empresa Teste' AND a.year = 2024),
  1, 'Anos que não foram lidos ficam como estavam');

CREATE TEMP TABLE novas AS SELECT unnest(omie_create_new_accounts()) AS name;
SELECT is((SELECT array_agg(name ORDER BY name) FROM novas), ARRAY['Ferramenta Nova Teste', 'Receita Nova Teste'],
  'Só categorias novas e lançáveis viram contas');
SELECT is((SELECT kind FROM accounts WHERE name = 'Receita Nova Teste'), 'receita', 'Categoria de receita vira conta de receita');
SELECT is((SELECT kind FROM accounts WHERE name = 'Ferramenta Nova Teste'), 'despesa', 'Categoria de despesa vira conta de despesa');
SELECT is(cardinality(omie_create_new_accounts()), 0, 'Na leitura seguinte, nada é criado de novo');

-- Uma leitura de cada vez
CREATE TEMP TABLE r AS SELECT omie_sync_start(NULL) AS id;
SELECT throws_ok($$ SELECT omie_sync_start(NULL) $$, 'Já há uma leitura do Omie em andamento.');
SELECT lives_ok($$ SELECT omie_sync_finish((SELECT id FROM r)) $$, 'A leitura termina');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT omie_create_new_accounts() $$, '42501', NULL, 'Quem está logado não chama a gravação direto');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
