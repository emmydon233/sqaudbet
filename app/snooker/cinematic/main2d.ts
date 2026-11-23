/**
 * SquadBet Pool - 2D table renderer (top-down, like the 8 Ball Pool app).
 *
 * This is a drop-in replacement for the 3D cinematic table (`main.ts`). It exposes the SAME
 * `mountCinematicPool()` entry point and the SAME `window.__POOL_GAME__` API and `pool-*` events, so the pages
 * (`pool3d/page.tsx`, `pool3d/local/page.tsx`), the HUD (avatars, 30 s turn ring, stake, pause text) and all the
 * server routes are untouched.
 *
 * Authority is unchanged: this file never decides a result. Every shot is simulated by
 * `lib/pool/authoritative.js` (the same module the server runs). Online, the page sends the shot to the server and
 * this renderer replays the server-approved trace; practice (local) games replay the same module's result.
 *
 * Rendering: balls are per-pixel shaded spheres (lighting, clear-coat highlight, rolling number discs, cast and contact
 * shadows) drawn on a pre-rendered table image, in a straight top-down view so every ball stays large and readable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PoolHud } from '../../pool3d/engine/hud';
import { PoolAudio } from '../../pool3d/engine/audio';
import type { PoolPlayerInfo } from '../../pool3d/engine/common';
import { predictShot } from '../../../lib/pool/aim';
import { TABLE as AUTH, pockets as AUTH_POCKETS, initialPoolState, isLegalPlacement, simulateShotTrace } from '../../../lib/pool/authoritative';
import type { PoolTrace } from '../../../lib/pool/authoritative';

type BallKind = 'cue' | 'solid' | 'stripe' | 'eight';
type ApprovedShotExtra = { spinX?: number; spinY?: number; cuePlacement?: { x: number; z: number } | null };
type Job = { start: any; power: number; angle: number; final: any; extra?: ApprovedShotExtra; local: boolean };

type Ball = {
  id: number;
  kind: BallKind;
  x: number; // world (authoritative units)
  z: number;
  px: number; // table-image pixels
  py: number;
  pocketed: boolean;
  M: number[]; // orientation (3x3, row-major) so numbers and stripes roll like a real ball
  spr: HTMLCanvasElement | null;
  dirty: boolean;
  rdx: number;
  rdy: number;
  fall: { t: number; sx: number; sy: number; tx: number; ty: number } | null;
};

/* ------------------------------------------------------------------ geometry (pixels of the table image) */
const S = 107.45; // pixels per authoritative world unit
const R_W = AUTH.ballRadius;
const R = R_W * S; // ball radius in pixels
const PX = 60, PY = 60, PW = 880, PH = 448; // felt (playing surface) rectangle
const OX = PX + PW / 2, OY = PY + PH / 2; // world (0,0)
const CORNER_MOUTH = 38, SIDE_MOUTH = 31;
const COLORS = [0xfff8e9, 0xf5c400, 0x1f4fd8, 0xd42a2a, 0x5b2a9a, 0xf07a14, 0x1a8f3c, 0x7b1e24, 0x101012];
const colorOf = (id: number): number => COLORS[id <= 8 ? id : id - 8];
const kindOf = (id: number): BallKind => (id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe');
const wx = (x: number): number => OX + x * S;
const wz = (z: number): number => OY + z * S;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Visual pocket holes. The authoritative pocket centres decide where a ball is captured; the hole is drawn slightly
// outside the felt so the ball visibly drops into it.
const HOLES = AUTH_POCKETS.map((p, i) => {
  const corner = i !== 1 && i !== 4;
  const sx = Math.sign(p.x), sz = Math.sign(p.z);
  return {
    x: wx(p.x) + (corner ? sx * 9 : 0),
    y: wz(p.z) + sz * (corner ? 9 : 12),
    r: corner ? 28 : 25,
  };
});

/* ------------------------------------------------------------------ small matrix helpers */
const mul = (a: number[], b: number[]): number[] => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const rot = (ax: number, ay: number, az: number, ang: number): number[] => {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay, t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax, t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c];
};

