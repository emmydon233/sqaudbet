"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type Ball = {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  vx: number;
  vz: number;
  number: number;
  sunk: boolean;
};

const TABLE_X = 2.4;
const TABLE_Z = 1.2;
const R = 0.043;
const POCKET_R = 0.087;
const POCKETS: [number, number][] = [
  [-TABLE_X / 2, -TABLE_Z / 2],
  [0, -TABLE_Z / 2],
  [TABLE_X / 2, -TABLE_Z / 2],
  [-TABLE_X / 2, TABLE_Z / 2],
  [0, TABLE_Z / 2],
  [TABLE_X / 2, TABLE_Z / 2],
];

const ballColors = [
  0xffffff, 0xffd21c, 0x2468db, 0xe73535, 0x7728a5,
  0xff7920, 0x159447, 0x8c1725, 0x171717, 0xffd21c,
  0x2468db, 0xe73535, 0x7728a5, 0xff7920, 0x159447,
  0x8c1725,
];

export default function PoolGame() {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<{
    balls: Ball[];
    direction: number;
    power: number;
    moving: boolean;
    cue: THREE.Mesh | null;
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
  } | null>(null);

  const [power, setPower] = useState(55);
  const [aim, setAim] = useState(0);
  const [status, setStatus] = useState("Your turn — aim and take your shot");
  const [ballsLeft, setBallsLeft] = useState(15);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07120f");

    const camera = new THREE.PerspectiveCamera(
      38,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.1,
      100
    );
    camera.position.set(0, 2.8, 3.2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x26352b, 2));

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(-2, 5, 3);
    light.castShadow = true;
    scene.add(light);

    const wood = new THREE.MeshStandardMaterial({
      color: "#633b22",
      roughness: 0.32,
      metalness: 0.05,
    });
    const felt = new THREE.MeshStandardMaterial({
      color: "#087346",
      roughness: 0.9,
    });
    const dark = new THREE.MeshStandardMaterial({ color: "#101510" });

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(5, 0.12, 3.4),
      new THREE.MeshStandardMaterial({ color: "#14231c", roughness: 0.95 })
    );
    floor.position.y = -0.23;
    floor.receiveShadow = true;
    scene.add(floor);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_X + 0.3, 0.2, TABLE_Z + 0.3),
      wood
    );
    frame.position.y = -0.09;
    frame.castShadow = true;
    frame.receiveShadow = true;
    scene.add(frame);

    const cloth = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_X, 0.035, TABLE_Z),
      felt
    );
    cloth.position.y = 0.025;
    cloth.receiveShadow = true;
    scene.add(cloth);

    const railMaterial = new THREE.MeshStandardMaterial({
      color: "#155a3d",
      roughness: 0.55,
    });

    // Six dark pockets and four cushioned rails.
    for (const [x, z] of POCKETS) {
      const pocket = new THREE.Mesh(
        new THREE.CylinderGeometry(POCKET_R, POCKET_R * 0.92, 0.025, 32),
        dark
      );
      pocket.position.set(x, 0.048, z);
      scene.add(pocket);
    }

    const railThickness = 0.085;
    for (const z of [-TABLE_Z / 2 - railThickness / 2, TABLE_Z / 2 + railThickness / 2]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(TABLE_X + 0.13, 0.085, railThickness),
        railMaterial
      );
      rail.position.set(0, 0.055, z);
      rail.castShadow = true;
      scene.add(rail);
    }
    for (const x of [-TABLE_X / 2 - railThickness / 2, TABLE_X / 2 + railThickness / 2]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(railThickness, 0.085, TABLE_Z - 0.02),
        railMaterial
      );
      rail.position.set(x, 0.055, 0);
      rail.castShadow = true;
      scene.add(rail);
    }

    // Subtle table markings.
    const lineMaterial = new THREE.MeshBasicMaterial({
      color: "#c5e6d4",
      transparent: true,
      opacity: 0.3,
    });
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(0.004, 0.002, TABLE_Z * 0.86),
      lineMaterial
    );
    line.position.set(-TABLE_X * 0.22, 0.045, 0);
    scene.add(line);

    const balls: Ball[] = [];
    const ballGeometry = new THREE.SphereGeometry(R, 24, 18);

    function addBall(number: number, x: number, z: number) {
      const material = new THREE.MeshStandardMaterial({
        color: ballColors[number],
        roughness: 0.22,
        metalness: 0.03,
      });
      const mesh = new THREE.Mesh(ballGeometry, material);
      mesh.position.set(x, 0.045 + R, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      balls.push({ mesh, x, z, vx: 0, vz: 0, number, sunk: false });
    }

    function rackBalls() {
      for (const ball of balls) scene.remove(ball.mesh);
      balls.length = 0;

      addBall(0, -0.72, 0);

      // Fifteen object balls in a triangular rack.
      const startX = 0.42;
      const spacing = R * 2.08;
      let n = 1;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col <= row; col++) {
          const z = (col - row / 2) * spacing;
          addBall(n, startX + row * spacing * 0.87, z);
          n++;
        }
      }
    }

    rackBalls();

    const cueMaterial = new THREE.MeshStandardMaterial({
      color: "#e6c69a",
      roughness: 0.4,
    });
    const cue = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.015, 0.85, 12),
      cueMaterial
    );
    cue.rotation.x = Math.PI / 2;
    cue.position.y = 0.07;
    scene.add(cue);

    const state = {
      balls,
      direction: 0,
      power,
      moving: false,
      cue,
      scene,
      renderer,
    };
    game.current = state;

    let animationFrame = 0;
    let lastTime = 0;
    let sunkCount = 0;

    function updateCue() {
      const cueBall = balls.find((b) => b.number === 0 && !b.sunk);
      if (!cueBall || state.moving) {
        cue.visible = false;
        return;
      }
      cue.visible = true;
      cue.position.set(
        cueBall.x - Math.cos(state.direction) * 0.49,
        0.075,
        cueBall.z - Math.sin(state.direction) * 0.49
      );
      cue.rotation.set(0, -state.direction, Math.PI / 2);
    }

    function animate(time: number) {
      animationFrame = requestAnimationFrame(animate);
      const dt = Math.min((time - (lastTime || time)) / 1000, 0.025);
      lastTime = time;

      if (state.moving && dt > 0) {
        let anyMoving = false;

        for (const b of balls) {
          if (b.sunk) continue;

          b.x += b.vx * dt;
          b.z += b.vz * dt;

          const speed = Math.hypot(b.vx, b.vz);
          if (speed > 0) {
            const nextSpeed = Math.max(0, speed - 0.8 * dt);
            b.vx = (b.vx / speed) * nextSpeed;
            b.vz = (b.vz / speed) * nextSpeed;
          }

          const edgeX = TABLE_X / 2 - R;
          const edgeZ = TABLE_Z / 2 - R;
          if (Math.abs(b.x) > edgeX) {
            b.x = Math.sign(b.x) * edgeX;
            b.vx *= -0.78;
          }
          if (Math.abs(b.z) > edgeZ) {
            b.z = Math.sign(b.z) * edgeZ;
            b.vz *= -0.78;
          }

          for (const [px, pz] of POCKETS) {
            if (Math.hypot(b.x - px, b.z - pz) < POCKET_R * 0.78) {
              b.sunk = true;
              scene.remove(b.mesh);
              b.vx = 0;
              b.vz = 0;
              if (b.number === 0) {
                setStatus("Scratch! Cue ball pocketed. Reset the table to play again.");
                state.moving = false;
                setBusy(false);
              } else {
                sunkCount++;
                setBallsLeft(Math.max(0, 15 - sunkCount));
                setStatus(
                  b.number === 8
                    ? "8-ball pocketed! This local practice round is finished."
                    : `Ball ${b.number} pocketed`
                );
              }
              break;
            }
          }

          if (!b.sunk && Math.hypot(b.vx, b.vz) > 0.015) anyMoving = true;
          else {
            b.vx = 0;
            b.vz = 0;
          }

          b.mesh.position.set(b.x, 0.045 + R, b.z);
        }

        // Equal-mass sphere collisions, simulated on the table plane.
        for (let i = 0; i < balls.length; i++) {
          const a = balls[i];
          if (a.sunk) continue;
          for (let j = i + 1; j < balls.length; j++) {
            const b = balls[j];
            if (b.sunk) continue;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const distance = Math.hypot(dx, dz);
            if (distance > 0 && distance < R * 2) {
              const nx = dx / distance;
              const nz = dz / distance;
              const overlap = R * 2 - distance;
              a.x -= nx * overlap * 0.5;
              a.z -= nz * overlap * 0.5;
              b.x += nx * overlap * 0.5;
              b.z += nz * overlap * 0.5;
              const relative = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
              if (relative > 0) {
                a.vx -= relative * nx;
                a.vz -= relative * nz;
                b.vx += relative * nx;
                b.vz += relative * nz;
              }
            }
          }
        }

        if (!anyMoving) {
          state.moving = false;
          setBusy(false);
          setStatus("Balls stopped — your next shot is ready.");
        }
      }

      updateCue();
      renderer.render(scene, camera);
    }

    animate(0);

    const resize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / Math.max(container.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m) => m.dispose());
        }
      });
      game.current = null;
    };
  }, []);

  function shoot() {
    const g = game.current;
    if (!g || g.moving) return;
    const cueBall = g.balls.find((b) => b.number === 0 && !b.sunk);
    if (!cueBall) {
      setStatus("Cue ball is pocketed. Reset the table to start a new round.");
      return;
    }
    g.direction = aim;
    g.power = power;
    cueBall.vx = Math.cos(aim) * (power / 100) * 2.8;
    cueBall.vz = Math.sin(aim) * (power / 100) * 2.8;
    g.moving = true;
    setBusy(true);
    setStatus("Shot in progress…");
  }

  function resetGame() {
    window.location.reload();
  }

  return (
    <main className="flex h-dvh min-h-[520px] flex-col overflow-hidden bg-[#07120f] text-white">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/30 px-3 py-3 sm:px-5">
        <a href="/" className="rounded-lg border border-white/20 px-3 py-2 text-sm">
          ← SquadBet
        </a>
        <div className="text-center">
          <h1 className="text-sm font-bold tracking-wide sm:text-lg">SQUADBET POOL</h1>
          <p className="text-[10px] text-emerald-300 sm:text-xs">8-Ball · 3D Practice</p>
        </div>
        <button
          onClick={resetGame}
          className="rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/10 sm:text-sm"
        >
          New game
        </button>
      </header>

      <section className="flex min-h-0 flex-1 flex-col">
        <div ref={host} className="min-h-0 flex-1" />

        <div className="space-y-3 border-t border-white/10 bg-[#0b1b14] p-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
            <span className="text-emerald-200">{status}</span>
            <span className="shrink-0 text-white/60">Object balls left: {ballsLeft}</span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              disabled={busy}
              onClick={() => setAim((v) => v - 0.08)}
              className="rounded-xl border border-white/20 px-4 py-3 text-lg disabled:opacity-40"
              aria-label="Aim left"
            >
              ↶
            </button>

            <div className="flex min-w-[145px] flex-1 flex-col gap-1 px-2 sm:max-w-xs">
              <label className="flex justify-between text-xs text-white/70">
                <span>Shot power</span><span>{power}%</span>
              </label>
              <input
                type="range"
                min="10"
                max="100"
                value={power}
                disabled={busy}
                onChange={(e) => setPower(Number(e.target.value))}
                className="w-full accent-emerald-400"
              />
            </div>

            <button
              disabled={busy}
              onClick={() => setAim((v) => v + 0.08)}
              className="rounded-xl border border-white/20 px-4 py-3 text-lg disabled:opacity-40"
              aria-label="Aim right"
            >
              ↷
            </button>

            <button
              disabled={busy}
              onClick={shoot}
              className="rounded-xl bg-emerald-500 px-6 py-3 font-extrabold text-[#06130c] shadow-lg disabled:cursor-not-allowed disabled:opacity-40"
            >
              SHOOT
            </button>
          </div>
          <p className="text-center text-[10px] text-white/40">
            Practice build · Local play only · Online matches and stakes are not connected yet
          </p>
        </div>
      </section>
    </main>
  );
}
