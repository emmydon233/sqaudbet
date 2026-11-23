BEGIN;

-- SquadBet 8-Ball Pool multiplayer foundation, adapted to the confirmed LIVE schema.
-- IMPORTANT: This migration deliberately does NOT replace
-- accept_challenge_and_reserve_stakes() or create_match_for_accepted_challenge().
-- The existing acceptance function already charges the 5% fee and reserves 95% of
-- each stake in public.wallets. The existing challenges trigger creates public.matches.
-- This migration creates the Pool session after that match row is inserted.

CREATE TABLE IF NOT EXISTS public.pool_game_sessions (
  match_id uuid PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  game_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  settlement_status text NOT NULL DEFAULT 'pending'
    CHECK (settlement_status IN ('pending', 'settled')),
  winner_id uuid REFERENCES auth.users(id),
  end_reason text,
  player1_last_seen timestamptz,
  player2_last_seen timestamptz,
  player1_disconnected_at timestamptz,
  player2_disconnected_at timestamptz,
  disconnect_deadline timestamptz,
  started_at timestamptz,
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  turn_number bigint NOT NULL DEFAULT 0 CHECK (turn_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep this migration safe if a partial Pool table was created during earlier testing.
ALTER TABLE public.pool_game_sessions
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS turn_number bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS player1_last_seen timestamptz,
  ADD COLUMN IF NOT EXISTS player2_last_seen timestamptz,
  ADD COLUMN IF NOT EXISTS player1_disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS player2_disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnect_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS game_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS winner_id uuid,
  ADD COLUMN IF NOT EXISTS end_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.pool_game_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Pool players can read own session" ON public.pool_game_sessions;
CREATE POLICY "Pool players can read own session"
  ON public.pool_game_sessions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.matches AS m
      WHERE m.id = pool_game_sessions.match_id
        AND auth.uid() IN (m.player1_id, m.player2_id)
    )
  );
REVOKE ALL ON public.pool_game_sessions FROM anon, authenticated;
GRANT SELECT ON public.pool_game_sessions TO authenticated;
GRANT ALL ON public.pool_game_sessions TO service_role;

-- The acceptance function already reserves (stake - round(stake * 5%)) for EACH
-- player. Derive that same per-player net amount; do not deduct or record another fee.
CREATE OR REPLACE FUNCTION public.pool_create_session_for_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stake_kobo bigint;
  v_fee_kobo bigint;
  v_net_kobo bigint;
