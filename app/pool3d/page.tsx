"use client";

import "./pool-game.css";
import { queueGameResultPopup } from "../../lib/naija/popup-bus";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../../utils/supabase/client";
import type { PoolPlayerInfo, PoolQuality } from "./engine/common";
import type { PoolSnapshot } from "../../lib/pool/authoritative";
import { simulateShot, TURN_SECONDS } from "../../lib/pool/authoritative";

type SessionPayload = {
  success: boolean;
  error?: string;
  status: string;
  stake: number;
  localPlayerIndex: 0 | 1;
  players: Array<PoolPlayerInfo & { ready: boolean }>;
  serverNow?: number;
  turnStartedAt?: number | null;
  session: { game_state?: { snapshot?: PoolSnapshot; last_shot?: LastShotMeta }; state_version?: number; disconnect_deadline?: string | null; settlement_status?: string } | null;
};

type LastShotMeta = {
  startSnapshot?: PoolSnapshot;
  power?: number;
  angleRadians?: number;
  spinX?: number;
  spinY?: number;
  cuePlacement?: { x: number; z: number } | null;
};

type ShotDetail = { power: number; angleRadians: number; spinX?: number; spinY?: number; cuePlacement?: { x: number; z: number } | null };
type ResultState = { won: boolean; title: string; text: string } | null;

/** Same turn, same pocketed balls, same rule outcome and positions within a hair: the instant shot was right. */
function sameOutcome(a: PoolSnapshot, b: PoolSnapshot): boolean {
  if (a.currentPlayer !== b.currentPlayer || a.gameOver !== b.gameOver || Boolean(a.ballInHand) !== Boolean(b.ballInHand)) return false;
  if (JSON.stringify(a.groups) !== JSON.stringify(b.groups)) return false;
  for (const ball of a.balls) {
    const other = b.balls.find((x) => x.id === ball.id);
    if (!other || other.pocketed !== ball.pocketed) return false;
    if (!ball.pocketed && Math.hypot(other.x - ball.x, other.z - ball.z) > 0.03) return false;
  }
  return true;
}

const gameApi = () => (typeof window !== "undefined" ? window.__POOL_GAME__ : undefined);

