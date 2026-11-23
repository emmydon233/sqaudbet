# SquadBet 8-ball Pool multiplayer — foundation update

This ZIP is a **first implementation stage**, not a finished online pool game.

## Included

- A server API endpoint at `POST /api/pool/[matchId]/ready`.
- Bearer-token verification using the existing server-only Supabase admin helper.
- A database migration that adds a participant-readable `pool_game_sessions` table.
- An atomic `pool_set_ready` RPC that locks the match row, verifies the authenticated player is one of the two match participants, records readiness, and creates one session when both players are ready.
- The existing shared match lobby now sends 8-ball Pool readiness to the Pool endpoint.

## Not included yet

The existing 3D pool engine is still a local browser simulation. This foundation does **not** yet synchronize shots or ball physics between devices, validate shots authoritatively on the server, manage Pool disconnect/reconnect countdowns, or settle/refund wallets. The lobby explicitly tells players that the synchronized gameplay is not active yet. Do not advertise Pool multiplayer as launched based on this stage alone.

## Test safely

1. Create/use a separate Supabase staging project and a separate Vercel preview deployment. Do not run this migration against production yet.
2. Configure the staging environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`) in your local `.env.local`. This ZIP intentionally contains no `.env` files or secrets.
3. Apply `supabase/migrations/202611040001_pool_multiplayer_foundation.sql` to the staging database.
4. Install dependencies and run `npm run typecheck` and `npm run build`.
5. In staging, create and accept an 8-ball Pool challenge with two test accounts. Open the same match lobby on both accounts, ready each player, and verify the match becomes `in_progress` and exactly one `pool_game_sessions` row exists for that match.
6. Verify a non-participant cannot mark ready and a player cannot mark ready on another game type.

The migration is not applied automatically by this ZIP. Review it and test it in staging before any production change.
