BEGIN;

CREATE OR REPLACE FUNCTION public.pool_commit_authoritative_shot(
  p_match_id uuid,
  p_user_id uuid,
  p_expected_version bigint,
  p_snapshot jsonb,
  p_next_player_id uuid,
  p_game_over boolean,
  p_winner_id uuid,
  p_shot_meta jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_session public.pool_game_sessions%ROWTYPE;
  v_current_player uuid;
  v_winner_from_snapshot integer;
  v_net1 bigint;
  v_net2 bigint;
  v_net bigint;
  v_gross bigint;
  v_fee_expected bigint;
  v_fee1 bigint;
  v_fee2 bigint;
  v_fee_count integer;
  v_stake_count integer;
  v_reserved1 bigint;
  v_reserved2 bigint;
  v_loser uuid;
BEGIN
  IF p_user_id IS NULL OR p_expected_version IS NULL
     OR p_snapshot IS NULL OR p_shot_meta IS NULL THEN
    RAISE EXCEPTION 'Invalid shot request';
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF NOT FOUND OR v_match.game <> '8-ball Pool'
     OR v_match.status <> 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pool match is not active');
  END IF;

  IF p_user_id NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'Player is not part of this match';
  END IF;

  IF p_next_player_id NOT IN (v_match.player1_id, v_match.player2_id) THEN
    RAISE EXCEPTION 'Invalid next player';
  END IF;

  IF jsonb_typeof(p_snapshot -> 'balls') <> 'array'
     OR jsonb_array_length(p_snapshot -> 'balls') <> 16
     OR jsonb_typeof(p_snapshot -> 'groups') <> 'array'
     OR jsonb_array_length(p_snapshot -> 'groups') <> 2
     OR p_snapshot ->> 'currentPlayer' IS NULL
     OR (p_snapshot ->> 'currentPlayer')::integer NOT IN (0, 1)
     OR p_snapshot ->> 'gameOver' IS NULL
     OR (p_snapshot ->> 'gameOver')::boolean IS DISTINCT FROM p_game_over THEN
    RAISE EXCEPTION 'Invalid authoritative game state';
  END IF;

  IF ((p_snapshot ->> 'currentPlayer')::integer = 0 AND p_next_player_id <> v_match.player1_id)
     OR ((p_snapshot ->> 'currentPlayer')::integer = 1 AND p_next_player_id <> v_match.player2_id) THEN
    RAISE EXCEPTION 'Next player does not match authoritative game state';
  END IF;

  SELECT * INTO v_session
  FROM public.pool_game_sessions
  WHERE match_id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pool session not found';
  END IF;

  IF v_session.settlement_status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match has already settled');
  END IF;

  IF v_session.disconnect_deadline IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'A player is disconnected');
  END IF;

  IF v_session.state_version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Game state version conflict',
      'stateVersion', v_session.state_version
    );
  END IF;

  v_current_player := coalesce(
    (v_session.game_state ->> 'current_player_id')::uuid,
    v_match.player1_id
  );

  IF v_current_player <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'It is not this player''s turn');
  END IF;

  IF p_game_over THEN
    IF p_winner_id IS NULL
       OR p_winner_id NOT IN (v_match.player1_id, v_match.player2_id)
       OR p_snapshot ->> 'winnerPlayer' IS NULL
       OR (p_snapshot ->> 'winnerPlayer')::integer NOT IN (0, 1) THEN
      RAISE EXCEPTION 'Invalid match winner';
    END IF;

    v_winner_from_snapshot := (p_snapshot ->> 'winnerPlayer')::integer;

    IF (v_winner_from_snapshot = 0 AND p_winner_id <> v_match.player1_id)
       OR (v_winner_from_snapshot = 1 AND p_winner_id <> v_match.player2_id) THEN
      RAISE EXCEPTION 'Winner does not match authoritative game state';
    END IF;
  ELSIF p_winner_id IS NOT NULL THEN
    RAISE EXCEPTION 'Winner cannot be set before the game ends';
  END IF;

  IF p_game_over THEN
    v_gross := round(v_match.stake_amount * 100)::bigint;
    v_fee_expected := round(v_gross * 0.05)::bigint;

    SELECT count(*), max(amount_kobo)
    INTO v_stake_count, v_net1
    FROM public.wallet_transactions
    WHERE user_id = v_match.player1_id
      AND transaction_type = 'stake_reserved'
      AND status = 'completed'
      AND reference = 'stake:' || v_match.challenge_id::text || ':' || v_match.player1_id::text;

    IF v_stake_count <> 1 OR v_net1 IS NULL OR v_net1 <= 0 THEN
      RAISE EXCEPTION 'Player 1 stake reservation is missing or inconsistent';
    END IF;

    SELECT count(*), max(amount_kobo)
    INTO v_stake_count, v_net2
    FROM public.wallet_transactions
    WHERE user_id = v_match.player2_id
      AND transaction_type = 'stake_reserved'
      AND status = 'completed'
      AND reference = 'stake:' || v_match.challenge_id::text || ':' || v_match.player2_id::text;

    IF v_stake_count <> 1 OR v_net2 IS NULL OR v_net2 <= 0 THEN
      RAISE EXCEPTION 'Player 2 stake reservation is missing or inconsistent';
    END IF;

    IF v_net1 <> v_net2 THEN
      RAISE EXCEPTION 'Players have different reserved stakes; payout stopped';
    END IF;

    SELECT count(*), max(amount_kobo)
    INTO v_fee_count, v_fee1
    FROM public.platform_earnings
    WHERE source_reference =
      'challenge:' || v_match.challenge_id::text || ':fee:' || v_match.player1_id::text;

    IF v_fee_count NOT IN (0, 1) THEN
      RAISE EXCEPTION 'Player 1 platform fee records are inconsistent';
    END IF;

    SELECT count(*), max(amount_kobo)
    INTO v_stake_count, v_fee2
    FROM public.platform_earnings
    WHERE source_reference =
      'challenge:' || v_match.challenge_id::text || ':fee:' || v_match.player2_id::text;

    IF v_stake_count NOT IN (0, 1) THEN
      RAISE EXCEPTION 'Player 2 platform fee records are inconsistent';
    END IF;

    IF v_fee_count = 0 AND v_stake_count = 0 THEN
      IF v_net1 <> v_gross THEN
        RAISE EXCEPTION 'Legacy reservation amount does not match original stake';
      END IF;
    ELSIF v_fee_count = 1 AND v_stake_count = 1 THEN
      IF v_fee1 <> v_fee_expected OR v_fee2 <> v_fee_expected
         OR v_net1 <> v_gross - v_fee_expected THEN
        RAISE EXCEPTION 'Platform fee and reserved stake amounts do not match';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only one player has a platform fee record; payout stopped';
    END IF;

    v_net := v_net1;

    IF EXISTS (
      SELECT 1 FROM public.wallet_transactions
      WHERE reference IN (
        'pool-normal-win:' || p_match_id::text,
        'pool-normal-loss:' || p_match_id::text
      )
    ) THEN
      RAISE EXCEPTION 'Pool settlement transaction already exists';
    END IF;

    PERFORM 1
    FROM public.wallets
    WHERE user_id IN (v_match.player1_id, v_match.player2_id)
    ORDER BY user_id
    FOR UPDATE;

    SELECT reserved_balance_kobo INTO v_reserved1
    FROM public.wallets WHERE user_id = v_match.player1_id;

    SELECT reserved_balance_kobo INTO v_reserved2
    FROM public.wallets WHERE user_id = v_match.player2_id;

    IF coalesce(v_reserved1, 0) < v_net
       OR coalesce(v_reserved2, 0) < v_net THEN
      RAISE EXCEPTION 'Reserved Pool balances are insufficient; payout stopped';
    END IF;
  END IF;

  UPDATE public.pool_game_sessions
  SET game_state = coalesce(game_state, '{}'::jsonb) || jsonb_build_object(
        'snapshot', p_snapshot,
        'current_player_id', p_next_player_id,
        'status', CASE WHEN p_game_over THEN 'game_over' ELSE 'playing' END,
        'last_shot', p_shot_meta
      ),
      state_version = state_version + 1,
      turn_number = turn_number + 1,
      updated_at = now()
  WHERE match_id = p_match_id;

  IF p_game_over THEN
    v_loser := CASE
      WHEN p_winner_id = v_match.player1_id THEN v_match.player2_id
      ELSE v_match.player1_id
    END;

    UPDATE public.wallets
    SET reserved_balance_kobo = reserved_balance_kobo - v_net,
        updated_at = now()
    WHERE user_id IN (v_match.player1_id, v_match.player2_id);

    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + (v_net * 2),
        updated_at = now()
    WHERE user_id = p_winner_id;

    INSERT INTO public.wallet_transactions
      (user_id, transaction_type, amount_kobo, status, reference, description, metadata)
    VALUES
      (p_winner_id, 'stake_won', v_net * 2, 'completed',
       'pool-normal-win:' || p_match_id::text,
       '8-Ball Pool winner payout after server-validated result',
       jsonb_build_object('match_id', p_match_id, 'challenge_id', v_match.challenge_id)),
      (v_loser, 'stake_lost', v_net, 'completed',
       'pool-normal-loss:' || p_match_id::text,
       '8-Ball Pool stake lost after server-validated result',
       jsonb_build_object('match_id', p_match_id, 'challenge_id', v_match.challenge_id));

    UPDATE public.pool_game_sessions
    SET settlement_status = 'settled',
        winner_id = p_winner_id,
        end_reason = 'normal_8_ball',
        updated_at = now()
    WHERE match_id = p_match_id
      AND settlement_status = 'pending';

    UPDATE public.matches
    SET status = 'completed', updated_at = now()
    WHERE id = p_match_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'stateVersion', v_session.state_version + 1,
    'settled', p_game_over,
    'winnerId', CASE WHEN p_game_over THEN p_winner_id ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pool_commit_authoritative_shot(uuid, uuid, bigint, jsonb, uuid, boolean, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pool_commit_authoritative_shot(uuid, uuid, bigint, jsonb, uuid, boolean, uuid, jsonb)
  TO service_role;

COMMIT;