BEGIN
  IF NEW.game <> '8-ball Pool' THEN
    RETURN NEW;
  END IF;

  v_stake_kobo := round(NEW.stake_amount * 100)::bigint;
  v_fee_kobo := round(v_stake_kobo::numeric * 0.05)::bigint;
  v_net_kobo := v_stake_kobo - v_fee_kobo;
  IF v_net_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid net Pool stake for match %', NEW.id;
  END IF;

  INSERT INTO public.pool_game_sessions (match_id, game_state)
  VALUES (
    NEW.id,
    jsonb_build_object(
      'stake_net_kobo', v_net_kobo,
      'current_player_id', NEW.player1_id,
      'status', 'lobby'
    )
  )
  ON CONFLICT (match_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_create_session_after_match_insert ON public.matches;
CREATE TRIGGER pool_create_session_after_match_insert
  AFTER INSERT ON public.matches
  FOR EACH ROW
  WHEN (NEW.game = '8-ball Pool')
  EXECUTE FUNCTION public.pool_create_session_for_match();

-- Validate and backfill using the actual live wallet reservations.
DO $backfill_validation$
DECLARE r record;
DECLARE n1 bigint;
DECLARE n2 bigint;
DECLARE f1 bigint;
DECLARE f2 bigint;
DECLARE c1 integer;
DECLARE c2 integer;
DECLARE gross bigint;
DECLARE expected_fee bigint;
BEGIN
  FOR r IN
    SELECT * FROM public.matches WHERE game = '8-ball Pool'
  LOOP
    SELECT count(*), max(amount_kobo) INTO c1, n1
    FROM public.wallet_transactions
    WHERE user_id = r.player1_id
      AND transaction_type = 'stake_reserved'
      AND status = 'completed'
      AND reference = 'stake:' || r.challenge_id::text || ':' || r.player1_id::text;

    SELECT count(*), max(amount_kobo) INTO c2, n2
    FROM public.wallet_transactions
    WHERE user_id = r.player2_id
      AND transaction_type = 'stake_reserved'
      AND status = 'completed'
      AND reference = 'stake:' || r.challenge_id::text || ':' || r.player2_id::text;

    IF c1 <> 1 OR c2 <> 1 OR n1 IS NULL OR n2 IS NULL OR n1 <> n2 THEN
      RAISE EXCEPTION 'Pool backfill stopped: missing or unequal stake reservations for match %', r.id;
    END IF;

    SELECT count(*), max(amount_kobo) INTO c1, f1
    FROM public.platform_earnings
    WHERE source_reference = 'challenge:' || r.challenge_id::text || ':fee:' || r.player1_id::text;

    SELECT count(*), max(amount_kobo) INTO c2, f2
    FROM public.platform_earnings
    WHERE source_reference = 'challenge:' || r.challenge_id::text || ':fee:' || r.player2_id::text;

    gross := round(r.stake_amount * 100)::bigint;
    expected_fee := round(gross * 0.05)::bigint;

    IF c1 = 0 AND c2 = 0 THEN
      IF n1 <> gross THEN
        RAISE EXCEPTION 'Legacy Pool reservation mismatch for match %', r.id;
      END IF;
    ELSIF c1 = 1 AND c2 = 1 THEN
      IF f1 <> expected_fee OR f2 <> expected_fee OR n1 <> gross - expected_fee THEN
        RAISE EXCEPTION 'Pool fee/reservation mismatch for match %', r.id;
      END IF;
    ELSE
      RAISE EXCEPTION 'Inconsistent Pool fee records for match %', r.id;
    END IF;
  END LOOP;
END;
$backfill_validation$;

INSERT INTO public.pool_game_sessions
  (match_id, game_state, started_at, player1_last_seen, player2_last_seen)
SELECT
  m.id,
  jsonb_build_object(
    'stake_net_kobo', p1.amount_kobo,
    'current_player_id', m.player1_id,
    'status', CASE WHEN m.status = 'in_progress' THEN 'playing' ELSE 'lobby' END
  ),
  CASE WHEN m.status = 'in_progress' THEN now() ELSE NULL END,
  CASE WHEN m.status = 'in_progress' THEN now() ELSE NULL END,
  CASE WHEN m.status = 'in_progress' THEN now() ELSE NULL END
FROM public.matches m
JOIN public.wallet_transactions p1
  ON p1.user_id = m.player1_id
 AND p1.transaction_type = 'stake_reserved'
 AND p1.status = 'completed'
 AND p1.reference = 'stake:' || m.challenge_id::text || ':' || m.player1_id::text
WHERE m.game = '8-ball Pool'
ON CONFLICT (match_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.pool_set_ready(p_match_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_me uuid := coalesce(auth.uid(), p_user_id);
  v_p1_ready boolean;
  v_p2_ready boolean;
BEGIN
  IF v_me IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_match FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.game <> '8-ball Pool' THEN
    RAISE EXCEPTION '8-Ball Pool match not found';
  END IF;
  IF v_me NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'You are not part of this match';
  END IF;
  IF v_match.status = 'in_progress' THEN
    RETURN jsonb_build_object(
      'success', true,
      'bothReady', true,
      'status', 'in_progress',
      'alreadyStarted', true
    );
  END IF;

  IF v_match.status NOT IN ('lobby', 'waiting', 'ready') THEN
    RAISE EXCEPTION 'Match is not available';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pool_game_sessions WHERE match_id = p_match_id) THEN
    RAISE EXCEPTION 'Pool session is missing for this match';
  END IF;

  UPDATE public.matches
  SET player1_ready = CASE WHEN v_me = v_match.player1_id THEN true ELSE player1_ready END,
      player2_ready = CASE WHEN v_me = v_match.player2_id THEN true ELSE player2_ready END
  WHERE id = p_match_id;

  SELECT player1_ready, player2_ready
  INTO v_p1_ready, v_p2_ready
  FROM public.matches WHERE id = p_match_id;

  IF v_p1_ready AND v_p2_ready THEN
    UPDATE public.matches SET status = 'in_progress', updated_at = now()
    WHERE id = p_match_id AND status IN ('lobby', 'waiting', 'ready');

    UPDATE public.pool_game_sessions
    SET game_state = game_state || jsonb_build_object(
          'status', 'playing',
          'current_player_id', v_match.player1_id
        ),
        started_at = coalesce(started_at, now()),
        player1_last_seen = coalesce(player1_last_seen, now()),
        player2_last_seen = coalesce(player2_last_seen, now()),
        updated_at = now()
    WHERE match_id = p_match_id AND settlement_status = 'pending';
  ELSE
    UPDATE public.matches SET status = 'ready', updated_at = now()
    WHERE id = p_match_id AND status IN ('lobby', 'waiting');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'bothReady', v_p1_ready AND v_p2_ready,
    'status', CASE WHEN v_p1_ready AND v_p2_ready THEN 'in_progress' ELSE 'ready' END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.pool_set_ready(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pool_set_ready(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pool_resolve_disconnect(p_match_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_session public.pool_game_sessions%ROWTYPE;
  v_net bigint;
  v_winner uuid;
  v_both_disconnected boolean;
  v_reserved1 bigint;
  v_reserved2 bigint;
BEGIN
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_match FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.game <> '8-ball Pool' THEN
    RAISE EXCEPTION 'Pool match not found';
  END IF;
  IF p_user_id NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'You are not part of this match';
  END IF;

  SELECT * INTO v_session FROM public.pool_game_sessions WHERE match_id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool session not found'; END IF;
  IF v_session.settlement_status = 'settled' THEN
    RETURN jsonb_build_object('success', true, 'settled', true,
      'winnerId', v_session.winner_id, 'reason', v_session.end_reason);
  END IF;
  IF v_session.disconnect_deadline IS NULL OR v_session.disconnect_deadline > now() THEN
    RETURN jsonb_build_object('success', true, 'settled', false,
      'deadline', v_session.disconnect_deadline);
  END IF;

  -- Refund only when BOTH players disconnected within the original five-minute
  -- window. If the second player disappears after that deadline, the player who
  -- stayed connected through the deadline wins by forfeit.
  v_both_disconnected := v_session.player1_disconnected_at IS NOT NULL
    AND v_session.player2_disconnected_at IS NOT NULL
    AND greatest(v_session.player1_disconnected_at, v_session.player2_disconnected_at)
        <= v_session.disconnect_deadline;
  IF NOT v_both_disconnected THEN
    -- The player whose first disconnect happened on/before the deadline forfeits.
    -- A later disconnect by the other player must not reverse the winner.
    IF v_session.player1_disconnected_at IS NOT NULL
       AND v_session.player1_disconnected_at <= v_session.disconnect_deadline
       AND (v_session.player2_disconnected_at IS NULL
            OR v_session.player2_disconnected_at > v_session.disconnect_deadline) THEN
      v_winner := v_match.player2_id;
    ELSIF v_session.player2_disconnected_at IS NOT NULL
       AND v_session.player2_disconnected_at <= v_session.disconnect_deadline
       AND (v_session.player1_disconnected_at IS NULL
            OR v_session.player1_disconnected_at > v_session.disconnect_deadline) THEN
      v_winner := v_match.player1_id;
    ELSE
      -- No unambiguous first forfeiting player: stop rather than pay the wrong account.
      RETURN jsonb_build_object('success', true, 'settled', false,
        'error', 'Disconnect timestamps do not identify a valid forfeiting player');
    END IF;
  END IF;

  v_net := (v_session.game_state ->> 'stake_net_kobo')::bigint;
  IF v_net IS NULL OR v_net <= 0 THEN
    RAISE EXCEPTION 'Pool net stake is missing or invalid; settlement stopped';
  END IF;

  IF v_both_disconnected THEN
    IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE reference IN (
      'pool-refund:' || p_match_id::text || ':' || v_match.player1_id::text,
      'pool-refund:' || p_match_id::text || ':' || v_match.player2_id::text
    )) THEN
      RAISE EXCEPTION 'Refund transaction already exists while Pool session is unsettled';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE reference IN (
      'pool-disconnect-win:' || p_match_id::text,
      'pool-disconnect-loss:' || p_match_id::text
    )) THEN
      RAISE EXCEPTION 'Disconnect payout already exists while Pool session is unsettled';
    END IF;
  END IF;

  PERFORM 1 FROM public.wallets
  WHERE user_id IN (v_match.player1_id, v_match.player2_id)
  ORDER BY user_id FOR UPDATE;
  SELECT reserved_balance_kobo INTO v_reserved1 FROM public.wallets WHERE user_id = v_match.player1_id;
  SELECT reserved_balance_kobo INTO v_reserved2 FROM public.wallets WHERE user_id = v_match.player2_id;
  IF coalesce(v_reserved1, 0) < v_net OR coalesce(v_reserved2, 0) < v_net THEN
    RAISE EXCEPTION 'Reserved Pool stake is inconsistent; settlement stopped';
  END IF;

  UPDATE public.wallets
  SET reserved_balance_kobo = reserved_balance_kobo - v_net, updated_at = now()
  WHERE user_id IN (v_match.player1_id, v_match.player2_id);

  IF v_both_disconnected THEN
    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + v_net, updated_at = now()
    WHERE user_id IN (v_match.player1_id, v_match.player2_id);

    INSERT INTO public.wallet_transactions
  (user_id, transaction_type, amount_kobo, status, reference, description, metadata)
VALUES
  (v_match.player1_id, 'refund', v_net, 'completed',
   'pool-refund:' || p_match_id::text || ':' || v_match.player1_id::text,
   '8-Ball Pool net stake refund after both players disconnected',
   jsonb_build_object('match_id', p_match_id)),
  (v_match.player2_id, 'refund', v_net, 'completed',
   'pool-refund:' || p_match_id::text || ':' || v_match.player2_id::text,
   '8-Ball Pool net stake refund after both players disconnected',
   jsonb_build_object('match_id', p_match_id));UPDATE public.pool_game_sessions
    SET settlement_status = 'settled', end_reason = 'both_disconnected_refund', updated_at = now()
    WHERE match_id = p_match_id AND settlement_status = 'pending';
    UPDATE public.matches SET status = 'cancelled', updated_at = now() WHERE id = p_match_id;
    RETURN jsonb_build_object('success', true, 'settled', true, 'result', 'refund');
  ELSE
    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + (v_net * 2), updated_at = now()
    WHERE user_id = v_winner;

    INSERT INTO public.wallet_transactions
  (user_id, transaction_type, amount_kobo, status, reference, description, metadata)
VALUES
  (v_winner, 'stake_won', v_net * 2, 'completed',
   'pool-disconnect-win:' || p_match_id::text,
   '8-Ball Pool winner payout after opponent failed to reconnect',
   jsonb_build_object('match_id', p_match_id)),
  (CASE WHEN v_winner = v_match.player1_id THEN v_match.player2_id ELSE v_match.player1_id END,
   'stake_lost', v_net, 'completed',
   'pool-disconnect-loss:' || p_match_id::text,
   '8-Ball Pool stake lost after opponent failed to reconnect',
   jsonb_build_object('match_id', p_match_id));UPDATE public.pool_game_sessions
    SET settlement_status = 'settled', winner_id = v_winner,
        end_reason = 'disconnect_forfeit', updated_at = now()
    WHERE match_id = p_match_id AND settlement_status = 'pending';
    UPDATE public.matches SET status = 'completed', updated_at = now() WHERE id = p_match_id;
    RETURN jsonb_build_object('success', true, 'settled', true,
      'result', 'forfeit', 'winnerId', v_winner);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_resolve_disconnect(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pool_resolve_disconnect(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pool_presence(p_match_id uuid, p_action text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_session public.pool_game_sessions%ROWTYPE;
  v_me uuid := coalesce(auth.uid(), p_user_id);
  v_now timestamptz := now();
BEGIN
  IF v_me IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_action NOT IN ('heartbeat', 'leave') THEN
    RAISE EXCEPTION 'Unsupported presence action';
  END IF;

  SELECT * INTO v_match FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND OR v_match.game <> '8-ball Pool'
     OR v_me NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'Pool match not found or unauthorized';
  END IF;
  SELECT * INTO v_session FROM public.pool_game_sessions WHERE match_id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool session not found'; END IF;
  IF v_session.settlement_status = 'settled' THEN
    RETURN jsonb_build_object('success', true, 'settled', true,
      'winnerId', v_session.winner_id, 'reason', v_session.end_reason);
  END IF;

  -- Resolve an expired deadline BEFORE accepting a late reconnect.
  IF v_session.disconnect_deadline IS NOT NULL AND v_session.disconnect_deadline <= v_now THEN
    PERFORM public.pool_resolve_disconnect(p_match_id, v_me);
    SELECT * INTO v_session FROM public.pool_game_sessions WHERE match_id = p_match_id FOR UPDATE;
    IF v_session.settlement_status = 'settled' THEN
      RETURN jsonb_build_object('success', true, 'settled', true,
        'winnerId', v_session.winner_id, 'reason', v_session.end_reason);
    END IF;
  END IF;

  -- A player leaving the pre-game lobby is not a forfeit. The five-minute
  -- reconnect rule begins once both players have started the live match.
  IF v_match.status <> 'in_progress' THEN
    RETURN jsonb_build_object('success', true, 'settled', false, 'lobby', true);
  END IF;

  IF p_action = 'heartbeat' THEN
    UPDATE public.pool_game_sessions
    SET player1_last_seen = CASE WHEN v_me = v_match.player1_id THEN v_now ELSE player1_last_seen END,
        player2_last_seen = CASE WHEN v_me = v_match.player2_id THEN v_now ELSE player2_last_seen END,
        player1_disconnected_at = CASE WHEN v_me = v_match.player1_id THEN NULL ELSE player1_disconnected_at END,
        player2_disconnected_at = CASE WHEN v_me = v_match.player2_id THEN NULL ELSE player2_disconnected_at END,
        disconnect_deadline = CASE
          WHEN v_me = v_match.player1_id AND player1_disconnected_at IS NOT NULL
            THEN CASE WHEN player2_disconnected_at IS NOT NULL THEN v_now + interval '5 minutes' ELSE NULL END
          WHEN v_me = v_match.player2_id AND player2_disconnected_at IS NOT NULL
            THEN CASE WHEN player1_disconnected_at IS NOT NULL THEN v_now + interval '5 minutes' ELSE NULL END
          ELSE disconnect_deadline
        END,
        updated_at = v_now
    WHERE match_id = p_match_id;
    RETURN jsonb_build_object('success', true, 'returned', true);
  ELSE
    UPDATE public.pool_game_sessions
    SET player1_disconnected_at = CASE WHEN v_me = v_match.player1_id
          THEN coalesce(player1_disconnected_at, v_now) ELSE player1_disconnected_at END,
        player2_disconnected_at = CASE WHEN v_me = v_match.player2_id
          THEN coalesce(player2_disconnected_at, v_now) ELSE player2_disconnected_at END,
        disconnect_deadline = coalesce(disconnect_deadline, v_now + interval '5 minutes'),
        updated_at = v_now
    WHERE match_id = p_match_id;
    RETURN jsonb_build_object('success', true,
      'deadline', coalesce(v_session.disconnect_deadline, v_now + interval '5 minutes'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_presence(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pool_presence(uuid, text, uuid) TO authenticated, service_role;

-- Detect browser/tab closure even when the explicit Dashboard/Exit action never runs.
CREATE OR REPLACE FUNCTION public.pool_sweep_disconnects()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_result jsonb;
  v_count integer := 0;
  v_now timestamptz := now();
BEGIN
  FOR v_row IN
    SELECT m.id AS match_id, m.player1_id
    FROM public.matches AS m
    JOIN public.pool_game_sessions AS s ON s.match_id = m.id
    WHERE m.game = '8-ball Pool'
      AND m.status = 'in_progress'
      AND s.settlement_status = 'pending'
      AND (
        (s.disconnect_deadline IS NOT NULL AND s.disconnect_deadline <= v_now)
        OR (s.player1_disconnected_at IS NULL
            AND coalesce(s.player1_last_seen, s.started_at) < v_now - interval '20 seconds')
        OR (s.player2_disconnected_at IS NULL
            AND coalesce(s.player2_last_seen, s.started_at) < v_now - interval '20 seconds')
      )
    ORDER BY m.id
    FOR UPDATE OF m SKIP LOCKED
  LOOP
    UPDATE public.pool_game_sessions AS s
    SET player1_disconnected_at = CASE
          WHEN s.player1_disconnected_at IS NULL
            AND coalesce(s.player1_last_seen, s.started_at) < v_now - interval '20 seconds'
          THEN v_now ELSE s.player1_disconnected_at END,
        player2_disconnected_at = CASE
          WHEN s.player2_disconnected_at IS NULL
            AND coalesce(s.player2_last_seen, s.started_at) < v_now - interval '20 seconds'
          THEN v_now ELSE s.player2_disconnected_at END,
        disconnect_deadline = CASE
          WHEN (s.player1_disconnected_at IS NULL
                AND coalesce(s.player1_last_seen, s.started_at) < v_now - interval '20 seconds')
            OR (s.player2_disconnected_at IS NULL
                AND coalesce(s.player2_last_seen, s.started_at) < v_now - interval '20 seconds')
          THEN coalesce(s.disconnect_deadline, v_now + interval '5 minutes')
          ELSE s.disconnect_deadline END,
        updated_at = v_now
    WHERE s.match_id = v_row.match_id;

    v_result := public.pool_resolve_disconnect(v_row.match_id, v_row.player1_id);
    IF coalesce((v_result ->> 'settled')::boolean, false) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.pool_sweep_disconnects() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pool_sweep_disconnects() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'pool_game_sessions'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pool_game_sessions;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'squadbet-pool-disconnect-sweeper') THEN
      PERFORM cron.schedule(
        'squadbet-pool-disconnect-sweeper',
        '* * * * *',
        'select public.pool_sweep_disconnects();'
      );
    END IF;
  ELSE
    RAISE NOTICE 'pg_cron is not enabled. Configure public.pool_sweep_disconnects() to run every minute in Supabase Cron.';
  END IF;
END;
$$;

COMMIT;
