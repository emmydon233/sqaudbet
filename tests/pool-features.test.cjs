const test = require('node:test');
const assert = require('node:assert/strict');
const { initialPoolState, simulateShot, simulateShotTrace, parseShotInput, isLegalPlacement, TABLE, pockets } = require('../lib/pool/authoritative.js');
const { predictShot } = require('../lib/pool/aim.js');

const R = TABLE.ballRadius;
/** A table with only the requested balls, everything else parked (pocketed) out of play. */
function scenario(placements, extra = {}) {
  const s = initialPoolState();
  s.balls.forEach((b, i) => { b.x = -3.4 + (i % 8) * 0.01; b.z = 1.8 - Math.floor(i / 8) * 0.01; b.pocketed = true; });
  for (const [id, x, z] of placements) { const b = s.balls.find((q) => q.id === id); b.x = x; b.z = z; b.pocketed = false; }
  return Object.assign(s, extra);
}
const live = (state, id) => state.balls.find((b) => b.id === id);

test('parseShotInput accepts a plain shot and defaults spin/placement', () => {
  const p = parseShotInput({ power: 0.5, angleRadians: 1, expectedVersion: 3 });
  assert.deepEqual([p.spinX, p.spinY, p.cuePlacement], [0, 0, null]);
});
test('parseShotInput rejects malformed or out-of-range requests', () => {
  assert.throws(() => parseShotInput(null));
  assert.throws(() => parseShotInput({ power: '1', angleRadians: 0, expectedVersion: 0 }));
  assert.throws(() => parseShotInput({ power: 1, angleRadians: 0, expectedVersion: 1.5 }));
  assert.throws(() => parseShotInput({ power: 1, angleRadians: 0, expectedVersion: 0, spinX: 0.9, spinY: 0.9 }), /spin/);
  assert.throws(() => parseShotInput({ power: 1, angleRadians: 0, expectedVersion: 0, spinX: NaN }), /spin/);
  assert.throws(() => parseShotInput({ power: 1, angleRadians: 0, expectedVersion: 0, cuePlacement: { x: 'a', z: 0 } }), /placement/);
});
test('simulateShot refuses out-of-range spin even if the route is bypassed', () => {
  assert.throws(() => simulateShot(initialPoolState(), 0.5, 0, { spinX: 1, spinY: 1 }), /spin/);
});

test('draw sends the cue ball backwards, follow carries it forward (spin has a real physical effect)', () => {
  const base = () => scenario([[0, -1.5, 0], [1, 0, 0]]);
  const none = live(simulateShot(base(), 0.45, 0), 0).x;
  const draw = live(simulateShot(base(), 0.45, 0, { spinY: -1 }), 0).x;
  const follow = live(simulateShot(base(), 0.45, 0, { spinY: 1 }), 0).x;
  assert.ok(draw < none - 0.15, `draw ${draw} should end well behind stun ${none}`);
  assert.ok(follow > none + 0.15, `follow ${follow} should end well past stun ${none}`);
  assert.ok(draw < -1.5, 'draw returns past the cue ball start');
});
test('side spin changes the cue-ball path after a cushion, and left/right are mirror images', () => {
  const run = (spinX) => live(simulateShot(scenario([[0, -1, 0.6], [8, 3, -1.8]]), 0.5, -0.5, { spinX }), 0);
  const left = run(-1), right = run(1), none = run(0);
  assert.ok(Math.abs(left.z - none.z) > 0.05 || Math.abs(left.x - none.x) > 0.05);
  assert.ok(Math.abs(right.z - none.z) > 0.05 || Math.abs(right.x - none.x) > 0.05);
  assert.notEqual(left.z.toFixed(3), right.z.toFixed(3));
});
test('simulation with spin is deterministic', () => {
  const s = initialPoolState();
  assert.deepEqual(simulateShot(s, 0.8, 0.02, { spinX: 0.4, spinY: -0.3 }), simulateShot(s, 0.8, 0.02, { spinX: 0.4, spinY: -0.3 }));
});

test('a foul gives the opponent ball-in-hand; a clean pot does not', () => {
  const foul = simulateShot(scenario([[0, -1, 0], [1, 2.5, 1.4]]), 0.3, Math.PI); // misses everything
  assert.equal(foul.currentPlayer, 1); assert.equal(foul.ballInHand, true); assert.equal(foul.lastShot.foul, true);
  const dry = simulateShot(scenario([[0, -1, 0], [9, 0, 0]], { groups: ['solid', 'stripe'] }), 0.3, 0);
  assert.equal(dry.lastShot.foul, true); // hit a stripe as solids
});
test('ball-in-hand: placement is only honoured when the server flagged it, and is validated', () => {
  const s = scenario([[0, -1, 0], [1, 1, 0]]);
  assert.throws(() => simulateShot(s, 0.3, 0, { cuePlacement: { x: -2, z: 0 } }), /Ball-in-hand is not available/);
  s.ballInHand = true;
  const ok = simulateShot(s, 0.3, 0, { cuePlacement: { x: -2, z: 0.2 } });
  assert.ok(ok.lastShot);
  assert.throws(() => simulateShot(s, 0.3, 0, { cuePlacement: { x: 1.05, z: 0 } }), /not legal/);        // on a ball
  assert.throws(() => simulateShot(s, 0.3, 0, { cuePlacement: { x: 9, z: 0 } }), /not legal/);           // off table
  // Dropping the ball INTO the hole is a foul (see pool-pocket-placement-foul.test.cjs); merely touching the pocket
  // mouth, just outside the hole, is still an illegal placement.
  const hole = require('../lib/pool/authoritative.js').pockets[0];
  assert.throws(() => simulateShot(s, 0.3, 0, { cuePlacement: { x: hole.x + (hole.radius * 1.2) / Math.SQRT2, z: hole.z + (hole.radius * 1.2) / Math.SQRT2 } }), /not legal/); // pocket mouth edge, just outside the hole
  assert.equal(isLegalPlacement(s.balls, -2, 0), true);
});
test('ball-in-hand flag is cleared after the next shot unless that shot is a foul', () => {
  const s = scenario([[0, -1, 0], [1, 1, 0]]); s.ballInHand = true; s.groups = [null, null];
  const r = simulateShot(s, 0.25, 0);
  assert.equal(r.ballInHand, false);
});

