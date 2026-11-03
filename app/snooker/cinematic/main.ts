import './style.css';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

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
};

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

window.__POOL_ERRORS__ = [];
window.addEventListener('error', (event) => {
  window.__POOL_ERRORS__.push(event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  window.__POOL_ERRORS__.push(String(event.reason));
});

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

app.innerHTML = `
  <div id="hud" aria-label="Cinematic Eight Ball Pool HUD">
    <div class="topbar">
      <section class="panel title" aria-live="polite">
        <span class="kicker">Three.js · Cinematic table top clone</span>
        <h1>Eight Ball Pool</h1>
        <div id="status">Rack is set. Aim with the mouse and hold Space or click to charge.</div>
      </section>
      <section class="panel score-grid" aria-label="Scoreboard">
        <article class="player-card active" id="player0">
          <div class="name"><span>Player 1</span><span id="turn0">At table</span></div>
          <div class="group" id="group0">Open table</div>
          <div class="mini-balls" id="balls0"></div>
        </article>
        <article class="player-card" id="player1">
          <div class="name"><span>Player 2</span><span id="turn1">Waiting</span></div>
          <div class="group" id="group1">Open table</div>
          <div class="mini-balls" id="balls1"></div>
        </article>
      </section>
    </div>
    <div id="shotBanner">Break with style</div>
    <div class="bottombar">
      <section class="panel controls">
        <strong>Controls</strong><br />
        Aim: <span class="key">Mouse / Touch</span> or <span class="key">←</span><span class="key">→</span> · Charge: hold <span class="key">Space</span> or left click · Fine power: <span class="key">↑</span><span class="key">↓</span> · Reset rack: <span class="key">R</span>
      </section>
      <section class="panel meter-panel" aria-label="Shot power">
        <div class="meter-label"><span>Shot power</span><span id="powerText">0%</span></div>
        <div class="power-track"><div id="powerFill"></div></div>
        <div class="mobile-shot" aria-label="Mobile shot controls">
          <button id="aimLeft" type="button">Aim -</button>
          <button id="shootButton" type="button">Shoot</button>
          <button id="aimRight" type="button">Aim +</button>
          <button id="resetButton" type="button">Rack</button>
        </div>
      </section>
    </div>
  </div>
`;

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const shotBannerEl = document.querySelector<HTMLDivElement>('#shotBanner')!;
const powerFillEl = document.querySelector<HTMLDivElement>('#powerFill')!;
const powerTextEl = document.querySelector<HTMLSpanElement>('#powerText')!;
const playerCards = [
  document.querySelector<HTMLElement>('#player0')!,
  document.querySelector<HTMLElement>('#player1')!,
];
const playerGroupEls = [
  document.querySelector<HTMLDivElement>('#group0')!,
  document.querySelector<HTMLDivElement>('#group1')!,
];
const turnEls = [
  document.querySelector<HTMLSpanElement>('#turn0')!,
  document.querySelector<HTMLSpanElement>('#turn1')!,
];
const miniBallEls = [
  document.querySelector<HTMLDivElement>('#balls0')!,
  document.querySelector<HTMLDivElement>('#balls1')!,
];

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.5;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);
scene.fog = new THREE.FogExp2(0x05070c, 0.028);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.05, 80);
camera.position.set(0, 6.7, 5.65);
const cameraLook = new THREE.Vector3(0, 0.08, 0);
camera.lookAt(cameraLook);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.23, 0.55, 0.78);
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
let chargePower = 0.44;
let charging = false;
let chargeDirection = 1;
let bannerTimer = 0;
let lastPointerWorld = new THREE.Vector3(0, 0, 0);
let manualPowerTouched = false;
let mobileAimInterval: number | null = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE.surfaceY);
const cameraTarget = new THREE.Vector3(0, 0.08, 0);
const tempVec3 = new THREE.Vector3();
const tempVec3B = new THREE.Vector3();
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

