-- Metas de cima para baixo (docs/mudancas-reuniao-fabio-22-10.md, objetivo 1).
-- O financeiro soma os custos (áreas de apoio e unidades de negócio), define o alvo de cada cenário em R$ de
-- resultado ou em % de margem, e o app calcula a receita necessária:
--   alvo em R$:  R = (alvo + F − Rfin·(1 − vfin)) / (1 − v)
--   alvo em %:   R = (F − Rfin·(1 − vfin − m)) / (1 − v − m)       (m sobre a receita total R + Rfin)
-- F = custos que não dependem da receita; v = alíquota variável (impostos e comissões) das unidades de negócio;
-- Rfin = receita planejada pelas áreas de apoio (ex.: receita financeira do Financeiro), com alíquota vfin própria.
-- A receita das unidades de negócio é distribuída por participação (%) de cada unidade e peso de cada mês, ambos manuais.

CREATE TABLE public.scenario_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- a auditoria identifica a linha por id
  scenario_id UUID NOT NULL PRIMARY KEY REFERENCES public.scenarios(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT 'resultado' CHECK (target_kind IN ('resultado', 'margem')),
  target_value NUMERIC NOT NULL DEFAULT 0,
  -- Alíquota que incide sobre a receita das áreas de apoio. O tratamento tributário da receita financeira
  -- ainda não foi definido: começa em zero e o financeiro ajusta.
  financial_variable_pct NUMERIC NOT NULL DEFAULT 0 CHECK (financial_variable_pct >= 0 AND financial_variable_pct < 1),
  -- Resultado do último cálculo
  required_revenue NUMERIC,
  fixed_costs NUMERIC,
  financial_revenue NUMERIC,
  variable_pct NUMERIC,
  target_amount NUMERIC,
  target_margin NUMERIC,
  feasible BOOLEAN,
  computed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_kind <> 'margem' OR (target_value >= 0 AND target_value < 1))
);

-- Participação de cada unidade de negócio na receita necessária (somam 100%).
CREATE TABLE public.target_unit_shares (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  share NUMERIC NOT NULL CHECK (share >= 0 AND share <= 1),
  -- Alíquota variável da unidade, se o financeiro quiser trocar a calculada pelas regras
  variable_pct_override NUMERIC CHECK (variable_pct_override >= 0 AND variable_pct_override < 1),
  PRIMARY KEY (scenario_id, unit_id)
);

-- Peso de cada mês. unit_id vazio = padrão de todas as unidades; sem nenhum peso, os 12 meses valem igual.
CREATE TABLE public.target_month_weights (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  weight NUMERIC NOT NULL CHECK (weight >= 0)
);
CREATE UNIQUE INDEX target_month_weights_key ON public.target_month_weights
  (scenario_id, COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::UUID), month);

-- Meta calculada: um valor por cenário, unidade e mês. É o que o líder enxerga depois de publicada.
CREATE TABLE public.revenue_targets (
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC NOT NULL,
  PRIMARY KEY (scenario_id, unit_id, month)
);

-- Acesso: o financeiro escreve tudo. O líder só lê a meta publicada das unidades dele.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['scenario_targets', 'target_unit_shares', 'target_month_weights', 'revenue_targets']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['scenario_targets', 'target_unit_shares', 'target_month_weights']
  LOOP
    EXECUTE format('CREATE POLICY "Financeiro reads %1$s" ON public.%1$I FOR SELECT TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
  END LOOP;
END $$;
CREATE TRIGGER upd_scenario_targets BEFORE UPDATE ON public.scenario_targets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A tabela do alvo é só do financeiro; o líder só precisa saber se a meta foi publicada.
CREATE OR REPLACE FUNCTION public.targets_published(_scenario_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.scenario_targets WHERE scenario_id = _scenario_id AND published_at IS NOT NULL)
$$;
REVOKE EXECUTE ON FUNCTION public.targets_published(UUID) FROM anon;

CREATE POLICY "Leader reads published targets" ON public.revenue_targets FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id) AND public.targets_published(scenario_id));

-- Receita, custo variável, folha e despesas do plano por unidade e mês, já com as regras de cálculo e o cenário.
-- Fonte única do que a meta e o "caminho para o alvo" tratam como receita, variável e custo que não depende dela.
CREATE OR REPLACE FUNCTION public.plan_split(_version_id UUID, _scenario_id UUID)
RETURNS TABLE (unit_id UUID, month INT, bucket TEXT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, NULL)),
  calc AS (
    SELECT b.unit_id, b.month, r.base_kind,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = b.row_kind
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.exclude_revenue_type_ids IS NULL
           OR NOT COALESCE(b.revenue_type_id = ANY (r.exclude_revenue_type_ids), false))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  )
  SELECT s.unit_id, s.month, s.bucket, SUM(s.amount) FROM (
    SELECT b.unit_id, b.month,
      CASE b.row_kind WHEN 'receita' THEN 'receita' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END AS bucket, b.amount
    FROM base b WHERE b.row_kind IN ('receita', 'despesa', 'folha', 'salario')
    UNION ALL
    SELECT c.unit_id, c.month,
      CASE c.base_kind WHEN 'receita' THEN 'variavel' WHEN 'despesa' THEN 'despesa' ELSE 'folha' END, c.amount
    FROM calc c
  ) s
  GROUP BY s.unit_id, s.month, s.bucket
