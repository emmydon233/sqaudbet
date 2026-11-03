"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type Player = {
  name: string;
  color: string;
  hex: number;
  start: number;
};

const PLAYERS: Player[] = [
  { name: "Red", color: "#ef4444", hex: 0xef4444, start: 0 },
  { name: "Green", color: "#22c55e", hex: 0x22c55e, start: 13 },
  { name: "Yellow", color: "#facc15", hex: 0xfacc15, start: 26 },
  { name: "Blue", color: "#3b82f6", hex: 0x3b82f6, start: 39 },
];

const TRACK: [number, number][] = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],
];

const CELL = 0.76;
const point = (row: number, col: number) => ({
  x: (col - 7) * CELL,
  z: (row - 7) * CELL,
});

function tokenPosition(
  playerIndex: number,
  tokenIndex: number,
  progress: number,
  playerCount: number
) {
  const player = PLAYERS[playerIndex];
  if (playerCount === 2 && playerIndex !== 0 && playerIndex !== 2) {
    return { x: 0, z: 0, y: 0.55 };
  }

  if (progress < 0) {
    const homes = [
      { r: 2.2, c: 2.2 },
      { r: 2.2, c: 11.8 },
      { r: 11.8, c: 11.8 },
      { r: 11.8, c: 2.2 },
    ];
    const home = homes[playerIndex];
    const offsets = [
      [-0.7, -0.7],
      [0.7, -0.7],
      [-0.7, 0.7],
      [0.7, 0.7],
    ];
    const [dr, dc] = offsets[tokenIndex];
    const p = point(home.r + dr, home.c + dc);
    return { ...p, y: 0.55 };
  }

  const trackIndex = (player.start + progress) % TRACK.length;
  const [r, c] = TRACK[trackIndex];
  const p = point(r, c);
  return { ...p, y: 0.55 };
}

