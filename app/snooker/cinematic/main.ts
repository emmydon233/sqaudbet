import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PoolHud } from '../../pool3d/engine/hud';
import { PoolAudio } from '../../pool3d/engine/audio';
import type { PoolPlayerInfo } from '../../pool3d/engine/common';
import { predictShot } from '../../../lib/pool/aim';
import { isLegalPlacement, simulateShotTrace } from '../../../lib/pool/authoritative';
import type { PoolTrace } from '../../../lib/pool/authoritative';

type BallKind = 'cue' | 'solid' | 'stripe' | 'eight';
type GroupKind = 'solid' | 'stripe';
type PlayerGroup = GroupKind | null;

type Pocket = {
  name: string;
  x: number;
  z: number;
  radius: number;
};

type PlayerState = {
  name: string;
  group: PlayerGroup;
};

type ShotReport = {
  pocketedIds: number[];
  firstContactId: number | null;
  cueScratch: boolean;
  eightPocketed: boolean;
  started: boolean;
};

type Ball = {
  id: number;
  label: string;
  kind: BallKind;
  color: number;
  body: THREE.Group;
  sphere: THREE.Mesh;
  velocity: THREE.Vector2;
  pocketed: boolean;
  radius: number;
};

type PublicPoolApi = {
  getState: () => unknown;
  aimAt: (x: number, z: number) => unknown;
  setAimAngle: (angleRadians: number) => unknown;
  setPower: (value: number) => unknown;
  shoot: (power?: number, angleRadians?: number) => unknown;
  step: (frames?: number, dt?: number) => unknown;
  reset: () => unknown;
  applyState: (snapshot: any) => unknown;
  setMultiplayerMode: (enabled: boolean, localPlayerIndex?: number, live?: boolean) => void;
  setShotPending: (pending: boolean) => void;
  playApprovedShot: (startSnapshot: any, power: number, angleRadians: number, finalSnapshot: any, extra?: ApprovedShotExtra) => unknown;
  // ---- SquadBet HUD / integration additions (the 3D scene itself is unchanged) ----
  setPlayers: (players: [PoolPlayerInfo, PoolPlayerInfo], localPlayerIndex: 0 | 1) => void;
  setStake: (amount: number | null) => void;
  setCountdown: (seconds: number) => void;
  setTurnTimer: (playerIndex: 0 | 1, secondsLeft: number | null, totalSeconds: number) => void;
  setPaused: (paused: boolean) => void;
  shotRejected: (message?: string) => void;
  /** Stop any replay in progress and snap the table to this authoritative snapshot (used to correct an instant local shot). */
  settleTo: (snapshot: any) => unknown;
  setGuide: (full: boolean) => void;
  setQuality: (quality: 'auto' | 'high' | 'low') => void;
  getSettings: () => { quality: 'auto' | 'high' | 'low'; guideFull: boolean; sound: boolean };
  toggleSound: () => boolean;
  toggleFullscreen: () => void;
  dispose: () => void;
};

type ApprovedShotExtra = { spinX?: number; spinY?: number; cuePlacement?: { x: number; z: number } | null };

declare global {
  interface Window {
    __POOL_GAME__: PublicPoolApi;
    __POOL_ERRORS__: string[];
  }
}

const TABLE = {
  halfW: 4.05,
  halfD: 2.04,
  outerHalfW: 4.72,
  outerHalfD: 2.72,
  surfaceY: 0.16,
  ballRadius: 0.118,
  pocketRadius: 0.31,
  cushionRestitution: 0.82,
  ballRestitution: 0.94,
  friction: 0.92,
  stopSpeed: 0.018,
  maxShotSpeed: 8.8,
};

const BALL_COLORS: Record<number, number> = {
  1: 0xf6cc4f,
  2: 0x2868c7,
  3: 0xc83d35,
  4: 0x743eaa,
  5: 0xf07a2f,
  6: 0x2f9a57,
  7: 0x8c2638,
  8: 0x111114,
  9: 0xf6cc4f,
  10: 0x2868c7,
  11: 0xc83d35,
  12: 0x743eaa,
  13: 0xf07a2f,
  14: 0x2f9a57,
  15: 0x8c2638,
};

const pockets: Pocket[] = [
  { name: 'top-left corner', x: -TABLE.halfW, z: -TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { name: 'top side', x: 0, z: -TABLE.halfD - 0.015, radius: TABLE.pocketRadius * 0.94 },
  { name: 'top-right corner', x: TABLE.halfW, z: -TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { name: 'bottom-left corner', x: -TABLE.halfW, z: TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
  { name: 'bottom side', x: 0, z: TABLE.halfD + 0.015, radius: TABLE.pocketRadius * 0.94 },
  { name: 'bottom-right corner', x: TABLE.halfW, z: TABLE.halfD, radius: TABLE.pocketRadius * 1.08 },
];

/**
 * Builds the cinematic table inside #pool-host. Previously this ran as a side effect of importing the
 * module; it is now an explicit call so the page can tear the game down (dispose) and mount it again
 * without leaking the render loop or event listeners. The scene below is otherwise unchanged.
 */
export function mountCinematicPool(): void {
const cleanups: Array<() => void> = [];
let disposed = false;
let rafId = 0;
function listen(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener(type, handler, options));
}

window.__POOL_ERRORS__ = [];
listen(window, 'error', ((event: ErrorEvent) => {
  window.__POOL_ERRORS__.push(event.message);
}) as EventListener);
listen(window, 'unhandledrejection', ((event: PromiseRejectionEvent) => {
  window.__POOL_ERRORS__.push(String(event.reason));
}) as EventListener);

const app = document.querySelector<HTMLDivElement>('#pool-host');
if (!app) throw new Error('Missing #pool-host root');

const audio = new PoolAudio();
let paused = false;
let guideFull = true;
let qualitySetting: 'auto' | 'high' | 'low' = 'auto';
try {
  const q = window.localStorage.getItem('squadbet.pool.quality');
  if (q === 'high' || q === 'low' || q === 'auto') qualitySetting = q;
  guideFull = window.localStorage.getItem('squadbet.pool.guide.v2') !== 'line'; // v2: everyone starts on the full guide again
} catch { /* storage unavailable: defaults are fine */ }

// Cue-ball spin selected on the HUD. -1..1 on both axes; sent to the server with the shot.
const spin = { x: 0, y: 0 };
let fineDirection: -1 | 0 | 1 = 0;
let fineHeld = 0;

const hud = new PoolHud(app, {
  gesture: () => audio.unlock(),
  spin: (x, y) => { spin.x = x; spin.y = y; },
  fine: (direction) => { fineDirection = direction; fineHeld = 0; },
  power: (value, phase) => {
    if (phase === 'start') return;
    if (phase === 'move') {
      if (canShoot()) { manualPowerTouched = true; chargePower = THREE.MathUtils.clamp(value, 0.08, 1); }
      return;
    }
    if (phase === 'cancel') { manualPowerTouched = false; chargePower = 0.38; return; }
    // 'end': releasing near the top cancels, so grabbing the bar can never fire a shot by accident.
    if (value >= 0.06 && canShoot()) shoot(THREE.MathUtils.clamp(value, 0.08, 1));
    else { manualPowerTouched = false; chargePower = 0.38; }
  },
  button: (name) => {
    if (name === 'sound') { audio.setEnabled(!audio.isOn); hud.setSoundOn(audio.isOn); }
    else if (name === 'fullscreen') toggleFullscreen();
    else window.dispatchEvent(new CustomEvent('pool-ui', { detail: { action: name } })); // exit / help / settings
  },
});
hud.setSoundOn(audio.isOn);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

// Soft studio reflection used ONLY by the balls (scene.environment stays unset, so the felt and wood keep
// their current look). Gives the balls crisp, realistic highlights without any baked-in glare.
let ballEnvMap: THREE.Texture | null = null;
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  ballEnvMap = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
} catch { ballEnvMap = null; }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);
scene.fog = new THREE.FogExp2(0x05070c, 0.028);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.5, 80) /* near plane pushed out: far better depth precision, no dashed/flickering lines on phones */;
camera.position.set(0, 6.7, 5.65);
const cameraLook = new THREE.Vector3(0, 0.08, 0);
camera.lookAt(cameraLook);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.12, 0.45, 0.92);
composer.addPass(bloomPass);
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    darkness: { value: 0.82 },
    offset: { value: 1.08 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float darkness;
    uniform float offset;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 uv = (vUv - vec2(0.5)) * vec2(offset);
      color.rgb = mix(color.rgb, vec3(0.0), dot(uv, uv) * darkness);
      gl_FragColor = color;
    }
  `,
};
composer.addPass(new ShaderPass(VignetteShader));
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.material.uniforms.resolution.value.set(1 / window.innerWidth, 1 / window.innerHeight);
composer.addPass(fxaaPass);

const clock = new THREE.Clock();
const balls: Ball[] = [];
const activeBallMeshes: THREE.Object3D[] = [];

const game = {
  turn: 0,
  players: [
    { name: 'Player 1', group: null },
    { name: 'Player 2', group: null },
  ] as PlayerState[],
  status: 'Rack is set. Player 1 breaks.',
  shot: createEmptyShotReport(),
  shotInProgress: false,
  settleTimer: 0,
  gameOver: false,
};

const aimDir = new THREE.Vector2(1, 0);
let multiplayerMode = false;
let multiplayerLive = false;
let localPlayerIndex = 0;
let serverShotPending = false;
let serverPlayback = false;
let serverPlaybackStarting = false;
let authoritativePlaybackFinal: any = null;
let serverPlaybackElapsed = 0;
let chargePower = 0.44;
let charging = false;
let chargeDirection = 1;
let lastPointerWorld = new THREE.Vector3(0, 0, 0);
let manualPowerTouched = false;
let ballInHand = false;
let placement: { x: number; z: number } | null = null;
let placingPointer = -1;
let lastHudKey = '';
let fitScale = 1;
const trayPocketed = new Set<number>();
const ballList: Array<{ id: number; x: number; z: number; pocketed: boolean }> = [];
type TracePlayback = { trace: PoolTrace; t: number; ev: number; final: any; start: any; settle: number };
let tracePlayback: TracePlayback | null = null;
let cueAnimation: { angle: number; spinX: number; spinY: number; t: number; plan: Array<{ dur: number; from: number; to: number }>; idx: number; done: () => void } | null = null;
let cueAnimPull = 0;
const approvedQueue: Array<{ start: any; power: number; angle: number; final: any; extra?: ApprovedShotExtra; local: boolean }> = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE.surfaceY);
const cameraTarget = new THREE.Vector3(0, 0.08, 0);
const tempVec3 = new THREE.Vector3();
const tempVec3B = new THREE.Vector3();
const tempVec3C = new THREE.Vector3();
// Camera: higher, steeper angle so the playing surface fills the screen (wood frame is cropped off-screen).
const CAM_Y = 7.2;
const CAM_Z = 3.9;
const tempVec2 = new THREE.Vector2();

function createEmptyShotReport(): ShotReport {
  return {
    pocketedIds: [],
    firstContactId: null,
    cueScratch: false,
    eightPocketed: false,
    started: false,
  };
}

function makeNoiseTexture(base: string, accent: string, width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 9500; i += 1) {
    const alpha = Math.random() * 0.08;
    ctx.fillStyle = i % 2 === 0 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    ctx.fillRect(Math.random() * width, Math.random() * height, Math.random() * 2 + 0.35, Math.random() * 2 + 0.35);
  }
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.26;
  for (let y = 22; y < height; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(y) * 3);
    ctx.bezierCurveTo(width * 0.28, y + 6, width * 0.55, y - 8, width, y + Math.cos(y) * 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Fine woven-cloth felt: dense short fibres in two directions, no wavy "stripe" lines. */
function makeFeltTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#106348';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 26000; i += 1) {
    const a = 0.03 + Math.random() * 0.07;
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(120,230,180,${a})` : `rgba(0,25,15,${a * 1.2})`;
    if (Math.random() < 0.5) ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2.5, 0.6);
    else ctx.fillRect(Math.random() * size, Math.random() * size, 0.6, 1 + Math.random() * 2.5);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Polished hardwood: long grain streaks with darker pores and a few knots. */