function makeBallTexture(id: number, kind: BallKind, color: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const colorStyle = `#${color.toString(16).padStart(6, '0')}`;

  if (kind === 'cue') {
    const gradient = ctx.createLinearGradient(0, 0, 512, 256);
    gradient.addColorStop(0, '#fffdf3');
    gradient.addColorStop(0.55, '#f2ead4');
    gradient.addColorStop(1, '#d8c9a8');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(120,100,70,0.08)';
    for (let i = 0; i < 60; i += 1) ctx.fillRect(Math.random() * 512, Math.random() * 256, 1, 1);
  } else if (kind === 'stripe') {
    ctx.fillStyle = '#f7f0dc';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = colorStyle;
    ctx.fillRect(0, 76, 512, 104);
  } else if (kind === 'eight') {
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, 512, 256);
  } else {
    ctx.fillStyle = colorStyle;
    ctx.fillRect(0, 0, 512, 256);
  }

  if (kind !== 'cue') {
    const badges = [130, 384];
    for (const x of badges) {
      ctx.save();
      ctx.translate(x, 128);
      ctx.fillStyle = '#fff8e8';
      ctx.beginPath();
      ctx.arc(0, 0, 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = '900 58px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(id), 0, 4);
      ctx.restore();
    }
  }

  const shine = ctx.createRadialGradient(160, 62, 8, 160, 62, 170);
  shine.addColorStop(0, 'rgba(255,255,255,0.78)');
  shine.addColorStop(0.24, 'rgba(255,255,255,0.18)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, 512, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
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
  const feltTexture = makeNoiseTexture('#106348', '#5ed3a1');
  feltTexture.repeat.set(4.5, 2.4);
  const feltMaterial = new THREE.MeshStandardMaterial({
    map: feltTexture,
    color: 0x13845e,
    roughness: 0.9,
    metalness: 0,
  });
  const woodTexture = makeNoiseTexture('#5a2f17', '#d09b5b');
  woodTexture.repeat.set(4, 1);
  const woodMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0x6d3a1c,
    roughness: 0.44,
    metalness: 0.08,
  });
  const rubberMaterial = new THREE.MeshStandardMaterial({ color: 0x07362a, roughness: 0.78, metalness: 0.02 });
  const brassMaterial = new THREE.MeshStandardMaterial({ color: 0xd69d4a, roughness: 0.26, metalness: 0.72 });
  const pocketMaterial = new THREE.MeshStandardMaterial({ color: 0x010104, roughness: 0.68, metalness: 0.0 });

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

  for (const pocket of pockets) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(pocket.radius * 0.98, pocket.radius * 1.06, 0.13, 48), pocketMaterial);
    cup.position.set(pocket.x, TABLE.surfaceY + 0.002, pocket.z);
    tableRoot.add(cup);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(pocket.radius * 1.02, 0.026, 10, 54), brassMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pocket.x, TABLE.surfaceY + 0.072, pocket.z);
    tableRoot.add(ring);
  }

  const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xe6c279, transparent: true, opacity: 0.9 });
  const markerGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.006, 24);
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
  const key = new THREE.SpotLight(0xffe6b8, 200, 22, Math.PI / 3.6, 0.55, 1.0);
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
  // so their contribution is identical on every device — the backbone of portable brightness.
  const wash = new THREE.DirectionalLight(0xffd9a0, 1.7);
  wash.position.set(1.6, 5.6, 1.4);
  wash.target.position.set(0, TABLE.surfaceY, 0);
  scene.add(wash, wash.target);

  // Cool fill from the near side to shape the balls and add cinematic color contrast.
  const fill = new THREE.DirectionalLight(0x9fc2ff, 1.0);
  fill.position.set(-3.2, 3.4, 3.6);
  fill.target.position.set(0, TABLE.surfaceY, 0);
  scene.add(fill, fill.target);

  // Cool rim / back light with shadow for depth and edge separation.
  const rim = new THREE.DirectionalLight(0xbcd6ff, 1.3);
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

  // Focused warm highlight over the head spot for cinematic pop.
  const spotlight = new THREE.SpotLight(0xffdda5, 70, 18, Math.PI / 5.2, 0.55, 1.0);
  spotlight.position.set(0.4, 5.55, 1.2);
  spotlight.target.position.set(0.1, TABLE.surfaceY, -0.05);
  spotlight.castShadow = true;
  spotlight.shadow.mapSize.set(1024, 1024);
  spotlight.shadow.bias = -0.0002;
  scene.add(spotlight, spotlight.target);
}

