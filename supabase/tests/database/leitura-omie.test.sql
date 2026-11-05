-- Leitura do Omie pelo app: gravação por empresa, categorias novas viram contas e uma leitura de cada vez.
BEGIN;
SELECT plan(20);

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

-- A execução que morre sem avisar é retomada de onde parou
CREATE TEMP TABLE r2 AS SELECT omie_sync_start(NULL) AS id;
SELECT omie_sync_checkpoint((SELECT id FROM r2), 2, 4, 13);
SELECT is((SELECT resume FROM omie_sync_runs WHERE id = (SELECT id FROM r2)),
  '{"index": 2, "step": 4, "page": 13}'::JSONB, 'Cada página marca a posição');
SELECT omie_sync_watchdog();
SELECT is((SELECT stalls FROM omie_sync_runs WHERE id = (SELECT id FROM r2)), 0, 'Quem está avançando não é mexido');

SELECT vault.create_secret('http://teste.invalid/omie-sync', 'omie_sync_url');
SELECT vault.create_secret('token-teste', 'omie_sync_token');
UPDATE omie_sync_runs SET progress_at = now() - interval '8 minutes' WHERE id = (SELECT id FROM r2);
SELECT omie_sync_watchdog();
SELECT is((SELECT stalls FROM omie_sync_runs WHERE id = (SELECT id FROM r2)), 1, 'Sem avançar: conta a tentativa');
SELECT is((SELECT convert_from(body, 'UTF8')::JSONB FROM net.http_request_queue ORDER BY id DESC LIMIT 1) - 'run_id',
  '{"index": 2, "step": 4, "page": 13}'::JSONB, 'Retoma da posição marcada');
SELECT omie_sync_checkpoint((SELECT id FROM r2), 2, 4, 14);
SELECT is((SELECT stalls FROM omie_sync_runs WHERE id = (SELECT id FROM r2)), 0, 'Avançou: zera as tentativas');

-- Empresa terminada passa a posição para a próxima
SELECT omie_sync_progress((SELECT id FROM r2), 'Empresa Teste', NULL);
SELECT is((SELECT resume FROM omie_sync_runs WHERE id = (SELECT id FROM r2)),
  '{"index": 3, "step": 0, "page": 1}'::JSONB, 'A retomada não grava a mesma empresa de novo');

-- Três tentativas sem avançar: termina com erro e libera o botão
UPDATE omie_sync_runs SET stalls = 3, progress_at = now() - interval '8 minutes' WHERE id = (SELECT id FROM r2);
INSERT INTO omie_sync_cache (run_id, step, page, rows) SELECT id, 'paid', 1, '[]' FROM r2;
SELECT omie_sync_watchdog();
SELECT is((SELECT status FROM omie_sync_runs WHERE id = (SELECT id FROM r2)), 'com_erro', 'Desiste depois de três tentativas');
SELECT is((SELECT count(*)::INT FROM omie_sync_cache WHERE run_id = (SELECT id FROM r2)), 0, 'Limpa o que estava guardado');
SELECT lives_ok($$ SELECT omie_sync_start(NULL) $$, 'O botão volta a funcionar');

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT omie_create_new_accounts() $$, '42501', NULL, 'Quem está logado não chama a gravação direto');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