/* ------------------------------------------------------------------ number discs (shared by all mounts) */
const TEX = 96;
let numTex: Uint8ClampedArray[] | null = null;
function buildNumberTextures(): Uint8ClampedArray[] {
  if (numTex) return numTex;
  const out: Uint8ClampedArray[] = [];
  for (let id = 1; id <= 15; id += 1) {
    const c = document.createElement('canvas');
    c.width = c.height = TEX;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f7f4ea';
    g.beginPath();
    g.arc(TEX / 2, TEX / 2, TEX / 2 - 1, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0a0a0c';
    g.font = `900 ${id >= 10 ? 52 : 66}px "Arial Black", Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(id), TEX / 2, TEX / 2 + 4);
    if (id === 6 || id === 9) g.fillRect(TEX / 2 - 13, TEX / 2 + 27, 26, 5);
    out[id] = g.getImageData(0, 0, TEX, TEX).data;
  }
  numTex = out;
  return out;
}
// six decal axes (centre c, up u); right = u x c
const AX = [
  { c: [0, 0, 1], u: [0, 1, 0] }, { c: [0, 0, -1], u: [0, 1, 0] },
  { c: [1, 0, 0], u: [0, 1, 0] }, { c: [-1, 0, 0], u: [0, 1, 0] },
  { c: [0, 1, 0], u: [0, 0, -1] }, { c: [0, -1, 0], u: [0, 0, 1] },
].map((a) => ({ ...a, r: [a.u[1] * a.c[2] - a.u[2] * a.c[1], a.u[2] * a.c[0] - a.u[0] * a.c[2], a.u[0] * a.c[1] - a.u[1] * a.c[0]] }));
const DISC = 0.53; // sin(angular radius) of the number disc
const DISC_COS = Math.sqrt(1 - DISC * DISC);
const LIGHT = (() => { const v = [-0.45, 0.62, 0.64]; const n = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / n); })();
const HALF = (() => { const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1]; const n = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / n); })();
const smooth = (e0: number, e1: number, x: number): number => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Per-pixel shaded sphere: real lighting, clear-coat highlight, number discs that follow the ball's rotation. */
function renderBall(b: Ball, sizePx: number): void {
  const tex = buildNumberTextures();
  if (!b.spr || b.spr.width !== sizePx) {
    b.spr = document.createElement('canvas');
    b.spr.width = b.spr.height = sizePx;
  }
  const g = b.spr.getContext('2d')!;
  const img = g.createImageData(sizePx, sizePx);
  const d = img.data;
  const M = b.M;
  const base = colorOf(b.id), br = (base >> 16) & 255, bg = (base >> 8) & 255, bb = base & 255;
  const half = sizePx / 2, rad = half - 0.5;
  const t = tex[b.id];
  for (let py = 0; py < sizePx; py += 1) {
    for (let px = 0; px < sizePx; px += 1) {
      const dx = (px + 0.5 - half) / rad, dy = (py + 0.5 - half) / rad;
      const rr = dx * dx + dy * dy;
      if (rr > 1) continue;
      const nz = Math.sqrt(1 - rr), nx = dx, ny = -dy;
      const lx = M[0] * nx + M[3] * ny + M[6] * nz;
      const ly = M[1] * nx + M[4] * ny + M[7] * nz;
      const lz = M[2] * nx + M[5] * ny + M[8] * nz;
      let r: number, gg: number, bl: number;
      if (b.kind === 'cue') {
        r = 246; gg = 242; bl = 230;
        if (lx > 0.985 || -lx > 0.985 || ly > 0.985 || -ly > 0.985) { r = 200; gg = 40; bl = 40; } // small red spots show the roll
      } else {
        if (b.kind === 'stripe') {
          const e = clamp((0.52 - Math.abs(ly)) / 0.06, 0, 1);
          r = 246 + (br - 246) * e; gg = 242 + (bg - 242) * e; bl = 230 + (bb - 230) * e;
        } else { r = br; gg = bg; bl = bb; }
        for (let k = 0; k < 6; k += 1) {
          const a = AX[k];
          if (lx * a.c[0] + ly * a.c[1] + lz * a.c[2] > DISC_COS) {
            const aa = lx * a.r[0] + ly * a.r[1] + lz * a.r[2];
            const b2 = lx * a.u[0] + ly * a.u[1] + lz * a.u[2];
            // bilinear sample of the number disc so edges and digits stay smooth at any ball size
            const fx = (aa / DISC * 0.5 + 0.5) * (TEX - 1), fy = (0.5 - b2 / DISC * 0.5) * (TEX - 1);
            const x0 = Math.floor(fx), y0 = Math.floor(fy), wx = fx - x0, wy = fy - y0;
            if (x0 >= 0 && y0 >= 0 && x0 < TEX - 1 && y0 < TEX - 1) {
              const i00 = (y0 * TEX + x0) * 4, i10 = i00 + 4, i01 = i00 + TEX * 4, i11 = i01 + 4;
              const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
              const al = (t[i00 + 3] * w00 + t[i10 + 3] * w10 + t[i01 + 3] * w01 + t[i11 + 3] * w11) / 255;
              if (al > 0.001) {
                const tr = (t[i00] * t[i00 + 3] * w00 + t[i10] * t[i10 + 3] * w10 + t[i01] * t[i01 + 3] * w01 + t[i11] * t[i11 + 3] * w11) / (al * 255);
                const tg = (t[i00 + 1] * t[i00 + 3] * w00 + t[i10 + 1] * t[i10 + 3] * w10 + t[i01 + 1] * t[i01 + 3] * w01 + t[i11 + 1] * t[i11 + 3] * w11) / (al * 255);
                const tb = (t[i00 + 2] * t[i00 + 3] * w00 + t[i10 + 2] * t[i10 + 3] * w10 + t[i01 + 2] * t[i01 + 3] * w01 + t[i11 + 2] * t[i11 + 3] * w11) / (al * 255);
                r = r * (1 - al) + tr * al; gg = gg * (1 - al) + tg * al; bl = bl * (1 - al) + tb * al;
              }
            }
            break;
          }
        }
      }
      // wrapped diffuse from the overhead lamp, green bounce from the cloth, soft sheen, window reflection, hard highlight
      const nl = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const wrap = 0.30 + 0.80 * Math.pow(nl, 0.9);
      const bounce = Math.max(0, -ny * 0.6 - nx * 0.25) * 0.20;
      const ao = 0.90 + 0.10 * (ny * 0.5 + 0.5);
      const rimD = 0.78 + 0.22 * Math.pow(nz, 0.7);
      const rx = 2 * nz * nx, ry = 2 * nz * ny, rz = 2 * nz * nz - 1;
      const win = smooth(-0.78, -0.62, rx) * (1 - smooth(-0.30, -0.16, rx)) * smooth(0.22, 0.34, ry) * (1 - smooth(0.58, 0.72, ry)) * (rz > 0 ? 1 : 0.4);
      const hn = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
      const hn2 = Math.max(0, nx * 0.55 + ny * -0.45 + nz * 0.70);
      const gloss = Math.pow(hn, 170) * 1.0 + Math.pow(hn, 22) * 0.16 + win * 0.55 + Math.pow(hn2, 60) * 0.10;
      const fres = 0.04 + 0.34 * Math.pow(1 - nz, 3.2);
      const envUp = clamp(ry * 0.5 + 0.5, 0, 1);
      const eR = (225 * envUp + 28 * (1 - envUp)) * fres, eG = (228 * envUp + 120 * (1 - envUp)) * fres, eB = (215 * envUp + 62 * (1 - envUp)) * fres;
      const k0 = wrap * rimD * ao * (1 - fres * 0.5);
      const R_ = r * k0 + 255 * gloss + eR + r * bounce * 0.15 + 20 * bounce;
      const G_ = gg * k0 + 255 * gloss + eG + gg * bounce * 0.15 + 95 * bounce;
      const B_ = bl * k0 + 255 * gloss + eB + bl * bounce * 0.15 + 45 * bounce;
      const o = (py * sizePx + px) * 4;
      d[o] = R_ > 255 ? 255 : R_; d[o + 1] = G_ > 255 ? 255 : G_; d[o + 2] = B_ > 255 ? 255 : B_;
      d[o + 3] = Math.round(255 * Math.min(1, (1 - Math.sqrt(rr)) * rad));
    }
  }
  g.putImageData(img, 0, 0);
  b.dirty = false;
}

/* ------------------------------------------------------------------ static table art */
const seeded = (seed: number) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function pearl(g: CanvasRenderingContext2D, x: number, y: number): void {
  const k = g.createRadialGradient(x - 1.2, y - 1.2, 0.5, x, y, 5);
  k.addColorStop(0, '#fffdf3'); k.addColorStop(0.6, '#e8dcb8'); k.addColorStop(1, '#8c7b50');
  g.fillStyle = k; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 3.6, y); g.lineTo(x, y + 5); g.lineTo(x - 3.6, y); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 0.8; g.stroke();
}

function paintTable(c: HTMLCanvasElement, scale: number, VX0: number, VY0: number, VW: number, VH: number): void {
  const g = c.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, -VX0 * scale, -VY0 * scale);
  const rn = seeded(7);
  g.fillStyle = '#0a0f0d'; g.fillRect(VX0 - 2, VY0 - 2, VW + 4, VH + 4);
  // outer wooden rail: varnished mahogany with grain
  const wood = g.createLinearGradient(0, VY0, 0, VY0 + VH);
  wood.addColorStop(0, '#8a4f28'); wood.addColorStop(0.18, '#6d3b1d'); wood.addColorStop(0.5, '#5a2f16'); wood.addColorStop(0.82, '#4a2611'); wood.addColorStop(1, '#6a3a1d');
  g.fillStyle = wood; g.fillRect(VX0 - 2, VY0 - 2, VW + 4, VH + 4);
  g.save(); g.beginPath(); g.rect(VX0 - 2, VY0 - 2, VW + 4, VH + 4); g.clip();
  for (let i = 0; i < 260; i += 1) {
    const y = VY0 + rn() * VH, len = 120 + rn() * 380, x = VX0 + rn() * VW;
    g.strokeStyle = `rgba(${rn() > 0.5 ? '255,205,150' : '25,8,0'},${0.035 + rn() * 0.07})`; g.lineWidth = 0.5 + rn() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + len * 0.3, y + (rn() - 0.5) * 7, x + len * 0.7, y + (rn() - 0.5) * 7, x + len, y + (rn() - 0.5) * 5); g.stroke();
  }
  for (let i = 0; i < 90; i += 1) {
    const x = VX0 + rn() * VW, y = VY0 + rn() * VH;
    const k = g.createRadialGradient(x, y, 0, x, y, 30 + rn() * 50);
    k.addColorStop(0, 'rgba(30,10,0,.10)'); k.addColorStop(1, 'rgba(30,10,0,0)');
    g.fillStyle = k; g.fillRect(x - 90, y - 90, 180, 180);
  }
  const sheen = g.createLinearGradient(0, VY0, 0, VY0 + VH);
  sheen.addColorStop(0, 'rgba(255,225,185,.34)'); sheen.addColorStop(0.07, 'rgba(255,225,185,.10)'); sheen.addColorStop(0.14, 'rgba(255,225,185,0)');
  sheen.addColorStop(0.9, 'rgba(255,225,185,0)'); sheen.addColorStop(0.97, 'rgba(255,225,185,.10)'); sheen.addColorStop(1, 'rgba(255,225,185,.22)');
  g.fillStyle = sheen; g.fillRect(VX0, VY0, VW, VH);
  {
    // the rail is a rounded timber: dark outer edge, bright varnished crest, roll-off into the cushion
    const xo0 = PX - 24 - 9, xo1 = PX + PW + 24 + 9, yo0 = PY - 24 - 9, yo1 = PY + PH + 24 + 9;
    const roll = (ax: number, ay: number, bx: number, by: number, s2: number): CanvasGradient => {
      const gr = g.createLinearGradient(ax, ay, bx, by);
      gr.addColorStop(0, 'rgba(0,0,0,.50)'); gr.addColorStop(0.16, 'rgba(0,0,0,.10)'); gr.addColorStop(0.40, `rgba(255,222,170,${0.34 * s2})`);
      gr.addColorStop(0.58, `rgba(255,222,170,${0.07 * s2})`); gr.addColorStop(1, 'rgba(0,0,0,.42)'); return gr;
    };
    g.fillStyle = roll(0, VY0, 0, yo0, 1); g.fillRect(VX0 - 2, VY0 - 2, VW + 4, yo0 - VY0 + 2);
    g.fillStyle = roll(0, VY0 + VH, 0, yo1, 0.55); g.fillRect(VX0 - 2, yo1, VW + 4, VY0 + VH - yo1 + 2);
    g.fillStyle = roll(VX0, 0, xo0, 0, 0.85); g.fillRect(VX0 - 2, yo0, xo0 - VX0 + 2, yo1 - yo0);
    g.fillStyle = roll(VX0 + VW, 0, xo1, 0, 0.45); g.fillRect(xo1, yo0, VX0 + VW - xo1 + 2, yo1 - yo0);
    const dg = g.createLinearGradient(VX0, VY0, VX0 + VW * 0.7, VY0 + VH * 1.2);
    dg.addColorStop(0, 'rgba(255,240,215,0)'); dg.addColorStop(0.22, 'rgba(255,240,215,.10)'); dg.addColorStop(0.36, 'rgba(255,240,215,0)'); dg.addColorStop(1, 'rgba(255,240,215,0)');
    g.fillStyle = dg; g.fillRect(VX0 - 2, VY0 - 2, VW + 4, VH + 4);
  }
  g.restore();
  // cushions: trapezoid rubber rails with angled ends into each pocket
  const CW_ = 24;
  const mc = CORNER_MOUTH + 8, ms = SIDE_MOUTH + 8;
  g.fillStyle = '#06180f'; roundRect(g, PX - CW_ - 3, PY - CW_ - 3, PW + 2 * CW_ + 6, PH + 2 * CW_ + 6, 14); g.fill();
  g.fillStyle = '#17804d'; g.fillRect(PX - 4, PY - 4, PW + 8, PH + 8);
  const strip = (side: 'T' | 'B' | 'L' | 'R', n0: number, n1: number): void => {
    let nose0: number[] = [], nose1: number[] = [], base0: number[] = [], base1: number[] = [], nx = 0, ny = 0;
    if (side === 'T') { nose0 = [n0, PY]; nose1 = [n1, PY]; base0 = [n0 - CW_, PY - CW_]; base1 = [n1 + CW_, PY - CW_]; ny = -1; }
    if (side === 'B') { nose0 = [n0, PY + PH]; nose1 = [n1, PY + PH]; base0 = [n0 - CW_, PY + PH + CW_]; base1 = [n1 + CW_, PY + PH + CW_]; ny = 1; }
    if (side === 'L') { nose0 = [PX, n0]; nose1 = [PX, n1]; base0 = [PX - CW_, n0 - CW_]; base1 = [PX - CW_, n1 + CW_]; nx = -1; }
    if (side === 'R') { nose0 = [PX + PW, n0]; nose1 = [PX + PW, n1]; base0 = [PX + PW + CW_, n0 - CW_]; base1 = [PX + PW + CW_, n1 + CW_]; nx = 1; }
    g.save(); g.beginPath(); g.rect(PX, PY, PW, PH); g.clip();
    const sg = g.createLinearGradient(nose0[0], nose0[1], nose0[0] - nx * 18, nose0[1] - ny * 18);
    sg.addColorStop(0, 'rgba(0,0,0,.62)'); sg.addColorStop(0.5, 'rgba(0,0,0,.22)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg; g.beginPath(); g.moveTo(nose0[0], nose0[1]); g.lineTo(nose1[0], nose1[1]);
    g.lineTo(nose1[0] - nx * 18, nose1[1] - ny * 18); g.lineTo(nose0[0] - nx * 18, nose0[1] - ny * 18); g.closePath(); g.fill();
    g.restore();
    const bgr = g.createLinearGradient(nose0[0], nose0[1], base0[0], base0[1]);
    const lit = side === 'T' || side === 'L';
    bgr.addColorStop(0, lit ? '#1f8c58' : '#177a4c'); bgr.addColorStop(0.28, lit ? '#14693f' : '#0f5733'); bgr.addColorStop(1, lit ? '#04261a' : '#032015');
    g.fillStyle = bgr; g.beginPath(); g.moveTo(nose0[0], nose0[1]); g.lineTo(nose1[0], nose1[1]); g.lineTo(base1[0], base1[1]); g.lineTo(base0[0], base0[1]); g.closePath(); g.fill();
    g.lineCap = 'round';
    g.strokeStyle = lit ? 'rgba(190,255,220,.38)' : 'rgba(160,235,195,.20)'; g.lineWidth = 1.3; g.beginPath(); g.moveTo(nose0[0], nose0[1]); g.lineTo(nose1[0], nose1[1]); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(base0[0], base0[1]); g.lineTo(base1[0], base1[1]); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(nose0[0], nose0[1]); g.lineTo(base0[0], base0[1]); g.moveTo(nose1[0], nose1[1]); g.lineTo(base1[0], base1[1]); g.stroke();
  };
  strip('T', PX + mc, PX + PW / 2 - ms); strip('T', PX + PW / 2 + ms, PX + PW - mc);
  strip('B', PX + mc, PX + PW / 2 - ms); strip('B', PX + PW / 2 + ms, PX + PW - mc);
  strip('L', PY + mc, PY + PH - mc); strip('R', PY + mc, PY + PH - mc);
  // bevelled wooden rail edge
  const BV = 9;
  const bevel = (pts: number[][], c0: string, c1: string, g0: number[], g1: number[]): void => {
    const gr = g.createLinearGradient(g0[0], g0[1], g1[0], g1[1]); gr.addColorStop(0, c0); gr.addColorStop(1, c1);
    g.fillStyle = gr; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill();
  };
  const X0 = PX - CW_ - BV, X1 = PX + PW + CW_ + BV, Y0 = PY - CW_ - BV, Y1 = PY + PH + CW_ + BV;
  const xi0 = PX - CW_, xi1 = PX + PW + CW_, yi0 = PY - CW_, yi1 = PY + PH + CW_;
  bevel([[X0, Y0], [X1, Y0], [xi1, yi0], [xi0, yi0]], 'rgba(255,222,170,.55)', 'rgba(120,60,20,.10)', [0, Y0], [0, yi0]);
  bevel([[X0, Y0], [xi0, yi0], [xi0, yi1], [X0, Y1]], 'rgba(255,215,160,.42)', 'rgba(120,60,20,.10)', [X0, 0], [xi0, 0]);
  bevel([[X0, Y1], [xi0, yi1], [xi1, yi1], [X1, Y1]], 'rgba(40,15,0,.55)', 'rgba(40,15,0,.05)', [0, Y1], [0, yi1]);
  bevel([[X1, Y0], [X1, Y1], [xi1, yi1], [xi1, yi0]], 'rgba(40,15,0,.5)', 'rgba(40,15,0,.05)', [X1, 0], [xi1, 0]);
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.6; g.beginPath(); g.rect(xi0, yi0, xi1 - xi0, yi1 - yi0); g.stroke();
  g.strokeStyle = 'rgba(255,225,180,.30)'; g.lineWidth = 1; g.beginPath(); g.rect(X0, Y0, X1 - X0, Y1 - Y0); g.stroke();
  // felt
  g.fillStyle = '#157a4a'; g.fillRect(PX, PY, PW, PH);
  const lamp = g.createRadialGradient(PX + PW * 0.5, PY + PH * 0.46, 30, PX + PW * 0.5, PY + PH * 0.5, PW * 0.64);
  lamp.addColorStop(0, 'rgba(150,255,195,.26)'); lamp.addColorStop(0.40, 'rgba(70,205,130,.10)'); lamp.addColorStop(1, 'rgba(0,22,9,.62)');
  g.fillStyle = lamp; g.fillRect(PX, PY, PW, PH);
  g.save(); g.beginPath(); g.rect(PX, PY, PW, PH); g.clip();
  g.globalAlpha = 0.05; g.strokeStyle = '#000'; g.lineWidth = 0.5;
  for (let x = PX; x < PX + PW; x += 3) { g.beginPath(); g.moveTo(x, PY); g.lineTo(x, PY + PH); g.stroke(); }
  g.strokeStyle = '#fff';
  for (let y = PY; y < PY + PH; y += 3) { g.beginPath(); g.moveTo(PX, y); g.lineTo(PX + PW, y); g.stroke(); }
  g.globalAlpha = 1;
  const nr = seeded(11);
  for (let i = 0; i < 9000; i += 1) {
    g.fillStyle = `rgba(${nr() > 0.5 ? '255,255,255' : '0,0,0'},${0.012 + nr() * 0.03})`;
    g.fillRect(PX + nr() * PW, PY + nr() * PH, 1.2 + nr() * 1.2, 1.2 + nr() * 1.2);
  }
  for (let i = 0; i < 40; i += 1) {
    const x = PX + nr() * PW, y = PY + nr() * PH, rr = 40 + nr() * 90;
    const k = g.createRadialGradient(x, y, 0, x, y, rr);
    k.addColorStop(0, `rgba(${nr() > 0.5 ? '90,220,150' : '0,40,20'},.05)`); k.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = k; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number): void => {
    const k = g.createLinearGradient(x0, y0, x1, y1); k.addColorStop(0, 'rgba(0,0,0,.45)'); k.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = k; g.fillRect(rx, ry, rw, rh);
  };
  edge(0, PY, 0, PY + 26, PX, PY, PW, 26); edge(0, PY + PH, 0, PY + PH - 26, PX, PY + PH - 26, PW, 26);
  edge(PX, 0, PX + 26, 0, PX, PY, 26, PH); edge(PX + PW, 0, PX + PW - 26, 0, PX + PW - 26, PY, 26, PH);
  g.restore();
  // head string + spots
  const headX = wx(-2.72);
  g.strokeStyle = 'rgba(255,255,255,.20)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(headX, PY + 6); g.lineTo(headX, PY + PH - 6); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.34)';
  for (const [x, y] of [[headX, OY], [wx(1.28), OY], [OX, OY]]) { g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill(); }
  const cr = seeded(5);
  for (let i = 0; i < 5; i += 1) {
    const x = PX + 120 + cr() * (PW - 240), y = PY + 40 + cr() * (PH - 80);
    const k = g.createRadialGradient(x, y, 0, x, y, 9 + cr() * 8); k.addColorStop(0, 'rgba(120,190,255,.10)'); k.addColorStop(1, 'rgba(120,190,255,0)');
    g.fillStyle = k; g.fillRect(x - 20, y - 20, 40, 40);
  }
  for (let i = 1; i < 8; i += 1) { const x = PX + PW * i / 8; if (i === 4) continue; pearl(g, x, PY - 45); pearl(g, x, PY + PH + 45); }
  for (let i = 1; i < 4; i += 1) { const y = PY + PH * i / 4; pearl(g, PX - 45, y); pearl(g, PX + PW + 45, y); }
  // pockets: leather-lined with brass plates
  for (const p of HOLES) {
    // ambient shadow cast by the jaws onto the felt around the mouth
    const sh = g.createRadialGradient(p.x, p.y, p.r * 0.6, p.x, p.y, p.r + 30);
    sh.addColorStop(0, 'rgba(0,0,0,.65)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); g.beginPath(); g.rect(PX - 30, PY - 30, PW + 60, PH + 60); g.clip(); g.fillStyle = sh; g.beginPath(); g.arc(p.x, p.y, p.r + 30, 0, 7); g.fill(); g.restore();
    const brs = g.createRadialGradient(p.x - 6, p.y - 6, 4, p.x, p.y, p.r + 17);
    brs.addColorStop(0, '#cdb272'); brs.addColorStop(0.55, '#7d5f2c'); brs.addColorStop(1, '#3a2a10');
    g.fillStyle = brs; g.beginPath(); g.arc(p.x, p.y, p.r + 9, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, p.r + 9, 0, 7); g.stroke();
    const lg = g.createRadialGradient(p.x, p.y, p.r - 8, p.x, p.y, p.r + 6);
    lg.addColorStop(0, '#000'); lg.addColorStop(0.55, '#1a0f08'); lg.addColorStop(1, '#2b1a0e');
    g.fillStyle = lg; g.beginPath(); g.arc(p.x, p.y, p.r + 5, 0, 7); g.fill();
    const hg = g.createRadialGradient(p.x, p.y + 3, 2, p.x, p.y, p.r);
    hg.addColorStop(0, '#000'); hg.addColorStop(0.8, '#020202'); hg.addColorStop(1, '#0d0907');
    g.fillStyle = hg; g.beginPath(); g.arc(p.x, p.y, p.r - 1, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,235,200,.16)'; g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, p.r - 1, Math.PI * 0.15, Math.PI * 0.85); g.stroke();
    g.strokeStyle = 'rgba(255,244,214,.55)'; g.lineWidth = 1.6; g.beginPath(); g.arc(p.x, p.y, p.r + 8, Math.PI * 1.1, Math.PI * 1.55); g.stroke();
  }
  const vg = g.createRadialGradient(VX0 + VW / 2, VY0 + VH / 2, VH * 0.45, VX0 + VW / 2, VY0 + VH / 2, VW * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.30)');
  g.fillStyle = vg; g.fillRect(VX0, VY0, VW, VH);
}

/* ------------------------------------------------------------------ the game */
export function mountCinematicPool(): void {
const cleanups: Array<() => void> = [];
let disposed = false;
let rafId = 0;
function listen(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener(type, handler, options));
}
const W = window as any;
W.__POOL_ERRORS__ = [];
listen(window, 'error', ((event: ErrorEvent) => { W.__POOL_ERRORS__.push(event.message); }) as EventListener);
listen(window, 'unhandledrejection', ((event: PromiseRejectionEvent) => { W.__POOL_ERRORS__.push(String(event.reason)); }) as EventListener);

const app = document.querySelector<HTMLDivElement>('#pool-host');
if (!app) throw new Error('Missing #pool-host root');

const audio = new PoolAudio();
let paused = false;
let guideFull = true;
let qualitySetting: 'auto' | 'high' | 'low' = 'auto';
try {
  const q = window.localStorage.getItem('squadbet.pool.quality');
  if (q === 'high' || q === 'low' || q === 'auto') qualitySetting = q;
  guideFull = window.localStorage.getItem('squadbet.pool.guide.v2') !== 'line';
} catch { /* storage unavailable: defaults are fine */ }

// ---- state ----
const names = ['@Player1', '@Player2'];
const game = { turn: 0 as 0 | 1, groups: [null, null] as Array<'solid' | 'stripe' | null>, status: 'Rack is set. Player 1 breaks.', gameOver: false, winner: null as number | null, shotInProgress: false };
let snap: any = initialPoolState();
let ballInHand = false;
let placement: { x: number; z: number } | null = null;
const trayPocketed = new Set<number>();
let multiplayerMode = false;
let multiplayerLive = true;
let localPlayerIndex = 0;
let serverShotPending = false;
let aimAngle = 0;
let chargePower = 0.38;
let manualPowerTouched = false;
let charging = false;
let chargeDirection = 1;
const spin = { x: 0, y: 0 };
let fineDirection: -1 | 0 | 1 = 0;
let fineHeld = 0;
let lastHudKey = '';
let tracePlayback: { trace: PoolTrace; t: number; ev: number; final: any; start: any; settle: number } | null = null;
let cueAnim: { angle: number; spinX: number; spinY: number; t: number; plan: Array<{ dur: number; from: number; to: number }>; idx: number; done: () => void } | null = null;
let cuePull = 0;
const approvedQueue: Job[] = [];

const balls: Ball[] = [];
for (let id = 0; id <= 15; id += 1) {
  balls.push({ id, kind: kindOf(id), x: 0, z: 0, px: 0, py: 0, pocketed: false, M: rot(0, 0, 1, id === 0 ? 0.3 : (id * 0.9) % 6.28), spr: null, dirty: true, rdx: 0, rdy: 0, fall: null });
}
const ballById = (id: number): Ball | undefined => balls[id];
const cueBall = (): Ball => balls[0];
function setPos(b: Ball, x: number, z: number, roll = false): void {
  const npx = wx(x), npy = wz(z);
  if (roll) { b.rdx += npx - b.px; b.rdy += npy - b.py; b.dirty = true; }
  b.x = x; b.z = z; b.px = npx; b.py = npy;
}

// ---- HUD (avatars, 30 s ring, stake, pause text, power bar, spin, buttons): unchanged DOM + CSS ----
const hud = new PoolHud(app, {
  gesture: () => audio.unlock(),
  spin: (x, y) => { spin.x = x; spin.y = y; },
  fine: (direction) => { fineDirection = direction; fineHeld = 0; },
  power: (value, phase) => {
    if (phase === 'start') return;
    if (phase === 'move') {
      if (canShoot()) { manualPowerTouched = true; chargePower = clamp(value, 0.08, 1); }
      return;
    }
    if (phase === 'cancel') { manualPowerTouched = false; chargePower = 0.38; return; }
    // 'end': releasing near the top cancels, so grabbing the bar can never fire a shot by accident.
    if (value >= 0.06 && canShoot()) shoot(clamp(value, 0.08, 1));
    else { manualPowerTouched = false; chargePower = 0.38; }
  },
  button: (name) => {
    if (name === 'sound') { audio.setEnabled(!audio.isOn); hud.setSoundOn(audio.isOn); }
    else if (name === 'fullscreen') toggleFullscreen();
    else window.dispatchEvent(new CustomEvent('pool-ui', { detail: { action: name } }));
  },
});
hud.setSoundOn(audio.isOn);

const canvas = document.createElement('canvas');
canvas.setAttribute('aria-label', 'Pool table');
app.insertBefore(canvas, app.firstChild);
const ctx = canvas.getContext('2d')!;
let tableCanvas: HTMLCanvasElement | null = null;
let VX0 = 0, VY0 = 0, VW = 1000, VH = 560, k = 1, scale = 1, dpr = 1;

function dprCap(): number {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const cores = navigator.hardwareConcurrency || 4;
  const auto = cores <= 2 ? 'low' : coarse || window.innerWidth < 900 || cores <= 4 ? 'balanced' : 'high';
  const level = qualitySetting === 'auto' ? auto : qualitySetting;
  return level === 'high' ? 3 : level === 'balanced' ? 2.2 : 1.25;
}

/** The table fills the whole screen: felt + rail are scaled to the free area between the HUD panels, and the wood runs to the screen edges. */
function fit(): void {
  const Wd = app!.clientWidth || window.innerWidth, Ht = app!.clientHeight || window.innerHeight;
  let ins = { top: 0, left: 0, right: 0, bottom: 8 };
  try { ins = hud.getInsets(); } catch { /* HUD not laid out yet */ }
  const availW = Math.max(120, Wd - ins.left - ins.right), availH = Math.max(120, Ht - ins.top - ins.bottom);
  const RAIL = 36;
  k = Math.min(availW / (PW + 2 * RAIL), availH / (PH + 2 * RAIL));
  VW = Wd / k; VH = Ht / k;
  const cx = ins.left + availW / 2, cy = ins.top + availH / 2;
  VX0 = OX - cx / k; VY0 = OY - cy / k;
  dpr = Math.min(window.devicePixelRatio || 1, dprCap());
  canvas.width = Math.max(2, Math.round(Wd * dpr)); canvas.height = Math.max(2, Math.round(Ht * dpr));
  scale = k * dpr;
  tableCanvas = document.createElement('canvas');
  tableCanvas.width = canvas.width; tableCanvas.height = canvas.height;
  paintTable(tableCanvas, scale, VX0, VY0, VW, VH);
  balls.forEach((b) => { b.spr = null; b.dirty = true; });
  draw();
}
const onResize = (): void => { if (!disposed) fit(); };
listen(window, 'resize', onResize as EventListener);
listen(window, 'orientationchange', (() => window.setTimeout(onResize, 250)) as EventListener);
const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
resizeObserver?.observe(app);
cleanups.push(() => resizeObserver?.disconnect());

/* ------------------------------------------------------------------ audio / banner shortcuts */
const showBanner = (message: string, tone: 'info' | 'good' | 'bad' | 'turn' = 'info'): void => hud.showBanner(message, tone, 1500);

/* ------------------------------------------------------------------ rules gate (same conditions as the 3D table) */
function areBallsMoving(): boolean { return balls.some((b) => b.fall !== null); }
function canShoot(): boolean {
  return !paused && !tracePlayback && !cueAnim && !game.gameOver && !game.shotInProgress && !areBallsMoving() && !cueBall().pocketed
    && !serverShotPending && (!multiplayerMode || (multiplayerLive && game.turn === localPlayerIndex));
}

/* ------------------------------------------------------------------ state in / out */
function getPublicState(): unknown {
  const cue = cueBall();
  return {
    title: document.title,
    status: game.status,
    currentPlayer: game.turn,
    gameOver: game.gameOver,
    winnerPlayer: game.gameOver ? game.winner : null,
    shotInProgress: game.shotInProgress,
    canShoot: canShoot(),
    groups: game.groups.slice(),
    aimAngle,
    power: chargePower,
    moving: Boolean(tracePlayback) || Boolean(cueAnim) || areBallsMoving(),
    errors: (W.__POOL_ERRORS__ as string[]).slice(),
    cue: { x: Number(cue.x.toFixed(3)), z: Number(cue.z.toFixed(3)), vx: 0, vz: 0, pocketed: cue.pocketed },
    balls: balls.map((b) => ({ id: b.id, kind: b.kind, x: Number(b.x.toFixed(3)), z: Number(b.z.toFixed(3)), vx: 0, vz: 0, pocketed: b.pocketed })),
  };
}

function applyState(snapshot: any): unknown {
  if (!snapshot || !Array.isArray(snapshot.balls)) return getPublicState();
  serverShotPending = false;
  snap = snapshot;
  for (const remote of snapshot.balls) {
    const b = ballById(Number(remote.id));
    if (!b) continue;
    setPos(b, Number(remote.x) || 0, Number(remote.z) || 0);
    b.pocketed = Boolean(remote.pocketed);
    b.fall = null;
  }
  if (Array.isArray(snapshot.groups) && snapshot.groups.length >= 2) { game.groups[0] = snapshot.groups[0] ?? null; game.groups[1] = snapshot.groups[1] ?? null; }
  game.turn = Number(snapshot.currentPlayer) === 1 ? 1 : 0;
  ballInHand = Boolean(snapshot.ballInHand);
  placement = null;
  trayPocketed.clear();
  for (const remote of snapshot.balls) if (Number(remote.id) !== 0 && remote.pocketed) trayPocketed.add(Number(remote.id));
  game.gameOver = Boolean(snapshot.gameOver);
  game.winner = snapshot.winnerPlayer === 0 || snapshot.winnerPlayer === 1 ? Number(snapshot.winnerPlayer) : null;
  game.status = typeof snapshot.status === 'string' ? snapshot.status : game.status;
  game.shotInProgress = Boolean(snapshot.shotInProgress);
  lastHudKey = '';
  updateHUD();
  return getPublicState();
}

function hudKey(): string {
  return [
    game.turn, game.gameOver ? 1 : 0, multiplayerLive ? 1 : 0, localPlayerIndex, canShoot() ? 1 : 0, game.status,
    game.groups[0], game.groups[1], [...trayPocketed].sort().join(','), ballInHand ? 1 : 0,
    serverShotPending ? 1 : 0, tracePlayback ? 1 : 0,
    Math.round(((charging || hud.isPowerDragging || manualPowerTouched) ? chargePower : 0) * 100),
  ].join('|');
}

function updateHUD(): void {
  const key = hudKey();
  if (key === lastHudKey) return;
  lastHudKey = key;
  const canNow = canShoot();
  const live = !multiplayerMode || multiplayerLive;
  hud.setPower((charging || hud.isPowerDragging || manualPowerTouched) ? chargePower : 0);
  hud.setTurn(game.turn === 1 ? 1 : 0, localPlayerIndex === 1 ? 1 : 0, live, game.gameOver);
  hud.setGroups([game.groups[0], game.groups[1]]);
  hud.setTrays([game.groups[0], game.groups[1]], trayPocketed);
  hud.setInteractive(canNow);
  hud.setHint(canNow && ballInHand ? 'Ball in hand — drag the cue ball to place it, then shoot' : null);
  let status = game.status;
  if (multiplayerMode && !multiplayerLive) status = 'Waiting for both players to be ready';
  else if (tracePlayback || approvedQueue.length) status = 'Shot in progress…';
  else if (multiplayerMode && !game.gameOver && game.turn === localPlayerIndex && !serverShotPending) status = ballInHand ? 'Your turn · ball in hand' : 'Your turn · aim, then pull the power bar down';
  hud.setStatus(status);
}

/* ------------------------------------------------------------------ aiming and shooting */
function setAimTo(x: number, z: number): void {
  if (!canShoot()) return;
  const cue = cueBall();
  const dx = x - cue.x, dz = z - cue.z;
  if (dx * dx + dz * dz < 0.0001) return;
  aimAngle = Math.atan2(dz, dx);
}
const rotateAim = (delta: number): void => { aimAngle += delta; };
const pullFor = (power: number): number => 6 + power * 80;

function runCueAnimation(angle: number, spinX: number, spinY: number, plan: Array<{ dur: number; from: number; to: number }>, done: () => void): void {
  cueAnim = { angle, spinX, spinY, t: 0, plan, idx: 0, done };
  cuePull = plan[0].from;
}
function stepCueAnimation(dt: number): void {
  if (!cueAnim) return;
  const a = cueAnim;
  const seg = a.plan[a.idx];
  a.t += dt;
  const f = Math.min(1, a.t / Math.max(1e-6, seg.dur));
  cuePull = seg.from + (seg.to - seg.from) * f;
  if (f >= 1) {
    a.idx += 1; a.t = 0;
    if (a.idx >= a.plan.length) { const done = a.done; cueAnim = null; cuePull = 0; done(); }
    else cuePull = a.plan[a.idx].from;
  }
}

function placementIsLegal(): boolean {
  if (!placement) return true;
  return isLegalPlacement(balls.map((b) => ({ id: b.id, x: b.x, z: b.z, pocketed: b.pocketed })), placement.x, placement.z);
}

function submitPocketPlacementFoul(): void {
  if (!multiplayerMode || !ballInHand || !placement || !canShoot()) return;
  const hole = AUTH_POCKETS.find((p) => Math.hypot(placement!.x - p.x, placement!.z - p.z) <= p.radius);
  if (!hole) return;
  const cuePlacement = { x: hole.x, z: hole.z };
  placement = { x: hole.x, z: hole.z };
  serverShotPending = true;
  game.status = 'Submitting shot to SquadBet server…';
  showBanner('Cue ball in a pocket — foul', 'bad');
  window.dispatchEvent(new CustomEvent('pool-shot-requested', { detail: { power: 0.08, angleRadians: 0, spinX: 0, spinY: 0, cuePlacement } }));
  updateHUD();
}

function shoot(power: number): void {
  if (!canShoot()) return;
  const clamped = clamp(power, 0.08, 1);
  const angle = aimAngle;
  let cuePlacement: { x: number; z: number } | null = null;
  if (ballInHand && placement) {
    if (!placementIsLegal()) { showBanner("Can't place the cue ball there", 'bad'); return; }
    cuePlacement = { x: Math.round(placement.x * 10000) / 10000, z: Math.round(placement.z * 10000) / 10000 };
  }
  const shotSpin = { x: spin.x, y: spin.y };
  manualPowerTouched = false;
  const startPull = pullFor(clamped);
  chargePower = 0.38;
  if (multiplayerMode) {
    serverShotPending = true;
    game.status = 'Submitting shot to SquadBet server…';
    audio.cue(clamped);
    // The cue strikes, THEN the request goes to the server. The server alone decides the outcome.
    runCueAnimation(angle, shotSpin.x, shotSpin.y, [{ dur: 0.09, from: startPull, to: 0 }], () => {
      window.dispatchEvent(new CustomEvent('pool-shot-requested', { detail: { power: clamped, angleRadians: angle, spinX: shotSpin.x, spinY: shotSpin.y, cuePlacement } }));
    });
    updateHUD();
    return;
  }
  // Practice (local) game: the SAME authoritative module computes the result, then it is replayed.
  let out: { state: any; trace: PoolTrace | null };
  try {
    out = simulateShotTrace(snap, clamped, angle, { spinX: shotSpin.x, spinY: shotSpin.y, cuePlacement, trace: true });
  } catch (error) {
    showBanner('Shot could not be played', 'bad');
    W.__POOL_ERRORS__.push(String((error as Error)?.message ?? error));
    return;
  }
  const start = snap;
  game.status = `${names[game.turn]} shoots.`;
  runCueAnimation(angle, shotSpin.x, shotSpin.y, [{ dur: 0.09, from: startPull, to: 0 }], () => {
    audio.cue(clamped);
    if (out.trace) beginPlayback(out.trace, start, out.state);
    else finishApprovedShot(out.state, start);
  });
  updateHUD();
}

/* ------------------------------------------------------------------ server-approved shot playback */
function beginPlayback(trace: PoolTrace, start: any, final: any): void {
  game.shotInProgress = true;
  tracePlayback = { trace, t: 0, ev: 0, final, start, settle: 0 };
  const first = trace.frames[0];
  trace.ids.forEach((id, i) => { const b = ballById(id); if (b) setPos(b, first[i * 3], first[i * 3 + 1]); });
}

function startApprovedShot(job: Job): void {
  applyState(job.start);
  let trace: PoolTrace | null = null;
  try {
    const out = simulateShotTrace(job.start, job.power, job.angle, {
      spinX: job.extra?.spinX ?? 0, spinY: job.extra?.spinY ?? 0, cuePlacement: job.extra?.cuePlacement ?? null, trace: true,
    });
    trace = out.trace;
    // If this device's replay disagrees with the server about WHICH balls went down, show the authoritative result directly.
    const agrees = out.state.balls.every((b: any) => {
      const f = job.final.balls.find((q: any) => Number(q.id) === b.id);
      return !!f && Boolean(f.pocketed) === b.pocketed;
    });
    if (!agrees) trace = null;
  } catch { trace = null; }
  if (!trace) { finishApprovedShot(job.final, job.start); return; }
  const tr = trace;
  const begin = (): void => beginPlayback(tr, job.start, job.final);
  if (job.local) { begin(); return; }
  // Opponent's shot: show their cue draw back and strike before the balls move.
  if (job.extra?.cuePlacement) setPos(cueBall(), job.extra.cuePlacement.x, job.extra.cuePlacement.z);
  aimAngle = job.angle;
  const pull = pullFor(job.power);
  runCueAnimation(job.angle, job.extra?.spinX ?? 0, job.extra?.spinY ?? 0, [{ dur: 0.5, from: 6, to: pull }, { dur: 0.09, from: pull, to: 0 }], () => {
    audio.cue(job.power);
    begin();
  });
}

function startFall(b: Ball, pocketIndex: number): void {
  const h = HOLES[pocketIndex] ?? HOLES[0];
  b.pocketed = true;
  b.fall = { t: 0, sx: b.px, sy: b.py, tx: h.x, ty: h.y };
  audio.pocket();
  if (b.id !== 0) trayPocketed.add(b.id);
}

function stepFalls(dt: number): void {
  for (const b of balls) {
    if (!b.fall) continue;
    b.fall.t += dt;
    const f = Math.min(1, b.fall.t / 0.22);
    b.px = b.fall.sx + (b.fall.tx - b.fall.sx) * f;
    b.py = b.fall.sy + (b.fall.ty - b.fall.sy) * f;
    if (b.fall.t > 0.28) b.fall = null;
  }
}

function advanceTrace(dt: number): void {
  const pb = tracePlayback!;
  pb.t += dt;
  const frames = pb.trace.frames;
  const fi = pb.t * pb.trace.hz;
  const i0 = Math.min(frames.length - 1, Math.floor(fi));
  const i1 = Math.min(frames.length - 1, i0 + 1);
  const a = fi - Math.floor(fi);
  for (let i = 0; i < pb.trace.ids.length; i += 1) {
    const b = ballById(pb.trace.ids[i]);
    if (!b || b.pocketed) continue;
    const f0 = frames[i0], f1 = frames[i1];
    if (f0[i * 3 + 2] === 1) continue;
    const toPocket = f1[i * 3 + 2] === 1;
    setPos(b, f0[i * 3] + (f1[i * 3] - f0[i * 3]) * (toPocket ? 0 : a), f0[i * 3 + 1] + (f1[i * 3 + 1] - f0[i * 3 + 1]) * (toPocket ? 0 : a), true);
  }
  let clicks = 0;
  const events = pb.trace.events;
  while (pb.ev < events.length && events[pb.ev].f <= i0) {
    const e: any = events[pb.ev++];
    if (e.k === 'b') { if (clicks++ < 3) audio.ball(e.v); }
    else if (e.k === 'c') audio.cushion(e.v);
    else if (e.k === 'p') { const b = ballById(e.id); if (b && !b.pocketed) startFall(b, e.pocket); }
  }
  if (i0 >= frames.length - 1) {
    pb.settle += dt;
    if (pb.settle > 0.35) finishApprovedShot(pb.final, pb.start);
  }
  if (pb.t > 25) finishApprovedShot(pb.final, pb.start);
}

function finishApprovedShot(final: any, start: any): void {
  tracePlayback = null;
  game.shotInProgress = false;
  applyState(final);
  announceOutcome(start, final);
  window.dispatchEvent(new CustomEvent('pool-shot-settled', { detail: getPublicState() }));
  const next = approvedQueue.shift();
  if (next) startApprovedShot(next);
}

function announceOutcome(start: any, final: any): void {
  const last = final?.lastShot;
  if (final?.gameOver) {
    const iWon = Number(final.winnerPlayer) === localPlayerIndex;
    showBanner(iWon ? 'You win!' : 'Match over', iWon ? 'good' : 'bad');
    if (iWon) audio.win(); else audio.lose();
    return;
  }
  let delay = 0;
  if (last?.foul) {
    showBanner(`Foul · ${(last.reasons ?? []).join(', ')}`, 'bad');
    audio.foul();
    delay = 1600;
  } else if (last && Array.isArray(last.pocketedIds) && last.pocketedIds.length) {
    showBanner(last.pocketedIds.length === 1 ? `Ball ${last.pocketedIds[0]} down` : `${last.pocketedIds.length} balls down`, 'good');
    delay = 1400;
  }
  if (!start || Number(start.currentPlayer) !== Number(final.currentPlayer)) {
    const mine = Number(final.currentPlayer) === localPlayerIndex;
    window.setTimeout(() => {
      if (disposed) return;
      showBanner(mine ? (final.ballInHand ? 'Your turn · ball in hand' : 'Your turn') : 'Opponent’s turn', 'turn');
      audio.turn();
    }, delay);
  }
}

/** Jump straight to the server's authoritative result for any shot animation still in progress. */
function fastForwardPlayback(): void {
  let guard = 0;
  while ((cueAnim || tracePlayback || approvedQueue.length) && guard < 8) {
    guard += 1;
    if (cueAnim) { const done = cueAnim.done; cueAnim = null; cuePull = 0; done(); }
    if (tracePlayback) finishApprovedShot(tracePlayback.final, tracePlayback.start);
    else if (approvedQueue.length) startApprovedShot(approvedQueue.shift()!);
  }
  lastHudKey = '';
  updateHUD();
}

// Safety net: no single multiplayer wait state may last forever (identical to the 3D table's watchdog).
let pendingElapsed = 0;
let animElapsed = 0;
function watchdog(dt: number): void {
  if (serverShotPending) {
    pendingElapsed += dt;
    if (pendingElapsed > 20) {
      pendingElapsed = 0;
      serverShotPending = false;
      cueAnim = null; cuePull = 0;
      lastHudKey = '';
      showBanner('Re-syncing table…', 'info');
      window.dispatchEvent(new CustomEvent('pool-resync-needed'));
    }
  } else pendingElapsed = 0;
  if (tracePlayback || cueAnim || approvedQueue.length) {
    animElapsed += dt;
    if (animElapsed > 45) { animElapsed = 0; fastForwardPlayback(); }
  } else animElapsed = 0;
}

function resetMatch(): void {
  tracePlayback = null; cueAnim = null; cuePull = 0; approvedQueue.length = 0;
  chargePower = 0.44; charging = false;
  applyState(initialPoolState());
  aimAngle = 0; // cue ball on the left, rack on the right
  game.status = 'Rack is set. Player 1 breaks.';
  showBanner('Fresh rack');
  updateHUD();
}

/* ------------------------------------------------------------------ drawing */
function draw(): void {
  if (!tableCanvas) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tableCanvas, 0, 0);
  ctx.setTransform(scale, 0, 0, scale, -VX0 * scale, -VY0 * scale);
  const sizePx = Math.max(16, Math.ceil(2 * R * scale) + 2);
  // shadows: a soft cast shadow stretched away from the lamp and a tight dark contact shadow under each ball
  for (const b of balls) {
    if (b.pocketed && !b.fall) continue;
    const f = b.fall ? Math.max(0, 1 - b.fall.t / 0.28) : 1;
    ctx.save(); ctx.translate(b.px + R * 0.39, b.py + R * 0.54); ctx.rotate(0.62); ctx.scale(1.38, 0.95);
    const cg = ctx.createRadialGradient(0, 0, R * 0.25, 0, 0, R * 1.25);
    cg.addColorStop(0, `rgba(0,12,4,${0.46 * f})`); cg.addColorStop(0.55, `rgba(0,12,4,${0.22 * f})`); cg.addColorStop(1, 'rgba(0,12,4,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, R * 1.25, 0, 7); ctx.fill(); ctx.restore();
    const ox = b.px + R * 0.09, oy = b.py + R * 0.16;
    const og = ctx.createRadialGradient(ox, oy, R * 0.55, ox, oy, R * 1.08);
    og.addColorStop(0, `rgba(0,8,2,${0.78 * f})`); og.addColorStop(0.7, `rgba(0,8,2,${0.38 * f})`); og.addColorStop(1, 'rgba(0,8,2,0)');
    ctx.fillStyle = og; ctx.beginPath(); ctx.arc(ox, oy, R * 1.08, 0, 7); ctx.fill();
  }
  const cb = cueBall();
  const canAim = canShoot() && !cb.pocketed;
  if (canAim) drawAim(cb);
  for (const b of balls) {
    if (b.pocketed && !b.fall) continue;
    if (b.rdx || b.rdy) {
      const dist = Math.hypot(b.rdx, b.rdy);
      if (dist > 1e-4) b.M = mul(rot(b.rdy / dist, b.rdx / dist, 0, dist / R), b.M);
      b.rdx = b.rdy = 0;
    }
    if (b.dirty || !b.spr || b.spr.width !== sizePx) renderBall(b, sizePx);
    const sc = b.fall ? Math.max(0.35, 1 - b.fall.t / 0.4) : 1;
    const s = (2 * R + 2 / scale) * sc;
    ctx.globalAlpha = b.fall ? Math.max(0, 1 - b.fall.t / 0.3) : 1;
    ctx.drawImage(b.spr!, b.px - s / 2, b.py - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  if (canAim || (cueAnim && !cb.pocketed)) drawCue(cb);
  if (canAim && ballInHand) drawPlacementRing(cb);
}

/** Plain, straight, solid white guide: cue ball -> contact, ghost ball, object-ball line, cue-ball line after contact. */
function drawAim(cb: Ball): void {
  const list = balls.map((b) => ({ id: b.id, x: b.x, z: b.z, pocketed: b.pocketed }));
  const pred = predictShot(list, { x: cb.x, z: cb.z }, aimAngle, spin);
  const end = pred.cueEnd;
  if (!end) return;
  const ux = Math.cos(aimAngle), uz = Math.sin(aimAngle);
  ctx.save();
  ctx.lineCap = 'round'; ctx.setLineDash([]);
  ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.95; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(cb.px + ux * R, cb.py + uz * R); ctx.lineTo(wx(end.x), wz(end.z)); ctx.stroke();
  if (pred.contact) {
    ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(wx(pred.contact.ghost.x), wz(pred.contact.ghost.z), R, 0, 7); ctx.stroke();
    if (guideFull && pred.objectLine) {
      const o = pred.objectLine;
      ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(wx(o.from.x) + o.dir.x * R, wz(o.from.z) + o.dir.z * R);
      const len = Math.min(Math.hypot(o.to.x - o.from.x, o.to.z - o.from.z), 1.3);
      ctx.lineTo(wx(o.from.x + o.dir.x * len), wz(o.from.z + o.dir.z * len)); ctx.stroke();
      if (pred.cueAfter) {
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(wx(pred.cueAfter.from.x), wz(pred.cueAfter.from.z));
        ctx.lineTo(wx(pred.cueAfter.to.x), wz(pred.cueAfter.to.z)); ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Plain tapered stick in a single wood tone. */
function drawCue(cb: Ball): void {
  const animating = cueAnim !== null;
  const ang = (animating ? cueAnim!.angle : aimAngle) + Math.PI;
  const sx0 = animating ? cueAnim!.spinX : spin.x;
  const pullAmt = animating ? cuePull : ((charging || hud.isPowerDragging || manualPowerTouched) ? pullFor(chargePower) : 6);
  const dist = R + 3 + pullAmt;
  const ux = Math.cos(ang), uy = Math.sin(ang), pxn = -uy, pyn = ux;
  const side = sx0 * R * 0.5;
  const sx = cb.px + ux * dist + pxn * side, sy = cb.py + uy * dist + pyn * side;
  const len = 300;
  const hw = (t: number): number => 2.3 + (5.6 - 2.3) * (t / len);           // half-width: slim at the tip, thicker toward the butt
  const at = (t: number, w: number): number[] => [sx + ux * t + pxn * w, sy + uy * t + pyn * w];
  const poly = (t0: number, t1: number): void => { ctx.beginPath(); let q = at(t0, hw(t0)); ctx.moveTo(q[0], q[1]); q = at(t1, hw(t1)); ctx.lineTo(q[0], q[1]); q = at(t1, -hw(t1)); ctx.lineTo(q[0], q[1]); q = at(t0, -hw(t0)); ctx.lineTo(q[0], q[1]); ctx.closePath(); };
  ctx.save();
  // soft shadow on the cloth
  ctx.fillStyle = 'rgba(0,0,0,.26)'; ctx.beginPath();
  let q = at(0, 2.4); ctx.moveTo(q[0] + 4, q[1] + 7); q = at(len, 6); ctx.lineTo(q[0] + 4, q[1] + 7); q = at(len, -6); ctx.lineTo(q[0] + 4, q[1] + 7); q = at(0, -2.4); ctx.lineTo(q[0] + 4, q[1] + 7); ctx.closePath(); ctx.fill();
  const across = (c0: string, c1: string, c2: string, c3: string): CanvasGradient => {
    const gr = ctx.createLinearGradient(sx + pxn * 5.6, sy + pyn * 5.6, sx - pxn * 5.6, sy - pyn * 5.6);
    gr.addColorStop(0, c0); gr.addColorStop(0.30, c1); gr.addColorStop(0.55, c2); gr.addColorStop(1, c3); return gr;
  };
  const JOIN = 105;
  poly(4, JOIN); ctx.fillStyle = across('#a8733f', '#f2d29c', '#d9ae72', '#8d5d30'); ctx.fill();            // light maple shaft
  poly(JOIN, len - 4); ctx.fillStyle = across('#2a150a', '#6e4124', '#4a2813', '#1d0e06'); ctx.fill();       // dark butt
  // one thin gold joint ring
  poly(JOIN - 1.5, JOIN + 1.5); ctx.fillStyle = across('#7a5a1c', '#f0d27a', '#c9a24a', '#6b4d16'); ctx.fill();
  // rubber end cap
  poly(len - 4, len); ctx.fillStyle = '#120a05'; ctx.fill();
  // blue chalked tip with a rounded end
  poly(0, 4); ctx.fillStyle = across('#1f4f94', '#4d8fe0', '#2f6fb5', '#173c70'); ctx.fill();
  q = at(0, 0); ctx.fillStyle = '#2f6fb5'; ctx.beginPath(); ctx.arc(q[0] + ux * 0.4, q[1] + uy * 0.4, hw(0), 0, 7); ctx.fill();
  // fine highlight line along the lit side
  ctx.strokeStyle = 'rgba(255,245,225,.30)'; ctx.lineWidth = 0.9; ctx.beginPath();
  q = at(6, hw(6) * 0.45); ctx.moveTo(q[0], q[1]); q = at(len - 8, hw(len) * 0.45); ctx.lineTo(q[0], q[1]); ctx.stroke();
  ctx.restore();
}

function drawPlacementRing(cb: Ball): void {
  ctx.save();
  ctx.strokeStyle = placementIsLegal() ? 'rgba(62,224,143,.95)' : 'rgba(248,113,113,.95)'; ctx.lineWidth = 2.2; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.arc(cb.px, cb.py, R + 6, 0, 7); ctx.stroke(); ctx.restore();
}

/* ------------------------------------------------------------------ input */
function pointerWorld(event: PointerEvent): { x: number; z: number } {
  const rect = canvas.getBoundingClientRect();
  const pxn = VX0 + ((event.clientX - rect.left) / rect.width) * VW;
  const pyn = VY0 + ((event.clientY - rect.top) / rect.height) * VH;
  return { x: (pxn - OX) / S, z: (pyn - OY) / S };
}
let placingPointer = -1;
let aimPointer = -1;
listen(canvas, 'pointerdown', ((event: PointerEvent) => {
  audio.unlock();
  const p = pointerWorld(event);
  const cue = cueBall();
  if (ballInHand && canShoot() && Math.hypot(p.x - cue.x, p.z - cue.z) < R_W * 2.8) {
    placingPointer = event.pointerId;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    return;
  }
  aimPointer = event.pointerId;
  try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
  setAimTo(p.x, p.z);
}) as EventListener);
listen(canvas, 'pointermove', ((event: PointerEvent) => {
  const p = pointerWorld(event);
  if (placingPointer === event.pointerId) {
    const x = clamp(p.x, -AUTH.halfW + R_W * 1.6, AUTH.halfW - R_W * 1.6), z = clamp(p.z, -AUTH.halfD + R_W * 1.6, AUTH.halfD - R_W * 1.6);
    placement = { x, z };
    setPos(cueBall(), x, z);
    return;
  }
  if (aimPointer === event.pointerId || event.pointerType === 'mouse') setAimTo(p.x, p.z);
}) as EventListener);
const endPointer = ((event: PointerEvent) => {
  if (placingPointer === event.pointerId) {
    placingPointer = -1;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    submitPocketPlacementFoul();
    return;
  }
  if (aimPointer === event.pointerId) aimPointer = -1;
}) as EventListener;
listen(window, 'pointerup', endPointer);
listen(window, 'pointercancel', endPointer);

function beginCharge(): void { if (!canShoot()) return; charging = true; chargeDirection = 1; if (!manualPowerTouched) chargePower = 0.12; }
function endCharge(): void { if (!charging) return; charging = false; shoot(chargePower); }

listen(window, 'keydown', ((event: KeyboardEvent) => {
  if (paused) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  audio.unlock();
  if (event.repeat && event.code === 'Space') return;
  const fine = event.shiftKey ? 0.25 : 1;
  if (event.code === 'Space') { event.preventDefault(); beginCharge(); }
  else if (event.code === 'ArrowLeft' || event.code === 'KeyA') rotateAim(-0.055 * fine);
  else if (event.code === 'ArrowRight' || event.code === 'KeyD') rotateAim(0.055 * fine);
  else if (event.code === 'ArrowUp' || event.code === 'KeyW') { manualPowerTouched = true; chargePower = clamp(chargePower + 0.05, 0.08, 1); }
  else if (event.code === 'ArrowDown' || event.code === 'KeyS') { manualPowerTouched = true; chargePower = clamp(chargePower - 0.05, 0.08, 1); }
  else if (event.code === 'KeyR' && !multiplayerMode) resetMatch();
}) as EventListener);
listen(window, 'keyup', ((event: KeyboardEvent) => { if (event.code === 'Space') { event.preventDefault(); endCharge(); } }) as EventListener);

/* ------------------------------------------------------------------ fullscreen / immersive (same behaviour as before) */
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
let immersive = false;
const fullscreenActive = (): boolean => { const d = document as FsDoc; return Boolean(d.fullscreenElement || d.webkitFullscreenElement) || immersive; };
function setImmersive(on: boolean): void {
  immersive = on;
  (app!.closest('.pool-game-shell') as HTMLElement | null)?.classList.toggle('pg-immersive', on);
  hud.setFullscreenOn(fullscreenActive());
  onResize();
}
function toggleFullscreen(): void {
  const d = document as FsDoc;
  const shell = (app!.closest('.pool-game-shell') as FsEl | null) ?? (document.documentElement as FsEl);
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) { if (d.exitFullscreen) void d.exitFullscreen(); else d.webkitExitFullscreen?.(); return; }
    if (immersive) { setImmersive(false); return; }
    const request = shell.requestFullscreen ? () => shell.requestFullscreen() : shell.webkitRequestFullscreen ? () => shell.webkitRequestFullscreen!() : null;
    if (!request) { setImmersive(true); window.scrollTo(0, 1); showBanner('Full screen: Share → Add to Home Screen', 'info'); return; }
    Promise.resolve(request()).then(() => {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return orientation?.lock?.('landscape');
    }).catch(() => { if (!fullscreenActive()) setImmersive(true); });
  } catch { setImmersive(true); }
}
const onFullscreenChange = (() => {
  if (!(document.fullscreenElement || (document as FsDoc).webkitFullscreenElement)) immersive = false;
  (app!.closest('.pool-game-shell') as HTMLElement | null)?.classList.toggle('pg-immersive', immersive);
  hud.setFullscreenOn(fullscreenActive());
  onResize();
}) as EventListener;
listen(document, 'fullscreenchange', onFullscreenChange);
listen(document, 'webkitfullscreenchange', onFullscreenChange);

/* ------------------------------------------------------------------ main loop */
let lastTime = performance.now();
function update(dt: number): void {
  if (fineDirection !== 0 && canShoot()) {
    fineHeld += dt;
    rotateAim(fineDirection * (0.18 + Math.min(1, fineHeld) * 0.7) * dt);
  }
  if (charging && canShoot()) {
    chargePower += chargeDirection * dt * 0.86;
    if (chargePower >= 1) { chargePower = 1; chargeDirection = -1; } else if (chargePower <= 0.08) { chargePower = 0.08; chargeDirection = 1; }
  }
  stepCueAnimation(dt);
  stepFalls(dt);
  watchdog(dt);
  if (tracePlayback) advanceTrace(dt);
  updateHUD();
}
let loopErrors = 0;
function animate(now: number): void {
  if (disposed) return;
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  try { update(dt); loopErrors = 0; } catch (error) {
    loopErrors += 1;
    try { W.__POOL_ERRORS__.push(String((error as Error)?.message ?? error)); } catch { /* ignore */ }
    if (loopErrors >= 3) { loopErrors = 0; try { fastForwardPlayback(); } catch { /* ignore */ } }
  }
  try { draw(); } catch { /* a failed frame is skipped, not fatal */ }
  rafId = requestAnimationFrame(animate);
}
listen(document, 'visibilitychange', (() => {
  if (document.hidden) return;
  lastTime = performance.now();
  if (tracePlayback || cueAnim || approvedQueue.length) fastForwardPlayback();
  if (multiplayerMode) window.dispatchEvent(new CustomEvent('pool-resync-needed'));
}) as EventListener);

/* ------------------------------------------------------------------ public API (identical surface to the 3D table) */
const api = {
  getState: getPublicState,
  aimAt: (x: number, z: number) => { setAimTo(x, z); return getPublicState(); },
  setAimAngle: (angleRadians: number) => { aimAngle = angleRadians; return getPublicState(); },
  setPower: (value: number) => { manualPowerTouched = true; chargePower = clamp(value, 0.08, 1); return getPublicState(); },
  shoot: (power = chargePower, angleRadians?: number) => { if (typeof angleRadians === 'number') aimAngle = angleRadians; shoot(power); return getPublicState(); },
  step: (frames = 60, dt = 1 / 60) => { for (let i = 0; i < frames; i += 1) update(dt); return getPublicState(); },
  reset: () => { resetMatch(); return getPublicState(); },
  setMultiplayerMode: (enabled: boolean, playerIndex = 0, live = true) => {
    const becameLive = enabled && live && !multiplayerLive;
    const modeChanged = enabled !== multiplayerMode || playerIndex !== localPlayerIndex;
    multiplayerMode = enabled;
    multiplayerLive = live;
    localPlayerIndex = playerIndex === 1 ? 1 : 0;
    // The page calls this on every `matches` row update. Only a real change may clear a shot that is still
    // waiting for the server (otherwise the same shot could be submitted twice).
    if (becameLive || modeChanged) serverShotPending = false;
    if (enabled && !live) game.status = 'Waiting for both players to be ready…';
    if (becameLive && game.turn === localPlayerIndex && !game.gameOver) showBanner(trayPocketed.size === 0 ? 'Break!' : 'Your turn', 'turn');
    lastHudKey = '';
    updateHUD();
  },
  setShotPending: (pending: boolean) => { serverShotPending = pending; updateHUD(); },
  playApprovedShot: (startSnapshot: any, power: number, angleRadians: number, finalSnapshot: any, extra?: ApprovedShotExtra) => {
    if (!finalSnapshot || !Array.isArray(finalSnapshot.balls) || !startSnapshot || !Array.isArray(startSnapshot.balls)) {
      serverShotPending = false;
      updateHUD();
      return getPublicState();
    }
    // `local` = this device submitted the shot (the cue already struck); otherwise animate the opponent's cue too.
    const job: Job = { start: startSnapshot, power, angle: angleRadians, final: finalSnapshot, extra, local: serverShotPending };
    serverShotPending = false;
    if (document.hidden) { // rAF is paused in background tabs: skip the animation, show the authoritative result now
      fastForwardPlayback();
      finishApprovedShot(finalSnapshot, startSnapshot);
      return getPublicState();
    }
    if (tracePlayback || cueAnim) approvedQueue.push(job);
    else startApprovedShot(job);
    return getPublicState();
  },
  settleTo: (snapshot: any) => {
    approvedQueue.length = 0;
    try { fastForwardPlayback(); } catch { /* ignore */ }
    return applyState(snapshot);
  },
  applyState,
  setPlayers: (players: [PoolPlayerInfo, PoolPlayerInfo], localIndex: 0 | 1) => {
    localPlayerIndex = localIndex;
    names[0] = players[0].username.startsWith('@') ? players[0].username : `@${players[0].username}`;
    names[1] = players[1].username.startsWith('@') ? players[1].username : `@${players[1].username}`;
    hud.setPlayers(players, localIndex);
    lastHudKey = '';
    onResize();
  },
  setStake: (amount: number | null) => hud.setStake(amount),
  setCountdown: (seconds: number) => hud.setCountdown(seconds),
  setTurnTimer: (playerIndex: 0 | 1, secondsLeft: number | null, totalSeconds: number) => hud.setTurnTimer(playerIndex, secondsLeft, totalSeconds),
  setPaused: (value: boolean) => {
    paused = value;
    if (value) { charging = false; fineDirection = 0; }
    lastHudKey = '';
    updateHUD();
  },
  shotRejected: (message?: string) => {
    serverShotPending = false;
    cueAnim = null; cuePull = 0;
    if (message) showBanner(message.length > 48 ? 'Shot not accepted' : message, 'bad');
    lastHudKey = '';
    updateHUD();
  },
  setGuide: (full: boolean) => {
    guideFull = full;
    try { window.localStorage.setItem('squadbet.pool.guide.v2', full ? 'full' : 'line'); } catch { /* ignore */ }
  },
  setQuality: (quality: 'auto' | 'high' | 'low') => {
    qualitySetting = quality;
    try { window.localStorage.setItem('squadbet.pool.quality', quality); } catch { /* ignore */ }
    onResize();
  },
  getSettings: () => ({ quality: qualitySetting, guideFull, sound: audio.isOn }),
  toggleSound: () => { audio.setEnabled(!audio.isOn); hud.setSoundOn(audio.isOn); return audio.isOn; },
  toggleFullscreen,
  dispose: () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    hud.dispose();
    audio.dispose();
    canvas.remove();
    W.__POOL_GAME__ = undefined;
  },
};
W.__POOL_GAME__ = api;

buildNumberTextures();
resetMatch();
fit();
rafId = requestAnimationFrame(animate);
}
