-- SquadBet 8-Ball Pool multiplayer foundation. Apply to production Supabase only after review.
-- Pool challenges reserve each player's stake less the 5% entry fee at acceptance.

CREATE TABLE IF NOT EXISTS public.pool_game_sessions (
  match_id uuid PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  game_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  settlement_status text NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending','settled')),
  winner_id uuid REFERENCES auth.users(id),
  end_reason text,
  player1_last_seen timestamptz,
  player2_last_seen timestamptz,
  player1_disconnected_at timestamptz,
  player2_disconnected_at timestamptz,
  disconnect_deadline timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pool_game_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Pool players can read own session" ON public.pool_game_sessions;
CREATE POLICY "Pool players can read own session" ON public.pool_game_sessions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.matches m WHERE m.id=match_id AND auth.uid() IN (m.player1_id,m.player2_id)));
REVOKE INSERT, UPDATE, DELETE ON public.pool_game_sessions FROM anon, authenticated;
GRANT SELECT ON public.pool_game_sessions TO authenticated;
GRANT ALL ON public.pool_game_sessions TO service_role;

-- For Pool, deduct 5% from each stake into platform earnings and reserve the net stake.
CREATE OR REPLACE FUNCTION public.accept_challenge_and_reserve_stakes(p_challenge_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ch public.challenges%ROWTYPE; v_stake bigint; v_fee bigint; v_net bigint; v_match uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_ch FROM public.challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_ch.recipient_id<>auth.uid() THEN RAISE EXCEPTION 'Only the invited player can accept this challenge'; END IF;
  IF v_ch.status<>'pending' THEN RAISE EXCEPTION 'Challenge is no longer pending'; END IF;
  IF v_ch.sender_id=v_ch.recipient_id THEN RAISE EXCEPTION 'Players must be different'; END IF;
  IF v_ch.game NOT IN ('8-ball Pool','Whot','Ludo') THEN RAISE EXCEPTION 'Unsupported game'; END IF;
  IF v_ch.stake_amount<500 OR v_ch.stake_amount>50000 OR v_ch.stake_amount<>trunc(v_ch.stake_amount) THEN
    RAISE EXCEPTION 'Stake must be a whole naira amount between 500 and 50000';
  END IF;
  v_stake := (v_ch.stake_amount*100)::bigint;
  v_fee := CASE WHEN v_ch.game='8-ball Pool' THEN (v_stake*5)/100 ELSE 0 END;
  v_net := v_stake-v_fee;
  INSERT INTO public.wallets(user_id) VALUES(v_ch.sender_id),(v_ch.recipient_id) ON CONFLICT(user_id) DO NOTHING;
  PERFORM 1 FROM public.wallets WHERE user_id IN(v_ch.sender_id,v_ch.recipient_id) ORDER BY user_id FOR UPDATE;
  IF (SELECT available_balance_kobo FROM public.wallets WHERE user_id=v_ch.sender_id)<v_stake THEN RAISE EXCEPTION 'Challenge sender has insufficient available balance'; END IF;
  IF (SELECT available_balance_kobo FROM public.wallets WHERE user_id=v_ch.recipient_id)<v_stake THEN RAISE EXCEPTION 'Insufficient available balance to accept this challenge'; END IF;
  UPDATE public.wallets SET available_balance_kobo=available_balance_kobo-v_stake,reserved_balance_kobo=reserved_balance_kobo+v_net,updated_at=now()
    WHERE user_id IN(v_ch.sender_id,v_ch.recipient_id);
  UPDATE public.challenges SET status='accepted' WHERE id=v_ch.id;
  INSERT INTO public.matches(challenge_id,player1_id,player2_id,game,stake_amount,status)
    VALUES(v_ch.id,v_ch.sender_id,v_ch.recipient_id,v_ch.game,v_ch.stake_amount,'lobby') ON CONFLICT(challenge_id) DO NOTHING RETURNING id INTO v_match;
  IF v_match IS NULL THEN RAISE EXCEPTION 'A match already exists for this challenge'; END IF;
  INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,description) VALUES
    (v_ch.sender_id,'stake-reserve:'||v_ch.id::text||':'||v_ch.sender_id::text,'stake_reserve',v_net,'Net stake reserved for match '||v_match::text),
    (v_ch.recipient_id,'stake-reserve:'||v_ch.id::text||':'||v_ch.recipient_id::text,'stake_reserve',v_net,'Net stake reserved for match '||v_match::text);
  IF v_fee>0 THEN
    INSERT INTO public.platform_earnings(source_reference,amount_kobo,description) VALUES
      ('pool-entry-fee:'||v_ch.id::text||':'||v_ch.sender_id::text,v_fee,'5% 8-Ball Pool entry fee for match '||v_match::text),
      ('pool-entry-fee:'||v_ch.id::text||':'||v_ch.recipient_id::text,v_fee,'5% 8-Ball Pool entry fee for match '||v_match::text);
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,description) VALUES
      (v_ch.sender_id,'pool-fee:'||v_ch.id::text||':'||v_ch.sender_id::text,'adjustment',v_fee,'5% platform fee on 8-Ball Pool match'),
      (v_ch.recipient_id,'pool-fee:'||v_ch.id::text||':'||v_ch.recipient_id::text,'adjustment',v_fee,'5% platform fee on 8-Ball Pool match');
    INSERT INTO public.pool_game_sessions(match_id,game_state) VALUES(v_match,jsonb_build_object('stake_net_kobo',v_net,'current_player',0,'balls',jsonb_build_array(),'status','lobby'));
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.accept_challenge_and_reserve_stakes(uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.accept_challenge_and_reserve_stakes(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pool_set_ready(p_match_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_m public.matches%ROWTYPE; v_me uuid:=coalesce(auth.uid(),p_user_id); v_p1 boolean; v_p2 boolean;
BEGIN
  IF v_me IS NULL OR (auth.uid() IS NOT NULL AND auth.uid()<>p_user_id) THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_m FROM public.matches WHERE id=p_match_id FOR UPDATE;
  IF NOT FOUND OR v_m.game<>'8-ball Pool' THEN RAISE EXCEPTION '8-Ball Pool match not found'; END IF;
  IF v_me NOT IN(v_m.player1_id,v_m.player2_id) THEN RAISE EXCEPTION 'You are not part of this match'; END IF;
  IF v_m.status NOT IN('lobby','in_progress') THEN RAISE EXCEPTION 'Match is not available'; END IF;
  UPDATE public.matches SET player1_ready=CASE WHEN v_me=v_m.player1_id THEN true ELSE player1_ready END,
    player2_ready=CASE WHEN v_me=v_m.player2_id THEN true ELSE player2_ready END WHERE id=p_match_id;
  SELECT player1_ready,player2_ready INTO v_p1,v_p2 FROM public.matches WHERE id=p_match_id;
  IF v_p1 AND v_p2 THEN
    UPDATE public.matches SET status='in_progress' WHERE id=p_match_id AND status='lobby';
    UPDATE public.pool_game_sessions SET game_state=game_state||jsonb_build_object('status','playing','current_player_id',(SELECT player1_id FROM public.matches WHERE id=p_match_id)),started_at=coalesce(started_at,now()),player1_last_seen=coalesce(player1_last_seen,now()),player2_last_seen=coalesce(player2_last_seen,now()),updated_at=now() WHERE match_id=p_match_id;
  END IF;
  RETURN jsonb_build_object('success',true,'bothReady',v_p1 AND v_p2,'status',CASE WHEN v_p1 AND v_p2 THEN 'in_progress' ELSE 'lobby' END);
END; $$;
REVOKE ALL ON FUNCTION public.pool_set_ready(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.pool_set_ready(uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pool_presence(p_match_id uuid,p_action text,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_m public.matches%ROWTYPE; v_s public.pool_game_sessions%ROWTYPE; v_me uuid:=coalesce(auth.uid(),p_user_id); v_now timestamptz:=now(); v_both_gone boolean;
BEGIN
  IF v_me IS NULL OR (auth.uid() IS NOT NULL AND auth.uid()<>p_user_id) THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_m FROM public.matches WHERE id=p_match_id FOR UPDATE;
  IF NOT FOUND OR v_m.game<>'8-ball Pool' OR v_me NOT IN(v_m.player1_id,v_m.player2_id) THEN RAISE EXCEPTION 'Match not found or unauthorized'; END IF;
  SELECT * INTO v_s FROM public.pool_game_sessions WHERE match_id=p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool session missing'; END IF;
  IF v_s.settlement_status='settled' THEN RETURN jsonb_build_object('success',true,'settled',true); END IF;
  IF p_action='heartbeat' THEN
    UPDATE public.pool_game_sessions SET
      player1_last_seen=CASE WHEN v_me=v_m.player1_id THEN v_now ELSE player1_last_seen END,
      player2_last_seen=CASE WHEN v_me=v_m.player2_id THEN v_now ELSE player2_last_seen END,
      player1_disconnected_at=CASE WHEN v_me=v_m.player1_id THEN NULL ELSE player1_disconnected_at END,
      player2_disconnected_at=CASE WHEN v_me=v_m.player2_id THEN NULL ELSE player2_disconnected_at END,
      disconnect_deadline=CASE
        WHEN v_me=v_m.player1_id AND player1_disconnected_at IS NOT NULL THEN CASE WHEN player2_disconnected_at IS NOT NULL THEN v_now+interval '5 minutes' ELSE NULL END
        WHEN v_me=v_m.player2_id AND player2_disconnected_at IS NOT NULL THEN CASE WHEN player1_disconnected_at IS NOT NULL THEN v_now+interval '5 minutes' ELSE NULL END
        ELSE disconnect_deadline END,
      updated_at=v_now WHERE match_id=p_match_id;
    RETURN jsonb_build_object('success',true,'returned',true);
  ELSIF p_action='leave' THEN
    UPDATE public.pool_game_sessions SET
      player1_disconnected_at=CASE WHEN v_me=v_m.player1_id THEN coalesce(player1_disconnected_at,v_now) ELSE player1_disconnected_at END,
      player2_disconnected_at=CASE WHEN v_me=v_m.player2_id THEN coalesce(player2_disconnected_at,v_now) ELSE player2_disconnected_at END,
      disconnect_deadline=coalesce(disconnect_deadline,v_now+interval '5 minutes'),updated_at=v_now WHERE match_id=p_match_id;
    RETURN jsonb_build_object('success',true,'deadline',v_now+interval '5 minutes');
  ELSE RAISE EXCEPTION 'Unsupported presence action'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.pool_presence(uuid,text,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.pool_presence(uuid,text,uuid) TO authenticated,service_role;

-- Realtime publishes the match status and pool session presence. Settlement is deliberately a
-- separate server RPC to be wired with the finalized game outcome/disconnect sweeper.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND
     NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='pool_game_sessions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pool_game_sessions;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pool_resolve_disconnect(p_match_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_m public.matches%ROWTYPE; v_s public.pool_game_sessions%ROWTYPE; v_net bigint; v_winner uuid; v_both boolean;
BEGIN
  IF coalesce(auth.uid(),p_user_id) IS NULL OR (auth.uid() IS NOT NULL AND auth.uid()<>p_user_id) THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_m FROM public.matches WHERE id=p_match_id FOR UPDATE;
  IF NOT FOUND OR v_m.game<>'8-ball Pool' OR coalesce(auth.uid(),p_user_id) NOT IN(v_m.player1_id,v_m.player2_id) THEN RAISE EXCEPTION 'Match not found or unauthorized'; END IF;
  SELECT * INTO v_s FROM public.pool_game_sessions WHERE match_id=p_match_id FOR UPDATE;
  IF v_s.settlement_status='settled' THEN RETURN jsonb_build_object('success',true,'settled',true,'winnerId',v_s.winner_id,'reason',v_s.end_reason); END IF;
  IF v_s.disconnect_deadline IS NULL OR v_s.disconnect_deadline>now() THEN RETURN jsonb_build_object('success',true,'settled',false,'deadline',v_s.disconnect_deadline); END IF;
  v_both := v_s.player1_disconnected_at IS NOT NULL AND v_s.player2_disconnected_at IS NOT NULL;
  IF NOT v_both THEN
    IF v_s.player1_disconnected_at IS NOT NULL THEN v_winner:=v_m.player2_id;
    ELSIF v_s.player2_disconnected_at IS NOT NULL THEN v_winner:=v_m.player1_id;
    ELSE RETURN jsonb_build_object('success',true,'settled',false); END IF;
  END IF;
  v_net := coalesce((v_s.game_state->>'stake_net_kobo')::bigint,(v_m.stake_amount*100)::bigint);
  UPDATE public.wallets SET reserved_balance_kobo=reserved_balance_kobo-v_net,updated_at=now() WHERE user_id IN(v_m.player1_id,v_m.player2_id);
  IF v_both THEN
    UPDATE public.wallets SET available_balance_kobo=available_balance_kobo+v_net,updated_at=now() WHERE user_id IN(v_m.player1_id,v_m.player2_id);
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,description) VALUES
      (v_m.player1_id,'pool-refund:'||p_match_id::text||':'||v_m.player1_id::text,'refund',v_net,'8-Ball Pool double-disconnect refund'),
      (v_m.player2_id,'pool-refund:'||p_match_id::text||':'||v_m.player2_id::text,'refund',v_net,'8-Ball Pool double-disconnect refund');
    UPDATE public.pool_game_sessions SET settlement_status='settled',end_reason='both_disconnected_refund',updated_at=now() WHERE match_id=p_match_id;
    UPDATE public.matches SET status='cancelled' WHERE id=p_match_id;
    RETURN jsonb_build_object('success',true,'settled',true,'result','refund');
  ELSE
    UPDATE public.wallets SET available_balance_kobo=available_balance_kobo+(v_net*2),updated_at=now() WHERE user_id=v_winner;
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,description) VALUES
      (v_winner,'pool-disconnect-win:'||p_match_id::text,'payout',v_net*2,'8-Ball Pool win after opponent failed to reconnect within five minutes');
    UPDATE public.pool_game_sessions SET settlement_status='settled',winner_id=v_winner,end_reason='disconnect_forfeit',updated_at=now() WHERE match_id=p_match_id;
    UPDATE public.matches SET status='completed' WHERE id=p_match_id;
    RETURN jsonb_build_object('success',true,'settled',true,'result','forfeit','winnerId',v_winner);
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.pool_resolve_disconnect(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.pool_resolve_disconnect(uuid,uuid) TO authenticated,service_role;

-- Save a turn snapshot only from the authenticated player whose turn the database records.
-- The current browser-side Three.js physics still needs a server simulation before payouts
-- for normal 8-ball wins can be safely automated.
CREATE OR REPLACE FUNCTION public.pool_submit_snapshot(p_match_id uuid,p_snapshot jsonb,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_m public.matches%ROWTYPE; v_s public.pool_game_sessions%ROWTYPE; v_turn uuid; v_next uuid; v_idx integer;
BEGIN
  IF coalesce(auth.uid(),p_user_id) IS NULL OR (auth.uid() IS NOT NULL AND auth.uid()<>p_user_id) THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_m FROM public.matches WHERE id=p_match_id FOR UPDATE;
  IF NOT FOUND OR v_m.game<>'8-ball Pool' OR coalesce(auth.uid(),p_user_id) NOT IN(v_m.player1_id,v_m.player2_id) THEN RAISE EXCEPTION 'Match not found or unauthorized'; END IF;
  IF v_m.status<>'in_progress' THEN RAISE EXCEPTION 'Match is not live'; END IF;
  SELECT * INTO v_s FROM public.pool_game_sessions WHERE match_id=p_match_id FOR UPDATE;
  IF v_s.settlement_status='settled' THEN RAISE EXCEPTION 'Match has already settled'; END IF;
  v_turn := coalesce((v_s.game_state->>'current_player_id')::uuid,v_m.player1_id);
  IF v_turn<>coalesce(auth.uid(),p_user_id) THEN RAISE EXCEPTION 'It is not your turn'; END IF;
  IF jsonb_typeof(p_snapshot->'balls')<>'array' OR jsonb_array_length(p_snapshot->'balls')<>16 THEN RAISE EXCEPTION 'Invalid ball snapshot'; END IF;
  v_idx := CASE WHEN (p_snapshot->>'currentPlayer')::integer=1 THEN 1 ELSE 0 END;
  v_next := CASE WHEN v_idx=1 THEN v_m.player2_id ELSE v_m.player1_id END;
  UPDATE public.pool_game_sessions SET game_state=game_state||jsonb_build_object('snapshot',p_snapshot,'current_player_id',v_next,'status',CASE WHEN coalesce((p_snapshot->>'gameOver')::boolean,false) THEN 'game_over' ELSE 'playing' END),updated_at=now()
    WHERE match_id=p_match_id;
  RETURN jsonb_build_object('success',true,'nextPlayerId',v_next,'gameOver',coalesce((p_snapshot->>'gameOver')::boolean,false));
END; $$;
REVOKE ALL ON FUNCTION public.pool_submit_snapshot(uuid,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.pool_submit_snapshot(uuid,jsonb,uuid) TO authenticated,service_role;

-- Background worker so the five-minute rule resolves even if both players remain offline.
CREATE OR REPLACE FUNCTION public.pool_sweep_disconnects()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row record; v_count integer:=0;
BEGIN
  FOR v_row IN
    SELECT s.match_id,m.player1_id
    FROM public.pool_game_sessions s JOIN public.matches m ON m.id=s.match_id
    WHERE s.settlement_status='pending' AND s.disconnect_deadline IS NOT NULL AND s.disconnect_deadline<=now()
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    PERFORM public.pool_resolve_disconnect(v_row.match_id,v_row.player1_id);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE ALL ON FUNCTION public.pool_sweep_disconnects() FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pool_sweep_disconnects() TO service_role;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule('squadbet-pool-disconnect-sweeper','* * * * *','select public.pool_sweep_disconnects();');
  ELSE
    RAISE NOTICE 'pg_cron is not enabled; schedule public.pool_sweep_disconnects() every minute in Supabase Cron to enforce timeout refunds/forfeits while both players are offline.';
  END IF;
END $$;

ALTER TABLE public.pool_game_sessions ADD COLUMN IF NOT EXISTS started_at timestamptz;
-- Replace sweeper body to detect abrupt browser closes/network drops from stale heartbeats.
CREATE OR REPLACE FUNCTION public.pool_sweep_disconnects()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row record; v_count integer:=0; v_now timestamptz:=now();
BEGIN
  UPDATE public.pool_game_sessions s SET
    player1_disconnected_at=CASE WHEN s.player1_disconnected_at IS NULL AND coalesce(s.player1_last_seen,s.started_at)<v_now-interval '20 seconds' THEN v_now ELSE s.player1_disconnected_at END,
    player2_disconnected_at=CASE WHEN s.player2_disconnected_at IS NULL AND coalesce(s.player2_last_seen,s.started_at)<v_now-interval '20 seconds' THEN v_now ELSE s.player2_disconnected_at END,
    disconnect_deadline=CASE WHEN (s.player1_disconnected_at IS NULL AND coalesce(s.player1_last_seen,s.started_at)<v_now-interval '20 seconds') OR (s.player2_disconnected_at IS NULL AND coalesce(s.player2_last_seen,s.started_at)<v_now-interval '20 seconds') THEN coalesce(s.disconnect_deadline,v_now+interval '5 minutes') ELSE s.disconnect_deadline END,
    updated_at=v_now
  FROM public.matches m
  WHERE m.id=s.match_id AND m.status='in_progress' AND s.settlement_status='pending'
    AND ((s.player1_disconnected_at IS NULL AND coalesce(s.player1_last_seen,s.started_at)<v_now-interval '20 seconds') OR (s.player2_disconnected_at IS NULL AND coalesce(s.player2_last_seen,s.started_at)<v_now-interval '20 seconds'));
  FOR v_row IN
    SELECT s.match_id,m.player1_id
    FROM public.pool_game_sessions s JOIN public.matches m ON m.id=s.match_id
    WHERE s.settlement_status='pending' AND s.disconnect_deadline IS NOT NULL AND s.disconnect_deadline<=v_now
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    PERFORM public.pool_resolve_disconnect(v_row.match_id,v_row.player1_id);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END; $$;