function makeWoodTexture(): THREE.CanvasTexture {
  const w = 1024, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#6b3a1c'); grad.addColorStop(0.5, '#7a4423'); grad.addColorStop(1, '#5f3318');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 520; i += 1) {
    const y = Math.random() * h;
    const dark = Math.random() < 0.6;
    ctx.strokeStyle = dark ? `rgba(35,16,6,${0.05 + Math.random() * 0.16})` : `rgba(215,160,100,${0.04 + Math.random() * 0.1})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 7, w * 0.65, y + (Math.random() - 0.5) * 7, w, y + (Math.random() - 0.5) * 5);
    ctx.stroke();
  }
  for (let k = 0; k < 3; k += 1) {
    const x = Math.random() * w, y = 30 + Math.random() * (h - 60);
    const knot = ctx.createRadialGradient(x, y, 1, x, y, 16);
    knot.addColorStop(0, 'rgba(30,12,4,0.55)'); knot.addColorStop(1, 'rgba(30,12,4,0)');
    ctx.fillStyle = knot;
    ctx.fillRect(x - 18, y - 18, 36, 36);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// ---- Ball textures -------------------------------------------------------------------------------------
// Every pixel of the equirectangular texture is mapped back to a direction on the sphere, so the number
// "decals" are true circles on the ball (no stretching at the poles) and there are SIX of them (one on each
// side of the ball): whichever way a ball has rolled, a number faces the camera. No highlight is baked into
// the texture any more (the old baked white glare washed out the colour and hid the number); gloss now comes
// from the lights + environment reflection.
const BALL_TEX_W = 1024;
const BALL_TEX_H = 512;
const BADGE_HALF_ANGLE = 0.64; // sin(angular radius): number disc is ~58% of the ball diameter (big and readable)
// Decal centres (c) with their "up" (u) direction, in the sphere's local frame (Y is the texture pole axis).
const BADGE_AXES: Array<{ c: [number, number, number]; u: [number, number, number] }> = [
  { c: [0, 0, 1], u: [0, 1, 0] }, { c: [0, 0, -1], u: [0, 1, 0] },
  { c: [1, 0, 0], u: [0, 1, 0] }, { c: [-1, 0, 0], u: [0, 1, 0] },
  { c: [0, 1, 0], u: [0, 0, -1] }, { c: [0, -1, 0], u: [0, 0, 1] },
];
type BadgeMap = { slot: Int8Array; bx: Int16Array; by: Int16Array; dot: Float32Array; dy: Float32Array };
let badgeMap: BadgeMap | null = null;
const BADGE_PX = 256;

function getBadgeMap(): BadgeMap {
  if (badgeMap) return badgeMap;
  const n = BALL_TEX_W * BALL_TEX_H;
  const slot = new Int8Array(n).fill(-1);
  const bx = new Int16Array(n);
  const by = new Int16Array(n);
  const dot = new Float32Array(n); // cosine of the angle to the nearest decal centre (cue-ball dots)
  const dy = new Float32Array(n); // y component of the surface direction (stripe belt)
  const cosMax = Math.sqrt(1 - BADGE_HALF_ANGLE * BADGE_HALF_ANGLE);
  for (let py = 0; py < BALL_TEX_H; py += 1) {
    const theta = ((py + 0.5) / BALL_TEX_H) * Math.PI;
    const sinT = Math.sin(theta);
    const y = Math.cos(theta);
    for (let px = 0; px < BALL_TEX_W; px += 1) {
      const phi = ((px + 0.5) / BALL_TEX_W) * Math.PI * 2;
      const x = -Math.cos(phi) * sinT;
      const z = Math.sin(phi) * sinT;
      const idx = py * BALL_TEX_W + px;
      dy[idx] = y;
      let best = -2;
      for (let k = 0; k < BADGE_AXES.length; k += 1) {
        const { c, u } = BADGE_AXES[k];
        const d = x * c[0] + y * c[1] + z * c[2];
        if (d > best) best = d;
        if (d > cosMax) {
          // right = up x centre (viewer outside the ball looking inward)
          const rx = u[1] * c[2] - u[2] * c[1];
          const ry = u[2] * c[0] - u[0] * c[2];
          const rz = u[0] * c[1] - u[1] * c[0];
          const a = x * rx + y * ry + z * rz;
          const b = x * u[0] + y * u[1] + z * u[2];
          slot[idx] = k;
          bx[idx] = Math.round((a / BADGE_HALF_ANGLE * 0.5 + 0.5) * (BADGE_PX - 1));
          by[idx] = Math.round((0.5 - b / BADGE_HALF_ANGLE * 0.5) * (BADGE_PX - 1));
        }
      }
      dot[idx] = best;
    }
  }
  badgeMap = { slot, bx, by, dot, dy };
  return badgeMap;
}

function makeBadge(id: number): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = BADGE_PX;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, BADGE_PX, BADGE_PX);
  g.fillStyle = '#fbf8ee';
  g.beginPath();
  g.arc(BADGE_PX / 2, BADGE_PX / 2, BADGE_PX / 2 - 3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0b0b0d';
  g.font = `900 ${id >= 10 ? 138 : 164}px "Arial Black", Arial, Helvetica, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(id), BADGE_PX / 2, BADGE_PX / 2 + 8);
  if (id === 6 || id === 9) { // underline so 6 and 9 can never be confused
    g.fillRect(BADGE_PX / 2 - 34, BADGE_PX / 2 + 74, 68, 12);
  }
  return g.getImageData(0, 0, BADGE_PX, BADGE_PX);
}

function makeBallTexture(id: number, kind: BallKind, color: number): THREE.CanvasTexture {
  const map = getBadgeMap();
  const canvas = document.createElement('canvas');
  canvas.width = BALL_TEX_W;
  canvas.height = BALL_TEX_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(BALL_TEX_W, BALL_TEX_H);
  const out = img.data;
  const badge = kind === 'cue' ? null : makeBadge(id).data;
  const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255;
  const dotCos = Math.cos(0.075);
  for (let i = 0; i < BALL_TEX_W * BALL_TEX_H; i += 1) {
    let r: number, g: number, b: number;
    if (kind === 'cue') {
      r = 247; g = 243; b = 232;
      if (map.dot[i] > dotCos) { r = 196; g = 38; b = 38; } // six small red spots help judge spin and roll
    } else if (kind === 'stripe') {
      // coloured belt around the middle, white caps; soft edge
      const edge = Math.min(1, Math.max(0, (0.5 - Math.abs(map.dy[i])) / 0.035));
      r = 246 + (cr - 246) * edge; g = 241 + (cg - 241) * edge; b = 228 + (cb - 228) * edge;
    } else if (kind === 'eight') {
      r = 14; g = 14; b = 17;
    } else {
      r = cr; g = cg; b = cb;
    }
    if (badge && map.slot[i] >= 0) {
      const bi = (map.by[i] * BADGE_PX + map.bx[i]) * 4;
      const a = badge[bi + 3] / 255;
      if (a > 0) {
        r = r * (1 - a) + badge[bi] * a;
        g = g * (1 - a) + badge[bi + 1] * a;
        b = b * (1 - a) + badge[bi + 2] * a;
      }
    }
    const o = i * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}
const ballTextureCache = new Map<number, THREE.CanvasTexture>();
function ballTexture(id: number, kind: BallKind, color: number): THREE.CanvasTexture {
  let t = ballTextureCache.get(id);
  if (!t) { t = makeBallTexture(id, kind, color); ballTextureCache.set(id, t); }
  return t;
}

function createMaterial(color: number, roughness = 0.48, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addShadowFlags(object: THREE.Object3D, cast = true, receive = true): void {
  object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
    }
  });
}

function buildRoom(): void {
  const floorTexture = makeNoiseTexture('#151019', '#4d3c34', 1024, 1024);
  floorTexture.repeat.set(8, 8);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 28),
    new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.86, metalness: 0.02 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.32;
  floor.receiveShadow = true;
  scene.add(floor);

  const backWall = new THREE.Mesh(new THREE.BoxGeometry(28, 8, 0.45), createMaterial(0x090b11, 0.72, 0.02));
  backWall.position.set(0, 3.4, -7.2);
  backWall.receiveShadow = true;
  scene.add(backWall);

  const brass = createMaterial(0xb8833f, 0.32, 0.75);
  for (let i = -3; i <= 3; i += 1) {
    const pendant = new THREE.Group();
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 10), brass);
    cord.position.y = 5.8;
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.45, 0.26, 32, 1, true), brass);
    shade.position.y = 5.18;
    const bulb = new THREE.PointLight(0xffc06a, 0.35, 4.6, 1.8);
    bulb.position.y = 5.0;
    pendant.add(cord, shade, bulb);
    pendant.position.set(i * 1.05, 0, -0.25);
    scene.add(pendant);
  }
}

