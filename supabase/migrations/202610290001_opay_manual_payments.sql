-- SquadBet manual OPay Business payments
-- Additive migration: preserve existing wallets, matches and challenges.

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS transfer_reference text,
  ADD COLUMN IF NOT EXISTS admin_note text;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.payment_transactions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.payment_transactions DROP CONSTRAINT %I',
      c.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_provider_check
  CHECK (provider IN ('paystack', 'opay_manual'));

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_opay_transfer_reference_unique
  ON public.payment_transactions (lower(transfer_reference))
  WHERE provider = 'opay_manual'
    AND transfer_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount_kobo bigint NOT NULL CHECK (amount_kobo BETWEEN 50000 AND 5000000),
  bank_name text NOT NULL,
  account_name text NOT NULL,
  account_number text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.withdrawal_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS withdrawal_requests_read_own
  ON public.withdrawal_requests;

CREATE POLICY withdrawal_requests_read_own
  ON public.withdrawal_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS withdrawal_requests_status_created_idx
  ON public.withdrawal_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_transactions_opay_status_created_idx
  ON public.payment_transactions (status, created_at DESC)
  WHERE provider = 'opay_manual';

-- Admin API uses the service-role client. Do not grant ordinary users
-- permission to review deposits or withdrawals.
REVOKE ALL ON public.withdrawal_requests FROM anon, authenticated;
GRANT SELECT ON public.withdrawal_requests TO authenticated;
GRANT ALL ON public.withdrawal_requests TO service_role;

