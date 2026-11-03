-- SquadBet admin finance totals. Apply after the existing wallet/payment migrations.
-- Earnings are recorded separately so player money is never treated as platform income.
CREATE TABLE IF NOT EXISTS public.platform_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_reference text NOT NULL UNIQUE,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_earnings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_earnings FROM anon, authenticated;
GRANT ALL ON public.platform_earnings TO service_role;

-- Server-only aggregate avoids PostgREST row limits making totals inaccurate
-- when SquadBet grows beyond the default row page size.
CREATE OR REPLACE FUNCTION public.admin_financial_totals()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'available_wallet_kobo', COALESCE((SELECT SUM(available_balance_kobo) FROM public.wallets), 0),
    'reserved_wallet_kobo', COALESCE((SELECT SUM(reserved_balance_kobo) FROM public.wallets), 0),
    'total_player_wallet_kobo', COALESCE((SELECT SUM(available_balance_kobo + reserved_balance_kobo) FROM public.wallets), 0),
    'recorded_platform_earnings_kobo', COALESCE((SELECT SUM(amount_kobo) FROM public.platform_earnings), 0)
  );
$$;
REVOKE ALL ON FUNCTION public.admin_financial_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_financial_totals() TO service_role;
