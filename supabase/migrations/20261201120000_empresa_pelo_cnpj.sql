-- Empresa do Omie reconhecida pelo CNPJ: quando o nome fantasia muda no Omie, a leitura atualizava uma empresa nova com o
-- novo nome e a antiga ficava, e o ano base dobrava. Agora a empresa é procurada pelo CNPJ (e, sem ele, pelo nome, como
-- antes) e o nome é atualizado.
ALTER TABLE public.omie_companies ADD COLUMN cnpj TEXT UNIQUE;
COMMENT ON COLUMN public.omie_companies.cnpj IS 'CNPJ da empresa no Omie, só dígitos. É por ele que a leitura acha a empresa.';

DROP FUNCTION public.omie_store_company(TEXT, INT[], JSONB, JSONB, JSONB, JSONB, JSONB);
CREATE FUNCTION public.omie_store_company(_name TEXT, _years INT[], _departments JSONB, _categories JSONB,
  _suppliers JSONB, _actuals JSONB, _receipts JSONB, _cnpj TEXT DEFAULT NULL) RETURNS VOID
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  _cid UUID;
  _key TEXT := NULLIF(regexp_replace(COALESCE(_cnpj, ''), '\D', '', 'g'), '');
BEGIN
  SELECT id INTO _cid FROM public.omie_companies WHERE _key IS NOT NULL AND cnpj = _key;
  IF _cid IS NULL THEN
    SELECT id INTO _cid FROM public.omie_companies WHERE name = _name AND (cnpj IS NULL OR _key IS NULL);
  END IF;
  IF _cid IS NULL THEN
    INSERT INTO public.omie_companies (name, cnpj, last_synced_at) VALUES (_name, _key, now()) RETURNING id INTO _cid;
  ELSE
    UPDATE public.omie_companies SET name = _name, cnpj = COALESCE(_key, cnpj), last_synced_at = now() WHERE id = _cid;
  END IF;

  DELETE FROM public.omie_departments WHERE company_id = _cid;
  INSERT INTO public.omie_departments (company_id, code, name, structure)
  SELECT _cid, x.code, x.name, x.structure FROM jsonb_to_recordset(_departments) AS x(code TEXT, name TEXT, structure TEXT);

  DELETE FROM public.omie_categories WHERE company_id = _cid;
  INSERT INTO public.omie_categories (company_id, code, name, parent_code, is_expense, is_revenue, is_total)
  SELECT _cid, x.code, x.name, x.parent_code, x.is_expense, x.is_revenue, x.is_total
  FROM jsonb_to_recordset(_categories) AS x(code TEXT, name TEXT, parent_code TEXT, is_expense BOOLEAN, is_revenue BOOLEAN, is_total BOOLEAN);

  -- Clientes e fornecedores acumulam: ler um ano só não apaga o nome dos que aparecem em outros anos.
  INSERT INTO public.omie_suppliers (company_id, code, name)
  SELECT _cid, x.code, x.name FROM jsonb_to_recordset(_suppliers) AS x(code TEXT, name TEXT)
  ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name;

  DELETE FROM public.omie_actuals WHERE company_id = _cid AND year = ANY (_years);
  INSERT INTO public.omie_actuals (company_id, year, month, category_code, department_code, supplier_code, item, amount_paid, amount_open)
  SELECT _cid, x.year, x.month, x.category_code, x.department_code, x.supplier_code, x.item, x.amount_paid, x.amount_open
  FROM jsonb_to_recordset(_actuals) AS x(year INT, month INT, category_code TEXT, department_code TEXT, supplier_code TEXT,
    item TEXT, amount_paid NUMERIC, amount_open NUMERIC);

  DELETE FROM public.omie_receipts WHERE company_id = _cid AND year = ANY (_years);
  INSERT INTO public.omie_receipts (company_id, year, month, category_code, department_code, client_code, amount_received, amount_open)
  SELECT _cid, x.year, x.month, x.category_code, x.department_code, x.client_code, x.amount_received, x.amount_open
  FROM jsonb_to_recordset(_receipts) AS x(year INT, month INT, category_code TEXT, department_code TEXT, client_code TEXT,
    amount_received NUMERIC, amount_open NUMERIC);
END $$;
REVOKE ALL ON FUNCTION public.omie_store_company(TEXT, INT[], JSONB, JSONB, JSONB, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omie_store_company(TEXT, INT[], JSONB, JSONB, JSONB, JSONB, JSONB, TEXT) TO service_role;