function buildTable(): void {
  const feltTexture = makeFeltTexture();
  feltTexture.repeat.set(9, 4.6);
  const feltMaterial = new THREE.MeshStandardMaterial({
    map: feltTexture,
    color: 0x1a9a6a,
    roughness: 1.0,
    metalness: 0,
  });
  const woodTexture = makeWoodTexture();
  woodTexture.repeat.set(2, 1);
  const woodMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0xb4733f,
    roughness: 0.78,
    metalness: 0.0,
  });
  const rubberMaterial = new THREE.MeshStandardMaterial({ color: 0x0f7a54, roughness: 0.9, metalness: 0.0 }); // cloth-covered cushion
  const darkMetalMaterial = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 0.6, metalness: 0.3 }); // thin dark pocket rim (no glowing brass)

  const tableRoot = new THREE.Group();
  scene.add(tableRoot);

  const base = new THREE.Mesh(new THREE.BoxGeometry(TABLE.outerHalfW * 2, 0.42, TABLE.outerHalfD * 2), woodMaterial);
  base.position.y = -0.08;
  tableRoot.add(base);

  const felt = new THREE.Mesh(new THREE.BoxGeometry(TABLE.halfW * 2, 0.075, TABLE.halfD * 2), feltMaterial);
  felt.position.y = TABLE.surfaceY - 0.05;
  felt.receiveShadow = true;
  tableRoot.add(felt);

  const railHeight = 0.42;
  const railY = TABLE.surfaceY + 0.09;
  const topRail = new THREE.Mesh(new THREE.BoxGeometry(TABLE.outerHalfW * 2, railHeight, 0.54), woodMaterial);
  topRail.position.set(0, railY, -TABLE.outerHalfD + 0.28);
  const bottomRail = topRail.clone();
  bottomRail.position.z = TABLE.outerHalfD - 0.28;
  const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.54, railHeight, TABLE.outerHalfD * 2), woodMaterial);
  leftRail.position.set(-TABLE.outerHalfW + 0.28, railY, 0);
  const rightRail = leftRail.clone();
  rightRail.position.x = TABLE.outerHalfW - 0.28;
  tableRoot.add(topRail, bottomRail, leftRail, rightRail);

  const cushionDepth = 0.16;
  const topCushion = new THREE.Mesh(new THREE.BoxGeometry(TABLE.halfW * 1.72, 0.16, cushionDepth), rubberMaterial);
  topCushion.position.set(0, TABLE.surfaceY + 0.085, -TABLE.halfD - cushionDepth * 0.18);
  const bottomCushion = topCushion.clone();
  bottomCushion.position.z = TABLE.halfD + cushionDepth * 0.18;
  const leftCushion = new THREE.Mesh(new THREE.BoxGeometry(cushionDepth, 0.16, TABLE.halfD * 1.55), rubberMaterial);
  leftCushion.position.set(-TABLE.halfW - cushionDepth * 0.18, TABLE.surfaceY + 0.085, 0);
  const rightCushion = leftCushion.clone();
  rightCushion.position.x = TABLE.halfW + cushionDepth * 0.18;
  tableRoot.add(topCushion, bottomCushion, leftCushion, rightCushion);

  // Pockets: a deep, soft-shaded hole sitting just above the felt/base (so a falling ball is swallowed by it
  // instead of being hidden by a flat black lid), a leather-brown lip, and the original brass ring.
  const holeCanvas = document.createElement('canvas');
  holeCanvas.width = holeCanvas.height = 128;
  {
    const hctx = holeCanvas.getContext('2d')!;
    const grad = hctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, '#000000');
    grad.addColorStop(0.8, '#000000');
    grad.addColorStop(0.93, '#050403');
    grad.addColorStop(1, '#14100d');
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 128, 128);
  }
  const holeTexture = new THREE.CanvasTexture(holeCanvas);
  const holeMaterial = new THREE.MeshBasicMaterial({ map: holeTexture });
  const leatherMaterial = new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.7, metalness: 0.05 });
  for (const pocket of pockets) {
    const hole = new THREE.Mesh(new THREE.CircleGeometry(pocket.radius * (Math.abs(pocket.x) > 1 ? 1.16 : 1.06), 56), holeMaterial);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(pocket.x, TABLE.surfaceY - 0.007, pocket.z);
    tableRoot.add(hole);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(pocket.radius * (Math.abs(pocket.x) > 1 ? 1.16 : 1.06), 0.03, 12, 56), leatherMaterial);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(pocket.x, TABLE.surfaceY + 0.02, pocket.z);
    tableRoot.add(lip);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(pocket.radius * (Math.abs(pocket.x) > 1 ? 1.17 : 1.07), 0.016, 10, 54), darkMetalMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pocket.x, TABLE.surfaceY + 0.072, pocket.z);
    tableRoot.add(ring);
  }

  {
    const gc = document.createElement('canvas');
    gc.width = gc.height = 256;
    const gx = gc.getContext('2d')!;
    const gg = gx.createRadialGradient(128, 128, 8, 128, 128, 128);
    gg.addColorStop(0, 'rgba(120,255,190,0.20)');
    gg.addColorStop(0.6, 'rgba(120,255,190,0.07)');
    gg.addColorStop(1, 'rgba(120,255,190,0)');
    gx.fillStyle = gg;
    gx.fillRect(0, 0, 256, 256);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE.halfW * 2, TABLE.halfD * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    glow.position.set(0, TABLE.surfaceY + 0.004, 0);
    glow.renderOrder = 1;
    glow.castShadow = false;
    glow.receiveShadow = false;
    scene.add(glow); // not in tableRoot: it must never cast a shadow onto the felt
  }

  const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xf4efe0, transparent: true, opacity: 0.95 });
  const markerGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.006, 24);
  const markerPositions = [
    [-2.02, -2.48], [0, -2.48], [2.02, -2.48],
    [-2.02, 2.48], [0, 2.48], [2.02, 2.48],
    [-4.38, -1.0], [-4.38, 1.0], [4.38, -1.0], [4.38, 1.0],
  ];
  for (const [x, z] of markerPositions) {
    const marker = new THREE.Mesh(markerGeo, dotMaterial);
    marker.position.set(x, TABLE.surfaceY + 0.17, z);
    tableRoot.add(marker);
  }

  const spotMaterial = new THREE.MeshBasicMaterial({ color: 0xf8e7bb, transparent: true, opacity: 0.55 });
  for (const x of [-2.02, 2.02]) {
    const spot = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.006, 32), spotMaterial);
    spot.position.set(x, TABLE.surfaceY + 0.012, 0);
    tableRoot.add(spot);
  }

  addShadowFlags(tableRoot, true, true);
}

function buildLights(): void {
  // Portable ambient base: guarantees the table is legible on every GPU, including
  // software WebGL (SwiftShader) and mobile, where RectAreaLight (LTC) is unreliable.
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x241a12, 1.1));
  scene.add(new THREE.AmbientLight(0xfff0dd, 0.55));

  // Main overhead "pool-hall pendant" key light. SpotLight is portable across all GPUs
  // and casts real shadows (RectAreaLight cannot), so it replaces the old area key light.
  // decay=1.0 keeps falloff gentle/predictable across GPUs (steep decay caused blowouts).
  const key = new THREE.SpotLight(0xffe6b8, 105, 22, Math.PI / 3.6, 0.55, 1.0);
  key.position.set(0, 6.6, 0);
  key.target.position.set(0, TABLE.surfaceY, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.02;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 22;
  scene.add(key, key.target);

  // Warm directional wash lifts the felt evenly. Directionals have NO distance falloff,
  // so their contribution is identical on every device â€” the backbone of portable brightness.
  const wash = new THREE.DirectionalLight(0xffd9a0, 1.0);
  wash.position.set(1.6, 5.6, 1.4);
  wash.target.position.set(0, TABLE.surfaceY, 0);
  scene.add(wash, wash.target);

  // Cool fill from the near side to shape the balls and add cinematic color contrast.
  const fill = new THREE.DirectionalLight(0x9fc2ff, 1.0);
  fill.position.set(-3.2, 3.4, 3.6);
  fill.target.position.set(0, TABLE.surfaceY, 0);
  scene.add(fill, fill.target);

  // Cool rim / back light with shadow for depth and edge separation.
  const rim = new THREE.DirectionalLight(0xbcd6ff, 0.6);
  rim.position.set(-3.5, 5.6, -5.2);
  rim.castShadow = true;
  rim.shadow.mapSize.set(2048, 2048);
  rim.shadow.camera.left = -7;
  rim.shadow.camera.right = 7;
  rim.shadow.camera.top = 6;
  rim.shadow.camera.bottom = -6;
  rim.shadow.camera.near = 0.5;
  rim.shadow.camera.far = 18;
  rim.shadow.bias = -0.00012;
  rim.shadow.normalBias = 0.02;
  scene.add(rim);

  // Gameplay-readability light: soft, even, straight down. It keeps the shadowed side of every ball lit so
  // colours and numbers stay readable, without adding glare. (No shadows, no falloff.)
  const readable = new THREE.DirectionalLight(0xffffff, 0.7);
  readable.position.set(0, 10, 0.2);
  readable.target.position.set(0, TABLE.surfaceY, 0);
  scene.add(readable, readable.target);

  // Focused warm highlight over the head spot for cinematic pop.
  const spotlight = new THREE.SpotLight(0xffdda5, 35, 18, Math.PI / 5.2, 0.55, 1.0);
  spotlight.position.set(0.4, 5.55, 1.2);
  spotlight.target.position.set(0.1, TABLE.surfaceY, -0.05);
  spotlight.castShadow = true;
  spotlight.shadow.mapSize.set(1024, 1024);
  spotlight.shadow.bias = -0.0002;
  scene.add(spotlight, spotlight.target);
}

// Visual-only ball size (physics radius is unchanged). Smaller screens get larger balls so numbers stay readable.
const ballVisualScaleFor = (width: number): number => (width < 1000 ? 1.12 : 1.05);
let ballVisualScale = ballVisualScaleFor(window.innerWidth);

function createBall(id: number, x: number, z: number): Ball {
  const kind: BallKind = id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';
  const color = id === 0 ? 0xfff8e9 : BALL_COLORS[id];
  const texture = ballTexture(id, kind, color);
  // Polished phenolic-resin look: low roughness + strong clear coat + a soft studio reflection.
  const material = new THREE.MeshPhysicalMaterial({
    map: texture,
    color: 0xb8b8b8, // multiplies the texture: stops colours and numbers washing out to white under the bright table lights
    roughness: 0.42,
    metalness: 0.0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.25,
    envMap: ballEnvMap,
    envMapIntensity: 0.15,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(TABLE.ballRadius, 48, 32), material);
  // Visual only: balls are drawn ~18% larger so numbers and colours read clearly on phones. Physics radius is unchanged.
  sphere.scale.setScalar(ballVisualScale);
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  // Start every ball with a number facing the camera (slightly different turn per ball, like a real rack).
  sphere.rotation.set(-Math.PI / 2, 0, (((id * 2654435761) % 1000) / 1000 - 0.5) * 1.1);

  const body = new THREE.Group();
  body.name = id === 0 ? 'Cue ball' : `Ball ${id}`;
  body.position.set(x, TABLE.surfaceY + TABLE.ballRadius, z);
  body.add(sphere);
  scene.add(body);

  const ball: Ball = {
    id,
    label: id === 0 ? 'Cue' : String(id),
    kind,
    color,
    body,
    sphere,
    velocity: new THREE.Vector2(0, 0),
    pocketed: false,
    radius: TABLE.ballRadius,
  };
  activeBallMeshes.push(sphere);
  return ball;
}

function clearBalls(): void {
  for (const ball of balls) {
    scene.remove(ball.body);
    ball.sphere.geometry.dispose();
    const material = ball.sphere.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose());
    } else {
      material.dispose();
    }
  }
  balls.length = 0;
  activeBallMeshes.length = 0;
}

function rackBalls(): void {
  clearBalls();
  balls.push(createBall(0, -2.72, 0));
  const rackOrder = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
  const spacingX = TABLE.ballRadius * 1.78;
  const spacingZ = TABLE.ballRadius * 2.08;
  let index = 0;
  const apexX = 1.28;
  for (let row = 0; row < 5; row += 1) {
    for (let item = 0; item <= row; item += 1) {
      const id = rackOrder[index];
      const x = apexX + row * spacingX;
      const z = (item - row / 2) * spacingZ;
      balls.push(createBall(id, x, z));
      index += 1;
    }
  }
}

const aimMaterial = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.95 });
const aimGeometry = new THREE.BufferGeometry();
aimGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const aimLine = new THREE.Line(aimGeometry, aimMaterial);
aimLine.renderOrder = 10;
scene.add(aimLine);

const ghostRing = new THREE.Mesh(
  new THREE.TorusGeometry(TABLE.ballRadius * 1.22, 0.017, 8, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
);
ghostRing.rotation.x = Math.PI / 2;
ghostRing.renderOrder = 11;
scene.add(ghostRing);

// Extra guide geometry (the original aim line + ghost ring above are kept as they were).
const objectLineMaterial = new THREE.LineBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0.9 });
const objectLineGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const objectLine = new THREE.Line(objectLineGeometry, objectLineMaterial);
objectLine.renderOrder = 10;
scene.add(objectLine);
const cueAfterMaterial = new THREE.LineBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.55 });
const cueAfterGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const cueAfterLine = new THREE.Line(cueAfterGeometry, cueAfterMaterial);
cueAfterLine.renderOrder = 10;
scene.add(cueAfterLine);
// WebGL lines are always 1 px wide (too faint to judge a shot), so each guide line gets a flat white ribbon
// that follows it. The thin Line objects keep their geometry/visibility logic but are not drawn themselves.
// Head string (the "kitchen" line) a quarter of the way down the table, like the real 8 Ball Pool break line.
// Purely visual: it marks the traditional break area and does not restrict where the cue ball may be placed.
{
  const headLen = TABLE.halfD * 2 - 0.16;
  const headString = new THREE.Mesh(
    new THREE.PlaneGeometry(0.026, headLen).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  headString.position.set(-TABLE.halfW / 2, TABLE.surfaceY + 0.006, 0);
  headString.renderOrder = 3;
  scene.add(headString);
}

const ribbonGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // lies flat, length along +X, width along Z
type Ribbon = { line: THREE.Line; mesh: THREE.Mesh; width: number };
function makeRibbon(line: THREE.Line, width: number, opacity: number): Ribbon {
  (line.material as THREE.LineBasicMaterial).visible = false;
  const mesh = new THREE.Mesh(
    ribbonGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);
  return { line, mesh, width };
}
const ribbons: Ribbon[] = [
  makeRibbon(aimLine, 0.038, 0.92),
  makeRibbon(objectLine, 0.034, 0.92),
  makeRibbon(cueAfterLine, 0.024, 0.7),
];
function syncRibbons(): void {
  for (const r of ribbons) {
    r.mesh.visible = r.line.visible;
    if (!r.line.visible) continue;
    const a = r.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const dx = a.getX(1) - a.getX(0), dz = a.getZ(1) - a.getZ(0);
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) { r.mesh.visible = false; continue; }
    r.mesh.position.set((a.getX(0) + a.getX(1)) / 2, a.getY(0) + 0.006, (a.getZ(0) + a.getZ(1)) / 2);
    r.mesh.rotation.y = -Math.atan2(dz, dx);
    r.mesh.scale.set(len, 1, r.width);
  }
}

