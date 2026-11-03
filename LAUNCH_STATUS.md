# SquadBet launch status

## Implemented in this package

- Existing Next.js pages and the 8-ball Pool, Whot, and Ludo interfaces retained.
- Login and registration pages retained; password-reset flow added.
- Wallet page added with available/reserved balances and recent deposit history.
- Paystack deposit initialization endpoint with authenticated-user checks, ₦500–₦50,000 limits, and basic per-user checkout rate limiting.
- Server-side Paystack verification and signed webhook handling.
- Supabase migration for wallets, payment transaction records, immutable ledger entries, idempotent deposit crediting, profile/wallet creation for new users, challenge acceptance/rejection RPCs, stake reservation, and relevant indexes/RLS policies.
- Dashboard challenge subscriptions and slower visibility-aware polling fallbacks; match lobby now uses realtime events with slower fallback polling.
- Basic security response headers and deployment documentation.
- Removed local `.env.local`, Git history, and backup files from this distribution ZIP.

## Not yet launch-ready / requires external configuration or additional implementation

- The SQL migration has not been applied to your actual Supabase project and must be reviewed against its current schema and policies first.
- Build, lint, and typecheck could not be verified in this environment because dependency installation timed out. Run the commands in `DEPLOYMENT.md` on your computer or CI.
- Paystack keys are not included. Start in test mode, configure the webhook, and get written provider approval for the intended gaming/stakes model before considering live mode.
- Automated withdrawals/payouts are not enabled. A secure payout process needs provider approval, bank/account validation, reconciliation, anti-fraud controls, and an admin review workflow.
- The match lobby is not a complete authoritative multiplayer server. Shared game moves, server-verified results, disconnection recovery, settlement, refunds, and dispute handling remain to be implemented and tested for each game.
- 2,000+ concurrent users have not been load-tested. Capacity cannot be claimed until traffic testing and monitoring are in place.
- Nigerian legal/compliance review for real-money gaming and payment-provider eligibility remains necessary.


## Admin financial totals update (2026-10-29)
- Added an admin-only SQL aggregate function so total wallet figures are calculated across all wallet rows, not only the first REST response page.
- Admin Finance Overview now displays total player wallet balances (available + reserved), available funds, reserved funds, and separately recorded platform fee entries.
- Added `platform_earnings` table for future verified fee records. Match settlement does not yet automatically write platform fee records, so the displayed recorded earnings may remain zero until settlement integration is implemented.
- Apply `supabase/migrations/202610300001_admin_financial_totals.sql` in Supabase before using the updated finance overview.
- This update is not a declaration of launch readiness. Build and live database verification remain outstanding because dependency installation timed out in this environment.
