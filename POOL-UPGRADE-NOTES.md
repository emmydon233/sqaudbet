# SquadBet 8-Ball Pool — upgrade notes (review copy, NOT deployed)

The existing cinematic Three.js game (`app/snooker/cinematic/main.ts`) is the foundation: same scene, table,
lighting, materials, camera look, cue, ball meshes and local physics. Features were added inside it.

## Files
Modified: `app/snooker/cinematic/main.ts`, `app/pool3d/page.tsx`, `app/api/pool/[matchId]/shot/route.ts`,
`lib/pool/authoritative.js`, `lib/pool/authoritative.d.ts`
New: `app/pool3d/pool-game.css` (all selectors scoped to `.pool-game-shell.pg-root`),
`app/pool3d/engine/{hud,audio,common}.ts`, `lib/pool/aim.{js,d.ts}`,
`app/api/pool/[matchId]/session/route.ts`, `tests/pool-features.test.cjs`, `tests/pool-routes-static.test.cjs`
Untouched: globals.css, layout, dashboard/wallet/admin, Tailwind config, Supabase migrations.
SQL migrations: none required (spin/placement travel in the existing `p_shot_meta jsonb`).

## What changed
Visual: Player 1/2 HUDs (avatar, username, YOU, solids/stripes, remaining-ball tray, turn glow), stake/status,
power bar, spin selector, settings/sound/fullscreen/help/exit, rotate-device prompt, safe-area + phone/tablet/desktop layouts.
Gameplay: aim guide from real geometry (contact, object-ball line, pocket prediction, cue deflection), spin with
real physics effect (no spin = identical to original engine), ball-in-hand after fouls, synthesized autoplay-safe sounds.
Touch safety: touch only aims/places; power bar starts at 0 and fires on release only above a minimum.
Multiplayer: server stays authoritative (version, turn, settlement, idempotency unchanged). Client shows the shot
as a replay and cross-checks against the server snapshot. New `/session` route re-checks accepted-challenge
participation server-side before the game loads. Exit uses the existing `/exit` route.

## Verified (actually run)
- `node --test tests/*.test.cjs`: 23 pass, 0 fail
- No-spin results identical to original engine on 240/240 random shots
- Stubbed `tsc` (strict) on main.ts/hud/audio/common: clean; page.tsx: only stub-induced implicit-any errors
- HUD DOM layout checked in Chromium at 6 viewport sizes (earlier harness)

## NOT verified (sandbox has no node_modules/network/DB)
`next build`, real `tsc`, ESLint, the live 3D scene, real two-device multiplayer, DB-level access/out-of-turn/
duplicate/settlement tests. Run locally:
`npm ci && node --test tests/*.test.cjs && npx tsc --noEmit && npm run lint && npm run build && npm run dev`
then test two accounts with an accepted challenge on a staging/preview Supabase, not production.

## Deploy (only with owner approval)
Push to a branch → Vercel Preview deployment → test → promote. No env var or SQL changes.
Known limits: spin is a lightweight approximation; replay of server shots is a client-side 60 Hz re-simulation.

## Addendum: cue direction + pocket drop (visual only, in main.ts)
- Cue tip now glows; four white chevrons march along the shot line from the cue ball.
- Each pocket has a dark hole disc; pocketed balls roll to the pocket centre, drop with gravity, shrink slightly, then hide.
  Game logic still marks the ball pocketed instantly, so rules/server results are unchanged.
- Not verified visually in this sandbox (3D scene cannot be run here): check the drop timing and hole size on a real match.
- Pockets (follow-up): the flat black lid was replaced by a deep radial-shaded hole disc just above the felt, a leather-brown lip
  and the original brass ring. Cushion "jaw" shapes at the pocket mouths were NOT added (would need visual tuning on a real render).
- Table now fills the screen: camera is steeper (y 7.2, z 3.9) and fits the playing surface + pockets (wood frame cropped) to the window;
  side controls reserve space, top/bottom HUD bars overlap the rails slightly. Unverified visually here; tune CAM_Y/CAM_Z and the 0.42 margin in fitCamera().
- Aim guide is now drawn with thick white ribbons (WebGL 1px lines were too faint): cue ball -> white ghost-ball ring, the object ball's
  departure line from the contact point, and a fainter cue-ball deflection line. "Full" guide is the default; Settings can switch to a single line.


# Round 3 (testing-ZIP fixes + Naija pop-ups)

## Pool fixes
- **Stuck turn after a dry shot.** Engine-level turn handling was correct (tested below). The turn could get stuck because the
  next player's screen depended on a single realtime event, with no recovery. Fixed: 3 s server-checked poll via the existing
  `/session` route, resync when the tab returns, the player who completes the "ready" handshake goes live immediately,
  `serverShotPending` is no longer cleared by unrelated `matches` row updates, the render loop survives errors, and playback
  fast-forwards to the server result when a tab was in the background.
