-- Ano base guardado: o mesmo resultado do cálculo na hora; mudança nos dados de origem volta ao cálculo na hora até o
-- agendamento refazer.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.agg(_rows TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r TEXT;
BEGIN
  EXECUTE format('SELECT md5(string_agg(x::TEXT, '','' ORDER BY x::TEXT)) FROM (%s) x', _rows) INTO r;
  RETURN r;
END $$;

-- Um lançamento do Omie em 2026, numa categoria com conta.
INSERT INTO accounts (name, kind, treatment, dre_line_id)
VALUES ('Cache Teste', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'));
SELECT public.reference_cache_refresh_year(2026);

SELECT is((SELECT stale FROM reference_cache_state WHERE year = 2026), false, 'Refeito: em dia');
SELECT is(pg_temp.agg('SELECT * FROM reference_rows_omie(2026)'), pg_temp.agg('SELECT * FROM reference_rows_omie_live(2026)'),
  'O guardado é igual ao cálculo na hora');

-- Uma conta nova muda a atribuição: o guardado fica desatualizado e vale o cálculo na hora.
UPDATE reference_omie_cache SET amount = amount + 1 WHERE year = 2026;
INSERT INTO reference_omie_cache VALUES (2026, (SELECT id FROM units LIMIT 1), (SELECT id FROM accounts LIMIT 1), 'despesa', 1, 999);
SELECT isnt(pg_temp.agg('SELECT * FROM reference_rows_omie(2026)'), pg_temp.agg('SELECT * FROM reference_rows_omie_live(2026)'),
  'Em dia, a leitura vem do guardado');
UPDATE accounts SET name = 'Cache Teste 2' WHERE name = 'Cache Teste';
SELECT is((SELECT stale FROM reference_cache_state WHERE year = 2026), true, 'Mudou uma conta: desatualizado');
SELECT is(pg_temp.agg('SELECT * FROM reference_rows_omie(2026)'), pg_temp.agg('SELECT * FROM reference_rows_omie_live(2026)'),
  'Desatualizado: calcula na hora');

SELECT * FROM finish();
ROLLBACK;
