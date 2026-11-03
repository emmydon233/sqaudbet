# SquadBet production preparation

## Current status

This package includes the existing Next.js app, a Paystack deposit checkout flow, signed-webhook verification, a server-side payment verification endpoint, and a Supabase SQL migration for idempotent wallet crediting. It is **not yet a live-money launch approval**: provider credentials, the database migration, provider approval for the intended gaming model, multiplayer server validation, and end-to-end/load testing are still required.

## Local setup

1. Install Node.js 20.9+ (or the version supported by your installed Next.js release).
2. Copy `.env.example` to `.env.local` in the project root (same level as `package.json`).
3. Fill in Supabase URL and publishable/anon key. For payment server routes, add the Supabase service-role key and Paystack test secret. Never share or commit secret keys.
4. In Supabase SQL Editor, review and apply `supabase/migrations/202610260001_payments_wallet.sql`. Back up the database first and reconcile with existing tables/policies before applying to an existing production database.
5. Run `npm ci`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
6. Start locally with `npm run dev` and test account creation/login, wallet display, and Paystack test-mode checkout.

## Paystack test setup

- Start with Paystack test keys only.
- Set the webhook URL in Paystack to `https://YOUR_DOMAIN/api/webhooks/paystack`.
- Set `NEXT_PUBLIC_APP_URL` to the deployed site origin.
- Test successful, abandoned, failed, repeated-webhook, mismatched-amount, rate-limited checkout, and delayed-confirmation cases.
- Supabase Realtime must be enabled for the `challenges` and `matches` tables; the migration adds them to `supabase_realtime` when that publication exists.
- Server-side verification and webhook signature checks are both used. A browser redirect alone never credits a wallet.
- Do not enable live keys until Paystack has explicitly approved the business model and applicable legal requirements are addressed.

## Vercel

- Import the repository into Vercel.
- Framework preset: Next.js.
- Build command: `npm run build`.
- Add each environment variable under Project Settings → Environment Variables for Preview and Production separately.
- Deploy first to Preview and test with test credentials.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `PAYSTACK_SECRET_KEY` server-only. They must never use the `NEXT_PUBLIC_` prefix.

## Render

Do not add Render just to host the Next.js site. Add a Render service only when the game implementation has a persistent authoritative game server or a worker that needs to stay running. For real-time multiplayer, game state and match events must be validated on the server and shared between instances (for example via a shared store/pub-sub design); do not trust client-submitted winners or payouts.

## Still required before launch

- Review the SQL migration against the existing database before applying it. It creates/updates wallet, payment, challenge and match structures and RLS policies; existing production policies or constraints may need reconciliation.
- Verify the `accept_challenge_and_reserve_stakes` RPC with two funded test accounts and concurrent acceptance attempts.
- Implement and test server-authoritative game state and match settlement for 8-ball Pool, Whot, and Ludo. The current lobby is not itself a synchronized multiplayer game server.
- Implement an approved, audited withdrawal/payout process with identity/anti-fraud checks, idempotency, limits, and reconciliation. This package intentionally does not automatically pay out withdrawals.
- Add rate limiting/bot protection, monitoring, error reporting, backups/restore drills, and load tests targeting at least 2,000 simultaneous sessions.
- Confirm legal eligibility and written payment-provider approval for real-money gaming/stakes in the target market.
