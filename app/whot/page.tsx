"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { supabase } from "@/utils/supabase/client";
import { queueGameResultPopup } from "../../lib/naija/popup-bus";

type Shape = "Circle" | "Triangle" | "Cross" | "Square" | "Star";
type Card = { id: number; shape: Shape | "Whot"; value: number };
type GameData = {
  myHand: Card[];
  opponentCardCount: number;
  topCard: Card | null;
  turn: string | null;
  chosenShape: Shape | null;
  status: string;
  message: string;
  mustDraw: number;
  skipNext: boolean;
  deckCount: number;
  settlementStatus: string;
  winnerId: string | null;
  endReason: string | null;
  draw?: boolean;
  player1HighestCard?: number | null;
  player2HighestCard?: number | null;
  isMyTurn: boolean;
  player1DisconnectedAt?: string | null;
  player2DisconnectedAt?: string | null;
  pauseStartedAt?: number | null;
  serverNow?: number;
  paused?: boolean;
  player1LastSeen?: string | null;
  player2LastSeen?: string | null;
  match?: {
    status?: string;
    player1_ready?: boolean;
    player2_ready?: boolean;
    player1_id?: string;
    player2_id?: string;
  };
};

const SHAPES: Shape[] = ["Circle", "Triangle", "Cross", "Square", "Star"];

function shapeSymbol(shape: Shape): string {
  return ({ Circle: "\u25CF", Triangle: "\u25B2", Cross: "\u271A", Square: "\u25A0", Star: "\u2605" })[shape];
}

function shapeColor(shape: Shape | "Whot"): string {
  if (shape === "Whot") return "border-amber-400 text-amber-300";
  return ({
    Circle: "border-sky-400 text-sky-300",
    Triangle: "border-orange-400 text-orange-300",
    Cross: "border-pink-400 text-pink-300",
    Square: "border-emerald-400 text-emerald-300",
    Star: "border-violet-400 text-violet-300",
  })[shape];
}

function PlayingCard({
  card,
  disabled = true,
  onClick,
  small = false,
}: {
  card: Card;
  disabled?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  const isWhot = card.shape === "Whot";
  const imageName = isWhot ? "star" : card.shape.toLowerCase();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-label={`${card.shape} ${card.value}`}
      className={[
        "relative flex shrink-0 flex-col items-center justify-between rounded-xl border-2 border-[#c62828] bg-white text-[#b71c1c] font-bold shadow-lg transition-all duration-150",

        small ? "h-20 w-14 p-1.5" : "h-28 w-[4.5rem] p-2 sm:h-32 sm:w-20 sm:p-3",
        onClick && !disabled ? "cursor-pointer hover:-translate-y-2 hover:bg-red-50" : "",
        disabled ? "cursor-not-allowed opacity-45" : "",
        isWhot ? "bg-[#fff1f1] ring-2 ring-[#c62828]" : "",
      ].join(" ")}
    >
      <span className="self-start text-xs">{isWhot ? "20" : card.value}</span>
      <span className="flex flex-1 items-center justify-center">
        <img
          src={`/whot/shapes/${imageName}.png`}
          alt={`${card.shape} symbol`}
          className={small ? "h-7 w-7 object-contain" : "h-10 w-10 object-contain sm:h-12 sm:w-12"}
        />
      </span>
      <span className="self-end text-[9px] uppercase tracking-wider">{isWhot ? "WHOT" : card.shape}</span>
    </button>
  );
}

