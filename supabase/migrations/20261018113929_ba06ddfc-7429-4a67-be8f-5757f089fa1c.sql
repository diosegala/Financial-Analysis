CREATE TYPE public.app_role AS ENUM ('financeiro', 'vp', 'ceo', 'lider');

CREATE TABLE public.units (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'negocio',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.units TO authenticated;
GRANT ALL ON public.units TO service_role;
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read units" ON public.units FOR SELECT TO authenticated USING (true);

INSERT INTO public.units (name, kind) VALUES
  ('Agência','negocio'),('Consultoria','negocio'),('Educação','negocio'),
  ('RH','apoio'),('Financeiro','apoio'),('CRO','apoio'),('ADM','apoio'),('Growth','apoio');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name) VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.user_roles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID, _roles public.app_role[]) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles))
$$;

CREATE TABLE public.user_units (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  UNIQUE (user_id, unit_id)
);
GRANT SELECT ON public.user_units TO authenticated;
GRANT ALL ON public.user_units TO service_role;
ALTER TABLE public.user_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own units" ON public.user_units FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.has_role(auth.uid(),'financeiro'));

CREATE OR REPLACE FUNCTION public.has_unit(_user_id UUID, _unit_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, ARRAY['financeiro','vp','ceo']::public.app_role[])
    OR EXISTS (SELECT 1 FROM public.user_units WHERE user_id = _user_id AND unit_id = _unit_id)
$$;

CREATE TABLE public.scenarios (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  revenue_variation NUMERIC NOT NULL DEFAULT 0,
  expense_variation NUMERIC NOT NULL DEFAULT 0,
  is_official BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.scenarios TO authenticated;
GRANT ALL ON public.scenarios TO service_role;
ALTER TABLE public.scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read scenarios" ON public.scenarios FOR SELECT TO authenticated USING (true);
CREATE POLICY "Financeiro writes scenarios" ON public.scenarios FOR ALL TO authenticated USING (public.has_role(auth.uid(),'financeiro')) WITH CHECK (public.has_role(auth.uid(),'financeiro'));
INSERT INTO public.scenarios (name, is_official) VALUES ('Realista', true), ('Otimista', false), ('Conservador', false);

CREATE TABLE public.revenue_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  year INT NOT NULL DEFAULT 2027,
  month INT NOT NULL,
  client_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  revenue_type TEXT NOT NULL DEFAULT 'variavel',
  amount NUMERIC NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.revenue_entries TO authenticated;
GRANT ALL ON public.revenue_entries TO service_role;
ALTER TABLE public.revenue_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read revenue by unit access" ON public.revenue_entries FOR SELECT TO authenticated USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Write revenue by unit access (not ceo)" ON public.revenue_entries FOR ALL TO authenticated USING (public.has_unit(auth.uid(), unit_id) AND NOT public.has_role(auth.uid(),'ceo')) WITH CHECK (public.has_unit(auth.uid(), unit_id) AND NOT public.has_role(auth.uid(),'ceo'));

CREATE TABLE public.people (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contract_type TEXT NOT NULL DEFAULT 'clt',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.people TO authenticated;
GRANT ALL ON public.people TO service_role;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read people by unit access" ON public.people FOR SELECT TO authenticated USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes people" ON public.people FOR ALL TO authenticated USING (public.has_role(auth.uid(),'financeiro')) WITH CHECK (public.has_role(auth.uid(),'financeiro'));

CREATE TABLE public.payroll_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  year INT NOT NULL DEFAULT 2027,
  month INT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'salario',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_entries TO authenticated;
GRANT ALL ON public.payroll_entries TO service_role;
ALTER TABLE public.payroll_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read payroll by unit access" ON public.payroll_entries FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.has_unit(auth.uid(), p.unit_id)));
CREATE POLICY "Financeiro writes payroll" ON public.payroll_entries FOR ALL TO authenticated USING (public.has_role(auth.uid(),'financeiro')) WITH CHECK (public.has_role(auth.uid(),'financeiro'));

CREATE TABLE public.expense_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dre_line TEXT NOT NULL DEFAULT 'despesas',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories TO authenticated;
GRANT ALL ON public.expense_categories TO service_role;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read categories by unit access" ON public.expense_categories FOR SELECT TO authenticated USING (public.has_unit(auth.uid(), unit_id));
CREATE POLICY "Financeiro writes categories" ON public.expense_categories FOR ALL TO authenticated USING (public.has_role(auth.uid(),'financeiro')) WITH CHECK (public.has_role(auth.uid(),'financeiro'));

CREATE TABLE public.expense_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE CASCADE,
  year INT NOT NULL DEFAULT 2027,
  month INT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_entries TO authenticated;
GRANT ALL ON public.expense_entries TO service_role;
ALTER TABLE public.expense_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read expenses by unit access" ON public.expense_entries FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = category_id AND public.has_unit(auth.uid(), c.unit_id)));
CREATE POLICY "Write expenses by unit access (not ceo)" ON public.expense_entries FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = category_id AND public.has_unit(auth.uid(), c.unit_id)) AND NOT public.has_role(auth.uid(),'ceo')) WITH CHECK (EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = category_id AND public.has_unit(auth.uid(), c.unit_id)) AND NOT public.has_role(auth.uid(),'ceo'));

CREATE TABLE public.parameters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL,
  value NUMERIC NOT NULL,
  valid_from DATE NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.parameters TO authenticated;
GRANT ALL ON public.parameters TO service_role;
ALTER TABLE public.parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read parameters" ON public.parameters FOR SELECT TO authenticated USING (true);
CREATE POLICY "Financeiro writes parameters" ON public.parameters FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'financeiro'));

CREATE TABLE public.audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id UUID,
  action TEXT NOT NULL,
  changed_by UUID REFERENCES auth.users(id),
  old_data JSONB,
  new_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Management reads audit" ON public.audit_log FOR SELECT TO authenticated USING (public.has_any_role(auth.uid(), ARRAY['financeiro','vp','ceo']::public.app_role[]));

CREATE OR REPLACE FUNCTION public.audit_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_log (table_name, row_id, action, changed_by, new_data) VALUES (TG_TABLE_NAME, NEW.id, 'insert', auth.uid(), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.audit_log (table_name, row_id, action, changed_by, old_data, new_data) VALUES (TG_TABLE_NAME, NEW.id, 'update', auth.uid(), to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSE
    INSERT INTO public.audit_log (table_name, row_id, action, changed_by, old_data) VALUES (TG_TABLE_NAME, OLD.id, 'delete', auth.uid(), to_jsonb(OLD));
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER audit_revenue AFTER INSERT OR UPDATE OR DELETE ON public.revenue_entries FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_payroll AFTER INSERT OR UPDATE OR DELETE ON public.payroll_entries FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_expenses AFTER INSERT OR UPDATE OR DELETE ON public.expense_entries FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_people AFTER INSERT OR UPDATE OR DELETE ON public.people FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_categories AFTER INSERT OR UPDATE OR DELETE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_parameters AFTER INSERT OR DELETE ON public.parameters FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();
CREATE TRIGGER audit_scenarios AFTER INSERT OR UPDATE OR DELETE ON public.scenarios FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;
CREATE TRIGGER upd_revenue BEFORE UPDATE ON public.revenue_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_payroll BEFORE UPDATE ON public.payroll_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_expenses BEFORE UPDATE ON public.expense_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_people BEFORE UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_categories BEFORE UPDATE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_scenarios BEFORE UPDATE ON public.scenarios FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER upd_profiles BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();