BEGIN;

CREATE OR REPLACE FUNCTION public.pool_cancel_lobby_match(
  p_match_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_session public.pool_game_sessions%ROWTYPE;
  v_net bigint;
BEGIN
  IF p_user_id IS NULL
     OR (auth.uid() IS NOT NULL AND auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Invalid user';
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  IF v_match.game <> '8-ball Pool' THEN
    RAISE EXCEPTION 'This cancellation endpoint is for Pool matches only';
  END IF;

  IF p_user_id NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'You are not part of this match';
  END IF;

  SELECT * INTO v_session
  FROM public.pool_game_sessions
  WHERE match_id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pool session not found';
  END IF;

  IF v_session.settlement_status = 'settled' THEN
    IF v_match.status = 'cancelled'
       AND v_session.end_reason = 'lobby_cancelled_by_player' THEN
      RETURN jsonb_build_object(
        'success', true,
        'alreadyCancelled', true,
        'message', 'This match has already been cancelled.'
      );
    END IF;

    RAISE EXCEPTION 'This match has already been settled';
  END IF;

  IF v_match.status NOT IN ('lobby', 'waiting', 'ready')
     OR v_session.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'A match cannot be cancelled after gameplay has started';
  END IF;

  v_net := (v_session.game_state ->> 'stake_net_kobo')::bigint;

  IF v_net IS NULL OR v_net <= 0 THEN
    RAISE EXCEPTION 'Invalid Pool reservation amount';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.wallets
    WHERE user_id = v_match.player1_id
      AND reserved_balance_kobo >= v_net
  ) OR NOT EXISTS (
    SELECT 1 FROM public.wallets
    WHERE user_id = v_match.player2_id
      AND reserved_balance_kobo >= v_net
  ) THEN
    RAISE EXCEPTION 'Wallet reservation verification failed; refund stopped';
  END IF;

  UPDATE public.wallets
  SET reserved_balance_kobo = reserved_balance_kobo - v_net,
      available_balance_kobo = available_balance_kobo + v_net
  WHERE user_id IN (v_match.player1_id, v_match.player2_id);

  INSERT INTO public.wallet_transactions
  (user_id, transaction_type, amount_kobo, status, reference, description, metadata)
VALUES
  (v_match.player1_id, 'refund', v_net, 'completed',
   'pool-lobby-cancel:' || p_match_id::text || ':' || v_match.player1_id::text,
   '8-Ball Pool net stake refunded after lobby cancellation',
   jsonb_build_object('match_id', p_match_id)),
  (v_match.player2_id, 'refund', v_net, 'completed',
   'pool-lobby-cancel:' || p_match_id::text || ':' || v_match.player2_id::text,
   '8-Ball Pool net stake refunded after lobby cancellation',
   jsonb_build_object('match_id', p_match_id));UPDATE public.pool_game_sessions
  SET settlement_status = 'settled',
      end_reason = 'lobby_cancelled_by_player',
      game_state = game_state || jsonb_build_object('status', 'cancelled'),
      updated_at = now()
  WHERE match_id = p_match_id
    AND settlement_status = 'pending';

  UPDATE public.matches
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_match_id;

  RETURN jsonb_build_object(
    'success', true,
    'cancelled', true,
    'refundedPerPlayerKobo', v_net,
    'message', 'Match cancelled. Both players have received their net stake refunds.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pool_cancel_lobby_match(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pool_cancel_lobby_match(uuid, uuid)
  TO service_role;

COMMIT;
