ALTER TABLE public.payroll_entries ADD COLUMN unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE;
DROP POLICY "Read payroll by unit access" ON public.payroll_entries;
CREATE POLICY "Read payroll by unit access" ON public.payroll_entries FOR SELECT TO authenticated USING (
  (unit_id IS NOT NULL AND public.has_unit(auth.uid(), unit_id))
  OR EXISTS (SELECT 1 FROM public.people p WHERE p.id = person_id AND public.has_unit(auth.uid(), p.unit_id))
);