function createBall(id: number, x: number, z: number): Ball {
  const kind: BallKind = id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solid' : 'stripe';
  const color = id === 0 ? 0xfff8e9 : BALL_COLORS[id];
  const texture = makeBallTexture(id, kind, color);
  const material = new THREE.MeshPhysicalMaterial({
    map: texture,
    roughness: 0.31,
    metalness: 0.0,
    clearcoat: 0.68,
    clearcoatRoughness: 0.18,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(TABLE.ballRadius, 48, 32), material);
  sphere.castShadow = true;
  sphere.receiveShadow = true;

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
  new THREE.TorusGeometry(TABLE.ballRadius * 1.22, 0.008, 8, 42),
  new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.72 }),
);
ghostRing.rotation.x = Math.PI / 2;
ghostRing.renderOrder = 11;
scene.add(ghostRing);

const cueStick = new THREE.Group();
const cueLength = 1.78;
const cueShaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.017, 0.035, cueLength, 20),
  new THREE.MeshStandardMaterial({ color: 0xc18645, roughness: 0.4, metalness: 0.05 }),
);
const cueTip = new THREE.Mesh(
  new THREE.CylinderGeometry(0.021, 0.018, 0.08, 18),
  new THREE.MeshStandardMaterial({ color: 0x293f7c, roughness: 0.55 }),
);
cueTip.position.y = cueLength / 2 + 0.04;
const cueButt = new THREE.Mesh(
  new THREE.CylinderGeometry(0.045, 0.045, 0.18, 20),
  new THREE.MeshStandardMaterial({ color: 0x16100b, roughness: 0.35, metalness: 0.12 }),
);
cueButt.position.y = -cueLength / 2 - 0.07;
cueStick.add(cueShaft, cueTip, cueButt);
addShadowFlags(cueStick, true, false);
scene.add(cueStick);

function getCueBall(): Ball {
  const cue = balls.find((ball) => ball.id === 0);
  if (!cue) throw new Error('Cue ball missing');
  return cue;
}

