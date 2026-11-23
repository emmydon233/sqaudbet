const test = require("node:test");
const assert = require("node:assert");
const A = require("../lib/pool/authoritative.js");

function afterDryFoul() {
  const init = A.initialPoolState();
  // P1 hits nothing -> foul, P2 gets ball in hand
  return A.simulateShot(init, 0.12, Math.PI, { spinX: 0, spinY: 0, cuePlacement: null });
}

test("dropping the cue ball into a pocket is a foul: turn passes back with ball in hand", () => {
  const s1 = afterDryFoul();
  assert.strictEqual(s1.currentPlayer, 1);
  assert.strictEqual(s1.ballInHand, true);
  for (let i = 0; i < A.pockets.length; i += 1) {
    const p = A.pockets[i];
    const { state, trace } = A.simulateShotTrace(s1, 0.08, 0, { spinX: 0, spinY: 0, cuePlacement: { x: p.x, z: p.z }, trace: true });
    assert.strictEqual(state.currentPlayer, 0, "turn goes back to player 1");
    assert.strictEqual(state.ballInHand, true, "player 1 has ball in hand");
    assert.strictEqual(state.gameOver, false);
    assert.strictEqual(state.lastShot.foul, true);
    const cue = state.balls.find((b) => b.id === 0);
    assert.strictEqual(cue.pocketed, false, "cue ball is back on the table");
    assert.ok(trace && trace.frames.length === 2 && trace.events[0].k === "p" && trace.events[0].id === 0);
    assert.match(state.status, /Player 2 fouls .*Player 1 has the table/);
    // no other ball moved or got pocketed
    for (const b of state.balls) if (b.id !== 0) {
      const before = s1.balls.find((x) => x.id === b.id);
      assert.ok(Math.abs(before.x - b.x) < 1e-4 && Math.abs(before.z - b.z) < 1e-4 && before.pocketed === b.pocketed);
    }
  }
});

test("without ball in hand a pocket placement is still rejected (no free turn-skip)", () => {
  const init = A.initialPoolState();
  const p = A.pockets[0];
  assert.throws(() => A.simulateShot(init, 0.08, 0, { cuePlacement: { x: p.x, z: p.z } }), /Ball-in-hand is not available/);
});

test("a normal legal placement still plays a normal shot", () => {
  const s1 = afterDryFoul();
  const out = A.simulateShot(s1, 0.4, 0.0, { spinX: 0, spinY: 0, cuePlacement: { x: -2.0, z: 0.9 } });
  assert.ok(out.currentPlayer === 0 || out.currentPlayer === 1);
  assert.strictEqual(out.lastShot.reasons.includes("cue ball placed in a pocket"), false);
});