function makeGuideRing(inner: number, outer: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 56),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 11;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}
const pocketRing = makeGuideRing(0.27, 0.32, 0x34d399);
const scratchRing = makeGuideRing(0.27, 0.32, 0xf87171);
const placeRing = makeGuideRing(TABLE.ballRadius * 1.3, TABLE.ballRadius * 1.55, 0x34d399);

const cueStick = new THREE.Group();
const cueLength = 1.78;
const cueShaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.017, 0.035, cueLength, 20),
  new THREE.MeshStandardMaterial({ color: 0xe2b57a, roughness: 0.32, metalness: 0.04 }), // maple shaft
);
const cueTip = new THREE.Mesh(
  new THREE.CylinderGeometry(0.021, 0.018, 0.08, 18),
  new THREE.MeshStandardMaterial({ color: 0x293f7c, roughness: 0.55, emissive: 0x3a6dff, emissiveIntensity: 0.7 }),
);
cueTip.position.y = cueLength / 2 + 0.04;
const cueButt = new THREE.Mesh(
  new THREE.CylinderGeometry(0.045, 0.045, 0.18, 20),
  new THREE.MeshStandardMaterial({ color: 0x16100b, roughness: 0.35, metalness: 0.12 }),
);
cueButt.position.y = -cueLength / 2 - 0.07;
// Realistic cue details (all attached to the same group, so the existing aiming / animation code is unchanged):
// white ferrule under the leather tip, dark hardwood butt sleeve, joint ring and a brass accent ring.
const cueRadiusAt = (y: number): number => 0.017 + (0.035 - 0.017) * ((cueLength / 2 - y) / cueLength);
const cueFerrule = new THREE.Mesh(
  new THREE.CylinderGeometry(0.0195, 0.0195, 0.05, 20),
  new THREE.MeshStandardMaterial({ color: 0xf4efe3, roughness: 0.25, metalness: 0.05 }),
);
cueFerrule.position.y = cueLength / 2 - 0.012;
const buttTop = -0.1, buttBottom = -cueLength / 2;
const cueSleeve = new THREE.Mesh(
  new THREE.CylinderGeometry(cueRadiusAt(buttTop) + 0.0013, cueRadiusAt(buttBottom) + 0.0013, buttTop - buttBottom, 24),
  new THREE.MeshStandardMaterial({ color: 0x2a170c, roughness: 0.3, metalness: 0.08 }),
);
cueSleeve.position.y = (buttTop + buttBottom) / 2;
const cueJoint = new THREE.Mesh(
  new THREE.CylinderGeometry(cueRadiusAt(buttTop) + 0.0024, cueRadiusAt(buttTop) + 0.0024, 0.016, 24),
  new THREE.MeshStandardMaterial({ color: 0xd8b25a, roughness: 0.22, metalness: 0.85 }),
);
cueJoint.position.y = buttTop;
const cueAccent = new THREE.Mesh(
  new THREE.CylinderGeometry(cueRadiusAt(-0.62) + 0.0024, cueRadiusAt(-0.62) + 0.0024, 0.02, 24),
  new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.3, metalness: 0.1 }),
);
cueAccent.position.y = -0.62;
cueStick.add(cueShaft, cueTip, cueButt, cueFerrule, cueSleeve, cueJoint, cueAccent);
addShadowFlags(cueStick, true, false);
scene.add(cueStick);

// Direction arrows: small chevrons that run along the shot line from the cue ball (like the arrows in
// mobile 8-ball games) so the stick's pointing direction is obvious. Visual only; no physics.
const dirChevrons: THREE.Mesh[] = [];
for (let i = 0; i < 4; i += 1) {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.035, 0.09, 3),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  cone.renderOrder = 12;
  cone.visible = false;
  scene.add(cone);
  dirChevrons.push(cone);
}
const CHEVRON_UP = new THREE.Vector3(0, 1, 0);

// Pocketed balls roll to the pocket centre, then drop with gravity and shrink slightly before they are
// hidden. Purely visual: game logic still treats the ball as pocketed the instant pocketBall() runs.
type BallDrop = { ball: Ball; t: number; fromX: number; fromZ: number; toX: number; toZ: number; y0: number; rattled?: boolean };
const ballDrops: BallDrop[] = [];

function startBallDrop(ball: Ball, pocket: Pocket): void {
  ballDrops.push({
    ball, t: 0, y0: ball.body.position.y,
    fromX: ball.body.position.x, fromZ: ball.body.position.z, toX: pocket.x, toZ: pocket.z,
  });
}

function stepBallDrops(dt: number): void {
  for (let i = ballDrops.length - 1; i >= 0; i -= 1) {
    const d = ballDrops[i];
    const b = d.ball;
    if (!b.pocketed) { // table was reset / ball restored while falling
      b.body.scale.setScalar(1);
      ballDrops.splice(i, 1);
      continue;
    }
    d.t += dt;
    // 1) The ball keeps rolling and ACCELERATES into the mouth (ease-in), instead of gliding smoothly.
    const slide = Math.min(1, d.t / 0.2);
    const e = slide * slide;
    b.body.position.x = d.fromX + (d.toX - d.fromX) * e;
    b.body.position.z = d.fromZ + (d.toZ - d.fromZ) * e;
    // 2) Once its centre passes the lip it tips over the edge and falls under gravity.
    const fall = Math.max(0, d.t - 0.13);
    b.body.position.y = d.y0 - 13 * fall * fall;
    // 3) It shrinks as it goes deeper into the hole (perspective), then is hidden by the black hole.
    b.body.scale.setScalar(1 - Math.min(0.42, fall * 1.7));
    // 4) A soft rattle as it knocks around inside the pocket.
    if (!d.rattled && b.body.position.y < TABLE.surfaceY - TABLE.ballRadius * 1.1) {
      d.rattled = true;
      audio.rattle();
    }
    if (b.body.position.y < TABLE.surfaceY - TABLE.ballRadius * 1.7) {
      b.body.visible = false;
      b.body.scale.setScalar(1);
      b.body.position.set(d.toX, TABLE.surfaceY - 0.18, d.toZ);
      ballDrops.splice(i, 1);
    }
  }
}

function getCueBall(): Ball {
  const cue = balls.find((ball) => ball.id === 0);
  if (!cue) throw new Error('Cue ball missing');
  return cue;
}

function canShoot(): boolean {
  return !paused && !tracePlayback && !cueAnimation && !game.gameOver && !game.shotInProgress && !areBallsMoving() && !getCueBall().pocketed
    && !serverShotPending && (!multiplayerMode || (multiplayerLive && game.turn === localPlayerIndex));
}

function setAimFromWorld(world: THREE.Vector3): void {
  if (!canShoot()) return;
  const cue = getCueBall();
  const dx = world.x - cue.body.position.x;
  const dz = world.z - cue.body.position.z;
  if (dx * dx + dz * dz < 0.0001) return;
  aimDir.set(dx, dz).normalize();
}

function rotateAim(delta: number): void {
  const angle = Math.atan2(aimDir.y, aimDir.x) + delta;
  aimDir.set(Math.cos(angle), Math.sin(angle));
}

function updatePointerFromEvent(event: PointerEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(tablePlane, hit)) {
    lastPointerWorld.copy(hit);
    setAimFromWorld(hit);
  }
}

function beginCharge(): void {
  if (!canShoot()) return;
  charging = true;
  chargeDirection = 1;
  if (!manualPowerTouched) chargePower = 0.12;
}

function endCharge(): void {
  if (!charging) return;
  charging = false;
  shoot(chargePower);
}

function shoot(power: number): void {
  if (!serverPlaybackStarting && !canShoot()) return;
  if (multiplayerMode && !serverPlaybackStarting) {
    const clamped = THREE.MathUtils.clamp(power, 0.08, 1);
    const angle = Math.atan2(aimDir.y, aimDir.x);
    let cuePlacement: { x: number; z: number } | null = null;
    if (ballInHand && placement) {
      if (!placementIsLegal()) { showBanner("Can't place the cue ball there", 'bad'); return; }
      cuePlacement = { x: Math.round(placement.x * 10000) / 10000, z: Math.round(placement.z * 10000) / 10000 };
    }
    const shotSpin = { x: spin.x, y: spin.y };
    serverShotPending = true;
    game.status = 'Submitting shot to SquadBet server\u2026';
    audio.cue(clamped);
    manualPowerTouched = false;
    chargePower = 0.38;
    // The cue strikes, THEN the request goes to the server. The server alone decides the outcome.
    runCueAnimation(angle, shotSpin, [{ dur: 0.09, from: 0.12 + clamped * 0.95, to: 0 }], () => {
      window.dispatchEvent(new CustomEvent('pool-shot-requested', { detail: { power: clamped, angleRadians: angle, spinX: shotSpin.x, spinY: shotSpin.y, cuePlacement } }));
    });
    updateHUD();
    return;
  }
  if (serverPlaybackStarting) serverPlaybackStarting = false;
  const cue = getCueBall();
  const clampedPower = THREE.MathUtils.clamp(power, 0.08, 1);
  game.shotInProgress = true;
  game.settleTimer = 0;
  game.shot = createEmptyShotReport();
  game.shot.started = true;
  cue.velocity.set(aimDir.x, aimDir.y).multiplyScalar(1.55 + clampedPower * TABLE.maxShotSpeed);
  showBanner(clampedPower > 0.83 ? 'Power break!' : clampedPower > 0.55 ? 'Clean stroke' : 'Soft touch');
  game.status = `${game.players[game.turn].name} shoots.`;
  manualPowerTouched = false;
  updateHUD();
}

function showBanner(message: string, tone: 'info' | 'good' | 'bad' | 'turn' = 'info'): void {
  hud.showBanner(message, tone, 1500);
}

function groupForKind(kind: BallKind): GroupKind | null {
  if (kind === 'solid') return 'solid';
  if (kind === 'stripe') return 'stripe';
  return null;
}

function ballById(id: number): Ball | undefined {
  return balls.find((ball) => ball.id === id);
}

function remainingGroupBalls(group: GroupKind): Ball[] {
  return balls.filter((ball) => ball.kind === group && !ball.pocketed);
}

function pocketBall(ball: Ball, pocket: Pocket): void {
  ball.velocity.set(0, 0);
  ball.pocketed = true;
  startBallDrop(ball, pocket); // ball stays visible while it rolls in and drops; hidden when the drop ends
  audio.pocket();
  if (ball.id !== 0) trayPocketed.add(ball.id);
  if (game.shot.started) {
    if (ball.id === 0) {
      game.shot.cueScratch = true;
    } else {
      game.shot.pocketedIds.push(ball.id);
      if (ball.id === 8) game.shot.eightPocketed = true;
    }
  }
}

function canPlaceCueAt(x: number, z: number): boolean {
  for (const ball of balls) {
    if (ball.id === 0 || ball.pocketed) continue;
    const dx = ball.body.position.x - x;
    const dz = ball.body.position.z - z;
    if (dx * dx + dz * dz < (TABLE.ballRadius * 2.4) ** 2) return false;
  }
  return true;
}

function restoreCueAfterScratch(): void {
  const cue = getCueBall();
  const candidates = [
    [-2.72, 0], [-2.94, -0.42], [-2.94, 0.42], [-2.45, -0.72], [-2.45, 0.72], [-3.15, 0],
  ];
  const open = candidates.find(([x, z]) => canPlaceCueAt(x, z)) ?? [-2.72, 0];
  cue.body.position.set(open[0], TABLE.surfaceY + TABLE.ballRadius, open[1]);
  cue.velocity.set(0, 0);
  cue.pocketed = false;
  cue.body.visible = true;
}

