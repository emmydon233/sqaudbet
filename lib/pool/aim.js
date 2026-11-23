/**
 * Aim prediction for the cue guide. Pure geometry on the SAME constants the authoritative
 * simulation uses (lib/pool/authoritative.js), so the guide describes the real shot:
 *  - the cue ball's straight path to its first contact (ball, cushion or pocket),
 *  - the ghost-ball position at contact and the object ball's departure line,
 *  - the cue ball's post-contact line (including follow / draw spin),
 *  - the pocket the object ball is heading for, if its line reaches one.
 * It is a first-order prediction (no friction curve, no secondary collisions) and is only
 * ever used for drawing; the server remains the only authority on what actually happens.
 */
const { TABLE, SPIN, pockets } = require('./authoritative.js');

const R = TABLE.ballRadius;
const MIN_X = -TABLE.halfW + R * 0.62;
const MAX_X = TABLE.halfW - R * 0.62;
const MIN_Z = -TABLE.halfD + R * 0.62;
const MAX_Z = TABLE.halfD - R * 0.62;

/** Smallest t>0 where the ray p + t*d enters the circle (c, radius). */
function rayCircle(px, pz, dx, dz, cx, cz, radius) {
  const mx = cx - px, mz = cz - pz;
  const proj = mx * dx + mz * dz;
  const perp2 = mx * mx + mz * mz - proj * proj;
  if (perp2 >= radius * radius) return null;
  const t = proj - Math.sqrt(radius * radius - perp2);
  if (t < 0) return mx * mx + mz * mz < radius * radius ? 0 : null;
  return t;
}
/** Distance along the ray to the cushion bounds used by the simulation, and the wall hit. */
function rayWall(px, pz, dx, dz) {
  let best = Infinity, nx = 0, nz = 0;
  if (dx > 1e-9) { const t = (MAX_X - px) / dx; if (t >= 0 && t < best) { best = t; nx = -1; nz = 0; } }
  else if (dx < -1e-9) { const t = (MIN_X - px) / dx; if (t >= 0 && t < best) { best = t; nx = 1; nz = 0; } }
  if (dz > 1e-9) { const t = (MAX_Z - pz) / dz; if (t >= 0 && t < best) { best = t; nx = 0; nz = -1; } }
  else if (dz < -1e-9) { const t = (MIN_Z - pz) / dz; if (t >= 0 && t < best) { best = t; nx = 0; nz = 1; } }
  return { t: best, nx, nz };
}
function firstPocket(px, pz, dx, dz, maxT) {
  let best = null;
  for (let i = 0; i < pockets.length; i += 1) {
    const t = rayCircle(px, pz, dx, dz, pockets[i].x, pockets[i].z, pockets[i].radius);
    if (t !== null && t <= maxT && (best === null || t < best.t)) best = { t, index: i };
  }
  return best;
}

/**
 * @param balls  [{id,x,z,pocketed}] from the authoritative snapshot (cue = id 0)
 * @param cue    {x,z} cue-ball position (may differ from the snapshot while placing)
 * @param angle  aim angle in radians (atan2(dz, dx))
 * @param spin   {x,y} cue-ball spin, each -1..1
 */
function predictShot(balls, cue, angle, spin) {
  const sx = (spin && spin.x) || 0, sy = (spin && spin.y) || 0;
  const a = angle - sx * SPIN.squirt; // same launch deflection as the server
  const dx = Math.cos(a), dz = Math.sin(a);
  const out = {
    launchAngle: a,
    cueStart: { x: cue.x, z: cue.z },
    cueEnd: null,           // where the cue ball stops being a straight line (contact / wall)
    contact: null,          // { id, ghost:{x,z}, point:{x,z}, normal:{x,z} }
    objectLine: null,       // { from:{x,z}, to:{x,z}, dir:{x,z}, pocket:number|-1, cushion:boolean }
    cueAfter: null,         // { from, to, dir }
    cueBounce: null,        // when no ball is hit: { from, to } after the first cushion
    cuePocket: -1,          // pocket index if the cue ball would be pocketed on its straight run
  };

  let tBall = Infinity, hit = null;
  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    const t = rayCircle(cue.x, cue.z, dx, dz, b.x, b.z, R * 2);
    if (t !== null && t < tBall) { tBall = t; hit = b; }
  }
  const wall = rayWall(cue.x, cue.z, dx, dz);
  const tEnd = Math.min(tBall, wall.t);
  const pocket = firstPocket(cue.x, cue.z, dx, dz, tEnd);
  if (pocket) {
    out.cuePocket = pocket.index;
    out.cueEnd = { x: cue.x + dx * pocket.t, z: cue.z + dz * pocket.t };
    return out;
  }
  out.cueEnd = { x: cue.x + dx * tEnd, z: cue.z + dz * tEnd };

  if (!hit || tBall > wall.t) {
    // Cushion first: show a single rebound segment (restitution is applied to the normal part only).
    const rx = wall.nx !== 0 ? -dx : dx, rz = wall.nz !== 0 ? -dz : dz;
    const bounce = rayWall(out.cueEnd.x, out.cueEnd.z, rx, rz);
    const len = Math.min(bounce.t, 1.8);
    out.cueBounce = { from: out.cueEnd, to: { x: out.cueEnd.x + rx * len, z: out.cueEnd.z + rz * len } };
    return out;
  }

  // Ball contact. Normal points from the cue ball (at contact) to the object ball.
  const ghost = out.cueEnd;
  let nx = hit.x - ghost.x, nz = hit.z - ghost.z;
  const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
  out.contact = {
    id: hit.id, ghost: { x: ghost.x, z: ghost.z },
    point: { x: ghost.x + nx * R, z: ghost.z + nz * R }, normal: { x: nx, z: nz },
  };

  // Object ball leaves along the line of centres.
  const objWall = rayWall(hit.x, hit.z, nx, nz);
  const objPocket = firstPocket(hit.x, hit.z, nx, nz, objWall.t);
  const objLen = objPocket ? objPocket.t : Math.min(objWall.t, 3.2);
  out.objectLine = {
    from: { x: hit.x, z: hit.z }, dir: { x: nx, z: nz },
    to: { x: hit.x + nx * objLen, z: hit.z + nz * objLen },
    pocket: objPocket ? objPocket.index : -1, cushion: !objPocket,
  };

  // Cue ball after contact: equal-mass exchange with the engine's restitution, plus follow/draw.
  const approach = dx * nx + dz * nz; // > 0
  const share = (1 + TABLE.ballRestitution) / 2;
  let cx = dx - share * approach * nx, cz = dz - share * approach * nz;
  if (sy !== 0) {
    const k = (sy > 0 ? SPIN.followK : SPIN.drawK) * sy * approach;
    cx += dx * k; cz += dz * k;
  }
  const cl = Math.hypot(cx, cz);
  if (cl > 1e-6) {
    const ux = cx / cl, uz = cz / cl;
    const w = rayWall(ghost.x, ghost.z, ux, uz);
    const len = Math.min(w.t, 0.2 + cl * 1.1);
    out.cueAfter = { from: { x: ghost.x, z: ghost.z }, dir: { x: ux, z: uz }, to: { x: ghost.x + ux * len, z: ghost.z + uz * len } };
  }
  return out;
}

module.exports = { predictShot };
