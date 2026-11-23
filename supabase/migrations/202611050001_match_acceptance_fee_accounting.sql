BEGIN;

CREATE OR REPLACE FUNCTION public.accept_challenge_and_reserve_stakes(p_challenge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_challenge public.challenges%ROWTYPE;
  v_stake_kobo bigint;
  v_fee_kobo bigint;
  v_net_kobo bigint;
  v_match_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_challenge
  FROM public.challenges
  WHERE id = p_challenge_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_challenge.recipient_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the invited player can accept this challenge';
  END IF;
  IF v_challenge.status <> 'pending' THEN
    RAISE EXCEPTION 'Challenge is no longer pending';
  END IF;
  IF v_challenge.sender_id = v_challenge.recipient_id THEN
    RAISE EXCEPTION 'Players must be different';
  END IF;
  IF v_challenge.game NOT IN ('8-ball Pool','Whot','Ludo') THEN
    RAISE EXCEPTION 'Unsupported game';
  END IF;
  IF v_challenge.stake_amount < 500
     OR v_challenge.stake_amount > 50000
     OR v_challenge.stake_amount <> trunc(v_challenge.stake_amount) THEN
    RAISE EXCEPTION 'Stake must be a whole naira amount between 500 and 50000';
  END IF;

  v_stake_kobo := (v_challenge.stake_amount * 100)::bigint;
  v_fee_kobo := (v_stake_kobo * 5) / 100;
  v_net_kobo := v_stake_kobo - v_fee_kobo;

  INSERT INTO public.wallets (user_id)
  VALUES (v_challenge.sender_id), (v_challenge.recipient_id)
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
  FROM public.wallets
  WHERE user_id IN (v_challenge.sender_id, v_challenge.recipient_id)
  ORDER BY user_id
  FOR UPDATE;

  IF (SELECT available_balance_kobo FROM public.wallets
      WHERE user_id = v_challenge.sender_id) < v_stake_kobo THEN
    RAISE EXCEPTION 'Challenge sender has insufficient available balance';
  END IF;

  IF (SELECT available_balance_kobo FROM public.wallets
      WHERE user_id = v_challenge.recipient_id) < v_stake_kobo THEN
    RAISE EXCEPTION 'Insufficient available balance to accept this challenge';
  END IF;

  -- Remove the full original stake from available balance.
  -- Only the remaining 95% is reserved for the match.
  UPDATE public.wallets
  SET available_balance_kobo = available_balance_kobo - v_stake_kobo,
      reserved_balance_kobo = reserved_balance_kobo + v_net_kobo,
      updated_at = now()
  WHERE user_id IN (v_challenge.sender_id, v_challenge.recipient_id);

  UPDATE public.challenges
  SET status = 'accepted'
  WHERE id = v_challenge.id;

  INSERT INTO public.matches
    (challenge_id, player1_id, player2_id, game, stake_amount, status)
  VALUES
    (v_challenge.id, v_challenge.sender_id, v_challenge.recipient_id,
     v_challenge.game, v_challenge.stake_amount, 'lobby')
  ON CONFLICT (challenge_id) DO NOTHING
  RETURNING id INTO v_match_id;

  IF v_match_id IS NULL THEN
    RAISE EXCEPTION 'A match already exists for this challenge';
  END IF;

  -- Record the actual net reservation for each player.
  INSERT INTO public.wallet_ledger
    (user_id, reference, entry_type, amount_kobo, description)
  VALUES
    (v_challenge.sender_id,
     'stake-reserve:' || v_challenge.id::text || ':' || v_challenge.sender_id::text,
     'stake_reserve', v_net_kobo,
     '95% net stake reserved for match ' || v_match_id::text),
    (v_challenge.recipient_id,
     'stake-reserve:' || v_challenge.id::text || ':' || v_challenge.recipient_id::text,
     'stake_reserve', v_net_kobo,
     '95% net stake reserved for match ' || v_match_id::text);

  -- Record the 5% fee for each player exactly once.
  INSERT INTO public.wallet_ledger
    (user_id, reference, entry_type, amount_kobo, description)
  VALUES
    (v_challenge.sender_id,
     'stake-fee:' || v_challenge.id::text || ':' || v_challenge.sender_id::text,
     'adjustment', v_fee_kobo,
     '5% match acceptance fee for match ' || v_match_id::text),
    (v_challenge.recipient_id,
     'stake-fee:' || v_challenge.id::text || ':' || v_challenge.recipient_id::text,
     'adjustment', v_fee_kobo,
     '5% match acceptance fee for match ' || v_match_id::text);

  INSERT INTO public.platform_earnings
    (source_reference, amount_kobo, description)
  VALUES
    ('match-fee:' || v_challenge.id::text || ':' || v_challenge.sender_id::text,
     v_fee_kobo, '5% match acceptance fee from sender, match ' || v_match_id::text),
    ('match-fee:' || v_challenge.id::text || ':' || v_challenge.recipient_id::text,
     v_fee_kobo, '5% match acceptance fee from recipient, match ' || v_match_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.accept_challenge_and_reserve_stakes(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_challenge_and_reserve_stakes(uuid)
  TO authenticated;

COMMIT;