-- Secure manual OPay deposit approval.
CREATE OR REPLACE FUNCTION public.admin_review_opay_deposit(
  p_admin uuid,
  p_reference text,
  p_approve boolean,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tx public.payment_transactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin
     OR COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  SELECT * INTO v_tx
  FROM public.payment_transactions
  WHERE reference = p_reference AND provider = 'opay_manual'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPay deposit request not found';
  END IF;

  IF v_tx.status <> 'pending' THEN
    RAISE EXCEPTION 'This deposit has already been reviewed';
  END IF;

  IF p_approve THEN
    INSERT INTO public.wallets (user_id)
    VALUES (v_tx.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + v_tx.amount_kobo,
        updated_at = now()
    WHERE user_id = v_tx.user_id;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_tx.user_id, 'deposit:' || v_tx.reference, 'deposit',
       v_tx.amount_kobo, 'Manually verified OPay Business deposit');

    UPDATE public.payment_transactions
    SET status = 'success',
        paid_at = now(),
        updated_at = now(),
        admin_note = p_note
    WHERE id = v_tx.id;
  ELSE
    UPDATE public.payment_transactions
    SET status = 'failed',
        updated_at = now(),
        admin_note = p_note
    WHERE id = v_tx.id;
  END IF;
END;
$$;

-- Secure withdrawal review. The withdrawal request API must reserve
-- funds before an administrator can approve or mark it paid.
CREATE OR REPLACE FUNCTION public.admin_review_withdrawal(
  p_admin uuid,
  p_reference text,
  p_action text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.withdrawal_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin
     OR COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  IF p_action NOT IN ('approve', 'reject', 'paid') THEN
    RAISE EXCEPTION 'Invalid withdrawal action';
  END IF;

  SELECT * INTO v_req
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

    UPDATE public.withdrawal_requests
    SET status = 'approved', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSIF p_action = 'reject' THEN
    IF v_req.status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'This withdrawal cannot be rejected';
    END IF;

    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + v_req.amount_kobo,
        reserved_balance_kobo = reserved_balance_kobo - v_req.amount_kobo,
        updated_at = now()
    WHERE user_id = v_req.user_id
      AND reserved_balance_kobo >= v_req.amount_kobo;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reserved withdrawal funds were not found';
    END IF;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_req.user_id, 'withdrawal-refund:' || v_req.reference,
       'refund', v_req.amount_kobo, 'Rejected withdrawal funds returned');

    UPDATE public.withdrawal_requests
    SET status = 'rejected', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSE
    IF v_req.status <> 'approved' THEN
      RAISE EXCEPTION 'Only approved withdrawals can be marked paid';
    END IF;

    UPDATE public.wallets
    SET reserved_balance_kobo = reserved_balance_kobo - v_req.amount_kobo,
        updated_at = now()
    WHERE user_id = v_req.user_id
      AND reserved_balance_kobo >= v_req.amount_kobo;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reserved withdrawal funds were not found';
    END IF;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_req.user_id, 'withdrawal:' || v_req.reference,
       'withdrawal', v_req.amount_kobo, 'Withdrawal paid manually by admin');

    UPDATE public.withdrawal_requests
    SET status = 'paid', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_review_opay_deposit(uuid, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_opay_deposit(uuid, text, boolean, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_review_withdrawal(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_withdrawal(uuid, text, text, text)
  TO service_role;


-- Secure manual OPay deposit approval.
CREATE OR REPLACE FUNCTION public.admin_review_opay_deposit(
  p_admin uuid,
  p_reference text,
  p_approve boolean,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tx public.payment_transactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin
     OR COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  SELECT * INTO v_tx
  FROM public.payment_transactions
  WHERE reference = p_reference AND provider = 'opay_manual'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPay deposit request not found';
  END IF;

  IF v_tx.status <> 'pending' THEN
    RAISE EXCEPTION 'This deposit has already been reviewed';
  END IF;

  IF p_approve THEN
    INSERT INTO public.wallets (user_id)
    VALUES (v_tx.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + v_tx.amount_kobo,
        updated_at = now()
    WHERE user_id = v_tx.user_id;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_tx.user_id, 'deposit:' || v_tx.reference, 'deposit',
       v_tx.amount_kobo, 'Manually verified OPay Business deposit');

    UPDATE public.payment_transactions
    SET status = 'success',
        paid_at = now(),
        updated_at = now(),
        admin_note = p_note
    WHERE id = v_tx.id;
  ELSE
    UPDATE public.payment_transactions
    SET status = 'failed',
        updated_at = now(),
        admin_note = p_note
    WHERE id = v_tx.id;
  END IF;
END;
$$;

-- Secure withdrawal review. The withdrawal request API must reserve
-- funds before an administrator can approve or mark it paid.
CREATE OR REPLACE FUNCTION public.admin_review_withdrawal(
  p_admin uuid,
  p_reference text,
  p_action text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.withdrawal_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin
     OR COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  IF p_action NOT IN ('approve', 'reject', 'paid') THEN
    RAISE EXCEPTION 'Invalid withdrawal action';
  END IF;

  SELECT * INTO v_req
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

    UPDATE public.withdrawal_requests
    SET status = 'approved', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSIF p_action = 'reject' THEN
    IF v_req.status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'This withdrawal cannot be rejected';
    END IF;

    UPDATE public.wallets
    SET available_balance_kobo = available_balance_kobo + v_req.amount_kobo,
        reserved_balance_kobo = reserved_balance_kobo - v_req.amount_kobo,
        updated_at = now()
    WHERE user_id = v_req.user_id
      AND reserved_balance_kobo >= v_req.amount_kobo;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reserved withdrawal funds were not found';
    END IF;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_req.user_id, 'withdrawal-refund:' || v_req.reference,
       'refund', v_req.amount_kobo, 'Rejected withdrawal funds returned');

    UPDATE public.withdrawal_requests
    SET status = 'rejected', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;

  ELSE
    IF v_req.status <> 'approved' THEN
      RAISE EXCEPTION 'Only approved withdrawals can be marked paid';
    END IF;

    UPDATE public.wallets
    SET reserved_balance_kobo = reserved_balance_kobo - v_req.amount_kobo,
        updated_at = now()
    WHERE user_id = v_req.user_id
      AND reserved_balance_kobo >= v_req.amount_kobo;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reserved withdrawal funds were not found';
    END IF;

    INSERT INTO public.wallet_ledger
      (user_id, reference, entry_type, amount_kobo, description)
    VALUES
      (v_req.user_id, 'withdrawal:' || v_req.reference,
       'withdrawal', v_req.amount_kobo, 'Withdrawal paid manually by admin');

    UPDATE public.withdrawal_requests
    SET status = 'paid', admin_note = p_note,
        reviewed_at = now(), reviewed_by = p_admin
    WHERE id = v_req.id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_review_opay_deposit(uuid, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_opay_deposit(uuid, text, boolean, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_review_withdrawal(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_withdrawal(uuid, text, text, text)
  TO service_role;

