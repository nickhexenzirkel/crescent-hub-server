-- ════════════════════════════════════════════════════════
-- CRESCENT HUB — Auth Migration
-- Cole e execute no Supabase SQL Editor
-- ════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.employees (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name          text        NOT NULL,
  cpf           text        NOT NULL UNIQUE,      -- somente dígitos, ex: 12345678900
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'employee'
                            CHECK (role IN ('employee','admin')),
  active        boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- RLS aberto para o servidor acessar via anon key
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ch_employees_all" ON public.employees;
CREATE POLICY "ch_employees_all" ON public.employees FOR ALL USING (true) WITH CHECK (true);
