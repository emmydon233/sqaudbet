"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../utils/supabase/client";

type PlayerProfile = {
  id: string;
  username: string;
  state: string | null;
  city: string | null;
};

type ActiveWhotMatch = {
  id: string;
  status: string;
  stake_amount: number;
  updated_at?: string;
};

type IncomingChallenge = {
  id: string;
  sender_id: string;
  recipient_id: string;
  game: string;
  stake_amount: number;
  status: string;
  created_at: string;
  sender_username: string;
};

const games = [
  {
    name: "8-ball Pool",
    players: "2 players",
    icon: "8",
    description: "Challenge another player to a realistic 8-ball pool match.",
  },
  {
    name: "Whot",
    players: "2 players",
    icon: "W",
    description: "Challenge a friend to a competitive Whot card match.",
  },
  {
    name: "Ludo",
    players: "2–4 players",
    icon: "L",
    description: "Race your pieces to victory.",
  },
];

export default function DashboardPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [notice, setNotice] = useState("");

  const [playerSearch, setPlayerSearch] = useState("");
  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");

  const [selectedPlayer, setSelectedPlayer] =
    useState<PlayerProfile | null>(null);
  const [challengeGame, setChallengeGame] = useState("8-ball Pool");
  const [stakeAmount, setStakeAmount] = useState("500");
  const [sendingChallenge, setSendingChallenge] = useState(false);
  const [challengeMessage, setChallengeMessage] = useState("");

  const [incomingChallenges, setIncomingChallenges] =
    useState<IncomingChallenge[]>([]);
  const [respondingToChallenge, setRespondingToChallenge] =
    useState<string | null>(null);
  const [challengeLoadError, setChallengeLoadError] = useState("");
  const [activeWhotMatch, setActiveWhotMatch] = useState<ActiveWhotMatch | null>(null);

  useEffect(() => {
    let active = true;

    const timer = setTimeout(() => {
      if (active) {
        setNotice(
          "Your dashboard is taking too long to load. Check your connection and refresh the page."
        );
        setLoading(false);
      }
    }, 12000);

    async function loadDashboard() {
      try {
        const { data, error } = await supabase.auth.getUser();

        if (!active) return;

        if (error || !data.user) {
          router.replace("/login");
          return;
        }

        const user = data.user;

        setEmail(user.email ?? "");
        setProfile({
          id: user.id,
          username: user.user_metadata?.username ?? "Player",
          state: user.user_metadata?.state ?? null,
          city: user.user_metadata?.city ?? null,
        });

        setLoading(false);

        const { data: savedProfile, error: profileError } =
          await supabase
            .from("profiles")
            .select("id, username, state, city")
            .eq("id", user.id)
            .maybeSingle();

        if (!active) return;

        if (savedProfile) {
          setProfile({
            id: savedProfile.id ?? user.id,
            username: savedProfile.username ?? "Player",
            state: savedProfile.state ?? null,
            city: savedProfile.city ?? null,
          });
        } else if (profileError) {
          setNotice(
            "Your account is logged in, but your saved profile could not be loaded."
          );
        }
      } catch {
        if (active) {
          setNotice(
            "Unable to load your account. Refresh the page and try again."
          );
          setLoading(false);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    void loadDashboard();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [router]);

  useEffect(() => {
    if (!profile?.id) return;
    let active = true;

    async function loadActiveWhotMatch() {
      const { data, error } = await supabase
        .from("matches")
        .select("id, status, stake_amount, created_at")
        .eq("game", "Whot")
        .eq("status", "in_progress")
        .or(`player1_id.eq.${profile!.id},player2_id.eq.${profile!.id}`)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!active) return;
      if (error) {
        console.warn("Could not load active Whot match:", error.message);
        return;
      }
      setActiveWhotMatch(data?.[0] ?? null);
    }

    void loadActiveWhotMatch();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadActiveWhotMatch();
    }, 10000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [profile?.id]);

  useEffect(() => {
    if (!profile?.id) return;
    let active = true;
    let redirecting = false;
    const pendingKey = "squadbet_pending_challenge_ids";

    async function checkSentChallenges() {
      if (!active || redirecting) return;

      let ids: string[] = [];

      try {
        ids = JSON.parse(
          sessionStorage.getItem(pendingKey) ?? "[]"
        ) as string[];
      } catch {
        sessionStorage.removeItem(pendingKey);
        return;
      }

      if (!ids.length) return;

      const { data: authData, error: authError } =
        await supabase.auth.getUser();

      if (!active || authError || !authData.user) return;

      for (const challengeId of ids) {
        const { data: challenge, error } = await supabase
          .from("challenges")
          .select("id, status")
          .eq("id", challengeId)
          .eq("sender_id", authData.user.id)
          .maybeSingle();

        if (!active) return;
        if (error || !challenge) continue;

        if (challenge.status === "rejected") {
          ids = ids.filter((id) => id !== challengeId);
          sessionStorage.setItem(pendingKey, JSON.stringify(ids));
          continue;
        }

        if (challenge.status !== "accepted") continue;

        const { data: match, error: matchError } = await supabase
          .from("matches")
          .select("id")
          .eq("challenge_id", challengeId)
          .maybeSingle();

        if (!active) return;
        if (matchError || !match) continue;

        ids = ids.filter((id) => id !== challengeId);
        sessionStorage.setItem(pendingKey, JSON.stringify(ids));

        redirecting = true;
        router.push("/match/" + encodeURIComponent(match.id));
        return;
      }
    }

    void checkSentChallenges();

    const sentChannel = supabase
      .channel(`sent-challenges-${profile.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "challenges", filter: `sender_id=eq.${profile.id}` }, () => {
        if (document.visibilityState === "visible") void checkSentChallenges();
      })
      .subscribe();
    // Fallback polling is intentionally slow and pauses while the tab is hidden.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkSentChallenges();
    }, 15000);

    return () => {
      active = false;
      window.clearInterval(interval);
      void supabase.removeChannel(sentChannel);
    };
  }, [router, profile?.id]);
  async function loadIncomingChallenges() {
    const { data: authData, error: authError } =
      await supabase.auth.getUser();

    if (authError || !authData.user) return;

    const { data: challenges, error } = await supabase
      .from("challenges")
      .select(
        "id, sender_id, recipient_id, game, stake_amount, status, created_at"
      )
      .eq("recipient_id", authData.user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading incoming challenges:", error);
      setChallengeLoadError(error.message);
      return;
    }

    setChallengeLoadError("");

    const rows = challenges ?? [];

    if (rows.length === 0) {
      setIncomingChallenges([]);
      return;
    }

    const senderIds = [
      ...new Set(rows.map((challenge) => challenge.sender_id)),
    ];

    const { data: senderProfiles, error: profileError } = await supabase
      .from("profiles")
      .select("id, username")
      .in("id", senderIds);

    if (profileError) {
      console.error("Error loading challenge senders:", profileError);
    }

    const usernames = Object.fromEntries(
      (senderProfiles ?? []).map((sender) => [
        sender.id,
        sender.username,
      ])
    );

    setIncomingChallenges(
      rows.map((challenge) => ({
        ...challenge,
        sender_username:
          usernames[challenge.sender_id] ?? "Unknown player",
      }))
    );
  }

  useEffect(() => {
    if (!profile?.id) return;

    void loadIncomingChallenges();

    const incomingChannel = supabase
      .channel(`incoming-challenges-${profile.id}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "challenges", filter: `recipient_id=eq.${profile.id}`,
      }, () => {
        if (document.visibilityState === "visible") void loadIncomingChallenges();
      })
      .subscribe();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadIncomingChallenges();
    }, 15000);

    return () => {
      window.clearInterval(interval);
      void supabase.removeChannel(incomingChannel);
    };
  }, [profile?.id]);

  async function searchPlayers(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const query = playerSearch.trim();

    if (query.length < 3) {
      setSearchMessage("Enter at least 3 characters to search.");
      setPlayers([]);
      return;
    }

    setSearching(true);
    setSearchMessage("");

    try {
      const { data: authData, error: authError } =
        await supabase.auth.getUser();

      if (authError || !authData.user) {
        setSearchMessage("Please log in again to search for players.");
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, state, city")
        .ilike("username", `%${query}%`)
        .neq("id", authData.user.id)
        .limit(20);

      if (error) {
        setSearchMessage(
          "Player search is not ready in the database yet. Check the profiles table and its read permissions in Supabase."
        );
        setPlayers([]);
        return;
      }

      setPlayers(data ?? []);
      setSearchMessage(
        data?.length
          ? `${data.length} player(s) found.`
          : "No players found. Try another username."
      );
    } catch {
      setSearchMessage("Search failed. Check your connection and try again.");
      setPlayers([]);
    } finally {
      setSearching(false);
    }
  }

  async function sendChallenge(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!selectedPlayer) return;

    const stake = Number(stakeAmount);

    if (!Number.isSafeInteger(stake) || stake < 500 || stake > 50000) {
      setChallengeMessage("Stake must be a whole naira amount between ₦500 and ₦50,000.");
      return;
    }

    setSendingChallenge(true);
    setChallengeMessage("");

    try {
      const { data, error: authError } =
        await supabase.auth.getUser();

      if (authError || !data.user) {
        setChallengeMessage("Please log in again.");
        return;
      }

      const { data: createdChallenge, error } = await supabase
        .from("challenges")
        .insert({
          sender_id: data.user.id,
          recipient_id: selectedPlayer.id,
          game: challengeGame,
          stake_amount: stake,
        })
        .select("id")
        .single();

      if (error || !createdChallenge) {
        setChallengeMessage(
          "Challenge failed: " + (error?.message ?? "No challenge ID returned.")
        );
        return;
      }

      const pendingKey = "squadbet_pending_challenge_ids";
      const savedIds = JSON.parse(
        sessionStorage.getItem(pendingKey) ?? "[]"
      ) as string[];

      sessionStorage.setItem(
        pendingKey,
        JSON.stringify([...new Set([...savedIds, createdChallenge.id])])
      );

      setChallengeMessage(
        `Challenge sent to @${selectedPlayer.username} for ${challengeGame} at ₦${stake.toLocaleString()}.`
      );

      setSelectedPlayer(null);
    } catch {
      setChallengeMessage(
        "Could not send the challenge. Check your connection."
      );
    } finally {
      setSendingChallenge(false);
    }
  }

  async function respondToChallenge(
    challengeId: string,
    status: "accepted" | "rejected"
  ) {
    setRespondingToChallenge(challengeId);
    setNotice("");

    try {
      const { data: authData, error: authError } =
        await supabase.auth.getUser();

      if (authError || !authData.user) {
        setNotice("Please log in again.");
        return;
      }

      if (status === "accepted") {
        const { error } = await supabase.rpc(
          "accept_challenge_and_reserve_stakes",
          { p_challenge_id: challengeId }
        );

        if (error) {
          console.error("Error accepting challenge:", {
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint,
          });
          setNotice("Could not accept challenge: " + error.message);
          await loadIncomingChallenges();
          return;
        }

        const { data: match, error: matchError } = await supabase
          .from("matches")
          .select("id")
          .eq("challenge_id", challengeId)
          .single();

        if (matchError || !match) {
          console.error("Challenge accepted, but shared match lookup failed:", matchError);
          setNotice(
            "Challenge accepted, but the shared lobby could not be loaded. Refresh the dashboard and try again."
          );
          return;
        }

        router.push("/match/" + encodeURIComponent(match.id));
        return;
      }

      const { error } = await supabase.rpc("reject_challenge", {
        p_challenge_id: challengeId,
      });

      if (error) {
        console.error("Error rejecting challenge:", error.message);
        setNotice("Could not reject challenge: " + error.message);
        await loadIncomingChallenges();
        return;
      }

      setNotice("Challenge rejected.");
      await loadIncomingChallenges();
    } catch (error) {
      console.error("Challenge response failed:", error);
      setNotice("Something went wrong. Please try again.");
    } finally {
      setRespondingToChallenge(null);
    }
  }
  async function handleLogout() {
    setNotice("");

    try {
      const { error } = await supabase.auth.signOut();

      if (error) {
        setNotice("Logout failed: " + error.message);
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setNotice("Unable to log out. Please try again.");
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-center text-white">
        Loading your SquadBet dashboard...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-7xl flex-col items-stretch gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-5">
          <a href="/" className="text-2xl font-black">
            <span className="text-emerald-400">Squad</span>Bet
          </a>

          <nav className="flex flex-wrap items-center gap-2 text-xs sm:gap-4 sm:text-sm">
            <a href="/" className="min-h-10 inline-flex items-center rounded-lg px-2 hover:bg-slate-800 hover:text-emerald-400 sm:px-0">
              Home
            </a>
            <a href="#games" className="min-h-10 inline-flex items-center rounded-lg px-2 hover:bg-slate-800 hover:text-emerald-400 sm:px-0">
              Games
            </a>
            <a href="#incoming" className="min-h-10 inline-flex items-center rounded-lg px-2 hover:bg-slate-800 hover:text-emerald-400 sm:px-0">
              Incoming challenges
            </a>
            <a href="#friends" className="min-h-10 inline-flex items-center rounded-lg px-2 hover:bg-slate-800 hover:text-emerald-400 sm:px-0">
              Friends
            </a>
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 hover:bg-slate-800"
            >
              Log out
            </button>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-10">
        {notice && (
          <p
            role="status"
            className="mb-5 rounded-xl bg-amber-950 p-4 text-amber-200"
          >
            {notice}
          </p>
        )}

        <section className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-7 sm:p-10">
          <p className="font-semibold uppercase tracking-widest text-emerald-400">
            Your gaming hub
          </p>

          <h1 className="mt-3 text-3xl font-black sm:text-5xl">
            Welcome back, {profile?.username ?? "Player"}!
          </h1>

          <p className="mt-4 max-w-2xl text-slate-400">
            Find opponents, challenge friends, and get ready to play 8-ball
            Pool, Whot, and Ludo.
          </p>

          <a
            href="#games"
            className="mt-7 inline-block rounded-xl bg-emerald-400 px-6 py-3 font-bold text-slate-950 hover:bg-emerald-300"
          >
            Explore games
          </a>
        </section>

        {activeWhotMatch && (
          <section className="mt-6 rounded-2xl border border-emerald-500/40 bg-emerald-950/30 p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">Your game is still active</p>
            <h2 className="mt-2 text-2xl font-black">Continue your Whot match</h2>
            <p className="mt-2 text-sm text-slate-300">You can return to the same match. Your cards and turn are loaded from the saved game session.</p>
            <button
              type="button"
              onClick={() => router.push(`/whot?matchId=${encodeURIComponent(activeWhotMatch.id)}`)}
              className="mt-4 min-h-12 rounded-xl bg-emerald-400 px-6 py-3 font-bold text-slate-950 hover:bg-emerald-300"
            >
              Continue your game
            </button>
          </section>
        )}

        <section className="mt-8 grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm text-slate-400">Player profile</p>

            <h2 className="mt-2 text-2xl font-bold">
              @{profile?.username ?? "Player"}
            </h2>

            <p className="mt-2 break-all text-sm text-slate-400">{email}</p>

            <p className="mt-3 text-sm text-slate-300">
              {[profile?.city, profile?.state].filter(Boolean).join(", ") ||
                "Location not added"}
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-900 bg-emerald-950/30 p-6">
            <p className="text-sm text-emerald-300">Virtual coins</p>
            <h2 className="mt-2 text-3xl font-black">Coming soon</h2>
            <p className="mt-3 text-sm text-slate-400">
              The virtual wallet will be connected to the database in the next
              stage.
            </p>
          </div>
        </section>

        <section
          id="incoming"
          className="mt-12 scroll-mt-6 rounded-2xl border border-emerald-900 bg-slate-900 p-7"
        >
          <p className="font-semibold uppercase tracking-widest text-emerald-400">
            Challenges for you
          </p>

          <h2 className="mt-2 text-2xl font-bold">Incoming Challenges</h2>

          <p className="mt-2 text-sm text-slate-400">
            Pending challenges refresh automatically every 5 seconds.
          </p>

          {challengeLoadError && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-red-950 p-4 text-sm text-red-200"
            >
              Could not load challenges: {challengeLoadError}
            </p>
          )}

          {!challengeLoadError && incomingChallenges.length === 0 && (
            <p className="mt-5 rounded-xl bg-slate-950 p-5 text-slate-400">
              No pending challenges right now.
            </p>
          )}

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {incomingChallenges.map((challenge) => (
              <article
                key={challenge.id}
                className="rounded-xl border border-slate-700 bg-slate-950 p-5"
              >
                <p className="text-sm text-emerald-400">
                  Challenge from
                </p>

                <h3 className="mt-1 text-xl font-bold">
                  @{challenge.sender_username}
                </h3>

                <p className="mt-3 text-slate-300">
                  Game:{" "}
                  <span className="font-semibold">{challenge.game}</span>
                </p>

                <p className="mt-1 text-slate-300">
                  Stake:{" "}
                  <span className="font-semibold">
                    ₦{Number(challenge.stake_amount).toLocaleString()}
                  </span>
                </p>

                <p className="mt-1 text-sm text-slate-500">
                  Status: {challenge.status}
                </p>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={respondingToChallenge !== null}
                    onClick={() =>
                      void respondToChallenge(challenge.id, "accepted")
                    }
                    className="rounded-lg bg-emerald-400 px-5 py-2 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {respondingToChallenge === challenge.id
                      ? "Please wait..."
                      : "Accept"}
                  </button>

                  <button
                    type="button"
                    disabled={respondingToChallenge !== null}
                    onClick={() =>
                      void respondToChallenge(challenge.id, "rejected")
                    }
                    className="rounded-lg border border-red-800 px-5 py-2 font-bold text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="games" className="mt-12 scroll-mt-6">
          <p className="font-semibold uppercase tracking-widest text-emerald-400">
            Choose your game
          </p>

          <h2 className="mt-2 text-3xl font-black">Ready to play?</h2>

          <div className="mt-6 grid gap-5 md:grid-cols-3">
            {games.map((game) => (
              <article
                key={game.name}
                className="rounded-2xl border border-slate-800 bg-slate-900 p-6 hover:border-emerald-500"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-400 text-2xl font-black text-slate-950">
                  {game.icon}
                </div>

                <h3 className="mt-5 text-2xl font-bold">{game.name}</h3>

                <p className="mt-2 text-sm text-emerald-400">
                  {game.players}
                </p>

                <p className="mt-3 text-sm leading-6 text-slate-400">
                  {game.description}
                </p>

                <button
                  type="button"
                  onClick={() => {
                    const destination = game.name === "8-ball Pool"
                      ? "/pool3d"
                      : game.name === "Whot"
                        ? "/whot"
                        : "/ludo";
                    router.push(destination);
                  }}
                  className="mt-5 min-h-12 w-full touch-manipulation rounded-xl bg-slate-800 px-4 py-3 font-semibold hover:bg-emerald-400 hover:text-slate-950 active:scale-[0.99]"
                >
                  Select {game.name}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section
          id="friends"
          className="mt-12 scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-7"
        >
          <p className="font-semibold uppercase tracking-widest text-emerald-400">
            Find your squad
          </p>

          <h2 className="mt-2 text-2xl font-bold">Find Players</h2>

          <p className="mt-2 text-slate-400">
            Search for other SquadBet players by username.
          </p>

          <form
            onSubmit={searchPlayers}
            className="mt-5 flex flex-col gap-3 sm:flex-row"
          >
            <input
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="Enter a username..."
              aria-label="Search players by username"
              minLength={3}
              maxLength={20}
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400"
            />

            <button
              type="submit"
              disabled={searching}
              className="rounded-xl bg-emerald-400 px-6 py-3 font-bold text-slate-950 disabled:opacity-60"
            >
              {searching ? "Searching..." : "Search players"}
            </button>
          </form>

          {searchMessage && (
            <p role="status" className="mt-4 text-sm text-slate-300">
              {searchMessage}
            </p>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {players.map((player, index) => (
              <article
                key={`${player.username}-${index}`}
                className="rounded-xl border border-slate-800 bg-slate-950 p-4"
              >
                <h3 className="font-bold text-emerald-400">
                  @{player.username}
                </h3>

                <p className="mt-1 text-sm text-slate-400">
                  {[player.city, player.state].filter(Boolean).join(", ") ||
                    "Location not added"}
                </p>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedPlayer(player);
                    setChallengeMessage("");
                  }}
                  className="mt-4 w-full rounded-lg bg-emerald-400 px-4 py-2 font-bold text-slate-950 hover:bg-emerald-300"
                >
                  Challenge player
                </button>
              </article>
            ))}
          </div>

          {selectedPlayer && (
            <form
              onSubmit={sendChallenge}
              className="mt-6 rounded-xl border border-emerald-800 bg-slate-950 p-5"
            >
              <h3 className="text-xl font-bold">
                Challenge @{selectedPlayer.username}
              </h3>

              <label className="mt-4 block text-sm text-slate-300">
                Game
              </label>

              <select
                value={challengeGame}
                onChange={(e) => setChallengeGame(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-white"
              >
                <option value="8-ball Pool">8-ball Pool</option>
                <option value="Whot">Whot</option>
                <option value="Ludo">Ludo</option>
              </select>

              <label className="mt-4 block text-sm text-slate-300">
                Stake amount
              </label>

              <select
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-white"
              >
                <option value="500">₦500</option>
                <option value="1000">₦1,000</option>
                <option value="1500">₦1,500</option>
                <option value="2000">₦2,000</option>
              </select>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={sendingChallenge}
                  className="rounded-lg bg-emerald-400 px-5 py-3 font-bold text-slate-950 disabled:opacity-60"
                >
                  {sendingChallenge ? "Sending..." : "Send challenge"}
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedPlayer(null)}
                  className="rounded-lg border border-slate-700 px-5 py-3"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {challengeMessage && (
            <p
              role="status"
              className="mt-4 rounded-lg bg-slate-950 p-4 text-sm text-slate-200"
            >
              {challengeMessage}
            </p>
          )}
        </section>

        <footer className="mt-12 border-t border-slate-800 py-6 text-center text-sm text-slate-500">
          SquadBet - Play together, compete fairly.
        </footer>
      </div>
    </main>
  );
}
