CREATE OR REPLACE FUNCTION public.guard_game_save()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  new_d numeric; old_d numeric; ledger_d numeric;
  res_key text; res_val numeric;
  MAX_RES CONSTANT numeric := 10000000;
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
  -- Clamp all other core resources to non-negative bounded values so a client
  -- cannot write arbitrary resource balances directly to public.game_saves.
  IF jsonb_typeof(NEW.game_state -> 'resources') = 'object' THEN
    FOREACH res_key IN ARRAY ARRAY['gold','food','wood','stone','iron'] LOOP
      IF (NEW.game_state -> 'resources') ? res_key THEN
        res_val := COALESCE((NEW.game_state #>> ARRAY['resources', res_key])::numeric, 0);
        IF res_val < 0 OR res_val > MAX_RES THEN
          NEW.game_state := jsonb_set(
            NEW.game_state,
            ARRAY['resources', res_key],
            to_jsonb(GREATEST(LEAST(res_val, MAX_RES), 0)),
            true
          );
        END IF;
      END IF;
    END LOOP;
  END IF;
  NEW.user_id := COALESCE(OLD.user_id, NEW.user_id);
  RETURN NEW;
END $$;