function canShoot(): boolean {
  return !game.gameOver && !game.shotInProgress && !areBallsMoving() && !getCueBall().pocketed;
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
  if (!canShoot()) return;
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

function showBanner(message: string): void {
  shotBannerEl.textContent = message;
  shotBannerEl.classList.add('show');
  bannerTimer = 1.35;
}

function hideBannerSoon(dt: number): void {
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) shotBannerEl.classList.remove('show');
  }
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
  ball.body.visible = false;
  ball.body.position.set(pocket.x, TABLE.surfaceY - 0.18, pocket.z);
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
      ball.velocity.x = Math.abs(ball.velocity.x) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    } else if (pos.x > maxX) {
      pos.x = maxX;
      ball.velocity.x = -Math.abs(ball.velocity.x) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    }
    if (pos.z < minZ) {
      pos.z = minZ;
      ball.velocity.y = Math.abs(ball.velocity.y) * TABLE.cushionRestitution;
      nudgeFromPocketMouth(ball);
    } else if (pos.z > maxZ) {
      pos.z = maxZ;
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

function updateShotResolution(dt: number): void {
  if (!game.shotInProgress) return;
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
    showBanner('Foul · turn changes');
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
  minT = Math.min(...bounds, 5.2);

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

function updateAimVisuals(dt: number): void {
  const cue = getCueBall();
  const visible = canShoot();
  cueStick.visible = visible;
  aimLine.visible = visible;
  ghostRing.visible = visible;
  if (!visible) return;

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

  const dist = getAimLineDistance();
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

  const shotDir3 = new THREE.Vector3(aimDir.x, 0, aimDir.y).normalize();
  const drawBack = 0.18 + chargePower * 0.58;
  const center = cue.body.position.clone().addScaledVector(shotDir3, -(drawBack + cueLength / 2));
  cueStick.position.set(center.x, TABLE.surfaceY + TABLE.ballRadius * 1.08, center.z);
  cueStick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shotDir3);
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
  const targetPosition = tempVec3.set(focusX * 0.22, 6.72 + chargePower * 0.08, 5.72 + focusZ * 0.3);
  const alpha = 1 - Math.pow(0.0015, dt);
  camera.position.lerp(targetPosition, alpha);
  cameraLook.lerp(cameraTarget, alpha);
  camera.lookAt(cameraLook);
}

function updateHUD(): void {
  statusEl.textContent = game.status;
  powerFillEl.style.width = `${Math.round(chargePower * 100)}%`;
  powerTextEl.textContent = `${Math.round(chargePower * 100)}%`;

  for (let i = 0; i < 2; i += 1) {
    const player = game.players[i];
    playerCards[i].classList.toggle('active', game.turn === i && !game.gameOver);
    turnEls[i].textContent = game.turn === i && !game.gameOver ? 'At table' : game.gameOver ? 'Match over' : 'Waiting';
    playerGroupEls[i].textContent = player.group ? (player.group === 'solid' ? 'Solids' : 'Stripes') : 'Open table';
    const previewGroup: GroupKind = player.group ?? (i === 0 ? 'solid' : 'stripe');
    renderMiniBalls(miniBallEls[i], previewGroup);
  }
}

function renderMiniBalls(container: HTMLElement, group: GroupKind): void {
  const ids = group === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
  container.innerHTML = ids
    .map((id) => {
      const ball = ballById(id);
      const color = `#${BALL_COLORS[id].toString(16).padStart(6, '0')}`;
      const stripe = id >= 9;
      const bg = stripe ? `linear-gradient(180deg, #fff8df 0 27%, ${color} 27% 73%, #fff8df 73%)` : color;
      return `<span class="mini-ball ${ball?.pocketed ? 'pocketed' : ''}" style="background:${bg}">${id}</span>`;
    })
    .join('');
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
  rackBalls();
  showBanner('Fresh rack');
  updateHUD();
}

function update(dt: number): void {
  updatePhysics(dt);
  updateShotResolution(dt);
  updateAimVisuals(dt);
  updateCamera(dt);
  hideBannerSoon(dt);
  updateHUD();
}

function animate(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  composer.render();
  requestAnimationFrame(animate);
}

function getPublicState(): unknown {
  return {
    title: document.title,
    status: game.status,
    currentPlayer: game.turn,
    gameOver: game.gameOver,
    shotInProgress: game.shotInProgress,
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

renderer.domElement.addEventListener('pointermove', updatePointerFromEvent);
renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
  updatePointerFromEvent(event);
  if (event.button === 0) beginCharge();
});
window.addEventListener('pointerup', () => endCharge());
renderer.domElement.addEventListener('pointerleave', () => {
  if (charging) endCharge();
});

window.addEventListener('keydown', (event) => {
  if (event.repeat && event.code === 'Space') return;
  if (event.code === 'Space') {
    event.preventDefault();
    beginCharge();
  } else if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
    rotateAim(0.055);
  } else if (event.code === 'ArrowRight' || event.code === 'KeyD') {
    rotateAim(-0.055);
  } else if (event.code === 'ArrowUp' || event.code === 'KeyW') {
    manualPowerTouched = true;
    chargePower = THREE.MathUtils.clamp(chargePower + 0.05, 0.08, 1);
  } else if (event.code === 'ArrowDown' || event.code === 'KeyS') {
    manualPowerTouched = true;
    chargePower = THREE.MathUtils.clamp(chargePower - 0.05, 0.08, 1);
  } else if (event.code === 'KeyR') {
    resetMatch();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    endCharge();
  }
});

function wireMobileAim(buttonId: string, amount: number): void {
  const button = document.querySelector<HTMLButtonElement>(buttonId)!;
  button.addEventListener('pointerdown', () => {
    rotateAim(amount);
    mobileAimInterval = window.setInterval(() => rotateAim(amount), 55);
  });
  button.addEventListener('pointerup', () => {
    if (mobileAimInterval !== null) window.clearInterval(mobileAimInterval);
    mobileAimInterval = null;
  });
  button.addEventListener('pointerleave', () => {
    if (mobileAimInterval !== null) window.clearInterval(mobileAimInterval);
    mobileAimInterval = null;
  });
}
wireMobileAim('#aimLeft', 0.08);
wireMobileAim('#aimRight', -0.08);
document.querySelector<HTMLButtonElement>('#shootButton')!.addEventListener('pointerdown', beginCharge);
document.querySelector<HTMLButtonElement>('#shootButton')!.addEventListener('pointerup', endCharge);
document.querySelector<HTMLButtonElement>('#resetButton')!.addEventListener('click', resetMatch);

window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  composer.setSize(width, height);
  bloomPass.resolution.set(width, height);
  fxaaPass.material.uniforms.resolution.value.set(1 / width, 1 / height);
});

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
};

buildRoom();
buildTable();
buildLights();
resetMatch();
animate();
