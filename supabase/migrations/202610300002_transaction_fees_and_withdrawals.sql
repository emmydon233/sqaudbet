-- SquadBet 5% transaction fees and safe manual withdrawal reservation.
-- Additive: existing wallet/payment rows are preserved. Amounts are integer kobo.

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS fee_kobo bigint NOT NULL DEFAULT 0 CHECK (fee_kobo >= 0),
  ADD COLUMN IF NOT EXISTS net_credit_kobo bigint;

ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS fee_kobo bigint NOT NULL DEFAULT 0 CHECK (fee_kobo >= 0),
  ADD COLUMN IF NOT EXISTS net_payout_kobo bigint;

CREATE TABLE IF NOT EXISTS public.platform_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_reference text NOT NULL UNIQUE,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_earnings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_earnings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.platform_earnings TO service_role;

-- Service-role-only API function. The API must verify the user's bearer token first.
CREATE OR REPLACE FUNCTION public.request_manual_withdrawal(
  p_user_id uuid,
  p_amount_kobo bigint,
  p_bank_name text,
  p_account_name text,
  p_account_number text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fee bigint;
  v_net bigint;
  v_ref text := 'WD-' || gen_random_uuid()::text;
  v_wallet public.wallets%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_amount_kobo < 50000 OR p_amount_kobo > 5000000
     OR p_amount_kobo % 100 <> 0
     OR length(trim(coalesce(p_bank_name,''))) < 2
     OR length(trim(coalesce(p_account_name,''))) < 2
     OR coalesce(trim(p_account_number),'') !~ '^\d{10}$' THEN
    RAISE EXCEPTION 'Invalid withdrawal details';
  END IF;
  v_fee := (p_amount_kobo * 5) / 100;
  v_net := p_amount_kobo - v_fee;

  INSERT INTO public.wallets(user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_wallet.available_balance_kobo < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  UPDATE public.wallets
  SET available_balance_kobo = available_balance_kobo - p_amount_kobo,
      reserved_balance_kobo = reserved_balance_kobo + p_amount_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.withdrawal_requests
    (reference,user_id,amount_kobo,bank_name,account_name,account_number,fee_kobo,net_payout_kobo)
  VALUES
    (v_ref,p_user_id,p_amount_kobo,trim(p_bank_name),trim(p_account_name),p_account_number,v_fee,v_net)
  RETURNING id INTO v_id;

  INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,currency,description)
  VALUES (p_user_id,'withdrawal-reserve:' || v_ref,'withdrawal',p_amount_kobo,'NGN',
          'Withdrawal requested; 5% fee NGN ' || (v_fee/100)::text || ', net payout NGN ' || (v_net/100)::text);
  RETURN jsonb_build_object('id',v_id,'reference',v_ref,'amount_kobo',p_amount_kobo,
                            'fee_kobo',v_fee,'net_payout_kobo',v_net,'status','pending');
END;
$$;
REVOKE ALL ON FUNCTION public.request_manual_withdrawal(uuid,bigint,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_manual_withdrawal(uuid,bigint,text,text,text) TO service_role;

-- Replace review routines so service-role API calls authenticate the admin against auth.users.
CREATE OR REPLACE FUNCTION public.admin_review_opay_deposit(
  p_admin uuid, p_reference text, p_approve boolean, p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_tx public.payment_transactions%ROWTYPE; v_fee bigint; v_net bigint;
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_admin AND u.raw_app_meta_data->>'role'='admin'
  ) THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  SELECT * INTO v_tx FROM public.payment_transactions
  WHERE reference=p_reference AND provider='opay_manual' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPay deposit request not found'; END IF;
  IF v_tx.status <> 'pending' THEN RAISE EXCEPTION 'This deposit has already been reviewed'; END IF;
  IF p_approve THEN
    v_fee := (v_tx.amount_kobo * 5) / 100;
    v_net := v_tx.amount_kobo - v_fee;
    INSERT INTO public.wallets(user_id) VALUES(v_tx.user_id) ON CONFLICT(user_id) DO NOTHING;
    UPDATE public.wallets SET available_balance_kobo=available_balance_kobo+v_net, updated_at=now()
      WHERE user_id=v_tx.user_id;
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,currency,description)
      VALUES(v_tx.user_id,'deposit:'||v_tx.reference,'deposit',v_net,'NGN',
             'OPay deposit NGN '||(v_tx.amount_kobo/100)::text||' less 5% fee NGN '||(v_fee/100)::text);
    INSERT INTO public.platform_earnings(source_reference,amount_kobo,description)
      VALUES('deposit-fee:'||v_tx.reference,v_fee,'5% fee on OPay deposit '||v_tx.reference)
      ON CONFLICT(source_reference) DO NOTHING;
    UPDATE public.payment_transactions SET status='success',fee_kobo=v_fee,net_credit_kobo=v_net,
      paid_at=now(),updated_at=now(),admin_note=p_note WHERE reference = v_tx.reference;
  ELSE
    UPDATE public.payment_transactions SET status='failed',updated_at=now(),admin_note=p_note WHERE reference = v_tx.reference;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_opay_deposit(uuid,text,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_opay_deposit(uuid,text,boolean,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_review_withdrawal(
  p_admin uuid, p_reference text, p_action text, p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_req public.withdrawal_requests%ROWTYPE;
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_admin AND u.raw_app_meta_data->>'role'='admin'
  ) THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  IF p_action NOT IN ('approve','reject','paid') THEN RAISE EXCEPTION 'Invalid withdrawal action'; END IF;
  SELECT * INTO v_req FROM public.withdrawal_requests WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;

  IF p_action='approve' THEN
    IF v_req.status<>'pending' THEN RAISE EXCEPTION 'Only pending withdrawals can be approved'; END IF;
    UPDATE public.withdrawal_requests SET status='approved',admin_note=p_note,reviewed_at=now(),reviewed_by=p_admin WHERE id=v_req.id;
  ELSIF p_action='reject' THEN
    IF v_req.status NOT IN ('pending','approved') THEN RAISE EXCEPTION 'This withdrawal cannot be rejected'; END IF;
    UPDATE public.wallets SET available_balance_kobo=available_balance_kobo+v_req.amount_kobo,
      reserved_balance_kobo=reserved_balance_kobo-v_req.amount_kobo,updated_at=now()
      WHERE user_id=v_req.user_id AND reserved_balance_kobo>=v_req.amount_kobo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reserved withdrawal funds were not found'; END IF;
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,currency,description)
      VALUES(v_req.user_id,'withdrawal-refund:'||v_req.reference,'refund',v_req.amount_kobo,'NGN','Rejected withdrawal returned in full');
    UPDATE public.withdrawal_requests SET status='rejected',admin_note=p_note,reviewed_at=now(),reviewed_by=p_admin WHERE id=v_req.id;
  ELSE
    IF v_req.status<>'approved' THEN RAISE EXCEPTION 'Only approved withdrawals can be marked paid'; END IF;
    UPDATE public.wallets SET reserved_balance_kobo=reserved_balance_kobo-v_req.amount_kobo,updated_at=now()
      WHERE user_id=v_req.user_id AND reserved_balance_kobo>=v_req.amount_kobo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reserved withdrawal funds were not found'; END IF;
    INSERT INTO public.platform_earnings(source_reference,amount_kobo,description)
      VALUES('withdrawal-fee:'||v_req.reference,coalesce(v_req.fee_kobo,(v_req.amount_kobo*5)/100),'5% fee on paid withdrawal '||v_req.reference)
      ON CONFLICT(source_reference) DO NOTHING;
    INSERT INTO public.wallet_ledger(user_id,reference,entry_type,amount_kobo,currency,description)
      VALUES(v_req.user_id,'withdrawal:'||v_req.reference,'withdrawal',v_req.amount_kobo,'NGN',
             'Withdrawal gross NGN '||(v_req.amount_kobo/100)::text||'; net paid NGN '||(coalesce(v_req.net_payout_kobo,v_req.amount_kobo-(v_req.amount_kobo*5)/100)/100)::text);
    UPDATE public.withdrawal_requests SET status='paid',admin_note=p_note,reviewed_at=now(),reviewed_by=p_admin WHERE id=v_req.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_withdrawal(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_withdrawal(uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_financial_totals()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'available_wallet_kobo',coalesce((SELECT sum(available_balance_kobo) FROM public.wallets),0),
  'reserved_wallet_kobo',coalesce((SELECT sum(reserved_balance_kobo) FROM public.wallets),0),
  'total_player_wallet_kobo',coalesce((SELECT sum(available_balance_kobo+reserved_balance_kobo) FROM public.wallets),0),
  'recorded_platform_earnings_kobo',coalesce((SELECT sum(amount_kobo) FROM public.platform_earnings),0)
 );
$$;
REVOKE ALL ON FUNCTION public.admin_financial_totals() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_financial_totals() TO service_role;







