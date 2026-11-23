const test = require('node:test');
const assert = require('node:assert/strict');
const { initialPoolState, simulateShot } = require('../lib/pool/authoritative.js');

test('initial rack contains the cue ball and all fifteen object balls', () => {
  const state = initialPoolState();
  assert.equal(state.balls.length, 16);
  assert.deepEqual(state.balls.map((ball) => ball.id).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  assert.equal(state.currentPlayer, 0);
});

test('same canonical state and shot produce the same server result', () => {
  const start = initialPoolState();
  const a = simulateShot(start, 0.5, 0.25);
  const b = simulateShot(start, 0.5, 0.25);
  assert.deepEqual(a, b);
  assert.equal(a.balls.length, 16);
  assert.equal(a.shotInProgress, false);
});

test('a shot changes the turn when no ball is legally pocketed', () => {
  const result = simulateShot(initialPoolState(), 0.5, 0);
  assert.equal(result.currentPlayer, 1);
  assert.equal(result.gameOver, false);
});

test('client cannot supply malformed or moving canonical state', () => {
  const state = initialPoolState();
  state.balls[0].vx = 2;
  assert.throws(() => simulateShot(state, 0.5, 0), /previous shot has not settled/);
  assert.throws(() => simulateShot(initialPoolState(), 2, 0), /power/);
  assert.throws(() => simulateShot(initialPoolState(), 0.5, Number.NaN), /direction/);
});
