
BEGIN;

-- Existing requests used reserved funds. Preserve that accounting
-- so they can still be paid or refunded correctly.
ALTER TABLE public.withdrawal_requests
ADD COLUMN IF NOT EXISTS funds_reserved boolean NOT NULL DEFAULT true;

ALTER TABLE public.withdrawal_requests
ALTER COLUMN funds_reserved SET DEFAULT true;

-- NEW withdrawal requests deduct from available balance only.
CREATE OR REPLACE FUNCTION public.request_manual_withdrawal(
  p_user_id uuid,
  p_amount_kobo bigint,
  p_bank_name text,
  p_account_name text,
  p_account_number text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fee bigint;
  v_net bigint;
  v_ref text := 'WD-' || gen_random_uuid()::text;
  v_wallet public.wallets%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR p_amount_kobo IS NULL
     OR p_amount_kobo < 50000
     OR p_amount_kobo > 5000000
     OR p_amount_kobo % 100 <> 0
     OR length(trim(coalesce(p_bank_name, ''))) < 2
     OR length(trim(coalesce(p_account_name, ''))) < 2
     OR coalesce(trim(p_account_number), '') !~ '^\d{10}$'
  THEN
    RAISE EXCEPTION 'Invalid withdrawal details';
  END IF;

  v_fee := (p_amount_kobo * 5) / 100;
  v_net := p_amount_kobo - v_fee;

  INSERT INTO public.wallets(user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_wallet.available_balance_kobo < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  -- Deduct the gross withdrawal amount once.
  -- Do not increase reserved_balance_kobo for new requests.
  UPDATE public.wallets
  SET available_balance_kobo =
        available_balance_kobo - p_amount_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.withdrawal_requests (
    reference,
    user_id,
    amount_kobo,
    bank_name,
    account_name,
    account_number,
    fee_kobo,
    net_payout_kobo,
    funds_reserved
  )
  VALUES (
    v_ref,
    p_user_id,
    p_amount_kobo,
    trim(p_bank_name),
    trim(p_account_name),
    trim(p_account_number),
    v_fee,
    v_net,
    false
  )
  RETURNING id INTO v_id;

  INSERT INTO public.wallet_ledger (
    user_id,
    reference,
    entry_type,
    amount_kobo,
    currency,
    description
  )
  VALUES (
    p_user_id,
    'withdrawal-request:' || v_ref,
    'withdrawal',
    p_amount_kobo,
    'NGN',
    'Withdrawal requested; gross NGN ' ||
      (p_amount_kobo / 100)::text ||
      ', 5% fee NGN ' || (v_fee / 100)::text ||
      ', net payout NGN ' || (v_net / 100)::text
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'reference', v_ref,
    'amount_kobo', p_amount_kobo,
    'fee_kobo', v_fee,
    'net_payout_kobo', v_net,
    'status', 'pending'
  );
END;
$$;

REVOKE ALL ON FUNCTION
public.request_manual_withdrawal(uuid,bigint,text,text,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.request_manual_withdrawal(uuid,bigint,text,text,text)
TO service_role;


-- Admin review: support both old reserved requests and new
-- available-balance-only requests.
CREATE OR REPLACE FUNCTION public.admin_review_withdrawal(
  p_admin uuid,
  p_reference text,
  p_action text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.withdrawal_requests%ROWTYPE;
  v_fee bigint;
  v_net bigint;
BEGIN
  IF p_admin IS NULL OR NOT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = p_admin
      AND u.raw_app_meta_data->>'role' = 'admin'
  ) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  IF p_action IS NULL
     OR p_action NOT IN ('approve', 'reject', 'paid')
  THEN
    RAISE EXCEPTION 'Invalid withdrawal action';
  END IF;

  IF p_action = 'reject'
     AND length(trim(coalesce(p_note, ''))) = 0
  THEN
    RAISE EXCEPTION 'A rejection reason is required';
  END IF;

  SELECT *
  INTO v_req
  FROM public.withdrawal_requests
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal request not found';
  END IF;

  IF p_action = 'approve' THEN

    IF v_req.status <> 'pending' THEN
      RAISE EXCEPTION 'Only pending withdrawals can be approved';
    END IF;

    -- Approval does not change either wallet balance.
    UPDATE public.withdrawal_requests
    SET status = 'approved',
        admin_note = p_note,
        reviewed_at = now(),
        reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSIF p_action = 'reject' THEN

    IF v_req.status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'This withdrawal cannot be rejected';
    END IF;

    -- Refund the gross amount.
    -- Old requests also release their old reserved amount.
    IF v_req.funds_reserved THEN

      UPDATE public.wallets
      SET available_balance_kobo =
            available_balance_kobo + v_req.amount_kobo,
          reserved_balance_kobo =
            reserved_balance_kobo - v_req.amount_kobo,
          updated_at = now()
      WHERE user_id = v_req.user_id
        AND reserved_balance_kobo >= v_req.amount_kobo;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reserved withdrawal funds were not found';
      END IF;

    ELSE

      UPDATE public.wallets
      SET available_balance_kobo =
            available_balance_kobo + v_req.amount_kobo,
          updated_at = now()
      WHERE user_id = v_req.user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found for withdrawal refund';
      END IF;

    END IF;

    INSERT INTO public.wallet_ledger (
      user_id,
      reference,
      entry_type,
      amount_kobo,
      currency,
      description
    )
    VALUES (
      v_req.user_id,
      'withdrawal-refund:' || v_req.reference,
      'refund',
      v_req.amount_kobo,
      'NGN',
      'Rejected withdrawal returned in full. Reason: ' ||
        trim(p_note)
    );

    UPDATE public.withdrawal_requests
    SET status = 'rejected',
        admin_note = trim(p_note),
        reviewed_at = now(),
        reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSE

    IF v_req.status <> 'approved' THEN
      RAISE EXCEPTION 'Only approved withdrawals can be marked paid';
    END IF;

    -- Old requests release their reserved balance.
    -- New requests have already been deducted, so do nothing.
    IF v_req.funds_reserved THEN

      UPDATE public.wallets
      SET reserved_balance_kobo =
            reserved_balance_kobo - v_req.amount_kobo,
          updated_at = now()
      WHERE user_id = v_req.user_id
        AND reserved_balance_kobo >= v_req.amount_kobo;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Reserved withdrawal funds were not found';
      END IF;

    END IF;

    v_fee := coalesce(
      nullif(v_req.fee_kobo, 0),
      (v_req.amount_kobo * 5) / 100
    );

    v_net := coalesce(
      nullif(v_req.net_payout_kobo, 0),
      v_req.amount_kobo - v_fee
    );

    INSERT INTO public.platform_earnings (
      source_reference,
      amount_kobo,
      description
    )
    VALUES (
      'withdrawal-fee:' || v_req.reference,
      v_fee,
      '5% fee on paid withdrawal ' || v_req.reference
    )
    ON CONFLICT (source_reference) DO NOTHING;

    INSERT INTO public.wallet_ledger (
      user_id,
      reference,
      entry_type,
      amount_kobo,
      currency,
      description
    )
    VALUES (
      v_req.user_id,
      'withdrawal:' || v_req.reference,
      'withdrawal',
      v_req.amount_kobo,
      'NGN',
      'Withdrawal gross NGN ' ||
        (v_req.amount_kobo / 100)::text ||
        '; net paid NGN ' || (v_net / 100)::text
    );

    UPDATE public.withdrawal_requests
    SET status = 'paid',
        admin_note = coalesce(p_note, admin_note),
        reviewed_at = now(),
        reviewed_by = p_admin
    WHERE id = v_req.id;

  END IF;
END;
$$;

REVOKE ALL ON FUNCTION
public.admin_review_withdrawal(uuid,text,text,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
public.admin_review_withdrawal(uuid,text,text,text)
TO service_role;

COMMIT;
