const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const A = require("../lib/pool/authoritative.js");

test("turn timer lasts 30 seconds", () => assert.strictEqual(A.TURN_SECONDS, 30));

test("timeout passes the turn to the opponent with ball in hand, and back again on a second timeout", () => {
  const s0 = A.initialPoolState();
  assert.strictEqual(s0.currentPlayer, 0);
  const s1 = A.applyTurnTimeout(s0);
  assert.strictEqual(s1.currentPlayer, 1);
  assert.strictEqual(s1.ballInHand, true);
  assert.strictEqual(s1.gameOver, false);
  assert.deepStrictEqual(s1.lastShot.reasons, ["turn timer expired"]);
  assert.match(s1.status, /Player 1 ran out of time\. Player 2 has the table/);
  const s2 = A.applyTurnTimeout(s1);
  assert.strictEqual(s2.currentPlayer, 0, "if player 2 also runs out, it goes back to player 1");
  assert.strictEqual(s2.ballInHand, true);
});

test("timeout never moves, pockets or changes groups; input is not mutated", () => {
  const s0 = A.initialPoolState();
  const before = JSON.stringify(s0);
  const s1 = A.applyTurnTimeout(s0);
  assert.strictEqual(JSON.stringify(s0), before);
  for (const b of s1.balls) {
    const o = s0.balls.find((x) => x.id === b.id);
    assert.ok(o.x === b.x && o.z === b.z && o.pocketed === b.pocketed);
  }
  assert.deepStrictEqual(s1.groups, s0.groups);
});

test("the player who got ball in hand can still shoot normally after a timeout", () => {
  const s1 = A.applyTurnTimeout(A.initialPoolState());
  const out = A.simulateShot(s1, 0.4, 0.1, { spinX: 0, spinY: 0, cuePlacement: null });
  assert.ok(out && (out.currentPlayer === 0 || out.currentPlayer === 1));
});

test("a finished match cannot be timed out", () => {
  const s = { ...A.initialPoolState(), gameOver: true };
  assert.throws(() => A.applyTurnTimeout(s), /already ended/);
});

test("timeout route: authenticated, access-checked, server clock, same commit RPC, no wallet code", () => {
  const r = fs.readFileSync("app/api/pool/[matchId]/timeout/route.ts", "utf8");
  assert.match(r, /auth\.getUser\(token\)/);
  assert.match(r, /checkPoolAccess\(db, matchId, auth\.user\.id, \["in_progress"\]\)/);
  assert.match(r, /Date\.now\(\) < startedAt|now < startedAt/);
  assert.match(r, /pool_commit_authoritative_shot/);
  assert.match(r, /expectedVersion !== currentVersion/);
  assert.ok(!/wallet|settle_|refund|platform/i.test(r.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/settlement_status|already been settled/g, "")), "no money logic");
});

test("shot route stamps the server clock; client draws ring and calls the timeout route", () => {
  assert.match(fs.readFileSync("app/api/pool/[matchId]/shot/route.ts", "utf8"), /turnStartedAt = Date\.now\(\)/);
  const page = fs.readFileSync("app/pool3d/page.tsx", "utf8");
  assert.match(page, /\/timeout`/);
  assert.match(page, /setTurnTimer\(/);
  assert.match(fs.readFileSync("app/pool3d/engine/hud.ts", "utf8"), /setTurnTimer\(/);
});
