-- Fase 1: modelo configurável (docs/plano-evolucao.md, seção 4).
-- Substitui as tabelas de lançamento da Fase 0 (vazias em 18/10/2026) por:
--   versões e cenários · estrutura da DRE · plano de contas · cadastros ·
--   parâmetros com escopo e vigência · regras de cálculo · linhas + valores mensais ·
--   envio/aprovação por unidade. A DRE é calculada no banco (dre_report).

-- ───────────────────────── Limpeza do modelo anterior ─────────────────────────
DROP TABLE IF EXISTS public.revenue_entries, public.payroll_entries, public.expense_entries,
  public.expense_categories, public.people, public.parameters, public.scenarios CASCADE;

-- ───────────────────────── Funções de permissão ─────────────────────────
-- Escrita em uma unidade: financeiro em qualquer uma; líder só nas suas. VP e CEO só leem (D4).
CREATE OR REPLACE FUNCTION public.can_write_unit(_user_id UUID, _unit_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'financeiro')
    OR (public.has_role(_user_id, 'lider')
        AND EXISTS (SELECT 1 FROM public.user_units WHERE user_id = _user_id AND unit_id = _unit_id))
$$;

-- ───────────────────────── Unidades ─────────────────────────
ALTER TABLE public.units
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
  ADD COLUMN omie_department_code TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT units_kind_check CHECK (kind IN ('negocio', 'apoio'));
UPDATE public.units SET sort_order = CASE name
  WHEN 'Agência' THEN 10 WHEN 'Consultoria' THEN 20 WHEN 'Educação' THEN 30 WHEN 'RH' THEN 40
  WHEN 'Financeiro' THEN 50 WHEN 'CRO' THEN 60 WHEN 'ADM' THEN 70 WHEN 'Growth' THEN 80 ELSE 100 END;
GRANT INSERT, UPDATE ON public.units TO authenticated;
CREATE POLICY "Financeiro writes units" ON public.units FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'financeiro'));
CREATE POLICY "Financeiro updates units" ON public.units FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

-- ───────────────────────── Versões e cenários ─────────────────────────
CREATE TABLE public.budget_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'orcamento' CHECK (kind IN ('orcamento', 'forecast')),
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'em_coleta', 'em_aprovacao', 'aprovado', 'travado')),
  base_version_id UUID REFERENCES public.budget_versions(id) ON DELETE SET NULL,
  first_editable_month INT NOT NULL DEFAULT 1 CHECK (first_editable_month BETWEEN 1 AND 12),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budget_versions_one_default ON public.budget_versions (is_default) WHERE is_default;

CREATE TABLE public.scenarios (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revenue_variation NUMERIC NOT NULL DEFAULT 0,
  expense_variation NUMERIC NOT NULL DEFAULT 0,
  -- D3: a variação de despesa não afeta a folha, salvo se o financeiro ligar esta opção.
  applies_to_payroll BOOLEAN NOT NULL DEFAULT false,
  is_official BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, name)
);
CREATE UNIQUE INDEX scenarios_one_official ON public.scenarios (version_id) WHERE is_official;

-- ───────────────────────── Estrutura da DRE e plano de contas ─────────────────────────
CREATE TABLE public.dre_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL,
  -- lancada: soma de contas · calculada: resultado de regras · subtotal: soma com sinal das
  -- linhas lançadas/calculadas acima dela · percentual: numerador / denominador.
  kind TEXT NOT NULL CHECK (kind IN ('lancada', 'calculada', 'subtotal', 'percentual')),
  sign SMALLINT NOT NULL DEFAULT -1 CHECK (sign IN (-1, 1)),
  numerator_line_id UUID REFERENCES public.dre_lines(id),
  denominator_line_id UUID REFERENCES public.dre_lines(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'percentual' OR (numerator_line_id IS NOT NULL AND denominator_line_id IS NOT NULL))
);

CREATE TABLE public.accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL UNIQUE,
  -- Em qual grade a conta aparece: Receitas, Despesas ou Folha.
  kind TEXT NOT NULL CHECK (kind IN ('receita', 'despesa', 'folha')),
  dre_line_id UUID NOT NULL REFERENCES public.dre_lines(id),
  unit_ids UUID[], -- NULL = disponível para todas as unidades
  generates_tax_credit BOOLEAN NOT NULL DEFAULT false, -- Lucro Real: crédito de PIS/COFINS
  omie_category_code TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Cadastros ─────────────────────────
CREATE TABLE public.revenue_types (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  recurrence_months INT CHECK (recurrence_months BETWEEN 1 AND 12), -- preenche N meses
  max_months INT CHECK (max_months BETWEEN 1 AND 12), -- alerta acima de N meses
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.contract_types (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES public.accounts(id), -- conta da remuneração (salário, pró-labore, bolsa)
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  document TEXT,
  omie_id TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  unit_id UUID REFERENCES public.units(id),
  revenue_type_id UUID REFERENCES public.revenue_types(id),
  omie_code TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Parâmetros e regras ─────────────────────────
CREATE TABLE public.parameter_definitions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  value_type TEXT NOT NULL DEFAULT 'percent' CHECK (value_type IN ('percent', 'currency')),
  -- Escopos em que um valor pode ser cadastrado. 'global' = vale para tudo.
  allowed_scopes TEXT[] NOT NULL DEFAULT ARRAY['global'],
  min_value NUMERIC,
  max_value NUMERIC,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allowed_scopes <@ ARRAY['global', 'unit', 'product', 'contract_type', 'revenue_type'])
);

