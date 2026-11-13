CREATE OR REPLACE FUNCTION public.guard_game_save()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  new_d numeric; old_d numeric; ledger_d numeric;
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF pg_column_size(NEW.game_state) > 2000000 THEN
    RAISE EXCEPTION 'game save too large';
  END IF;
  new_d := COALESCE((NEW.game_state #>> '{resources,diamonds}')::numeric, 0);
  SELECT balance_after INTO ledger_d FROM public.game_transactions
    WHERE user_id = NEW.user_id AND currency_type = 'diamonds'
    ORDER BY created_at DESC LIMIT 1;
  IF TG_OP = 'UPDATE' THEN
    old_d := COALESCE((OLD.game_state #>> '{resources,diamonds}')::numeric, 0);
  ELSE
    old_d := 0;
  END IF;
  -- A client save may spend diamonds but never mint them: the ceiling is the
  -- server ledger balance (or the previous save when no ledger row exists).
  IF new_d > GREATEST(COALESCE(ledger_d, old_d), 0) OR new_d < 0 THEN
    NEW.game_state := jsonb_set(NEW.game_state, '{resources,diamonds}',
      to_jsonb(GREATEST(LEAST(new_d, COALESCE(ledger_d, old_d)), 0)), true);
  END IF;
  NEW.user_id := COALESCE(OLD.user_id, NEW.user_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_game_save ON public.game_saves;
CREATE TRIGGER guard_game_save BEFORE INSERT OR UPDATE ON public.game_saves
FOR EACH ROW EXECUTE FUNCTION public.guard_game_save();

DELETE FROM public.gunit_memory WHERE role NOT IN ('user','assistant');
ALTER TABLE public.gunit_memory DROP CONSTRAINT IF EXISTS gunit_memory_role_check;
ALTER TABLE public.gunit_memory ADD CONSTRAINT gunit_memory_role_check CHECK (role IN ('user','assistant'));