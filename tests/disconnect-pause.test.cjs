const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(f, "utf8");

function loadPause() {
  let ts;
  try { ts = require("typescript"); } catch { try { ts = require("/home/claude/.npm-global/lib/node_modules/typescript"); } catch { return null; } }
  const js = ts.transpileModule(read("lib/pool/pause.ts"), { compilerOptions: { module: "commonjs", target: "es2020" } }).outputText;
  const m = { exports: {} }; new Function("module", "exports", js)(m, m.exports); return m.exports;
}

test("pool pause rule: paused when a deadline or either disconnect time is set", (t) => {
  const P = loadPause(); if (!P) return t.skip("typescript not available");
  assert.strictEqual(P.isPoolPaused(null), false);
  assert.strictEqual(P.isPoolPaused({}), false);
  assert.strictEqual(P.isPoolPaused({ disconnect_deadline: "2026-01-01T00:05:00Z" }), true);
  assert.strictEqual(P.isPoolPaused({ player1_disconnected_at: "2026-01-01T00:00:00Z" }), true);
  assert.strictEqual(P.isPoolPaused({ player2_disconnected_at: "2026-01-01T00:00:00Z" }), true);
  assert.strictEqual(P.poolPauseStartedAt({ disconnect_deadline: "2026-01-01T00:05:00.000Z" }), Date.parse("2026-01-01T00:00:00.000Z"));
  assert.strictEqual(P.poolPauseStartedAt({}), null);
});

test("pool shot and timeout routes refuse (423) before touching the table while paused", () => {
  for (const f of ["app/api/pool/[matchId]/shot/route.ts", "app/api/pool/[matchId]/timeout/route.ts"]) {
    const r = read(f);
    const gate = r.indexOf("isPoolPaused(session)");
    assert.ok(gate > 0, f + " checks the pause");
    assert.match(r, /status: 423/);
    assert.ok(gate < r.indexOf("simulateShot(") || f.includes("timeout"), "pause is checked before simulating");
    assert.ok(gate < r.indexOf('rpc("pool_commit_authoritative_shot"'), "pause is checked before committing");
    assert.match(r, /player1_disconnected_at,player2_disconnected_at/);
  }
});

test("pool heartbeat restores the remaining turn time once, only for the returning player", () => {
  const r = read("app/api/pool/[matchId]/heartbeat/route.ts");
  assert.match(r, /const mine = isP1 \? before\?\.player1_disconnected_at : before\?\.player2_disconnected_at/);
  assert.match(r, /pauseStartedAt/);
  assert.match(r, /pauseAdjustedFor/);
  assert.match(r, /\.eq\("state_version", version\)/);
  assert.match(r, /turnStartedAt = startedAt \+ pausedMs/);
  assert.match(r, /\.not\("game_state->snapshot->>pauseAdjustedFor", "eq", pauseMarker\)/);
  assert.ok(r.indexOf('rpc("pool_presence"') < r.indexOf("turnStartedAt = startedAt + pausedMs"));
});

test("pool client freezes the table and the ring while paused and never asks for a timeout", () => {
  const page = read("app/pool3d/page.tsx");
  assert.match(page, /setPaused\(dialog !== null \|\| result !== null \|\| disconnectDeadline !== null\)/);
  assert.match(page, /if \(disconnectDeadline\) \{[\s\S]*?return;\s*\}\s*const remaining/);
  assert.match(read("app/pool3d/engine/hud.ts"), /Game paused/);
});

test("whot action route refuses every action while either player is disconnected", () => {
  const r = read("app/api/whot/[matchId]/action/route.ts");
  const gate = r.indexOf("player1_disconnected_at || presence.player2_disconnected_at");
  assert.ok(gate > 0 && /status: 423/.test(r));
  assert.ok(gate < r.indexOf('db.rpc("whot_market_draw"') && gate < r.indexOf('db.rpc("whot_apply_action"'), "checked before any game RPC");
  assert.ok(gate < r.indexOf("whot_resolve_exhaustion"));
});

test("whot client disables every action while paused and shows the countdown from the server clock", () => {
  const p = read("app/whot/page.tsx");
  assert.match(p, /const myTurn = Boolean\(game\?\.isMyTurn && !isFinished && !choosingShape && !paused\)/);
  assert.match(p, /pausedRef\.current\) return/);
  assert.match(p, /serverSkewRef\.current/);
  assert.match(p, /game paused/i);
  assert.match(read("app/api/whot/[matchId]/route.ts"), /serverNow: Date\.now\(\)/);
});

test("no wallet, fee, refund or settlement code was touched by the pause", () => {
  for (const f of ["lib/pool/pause.ts", "app/api/pool/[matchId]/timeout/route.ts"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/wallet|refund|platform_earn|fee/i.test(code), f);
  }
});