-- Valor com vigência: vale a partir de valid_from. Escopo NULL = qualquer. Na resolução,
-- o valor mais específico (mais escopos preenchidos) prevalece; empate → vigência mais recente.
CREATE TABLE public.parameter_values (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  definition_id UUID NOT NULL REFERENCES public.parameter_definitions(id) ON DELETE CASCADE,
  value NUMERIC NOT NULL,
  valid_from DATE NOT NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  contract_type_id UUID REFERENCES public.contract_types(id) ON DELETE CASCADE,
  revenue_type_id UUID REFERENCES public.revenue_types(id) ON DELETE CASCADE,
  note TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX parameter_values_lookup ON public.parameter_values (definition_id, valid_from);

CREATE TABLE public.calc_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  target_dre_line_id UUID NOT NULL REFERENCES public.dre_lines(id),
  parameter_definition_id UUID NOT NULL REFERENCES public.parameter_definitions(id),
  -- Base: receita · despesa · salario (remuneração das pessoas) · headcount (1 por pessoa ativa no mês)
  base_kind TEXT NOT NULL CHECK (base_kind IN ('receita', 'despesa', 'salario', 'headcount')),
  revenue_type_ids UUID[], -- filtros opcionais; NULL = sem filtro
  contract_type_ids UUID[],
  account_ids UUID[],
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Lançamentos ─────────────────────────
CREATE TABLE public.people (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id),
  name TEXT NOT NULL,
  role_title TEXT,
  contract_type_id UUID NOT NULL REFERENCES public.contract_types(id),
  base_salary NUMERIC NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  start_month INT CHECK (start_month BETWEEN 1 AND 12), -- NULL = já está no início do ano
  end_month INT CHECK (end_month BETWEEN 1 AND 12), -- NULL = fica até o fim do ano
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_month IS NULL OR end_month IS NULL OR start_month <= end_month)
);

-- Reajuste: a partir de month, o salário passa a ser new_salary.
CREATE TABLE public.salary_changes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  new_salary NUMERIC NOT NULL CHECK (new_salary >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, month)
);

CREATE TABLE public.events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id),
  product_id UUID REFERENCES public.products(id),
  revenue_type_id UUID NOT NULL REFERENCES public.revenue_types(id),
  name TEXT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  quantity NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  price NUMERIC NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost_per_participant NUMERIC NOT NULL DEFAULT 0 CHECK (cost_per_participant >= 0),
  fixed_cost NUMERIC NOT NULL DEFAULT 0 CHECK (fixed_cost >= 0),
  revenue_account_id UUID NOT NULL REFERENCES public.accounts(id),
  cost_account_id UUID NOT NULL REFERENCES public.accounts(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.plan_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id),
  account_id UUID NOT NULL REFERENCES public.accounts(id),
  description TEXT,
  client_id UUID REFERENCES public.clients(id),
  product_id UUID REFERENCES public.products(id),
  revenue_type_id UUID REFERENCES public.revenue_types(id),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'gerada')),
  sort_order INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_lines_version_unit ON public.plan_lines (version_id, unit_id);

CREATE TABLE public.plan_values (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  line_id UUID NOT NULL REFERENCES public.plan_lines(id) ON DELETE CASCADE,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_id, month)
);

-- ───────────────────────── Envio e aprovação ─────────────────────────
CREATE TABLE public.unit_submissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES public.budget_versions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id),
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'enviado', 'aprovado', 'devolvido')),
  comment TEXT,
  submitted_by UUID REFERENCES auth.users(id),
  submitted_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, unit_id)
);