function areBallsMoving(): boolean {
  return balls.some((ball) => !ball.pocketed && ball.velocity.lengthSq() > TABLE.stopSpeed * TABLE.stopSpeed);
}

function updatePhysics(dt: number): void {
  const maxSubstep = 1 / 180;
  let remaining = Math.min(dt, 0.05);
  while (remaining > 0) {
    const step = Math.min(maxSubstep, remaining);
    integrateBalls(step);
    collideBalls();
    remaining -= step;
  }
}

function integrateBalls(dt: number): void {
  for (const ball of balls) {
    if (ball.pocketed) continue;
    const pos = ball.body.position;
    pos.x += ball.velocity.x * dt;
    pos.z += ball.velocity.y * dt;

    const speed = ball.velocity.length();
    if (speed > 0) {
      const axis = tempVec3.set(ball.velocity.y, 0, -ball.velocity.x).normalize();
      ball.sphere.rotateOnWorldAxis(axis, (speed * dt) / ball.radius);
      const nextSpeed = Math.max(0, speed - TABLE.friction * dt);
      if (nextSpeed < TABLE.stopSpeed) {
        ball.velocity.set(0, 0);
      } else {
        ball.velocity.multiplyScalar(nextSpeed / speed);
      }
    }

    for (const pocket of pockets) {
      const dx = pos.x - pocket.x;
      const dz = pos.z - pocket.z;
      if (dx * dx + dz * dz < pocket.radius * pocket.radius) {
        pocketBall(ball, pocket);
        break;
      }
    }
    if (ball.pocketed) continue;

    const minX = -TABLE.halfW + ball.radius * 0.62;
    const maxX = TABLE.halfW - ball.radius * 0.62;
    const minZ = -TABLE.halfD + ball.radius * 0.62;
    const maxZ = TABLE.halfD - ball.radius * 0.62;
    if (pos.x < minX) {
      pos.x = minX;
      audio.cushion(Math.abs(ball.velocity.x));
      ball.velocity.x = Math.abs(ball.velocity.x) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    } else if (pos.x > maxX) {
      pos.x = maxX;
      audio.cushion(Math.abs(ball.velocity.x));
      ball.velocity.x = -Math.abs(ball.velocity.x) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    }
    if (pos.z < minZ) {
      pos.z = minZ;
      audio.cushion(Math.abs(ball.velocity.y));
      ball.velocity.y = Math.abs(ball.velocity.y) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    } else if (pos.z > maxZ) {
      pos.z = maxZ;
      audio.cushion(Math.abs(ball.velocity.y));
      ball.velocity.y = -Math.abs(ball.velocity.y) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    }
  }
}

function nudgeFromPocketMouth(ball: Ball): void {
  for (const pocket of pockets) {
    const dx = ball.body.position.x - pocket.x;
    const dz = ball.body.position.z - pocket.z;
    const distanceSq = dx * dx + dz * dz;
    const safe = pocket.radius * 0.78;
    if (distanceSq > 0 && distanceSq < safe * safe) {
      const distance = Math.sqrt(distanceSq);
      ball.body.position.x = pocket.x + (dx / distance) * safe;
      ball.body.position.z = pocket.z + (dz / distance) * safe;
    }
  }
}

function collideBalls(): void {
  const minDistance = TABLE.ballRadius * 2;
  const minDistanceSq = minDistance * minDistance;
  for (let i = 0; i < balls.length; i += 1) {
    const a = balls[i];
    if (a.pocketed) continue;
    for (let j = i + 1; j < balls.length; j += 1) {
      const b = balls[j];
      if (b.pocketed) continue;
      const dx = b.body.position.x - a.body.position.x;
      const dz = b.body.position.z - a.body.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= 0 || distSq >= minDistanceSq) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDistance - dist;
      a.body.position.x -= nx * overlap * 0.5;
      a.body.position.z -= nz * overlap * 0.5;
      b.body.position.x += nx * overlap * 0.5;
      b.body.position.z += nz * overlap * 0.5;

      const relVel = (a.velocity.x - b.velocity.x) * nx + (a.velocity.y - b.velocity.y) * nz;
      if (relVel > 0) {
        audio.ball(relVel);
        const impulse = ((1 + TABLE.ballRestitution) * relVel) / 2;
        a.velocity.x -= impulse * nx;
        a.velocity.y -= impulse * nz;
        b.velocity.x += impulse * nx;
        b.velocity.y += impulse * nz;
        if (game.shot.started && game.shot.firstContactId === null) {
          if (a.id === 0 && b.id !== 0) game.shot.firstContactId = b.id;
          if (b.id === 0 && a.id !== 0) game.shot.firstContactId = a.id;
        }
      }
    }
  }
}

function finishAuthoritativePlayback(): void {
  if (!authoritativePlaybackFinal) return;
  const finalSnapshot = authoritativePlaybackFinal;
  authoritativePlaybackFinal = null;
  serverPlayback = false;
  serverPlaybackStarting = false;
  serverPlaybackElapsed = 0;
  window.__POOL_GAME__?.applyState(finalSnapshot);
}

function updateShotResolution(dt: number): void {
  if (!game.shotInProgress) return;

  if (serverPlayback && authoritativePlaybackFinal) {
    serverPlaybackElapsed += dt;

    if (!areBallsMoving()) {
      game.settleTimer += dt;
      if (game.settleTimer >= 0.45) {
        finishAuthoritativePlayback();
        return;
      }
    } else {
      game.settleTimer = 0;
    }

    // Never let client-side physics block the server-authoritative turn.
    if (serverPlaybackElapsed >= 12) {
      finishAuthoritativePlayback();
    }
    return;
  }

  if (areBallsMoving()) {
    game.settleTimer = 0;
    return;
  }

  game.settleTimer += dt;
  if (game.settleTimer >= 0.45) {
    resolveShot();
  }
}

function resolveShot(): void {
  if (serverPlayback && authoritativePlaybackFinal) {
    finishAuthoritativePlayback();
    return;
  }
  const current = game.turn;
  const player = game.players[current];
  const opponent = game.players[1 - current];
  const report = game.shot;
  let foul = false;
  const reasons: string[] = [];

  if (report.cueScratch) {
    foul = true;
    reasons.push('scratch');
  }

  const firstContact = report.firstContactId === null ? null : ballById(report.firstContactId);
  if (!firstContact) {
    foul = true;
    reasons.push('no object ball contact');
  } else if (player.group) {
    const firstGroup = groupForKind(firstContact.kind);
    if (firstContact.kind === 'eight') {
      if (remainingGroupBalls(player.group).length > 0) {
        foul = true;
        reasons.push('hit the 8 before clearing the group');
      }
    } else if (firstGroup !== player.group) {
      foul = true;
      reasons.push(`first hit was ${firstGroup === 'solid' ? 'a solid' : 'a stripe'}`);
    }
  } else if (firstContact.kind === 'eight') {
    foul = true;
    reasons.push('hit the 8 first on an open table');
  }

  const playerGroupBeforeAssignment = player.group;
  const firstPocketedGroup = report.pocketedIds
    .map((id) => ballById(id))
    .map((ball) => (ball ? groupForKind(ball.kind) : null))
    .find((group): group is GroupKind => group !== null);

  if (report.eightPocketed) {
    const hasCleared = player.group !== null && remainingGroupBalls(player.group).length === 0;
    if (!foul && hasCleared) {
      game.gameOver = true;
      game.status = `${player.name} pockets the 8 and wins the match.`;
      showBanner(`${player.name} wins`);
    } else {
      game.gameOver = true;
      game.status = `${player.name} loses by sinking the 8 early${reasons.length ? ` after ${reasons.join(', ')}` : ''}. ${opponent.name} wins.`;
      showBanner(`${opponent.name} wins`);
    }
    game.shotInProgress = false;
    if (report.cueScratch) restoreCueAfterScratch();
    updateHUD();
    window.dispatchEvent(new CustomEvent('pool-shot-settled', { detail: getPublicState() }));
    finishAuthoritativePlayback();
    return;
  }

  if (!foul && !player.group && firstPocketedGroup) {
    player.group = firstPocketedGroup;
    opponent.group = firstPocketedGroup === 'solid' ? 'stripe' : 'solid';
  }

  const pocketedGroups = report.pocketedIds
    .map((id) => ballById(id))
    .map((ball) => (ball ? groupForKind(ball.kind) : null))
    .filter((group): group is GroupKind => group !== null);

  let legalPocket = false;
  if (!foul) {
    if (player.group) {
      legalPocket = pocketedGroups.includes(player.group);
    } else if (!playerGroupBeforeAssignment) {
      legalPocket = pocketedGroups.length > 0;
    }
  }

  if (report.cueScratch) restoreCueAfterScratch();

  if (foul) {
    game.turn = 1 - game.turn;
    game.status = `${player.name} fouls (${reasons.join(', ')}). ${game.players[game.turn].name} has the table.`;
    showBanner('Foul Â· turn changes');
  } else if (legalPocket) {
    const groupMessage = player.group ? ` ${player.name} is ${player.group === 'solid' ? 'solids' : 'stripes'}.` : '';
    game.status = `${player.name} pockets legally and keeps shooting.${groupMessage}`;
    showBanner('Still at the table');
  } else {
    game.turn = 1 - game.turn;
    game.status = `${player.name} comes up dry. ${game.players[game.turn].name} shoots next.`;
    showBanner('Turn changes');
  }

  game.shotInProgress = false;
  game.shot = createEmptyShotReport();
  chargePower = 0.38;
  updateHUD();
  window.dispatchEvent(new CustomEvent('pool-shot-settled', { detail: getPublicState() }));
  finishAuthoritativePlayback();
}

function getAimLineDistance(): number {
  const cue = getCueBall();
  const origin = tempVec2.set(cue.body.position.x, cue.body.position.z);
  const dir = aimDir;
  let minT = Infinity;
  const bounds = [
    dir.x > 0 ? (TABLE.halfW - TABLE.ballRadius - origin.x) / dir.x : (-TABLE.halfW + TABLE.ballRadius - origin.x) / dir.x,
    dir.y > 0 ? (TABLE.halfD - TABLE.ballRadius - origin.y) / dir.y : (-TABLE.halfD + TABLE.ballRadius - origin.y) / dir.y,
  ].filter((value) => Number.isFinite(value) && value > 0);
  minT = Math.min(...bounds, 12);

  for (const ball of balls) {
    if (ball.id === 0 || ball.pocketed) continue;
    const toBallX = ball.body.position.x - origin.x;
    const toBallZ = ball.body.position.z - origin.y;
    const t = toBallX * dir.x + toBallZ * dir.y;
    if (t <= TABLE.ballRadius * 2) continue;
    const closestSq = toBallX * toBallX + toBallZ * toBallZ - t * t;
    const hitRadius = TABLE.ballRadius * 2.05;
    if (closestSq < hitRadius * hitRadius) {
      const hitT = t - Math.sqrt(hitRadius * hitRadius - closestSq);
      if (hitT > 0.16 && hitT < minT) minT = hitT;
    }
  }
  return minT;
}

/**
 * Ball in hand: dropping the cue ball into a pocket hole is a foul (the opponent gets ball in hand next).
 * The server decides it with the same rule, so this only sends the request (online matches only).
 */
function submitPocketPlacementFoul(): void {
  if (!multiplayerMode || !ballInHand || !placement || !canShoot()) return;
  const hole = pockets.find((p) => Math.hypot(placement!.x - p.x, placement!.z - p.z) <= p.radius);
  if (!hole) return;
  const cuePlacement = { x: hole.x, z: hole.z };
  placement = { x: hole.x, z: hole.z };
  serverShotPending = true;
  game.status = 'Submitting shot to SquadBet server\u2026';
  showBanner('Cue ball in a pocket \u2014 foul', 'bad');
  window.dispatchEvent(new CustomEvent('pool-shot-requested', { detail: { power: 0.08, angleRadians: 0, spinX: 0, spinY: 0, cuePlacement } }));
  updateHUD();
}

