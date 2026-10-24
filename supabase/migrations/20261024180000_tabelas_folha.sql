-- Tabelas da folha (INSS e IRRF do empregado), encargos patronais granulares e detalhe por colaborador.
-- Tudo é dado editável com vigência (as tabelas mudam todo ano). Valores iniciais: "Tabelas_Folha_2026_CUPOLA",
-- que valem para CLT. Sócios e estagiários recebem parâmetros próprios pela tela, se quiserem.
-- INSS e IRRF do colaborador são retenção: aparecem no detalhe (bruto → líquido), não entram na DRE.

CREATE TABLE public.payroll_tax_brackets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_key TEXT NOT NULL CHECK (table_key IN ('inss', 'irrf')),
  valid_from DATE NOT NULL,
  lower_bound NUMERIC NOT NULL CHECK (lower_bound >= 0),
  upper_bound NUMERIC,                      -- NULL = sem limite
  rate NUMERIC NOT NULL CHECK (rate >= 0 AND rate < 1),
  deduction NUMERIC NOT NULL DEFAULT 0 CHECK (deduction >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (upper_bound IS NULL OR upper_bound > lower_bound)
);
CREATE UNIQUE INDEX payroll_tax_brackets_key ON public.payroll_tax_brackets (table_key, valid_from, lower_bound);

CREATE TABLE public.payroll_tax_constants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  valid_from DATE NOT NULL,
  value NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payroll_tax_constants_key ON public.payroll_tax_constants (key, valid_from);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_tax_brackets', 'payroll_tax_constants']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Authenticated read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

INSERT INTO public.payroll_tax_brackets (table_key, valid_from, lower_bound, upper_bound, rate, deduction) VALUES
  ('inss', '2026-01-01', 0, 1621.00, 0.075, 0),
  ('inss', '2026-01-01', 1621.01, 2902.84, 0.09, 24.32),
  ('inss', '2026-01-01', 2902.85, 4354.27, 0.12, 111.40),
  ('inss', '2026-01-01', 4354.28, 8475.55, 0.14, 198.49),
  ('irrf', '2026-01-01', 0, 2428.80, 0, 0),
  ('irrf', '2026-01-01', 2428.81, 2826.65, 0.075, 182.16),
  ('irrf', '2026-01-01', 2826.66, 3751.05, 0.15, 394.16),
  ('irrf', '2026-01-01', 3751.06, 4664.68, 0.225, 675.49),
  ('irrf', '2026-01-01', 4664.69, NULL, 0.275, 908.73);

INSERT INTO public.payroll_tax_constants (key, label, valid_from, value) VALUES
  ('irrf_dependente', 'IRRF: dedução por dependente (R$)', '2026-01-01', 189.59),
  ('irrf_simplificado', 'IRRF: desconto simplificado mensal (R$)', '2026-01-01', 607.20),
  ('irrf_reducao_limite_isencao', 'IRRF, redução (Lei 15.270): limite de isenção total, sobre o bruto (R$)', '2026-01-01', 5000),
  ('irrf_reducao_limite_transicao', 'IRRF, redução: limite da faixa de transição, sobre o bruto (R$)', '2026-01-01', 7350),
  ('irrf_reducao_maxima', 'IRRF, redução: valor máximo até o limite de isenção (R$)', '2026-01-01', 312.89),
  ('irrf_reducao_constante', 'IRRF, redução na transição: constante (R$)', '2026-01-01', 978.62),
  ('irrf_reducao_fator', 'IRRF, redução na transição: fator sobre o bruto', '2026-01-01', 0.133145);

-- Tabela vigente na data: a mais recente com valid_from até a data.
CREATE OR REPLACE FUNCTION public.tax_constant(_key TEXT, _ref DATE) RETURNS NUMERIC
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT value FROM public.payroll_tax_constants WHERE key = _key AND valid_from <= _ref
  ORDER BY valid_from DESC LIMIT 1
$$;