export default function WhotPage() {
  const [matchId, setMatchId] = useState<string | null>(null);
  useEffect(() => { setMatchId(new URLSearchParams(window.location.search).get("matchId")); }, []);

  const [game, setGame] = useState<GameData | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const [choosingShape, setChoosingShape] = useState(false);
  const [clockNow, setClockNow] = useState(0);
  const [exitBusy, setExitBusy] = useState(false);
  const serverSkewRef = useRef(0); // server clock minus this device's clock, so the countdown never trusts the device clock
  const pausedRef = useRef(false);

  const getToken = useCallback(async () => {
    const { data, error: authError } = await supabase.auth.getSession();
    if (authError) throw authError;
    if (!data.session?.access_token) throw new Error("Your session has expired. Please sign in again.");
    return { token: data.session.access_token, id: data.session.user.id };
  }, []);

  const loadGame = useCallback(async (showLoader = false) => {
    if (!matchId) {
      setError("This Whot game has no match ID. Open it from your accepted challenge.");
      setLoading(false);
      return;
    }

    try {
      if (showLoader) setLoading(true);
      const { token, id } = await getToken();
      setUserId(id);

      const response = await fetch(`/api/whot/${matchId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.message || "Could not load this match.");

      // The API wraps the private, player-specific game view in `game`.
      // Keep the wrapper metadata separate from the actual game state.
      if (!result?.success) throw new Error(result?.error || "Could not load this match.");
      if (!result.started || !result.game) {
        setGame(null);
        setError("The Whot match has not started yet. Return to the match lobby and both players must select I'm Ready.");
        return;
      }
      if (typeof result.game.serverNow === "number") serverSkewRef.current = result.game.serverNow - Date.now();
      setGame({
        ...result.game,
        match: result.match,
        player1DisconnectedAt: result.game.player1DisconnectedAt ?? null,
        player2DisconnectedAt: result.game.player2DisconnectedAt ?? null,
      } as GameData);
      setError("");
      const text = String(result.game.message || "").toLowerCase();
      setChoosingShape(
        text.includes("choose a shape") ||
        text.includes("choose shape") ||
        text.includes("awaiting shape"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect to the Whot match.");
    } finally {
      setLoading(false);
    }
  }, [getToken, matchId]);

  useEffect(() => {
    void loadGame(true);
    const poll = window.setInterval(() => void loadGame(false), 1800);
    return () => window.clearInterval(poll);
  }, [loadGame]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!matchId) return;
    let stopped = false;

    const sendHeartbeat = async () => {
      try {
        const { token } = await getToken();
        if (stopped) return;
        await fetch(`/api/whot/${matchId}/heartbeat`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Polling will show the connection error; heartbeat retries on the next interval.
      }
    };

    void sendHeartbeat();
    const heartbeat = window.setInterval(() => void sendHeartbeat(), 5000);
    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
    };
  }, [getToken, matchId]);

  const sendAction = useCallback(async (
    action: "play" | "draw" | "market" | "choose_shape",
    cardId?: number,
    chosenShape?: Shape,
  ) => {
    if (!matchId || actionBusy || pausedRef.current) return; // frozen while a player is disconnected (server refuses too)
    setActionBusy(true);
    setError("");

    try {
      const { token } = await getToken();
      const response = await fetch(`/api/whot/${matchId}/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action,
          ...(cardId !== undefined ? { cardId } : {}),
          ...(chosenShape ? { chosenShape } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.message || "That move was rejected.");
      await loadGame(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your move could not be sent.");
      await loadGame(false);
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, getToken, loadGame, matchId]);

  const handleExitGame = async () => {
    if (!matchId || exitBusy) return;
    if (!window.confirm("Leave this match? Your opponent will get a 5-minute countdown. You may forfeit if you do not return.")) return;

    setExitBusy(true);
    setError("");

    try {
      const { token } = await getToken();
      const response = await fetch(`/api/whot/${matchId}/exit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Could not exit.");

      window.location.assign("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not exit.");
      setExitBusy(false);
    }
  };

  const playableIds = useMemo(() => {
    if (!game?.topCard) return new Set<number>();
    const activeShape = game.chosenShape ?? game.topCard.shape;
    return new Set(
      game.myHand
        .filter((card) =>
          card.shape === "Whot" ||
          card.shape === activeShape ||
          card.value === game.topCard?.value,
        )
        .map((card) => card.id),
    );
  }, [game]);

  const isFinished = Boolean(
    game && (
      game.status === "finished" ||
      game.status === "completed" ||
      game.status === "cancelled" ||
      game.settlementStatus === "paid" ||
      game.settlementStatus === "refunded" ||
      game.winnerId
    ),
  );

  const isWinner = Boolean(game?.winnerId && userId && game.winnerId === userId);
  useEffect(() => {
    if (!game || !matchId || !userId) return;
    if (game.settlementStatus !== "paid" || !game.winnerId) return;

    queueGameResultPopup("whot", matchId, userId, game.winnerId === userId);
  }, [game?.settlementStatus, game?.winnerId, matchId, userId]);
  // PAUSE: when EITHER player is disconnected the whole match is frozen for both players. The server refuses every
  // game action meanwhile (423); this only mirrors that so buttons are disabled and the reason is explained.
  const p1Gone = game?.player1DisconnectedAt ?? null;
  const p2Gone = game?.player2DisconnectedAt ?? null;
  const paused = Boolean(game && game.settlementStatus === "pending" && (p1Gone || p2Gone) && !isFinished);
  pausedRef.current = paused;
  const iAmPlayer1 = Boolean(game?.match && userId && game.match.player1_id === userId);
  const iAmDisconnected = Boolean(iAmPlayer1 ? p1Gone : p2Gone);
  const opponentDisconnectedAt = iAmPlayer1 ? p2Gone : p1Gone;
  // The 5-minute window started with the FIRST disconnect. Server timestamp + server clock offset.
  const firstGone = Number(game?.pauseStartedAt) > 0
    ? Number(game?.pauseStartedAt)
    : [p1Gone, p2Gone].filter(Boolean).map((t) => new Date(t as string).getTime()).sort((x, y) => x - y)[0];
  const disconnectDeadline = paused && Number.isFinite(firstGone) ? firstGone + 5 * 60 * 1000 : null;
  const disconnectSecondsLeft = disconnectDeadline
    ? Math.max(0, Math.ceil((disconnectDeadline - (clockNow + serverSkewRef.current)) / 1000))
    : null;
  const disconnectCountdown = disconnectSecondsLeft === null
    ? null
    : `${Math.floor(disconnectSecondsLeft / 60)}:${String(disconnectSecondsLeft % 60).padStart(2, "0")}`;
  const myTurn = Boolean(game?.isMyTurn && !isFinished && !choosingShape && !paused);

  const playCard = (card: Card) => {
    if (!myTurn || !playableIds.has(card.id) || actionBusy) return;
    void sendAction("play", card.id);
  };

  const chooseShape = (shape: Shape) => {
    void sendAction("choose_shape", undefined, shape);
    setChoosingShape(false);
  };

  if (loading && !game) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#07120e] text-white">
        Connecting to your Whot match...
      </main>
    );
  }

  if (!game) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#07120e] px-5 text-white">
        <div className="max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <h1 className="text-2xl font-black">WHOT.</h1>
          <p className="mt-3 text-sm text-rose-200">{error || "Match could not be loaded."}</p>
          <a href="/dashboard" className="mt-5 inline-block rounded-xl bg-emerald-400 px-5 py-3 font-bold text-[#07120e]">Back to dashboard</a>
        </div>
      </main>
    );
  }

  const topCard = game.topCard;
  const isExhaustionDraw = Boolean(game.draw || game.endReason === "draw_exhaustion");
  const statusText = isFinished
    ? (isExhaustionDraw ? "Match drawn — stakes refunded" : isWinner ? "You won the match!" : game.settlementStatus === "refunded" ? "Match cancelled - stakes refunded" : "Match finished")
    : paused ? "Game paused \u2014 waiting for reconnection"
    : myTurn ? "Your turn" : "Opponent's turn";

  return (
    <main className="min-h-screen bg-[#07120e] px-3 py-5 text-white sm:px-6 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={handleExitGame} disabled={exitBusy || isFinished} className="text-sm text-emerald-300 transition hover:text-white disabled:opacity-50">â† Dashboard</button>
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-400">SquadBet Games</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">WHOT<span className="text-emerald-400">.</span></h1>
          </div>
          <button type="button" onClick={handleExitGame} disabled={exitBusy || isFinished} className="rounded-xl border-2 border-red-500 bg-red-600 px-5 py-3 text-sm font-black text-white shadow-lg hover:bg-red-700 disabled:opacity-50">
  {exitBusy ? "EXITING..." : "EXIT GAME"}
</button>
        </header>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Game status</p>
              <p className="mt-1 font-semibold text-white">{statusText}</p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="rounded-lg border border-white/10 px-3 py-2 text-slate-300">Your cards: <strong className="text-white">{(game.myHand ?? []).length}</strong></span>
              <span className="rounded-lg border border-white/10 px-3 py-2 text-slate-300">Opponent: <strong className="text-white">{game.opponentCardCount}</strong></span>
            </div>
          </div>
          {paused && (
            <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3">
              <p className="font-bold text-amber-200">{iAmDisconnected && !opponentDisconnectedAt ? "You were disconnected \u2014 game paused" : opponentDisconnectedAt && !iAmDisconnected ? "Opponent disconnected \u2014 game paused" : "Both players disconnected \u2014 game paused"}</p><p className="mt-1 text-xs text-amber-100">No one can play until both players are back. You both continue from exactly where the game stopped.</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-amber-200">Time left to reconnect</p><p className="mt-1 text-4xl font-black tracking-widest tabular-nums text-amber-300">{disconnectCountdown ?? "5:00"}</p><p className="mt-1 text-xs text-amber-100">If the player does not reconnect before the timer expires, the server decides the match.</p>
            </div>
          )}
          <p aria-live="polite" className="mt-4 rounded-xl bg-black/20 px-3 py-3 text-sm leading-6 text-emerald-100">{game.message || "Match connected."}</p>
          {error && <p role="alert" className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
          {actionBusy && <p className="mt-2 text-xs text-slate-400">Sending move...</p>}
        </section>

        <section className="rounded-3xl border border-emerald-900/60 bg-[#0b1c15] p-4 shadow-2xl sm:p-7">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="font-bold">Opponent</p>
              <p className="text-xs text-slate-400">{game.opponentCardCount} cards in hand</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${!myTurn && !isFinished ? "bg-amber-400/15 text-amber-300" : "bg-white/5 text-slate-400"}`}>
              {!myTurn && !isFinished ? "Playing" : "Waiting"}
            </span>
          </div>

          <div className="flex min-h-24 items-center justify-center gap-1 overflow-hidden py-2">
            {Array.from({ length: Math.min(game.opponentCardCount, 12) }).map((_, index) => (
              <div key={index} className="flex h-20 w-12 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-gradient-to-br from-emerald-800 to-[#10251d] text-2xl font-black text-emerald-300 shadow-md" aria-label="Opponent's hidden card">
                <img src="/whot/shapes/market.png" alt="Face-down Whot card" className="h-10 w-10 object-contain" />
              </div>
            ))}
            {game.opponentCardCount > 12 && <span className="ml-2 text-xs text-slate-400">+{game.opponentCardCount - 12}</span>}
          </div>

          <div className="my-6 border-t border-white/10" />

          <div className="flex flex-wrap items-center justify-center gap-5 sm:gap-10">
            <div className="text-center">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Draw pile</p>
              <button
                type="button"
                onClick={() => void sendAction(game.mustDraw > 0 ? "draw" : "market")}
                disabled={!myTurn || actionBusy || choosingShape}
                className="flex h-28 w-[4.5rem] flex-col items-center justify-center rounded-xl border-2 border-emerald-500/60 bg-gradient-to-br from-emerald-800 to-[#10251d] text-3xl text-emerald-300 shadow-xl transition hover:-translate-y-1 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 sm:h-32 sm:w-20"
              >
                <img src="/whot/shapes/market.png" alt="Whot draw pile" className="h-12 w-12 object-contain sm:h-14 sm:w-14" />
                <span className="mt-2 text-[9px] font-bold uppercase tracking-widest">{game.mustDraw > 0 ? `Pick ${game.mustDraw}` : "Market"}</span>
              </button>
              <p className="mt-2 text-xs text-slate-400">{game.deckCount} left</p>
            </div>

            <div className="text-center">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Top card</p>
              {topCard ? <PlayingCard card={topCard} /> : <div className="flex h-28 w-20 items-center justify-center rounded-xl border border-white/10 text-xs text-slate-500">No card</div>}
              {game.chosenShape && (
                <p className="mt-3 text-xs text-emerald-300">Active shape: {shapeSymbol(game.chosenShape)} {game.chosenShape}</p>
              )}
            </div>
          </div>

          {choosingShape && (
            <div className="mx-auto mt-6 max-w-xl rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
              <p className="mb-3 text-center font-bold text-amber-200">Choose the active shape</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SHAPES.map((shape) => (
                  <button key={shape} type="button" onClick={() => chooseShape(shape)} disabled={actionBusy || paused} className={`rounded-xl border bg-black/20 px-3 py-3 font-semibold transition hover:bg-white/10 disabled:opacity-50 ${shapeColor(shape)}`}>
                    <span className="mr-2">{shapeSymbol(shape)}</span>{shape}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="my-6 border-t border-white/10" />

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold">Your hand</p>
              <p className="text-xs text-slate-400">Select a highlighted card to play it.</p>
            </div>
            <span className="rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300">{myTurn ? "Your move" : "Waiting for opponent"}</span>
          </div>

          <div className="flex min-h-36 flex-wrap justify-center gap-2 py-4 sm:gap-3">
            {(game.myHand ?? []).map((card) => {
              const playable = playableIds.has(card.id);
              return (
                <div key={card.id} className={`rounded-xl transition ${playable && myTurn && !choosingShape ? "ring-2 ring-emerald-400/40" : ""}`}>
                  <PlayingCard
                    card={card}
                    disabled={!myTurn || choosingShape || !playable || actionBusy}
                    onClick={myTurn && !choosingShape && playable && !actionBusy ? () => playCard(card) : undefined}
                  />
                </div>
              );
            })}
          </div>

          {isFinished && (
            <div className="mt-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5 text-center">
              <p className="text-xl font-black">{isExhaustionDraw ? "It's a draw!" : isWinner ? "Victory!" : "Match over"}</p>
              <p className="mt-2 text-sm text-slate-300">{game.message || game.endReason}</p>
              {game.player1HighestCard !== null && game.player1HighestCard !== undefined && game.player2HighestCard !== null && game.player2HighestCard !== undefined && (game.endReason === "draw_exhaustion" || game.endReason === "card_exhaustion" || game.message.toLowerCase().includes("highest-numbered")) && (
                <div className="mx-auto mt-4 grid max-w-sm grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{iAmPlayer1 ? "Your highest card" : "Opponent's highest card"}</p>
                    <p className="mt-1 text-2xl font-black text-white">{game.player1HighestCard}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{iAmPlayer1 ? "Opponent's highest card" : "Your highest card"}</p>
                    <p className="mt-1 text-2xl font-black text-white">{game.player2HighestCard}</p>
                  </div>
                </div>
              )}
              <a href="/dashboard" className="mt-4 inline-block rounded-xl bg-emerald-400 px-6 py-3 font-bold text-[#07120e]">Return to dashboard</a>
            </div>
          )}
        </section>

        <footer className="mt-5 text-center text-xs leading-6 text-slate-500">
          Live multiplayer Whot. Your opponent's cards remain hidden; moves are validated by the server.
        </footer>
      </div>
    </main>
  );
}