function placementIsLegal(): boolean {
  if (!placement) return true;
  syncBallList();
  return isLegalPlacement(ballList, placement.x, placement.z);
}

function syncBallList(): void {
  for (let i = 0; i < balls.length; i += 1) {
    const ball = balls[i];
    const row = ballList[i] ?? (ballList[i] = { id: 0, x: 0, z: 0, pocketed: false });
    row.id = ball.id;
    row.x = ball.body.position.x;
    row.z = ball.body.position.z;
    row.pocketed = ball.pocketed;
  }
  ballList.length = balls.length;
}

function hideExtraGuides(): void {
  objectLine.visible = false;
  cueAfterLine.visible = false;
  pocketRing.visible = false;
  scratchRing.visible = false;
  placeRing.visible = false;
  dirChevrons.forEach((c) => { c.visible = false; });
}

// Aim guide is deliberately medium length: it helps with direction but does not play the whole shot for the user.
const AIM_MAX = 99;         // cue-ball line reaches any ball, however far (stops at the first ball or the cushion)
const OBJECT_LINE_MAX = 1.4;
const CUE_AFTER_MAX = 0.9;

function setSegment(line: THREE.Line, ax: number, az: number, bx: number, bz: number, maxLen = Infinity): void {
  const segLen = Math.hypot(bx - ax, bz - az);
  if (segLen > maxLen) {
    const k = maxLen / segLen;
    bx = ax + (bx - ax) * k;
    bz = az + (bz - az) * k;
  }
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const y = TABLE.surfaceY + TABLE.ballRadius * 1.25;
  attr.setXYZ(0, ax, y, az);
  attr.setXYZ(1, bx, y, bz);
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
  line.visible = true;
}

function placeRingAt(ring: THREE.Mesh, x: number, z: number, scale = 1): void {
  ring.visible = true;
  ring.position.set(x, TABLE.surfaceY + 0.02, z);
  ring.scale.setScalar(scale);
}

function updateAimVisuals(dt: number): void {
  const cue = getCueBall();
  const canAim = canShoot();
  const cueVisible = !game.gameOver && !game.shotInProgress && !tracePlayback
    && !areBallsMoving() && !cue.pocketed;

  cueStick.visible = cueVisible;
  aimLine.visible = canAim;
  ghostRing.visible = canAim;

  const animating = cueAnimation !== null;
  const angleNow = animating ? cueAnimation!.angle : Math.atan2(aimDir.y, aimDir.x);
  const spinNow = animating ? { x: cueAnimation!.spinX, y: cueAnimation!.spinY } : spin;
  const shotDir3 = new THREE.Vector3(Math.cos(angleNow), 0, Math.sin(angleNow)).normalize();
  const drawBack = animating ? cueAnimPull : 0.18 + chargePower * 0.58;
  const center = cue.body.position.clone().addScaledVector(shotDir3, -(drawBack + cueLength / 2));
  // The cue tip is offset on the ball to show where the spin is applied (right-hand perpendicular).
  const side = spinNow.x * TABLE.ballRadius * 0.5;
  center.x += -shotDir3.z * side;
  center.z += shotDir3.x * side;
  cueStick.position.set(center.x, TABLE.surfaceY + TABLE.ballRadius * 1.08 + spinNow.y * TABLE.ballRadius * 0.5, center.z);
  cueStick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shotDir3);
  if (animating) cueStick.visible = true;

  if (!canAim) {
    hideExtraGuides();
    syncRibbons();
    return;
  }

  if (charging) {
    chargePower += chargeDirection * dt * 0.86;
    if (chargePower >= 1) {
      chargePower = 1;
      chargeDirection = -1;
    } else if (chargePower <= 0.08) {
      chargePower = 0.08;
      chargeDirection = 1;
    }
  }

  const dist = Math.min(getAimLineDistance(), AIM_MAX);
  const start = tempVec3.set(
    cue.body.position.x + aimDir.x * TABLE.ballRadius * 1.7,
    TABLE.surfaceY + TABLE.ballRadius * 1.25,
    cue.body.position.z + aimDir.y * TABLE.ballRadius * 1.7,
  );
  const end = tempVec3B.set(
    cue.body.position.x + aimDir.x * dist,
    TABLE.surfaceY + TABLE.ballRadius * 1.25,
    cue.body.position.z + aimDir.y * dist,
  );
  const positions = aimGeometry.getAttribute('position') as THREE.BufferAttribute;
  positions.setXYZ(0, start.x, start.y, start.z);
  positions.setXYZ(1, end.x, end.y, end.z);
  positions.needsUpdate = true;
  aimGeometry.computeBoundingSphere();
  aimMaterial.opacity = 0.45 + chargePower * 0.45;

  ghostRing.position.copy(end);
  ghostRing.scale.setScalar(0.9 + Math.sin(clock.elapsedTime * 4) * 0.035);

  // Direction chevrons marching away from the cue ball along the aim direction.
  {
    const dir3 = tempVec3C.set(aimDir.x, 0, aimDir.y).normalize();
    const march = (clock.elapsedTime * 0.5) % 1;
    dirChevrons.forEach((c, i) => {
      const along = TABLE.ballRadius * 2.6 + (i + march) * 0.3;
      c.visible = along < dist - TABLE.ballRadius;
      c.position.set(cue.body.position.x + dir3.x * along, TABLE.surfaceY + TABLE.ballRadius * 1.3, cue.body.position.z + dir3.z * along);
      c.quaternion.setFromUnitVectors(CHEVRON_UP, dir3);
      (c.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - (i + march) / 4);
    });
  }

  // Prediction from the SAME geometry/constants the authoritative simulation uses (lib/pool/aim.js):
  // object-ball departure line, cue-ball line after contact (with follow/draw), and the target pocket.
  syncBallList();
  const pred = predictShot(ballList, { x: cue.body.position.x, z: cue.body.position.z }, Math.atan2(aimDir.y, aimDir.x), spin);
  const pulse = 1 + Math.sin(clock.elapsedTime * 4) * 0.05;
  if (pred.cuePocket >= 0) {
    const p = pockets[pred.cuePocket];
    placeRingAt(scratchRing, p.x, p.z, (p.radius / 0.33) * pulse);
  } else scratchRing.visible = false;
  const contactDist = pred.contact ? Math.hypot(pred.contact.ghost.x - cue.body.position.x, pred.contact.ghost.z - cue.body.position.z) : Infinity;
  if (guideFull && pred.contact && pred.objectLine && contactDist <= AIM_MAX) {
    ghostRing.position.set(pred.contact.ghost.x, TABLE.surfaceY + TABLE.ballRadius * 1.25, pred.contact.ghost.z);
    const o = pred.objectLine;
    setSegment(objectLine, o.from.x + o.dir.x * TABLE.ballRadius, o.from.z + o.dir.z * TABLE.ballRadius, o.to.x, o.to.z, OBJECT_LINE_MAX);
    if (o.pocket >= 0) {
      const p = pockets[o.pocket];
      placeRingAt(pocketRing, p.x, p.z, (p.radius / 0.33) * pulse);
    } else pocketRing.visible = false;
    if (pred.cueAfter) setSegment(cueAfterLine, pred.cueAfter.from.x, pred.cueAfter.from.z, pred.cueAfter.to.x, pred.cueAfter.to.z, CUE_AFTER_MAX);
    else cueAfterLine.visible = false;
  } else {
    objectLine.visible = false;
    pocketRing.visible = false;
    cueAfterLine.visible = false; // no long wall-bounce preview: keeps the guide medium length
  }
  if (ballInHand) {
    placeRingAt(placeRing, cue.body.position.x, cue.body.position.z, 1);
    (placeRing.material as THREE.MeshBasicMaterial).color.setHex(placementIsLegal() ? 0x34d399 : 0xf87171);
  } else placeRing.visible = false;
  syncRibbons();
}

function runCueAnimation(angle: number, shotSpin: { x: number; y: number }, plan: Array<{ dur: number; from: number; to: number }>, done: () => void): void {
  cueAnimation = { angle, spinX: shotSpin.x, spinY: shotSpin.y, t: 0, plan, idx: 0, done };
  cueAnimPull = plan[0].from;
}

function stepCueAnimation(dt: number): void {
  const anim = cueAnimation;
  if (!anim) return;
  const step = anim.plan[anim.idx];
  anim.t += dt;
  const k = Math.min(1, anim.t / step.dur);
  const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  cueAnimPull = step.from + (step.to - step.from) * eased;
  if (k >= 1) {
    anim.idx += 1;
    anim.t = 0;
    if (anim.idx >= anim.plan.length) {
      cueAnimation = null;
      anim.done();
    } else cueAnimPull = anim.plan[anim.idx].from;
  }
}

function updateCamera(dt: number): void {
  const moving = balls.filter((ball) => !ball.pocketed && ball.velocity.lengthSq() > 0.05);
  const cue = getCueBall();
  let focusX = cue.pocketed ? 0 : cue.body.position.x * 0.18;
  let focusZ = cue.pocketed ? 0 : cue.body.position.z * 0.16;
  if (moving.length > 0) {
    focusX = moving.reduce((sum, ball) => sum + ball.body.position.x, 0) / moving.length * 0.16;
    focusZ = moving.reduce((sum, ball) => sum + ball.body.position.z, 0) / moving.length * 0.16;
  } else if (canShoot()) {
    focusX += aimDir.x * 0.16;
    focusZ += aimDir.y * 0.12;
  }
  cameraTarget.set(focusX, 0.08, focusZ);
  const targetPosition = tempVec3.set(focusX * 0.22, CAM_Y + chargePower * 0.08, CAM_Z + focusZ * 0.3);
  // Pull back (or in) along the existing view line so the whole table fits between the HUD panels.
  targetPosition.sub(cameraTarget).multiplyScalar(fitScale).add(cameraTarget);
  const alpha = 1 - Math.pow(0.0015, dt);
  camera.position.lerp(targetPosition, alpha);
  cameraLook.lerp(cameraTarget, alpha);
  camera.lookAt(cameraLook);
}

/** Fits the whole table inside the screen area the HUD leaves free. Called on resize / orientation change. */
function fitCamera(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const insets = hud.getInsets();
  // The table fills the screen: side controls reserve space, but the top player panels and bottom bar are
  // allowed to overlap the rails a little (only half their height is reserved).
  const freeW = Math.max(120, width - insets.left - insets.right);
  const freeH = Math.max(90, height - (insets.top + insets.bottom) * 0.3);
  camera.aspect = width / height;
  camera.clearViewOffset();
  const look = new THREE.Vector3(0, 0.08, 0);
  const base = new THREE.Vector3(0, CAM_Y, CAM_Z);
  const corners: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0.1, 0.3]) corners.push(new THREE.Vector3(sx * (TABLE.halfW + 0.2), y, sz * (TABLE.halfD + 0.2)));
  const probe = new THREE.Vector3();
  const measure = (scale: number) => {
    camera.position.copy(base).sub(look).multiplyScalar(scale).add(look);
    camera.lookAt(look);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      probe.copy(c).project(camera);
      minX = Math.min(minX, probe.x); maxX = Math.max(maxX, probe.x);
      minY = Math.min(minY, probe.y); maxY = Math.max(maxY, probe.y);
    }
    return { w: ((maxX - minX) / 2) * width, h: ((maxY - minY) / 2) * height, cx: ((minX + maxX) / 2) * (width / 2), cy: ((minY + maxY) / 2) * (height / 2) };
  };
  let lo = 0.8, hi = 3.2;
  for (let i = 0; i < 22; i += 1) {
    const mid = (lo + hi) / 2;
    const m = measure(mid);
    if (m.w <= freeW && m.h <= freeH) hi = mid; else lo = mid;
  }
  fitScale = hi;
  const m = measure(hi);
  // Centre the table in the free rectangle (not the whole window) with a sub-pixel view offset.
  const shiftX = (insets.left + (width - insets.right)) / 2 - width / 2 - m.cx;
  const shiftY = -((insets.top * 0.5 + (height - insets.bottom * 0.5)) / 2 - height / 2) - m.cy;
  camera.setViewOffset(width, height, -shiftX, shiftY, width, height);
  camera.updateProjectionMatrix();
}