-- Faixa da tabela vigente a que o valor pertence: a de maior limite inferior até o valor (acima da última, vale
-- a última). ceiling = limite superior da última faixa que tem limite (o teto do INSS).
CREATE OR REPLACE FUNCTION public.tax_bracket(_table TEXT, _base NUMERIC, _ref DATE)
RETURNS TABLE (rate NUMERIC, deduction NUMERIC, ceiling NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH b AS (
    SELECT t.* FROM public.payroll_tax_brackets t
    WHERE t.table_key = _table
      AND t.valid_from = (SELECT max(valid_from) FROM public.payroll_tax_brackets
                          WHERE table_key = _table AND valid_from <= _ref)
  )
  SELECT b.rate, b.deduction, (SELECT max(b2.upper_bound) FROM b b2)
  FROM b WHERE b.lower_bound <= _base
  ORDER BY b.lower_bound DESC LIMIT 1
$$;

-- INSS do empregado: progressivo pela tabela com parcela a deduzir, limitado ao teto (última faixa).
CREATE OR REPLACE FUNCTION public.inss_empregado(_gross NUMERIC, _ref DATE) RETURNS NUMERIC
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((
    SELECT round(GREATEST(0, LEAST(_gross, COALESCE(b.ceiling, _gross)) * b.rate - b.deduction), 2)
    FROM public.tax_bracket('inss', _gross, _ref) b
  ), 0)
$$;

-- IRRF mensal: base = bruto − maior entre (INSS + dependentes) e o desconto simplificado; tabela progressiva;
-- depois a redução da Lei 15.270, decidida pelo rendimento bruto, que nunca gera imposto negativo.
CREATE OR REPLACE FUNCTION public.irrf(_gross NUMERIC, _inss NUMERIC, _dependents INT, _ref DATE) RETURNS NUMERIC
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  _base NUMERIC;
  _table NUMERIC;
  _reduction NUMERIC := 0;
  b RECORD;
BEGIN
  _base := GREATEST(0, _gross - GREATEST(_inss + COALESCE(_dependents, 0) * COALESCE(public.tax_constant('irrf_dependente', _ref), 0),
                                         COALESCE(public.tax_constant('irrf_simplificado', _ref), 0)));
  SELECT * INTO b FROM public.tax_bracket('irrf', _base, _ref);
  IF NOT FOUND THEN RETURN 0; END IF;
  _table := GREATEST(0, _base * b.rate - b.deduction);
  IF _gross <= COALESCE(public.tax_constant('irrf_reducao_limite_isencao', _ref), 0) THEN
    _reduction := LEAST(_table, COALESCE(public.tax_constant('irrf_reducao_maxima', _ref), 0));
  ELSIF _gross <= COALESCE(public.tax_constant('irrf_reducao_limite_transicao', _ref), 0) THEN
    _reduction := GREATEST(0, COALESCE(public.tax_constant('irrf_reducao_constante', _ref), 0)
                              - COALESCE(public.tax_constant('irrf_reducao_fator', _ref), 0) * _gross);
  END IF;
  RETURN round(GREATEST(0, _table - _reduction), 2);
END;
$$;

-- Como cada regra de folha aparece no detalhe: encargo patronal, provisão ou benefício.
ALTER TABLE public.calc_rules
  ADD COLUMN payroll_group TEXT CHECK (payroll_group IN ('encargo', 'provisao', 'beneficio'));
UPDATE public.calc_rules SET payroll_group = CASE
  WHEN base_kind = 'headcount' THEN 'beneficio'
  WHEN parameter_definition_id = (SELECT id FROM public.parameter_definitions WHERE key = 'provisao_13_ferias') THEN 'provisao'
  ELSE 'encargo' END
WHERE base_kind IN ('salario', 'headcount');

-- Encargos patronais da planilha, por item (valem para CLT). O parâmetro "Encargos sobre a remuneração" continua
-- existindo para o que não tem item próprio; se ele já repete estes itens, zere-o na página Parâmetros.
INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order) VALUES
  ('inss_patronal', 'INSS patronal (CPP)', 'Sobre o total da remuneração, sem teto.', 'percent', ARRAY['global', 'contract_type'], 0, 1, 61),
  ('rat', 'RAT/GILRAT', 'Sobre o total da remuneração.', 'percent', ARRAY['global', 'contract_type'], 0, 1, 62),
  ('terceiros', 'Terceiros (outras entidades)', 'Sobre o total da remuneração.', 'percent', ARRAY['global', 'contract_type'], 0, 1, 63),
  ('fgts', 'FGTS', 'Sobre a remuneração. Alíquota fixa de 8% para CLT.', 'percent', ARRAY['global', 'contract_type'], 0, 1, 64);