export default function LudoPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tokenMeshes = useRef<Record<string, THREE.Group>>({});
  const [playerCount, setPlayerCount] = useState<2 | 4>(2);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [dice, setDice] = useState(1);
  const [rolling, setRolling] = useState(false);
  const [message, setMessage] = useState("Roll the dice to begin.");
  const [turnReady, setTurnReady] = useState(true);
  const [progress, setProgress] = useState<number[][]>(
    PLAYERS.map(() => [-1, -1, -1, -1])
  );

  const activePlayers =
    playerCount === 2 ? [0, 2] : [0, 1, 2, 3];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101827");

    const camera = new THREE.PerspectiveCamera(
      38,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      0.1,
      100
    );
    camera.position.set(11, 16, 18);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.matchMedia("(max-width: 640px)").matches ? false : true,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.shadowMap.enabled = !window.matchMedia("(max-width: 640px)").matches;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x384151, 2.1));

    const light = new THREE.DirectionalLight(0xffffff, 3.2);
    light.position.set(7, 15, 9);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    scene.add(light);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(12.4, 0.35, 12.4),
      new THREE.MeshStandardMaterial({
        color: "#243247",
        roughness: 0.75,
        metalness: 0.12,
      })
    );
    floor.position.y = -0.28;
    floor.receiveShadow = true;
    floor.castShadow = true;
    scene.add(floor);

    const tileGeo = new THREE.BoxGeometry(
      CELL * 0.96,
      0.14,
      CELL * 0.96
    );

    const tile = (
      row: number,
      col: number,
      color: string,
      height = 0.05
    ) => {
      const p = point(row, col);
      const mesh = new THREE.Mesh(
        tileGeo,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.56,
          metalness: 0.05,
        })
      );
      mesh.position.set(p.x, height, p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    };

    // Four coloured home quarters.
    const homeColors = [
      "#a92436",
      "#176b42",
      "#b88b18",
      "#204fa8",
    ];

    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        let color = "#e8edf5";

        if (r < 6 && c < 6) color = homeColors[0];
        else if (r < 6 && c > 8) color = homeColors[1];
        else if (r > 8 && c > 8) color = homeColors[2];
        else if (r > 8 && c < 6) color = homeColors[3];

        const isTrack = TRACK.some(([tr, tc]) => tr === r && tc === c);
        if (isTrack) color = "#f8fafc";

        if (r >= 6 && r <= 8 && c >= 6 && c <= 8) {
          color = "#f1f5f9";
        }

        tile(r, c, color);
      }
    }

    // Raised home pads.
    const padGeo = new THREE.BoxGeometry(3.05, 0.16, 3.05);
    const pads = [
      { x: -3.45, z: -3.45, color: homeColors[0] },
      { x: 3.45, z: -3.45, color: homeColors[1] },
      { x: 3.45, z: 3.45, color: homeColors[2] },
      { x: -3.45, z: 3.45, color: homeColors[3] },
    ];

    for (const pad of pads) {
      const mesh = new THREE.Mesh(
        padGeo,
        new THREE.MeshStandardMaterial({
          color: pad.color,
          roughness: 0.42,
          metalness: 0.1,
        })
      );
      mesh.position.set(pad.x, 0.17, pad.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      scene.add(mesh);

      const inset = new THREE.Mesh(
        new THREE.BoxGeometry(2.55, 0.12, 2.55),
        new THREE.MeshStandardMaterial({
          color: "#f8fafc",
          roughness: 0.65,
        })
      );
      inset.position.set(pad.x, 0.29, pad.z);
      scene.add(inset);
    }

    // The middle home area.
    const center = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.2, 1.7),
      new THREE.MeshStandardMaterial({
        color: "#dbeafe",
        roughness: 0.4,
        metalness: 0.15,
      })
    );
    center.position.y = 0.25;
    center.castShadow = true;
    scene.add(center);

    // Token bases and shiny rounded pieces.
    tokenMeshes.current = {};
    const tokenGeo = new THREE.CylinderGeometry(0.22, 0.27, 0.34, 32);
    const topGeo = new THREE.SphereGeometry(0.2, 24, 16);

    PLAYERS.forEach((player, pi) => {
      for (let ti = 0; ti < 4; ti++) {
        const group = new THREE.Group();
        const material = new THREE.MeshStandardMaterial({
          color: player.hex,
          roughness: 0.25,
          metalness: 0.12,
        });

        const base = new THREE.Mesh(tokenGeo, material);
        base.position.y = 0.17;
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        const top = new THREE.Mesh(topGeo, material);
        top.position.y = 0.39;
        top.castShadow = true;
        group.add(top);

        scene.add(group);
        tokenMeshes.current[`${pi}-${ti}`] = group;
      }
    });

    // Small gold studs make the center look like a finished game board.
    for (let i = 0; i < 4; i++) {
      const stud = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 16, 12),
        new THREE.MeshStandardMaterial({
          color: "#fbbf24",
          metalness: 0.65,
          roughness: 0.22,
        })
      );
      const p = point(6 + (i > 1 ? 2 : 0), 6 + (i % 2 ? 2 : 0));
      stud.position.set(p.x, 0.42, p.z);
      scene.add(stud);
    }

    let frame = 0;
    const render = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    const resize = () => {
      if (!canvas) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      tokenMeshes.current = {};
    };
  }, []);

  // Keep the 3D token positions synchronized with the game state.
  useEffect(() => {
    PLAYERS.forEach((player, pi) => {
      for (let ti = 0; ti < 4; ti++) {
        const mesh = tokenMeshes.current[`${pi}-${ti}`];
        if (!mesh) continue;

        const p = tokenPosition(
          pi,
          ti,
          progress[pi][ti],
          playerCount
        );

        mesh.position.set(p.x, p.y, p.z);
        mesh.visible = playerCount === 4 || pi === 0 || pi === 2;
      }
    });
  }, [progress, playerCount]);

  function newGame(count: 2 | 4) {
    setPlayerCount(count);
    setProgress(PLAYERS.map(() => [-1, -1, -1, -1]));
    setCurrentPlayer(0);
    setDice(1);
    setTurnReady(true);
    setRolling(false);
    setMessage(`${count}-player game ready. Roll the dice!`);
  }

  function rollDice() {
    if (rolling || !turnReady) return;

    setRolling(true);
    setTurnReady(false);

    let ticks = 0;
    const interval = window.setInterval(() => {
      setDice(Math.floor(Math.random() * 6) + 1);
      ticks++;

      if (ticks >= 10) {
        window.clearInterval(interval);

        const result = Math.floor(Math.random() * 6) + 1;
        setDice(result);
        setRolling(false);

        const player = PLAYERS[activePlayers[currentPlayer]];
        setMessage(
          `${player.name} rolled ${result}. ${
            result === 6
              ? "Choose a token to bring out or move."
              : "Choose a token to move."
          }`
        );
      }
    }, 85);
  }

  function moveToken(tokenIndex: number) {
    if (rolling || turnReady) {
      setMessage("Roll the dice first.");
      return;
    }

    const pi = activePlayers[currentPlayer];
    const oldProgress = progress[pi][tokenIndex];

    if (oldProgress < 0 && dice !== 6) {
      setMessage("You need a 6 to bring a token onto the board.");
      return;
    }

    const nextProgress = oldProgress < 0 ? 0 : oldProgress + dice;

    if (nextProgress >= TRACK.length) {
      setMessage("That token reached the end of the track!");
    } else {
      setMessage(`${PLAYERS[pi].name} moved token ${tokenIndex + 1}.`);
    }

    setProgress((previous) => {
      const next = previous.map((tokens) => [...tokens]);
      next[pi][tokenIndex] =
        nextProgress >= TRACK.length ? TRACK.length - 1 : nextProgress;
      return next;
    });

    // A six earns another turn in Ludo.
    if (dice === 6) {
      setTurnReady(true);
      setMessage("You rolled a 6! Take another turn.");
    } else {
      setCurrentPlayer((previous) => (previous + 1) % activePlayers.length);
      setTurnReady(true);
    }
  }

  const active = PLAYERS[activePlayers[currentPlayer]];

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-950 px-3 py-4 text-white sm:px-6 sm:py-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cyan-400">
              SquadBet Arcade
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
              3D Ludo
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Roll the dice. Move your tokens. Beat your friends.
            </p>
          </div>
          <a
            href="/dashboard"
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-800"
          >
            Back to dashboard
          </a>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-widest text-slate-400">
                  Current turn
                </p>
                <p className="mt-1 font-bold" style={{ color: active.color }}>
                  {active.name} player
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => newGame(2)}
                  className={`rounded-lg px-3 py-2 text-sm font-bold ${
                    playerCount === 2
                      ? "bg-cyan-400 text-slate-950"
                      : "bg-slate-800 text-slate-300"
                  }`}
                >
                  2 players
                </button>
                <button
                  onClick={() => newGame(4)}
                  className={`rounded-lg px-3 py-2 text-sm font-bold ${
                    playerCount === 4
                      ? "bg-cyan-400 text-slate-950"
                      : "bg-slate-800 text-slate-300"
                  }`}
                >
                  4 players
                </button>
              </div>
            </div>

            <div className="relative h-[min(92vw,390px)] min-h-[280px] w-full sm:h-[560px]">
              <canvas
                ref={canvasRef}
                className="h-full w-full touch-pan-y"
                style={{ touchAction: "pan-y" }}
                aria-label="Three-dimensional Ludo game board"
              />
              <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-300 backdrop-blur">
                3D board preview
              </div>
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm font-semibold text-slate-400">Dice roll</p>
              <div
                className={`my-5 flex h-24 w-24 items-center justify-center rounded-2xl border border-slate-600 bg-white text-5xl font-black text-slate-950 shadow-xl ${
                  rolling ? "animate-bounce" : ""
                }`}
              >
                {["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][dice - 1]}
              </div>
              <button
                onClick={rollDice}
                disabled={rolling || !turnReady}
                type="button"
                className="min-h-12 w-full touch-manipulation rounded-xl bg-cyan-400 px-4 py-3 font-extrabold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rolling ? "Rolling..." : "Roll dice"}
              </button>
              <p className="mt-4 min-h-12 text-sm leading-6 text-slate-300">
                {message}
              </p>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 font-bold">Move a token</h2>
              <p className="mb-4 text-xs leading-5 text-slate-400">
                Roll first, then select one of your four tokens. A token in
                the yard needs a six to enter the track.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((tokenIndex) => (
                  <button
                    key={tokenIndex}
                    onClick={() => moveToken(tokenIndex)}
                    type="button"
                    className="min-h-12 touch-manipulation rounded-xl border border-slate-700 bg-slate-800 px-3 py-3 text-sm font-bold hover:border-cyan-400 hover:bg-slate-700"
                  >
                    Token {tokenIndex + 1}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 font-bold">Players</h2>
              <div className="space-y-3">
                {activePlayers.map((pi, turnIndex) => (
                  <div key={pi} className="flex items-center gap-3">
                    <span
                      className="h-4 w-4 rounded-full ring-2 ring-white/10"
                      style={{ backgroundColor: PLAYERS[pi].color }}
                    />
                    <span className="flex-1 text-sm font-semibold">
                      {PLAYERS[pi].name}
                    </span>
                    {turnIndex === currentPlayer && (
                      <span className="rounded-full bg-cyan-400/10 px-2 py-1 text-xs text-cyan-300">
                        Turn
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>

        <p className="mt-5 text-center text-xs leading-5 text-slate-500">
          Early playable prototype. Online multiplayer, complete official Ludo
          rules, match results, and wallet-backed stakes are not connected yet.
        </p>
      </div>
    </main>
  );
}