- **Balls**: numbers 1-15 printed on six sides of every ball; solids/stripes clear; cue ball has red spots; bloom reduced.
- **Realism**: cue gets ferrule, hardwood sleeve and rings; table gets grain wood and woven-cloth felt textures.
- **Fullscreen**: always shown. Real Fullscreen API (incl. `webkit` prefix) when available, otherwise an immersive layout (iPhone Safari).
- **Right-side controls**: 38-41 px, higher contrast, 2-column grid on short landscape phones. No overlaps in the 6 sizes tested.
- Removed two stray compiled files (`app/pool3d/engine/hud.js`, `common.js`) that an earlier build step had leaked into the ZIP.

## Naija pop-ups (new, isolated)
`lib/naija/messages.ts` (4 separate collections), `lib/naija/popup-bus.ts` (queue + dedupe), `components/naija-popup.tsx`
(mounted once in `app/layout.tsx`). Triggers: login success, registration success / email confirmation, confirmed Pool and Whot results.
Ludo: the current Ludo page is an offline demo with no official result, so only the ready-made `queueGameResultPopup("ludo", ...)` call exists.

## Round 4 additions
- Instant shots: the shot plays on screen immediately using the same deterministic engine the server runs; the real request goes out in parallel. The server confirms (no visible change), corrects (table snaps to the server's), or rejects (rolled back). Shots that would end the match are never shown optimistically, so wins/losses wait for the server. Server validation, versioning, wallet and settlement are unchanged.
- Aim guide lengths, larger balls, bigger number discs, flatter ball lighting, camera framing, stuck-turn watchdog.

## Round 5: cue ball dropped into a pocket
- Rule (server, `lib/pool/authoritative.js`): while a player has ball in hand, dropping the cue ball into a pocket hole is a foul. No balls move, the opponent gets ball in hand and the turn passes to them. It only applies when the server flagged ball in hand, so it cannot be used to skip a normal turn. A placement merely touching the pocket mouth is still rejected as illegal.
- Client (`main.ts`): releasing the dragged cue ball on a hole sends that placement for the server to rule on (online matches only).
- Tests: `tests/pool-pocket-placement-foul.test.cjs`, plus an updated expectation in `pool-features.test.cjs`.

## Round 6: ball size, pocket entry, readability lighting
- Balls drawn at a medium size (visual only): 1.05x on desktop, 1.12x on screens under 1000px wide. Physics radius unchanged.
- Pocket entry: balls accelerate into the mouth, tip over the lip and fall with gravity, shrink as they go deeper, and a soft rattle plays inside the pocket (`audio.rattle()`).
- Lighting: cinematic look kept, harsh lights weakened (key 200->105, wash 1.7->1.0, rim 1.3->0.6, spot 70->35; overhead readability light 0.7) and a soft overhead "readability" light added; ball colour multiplier raised to compensate.

## Round 7: stake amounts
- Dashboard challenge form: the stake field is a typed amount with quick-pick buttons; only 500, 1,000, 1,500 ... 50,000 (steps of 500) are accepted. Anything else (e.g. 1,300) is rejected with a message suggesting the valid amounts (e.g. "use ₦1,500 instead, or ₦1,000, ₦2,000 and above"). Wallet, reservation, settlement and refund logic are untouched.
- Optional DB rule for review (NOT applied; `.sql.disabled`): `supabase/migrations/202611190001_stake_multiple_of_500.sql.disabled`. Without it, the rule is enforced in the app only; the existing DB check still allows any whole amount 500-50,000.

## Round 8 - 30-second turn timer (like 8 Ball Pool)
- Ring around the active player's avatar drains over 30 s with the seconds shown; turns red and pulses at 10 s or less.
- Server-enforced: `shot/route.ts` stamps `turnStartedAt` (server clock) in the snapshot; new `POST /api/pool/[matchId]/timeout` checks participant access, the version, and that 30 s (+1 s grace) really passed, then passes the turn through the SAME `pool_commit_authoritative_shot` RPC. If the opponent also times out it comes back to player 1.
- A timeout counts as a foul: the opponent gets ball in hand (`TURN_TIMEOUT_BALL_IN_HAND` in `lib/pool/authoritative.js`; set false for a plain turn pass).
- First turn of a match uses `started_at` as the clock. A match already in progress with no stamp gets its timer from the next shot.
- No database migration, no wallet/stake/settlement changes. Timer pauses while the disconnect countdown is active.
- Tests: `tests/pool-turn-timer.test.cjs`. NOT tested: a real two-account match, `next build`.