INSERT INTO public.parameter_values (definition_id, value, valid_from, contract_type_id, note)
SELECT d.id, v.value, DATE '2026-01-01', (SELECT id FROM public.contract_types WHERE name = 'CLT'), 'Tabelas_Folha_2026_CUPOLA'
FROM (VALUES ('inss_patronal', 0.20), ('rat', 0.01), ('terceiros', 0.058), ('fgts', 0.08)) AS v(key, value)
JOIN public.parameter_definitions d ON d.key = v.key
WHERE EXISTS (SELECT 1 FROM public.contract_types WHERE name = 'CLT');

INSERT INTO public.calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, payroll_group, sort_order)
SELECT d.label, (SELECT target_dre_line_id FROM public.calc_rules WHERE name = 'Encargos'), d.id, 'salario', 'encargo', 61 + o
FROM (VALUES ('inss_patronal', 0), ('rat', 1), ('terceiros', 2), ('fgts', 3)) AS k(key, o)
JOIN public.parameter_definitions d ON d.key = k.key
WHERE EXISTS (SELECT 1 FROM public.calc_rules WHERE name = 'Encargos');

-- Detalhe por colaborador e mês: bruto → retenções → líquido, e o que a empresa paga além do bruto.
-- grupo: bruto · retencao · liquido · encargo · provisao · beneficio · custo_total. SECURITY INVOKER: o RLS vale.
CREATE OR REPLACE FUNCTION public.payroll_detail(_version_id UUID, _scenario_id UUID DEFAULT NULL, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (person_id UUID, unit_id UUID, month INT, grupo TEXT, item TEXT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(expense_variation, 0) AS ev, COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  ), yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  pm AS (
    SELECT p.id AS person_id, p.unit_id, v.month, p.contract_type_id, p.dependents, l.account_id,
           make_date(yr.year, v.month, 1) AS ref,
           v.amount * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END AS gross
    FROM public.plan_lines l
    JOIN public.people p ON p.id = l.person_id
    JOIN public.plan_values v ON v.line_id = l.id
    CROSS JOIN s CROSS JOIN yr
    WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  ), ret AS (
    SELECT pm.*, public.inss_empregado(pm.gross, pm.ref) AS inss FROM pm
  ), ret2 AS (
    SELECT ret.*, public.irrf(ret.gross, ret.inss, ret.dependents, ret.ref) AS ir FROM ret
  ), rules AS (
    SELECT r2.person_id, r2.unit_id, r2.month, c.payroll_group AS grupo, c.name AS item,
      CASE c.base_kind WHEN 'salario' THEN r2.gross ELSE CASE WHEN r2.gross > 0 THEN 1 ELSE 0 END END
        * COALESCE(public.param_value(c.parameter_definition_id, r2.ref, r2.unit_id, NULL, r2.contract_type_id, NULL), 0) AS amount
    FROM ret2 r2
    JOIN public.calc_rules c ON c.active AND c.base_kind IN ('salario', 'headcount')
      AND (c.contract_type_ids IS NULL OR r2.contract_type_id = ANY (c.contract_type_ids))
      AND (c.account_ids IS NULL OR r2.account_id = ANY (c.account_ids))
  )
  SELECT person_id, unit_id, month, 'bruto', 'Salário bruto', gross FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'INSS do empregado', inss FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'retencao', 'IRRF', ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, 'liquido', 'Salário líquido', gross - inss - ir FROM ret2
  UNION ALL SELECT person_id, unit_id, month, COALESCE(grupo, 'encargo'), item, amount FROM rules
  UNION ALL SELECT r2.person_id, r2.unit_id, r2.month, 'custo_total', 'Custo total para a empresa',
    r2.gross + COALESCE((SELECT sum(x.amount) FROM rules x WHERE x.person_id = r2.person_id AND x.month = r2.month), 0)
  FROM ret2 r2
$$;
REVOKE EXECUTE ON FUNCTION public.payroll_detail(UUID, UUID, UUID[]) FROM anon;
