# SquadBet Pool Integration Build — Review Required

This archive is based on the original `squadbet-main-project.zip` with Claude's non-backup Pool implementation files selectively overlaid. The original ZIP was not modified.

## Included
- Claude's cinematic Pool engine and UI upgrades.
- Pool HUD/audio/aim helpers and authoritative shot updates.
- Pool session and lobby-cancel API routes, access checks, and related tests.
- Claude's Pool SQL migrations, retained for manual review only.
- Claude's Pool match-page integration.

## Preserved
- Original project package.json and package-lock.json.
- Original root layout and cinematic stylesheet loading (the original CSS import was retained).
- Existing non-Pool SquadBet files and features from the original archive.
- Original disabled migration and all original project files.

## Not done
- No production deployment, Supabase migration, or database write was performed.
- No `npm ci`, Next.js build, real TypeScript check, lint, browser/WebGL test, or two-account staging test was possible in this offline packaging environment.
- This Claude version requires an authenticated user and an accepted Pool challenge with `matchId`; it does not yet provide the separately requested standalone local 1v1/practice mode.

## Before pushing
Run `npm ci`, `node --test tests/*.test.cjs`, `npx tsc --noEmit`, `npm run lint`, and `npm run build` locally. Review every SQL migration and test only against a staging Supabase project.
