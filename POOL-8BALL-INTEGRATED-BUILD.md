# SquadBet 8-Ball Pool integrated build

This build combines the clean 4 November SquadBet foundation project with the authoritative Pool multiplayer implementation.

## Included

- Existing SquadBet app, dashboard, admin, wallet, Whot and Ludo files retained from the foundation ZIP.
- Full-screen 3D Pool scene and aiming/cue controls from `app/snooker/cinematic/`.
- Pool match lobby/readiness integration.
- Authenticated server routes for ready, heartbeat, exit and shot requests.
- Server-side deterministic shot simulation and state-version checks.
- Pool session SQL, normal-win settlement, disconnect settlement and double-disconnect refunds.
- A guard that pauses shot commits while a disconnect countdown is active.
- Corrected disconnect winner selection: the player who first missed the five-minute reconnect deadline forfeits; a later disconnect cannot reverse the winner.

## Tests performed while preparing this ZIP

- `node --test tests/pool-authoritative.test.cjs`: 4 tests passed.
- Archive contains no `.env` or `.env.local` files.
- The original 4 November foundation SQL migration is archived as `.sql.disabled` because it is an earlier schema draft. Do not apply it.

A full Next.js typecheck/build and live two-device gameplay test have not yet been run in the user's Windows environment. This is an integrated test build, not a production-certified release.

## Local Windows test

1. Back up the current `squadbet` folder.
2. Extract this ZIP into a separate folder, e.g. `C:\Users\USER\Desktop\squadbet-pool-build-test`.
3. Copy the existing private `.env.local` from the current project root into the extracted project root. Do not upload or commit it.
4. In PowerShell, from the extracted project root, run:

   ```powershell
   npm.cmd ci
   node --test tests/pool-authoritative.test.cjs
   npm.cmd run typecheck
   npm.cmd run build
   ```

5. Test with two separate accounts and two devices before deploying.

## Database safety

No SQL has been applied by preparing this build. The only executable Pool SQL migrations in this package are:

1. `supabase/migrations/202611040004_pool_live_schema_compatible.sql`
2. `supabase/migrations/202611040005_pool_authoritative_shots_live_schema.sql`

Do not apply the archived `.sql.disabled` foundation draft. Do not apply the older incompatible `002` or `003` drafts from any previous patch. Do not use `supabase db push` until the production migration history has been reconciled. Test these two migrations on a separate staging Supabase project first. Production remains unchanged.

The disconnect sweeper is scheduled automatically only if `pg_cron` is enabled. If it is not enabled, a server-side scheduled invocation of `public.pool_sweep_disconnects()` must be configured before relying on browser-close timeout settlement.

## Important gameplay limitation

The simulation is deterministic and server-run, but it is a lightweight 8-ball implementation, not certified professional billiards physics. Test break rules, fouls, ball-in-hand behavior, legal 8-ball wins and edge cases before public release.
