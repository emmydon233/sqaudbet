/**
 * Deterministic, server-side 8-ball simulation.
 * This module intentionally has no DOM, Three.js, or client-state dependency.
 * The browser submits only aim angle, power, optional cue-ball spin and (when the
 * server state allows it) a ball-in-hand placement. Ball positions and outcomes are
 * derived here from the last committed server snapshot.
 *
 * The same module is imported by the browser ONLY to replay an already-approved shot
 * as an animation; the server's final snapshot is always what the client snaps to.
 */
const TABLE = {
  halfW: 4.05,
  halfD: 2.04,
  ballRadius: 0.118,
  pocketRadius: 0.31,
  cushionRestitution: 0.82,
  ballRestitution: 0.94,
  friction: 0.92,
  stopSpeed: 0.018,
  maxShotSpeed: 8.8,
  step: 1 / 180,
};
const pockets = [
  { x: -TABLE.halfW, z: -TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { x: 0, z: -TABLE.halfD - 0.015, radius: TABLE.pocketRadius * 0.94 },
  { x: TABLE.halfW, z: -TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { x: -TABLE.halfW, z: TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { x: 0, z: TABLE.halfD + 0.015, radius: TABLE.pocketRadius * 0.94 },
  { x: TABLE.halfW, z: TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
];

/**
 * Cue-ball spin model ("English"). Spin is expressed as two numbers in the unit disc:
 *   spinX  -1 (left) .. +1 (right)   side spin
 *   spinY  -1 (back / draw) .. +1 (top / follow)
 * With spinX = spinY = 0 the simulation is bit-for-bit identical to the original engine.
 *
 *  - squirt:     side spin deflects the launch direction slightly away from the struck side.
 *  - follow/draw: on the cue ball's first object-ball contact, extra velocity is added along
 *                 the cue ball's pre-contact travel direction (follow) or against it (draw).
 *  - side spin:  on a cushion contact the cue ball receives a tangential kick; the spin is
 *                 partly consumed by every cushion.
 *  - all spin decays with time.
 * This is a compact approximation, not a full rigid-body friction model; it is deliberately
 * simple so server and client agree and the result is stable and cheap.
 */
const SPIN = {
  squirt: 0.03,
  followK: 0.42,
  drawK: 0.52,
  contactKeep: 0.12,
  sideK: 0.3,
  cushionKeep: 0.6,
  decayY: 0.5,
  decayX: 0.35,
};

/** Ball-in-hand after a foul (standard 8-ball rule). Set to false to restore the previous behaviour. */
const BALL_IN_HAND_ON_FOUL = true;
const TRACE_EVERY = 3; // 180 Hz simulation -> 60 Hz playback frames

function kindFor(id) {
  return id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';
}
function groupFor(id) {
  return id === 0 || id === 8 ? null : id < 8 ? 'solid' : 'stripe';
}
function initialPoolState() {
  const balls = [{ id: 0, kind: 'cue', x: -2.72, z: 0, vx: 0, vz: 0, pocketed: false }];
  const rackOrder = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
  const spacingX = TABLE.ballRadius * 1.78;
  const spacingZ = TABLE.ballRadius * 2.08;
  let index = 0;
  const apexX = 1.28;
  for (let row = 0; row < 5; row += 1) {
    for (let item = 0; item <= row; item += 1) {
      const id = rackOrder[index++];
      balls.push({ id, kind: kindFor(id), x: apexX + row * spacingX, z: (item - row / 2) * spacingZ, vx: 0, vz: 0, pocketed: false });
    }
  }
  return {
    status: 'Rack is set. Player 1 breaks.', currentPlayer: 0,
    gameOver: false, winnerPlayer: null, shotInProgress: false,
    ballInHand: false,
    groups: [null, null], balls,
  };
}
function normalizeState(input) {
  if (!input || !Array.isArray(input.balls) || input.balls.length !== 16) throw new Error('Server game state is invalid.');
  const ids = new Set();
  const balls = input.balls.map((b) => {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 0 || id > 15 || ids.has(id)) throw new Error('Server ball set is invalid.');
    ids.add(id);
    const x = Number(b.x), z = Number(b.z), vx = Number(b.vx ?? 0), vz = Number(b.vz ?? 0);
    if (![x, z, vx, vz].every(Number.isFinite)) throw new Error('Server ball coordinates are invalid.');
    return { id, kind: kindFor(id), x, z, vx, vz, pocketed: Boolean(b.pocketed) };
  });
  if (ids.size !== 16 || ![0, 1].includes(Number(input.currentPlayer))) throw new Error('Server turn state is invalid.');
  if (input.gameOver) throw new Error('This match has already ended.');
  if (balls.some((b) => !b.pocketed && Math.hypot(b.vx, b.vz) > TABLE.stopSpeed + 0.0001)) throw new Error('The previous shot has not settled.');
  const groups = Array.isArray(input.groups) && input.groups.length === 2 ? input.groups : [null, null];
  return { ...input, balls, groups: groups.map((g) => g === 'solid' || g === 'stripe' ? g : null), currentPlayer: Number(input.currentPlayer), gameOver: false, ballInHand: Boolean(input.ballInHand) };
}
function remaining(state, group) {
  return state.balls.filter((b) => !b.pocketed && groupFor(b.id) === group);
}
function canPlaceCue(balls, x, z) {
  return balls.every((b) => b.id === 0 || b.pocketed || (b.x - x) ** 2 + (b.z - z) ** 2 >= (TABLE.ballRadius * 2.4) ** 2);
}
function restoreCue(balls) {
  const cue = balls.find((b) => b.id === 0);
  const candidates = [[-2.72, 0], [-2.94, -0.42], [-2.94, 0.42], [-2.45, -0.72], [-2.45, 0.72], [-3.15, 0]];
  const open = candidates.find(([x, z]) => canPlaceCue(balls, x, z)) || [-2.72, 0];
  cue.x = open[0]; cue.z = open[1]; cue.vx = 0; cue.vz = 0; cue.pocketed = false;
}
function nudgeFromPocket(ball) {
  for (const p of pockets) {
    const dx = ball.x - p.x, dz = ball.z - p.z;
    const d2 = dx * dx + dz * dz, safe = p.radius * 0.78;
    if (d2 > 0 && d2 < safe * safe) {
      const d = Math.sqrt(d2);
      ball.x = p.x + dx / d * safe; ball.z = p.z + dz / d * safe;
    }
  }
}

/** Is (x,z) a legal place for the cue ball when the player has ball-in-hand? */
function isLegalPlacement(balls, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const margin = TABLE.ballRadius * 1.6;
  if (Math.abs(x) > TABLE.halfW - margin || Math.abs(z) > TABLE.halfD - margin) return false;
  for (const p of pockets) {
    if ((x - p.x) ** 2 + (z - p.z) ** 2 < (p.radius + TABLE.ballRadius) ** 2) return false;
  }
  return canPlaceCue(balls, x, z);
}

/**
 * Validates and normalises an untrusted shot request body.
 * Returns { power, angleRadians, expectedVersion, spinX, spinY, cuePlacement } or throws.
 */
function parseShotInput(body) {
  if (!body || typeof body !== 'object') throw new Error('A valid shot is required.');
  const { power, angleRadians, expectedVersion } = body;
  if (typeof power !== 'number' || typeof angleRadians !== 'number' || !Number.isInteger(expectedVersion)) {
    throw new Error('A valid shot power, direction and table version are required.');
  }
  let spinX = 0, spinY = 0;
  if (body.spinX !== undefined || body.spinY !== undefined) {
    spinX = body.spinX === undefined ? 0 : body.spinX;
    spinY = body.spinY === undefined ? 0 : body.spinY;
    if (typeof spinX !== 'number' || typeof spinY !== 'number' || !Number.isFinite(spinX) || !Number.isFinite(spinY)) {
      throw new Error('Cue-ball spin is invalid.');
    }
    if (Math.hypot(spinX, spinY) > 1.0001) throw new Error('Cue-ball spin is outside the allowed range.');
    spinX = Math.round(spinX * 1000) / 1000;
    spinY = Math.round(spinY * 1000) / 1000;
  }
  let cuePlacement = null;
  if (body.cuePlacement !== undefined && body.cuePlacement !== null) {
    const p = body.cuePlacement;
    if (typeof p !== 'object' || typeof p.x !== 'number' || typeof p.z !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      throw new Error('Cue-ball placement is invalid.');
    }
    cuePlacement = { x: Math.round(p.x * 10000) / 10000, z: Math.round(p.z * 10000) / 10000 };
  }
  return { power, angleRadians, expectedVersion, spinX, spinY, cuePlacement };
}

/** Index of the pocket whose hole contains (x, z), or -1. */
function pocketHoleAt(x, z) {
  for (let i = 0; i < pockets.length; i += 1) {
    const p = pockets[i];
    if ((x - p.x) ** 2 + (z - p.z) ** 2 <= (p.radius * 1.0001) ** 2) return i;
  }
  return -1;
}

/**
 * Ball-in-hand rule: a player who places (drops) the cue ball into a pocket hole has committed a foul.
 * No balls move; the turn passes to the opponent, who gets ball in hand. Returns { state, trace }.
 */
function placementInPocketFoul(state, x, z, holeIdx, wantTrace) {
  const playerIndex = state.currentPlayer, opponentIndex = 1 - playerIndex;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const row = (cuePocketed) => {
    const out = [];
    for (const b of state.balls) {
      if (b.id === 0) out.push(r4(x), r4(z), cuePocketed ? 1 : 0);
      else out.push(r4(b.x), r4(b.z), b.pocketed ? 1 : 0);
    }
    return out;
  };
  const trace = wantTrace
    ? { hz: 60, ids: state.balls.map((b) => b.id), frames: [row(false), row(true)], events: [{ f: 1, k: 'p', id: 0, pocket: holeIdx }], startCue: { x, z } }
    : null;
  restoreCue(state.balls);
  state.lastShot = { by: playerIndex, pocketedIds: [], foul: true, reasons: ['cue ball placed in a pocket'], scratch: true };
  state.currentPlayer = opponentIndex;
  state.status = `Player ${playerIndex + 1} fouls (put the cue ball in a pocket). Player ${opponentIndex + 1} has the table${BALL_IN_HAND_ON_FOUL ? ' with ball in hand' : ''}.`;
  state.ballInHand = BALL_IN_HAND_ON_FOUL;
  state.shotInProgress = false;
  state.winnerPlayer = null;
  state.balls = state.balls.map((b) => ({ ...b, x: Number(b.x.toFixed(6)), z: Number(b.z.toFixed(6)), vx: 0, vz: 0 }));
  return { state, trace };
}

/** Seconds a player has to shoot before the turn passes to the opponent. */
const TURN_SECONDS = 30;
/** Like 8 Ball Pool, running out of time is a foul: the opponent gets ball in hand. */
const TURN_TIMEOUT_BALL_IN_HAND = true;

/**
 * Pure rule for an expired turn timer. No balls move; the turn passes to the opponent.
 * Returns a new state (the input is not modified).
 */
function applyTurnTimeout(inputState) {
  const state = normalizeState(inputState);
  const playerIndex = state.currentPlayer, opponentIndex = 1 - playerIndex;
  restoreCueIfPocketed(state.balls);
  state.lastShot = { by: playerIndex, pocketedIds: [], foul: true, reasons: ['turn timer expired'], scratch: false, timeout: true };
  state.currentPlayer = opponentIndex;
  state.status = `Player ${playerIndex + 1} ran out of time. Player ${opponentIndex + 1} has the table${TURN_TIMEOUT_BALL_IN_HAND ? ' with ball in hand' : ''}.`;
  state.ballInHand = TURN_TIMEOUT_BALL_IN_HAND;
  state.shotInProgress = false;
  state.winnerPlayer = null;
  state.balls = state.balls.map((b) => ({ ...b, vx: 0, vz: 0 }));
  return state;
}
function restoreCueIfPocketed(balls) {
  const cue = balls.find((b) => b.id === 0);
  if (cue && cue.pocketed) restoreCue(balls);
}

/**
 * Runs one shot. Returns { state, trace }. `trace` is null unless options.trace is true.
 * The trace (60 Hz ball positions + impact events) is used by clients only to animate the
 * shot; it never influences the authoritative result.
 */
function simulateShotTrace(inputState, power, angleRadians, options) {
  const opts = options || {};
  const state = normalizeState(inputState);
  const pwr = Number(power), angle = Number(angleRadians);
  if (!Number.isFinite(pwr) || pwr < 0.08 || pwr > 1) throw new Error('Shot power is outside the allowed range.');
  if (!Number.isFinite(angle) || Math.abs(angle) > Math.PI * 1000) throw new Error('Shot direction is invalid.');
  let sx = Number(opts.spinX ?? 0), sy = Number(opts.spinY ?? 0);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.hypot(sx, sy) > 1.0001) throw new Error('Cue-ball spin is outside the allowed range.');
  const cue = state.balls.find((b) => b.id === 0);
  if (!cue || cue.pocketed) throw new Error('Cue ball is not available for a shot.');

  if (opts.cuePlacement) {
    if (!state.ballInHand) throw new Error('Ball-in-hand is not available for this shot.');
    const { x, z } = opts.cuePlacement;
    const holeIdx = pocketHoleAt(x, z);
    if (holeIdx >= 0) return placementInPocketFoul(state, x, z, holeIdx, Boolean(opts.trace));
    if (!isLegalPlacement(state.balls, x, z)) throw new Error('Cue-ball placement is not legal.');
    cue.x = x; cue.z = z; cue.vx = 0; cue.vz = 0;
  }
  const startCue = { x: cue.x, z: cue.z };

  const launchAngle = angle - sx * SPIN.squirt;
  const speed = 1.55 + pwr * TABLE.maxShotSpeed;
  cue.vx = Math.cos(launchAngle) * speed;
  cue.vz = Math.sin(launchAngle) * speed;

  const wantTrace = Boolean(opts.trace);
  const frames = [];
  const events = [];
  const ids = state.balls.map((b) => b.id);
  const sample = () => {
    const row = new Array(state.balls.length * 3);
    for (let i = 0; i < state.balls.length; i += 1) {
      const b = state.balls[i];
      row[i * 3] = Math.round(b.x * 10000) / 10000;
      row[i * 3 + 1] = Math.round(b.z * 10000) / 10000;
      row[i * 3 + 2] = b.pocketed ? 1 : 0;
    }
    frames.push(row);
  };
  if (wantTrace) {
    // Frame 0 is the table before the cue ball is struck (after any ball-in-hand placement).
    cue.vx = 0; cue.vz = 0; sample();
    cue.vx = Math.cos(launchAngle) * speed; cue.vz = Math.sin(launchAngle) * speed;
    events.push({ f: 0, k: 'cue', v: pwr });
  }

  const report = { firstContactId: null, cueScratch: false, eightPocketed: false, pocketedIds: [] };
  const minDistance = TABLE.ballRadius * 2;
  const minDistanceSq = minDistance * minDistance;
  const minX = -TABLE.halfW + TABLE.ballRadius * 0.62;
  const maxX = TABLE.halfW - TABLE.ballRadius * 0.62;
  const minZ = -TABLE.halfD + TABLE.ballRadius * 0.62;
  const maxZ = TABLE.halfD - TABLE.ballRadius * 0.62;
  let settled = false;

  const cushion = (ball, nx, nz, vn) => {
    if (wantTrace && vn > 0.12) events.push({ f: Math.floor(frame / TRACE_EVERY), k: 'c', v: vn });
    if (ball.id === 0 && sx !== 0) {
      const kick = sx * SPIN.sideK * vn;
      ball.vx += nz * kick;
      ball.vz += -nx * kick;
      sx *= SPIN.cushionKeep;
    }
  };

  let frame = 0;
  // Friction stops a full-power shot well before this deterministic safety cap.
  for (; frame < 7200; frame += 1) {
    if (wantTrace && frame % TRACE_EVERY === 0 && frame > 0) sample();
    if (sx !== 0 || sy !== 0) {
      sy -= sy * SPIN.decayY * TABLE.step;
      sx -= sx * SPIN.decayX * TABLE.step;
    }
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      ball.x += ball.vx * TABLE.step;
      ball.z += ball.vz * TABLE.step;
      const velocity = Math.hypot(ball.vx, ball.vz);
      if (velocity > 0) {
        const next = Math.max(0, velocity - TABLE.friction * TABLE.step);
        if (next < TABLE.stopSpeed) { ball.vx = 0; ball.vz = 0; }
        else { const ratio = next / velocity; ball.vx *= ratio; ball.vz *= ratio; }
      }
      for (let pi = 0; pi < pockets.length; pi += 1) {
        const pocket = pockets[pi];
        if ((ball.x - pocket.x) ** 2 + (ball.z - pocket.z) ** 2 < pocket.radius ** 2) {
          ball.vx = 0; ball.vz = 0; ball.pocketed = true;
          if (ball.id === 0) report.cueScratch = true;
          else { report.pocketedIds.push(ball.id); if (ball.id === 8) report.eightPocketed = true; }
          if (wantTrace) events.push({ f: Math.floor(frame / TRACE_EVERY), k: 'p', id: ball.id, pocket: pi });
          break;
        }
      }
      if (ball.pocketed) continue;
      if (ball.x < minX) { const vn = Math.abs(ball.vx); ball.x = minX; ball.vx = vn * TABLE.cushionRestitution; cushion(ball, 1, 0, vn); nudgeFromPocket(ball); }
      else if (ball.x > maxX) { const vn = Math.abs(ball.vx); ball.x = maxX; ball.vx = -vn * TABLE.cushionRestitution; cushion(ball, -1, 0, vn); nudgeFromPocket(ball); }
      if (ball.z < minZ) { const vn = Math.abs(ball.vz); ball.z = minZ; ball.vz = vn * TABLE.cushionRestitution; cushion(ball, 0, 1, vn); nudgeFromPocket(ball); }
      else if (ball.z > maxZ) { const vn = Math.abs(ball.vz); ball.z = maxZ; ball.vz = -vn * TABLE.cushionRestitution; cushion(ball, 0, -1, vn); nudgeFromPocket(ball); }
    }
    for (let i = 0; i < state.balls.length; i += 1) {
      const a = state.balls[i]; if (a.pocketed) continue;
      for (let j = i + 1; j < state.balls.length; j += 1) {
        const b = state.balls[j]; if (b.pocketed) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
        if (d2 <= 0 || d2 >= minDistanceSq) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, overlap = minDistance - d;
        a.x -= nx * overlap * 0.5; a.z -= nz * overlap * 0.5;
        b.x += nx * overlap * 0.5; b.z += nz * overlap * 0.5;
        const relative = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (relative > 0) {
          const cueBall = a.id === 0 ? a : b.id === 0 ? b : null;
          let ucx = 0, ucz = 0;
          if (cueBall && sy !== 0) {
            const sp = Math.hypot(cueBall.vx, cueBall.vz);
            if (sp > 0) { ucx = cueBall.vx / sp; ucz = cueBall.vz / sp; }
          }
          const impulse = ((1 + TABLE.ballRestitution) * relative) / 2;
          a.vx -= impulse * nx; a.vz -= impulse * nz;
          b.vx += impulse * nx; b.vz += impulse * nz;
          if (cueBall && sy !== 0 && (ucx !== 0 || ucz !== 0)) {
            const k = (sy > 0 ? SPIN.followK : SPIN.drawK) * sy * relative;
            cueBall.vx += ucx * k; cueBall.vz += ucz * k;
            sy *= SPIN.contactKeep;
          }
          if (wantTrace && relative > 0.05) events.push({ f: Math.floor(frame / TRACE_EVERY), k: 'b', v: relative });
          if (report.firstContactId === null) {
            if (a.id === 0 && b.id !== 0) report.firstContactId = b.id;
            if (b.id === 0 && a.id !== 0) report.firstContactId = a.id;
          }
        }
      }
    }
    const moving = state.balls.some((b) => !b.pocketed && Math.hypot(b.vx, b.vz) > TABLE.stopSpeed);
    if (!moving) { settled = true; break; }
  }
  if (!settled) throw new Error('The shot did not settle safely.');
  if (wantTrace) sample();
  const trace = wantTrace ? { hz: 60, ids, frames, events, startCue } : null;

  const playerIndex = state.currentPlayer;
  const playerGroup = state.groups[playerIndex];
  const opponentIndex = 1 - playerIndex;
  let foul = false;
  const reasons = [];
  if (report.cueScratch) { foul = true; reasons.push('scratch'); }
  const first = report.firstContactId === null ? null : state.balls.find((b) => b.id === report.firstContactId);
  if (!first) { foul = true; reasons.push('no object ball contact'); }
  else if (playerGroup) {
    const firstGroup = groupFor(first.id);
    if (first.id === 8 && remaining(state, playerGroup).length > 0) { foul = true; reasons.push('hit the 8 before clearing the group'); }
    else if (first.id !== 8 && firstGroup !== playerGroup) { foul = true; reasons.push('wrong first contact'); }
  } else if (first.id === 8) { foul = true; reasons.push('hit the 8 first on an open table'); }
  const playerGroupBeforeAssignment = playerGroup;
  const firstPocketedGroup = report.pocketedIds.map(groupFor).find(Boolean) || null;
  state.lastShot = { by: playerIndex, pocketedIds: report.pocketedIds.slice(), foul: false, reasons: [], scratch: report.cueScratch };
  if (report.eightPocketed) {
    const cleared = state.groups[playerIndex] !== null && remaining(state, state.groups[playerIndex]).length === 0;
    const wins = !foul && cleared;
    state.gameOver = true;
    state.winnerPlayer = wins ? playerIndex : opponentIndex;
    state.status = wins ? `Player ${playerIndex + 1} pockets the 8 and wins the match.` : `Player ${playerIndex + 1} loses by sinking the 8 early${reasons.length ? ` after ${reasons.join(', ')}` : ''}. Player ${opponentIndex + 1} wins.`;
    state.shotInProgress = false;
    state.ballInHand = false;
    state.lastShot.foul = !wins; state.lastShot.reasons = reasons;
    if (report.cueScratch) restoreCue(state.balls);
    return { state, trace };
  }
  if (!foul && !state.groups[playerIndex] && firstPocketedGroup) {
    state.groups[playerIndex] = firstPocketedGroup;
    state.groups[opponentIndex] = firstPocketedGroup === 'solid' ? 'stripe' : 'solid';
  }
  const pocketedGroups = report.pocketedIds.map(groupFor).filter(Boolean);
  const legalPocket = !foul && (state.groups[playerIndex] ? pocketedGroups.includes(state.groups[playerIndex]) : !playerGroupBeforeAssignment && pocketedGroups.length > 0);
  if (report.cueScratch) restoreCue(state.balls);
  if (foul) {
    state.currentPlayer = opponentIndex;
    state.status = `Player ${playerIndex + 1} fouls (${reasons.join(', ')}). Player ${opponentIndex + 1} has the table${BALL_IN_HAND_ON_FOUL ? ' with ball in hand' : ''}.`;
  } else if (legalPocket) {
    state.currentPlayer = playerIndex;
    state.status = `Player ${playerIndex + 1} pockets legally and keeps shooting.`;
  } else {
    state.currentPlayer = opponentIndex;
    state.status = `Player ${playerIndex + 1} comes up dry. Player ${opponentIndex + 1} shoots next.`;
  }
  state.lastShot.foul = foul; state.lastShot.reasons = reasons;
  state.ballInHand = BALL_IN_HAND_ON_FOUL && foul;
  state.shotInProgress = false;
  state.winnerPlayer = null;
  state.balls = state.balls.map((b) => ({ ...b, x: Number(b.x.toFixed(6)), z: Number(b.z.toFixed(6)), vx: 0, vz: 0 }));
  return { state, trace };
}

/** Authoritative result only (no trace). `options` = { spinX, spinY, cuePlacement }. */
function simulateShot(inputState, power, angleRadians, options) {
  return simulateShotTrace(inputState, power, angleRadians, { ...(options || {}), trace: false }).state;
}

module.exports = { TURN_SECONDS, applyTurnTimeout, TABLE, SPIN, pockets, pocketHoleAt, initialPoolState, simulateShot, simulateShotTrace, parseShotInput, isLegalPlacement };