-- ───────────────────────── Validações e travas ─────────────────────────
-- Bloqueia alterações conforme o status da versão e o envio da unidade.
-- Financeiro: só não altera versão travada. Líder: só em versão "em coleta", unidade não enviada
-- nem aprovada, e a partir do primeiro mês editável.
CREATE OR REPLACE FUNCTION public.assert_editable(_version_id UUID, _unit_id UUID, _month INT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v public.budget_versions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF; -- service role / migrations
  SELECT * INTO v FROM public.budget_versions WHERE id = _version_id;
  IF v.status = 'travado' THEN
    RAISE EXCEPTION 'A versão "%" está travada e não aceita alterações.', v.name;
  END IF;
  IF public.has_role(auth.uid(), 'financeiro') THEN RETURN; END IF;
  IF v.status <> 'em_coleta' THEN
    RAISE EXCEPTION 'A versão "%" não está aberta para lançamentos.', v.name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.unit_submissions
             WHERE version_id = _version_id AND unit_id = _unit_id AND status IN ('enviado', 'aprovado')) THEN
    RAISE EXCEPTION 'Esta unidade já foi enviada para aprovação. Peça ao financeiro para devolver.';
  END IF;
  IF _month IS NOT NULL AND _month < v.first_editable_month THEN
    RAISE EXCEPTION 'Meses anteriores a % não podem ser alterados nesta versão.', v.first_editable_month;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_editable() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  l public.plan_lines%ROWTYPE;
  p public.people%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'plan_values' THEN
    SELECT * INTO l FROM public.plan_lines WHERE id = r.line_id;
    IF FOUND THEN PERFORM public.assert_editable(l.version_id, l.unit_id, r.month); END IF;
  ELSIF TG_TABLE_NAME = 'salary_changes' THEN
    SELECT * INTO p FROM public.people WHERE id = r.person_id;
    IF FOUND THEN PERFORM public.assert_editable(p.version_id, p.unit_id, r.month); END IF;
  ELSIF TG_TABLE_NAME = 'events' THEN
    PERFORM public.assert_editable(r.version_id, r.unit_id, r.month);
  ELSE -- plan_lines, people
    PERFORM public.assert_editable(r.version_id, r.unit_id, NULL);
  END IF;
  RETURN r;
END;
$$;

CREATE TRIGGER editable_plan_lines BEFORE INSERT OR UPDATE OR DELETE ON public.plan_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_editable();
CREATE TRIGGER editable_plan_values BEFORE INSERT OR UPDATE OR DELETE ON public.plan_values
  FOR EACH ROW EXECUTE FUNCTION public.enforce_editable();
CREATE TRIGGER editable_people BEFORE INSERT OR UPDATE OR DELETE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.enforce_editable();
CREATE TRIGGER editable_salary_changes BEFORE INSERT OR UPDATE OR DELETE ON public.salary_changes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_editable();
CREATE TRIGGER editable_events BEFORE INSERT OR UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_editable();

CREATE OR REPLACE FUNCTION public.validate_plan_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.accounts WHERE id = NEW.account_id;
  IF a.unit_ids IS NOT NULL AND NOT NEW.unit_id = ANY (a.unit_ids) THEN
    RAISE EXCEPTION 'A conta "%" não está disponível para esta unidade.', a.name;
  END IF;
  IF a.kind = 'receita' AND NEW.revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Linhas de receita precisam de um tipo de receita.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_plan_lines BEFORE INSERT OR UPDATE ON public.plan_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_plan_line();

-- Folha (contas do tipo folha) só o financeiro grava.
CREATE OR REPLACE FUNCTION public.can_write_line(_user_id UUID, _line_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.plan_lines l JOIN public.accounts a ON a.id = l.account_id
    WHERE l.id = _line_id
      AND public.can_write_unit(_user_id, l.unit_id)
      AND (a.kind <> 'folha' OR public.has_role(_user_id, 'financeiro'))
  )
$$;

CREATE OR REPLACE FUNCTION public.account_kind(_account_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT kind FROM public.accounts WHERE id = _account_id
$$;

-- O app nunca fica sem administrador: não é possível remover o último financeiro.
CREATE OR REPLACE FUNCTION public.keep_last_financeiro() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.role = 'financeiro' AND (TG_OP = 'DELETE' OR NEW.role <> 'financeiro')
     AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'financeiro' AND id <> OLD.id) THEN
    RAISE EXCEPTION 'Não é possível remover o último usuário financeiro. Cadastre outro financeiro antes.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER keep_last_financeiro BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.keep_last_financeiro();

-- ───────────────────────── RLS ─────────────────────────
-- Cadastros e configuração: todos os usuários logados leem; só o financeiro grava.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['budget_versions', 'scenarios', 'dre_lines', 'accounts', 'revenue_types',
    'contract_types', 'clients', 'products', 'parameter_definitions', 'parameter_values', 'calc_rules']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Authenticated read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
  END LOOP;
END $$;

-- Lançamentos.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_lines, public.plan_values, public.people,
  public.salary_changes, public.events TO authenticated;
GRANT ALL ON public.plan_lines, public.plan_values, public.people, public.salary_changes, public.events,
  public.unit_submissions TO service_role;
GRANT SELECT ON public.unit_submissions TO authenticated;
ALTER TABLE public.plan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unit_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read lines by unit" ON public.plan_lines FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Write lines by unit" ON public.plan_lines FOR ALL TO authenticated
  USING (public.can_write_unit(auth.uid(), unit_id)
         AND (public.account_kind(account_id) <> 'folha' OR public.has_role(auth.uid(), 'financeiro')))
  WITH CHECK (public.can_write_unit(auth.uid(), unit_id)
         AND (public.account_kind(account_id) <> 'folha' OR public.has_role(auth.uid(), 'financeiro')));

CREATE POLICY "Read values by unit" ON public.plan_values FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.plan_lines l WHERE l.id = line_id AND public.has_unit(auth.uid(), l.unit_id)));
CREATE POLICY "Write values by line" ON public.plan_values FOR ALL TO authenticated
  USING (public.can_write_line(auth.uid(), line_id)) WITH CHECK (public.can_write_line(auth.uid(), line_id));