function Pool3DContent() {
  const searchParams = useSearchParams();
  const matchId = searchParams.get("matchId");
  const hostRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [lobbyError, setLobbyError] = useState("");
  const [players, setPlayers] = useState<[string, string]>(["Player 1", "Player 2"]);
  const [localIndex, setLocalIndex] = useState<0 | 1>(0);
  const [stake, setStake] = useState<number | null>(null);
  const [status, setStatus] = useState("Loading match...");
  const [matchLive, setMatchLive] = useState(false);
  const [disconnectDeadline, setDisconnectDeadline] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [bothReady, setBothReady] = useState(false);
  const [readyBusy, setReadyBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "exit" | "help" | "settings">(null);
  const [exiting, setExiting] = useState(false);
  const [result, setResult] = useState<ResultState>(null);
  const [settlementNote, setSettlementNote] = useState("");
  const [portraitOk, setPortraitOk] = useState(false);
  const [settings, setSettings] = useState<{ quality: PoolQuality; guideFull: boolean; sound: boolean }>({ quality: "auto", guideFull: true, sound: true });

  const stateVersionRef = useRef(0);
  const lastPlayedRef = useRef(0);
  const lastSnapRef = useRef<PoolSnapshot | null>(null);
  const submittingRef = useRef(false);
  const syncRef = useRef<() => void>(() => undefined);
  // Turn timer: server-stamped start of the current turn + (server clock - local clock).
  const turnRef = useRef<{ startedAt: number | null; skew: number }>({ startedAt: null, skew: 0 });
  const lastTimeoutTryRef = useRef(0);
  const localIndexRef = useRef<0 | 1>(0);
  const userIdRef = useRef("");
  const namesRef = useRef<[string, string]>(["Player 1", "Player 2"]);
  const pendingFinalRef = useRef<PoolSnapshot | null>(null);
  const heartbeatTokenRef = useRef("");
  const exitSignalSentRef = useRef(false);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const showFinal = useCallback((snapshot: PoolSnapshot, announce = true) => {
    const won = snapshot.winnerPlayer === localIndexRef.current;
    // Naija pop-up only for a result that just became official (not when re-opening a finished match); deduped per match.
    if (announce && matchId && userIdRef.current && (snapshot.winnerPlayer === 0 || snapshot.winnerPlayer === 1)) {
      queueGameResultPopup("pool", matchId, userIdRef.current, won);
    }
    const text = snapshot.status.replace(/Player ([12])/g, (_m, n) => `@${namesRef.current[Number(n) - 1]}`);
    setResult((prev) => prev ?? { won, title: won ? "Victory" : "Defeat", text });
  }, [matchId]);

  /* ---------------- boot: server-validated entry, then mount the existing cinematic table ---------------- */
  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    let onShotRequested: ((e: Event) => void) | null = null;
    let onUi: ((e: Event) => void) | null = null;
    let onSettled: (() => void) | null = null;
    let onResync: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const fail = (message: string, redirect: boolean) => {
      if (cancelled) return;
      setLobbyError(message);
      setLoading(false);
      if (redirect) redirectTimer = setTimeout(() => window.location.replace("/dashboard"), 2600);
    };

    /** Re-read the authoritative session through the server-checked route. */
    async function resync() {
      if (!matchId) return;
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`/api/pool/${encodeURIComponent(matchId)}/session`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json()) as SessionPayload;
      if (!res.ok || !data.success || !data.session) return;
      stateVersionRef.current = Number(data.session.state_version ?? stateVersionRef.current);
      lastPlayedRef.current = stateVersionRef.current;
      if (typeof data.serverNow === "number") turnRef.current.skew = data.serverNow - Date.now();
      turnRef.current.startedAt = data.turnStartedAt ?? null;
      const snap = data.session.game_state?.snapshot;
      if (snap) { lastSnapRef.current = snap; gameApi()?.applyState(snap); }
    }

    /**
     * Catch up with the authoritative table. Realtime can drop an event (flaky mobile data, a sleeping tab),
     * and without it the player whose turn it is would wait forever. This re-reads the session through the same
     * server-checked route and plays any shot we have not seen yet (animated when possible).
     */
    let syncing = false;
    let stuckPolls = 0;
    async function syncNow() {
      if (!matchId || syncing || cancelled) return;
      syncing = true;
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch(`/api/pool/${encodeURIComponent(matchId)}/session?sync=1`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        const data = (await res.json().catch(() => null)) as SessionPayload | null;
        if (!res.ok || !data?.success || !data.session) return;
        const version = Number(data.session.state_version ?? 0);
        if (typeof data.serverNow === "number") turnRef.current.skew = data.serverNow - Date.now();
        turnRef.current.startedAt = data.turnStartedAt ?? null;
        setDisconnectDeadline(data.session.disconnect_deadline ?? null);
        if (version > lastPlayedRef.current && data.session.game_state?.snapshot) {
          lastPlayedRef.current = version;
          stateVersionRef.current = Math.max(stateVersionRef.current, version);
          playFrom(data.session.game_state.snapshot, data.session.game_state.last_shot);
        } else if (version > stateVersionRef.current) {
          stateVersionRef.current = version;
        }
        if (data.status === "in_progress") gameApi()?.setMultiplayerMode(true, localIndexRef.current, true);

        // Self-healing watchdog: the authoritative table says it is OUR turn and nothing is moving or pending,
        // yet the local game still refuses input (a missed event / interrupted replay). After ~12 s of that we
        // re-apply the server snapshot, which is always the source of truth. Never runs for a finished game.
        const snap = data.session.game_state?.snapshot;
        const live = gameApi()?.getState() as { canShoot?: boolean; moving?: boolean; shotInProgress?: boolean } | undefined;
        if (data.status === "in_progress" && snap && !snap.gameOver && version <= lastPlayedRef.current && live
          && snap.currentPlayer === localIndexRef.current && !live.moving && !live.canShoot) {
          stuckPolls += 1;
          if (stuckPolls >= 4) {
            stuckPolls = 0;
            lastSnapRef.current = snap;
            gameApi()?.applyState(snap);
            gameApi()?.setMultiplayerMode(true, localIndexRef.current, true);
          }
        } else stuckPolls = 0;
      } catch { /* the next poll retries */ } finally { syncing = false; }
    }
    syncRef.current = syncNow;

    const playFrom = (snapshot: PoolSnapshot, meta: LastShotMeta | undefined) => {
      const api = gameApi();
      if (!api) return;
      lastSnapRef.current = snapshot;
      if (Number.isFinite(Number(snapshot.turnStartedAt))) turnRef.current.startedAt = Number(snapshot.turnStartedAt);
      if (snapshot.gameOver) pendingFinalRef.current = snapshot;
      if (meta?.startSnapshot && typeof meta.power === "number" && typeof meta.angleRadians === "number") {
        api.playApprovedShot(meta.startSnapshot, meta.power, meta.angleRadians, snapshot, { spinX: meta.spinX, spinY: meta.spinY, cuePlacement: meta.cuePlacement ?? null });
      } else {
        api.applyState(snapshot);
        if (snapshot.gameOver) showFinal(snapshot);
      }
    };

    async function submitShot(detail: ShotDetail) {
      const api = gameApi();
      if (!matchId || !api || submittingRef.current) return;
      submittingRef.current = true;
      // INSTANT SHOT: play the shot on screen immediately using the SAME deterministic engine the server runs,
      // while the real request is sent in parallel. The server stays the authority: it confirms the result
      // (nothing more to do), corrects it (the table snaps to the server's), or rejects it (rolled back).
      // A shot that would end the match is never shown optimistically: wins/losses wait for the server.
      const startSnap = lastSnapRef.current;
      turnRef.current.startedAt = null; // timer pauses while the shot is being confirmed
      const expected = stateVersionRef.current;
      let predicted: PoolSnapshot | null = null;
      if (startSnap && !startSnap.gameOver) {
        try {
          const extra = { spinX: detail.spinX ?? 0, spinY: detail.spinY ?? 0, cuePlacement: detail.cuePlacement ?? null };
          const final = simulateShot(startSnap, detail.power, detail.angleRadians, extra);
          if (!final.gameOver) {
            predicted = final;
            lastPlayedRef.current = Math.max(lastPlayedRef.current, expected + 1);
            api.playApprovedShot(startSnap, detail.power, detail.angleRadians, final, extra);
          }
        } catch { predicted = null; /* fall back to waiting for the server */ }
      }
      const rollback = () => {
        if (!predicted || !startSnap) return;
        lastPlayedRef.current = stateVersionRef.current;
        gameApi()?.settleTo(startSnap);
      };
      try {
        const token = await getToken();
        if (!token) {
          rollback();
          api.shotRejected("Session expired");
          setStatus("Your login session expired. Please sign in again.");
          return;
        }
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 20000);
        const response = await fetch(`/api/pool/${encodeURIComponent(matchId)}/shot`, {
          method: "POST",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            power: detail.power,
            angleRadians: detail.angleRadians,
            spinX: detail.spinX ?? 0,
            spinY: detail.spinY ?? 0,
            cuePlacement: detail.cuePlacement ?? null,
            expectedVersion: stateVersionRef.current,
          }),
        });
        clearTimeout(abortTimer);
        const out = await response.json();
        if (!response.ok || !out.success) {
          rollback();
          api.shotRejected(out.error || "The server could not accept that shot.");
          setStatus(out.error || "The server could not accept that shot.");
          if (response.status === 409) await resync();
          return;
        }
        stateVersionRef.current = Number(out.stateVersion ?? stateVersionRef.current + 1);
        if (out.snapshot && Number.isFinite(Number(out.snapshot.turnStartedAt))) {
          turnRef.current.startedAt = Number(out.snapshot.turnStartedAt);
          turnRef.current.skew = Number(out.snapshot.turnStartedAt) - Date.now();
        }
        if (predicted && out.snapshot) {
          const server = out.snapshot as PoolSnapshot;
          lastSnapRef.current = server;
          lastPlayedRef.current = Math.max(lastPlayedRef.current, stateVersionRef.current);
          if (!sameOutcome(predicted, server)) {
            // The server's result differs from the instant one (should be very rare): its table wins.
            if (server.gameOver) pendingFinalRef.current = server;
            gameApi()?.settleTo(server);
            if (server.gameOver) showFinal(server);
          } else if (server.gameOver) {
            showFinal(server);
          }
        } else if (out.snapshot && stateVersionRef.current > lastPlayedRef.current) {
          lastPlayedRef.current = stateVersionRef.current;
          playFrom(out.snapshot as PoolSnapshot, out.lastShot as LastShotMeta | undefined);
        } else {
          api.shotRejected();
        }
        setStatus(out.settled ? "Match complete Ã‚Â· winner payout recorded" : "Shot synchronized Ã‚Â· table updated");
      } catch {
        rollback();
        gameApi()?.shotRejected("Connection interrupted");
        setStatus("Connection interrupted. Wait for the table to synchronize before shooting again.");
        // The server may have accepted the shot even though the answer was lost: ask it what really happened.
        void syncNow();
      } finally {
        submittingRef.current = false;
      }
    }

    async function boot() {
      if (!matchId) {
        window.location.replace("/dashboard");
        return;
      }
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        window.location.assign("/login");
        return;
      }
      userIdRef.current = userData.user.id;
      const token = await getToken();
      if (!token) {
        window.location.assign("/login");
        return;
      }

      // SERVER-ENFORCED gate: authenticated user + accepted challenge + participant + playable match.
      const res = await fetch(`/api/pool/${encodeURIComponent(matchId)}/session`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => null)) as SessionPayload | null;
      if (!res.ok || !data?.success) {
        fail(data?.error || "No valid accepted 8-ball Pool match was found. Returning to your dashboard.", true);
        return;
      }
      if (cancelled) return;

      const me = data.localPlayerIndex;
      localIndexRef.current = me;
      setLocalIndex(me);
      const names: [string, string] = [data.players[0].username, data.players[1].username];
      namesRef.current = names;
      setPlayers(names);
      setStake(data.stake);
      const live = data.status === "in_progress";
      setMatchLive(live);
      setIsReady(Boolean(data.players[me].ready));
      setBothReady(Boolean(data.players[0].ready && data.players[1].ready));
      setStatus(live ? "Match live Ã‚Â· reconnecting session" : "Lobby ready Ã‚Â· waiting for both players");
      stateVersionRef.current = Number(data.session?.state_version ?? 0);
      lastPlayedRef.current = stateVersionRef.current;
      setDisconnectDeadline(data.session?.disconnect_deadline ?? null);

      // Browser-only: the existing cinematic game creates its WebGL renderer in #pool-host.
      try {
        const { mountCinematicPool } = await import("../snooker/cinematic/main2d");
        if (cancelled || !hostRef.current) return;
        mountCinematicPool();
      } catch (error) {
        console.error("Pool game initialization failed", error);
        fail("The 3D pool table could not initialize on this device.", false);
        return;
      }
      const api = gameApi();
      if (!api) {
        fail("The 3D pool table could not initialize on this device.", false);
        return;
      }
      setSettings(api.getSettings());
      api.setPlayers([data.players[0], data.players[1]], me);
      api.setStake(data.stake);
      api.setMultiplayerMode(true, me, live);
      const initial = data.session?.game_state?.snapshot;
      if (initial) {
        lastSnapRef.current = initial;
        api.applyState(initial);
        if (initial.gameOver) showFinal(initial, false);
      }

      onShotRequested = (e: Event) => { void submitShot((e as CustomEvent<ShotDetail>).detail); };
      onUi = (e: Event) => {
        const action = (e as CustomEvent<{ action: string }>).detail?.action;
        if (action === "exit" || action === "help" || action === "settings") setDialog(action);
      };
      onSettled = () => {
        const final = pendingFinalRef.current;
        if (final?.gameOver) {
          pendingFinalRef.current = null;
          window.setTimeout(() => { if (!cancelled) showFinal(final); }, 1400);
        }
      };
      onResync = () => { void syncNow(); };
      window.addEventListener("pool-shot-requested", onShotRequested);
      window.addEventListener("pool-ui", onUi);
      window.addEventListener("pool-shot-settled", onSettled);
      window.addEventListener("pool-resync-needed", onResync);
      // Realtime is the fast path, but it can silently drop an event (flaky mobile data, sleeping tab). A light,
      // server-checked poll guarantees the player whose turn it is always sees the opponent's shot and can play.
      pollTimer = setInterval(() => { if (!document.hidden) void syncNow(); }, 3000);
      setLoading(false);

      channel = supabase
        .channel(`pool-match-${matchId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, (payload) => {
          const next = payload.new as { status?: string; player1_ready?: boolean; player2_ready?: boolean };
          if (next.status === "in_progress") {
            setMatchLive(true);
            gameApi()?.setMultiplayerMode(true, localIndexRef.current, true);
            setStatus("Match live Ã‚Â· connection established");
          }
          if (typeof next.player1_ready === "boolean" && typeof next.player2_ready === "boolean") setBothReady(next.player1_ready && next.player2_ready);
          if (next.status === "completed" || next.status === "cancelled") setStatus(`Match ${next.status}`);
        })
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pool_game_sessions", filter: `match_id=eq.${matchId}` }, (payload) => {
          const session = payload.new as {
            disconnect_deadline?: string | null;
            end_reason?: string | null;
            winner_id?: string | null;
            settlement_status?: string;
            state_version?: number;
            game_state?: { snapshot?: PoolSnapshot; last_shot?: LastShotMeta };
          };
          setDisconnectDeadline(session.disconnect_deadline ?? null);
          const incoming = Number(session.state_version ?? stateVersionRef.current);
          stateVersionRef.current = Math.max(stateVersionRef.current, incoming);
          const gs = session.game_state;
          if (gs?.snapshot && incoming > lastPlayedRef.current) {
            lastPlayedRef.current = incoming;
            playFrom(gs.snapshot, gs.last_shot);
          }
          if (session.settlement_status === "settled") {
            const note =
              session.end_reason === "both_disconnected_refund" ? "Match cancelled Ã‚Â· both stakes refunded less entry fees"
              : session.end_reason === "normal_8_ball" ? "Match complete Ã‚Â· winner payout recorded"
              : "Match settled Ã‚Â· opponent disconnected";
            setStatus(note);
            setSettlementNote(note);
            if (session.end_reason !== "normal_8_ball") {
              // Disconnect / refund settlement ends the match without an 8-ball finish.
              const refund = session.end_reason === "both_disconnected_refund";
              const won = !refund && !!session.winner_id && session.winner_id === userIdRef.current;
              if (!refund && session.winner_id && matchId && userIdRef.current) queueGameResultPopup("pool", matchId, userIdRef.current, won);
              setResult((prev) => prev ?? { won, title: refund ? "Match cancelled" : won ? "Victory" : "Match over", text: note });
            }
          }
        })
        .subscribe();
    }

    void boot().catch((error) => {
      console.error("Pool game initialization failed", error);
      fail("The 3D pool table could not initialize on this device.", false);
    });

    return () => {
      cancelled = true;
      if (redirectTimer) clearTimeout(redirectTimer);
      if (onShotRequested) window.removeEventListener("pool-shot-requested", onShotRequested);
      if (onUi) window.removeEventListener("pool-ui", onUi);
      if (onSettled) window.removeEventListener("pool-shot-settled", onSettled);
      if (onResync) window.removeEventListener("pool-resync-needed", onResync);
      if (pollTimer) clearInterval(pollTimer);
      if (channel) void supabase.removeChannel(channel);
      gameApi()?.dispose();
    };
  }, [matchId, getToken, showFinal]);

  /* ---------------- heartbeat (unchanged behaviour) ---------------- */
  useEffect(() => {
    if (!matchId) return;
    const ping = async () => {
      const token = await getToken();
      if (!token) return;
      heartbeatTokenRef.current = token;
      try {
        const response = await fetch(`/api/pool/${encodeURIComponent(matchId)}/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        const out = await response.json();
        if (out.timeout?.settled) setStatus(out.timeout.result === "refund" ? "Match cancelled Ã‚Â· both stakes refunded less fees" : "Opponent disconnected Ã‚Â· match settled");
      } catch { /* transient network failure: next heartbeat retries */ }
    };
    void ping();
    const timer = setInterval(() => { void ping(); }, 4000);

    const onPageHide = () => {
      if (exitSignalSentRef.current) return;
      const token = heartbeatTokenRef.current;
      if (!token || !matchId) return;

      exitSignalSentRef.current = true;
      void fetch(`/api/pool/${encodeURIComponent(matchId)}/exit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {});
    };

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        exitSignalSentRef.current = false;
        void ping();
      }
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [matchId, getToken]);

  // 30-second turn timer. The server owns the clock; this only draws the ring and asks the server to pass the turn
  // once time is up (the server re-checks its own clock, so an early or forged call does nothing).
  useEffect(() => {
    if (!matchId || !matchLive || result) { gameApi()?.setTurnTimer(0, null, TURN_SECONDS); return; }
    const tick = () => {
      const api = gameApi();
      const snap = lastSnapRef.current;
      const t = turnRef.current;
      if (!api || !snap || snap.gameOver || t.startedAt === null || dialog === "exit") { api?.setTurnTimer(0, null, TURN_SECONDS); return; }
      if (disconnectDeadline) {
        // Match frozen (a player is disconnected): hold the ring at the time that was left when the pause began.
        // No timeout is requested while paused; the server would refuse it anyway.
        const pausedAt = new Date(disconnectDeadline).getTime() - 5 * 60 * 1000;
        const frozen = TURN_SECONDS - (pausedAt - t.startedAt) / 1000;
        api.setTurnTimer(snap.currentPlayer === 1 ? 1 : 0, Math.max(0, Math.min(TURN_SECONDS, frozen)), TURN_SECONDS);
        return;
      }
      const remaining = TURN_SECONDS - (Date.now() + t.skew - t.startedAt) / 1000;
      api.setTurnTimer(snap.currentPlayer === 1 ? 1 : 0, Math.max(0, remaining), TURN_SECONDS);
      if (remaining > -1.2 || submittingRef.current) return;
      const live = api.getState() as { moving?: boolean } | undefined;
      if (live?.moving) return;
      const now = Date.now();
      if (now - lastTimeoutTryRef.current < 2500) return;
      lastTimeoutTryRef.current = now;
      void (async () => {
        try {
          const token = await getToken();
          if (!token) return;
          const res = await fetch(`/api/pool/${encodeURIComponent(matchId)}/timeout`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ expectedVersion: stateVersionRef.current }),
          });
          const out = await res.json().catch(() => null);
          if (out?.success && out.snapshot) {
            const version = Number(out.stateVersion ?? stateVersionRef.current + 1);
            stateVersionRef.current = Math.max(stateVersionRef.current, version);
            if (version > lastPlayedRef.current) {
              lastPlayedRef.current = version;
              turnRef.current.skew = Number(out.snapshot.turnStartedAt) - Date.now();
              lastSnapRef.current = out.snapshot as PoolSnapshot;
              turnRef.current.startedAt = Number(out.snapshot.turnStartedAt);
              api.applyState(out.snapshot as PoolSnapshot);
              api.setMultiplayerMode(true, localIndexRef.current, true);
            }
          } else {
            syncRef.current(); // stale / someone else already moved: pick up the real state
          }
        } catch { /* next tick retries */ }
      })();
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [matchId, matchLive, result, disconnectDeadline, dialog, getToken]);

  useEffect(() => {
    if (!disconnectDeadline) { setCountdown(0); return; }
    const update = () => setCountdown(Math.max(0, Math.ceil((new Date(disconnectDeadline).getTime() - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [disconnectDeadline]);

  useEffect(() => { gameApi()?.setCountdown(countdown); }, [countdown]);
  // Frozen for BOTH players while a player is disconnected (the server also rejects every shot meanwhile).
  useEffect(() => { gameApi()?.setPaused(dialog !== null || result !== null || disconnectDeadline !== null); }, [dialog, result, disconnectDeadline]);
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !exiting) setDialog(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, exiting]);

  /* ---------------- actions ---------------- */
  const markReady = async () => {
    if (!matchId || isReady || readyBusy) return;
    setReadyBusy(true);
    try {
      const token = await getToken();
      if (!token) { window.location.assign("/login"); return; }
      const response = await fetch(`/api/pool/${encodeURIComponent(matchId)}/ready`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const out = await response.json();
      if (!response.ok || !out.success) throw new Error(out.error || "Could not mark you ready.");
      setIsReady(true);
      setBothReady(Boolean(out.bothReady));
      if (out.bothReady) { setMatchLive(true); gameApi()?.setMultiplayerMode(true, localIndexRef.current, true); }
      setStatus(out.bothReady ? "Both players ready Ã‚Â· match starting" : "You're ready Ã‚Â· waiting for opponent");
    } catch (error) {
      setLobbyError(error instanceof Error ? error.message : "Could not mark you ready.");
    } finally {
      setReadyBusy(false);
    }
  };

  /** Same server-side exit/disconnect handling as before, now behind a confirmation dialog. */
  const confirmExit = async () => {
    if (exiting) return;
    setExiting(true);
    exitSignalSentRef.current = true;
    if (matchId) {
      const token = await getToken();
      if (token) {
        try {
          const res = await fetch(`/api/pool/${encodeURIComponent(matchId)}/exit`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
          const out = await res.json();
          if (out.deadline) setDisconnectDeadline(out.deadline);
        } catch { /* navigation still allowed; heartbeat records connection loss */ }
      }
    }
    window.location.assign("/dashboard");
  };

  const toggleSound = () => {
    const on = gameApi()?.toggleSound() ?? true;
    setSettings((s) => ({ ...s, sound: on }));
  };
  const setQuality = (q: PoolQuality) => { gameApi()?.setQuality(q); setSettings((s) => ({ ...s, quality: q })); };
  const setGuide = (full: boolean) => { gameApi()?.setGuide(full); setSettings((s) => ({ ...s, guideFull: full })); };

  const opponentName = `@${players[localIndex === 0 ? 1 : 0]}`;
  const showLobby = !loading && !lobbyError && !matchLive && !result;

  return (
    <main className={`pool-game-shell pg-root${portraitOk ? " pg-portrait-ok" : ""}`}>
      <div id="pool-host" ref={hostRef} aria-label="SquadBet 3D eight-ball pool game" />

      {loading && !lobbyError && (
        <div className="pg-layer"><div className="pg-card"><h2>Preparing the tableÃ¢â‚¬Â¦</h2><p>Verifying your accepted challenge and loading the match.</p></div></div>
      )}

      {lobbyError && (
        <div className="pg-layer">
          <div className="pg-card" role="alertdialog" aria-live="assertive">
            <h2>Can&apos;t open this match</h2>
            <p className="pg-error">{lobbyError}</p>
            <div className="pg-actions"><button type="button" className="pg-btn is-primary" onClick={() => window.location.assign("/dashboard")}>Back to dashboard</button></div>
          </div>
        </div>
      )}

      {showLobby && (
        <div className="pg-layer">
          <div className="pg-card">
            <h2>Match lobby</h2>
            <div className="pg-lobby-vs">@{players[0]} <span>VS</span> @{players[1]}</div>
            <p>{status}{stake !== null ? ` Ã‚Â· Ã¢â€šÂ¦${stake.toLocaleString("en-NG")} stake` : ""}{countdown > 0 ? ` Ã‚Â· Reconnect ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}` : ""}</p>
            <p className="pg-sub">Opponent: {opponentName}</p>
            <div className="pg-actions">
              <button type="button" className="pg-btn" onClick={() => setDialog("exit")}>Exit</button>
              {!bothReady && (
                <button type="button" className="pg-btn is-primary" onClick={markReady} disabled={isReady || readyBusy}>
                  {readyBusy ? "ConfirmingÃ¢â‚¬Â¦" : isReady ? "You're ready Ã‚Â· waiting" : "I'm ready"}
                </button>
              )}
              {bothReady && <span className="pg-sub">Both players are ready Ã‚Â· startingÃ¢â‚¬Â¦</span>}
            </div>
          </div>
        </div>
      )}

      {dialog === "exit" && (
        <div className="pg-layer" onClick={() => !exiting && setDialog(null)}>
          <div className="pg-card" role="alertdialog" aria-labelledby="pg-exit-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="pg-exit-title">Leave this match?</h2>
            <p>Leaving starts the reconnect countdown. If you don&apos;t return in time, the match is settled under SquadBet&apos;s existing disconnect rules and your opponent is notified.</p>
            <div className="pg-actions">
              <button type="button" className="pg-btn is-primary" onClick={() => setDialog(null)} disabled={exiting} autoFocus>Stay in match</button>
              <button type="button" className="pg-btn is-danger" onClick={confirmExit} disabled={exiting}>{exiting ? "LeavingÃ¢â‚¬Â¦" : "Leave match"}</button>
            </div>
          </div>
        </div>
      )}

      {dialog === "help" && (
        <div className="pg-layer" onClick={() => setDialog(null)}>
          <div className="pg-card" role="dialog" aria-labelledby="pg-help-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="pg-help-title">How to play</h2>
            <ul>
              <li><b>Aim:</b> move the mouse (desktop) or drag on the table (touch). Use the fine-aim buttons for small adjustments.</li>
              <li><b>Power:</b> drag the power bar down to pull the cue back, then release to shoot. Release near the top to cancel. On desktop you can also hold the left mouse button or Space and release.</li>
              <li><b>Spin:</b> tap the cue ball diagram to choose where the tip strikes. Top = follow, bottom = draw, sides = English. Double-tap to reset.</li>
              <li><b>Ball in hand:</b> after a foul, drag the cue ball anywhere legal before you shoot.</li>
              <li><b>Keyboard:</b> Ã¢â€ Â Ã¢â€ â€™ aim (Shift = fine), Ã¢â€ â€˜ Ã¢â€ â€œ power, hold Space then release to shoot.</li>
            </ul>
            <p><b>Rules:</b> pocket all your solids (1Ã¢â‚¬â€œ7) or stripes (9Ã¢â‚¬â€œ15), then the 8-ball. You keep shooting while you pocket your own group. Scratching, missing every ball, or hitting the wrong group first is a foul and gives your opponent ball in hand. Pocketing the 8-ball early, or scratching on it, loses the match. The server decides every result.</p>
            <div className="pg-actions"><button type="button" className="pg-btn is-primary" onClick={() => setDialog(null)}>Got it</button></div>
          </div>
        </div>
      )}

      {dialog === "settings" && (
        <div className="pg-layer" onClick={() => setDialog(null)}>
          <div className="pg-card" role="dialog" aria-labelledby="pg-set-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="pg-set-title">Settings</h2>
            <div className="pg-row"><span>Sound</span>
              <span className="pg-seg"><button type="button" aria-pressed={settings.sound} onClick={() => !settings.sound && toggleSound()}>On</button><button type="button" aria-pressed={!settings.sound} onClick={() => settings.sound && toggleSound()}>Off</button></span></div>
            <div className="pg-row"><span>Aim guide<br /><span className="pg-sub">Full shows ghost ball, object line and pocket</span></span>
              <span className="pg-seg"><button type="button" aria-pressed={settings.guideFull} onClick={() => setGuide(true)}>Full</button><button type="button" aria-pressed={!settings.guideFull} onClick={() => setGuide(false)}>Line</button></span></div>
            <div className="pg-row"><span>Graphics<br /><span className="pg-sub">Lower if the game feels slow</span></span>
              <span className="pg-seg">{(["auto", "high", "low"] as PoolQuality[]).map((q) => (<button key={q} type="button" aria-pressed={settings.quality === q} onClick={() => setQuality(q)}>{q === "auto" ? "Auto" : q === "high" ? "High" : "Low"}</button>))}</span></div>
            <div className="pg-actions"><button type="button" className="pg-btn is-primary" onClick={() => setDialog(null)}>Done</button></div>
          </div>
        </div>
      )}

      {result && (
        <div className="pg-layer">
          {result.won && (
            <div className="pg-confetti" aria-hidden="true">
              {Array.from({ length: 26 }, (_, i) => (
                <i key={i} style={{ left: `${(i * 37) % 100}%`, background: ["#34d399", "#e6b85c", "#60a5fa", "#f87171"][i % 4], animationDuration: `${2.6 + (i % 5) * 0.5}s`, animationDelay: `${(i % 7) * 0.25}s` }} />
              ))}
            </div>
          )}
          <div className={`pg-card pg-result ${result.won ? "is-win" : "is-lose"}`} role="dialog" aria-live="polite">
            <svg className="pg-trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v4a5 5 0 0 1-10 0V4Zm-3 1h3v2a2 2 0 0 1-3-2Zm16 0h-3v2a2 2 0 0 0 3-2ZM12 13v4m-3 3h6m-5-3h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <h2>{result.title}</h2>
            <p>{result.text}</p>
            {settlementNote && <p className="pg-sub">{settlementNote}</p>}
            <div className="pg-actions"><button type="button" className="pg-btn is-primary" onClick={() => window.location.assign("/dashboard")}>Back to dashboard</button></div>
          </div>
        </div>
      )}

      <div className="pg-rotate" role="alert">
        <div className="pg-rotate-inner">
          <div className="pg-rotate-phone" />
          <h2>Rotate your device</h2>
          <p>8-ball Pool plays best in landscape. Turn your phone sideways for the full-screen table.</p>
          <button type="button" onClick={() => setPortraitOk(true)}>Play in portrait anyway</button>
        </div>
      </div>
    </main>
  );
}

export default function Pool3DPage() {
  return (
    <Suspense fallback={<main className="pool-game-shell pg-root"><div className="pg-layer"><div className="pg-card"><h2>Loading 8-Ball PoolÃ¢â‚¬Â¦</h2></div></div></main>}>
      <Pool3DContent />
    </Suspense>
  );
}
