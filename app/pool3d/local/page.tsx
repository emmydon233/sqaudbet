"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import "./../pool-game.css";

type LocalResult = {
  gameOver?: boolean;
  winnerPlayer?: number | null;
  status?: string;
};

export default function LocalPoolPage() {
  const [playerOne, setPlayerOne] = useState("Player 1");
  const [playerTwo, setPlayerTwo] = useState("Player 2");
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<LocalResult | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [engineError, setEngineError] = useState("");

  useEffect(() => {
    if (!started) return;

    let disposed = false;

    const handleSettled = (event: Event) => {
      const detail = (event as CustomEvent<LocalResult>).detail;
      if (detail?.gameOver) setResult(detail);
    };

    const handlePoolUi = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail;
      if (detail?.action === "exit") setConfirmExit(true);
    };

    const mount = async () => {
      try {
        const cinematic = await import("../../snooker/cinematic/main2d");
        if (disposed) return;

        cinematic.mountCinematicPool();

        const api = window.__POOL_GAME__;
        if (!api) throw new Error("The Pool engine did not initialise.");

        api.setPlayers(
          [
            {
              id: "local-player-1",
              username: playerOne.trim() || "Player 1",
              avatarUrl: null,
              stats: null,
            },
            {
              id: "local-player-2",
              username: playerTwo.trim() || "Player 2",
              avatarUrl: null,
              stats: null,
            },
          ],
          0
        );

        api.setStake(null);
        api.setMultiplayerMode(false, 0, true);

        window.addEventListener("pool-shot-settled", handleSettled);
        window.addEventListener("pool-ui", handlePoolUi);
      } catch (error) {
        setEngineError(
          error instanceof Error ? error.message : "Could not start the Pool game."
        );
      }
    };

    void mount();

    return () => {
      disposed = true;
      window.removeEventListener("pool-shot-settled", handleSettled);
      window.removeEventListener("pool-ui", handlePoolUi);

      if (window.__POOL_GAME__) {
        window.__POOL_GAME__.dispose();
      }
    };
  }, [started, playerOne, playerTwo]);

  const restart = () => {
    window.__POOL_GAME__?.reset();
    setResult(null);
  };

  const leaveGame = () => {
    setConfirmExit(false);
    setStarted(false);
    setResult(null);
    window.location.href = "/dashboard";
  };

  if (!started) {
    return (
      <main className="local-pool-setup">
        <section className="local-pool-setup-card">
          <div className="local-pool-kicker">SQUADBET · PRACTICE MODE</div>
          <h1>Local 1v1 Pool</h1>
          <p>
            Two players. One device. Take turns on the same cinematic 3D
            eight-ball table.
          </p>

          <label htmlFor="local-player-one">Player 1</label>
          <input
            id="local-player-one"
            value={playerOne}
            maxLength={20}
            onChange={(event) => setPlayerOne(event.target.value)}
            placeholder="Enter player 1 name"
          />

          <label htmlFor="local-player-two">Player 2</label>
          <input
            id="local-player-two"
            value={playerTwo}
            maxLength={20}
            onChange={(event) => setPlayerTwo(event.target.value)}
            placeholder="Enter player 2 name"
          />

          {engineError && <p className="local-pool-error">{engineError}</p>}

          <button
            className="local-pool-start"
            onClick={() => {
              setEngineError("");
              setStarted(true);
            }}
          >
            Start local game
          </button>

          <Link className="local-pool-back" href="/dashboard">
            Back to dashboard
          </Link>

          <small>
            Local practice only · No challenge · No stake · No wallet activity
          </small>
        </section>

        <style jsx>{`
          .local-pool-setup {
            min-height: 100dvh;
            display: grid;
            place-items: center;
            padding: 24px;
            color: #eef2f6;
            background: radial-gradient(ellipse at 50% 35%, #14251f, #05080c 72%);
            font-family: var(--font-geist-sans), system-ui, sans-serif;
          }
          .local-pool-setup-card {
            width: min(100%, 440px);
            display: flex;
            flex-direction: column;
            gap: 13px;
            padding: 30px;
            border: 1px solid rgba(255,255,255,.12);
            border-radius: 20px;
            background: rgba(10,17,20,.92);
            box-shadow: 0 24px 80px rgba(0,0,0,.4);
          }
          .local-pool-kicker {
            color: #34d399;
            font-size: 11px;
            font-weight: 800;
            letter-spacing: .16em;
          }
          h1 { margin: 0; font-size: 30px; }
          p { margin: 0 0 8px; color: #aab6c1; line-height: 1.55; }
          label { margin-top: 8px; color: #dce5e9; font-size: 13px; font-weight: 700; }
          input {
            width: 100%;
            padding: 13px 14px;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 10px;
            color: white;
            background: #10191d;
            outline: none;
          }
          input:focus { border-color: #34d399; }
          button {
            border: 0;
            border-radius: 10px;
            padding: 14px;
            color: #04120c;
            background: #34d399;
            font-weight: 800;
            cursor: pointer;
          }
          .local-pool-start { margin-top: 12px; }
          .local-pool-back { color: #d1d9df; text-align: center; text-decoration: none; font-size: 13px; }
          small { margin-top: 8px; color: #7f8c96; text-align: center; line-height: 1.5; }
          .local-pool-error { color: #fca5a5; font-size: 13px; }
        `}</style>
      </main>
    );
  }

  return (
    <main className="pool-game-shell pg-root">
      <div id="pool-host" />

      <div className="local-pool-topbar">
        <span>LOCAL 1V1 · PRACTICE</span>
        <button onClick={() => setConfirmExit(true)}>Exit game</button>
      </div>

      {result?.gameOver && (
        <div className="local-pool-result">
          <section>
            <span className="local-pool-result-kicker">MATCH COMPLETE</span>
            <h2>
              {Number(result.winnerPlayer) === 0
                ? playerOne
                : playerTwo}{" "}
              wins!
            </h2>
            <p>{result.status || "Well played."}</p>
            <button onClick={restart}>Play again</button>
            <button className="secondary" onClick={() => setConfirmExit(true)}>
              Exit to dashboard
            </button>
          </section>
        </div>
      )}

      {confirmExit && (
        <div className="local-pool-result">
          <section>
            <h2>Leave this game?</h2>
            <p>Your local match will end. No wallet or challenge is affected.</p>
            <button onClick={leaveGame}>Yes, leave game</button>
            <button className="secondary" onClick={() => setConfirmExit(false)}>
              Keep playing
            </button>
          </section>
        </div>
      )}

      {engineError && (
        <div className="local-pool-result">
          <section>
            <h2>Could not load Pool</h2>
            <p>{engineError}</p>
            <button onClick={leaveGame}>Return to dashboard</button>
          </section>
        </div>
      )}

      <style jsx>{`
        .local-pool-topbar {
          position: absolute;
          z-index: 8;
          top: max(12px, env(safe-area-inset-top));
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 10px 7px 14px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 999px;
          background: rgba(5,10,14,.78);
          color: #34d399;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .1em;
          white-space: nowrap;
        }
        .local-pool-topbar button, .local-pool-result button {
          border: 0;
          border-radius: 8px;
          padding: 9px 13px;
          color: #04120c;
          background: #34d399;
          font-weight: 800;
          cursor: pointer;
        }
        .local-pool-result {
          position: absolute;
          z-index: 20;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 20px;
          background: rgba(0,0,0,.72);
          backdrop-filter: blur(8px);
        }
        .local-pool-result section {
          width: min(100%, 380px);
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 28px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 18px;
          background: #0b1418;
          color: #eef2f6;
          text-align: center;
        }
        .local-pool-result h2 { margin: 0; font-size: 26px; }
        .local-pool-result p { margin: 0; color: #aab6c1; line-height: 1.5; }
        .local-pool-result-kicker { color: #34d399; font-size: 11px; font-weight: 800; letter-spacing: .15em; }
        .local-pool-result button.secondary { color: #eef2f6; background: #26343b; }
      `}</style>
    </main>
  );
}