function hudKey(): string {
  return [
    game.turn, game.gameOver ? 1 : 0, multiplayerLive ? 1 : 0, localPlayerIndex, canShoot() ? 1 : 0, game.status,
    game.players[0].group, game.players[1].group, [...trayPocketed].sort().join(','), ballInHand ? 1 : 0,
    serverShotPending ? 1 : 0, tracePlayback ? 1 : 0,
    Math.round(((charging || hud.isPowerDragging || manualPowerTouched) ? chargePower : 0) * 100),
  ].join('|');
}

function updateHUD(): void {
  // Only touch the DOM when something it shows actually changed (keeps the 60 fps loop cheap on phones).
  const key = hudKey();
  if (key === lastHudKey) return;
  lastHudKey = key;
  const canNow = canShoot();
  const live = !multiplayerMode || multiplayerLive;
  hud.setPower((charging || hud.isPowerDragging || manualPowerTouched) ? chargePower : 0);
  hud.setTurn(game.turn === 1 ? 1 : 0, localPlayerIndex === 1 ? 1 : 0, live, game.gameOver);
  hud.setGroups([game.players[0].group, game.players[1].group]);
  hud.setTrays([game.players[0].group, game.players[1].group], trayPocketed);
  hud.setInteractive(canNow);
  hud.setHint(canNow && ballInHand ? 'Ball in hand \u2014 drag the cue ball to place it, then shoot' : null);
  let status = game.status;
  if (multiplayerMode && !multiplayerLive) status = 'Waiting for both players to be ready';
  else if (tracePlayback || approvedQueue.length) status = 'Shot in progress\u2026';
  else if (multiplayerMode && !game.gameOver && game.turn === localPlayerIndex && !serverShotPending) status = ballInHand ? 'Your turn \u00b7 ball in hand' : 'Your turn \u00b7 aim, then pull the power bar down';
  hud.setStatus(status);
}

function resetMatch(): void {
  game.turn = 0;
  game.players[0].group = null;
  game.players[1].group = null;
  game.status = 'Rack is set. Player 1 breaks.';
  game.shot = createEmptyShotReport();
  game.shotInProgress = false;
  game.settleTimer = 0;
  game.gameOver = false;
  chargePower = 0.44;
  charging = false;
  aimDir.set(1, 0);
  ballInHand = false;
  placement = null;
  trayPocketed.clear();
  rackBalls();
  showBanner('Fresh rack');
  updateHUD();
}

// Safety net: no single multiplayer wait state may last forever. If the server never answers (lost response,
// dropped realtime event) the controls are released and the page is asked to re-read the authoritative table.
let pendingElapsed = 0;
let animElapsed = 0;
function watchdog(dt: number): void {
  if (serverShotPending) {
    pendingElapsed += dt;
    if (pendingElapsed > 20) {
      pendingElapsed = 0;
      serverShotPending = false;
      cueAnimation = null;
      lastHudKey = '';
      showBanner('Re-syncing table\u2026', 'info');
      window.dispatchEvent(new CustomEvent('pool-resync-needed'));
    }
  } else pendingElapsed = 0;
  if (tracePlayback || cueAnimation || approvedQueue.length) {
    animElapsed += dt;
    if (animElapsed > 45) { animElapsed = 0; fastForwardPlayback(); }
  } else animElapsed = 0;
}

/** Jump straight to the server's authoritative result for any shot animation still in progress. */
function fastForwardPlayback(): void {
  let guard = 0;
  while ((cueAnimation || tracePlayback || approvedQueue.length) && guard < 8) {
    guard += 1;
    if (cueAnimation) {
      const done = cueAnimation.done;
      cueAnimation = null;
      done();
    }
    if (tracePlayback) finishApprovedShot(tracePlayback.final, tracePlayback.start);
    else if (approvedQueue.length) startApprovedShot(approvedQueue.shift()!);
  }
  lastHudKey = '';
  updateHUD();
}

function update(dt: number): void {
  if (fineDirection !== 0 && canShoot()) {
    fineHeld += dt;
    rotateAim(fineDirection * (0.18 + Math.min(1, fineHeld) * 0.7) * dt);
  }
  stepCueAnimation(dt);
  stepBallDrops(dt);
  watchdog(dt);
  if (tracePlayback) {
    advanceTrace(dt);
  } else {
    // Practice / local physics, exactly as before.
    updatePhysics(dt);
    updateShotResolution(dt);
  }
  updateAimVisuals(dt);
  updateCamera(dt);
  updateHUD();
}

let loopErrors = 0;
function animate(): void {
  if (disposed) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  // One unexpected error must never freeze the table: keep the loop alive, and if the same fault repeats,
  // jump to the server's authoritative result so the next player can always shoot.
  try {
    update(dt);
    loopErrors = 0;
  } catch (error) {
    loopErrors += 1;
    try { window.__POOL_ERRORS__.push(String((error as Error)?.message ?? error)); } catch { /* ignore */ }
    if (loopErrors >= 3) {
      loopErrors = 0;
      try { fastForwardPlayback(); } catch { /* ignore */ }
    }
  }
  try { composer.render(); } catch { /* a failed frame is skipped, not fatal */ }
  rafId = requestAnimationFrame(animate);
}

function getPublicState(): unknown {
  return {
    title: document.title,
    status: game.status,
    currentPlayer: game.turn,
    gameOver: game.gameOver,
    winnerPlayer: game.gameOver ? (game.status.includes('wins the match') ? game.turn : 1 - game.turn) : null,
    shotInProgress: game.shotInProgress,
    canShoot: canShoot(),
    groups: game.players.map((player) => player.group),
    aimAngle: Math.atan2(aimDir.y, aimDir.x),
    power: chargePower,
    moving: areBallsMoving(),
    errors: window.__POOL_ERRORS__.slice(),
    cue: (() => {
      const cue = getCueBall();
      return {
        x: Number(cue.body.position.x.toFixed(3)),
        z: Number(cue.body.position.z.toFixed(3)),
        vx: Number(cue.velocity.x.toFixed(3)),
        vz: Number(cue.velocity.y.toFixed(3)),
        pocketed: cue.pocketed,
      };
    })(),
    balls: balls.map((ball) => ({
      id: ball.id,
      kind: ball.kind,
      x: Number(ball.body.position.x.toFixed(3)),
      z: Number(ball.body.position.z.toFixed(3)),
      vx: Number(ball.velocity.x.toFixed(3)),
      vz: Number(ball.velocity.y.toFixed(3)),
      pocketed: ball.pocketed,
    })),
  };
}

// ---- pointer input -------------------------------------------------------------------------------
// Mouse keeps the original behaviour (move to aim, hold left button to charge, release to shoot).
// Touch never charges from the table: dragging only aims (or places the cue ball); power comes from
// the power bar, so an aiming drag can never fire an accidental shot.
function pointerOnCueBall(event: PointerEvent): boolean {
  updatePointerFromEventNoAim(event);
  const cue = getCueBall();
  return Math.hypot(lastPointerWorld.x - cue.body.position.x, lastPointerWorld.z - cue.body.position.z) < TABLE.ballRadius * 2.8;
}

function updatePointerFromEventNoAim(event: PointerEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(tablePlane, hit)) lastPointerWorld.copy(hit);
}

listen(renderer.domElement, 'pointermove', ((event: PointerEvent) => {
  if (placingPointer === event.pointerId) {
    updatePointerFromEventNoAim(event);
    placement = { x: lastPointerWorld.x, z: lastPointerWorld.z };
    const cue = getCueBall();
    cue.body.position.x = placement.x;
    cue.body.position.z = placement.z;
    return;
  }
  updatePointerFromEvent(event);
}) as EventListener);
listen(renderer.domElement, 'pointerdown', ((event: PointerEvent) => {
  audio.unlock();
  if (ballInHand && canShoot() && pointerOnCueBall(event)) {
    placingPointer = event.pointerId;
    try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    return;
  }
  updatePointerFromEvent(event);
  if (event.button === 0 && event.pointerType === 'mouse') beginCharge();
}) as EventListener);
listen(window, 'pointerup', ((event: PointerEvent) => {
  if (placingPointer === event.pointerId) {
    placingPointer = -1;
    try { renderer.domElement.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    submitPocketPlacementFoul();
    return;
  }
  endCharge();
}) as EventListener);
listen(renderer.domElement, 'pointerleave', (() => {
  if (charging) endCharge();
}) as EventListener);

listen(window, 'keydown', ((event: KeyboardEvent) => {
  if (paused) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  audio.unlock();
  if (event.repeat && event.code === 'Space') return;
  const fine = event.shiftKey ? 0.25 : 1;
  if (event.code === 'Space') {
    event.preventDefault();
    beginCharge();
  } else if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
    rotateAim(0.055 * fine);
  } else if (event.code === 'ArrowRight' || event.code === 'KeyD') {
    rotateAim(-0.055 * fine);
  } else if (event.code === 'ArrowUp' || event.code === 'KeyW') {
    manualPowerTouched = true;
    chargePower = THREE.MathUtils.clamp(chargePower + 0.05, 0.08, 1);
  } else if (event.code === 'ArrowDown' || event.code === 'KeyS') {
    manualPowerTouched = true;
    chargePower = THREE.MathUtils.clamp(chargePower - 0.05, 0.08, 1);
  } else if (event.code === 'KeyR' && !multiplayerMode) {
    resetMatch();
  }
}) as EventListener);

listen(window, 'keyup', ((event: KeyboardEvent) => {
  if (event.code === 'Space') {
    event.preventDefault();
    endCharge();
  }
}) as EventListener);

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
let immersive = false;

function fullscreenActive(): boolean {
  const d = document as FsDoc;
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement) || immersive;
}

function setImmersive(on: boolean): void {
  immersive = on;
  (app!.closest('.pool-game-shell') as HTMLElement | null)?.classList.toggle('pg-immersive', on);
  hud.setFullscreenOn(fullscreenActive());
  onResize();
}

/** True fullscreen where the browser allows it (Chrome/Edge/Firefox/Android, iPadOS Safari); otherwise an immersive layout. */
function toggleFullscreen(): void {
  const d = document as FsDoc;
  const shell = (app!.closest('.pool-game-shell') as FsEl | null) ?? (document.documentElement as FsEl);
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) void d.exitFullscreen(); else d.webkitExitFullscreen?.();
      return;
    }
    if (immersive) { setImmersive(false); return; }
    const request = shell.requestFullscreen ? () => shell.requestFullscreen() : shell.webkitRequestFullscreen ? () => shell.webkitRequestFullscreen!() : null;
    if (!request) {
      // e.g. iPhone Safari: no Fullscreen API for pages. Use the immersive layout and say how to get a true full screen.
      setImmersive(true);
      window.scrollTo(0, 1);
      showBanner('Full screen: Share \u2192 Add to Home Screen', 'info');
      return;
    }
    Promise.resolve(request()).then(() => {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return orientation?.lock?.('landscape');
    }).catch(() => { if (!fullscreenActive()) setImmersive(true); }); // request refused: fall back to immersive
  } catch { setImmersive(true); }
}
listen(document, 'visibilitychange', (() => {
  if (document.hidden) return;
  clock.getDelta(); // discard the time spent in the background
  if (tracePlayback || cueAnimation || approvedQueue.length) fastForwardPlayback();
  if (multiplayerMode) window.dispatchEvent(new CustomEvent('pool-resync-needed'));
}) as EventListener);
const onFullscreenChange = (() => {
  if (!(document.fullscreenElement || (document as FsDoc).webkitFullscreenElement)) immersive = false;
  (app!.closest('.pool-game-shell') as HTMLElement | null)?.classList.toggle('pg-immersive', immersive);
  hud.setFullscreenOn(fullscreenActive());
  onResize();
}) as EventListener;
listen(document, 'fullscreenchange', onFullscreenChange);
listen(document, 'webkitfullscreenchange', onFullscreenChange);