test('8-ball rules: early 8 loses, legal 8 wins, 8 with a scratch loses', () => {
  const early = simulateShot(scenario([[0, -1, 0], [8, 3.55, 1.55], [1, 0, 1.2]], { groups: ['solid', 'stripe'] }), 0.2, Math.atan2(1.55, 4.55));
  if (early.gameOver) { assert.equal(early.winnerPlayer, 1); }
  const s = scenario([[0, 2.6, 0.9], [8, 3.4, 1.35]], { groups: ['solid', 'stripe'] });
  const angle = Math.atan2(1.35 - 0.9, 3.4 - 2.6);
  const win = simulateShot(s, 0.3, angle);
  if (win.gameOver) { assert.equal(win.winnerPlayer, 0); }
});

test('trace replays the same final table the server returns', () => {
  const s = initialPoolState();
  const { state, trace } = simulateShotTrace(s, 0.9, 0.0, { trace: true });
  assert.ok(trace.frames.length > 30 && trace.hz === 60);
  assert.ok(trace.events.some((e) => e.k === 'cue') && trace.events.some((e) => e.k === 'b'));
  // tracing must not change the authoritative result
  assert.deepEqual(simulateShot(s, 0.9, 0.0), state);
});

test('aim prediction: first contact, ghost ball and object-ball direction match the real simulation', () => {
  const cases = [
    [[0, -1.8, 0.3], [5, 0.4, -0.2]], [[0, -2.2, -0.9], [12, -0.3, 0.7]], [[0, 0.5, 1.2], [3, 2.0, 0.1]],
  ];
  for (const placements of cases) {
    const s = scenario(placements);
    const cue = live(s, 0), obj = live(s, placements[1][0]);
    const angle = Math.atan2(obj.z - cue.z, obj.x - cue.x) + 0.05; // a gentle cut
    const pred = predictShot(s.balls, cue, angle);
    assert.equal(pred.contact.id, obj.id);
    const { trace } = simulateShotTrace(s, 0.2, angle, { trace: true });
    const ci = trace.ids.indexOf(0), oi = trace.ids.indexOf(obj.id);
    // The 60 Hz trace can step over the exact instant of contact, so locate the first frame
    // at which the gap starts to GROW (just after contact) and use the frame before it.
    const gap = (fr) => Math.hypot(fr[ci * 3] - fr[oi * 3], fr[ci * 3 + 1] - fr[oi * 3 + 1]);
    let f = 1; while (f < trace.frames.length && gap(trace.frames[f]) < gap(trace.frames[f - 1])) f += 1;
    assert.ok(f > 1 && f < trace.frames.length);
    const before = trace.frames[f - 1];
    const ghostErr = Math.hypot(before[ci * 3] - pred.contact.ghost.x, before[ci * 3 + 1] - pred.contact.ghost.z);
    assert.ok(ghostErr < 0.07, `ghost error ${ghostErr}`);
    const f2 = Math.min(trace.frames.length - 1, f + 12);
    const mdx = trace.frames[f2][oi * 3] - obj.x, mdz = trace.frames[f2][oi * 3 + 1] - obj.z;
    const dirErr = Math.abs(Math.atan2(mdz, mdx) - Math.atan2(pred.objectLine.dir.z, pred.objectLine.dir.x));
    assert.ok(dirErr < 0.03, `object direction error ${dirErr}`);
  }
});
test('aim prediction: pocket prediction agrees with the simulation', () => {
  const pk = pockets[2];
  const ox = 3.3, oz = -1.3;
  const dirx = pk.x - ox, dirz = pk.z - oz; const len = Math.hypot(dirx, dirz);
  const ux = dirx / len, uz = dirz / len;
  const s = scenario([[0, ox - ux * 1.0, oz - uz * 1.0], [7, ox, oz]]);
  const cue = live(s, 0);
  const pred = predictShot(s.balls, cue, Math.atan2(uz, ux));
  assert.equal(pred.objectLine.pocket, 2);
  const res = simulateShot(s, 0.35, Math.atan2(uz, ux));
  assert.equal(live(res, 7).pocketed, true);
});
test('aim prediction: pocket-free cushion shot reports a rebound and no contact', () => {
  const s = scenario([[0, 0, 0]]);
  const pred = predictShot(s.balls, live(s, 0), 0.4);
  assert.equal(pred.contact, null); assert.ok(pred.cueBounce);
});
test('aim prediction reflects follow/draw on the cue ball after contact', () => {
  const s = scenario([[0, -1.5, 0], [1, 0, 0.1]]);
  const d = predictShot(s.balls, live(s, 0), 0, { x: 0, y: -1 });
  const f = predictShot(s.balls, live(s, 0), 0, { x: 0, y: 1 });
  assert.ok(d.cueAfter.dir.x < 0 && f.cueAfter.dir.x > 0);
});