$$;

-- Composição da alíquota variável de uma unidade na data: cada regra sobre a receita e a taxa que ela tem.
-- A regra entra quando vale para pelo menos metade dos tipos de receita (a de parceiros, por exemplo, fica de fora).
CREATE OR REPLACE FUNCTION public.variable_rate_parts(_unit_id UUID, _ref DATE)
RETURNS TABLE (rule_id UUID, rule_name TEXT, rate NUMERIC, included BOOLEAN)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH n AS (SELECT count(*) AS total FROM public.revenue_types)
  SELECT r.id, r.name,
    COALESCE(public.param_value(r.parameter_definition_id, _ref, _unit_id, NULL, NULL, NULL), 0),
    CASE WHEN r.revenue_type_ids IS NOT NULL THEN cardinality(r.revenue_type_ids)
         ELSE n.total - COALESCE(cardinality(r.exclude_revenue_type_ids), 0) END * 2 >= n.total
  FROM public.calc_rules r CROSS JOIN n
  WHERE r.active AND r.base_kind = 'receita'
  ORDER BY r.sort_order, r.name
$$;

-- Peso normalizado de cada mês de uma unidade (pesos próprios da unidade, senão o padrão, senão 1/12).
CREATE OR REPLACE FUNCTION public.target_weights(_scenario_id UUID, _unit_id UUID)
RETURNS TABLE (month INT, weight NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH own AS (SELECT w.month, w.weight FROM public.target_month_weights w
               WHERE w.scenario_id = _scenario_id AND w.unit_id = _unit_id),
  std AS (SELECT w.month, w.weight FROM public.target_month_weights w
          WHERE w.scenario_id = _scenario_id AND w.unit_id IS NULL),
  chosen AS (
    SELECT m.month, COALESCE(
      CASE WHEN EXISTS (SELECT 1 FROM own) THEN (SELECT o.weight FROM own o WHERE o.month = m.month)
           WHEN EXISTS (SELECT 1 FROM std) THEN (SELECT s.weight FROM std s WHERE s.month = m.month)
           ELSE 1 END, 0) AS weight
    FROM generate_series(1, 12) AS m(month)
  )
  SELECT c.month, CASE WHEN t.total > 0 THEN c.weight / t.total ELSE 1.0 / 12 END
  FROM chosen c CROSS JOIN (SELECT SUM(weight) AS total FROM chosen) t
$$;

-- Calcula a receita necessária e a distribui. Só o financeiro; meta publicada precisa ser reaberta antes.
CREATE OR REPLACE FUNCTION public.compute_targets(_scenario_id UUID) RETURNS public.scenario_targets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sc public.scenarios%ROWTYPE;
  st public.scenario_targets%ROWTYPE;
  _year INT;
  _f NUMERIC;
  _rfin NUMERIC;
  _v NUMERIC := 0;
  _vu NUMERIC;
  _sum_shares NUMERIC;
  _a NUMERIC;
  _m NUMERIC;
  _r NUMERIC;
  _den NUMERIC;
  u RECORD;
  w RECORD;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro calcula metas.';
  END IF;
  SELECT * INTO sc FROM public.scenarios WHERE id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cenário não encontrado.'; END IF;
  SELECT * INTO st FROM public.scenario_targets WHERE scenario_id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Defina o alvo do cenário antes de calcular.'; END IF;
  IF st.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'A meta deste cenário está publicada. Reabra a meta para recalcular.';
  END IF;
  SELECT year INTO _year FROM public.budget_versions WHERE id = sc.version_id;

  SELECT COALESCE(SUM(amount) FILTER (WHERE bucket IN ('folha', 'despesa')), 0) INTO _f
  FROM public.plan_split(sc.version_id, _scenario_id);
  SELECT COALESCE(SUM(s.amount), 0) INTO _rfin
  FROM public.plan_split(sc.version_id, _scenario_id) s
  JOIN public.units un ON un.id = s.unit_id AND un.kind = 'apoio' WHERE s.bucket = 'receita';

  SELECT COALESCE(SUM(share), 0) INTO _sum_shares
  FROM public.target_unit_shares sh JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
  WHERE sh.scenario_id = _scenario_id;
  IF abs(_sum_shares - 1) > 0.0001 THEN
    RAISE EXCEPTION 'As participações das unidades de negócio somam % por cento, e precisam somar 100.', round(_sum_shares * 100, 2);
  END IF;

  -- Alíquota variável ponderada: participação da unidade × (alíquota dela, ponderada pelos meses)
  FOR u IN SELECT sh.unit_id, sh.share, sh.variable_pct_override
           FROM public.target_unit_shares sh JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
           WHERE sh.scenario_id = _scenario_id AND sh.share > 0
  LOOP
    IF u.variable_pct_override IS NOT NULL THEN
      _vu := u.variable_pct_override;
    ELSE
      _vu := 0;
      FOR w IN SELECT * FROM public.target_weights(_scenario_id, u.unit_id) LOOP
        _vu := _vu + w.weight * COALESCE((SELECT SUM(p.rate) FROM public.variable_rate_parts(u.unit_id, make_date(_year, w.month, 1)) p
                                          WHERE p.included), 0);
      END LOOP;
    END IF;
    _v := _v + u.share * _vu;
  END LOOP;

  IF st.target_kind = 'resultado' THEN
    _a := st.target_value;
    _den := 1 - _v;
    _r := CASE WHEN _den > 0 THEN (_a + _f - _rfin * (1 - st.financial_variable_pct)) / _den END;
    _m := CASE WHEN _r IS NOT NULL AND (_r + _rfin) > 0 THEN _a / (_r + _rfin) END;
  ELSE
    _m := st.target_value;
    _den := 1 - _v - _m;
    _r := CASE WHEN _den > 0 THEN (_f - _rfin * (1 - st.financial_variable_pct - _m)) / _den END;
    _a := CASE WHEN _r IS NOT NULL THEN _m * (_r + _rfin) END;
  END IF;

  DELETE FROM public.revenue_targets WHERE scenario_id = _scenario_id;
  IF _r IS NOT NULL AND _r >= 0 THEN
    INSERT INTO public.revenue_targets (scenario_id, unit_id, month, amount)
    SELECT _scenario_id, sh.unit_id, w2.month, _r * sh.share * w2.weight
    FROM public.target_unit_shares sh
    JOIN public.units un ON un.id = sh.unit_id AND un.kind = 'negocio'
    CROSS JOIN LATERAL public.target_weights(_scenario_id, sh.unit_id) w2
    WHERE sh.scenario_id = _scenario_id AND sh.share > 0;
  END IF;

  UPDATE public.scenario_targets SET
    required_revenue = CASE WHEN _r >= 0 THEN _r END, fixed_costs = _f, financial_revenue = _rfin,
    variable_pct = _v, target_amount = _a, target_margin = _m,
    feasible = (_r IS NOT NULL AND _r >= 0), computed_at = now()
  WHERE scenario_id = _scenario_id
  RETURNING * INTO st;
  RETURN st;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_targets(_scenario_id UUID, _publish BOOLEAN DEFAULT true)
RETURNS public.scenario_targets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  st public.scenario_targets%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Somente o financeiro publica metas.';
  END IF;
  SELECT * INTO st FROM public.scenario_targets WHERE scenario_id = _scenario_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Defina o alvo do cenário antes de publicar.'; END IF;
  IF _publish AND NOT COALESCE(st.feasible, false) THEN
    RAISE EXCEPTION 'Calcule uma meta viável antes de publicar.';
  END IF;
  UPDATE public.scenario_targets SET published_at = CASE WHEN _publish THEN now() END
  WHERE scenario_id = _scenario_id RETURNING * INTO st;
  RETURN st;
END;
$$;

-- Caminho para o alvo: com o plano que existe hoje (o que os líderes lançaram), quanto falta para o alvo
-- e quanto custo teria de cair, separando folha e despesas. Só o financeiro enxerga o conjunto.
CREATE OR REPLACE FUNCTION public.target_gap(_scenario_id UUID)
RETURNS TABLE (revenue NUMERIC, variable_costs NUMERIC, payroll NUMERIC, expenses NUMERIC, result NUMERIC,
  target_amount NUMERIC, gap NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sc AS (SELECT * FROM public.scenarios WHERE id = _scenario_id),
  s AS (
    SELECT COALESCE(SUM(amount) FILTER (WHERE bucket = 'receita'), 0) AS rev,
           COALESCE(SUM(amount) FILTER (WHERE bucket = 'variavel'), 0) AS var,
           COALESCE(SUM(amount) FILTER (WHERE bucket = 'folha'), 0) AS pay,
           COALESCE(SUM(amount) FILTER (WHERE bucket = 'despesa'), 0) AS exp
    FROM sc, public.plan_split(sc.version_id, _scenario_id)
  )
  SELECT s.rev, s.var, s.pay, s.exp, s.rev - s.var - s.pay - s.exp,
         st.target_amount, st.target_amount - (s.rev - s.var - s.pay - s.exp)
  FROM s CROSS JOIN public.scenario_targets st
  WHERE st.scenario_id = _scenario_id AND public.has_role(auth.uid(), 'financeiro')
$$;
REVOKE EXECUTE ON FUNCTION public.compute_targets(UUID), public.publish_targets(UUID, BOOLEAN),
  public.target_gap(UUID) FROM anon;