CREATE POLICY "Read people by unit" ON public.people FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes people" ON public.people FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

CREATE POLICY "Read salary changes by unit" ON public.salary_changes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.has_unit(auth.uid(), p.unit_id)));
CREATE POLICY "Financeiro writes salary changes" ON public.salary_changes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'financeiro')) WITH CHECK (public.has_role(auth.uid(), 'financeiro'));

CREATE POLICY "Read events by unit" ON public.events FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Write events by unit" ON public.events FOR ALL TO authenticated
  USING (public.can_write_unit(auth.uid(), unit_id)) WITH CHECK (public.can_write_unit(auth.uid(), unit_id));

-- Envio/aprovação: leitura por unidade; escrita só pela função set_unit_status.
CREATE POLICY "Read submissions by unit" ON public.unit_submissions FOR SELECT TO authenticated
  USING (public.has_unit(auth.uid(), unit_id));

-- D6: líder não vê outros usuários.
DROP POLICY "Authenticated read profiles" ON public.profiles;
CREATE POLICY "Read own profile or management" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_any_role(auth.uid(), ARRAY['financeiro', 'vp', 'ceo']::public.app_role[]));

-- ───────────────────────── Ações (RPC) ─────────────────────────
CREATE OR REPLACE FUNCTION public.set_official_scenario(_scenario_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _version UUID;
BEGIN
  IF NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Apenas o financeiro define o cenário oficial.';
  END IF;
  SELECT version_id INTO _version FROM public.scenarios WHERE id = _scenario_id;
  IF _version IS NULL THEN RAISE EXCEPTION 'Cenário não encontrado.'; END IF;
  UPDATE public.scenarios SET is_official = false WHERE version_id = _version AND is_official;
  UPDATE public.scenarios SET is_official = true WHERE id = _scenario_id;
END;
$$;

-- enviado: líder (da unidade) ou financeiro, a partir de rascunho/devolvido.
-- aprovado / devolvido / rascunho (reabrir): só o financeiro.
CREATE OR REPLACE FUNCTION public.set_unit_status(_version_id UUID, _unit_id UUID, _status TEXT, _comment TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _current TEXT;
  _vstatus TEXT;
BEGIN
  SELECT status INTO _vstatus FROM public.budget_versions WHERE id = _version_id;
  IF _vstatus IS NULL THEN RAISE EXCEPTION 'Versão não encontrada.'; END IF;
  IF _vstatus = 'travado' THEN RAISE EXCEPTION 'A versão está travada.'; END IF;
  SELECT status INTO _current FROM public.unit_submissions WHERE version_id = _version_id AND unit_id = _unit_id;
  _current := COALESCE(_current, 'rascunho');

  IF _status = 'enviado' THEN
    IF NOT public.can_write_unit(auth.uid(), _unit_id) THEN
      RAISE EXCEPTION 'Você não pode enviar esta unidade.';
    END IF;
    IF _current NOT IN ('rascunho', 'devolvido') THEN
      RAISE EXCEPTION 'A unidade já foi enviada.';
    END IF;
    INSERT INTO public.unit_submissions (version_id, unit_id, status, comment, submitted_by, submitted_at)
    VALUES (_version_id, _unit_id, 'enviado', _comment, auth.uid(), now())
    ON CONFLICT (version_id, unit_id) DO UPDATE
      SET status = 'enviado', comment = EXCLUDED.comment, submitted_by = auth.uid(), submitted_at = now(),
          updated_at = now();
  ELSIF _status IN ('aprovado', 'devolvido', 'rascunho') THEN
    IF NOT public.has_role(auth.uid(), 'financeiro') THEN
      RAISE EXCEPTION 'Apenas o financeiro aprova, devolve ou reabre unidades.';
    END IF;
    INSERT INTO public.unit_submissions (version_id, unit_id, status, comment, reviewed_by, reviewed_at)
    VALUES (_version_id, _unit_id, _status, _comment, auth.uid(), now())
    ON CONFLICT (version_id, unit_id) DO UPDATE
      SET status = _status, comment = EXCLUDED.comment, reviewed_by = auth.uid(), reviewed_at = now(),
          updated_at = now();
  ELSE
    RAISE EXCEPTION 'Status inválido: %', _status;
  END IF;
END;
$$;

-- Copia uma versão inteira (cenários, pessoas, reajustes, eventos, linhas e valores).
CREATE OR REPLACE FUNCTION public.copy_version(_source_id UUID, _name TEXT, _year INT, _kind TEXT DEFAULT 'forecast')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _new UUID;
  _old_id UUID;
  _new_id UUID;
  rec RECORD;
BEGIN
  IF NOT public.has_role(auth.uid(), 'financeiro') THEN
    RAISE EXCEPTION 'Apenas o financeiro cria versões.';
  END IF;
  INSERT INTO public.budget_versions (year, name, kind, status, base_version_id, first_editable_month)
  SELECT _year, _name, _kind, 'rascunho', id, first_editable_month FROM public.budget_versions WHERE id = _source_id
  RETURNING id INTO _new;
  IF _new IS NULL THEN RAISE EXCEPTION 'Versão de origem não encontrada.'; END IF;

  INSERT INTO public.scenarios (version_id, name, revenue_variation, expense_variation, applies_to_payroll, is_official, sort_order)
  SELECT _new, name, revenue_variation, expense_variation, applies_to_payroll, is_official, sort_order
  FROM public.scenarios WHERE version_id = _source_id;

  FOR rec IN SELECT * FROM public.people WHERE version_id = _source_id LOOP
    INSERT INTO public.people (version_id, unit_id, name, role_title, contract_type_id, base_salary, start_month, end_month)
    VALUES (_new, rec.unit_id, rec.name, rec.role_title, rec.contract_type_id, rec.base_salary, rec.start_month, rec.end_month)
    RETURNING id INTO _new_id;
    INSERT INTO public.salary_changes (person_id, month, new_salary)
    SELECT _new_id, month, new_salary FROM public.salary_changes WHERE person_id = rec.id;
  END LOOP;

  INSERT INTO public.events (version_id, unit_id, product_id, revenue_type_id, name, month, quantity, price,
    cost_per_participant, fixed_cost, revenue_account_id, cost_account_id, created_by)
  SELECT _new, unit_id, product_id, revenue_type_id, name, month, quantity, price,
    cost_per_participant, fixed_cost, revenue_account_id, cost_account_id, auth.uid()
  FROM public.events WHERE version_id = _source_id;

  FOR rec IN SELECT * FROM public.plan_lines WHERE version_id = _source_id LOOP
    _old_id := rec.id;
    INSERT INTO public.plan_lines (version_id, unit_id, account_id, description, client_id, product_id,
      revenue_type_id, origin, sort_order, created_by)
    VALUES (_new, rec.unit_id, rec.account_id, rec.description, rec.client_id, rec.product_id,
      rec.revenue_type_id, rec.origin, rec.sort_order, auth.uid())
    RETURNING id INTO _new_id;
    INSERT INTO public.plan_values (line_id, month, amount)
    SELECT _new_id, month, amount FROM public.plan_values WHERE line_id = _old_id;
  END LOOP;

  RETURN _new;
END;
$$;

-- ───────────────────────── Cálculo da DRE ─────────────────────────
-- Valor de um parâmetro em uma data para uma combinação de escopos.
CREATE OR REPLACE FUNCTION public.param_value(_definition_id UUID, _ref DATE, _unit_id UUID,
  _product_id UUID, _contract_type_id UUID, _revenue_type_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT pv.value FROM public.parameter_values pv
  WHERE pv.definition_id = _definition_id AND pv.valid_from <= _ref
    AND (pv.unit_id IS NULL OR pv.unit_id = _unit_id)
    AND (pv.product_id IS NULL OR pv.product_id = _product_id)
    AND (pv.contract_type_id IS NULL OR pv.contract_type_id = _contract_type_id)
    AND (pv.revenue_type_id IS NULL OR pv.revenue_type_id = _revenue_type_id)
  ORDER BY (pv.unit_id IS NOT NULL)::INT + (pv.product_id IS NOT NULL)::INT
         + (pv.contract_type_id IS NOT NULL)::INT + (pv.revenue_type_id IS NOT NULL)::INT DESC,
           pv.valid_from DESC, pv.created_at DESC
  LIMIT 1
$$;

-- Linhas-base do plano (com a variação do cenário aplicada). SECURITY INVOKER: o RLS
-- garante que cada usuário só some as unidades que pode ver.
CREATE OR REPLACE FUNCTION public.plan_base_rows(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, month INT, row_kind TEXT, account_id UUID, dre_line_id UUID,
  revenue_type_id UUID, product_id UUID, contract_type_id UUID, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT COALESCE(revenue_variation, 0) AS rv, COALESCE(expense_variation, 0) AS ev,
           COALESCE(applies_to_payroll, false) AS ap
    FROM (SELECT 1) one LEFT JOIN public.scenarios ON id = _scenario_id
  )
  -- Linhas lançadas nas grades
  SELECT l.unit_id, v.month, a.kind, a.id, a.dre_line_id, l.revenue_type_id, l.product_id, NULL::UUID,
    v.amount * CASE a.kind WHEN 'receita' THEN 1 + s.rv
                           WHEN 'despesa' THEN 1 + s.ev
                           ELSE CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END END
  FROM public.plan_lines l
  JOIN public.plan_values v ON v.line_id = l.id
  JOIN public.accounts a ON a.id = l.account_id
  CROSS JOIN s
  WHERE l.version_id = _version_id AND (_unit_ids IS NULL OR l.unit_id = ANY (_unit_ids))
  UNION ALL
  -- Eventos: receita = vagas × preço
  SELECT e.unit_id, e.month, 'receita', e.revenue_account_id, a.dre_line_id, e.revenue_type_id, e.product_id,
    NULL::UUID, e.quantity * e.price * (1 + s.rv)
  FROM public.events e JOIN public.accounts a ON a.id = e.revenue_account_id CROSS JOIN s
  WHERE e.version_id = _version_id AND (_unit_ids IS NULL OR e.unit_id = ANY (_unit_ids))
  UNION ALL
  -- Eventos: despesa de produto = vagas × custo por participante + custo fixo
  SELECT e.unit_id, e.month, 'despesa', e.cost_account_id, a.dre_line_id, e.revenue_type_id, e.product_id,
    NULL::UUID, (e.quantity * e.cost_per_participant + e.fixed_cost) * (1 + s.ev)
  FROM public.events e JOIN public.accounts a ON a.id = e.cost_account_id CROSS JOIN s
  WHERE e.version_id = _version_id AND (_unit_ids IS NULL OR e.unit_id = ANY (_unit_ids))
  UNION ALL
  -- Pessoas: remuneração do mês (último reajuste até o mês, senão o salário base)
  SELECT p.unit_id, m.month, 'salario', ct.account_id, a.dre_line_id, NULL::UUID, NULL::UUID, p.contract_type_id,
    COALESCE((SELECT sc.new_salary FROM public.salary_changes sc
              WHERE sc.person_id = p.id AND sc.month <= m.month ORDER BY sc.month DESC LIMIT 1), p.base_salary)
    * CASE WHEN s.ap THEN 1 + s.ev ELSE 1 END
  FROM public.people p
  JOIN public.contract_types ct ON ct.id = p.contract_type_id
  JOIN public.accounts a ON a.id = ct.account_id
  CROSS JOIN generate_series(1, 12) AS m(month)
  CROSS JOIN s
  WHERE p.version_id = _version_id AND (_unit_ids IS NULL OR p.unit_id = ANY (_unit_ids))
    AND m.month >= COALESCE(p.start_month, 1) AND m.month <= COALESCE(p.end_month, 12)
  UNION ALL
  -- Headcount: 1 por pessoa ativa no mês (base para benefícios por pessoa)
  SELECT p.unit_id, m.month, 'headcount', NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, p.contract_type_id, 1
  FROM public.people p
  CROSS JOIN generate_series(1, 12) AS m(month)
  WHERE p.version_id = _version_id AND (_unit_ids IS NULL OR p.unit_id = ANY (_unit_ids))
    AND m.month >= COALESCE(p.start_month, 1) AND m.month <= COALESCE(p.end_month, 12)
$$;

-- Valores por unidade, linha da DRE e mês: linhas lançadas, calculadas (regras) e subtotais.
CREATE OR REPLACE FUNCTION public.dre_unit_values(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (unit_id UUID, dre_line_id UUID, month INT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH yr AS (SELECT year FROM public.budget_versions WHERE id = _version_id),
  base AS (SELECT * FROM public.plan_base_rows(_version_id, _scenario_id, _unit_ids)),
  calc AS (
    SELECT b.unit_id, r.target_dre_line_id AS dre_line_id, b.month,
      b.amount * COALESCE(public.param_value(r.parameter_definition_id, make_date(yr.year, b.month, 1),
        b.unit_id, b.product_id, b.contract_type_id, b.revenue_type_id), 0) AS amount
    FROM base b
    CROSS JOIN yr
    JOIN public.calc_rules r ON r.active AND r.base_kind = b.row_kind
      AND (r.revenue_type_ids IS NULL OR b.revenue_type_id = ANY (r.revenue_type_ids))
      AND (r.contract_type_ids IS NULL OR b.contract_type_id = ANY (r.contract_type_ids))
      AND (r.account_ids IS NULL OR b.account_id = ANY (r.account_ids))
  ),
  leaf AS (
    SELECT x.unit_id, x.dre_line_id, x.month, SUM(x.amount) AS amount
    FROM (
      SELECT b.unit_id, b.dre_line_id, b.month, b.amount FROM base b WHERE b.row_kind <> 'headcount'
      UNION ALL
      SELECT c.unit_id, c.dre_line_id, c.month, c.amount FROM calc c
    ) x
    GROUP BY x.unit_id, x.dre_line_id, x.month
  ),
  cells AS (SELECT DISTINCT leaf.unit_id, leaf.month FROM leaf)
  SELECT leaf.unit_id, leaf.dre_line_id, leaf.month, leaf.amount FROM leaf
  UNION ALL
  SELECT c.unit_id, st.id, c.month,
    COALESCE((SELECT SUM(dl.sign * lf.amount) FROM leaf lf JOIN public.dre_lines dl ON dl.id = lf.dre_line_id
              WHERE lf.unit_id = c.unit_id AND lf.month = c.month
                AND dl.kind IN ('lancada', 'calculada') AND dl.sort_order < st.sort_order), 0)
  FROM cells c CROSS JOIN public.dre_lines st
  WHERE st.kind = 'subtotal' AND st.active
$$;

-- Relatório da DRE para um conjunto de unidades: todas as linhas ativas × meses 1–12 e 0 (= ano).
-- Linhas percentuais = numerador / denominador, calculadas sobre os totais já somados.
CREATE OR REPLACE FUNCTION public.dre_report(_version_id UUID, _scenario_id UUID, _unit_ids UUID[] DEFAULT NULL)
RETURNS TABLE (dre_line_id UUID, month INT, amount NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH v AS (
    SELECT u.dre_line_id, u.month, SUM(u.amount) AS amount
    FROM public.dre_unit_values(_version_id, _scenario_id, _unit_ids) u
    GROUP BY u.dre_line_id, u.month
  ),
  months AS (SELECT generate_series(0, 12) AS month),
  grid AS (
    SELECT dl.id AS dre_line_id, m.month,
      CASE WHEN m.month = 0 THEN (SELECT SUM(v.amount) FROM v WHERE v.dre_line_id = dl.id)
           ELSE (SELECT v.amount FROM v WHERE v.dre_line_id = dl.id AND v.month = m.month) END AS amount
    FROM public.dre_lines dl CROSS JOIN months m
    WHERE dl.active AND dl.kind <> 'percentual'
  )
  SELECT g.dre_line_id, g.month, COALESCE(g.amount, 0) FROM grid g
  UNION ALL
  SELECT p.id, m.month,
    COALESCE((SELECT g.amount FROM grid g WHERE g.dre_line_id = p.numerator_line_id AND g.month = m.month)
      / NULLIF((SELECT g.amount FROM grid g WHERE g.dre_line_id = p.denominator_line_id AND g.month = m.month), 0), 0)
  FROM public.dre_lines p CROSS JOIN months m
  WHERE p.kind = 'percentual' AND p.active
$$;

-- ───────────────────────── Auditoria e updated_at ─────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'budget_versions', 'scenarios', 'dre_lines', 'accounts', 'revenue_types',
    'contract_types', 'clients', 'products', 'parameter_definitions', 'parameter_values', 'calc_rules',
    'people', 'salary_changes', 'events', 'plan_lines', 'plan_values', 'unit_submissions', 'user_roles', 'user_units']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['units', 'budget_versions', 'scenarios', 'dre_lines', 'accounts', 'revenue_types',
    'contract_types', 'clients', 'products', 'parameter_definitions', 'calc_rules', 'people', 'salary_changes',
    'events', 'plan_lines', 'plan_values']
  LOOP
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- ───────────────────────── Permissões de execução ─────────────────────────
REVOKE EXECUTE ON FUNCTION public.can_write_unit(UUID, UUID), public.can_write_line(UUID, UUID),
  public.account_kind(UUID), public.assert_editable(UUID, UUID, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_editable(), public.validate_plan_line(),
  public.keep_last_financeiro() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_official_scenario(UUID), public.set_unit_status(UUID, UUID, TEXT, TEXT),
  public.copy_version(UUID, TEXT, INT, TEXT), public.param_value(UUID, DATE, UUID, UUID, UUID, UUID),
  public.plan_base_rows(UUID, UUID, UUID[]), public.dre_unit_values(UUID, UUID, UUID[]),
  public.dre_report(UUID, UUID, UUID[]) FROM anon;

-- ───────────────────────── Dados iniciais (todos editáveis pela tela) ─────────────────────────
INSERT INTO public.dre_lines (code, name, sort_order, kind, sign) VALUES
  ('receita_bruta', 'Receita bruta', 10, 'lancada', 1),
  ('impostos', 'Impostos sobre a receita', 20, 'calculada', -1),
  ('despesas_produtos', 'Despesas de produtos', 30, 'lancada', -1),
  ('custos_indiretos', 'Custos indiretos (folha, encargos e benefícios)', 40, 'lancada', -1),
  ('despesas', 'Despesas', 50, 'lancada', -1),
  ('comissionamento', 'Comissionamento', 60, 'calculada', -1),
  ('contribuicao_liquida', 'Contribuição líquida', 70, 'subtotal', 1);
INSERT INTO public.dre_lines (code, name, sort_order, kind, sign, numerator_line_id, denominator_line_id)
SELECT 'mcl', '%MCL', 80, 'percentual', 1,
  (SELECT id FROM public.dre_lines WHERE code = 'contribuicao_liquida'),
  (SELECT id FROM public.dre_lines WHERE code = 'receita_bruta');

INSERT INTO public.accounts (name, kind, dre_line_id, sort_order)
SELECT a.name, a.kind, dl.id, a.ord FROM (VALUES
  ('Receita de serviços', 'receita', 'receita_bruta', 10),
  ('Receita de educação', 'receita', 'receita_bruta', 20),
  ('Despesas de produtos', 'despesa', 'despesas_produtos', 30),
  ('Salários CLT', 'folha', 'custos_indiretos', 40),
  ('Pró-labore', 'folha', 'custos_indiretos', 50),
  ('Bolsa de estágio (CIEE)', 'folha', 'custos_indiretos', 60),
  ('Benefícios', 'folha', 'custos_indiretos', 70),
  ('Rescisões', 'folha', 'custos_indiretos', 80),
  ('Aluguel e condomínio', 'despesa', 'despesas', 90),
  ('Software e ferramentas', 'despesa', 'despesas', 100),
  ('Marketing', 'despesa', 'despesas', 110),
  ('Viagens', 'despesa', 'despesas', 120),
  ('Outras despesas', 'despesa', 'despesas', 130)
) AS a(name, kind, line, ord) JOIN public.dre_lines dl ON dl.code = a.line;

INSERT INTO public.revenue_types (name, recurrence_months, max_months, sort_order) VALUES
  ('Recorrente 6 meses', 6, NULL, 10),
  ('Recorrente 12 meses', 12, NULL, 20),
  ('Variável (até 3 meses)', NULL, 3, 30),
  ('Parceiros', NULL, NULL, 40),
  ('Educação', NULL, NULL, 50);

INSERT INTO public.contract_types (name, account_id, sort_order)
SELECT c.name, a.id, c.ord FROM (VALUES
  ('CLT', 'Salários CLT', 10),
  ('Sócio (pró-labore)', 'Pró-labore', 20),
  ('Estagiário (CIEE)', 'Bolsa de estágio (CIEE)', 30)
) AS c(name, account, ord) JOIN public.accounts a ON a.name = c.account;

-- Sem valores: o financeiro informa na página Parâmetros (D1). Lucro Real: PIS, COFINS e ISS
-- separados (proposta da seção 8 do plano, a confirmar com a contabilidade).
INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order) VALUES
  ('pis', 'PIS', 'Alíquota de PIS sobre a receita.', 'percent', ARRAY['global'], 0, 1, 10),
  ('cofins', 'COFINS', 'Alíquota de COFINS sobre a receita.', 'percent', ARRAY['global'], 0, 1, 20),
  ('iss', 'ISS', 'Alíquota de ISS sobre a receita de serviços.', 'percent', ARRAY['global'], 0, 1, 30),
  ('comissao_comercial', 'Comissão comercial', 'Sobre a receita de todos os tipos, exceto parceiros (inclui Educação).', 'percent', ARRAY['global', 'unit', 'product'], 0, 1, 40),
  ('comissao_parceiro', 'Comissão de parceiro', 'Sobre a receita do tipo Parceiros.', 'percent', ARRAY['global', 'unit', 'product'], 0, 1, 50),
  ('encargos', 'Encargos sobre a remuneração', 'INSS patronal, FGTS, RAT etc., por vínculo.', 'percent', ARRAY['global', 'contract_type'], 0, 2, 60),
  ('provisao_13_ferias', 'Provisão de 13º e férias', 'Provisão mensal sobre a remuneração, por vínculo.', 'percent', ARRAY['global', 'contract_type'], 0, 1, 70),
  ('beneficios_por_pessoa', 'Benefícios por pessoa (R$/mês)', 'Valor mensal por pessoa ativa, por vínculo ou unidade.', 'currency', ARRAY['global', 'unit', 'contract_type'], 0, NULL, 80);

INSERT INTO public.calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, revenue_type_ids, sort_order)
SELECT r.name, dl.id, pd.id, r.base, r.types, r.ord FROM (VALUES
  ('PIS sobre a receita', 'impostos', 'pis', 'receita', NULL::UUID[], 10),
  ('COFINS sobre a receita', 'impostos', 'cofins', 'receita', NULL::UUID[], 20),
  ('ISS sobre a receita', 'impostos', 'iss', 'receita', NULL::UUID[], 30),
  ('Comissão comercial', 'comissionamento', 'comissao_comercial', 'receita',
    (SELECT array_agg(id) FROM public.revenue_types WHERE name <> 'Parceiros'), 40),
  ('Comissão de parceiro', 'comissionamento', 'comissao_parceiro', 'receita',
    (SELECT array_agg(id) FROM public.revenue_types WHERE name = 'Parceiros'), 50),
  ('Encargos', 'custos_indiretos', 'encargos', 'salario', NULL::UUID[], 60),
  ('Provisão de 13º e férias', 'custos_indiretos', 'provisao_13_ferias', 'salario', NULL::UUID[], 70),
  ('Benefícios por pessoa', 'custos_indiretos', 'beneficios_por_pessoa', 'headcount', NULL::UUID[], 80)
) AS r(name, line, param, base, types, ord)
JOIN public.dre_lines dl ON dl.code = r.line
JOIN public.parameter_definitions pd ON pd.key = r.param;

INSERT INTO public.budget_versions (year, name, kind, status, is_default)
VALUES (2027, 'Orçamento 2027', 'orcamento', 'em_coleta', true);

INSERT INTO public.scenarios (version_id, name, revenue_variation, expense_variation, is_official, sort_order)
SELECT id, s.name, s.rv, s.ev, s.official, s.ord FROM public.budget_versions,
  (VALUES ('Realista', 0, 0, true, 10), ('Otimista', 0, 0, false, 20), ('Conservador', 0, 0, false, 30))
  AS s(name, rv, ev, official, ord)
WHERE budget_versions.name = 'Orçamento 2027';
