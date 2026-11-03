"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/utils/supabase/client";

type Game = {
  name: string;
  players: string;
  description: string;
  emoji: string;
  category: string;
  gradient: string;
  glow: string;
  accent: string;
  route: string;
};

const games: Game[] = [
  {
    name: "8-Ball Pool",
      players: "1–2 players",
    description:
      "Line up your shot, control the cue ball and sink the 8-ball.",
      emoji: "\uD83C\uDFB1",
    category: "SPORTS & SKILL",
    gradient: "from-teal-950 via-emerald-900 to-cyan-950",
    glow: "rgba(45, 212, 191, 0.24)",
    accent: "text-teal-300",
    route: "/pool3d",
  },
  {
    name: "Whot",
      players: "1–2 players",
    description:
      "Match shapes, play your special cards and outsmart your opponent.",
      emoji: "\uD83C\uDC0F",
    category: "CARD STRATEGY",
    gradient: "from-fuchsia-950 via-purple-900 to-indigo-950",
    glow: "rgba(192, 132, 252, 0.24)",
    accent: "text-purple-300",
    route: "/whot",
  },
  {
    name: "Ludo",
      players: "2–4 players",
    description:
      "Roll the dice, move your tokens and race your way to victory.",
      emoji: "\uD83C\uDFB2",
    category: "CLASSIC BOARD",
    gradient: "from-amber-950 via-orange-900 to-rose-950",
    glow: "rgba(251, 191, 36, 0.24)",
    accent: "text-amber-300",
    route: "/ludo",
  },
];

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let mounted = true;

    supabase.auth.getUser().then(({ data, error }) => {
      if (!mounted) return;
      setUser(error ? null : data.user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  function openGame(game: Game) {
    if (!user) {
      router.push(`/login?next=${encodeURIComponent(game.route)}`);
      return;
    }
    router.push(game.route);
  }

  async function handleLogout() {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setNotice("Unable to sign out. Please try again.");
      return;
    }
    setUser(null);
    setNotice("You have signed out successfully.");
    router.refresh();
  }

  return (
    <main className="squad-home min-h-screen overflow-hidden bg-[#070b14] text-white">
      <style>{`
        @keyframes squadFadeUp {
          from { opacity: 0; transform: translateY(22px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes squadAmbient {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(0, -18px, 0) scale(1.06); }
        }
        @keyframes squadShimmer {
          from { transform: translateX(-150%) skewX(-18deg); }
          to { transform: translateX(250%) skewX(-18deg); }
        }
        .squad-reveal {
          animation: squadFadeUp .7s ease-out both;
        }
        .squad-game-card {
          position: relative;
          isolation: isolate;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.09);
          transition: transform .28s ease, border-color .28s ease,
            box-shadow .28s ease;
        }
        .squad-game-card:hover {
          transform: translateY(-7px);
          border-color: rgba(255,255,255,.24);
        }
        .squad-game-card::after {
          content: "";
          position: absolute;
          z-index: -1;
          top: 0;
          bottom: 0;
          left: -50%;
          width: 35%;
          background: linear-gradient(90deg, transparent,
            rgba(255,255,255,.08), transparent);
          transform: skewX(-18deg);
          pointer-events: none;
        }
        .squad-game-card:hover::after {
          animation: squadShimmer .85s ease;
        }
        .squad-game-art {
          transition: transform .35s ease;
        }
        .squad-game-card:hover .squad-game-art {
          transform: scale(1.045);
        }
        .squad-action {
          transition: transform .2s ease, background-color .2s ease;
        }
        .squad-action:hover { transform: translateY(-2px); }
        .squad-ambient {
          animation: squadAmbient 9s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .squad-reveal, .squad-ambient { animation: none !important; }
          .squad-game-card, .squad-game-art, .squad-action {
            transition: none !important;
          }
        }
      `}</style>

      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="squad-ambient absolute -left-40 -top-40 h-96 w-96 rounded-full bg-emerald-500/10 blur-[110px]" />
        <div className="squad-ambient absolute -right-40 top-1/3 h-96 w-96 rounded-full bg-violet-500/10 blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.07),transparent_50%)]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 sm:px-8">
        <header className="flex items-center justify-between border-b border-white/[0.08] py-5">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-400/10 text-xl font-black text-emerald-300 shadow-lg shadow-emerald-950/30">
              S
            </span>
            <span>
              <span className="block text-lg font-black tracking-tight">
                Squad<span className="text-emerald-300">Bet</span>
              </span>
              <span className="block text-[10px] font-semibold uppercase tracking-[.25em] text-slate-500">
                Play together
              </span>
            </span>
          </Link>

          <nav className="flex max-w-[68%] flex-wrap items-center justify-end gap-2 sm:max-w-none sm:gap-3">
            <Link
              href="/"
              className="hidden rounded-full px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white sm:inline-flex"
            >
              Home
            </Link>
            {loading ? (
              <>
                <Link
                  href="/login"
                  className="min-h-10 rounded-full px-3 py-2 text-xs font-semibold text-slate-300 sm:px-4 sm:text-sm"
                >
                  Log in
                </Link>
                <Link
                  href="/register"
                  className="squad-action min-h-10 rounded-full bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950 sm:px-4 sm:text-sm"
                >
                  Get started
                </Link>
              </>
            ) : user ? (
              <>
                <Link
                  href="/dashboard"
                  className="min-h-10 rounded-full bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300 transition hover:bg-emerald-400/20 sm:px-4 sm:text-sm"
                >
                  Dashboard
                </Link>
                <span className="inline-block max-w-28 truncate text-xs text-slate-300 sm:max-w-36 sm:text-sm">
                  {user.user_metadata?.username ||
                    user.user_metadata?.full_name ||
                    user.email?.split("@")[0] ||
                    "Player"}
                </span>
                <button
                  onClick={handleLogout}
                  className="squad-action min-h-10 rounded-full border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5 hover:text-white sm:px-4 sm:text-sm"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="min-h-10 rounded-full px-3 py-2 text-xs font-semibold text-slate-300 transition hover:text-white sm:px-4 sm:text-sm"
                >
                  Log in
                </Link>
                <Link
                  href="/register"
                  className="squad-action min-h-10 rounded-full bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950 shadow-lg shadow-emerald-950/40 hover:bg-emerald-300 sm:px-4 sm:text-sm"
                >
                  Get started
                </Link>
              </>
            )}
          </nav>
        </header>

        <section className="squad-reveal relative py-16 sm:py-24">
          <div className="absolute right-4 top-16 hidden h-32 w-32 items-center justify-center rounded-full border border-emerald-300/10 bg-emerald-300/[0.03] text-6xl opacity-70 md:flex">
            &#127921;
          </div>

          <div className="relative max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/[0.07] px-4 py-2 text-xs font-bold uppercase tracking-[.18em] text-emerald-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
              Your next game starts here
            </div>

            <h1 className="max-w-3xl text-4xl font-black leading-[1.08] tracking-tight sm:text-6xl lg:text-7xl">
              Good games.
              <br />
              <span className="bg-gradient-to-r from-emerald-300 via-teal-200 to-cyan-300 bg-clip-text text-transparent">
                Better together.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-slate-400 sm:text-lg sm:leading-8">
              Pick your game, sharpen your skills and challenge your people.
              Your next favourite match is just one click away.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#games"
                className="squad-action inline-flex items-center gap-2 rounded-full bg-emerald-400 px-6 py-3.5 text-sm font-extrabold text-slate-950 shadow-xl shadow-emerald-950/40 hover:bg-emerald-300"
              >
                Explore games <span aria-hidden="true">&#8594;</span>
              </a>
              {!user && !loading && (
                <Link
                  href="/register"
                  className="squad-action rounded-full border border-white/10 bg-white/[0.03] px-6 py-3.5 text-sm font-bold text-white hover:bg-white/[0.07]"
                >
                  Create your account
                </Link>
              )}
            </div>

            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-500">
              <span className="flex items-center gap-2">
                <span className="text-emerald-300">&#10022;</span> Skill-based fun
              </span>
              <span className="flex items-center gap-2">
                <span className="text-emerald-300">&#10022;</span> Multiple games
              </span>
              <span className="flex items-center gap-2">
                <span className="text-emerald-300">&#10022;</span> Made for your squad
              </span>
            </div>
          </div>
        </section>

        {notice && (
          <div
            role="status"
            className="mb-6 flex items-center justify-between rounded-xl border border-emerald-300/20 bg-emerald-300/[0.07] px-4 py-3 text-sm text-emerald-200"
          >
            <span>{notice}</span>
            <button
              onClick={() => setNotice("")}
              className="ml-4 text-emerald-100/70 hover:text-white"
              aria-label="Dismiss notification"
            >
              &#10003;
            </button>
          </div>
        )}

        <section id="games" className="pb-16 sm:pb-24">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-3 text-xs font-bold uppercase tracking-[.24em] text-emerald-300">
                The game room
              </p>
              <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
                Choose your game
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">
                Different games, different strategies. Find your favourite and
                make your next move.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-slate-400">
              {games.length} games available
            </span>
          </div>

          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {games.map((game, index) => (
              <article
                key={game.name}
                className="squad-game-card squad-reveal group rounded-3xl bg-[#0c1220]"
                style={{
                  animationDelay: `${index * 110}ms`,
                  boxShadow: `0 20px 60px -30px ${game.glow}`,
                }}
              >
                <div
                  className={`squad-game-art relative flex h-52 items-center justify-center overflow-hidden bg-gradient-to-br ${game.gradient}`}
                >
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.10),transparent_45%)]" />
                  <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.12)_1px,transparent_1px)] [background-size:32px_32px]" />
                  <div className="absolute left-5 top-5 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 text-[10px] font-bold tracking-[.17em] text-white/80 backdrop-blur">
                    {game.category}
                  </div>
                  <div className="relative flex h-28 w-28 items-center justify-center rounded-[2rem] border border-white/15 bg-black/15 text-7xl shadow-2xl backdrop-blur-sm transition duration-300 group-hover:scale-110">
                    <span role="img" aria-label={game.name}>
                      {game.emoji}
                    </span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-black/25 to-transparent" />
                </div>

                <div className="p-6">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <h3 className="text-2xl font-extrabold tracking-tight">
                      {game.name}
                    </h3>
                    <span
                      className={`shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold ${game.accent}`}
                    >
                      {game.players}
                    </span>
                  </div>
                  <p className="min-h-[48px] text-sm leading-6 text-slate-400">
                    {game.description}
                  </p>
                  <button
                    onClick={() => openGame(game)}
                    type="button"
                    className="squad-action mt-6 flex min-h-12 w-full touch-manipulation items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3.5 text-sm font-bold text-white hover:border-emerald-300/30 hover:bg-emerald-300/10"
                  >
                    <span>Play {game.name}</span>
                    <span className="text-lg text-emerald-300 transition-transform group-hover:translate-x-1">
                      &#8594;
                    </span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mb-16 overflow-hidden rounded-3xl border border-white/[0.09] bg-gradient-to-br from-[#101a27] via-[#0d1421] to-[#111027] p-7 sm:mb-24 sm:p-10">
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
            <div className="max-w-2xl">
              <div className="mb-3 text-xs font-bold uppercase tracking-[.22em] text-teal-300">
                One squad. Many ways to play.
              </div>
              <h2 className="text-2xl font-black tracking-tight sm:text-3xl">
                Ready to make your move?
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-400 sm:text-base">
                Sign in to access your games. Online multiplayer rooms and
                additional features can be added as the platform grows.
              </p>
            </div>
            <Link
              href={user ? "/pool3d" : "/register"}
              className="squad-action inline-flex shrink-0 items-center justify-center rounded-full bg-white px-6 py-3.5 text-sm font-extrabold text-slate-950 hover:bg-emerald-200"
            >
              {user ? "Enter game room" : "Join SquadBet"} <span className="ml-2">&#8594;</span>
            </Link>
          </div>
        </section>

        <footer className="mt-auto flex flex-col gap-4 border-t border-white/[0.08] py-7 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            &#169; 2026 SquadBet. Play fair. Have fun.
          </p>
          <div className="flex flex-wrap gap-5">
            <Link href="/privacy" className="transition hover:text-white">
              Privacy
            </Link>
            <Link href="/terms" className="transition hover:text-white">
              Terms
            </Link>
            <Link href="/contact" className="transition hover:text-white">
              Contact
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}



