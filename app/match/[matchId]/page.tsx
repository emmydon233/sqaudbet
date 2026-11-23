"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../utils/supabase/client";

type MatchRecord = {
  id: string;
  challenge_id: string;
  player1_id: string;
  player2_id: string;
  game: string;
  stake_amount: number;
  status: string;
  player1_ready: boolean;
  player2_ready: boolean;
  created_at: string;
};

type PlayerNames = {
  player1: string;
  player2: string;
};

function MatchLobbyContent() {
  const params = useParams<{ matchId: string }>();
  const router = useRouter();
  const matchId = params.matchId;

  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const [names, setNames] = useState<PlayerNames>({
    player1: "Loading player...",
    player2: "Loading player...",
  });
  const [loading, setLoading] = useState(true);
  const [readyLoading, setReadyLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState("");

  const loadMatch = useCallback(async () => {
    const { data: authData, error: authError } =
      await supabase.auth.getUser();

    if (authError || !authData.user) {
      router.replace("/login");
      return;
    }

    setCurrentUserId(authData.user.id);

    const { data, error } = await supabase
      .from("matches")
      .select(
        "id, challenge_id, player1_id, player2_id, game, stake_amount, status, player1_ready, player2_ready, created_at"
      )
      .eq("id", matchId)
      .maybeSingle();

    if (error) {
      setErrorMessage("Could not load the match: " + error.message);
      setLoading(false);
      return;
    }

    if (!data) {
      setErrorMessage(
        "This match was not found, or your account cannot access it."
      );
      setLoading(false);
      return;
    }

    if (
      authData.user.id !== data.player1_id &&
      authData.user.id !== data.player2_id
    ) {
      setErrorMessage("You are not a player in this match.");
      setLoading(false);
      return;
    }

    setMatch(data as MatchRecord);

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, username")
      .in("id", [data.player1_id, data.player2_id]);

    if (!profilesError && profiles) {
      const profileMap = Object.fromEntries(
        profiles.map((profile) => [profile.id, profile.username])
      );

      setNames({
        player1: profileMap[data.player1_id] ?? "Player 1",
        player2: profileMap[data.player2_id] ?? "Player 2",
      });
    }

    setErrorMessage("");
    setLoading(false);
  }, [matchId, router]);

  useEffect(() => {
    void loadMatch();

    const matchChannel = supabase
      .channel(`match-lobby-${matchId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "matches",
          filter: `id=eq.${matchId}`,
        },
        () => {
          if (document.visibilityState === "visible") {
            void loadMatch();
          }
        }
      )
      .subscribe();

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadMatch();
      }
    }, 3000);

    return () => {
      window.clearInterval(interval);
      void supabase.removeChannel(matchChannel);
    };
  }, [loadMatch, matchId]);

  useEffect(() => {
    if (match?.status === "in_progress" && match.game.toLowerCase().includes("whot")) {
      router.replace(`/whot?matchId=${encodeURIComponent(match.id)}`);
    } else if (match?.status === "in_progress" && match.game.toLowerCase().includes("pool")) {
      router.replace(`/pool3d?matchId=${encodeURIComponent(match.id)}`);
    }
  }, [match, router]);

  const handleReady = async () => {
    if (!match || readyLoading) return;

    setReadyLoading(true);
    setErrorMessage("");
    setNotice("");

    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      const token = sessionData.session?.access_token;

      if (sessionError || !token) {
        setErrorMessage("Your login session has expired. Please log in again.");
        setReadyLoading(false);
        return;
      }

      const isPoolMatch = match.game.toLowerCase().includes("pool");
      const response = await fetch(
        `${isPoolMatch ? "/api/pool" : "/api/whot"}/${encodeURIComponent(match.id)}/ready`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        setErrorMessage(result.error || "Could not mark you as ready.");
        setReadyLoading(false);
        return;
      }

      setNotice(
        result.message || "You are ready. Waiting for the other player."
      );

      await loadMatch();
    } catch (error) {
      console.error("Ready-up request failed:", error);
      setErrorMessage("A network error occurred. Please try again.");
    }

    setReadyLoading(false);
  };

  const handleCancel = async () => {
    if (!match || !match.game.toLowerCase().includes("pool") || cancelLoading) return;

    const confirmed = window.confirm(
      "Cancel this Pool match? Both players will receive their full 95% net stakes back. SquadBet keeps the 5% fees already collected."
    );

    if (!confirmed) return;

    setCancelLoading(true);
    setErrorMessage("");
    setNotice("");

    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      const token = sessionData.session?.access_token;

      if (sessionError || !token) {
        setErrorMessage("Your login session has expired. Please log in again.");
        return;
      }

      const response = await fetch(
        `/api/pool/${encodeURIComponent(match.id)}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        setErrorMessage(result.error || "Could not cancel this match.");
        return;
      }

      setNotice(result.message || "Match cancelled. Both players have been refunded.");
      await loadMatch();
      router.replace("/dashboard");
    } catch (error) {
      console.error("Pool lobby cancellation failed:", error);
      setErrorMessage("A network error occurred. Please try again.");
    } finally {
      setCancelLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-white">
        Loading your match lobby...
      </main>
    );
  }

  const isPlayer1 = match?.player1_id === currentUserId;
  const myReady = isPlayer1 ? match?.player1_ready : match?.player2_ready;
  const opponentReady = isPlayer1 ? match?.player2_ready : match?.player1_ready;
  const bothReady = Boolean(match?.player1_ready && match?.player2_ready);
  const isWhot = match?.game.toLowerCase().includes("whot") ?? false;
  const isPool = match?.game.toLowerCase().includes("pool") ?? false;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-white">
      <div className="mx-auto max-w-2xl">
        <Link
          href="/dashboard"
          className="text-sm text-emerald-300 hover:text-emerald-200"
        >
          â† Back to dashboard
        </Link>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-300">
            SquadBet multiplayer
          </p>
          <h1 className="mt-2 text-3xl font-bold">Match lobby</h1>

          {errorMessage ? (
            <p className="mt-6 rounded-lg bg-red-950 p-4 text-red-200">
              {errorMessage}
            </p>
          ) : match ? (
            <>
              <div className="mt-6 rounded-xl bg-slate-800 p-4">
                <p className="text-sm text-slate-400">Shared match ID</p>
                <p className="mt-1 break-all font-mono text-sm">{match.id}</p>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-700 p-4">
                  <p className="text-sm text-slate-400">Player 1 Â· Challenger</p>
                  <p className="mt-2 text-lg font-semibold">{names.player1}</p>
                  <p className={`mt-2 text-sm ${match.player1_ready ? "text-emerald-300" : "text-amber-300"}`}>
                    {match.player1_ready ? "âœ“ Ready" : "Waiting to get ready"}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-700 p-4">
                  <p className="text-sm text-slate-400">Player 2 Â· Recipient</p>
                  <p className="mt-2 text-lg font-semibold">{names.player2}</p>
                  <p className={`mt-2 text-sm ${match.player2_ready ? "text-emerald-300" : "text-amber-300"}`}>
                    {match.player2_ready ? "âœ“ Ready" : "Waiting to get ready"}
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-3 rounded-xl bg-slate-800 p-4">
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">Game</span>
                  <span className="font-semibold">{match.game}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">Stake per player</span>
                  <span className="font-semibold">
                    â‚¦{Number(match.stake_amount).toLocaleString("en-NG")}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">Match status</span>
                  <span className="rounded-full bg-emerald-950 px-3 py-1 text-sm text-emerald-300">
                    {match.status}
                  </span>
                </div>
              </div>

              {notice && (
                <p className="mt-5 rounded-lg bg-emerald-950 p-4 text-emerald-200">
                  {notice}
                </p>
              )}

              {(isWhot || isPool) && match.status !== "in_progress" && match.status !== "completed" && match.status !== "cancelled" && (
                <div className="mt-6 rounded-xl border border-slate-700 p-5">
                  <h2 className="text-lg font-semibold">Ready to play?</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    Both players must confirm readiness. {isPool ? "Your shared 8-Ball Pool lobby will launch automatically when both players are ready." : "The Whot game will start automatically when both players are ready."}
                  </p>

                  <button
                    type="button"
                    onClick={handleReady}
                    disabled={Boolean(myReady) || readyLoading || bothReady}
                    className="mt-5 w-full rounded-xl bg-emerald-500 px-5 py-3 font-bold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
                  >
                    {readyLoading
                      ? "Confirming..."
                      : myReady
                        ? "You are ready â€” waiting for opponent"
                        : "I'm Ready"}
                  </button>

                  {isPool && (
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={cancelLoading || match.status === "in_progress"}
                      className="mt-3 w-full rounded-xl border border-red-500/60 bg-red-950/40 px-5 py-3 font-bold text-red-300 transition hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {cancelLoading ? "Cancelling match..." : "Cancel Match"}
                    </button>
                  )}

                  <p className="mt-3 text-center text-xs text-slate-400">
                    {opponentReady
                      ? "Your opponent is ready."
                      : "Waiting for your opponent to get ready."}
                  </p>
                </div>
              )}

              {!isWhot && !isPool && (
                <p className="mt-5 rounded-lg bg-amber-950 p-4 text-sm text-amber-200">
                  Ready-up is currently being connected. This match's game is {match.game}.
                </p>
              )}

              {match.status === "completed" && (
                <p className="mt-5 rounded-lg bg-slate-800 p-4 text-slate-200">
                  This match has been completed.
                </p>
              )}

              {match.status === "cancelled" && (
                <p className="mt-5 rounded-lg bg-slate-800 p-4 text-slate-200">
                  This match has been cancelled.
                </p>
              )}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export default function MatchLobbyPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
          Loading match...
        </main>
      }
    >
      <MatchLobbyContent />
    </Suspense>
  );
}