function onResize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  composer.setSize(width, height);
  bloomPass.resolution.set(width, height);
  fxaaPass.material.uniforms.resolution.value.set(1 / width, 1 / height);
  ballVisualScale = ballVisualScaleFor(width);
  try { balls.forEach((b) => b.sphere.scale.setScalar(ballVisualScale)); } catch { /* balls not created yet */ }
  fitCamera();
}
listen(window, 'resize', onResize as EventListener);
listen(window, 'orientationchange', (() => window.setTimeout(onResize, 250)) as EventListener);
const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
resizeObserver?.observe(app);
cleanups.push(() => resizeObserver?.disconnect());

// ---- server-approved shot playback ---------------------------------------------------------------
// The shot is replayed from the SAME deterministic simulation module the server ran (lib/pool/
// authoritative.js), driving the existing ball meshes, and always ends by snapping every ball to
// the server's authoritative snapshot. Nothing the client animates can change the result.
function startApprovedShot(job: { start: any; power: number; angle: number; final: any; extra?: ApprovedShotExtra; local: boolean }): void {
  window.__POOL_GAME__.applyState(job.start);
  let trace: PoolTrace | null = null;
  try {
    const out = simulateShotTrace(job.start, job.power, job.angle, {
      spinX: job.extra?.spinX ?? 0, spinY: job.extra?.spinY ?? 0, cuePlacement: job.extra?.cuePlacement ?? null, trace: true,
    });
    trace = out.trace;
    // If this device's replay disagrees with the server about WHICH balls went down, do not animate a
    // wrong picture: show the authoritative result directly instead.
    const agrees = out.state.balls.every((b) => {
      const f = job.final.balls.find((q: any) => Number(q.id) === b.id);
      return !!f && Boolean(f.pocketed) === b.pocketed;
    });
    if (!agrees) trace = null;
  } catch {
    trace = null;
  }
  if (!trace) {
    finishApprovedShot(job.final, job.start);
    return;
  }
  const begin = (): void => {
    game.shot = createEmptyShotReport();
    game.shotInProgress = true;
    tracePlayback = { trace: trace as PoolTrace, t: 0, ev: 0, final: job.final, start: job.start, settle: 0 };
    const first = (trace as PoolTrace).frames[0];
    (trace as PoolTrace).ids.forEach((id, k) => {
      const ball = ballById(id);
      if (ball) { ball.body.position.x = first[k * 3]; ball.body.position.z = first[k * 3 + 1]; }
    });
  };
  if (job.local) {
    begin();
  } else {
    // Opponent's shot: show their cue draw back and strike before the balls move.
    if (job.extra?.cuePlacement) {
      const cue = getCueBall();
      cue.body.position.x = job.extra.cuePlacement.x;
      cue.body.position.z = job.extra.cuePlacement.z;
    }
    aimDir.set(Math.cos(job.angle), Math.sin(job.angle));
    const pull = 0.12 + job.power * 0.95;
    runCueAnimation(job.angle, { x: job.extra?.spinX ?? 0, y: job.extra?.spinY ?? 0 }, [{ dur: 0.5, from: 0.12, to: pull }, { dur: 0.09, from: pull, to: 0 }], () => {
      audio.cue(job.power);
      begin();
    });
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
  const axisVec = tempVec3;
  for (let k = 0; k < pb.trace.ids.length; k += 1) {
    const ball = ballById(pb.trace.ids[k]);
    if (!ball || ball.pocketed) continue;
    const f0 = frames[i0], f1 = frames[i1];
    if (f0[k * 3 + 2] === 1) continue;
    const toPocket = f1[k * 3 + 2] === 1;
    const x = f0[k * 3] + (f1[k * 3] - f0[k * 3]) * (toPocket ? 0 : a);
    const z = f0[k * 3 + 1] + (f1[k * 3 + 1] - f0[k * 3 + 1]) * (toPocket ? 0 : a);
    const dx = x - ball.body.position.x, dz = z - ball.body.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-5) {
      axisVec.set(dz, 0, -dx).normalize();
      ball.sphere.rotateOnWorldAxis(axisVec, d / ball.radius); // rolling, same as the original physics
    }
    ball.body.position.x = x;
    ball.body.position.z = z;
  }
  let clicks = 0;
  const events = pb.trace.events;
  while (pb.ev < events.length && events[pb.ev].f <= i0) {
    const e = events[pb.ev++];
    if (e.k === 'b') { if (clicks++ < 3) audio.ball(e.v); }
    else if (e.k === 'c') audio.cushion(e.v);
    else if (e.k === 'p') {
      const ball = ballById(e.id);
      if (ball && !ball.pocketed) pocketBall(ball, pockets[e.pocket]); // existing pocket handling (hides ball, plays sound)
    }
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
  window.__POOL_GAME__.applyState(final);
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
    showBanner(`Foul \u00b7 ${(last.reasons ?? []).join(', ')}`, 'bad');
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
      showBanner(mine ? (final.ballInHand ? 'Your turn \u00b7 ball in hand' : 'Your turn') : 'Opponent\u2019s turn', 'turn');
      audio.turn();
    }, delay);
  }
}

window.__POOL_GAME__ = {
  getState: getPublicState,
  aimAt: (x: number, z: number) => {
    lastPointerWorld.set(x, TABLE.surfaceY, z);
    setAimFromWorld(lastPointerWorld);
    return getPublicState();
  },
  setAimAngle: (angleRadians: number) => {
    aimDir.set(Math.cos(angleRadians), Math.sin(angleRadians));
    return getPublicState();
  },
  setPower: (value: number) => {
    manualPowerTouched = true;
    chargePower = THREE.MathUtils.clamp(value, 0.08, 1);
    return getPublicState();
  },
  shoot: (power = chargePower, angleRadians?: number) => {
    if (typeof angleRadians === 'number') aimDir.set(Math.cos(angleRadians), Math.sin(angleRadians));
    shoot(power);
    return getPublicState();
  },
  step: (frames = 60, dt = 1 / 60) => {
    for (let i = 0; i < frames; i += 1) update(dt);
    return getPublicState();
  },
  reset: () => {
    resetMatch();
    return getPublicState();
  },
  setMultiplayerMode: (enabled: boolean, playerIndex = 0, live = true) => {
    const becameLive = enabled && live && !multiplayerLive;
    const modeChanged = enabled !== multiplayerMode || playerIndex !== localPlayerIndex;
    multiplayerMode = enabled;
    multiplayerLive = live;
    localPlayerIndex = playerIndex === 1 ? 1 : 0;
    // The page calls this on every `matches` row update. Only a real change may clear a shot that is still
    // waiting for the server (otherwise the same shot could be submitted twice).
    if (becameLive || modeChanged) serverShotPending = false;
    if (enabled && !live) game.status = 'Waiting for both players to be ready\u2026';
    if (becameLive && game.turn === localPlayerIndex && !game.gameOver) showBanner(ballList.length && trayPocketed.size === 0 ? 'Break!' : 'Your turn', 'turn');
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
    const job = { start: startSnapshot, power, angle: angleRadians, final: finalSnapshot, extra, local: serverShotPending };
    serverShotPending = false;
    if (document.hidden) { // rAF is paused in background tabs: skip the animation, show the authoritative result now
      fastForwardPlayback();
      finishApprovedShot(finalSnapshot, startSnapshot);
      return getPublicState();
    }
    if (tracePlayback || cueAnimation) approvedQueue.push(job);
    else startApprovedShot(job);
    return getPublicState();
  },
  settleTo: (snapshot: any) => {
    approvedQueue.length = 0;
    try { fastForwardPlayback(); } catch { /* ignore */ }
    return window.__POOL_GAME__.applyState(snapshot);
  },
  applyState: (snapshot: any) => {
    if (!snapshot || !Array.isArray(snapshot.balls)) return getPublicState();
    serverShotPending = false;
    for (const remote of snapshot.balls) {
      const local = ballById(Number(remote.id));
      if (!local) continue;
      local.body.position.x = Number(remote.x) || 0;
      local.body.position.z = Number(remote.z) || 0;
      local.body.position.y = TABLE.surfaceY + TABLE.ballRadius;
      local.velocity.set(Number(remote.vx) || 0, Number(remote.vz) || 0);
      local.pocketed = Boolean(remote.pocketed);
      local.body.visible = !local.pocketed;
    }
    if (Array.isArray(snapshot.groups) && snapshot.groups.length >= 2) {
      game.players[0].group = snapshot.groups[0] ?? null;
      game.players[1].group = snapshot.groups[1] ?? null;
    }
    game.turn = Number(snapshot.currentPlayer) === 1 ? 1 : 0;
    ballInHand = Boolean(snapshot.ballInHand);
    placement = null;
    trayPocketed.clear();
    for (const remote of snapshot.balls) if (Number(remote.id) !== 0 && remote.pocketed) trayPocketed.add(Number(remote.id));
    game.gameOver = Boolean(snapshot.gameOver);
    game.status = typeof snapshot.status === 'string' ? snapshot.status : game.status;
    game.shotInProgress = Boolean(snapshot.shotInProgress);
    game.shot = createEmptyShotReport();
    lastHudKey = '';
    updateHUD();
    return getPublicState();
  },
  setPlayers: (players, localIndex) => {
    localPlayerIndex = localIndex;
    game.players[0].name = players[0].username.startsWith('@') ? players[0].username : `@${players[0].username}`;
    game.players[1].name = players[1].username.startsWith('@') ? players[1].username : `@${players[1].username}`;
    hud.setPlayers(players, localIndex);
    lastHudKey = '';
    onResize();
  },
  setStake: (amount) => hud.setStake(amount),
  setCountdown: (seconds) => hud.setCountdown(seconds),
  setTurnTimer: (playerIndex, secondsLeft, totalSeconds) => hud.setTurnTimer(playerIndex, secondsLeft, totalSeconds),
  setPaused: (value) => {
    paused = value;
    if (value) { charging = false; fineDirection = 0; }
    lastHudKey = '';
    updateHUD();
  },
  shotRejected: (message) => {
    serverShotPending = false;
    cueAnimation = null;
    if (message) showBanner(message.length > 48 ? 'Shot not accepted' : message, 'bad');
    lastHudKey = '';
    updateHUD();
  },
  setGuide: (full) => {
    guideFull = full;
    try { window.localStorage.setItem('squadbet.pool.guide.v2', full ? 'full' : 'line'); } catch { /* ignore */ }
  },
  setQuality: (quality) => {
    qualitySetting = quality;
    try { window.localStorage.setItem('squadbet.pool.quality', quality); } catch { /* ignore */ }
    applyQuality();
  },
  getSettings: () => ({ quality: qualitySetting, guideFull, sound: audio.isOn }),
  toggleSound: () => {
    audio.setEnabled(!audio.isOn);
    hud.setSoundOn(audio.isOn);
    return audio.isOn;
  },
  toggleFullscreen,
  dispose: () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    hud.dispose();
    audio.dispose();
    composer.dispose();
    scene.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m: THREE.Material) => { const mm = m as THREE.MeshStandardMaterial; mm.map?.dispose(); mm.dispose(); });
      }
    });
    ballEnvMap?.dispose();
    ballTextureCache.forEach((t) => t.dispose());
    ballTextureCache.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    window.__POOL_GAME__ = undefined as unknown as PublicPoolApi;
  },
};

/** Pixel ratio / shadow budget for the Quality setting. The scene itself is never altered. */
function applyQuality(): void {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const cores = navigator.hardwareConcurrency || 4;
  const auto = (cores <= 2 ? 'low' : coarse || window.innerWidth < 900 || cores <= 4 ? 'balanced' : 'high');
  const level = qualitySetting === 'auto' ? auto : qualitySetting;
  const cap = level === 'high' ? 2.5 : level === 'balanced' ? 2.2 : 1.25;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  composer.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, cap));
  bloomPass.enabled = level !== 'low';
  onResize();
}

buildRoom();
buildTable();
buildLights();
resetMatch();
applyQuality();
animate();
}
