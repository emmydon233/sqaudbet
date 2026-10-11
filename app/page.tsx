"use client";

import { useState } from "react";

type Game = {
  name: string;
  players: string;
  description: string;
  emoji: string;
  color: string;
  gradient: string;
};

const games: Game[] = [
  {
    name: "Snooker",
    players: "2 Players",
    description: "Line up your shots. Own the table.",
    emoji: "🎱",
    color: "#43e0a0",
    gradient: "linear-gradient(135deg, #103d32, #071f1b)",
  },
  {
    name: "Whot",
    players: "2 Players",
    description: "Play your cards. Outsmart your rival.",
    emoji: "🃏",
    color: "#b69aff",
    gradient: "linear-gradient(135deg, #35245c, #19122c)",
  },
  {
    name: "Ludo",
    players: "2–4 Players",
    description: "Roll the dice. Race to victory.",
    emoji: "🎲",
    color: "#ffb75e",
    gradient: "linear-gradient(135deg, #57331b, #25180f)",
  },
];

const stakes = [500, 1000, 1500, 2000];

export default function Home() {
  const [balance, setBalance] = useState(5000);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [selectedStake, setSelectedStake] = useState(500);
  const [customStake, setCustomStake] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState("Games");

  const stake = customStake ? Number(customStake) : selectedStake;

  function createRoom() {
    if (!selectedGame) return;

    if (!Number.isFinite(stake) || stake < 1) {
      setNotice("Enter a valid virtual-coin stake.");
      return;
    }

    if (stake > balance) {
      setNotice("Your virtual-coin balance is too low for this stake.");
      return;
    }

    setBalance((previous) => previous - stake);
    setNotice(
      `${selectedGame.name} room created with ${stake.toLocaleString()} virtual coins. Online matchmaking will be added next.`
    );
    setSelectedGame(null);
    setCustomStake("");
  }

  return (
    <main className="min-h-screen bg-[#080b10] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-64 shrink-0 border-r border-white/10 bg-[#0c1017] p-6 md:flex md:flex-col">
          <a href="#" className="mb-12 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-400 text-2xl text-black">
              ♠
            </span>
            <span>
              <span className="block text-xl font-black tracking-tight">
                Squad<span className="text-emerald-400">Bet</span>
              </span>
              <span className="text-xs text-gray-500">PLAY. COMPETE. WIN.</span>
            </span>
          </a>

          <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-gray-500">
            Menu
          </p>

          <nav className="space-y-2">
            {[
              ["Games", "⌂"],
              ["Play with Friends", "♧"],
              ["Find Players", "⌕"],
              ["Leaderboard", "♛"],
            ].map(([label, icon]) => (
              <button
                key={label}
                onClick={() => {
                  setActiveTab(label);
                  if (label !== "Games") {
                    setNotice(
                      `${label} will be connected when we add player accounts and multiplayer.`
                    );
                  } else {
                    setNotice("");
                  }
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold transition ${
                  activeTab === label
                    ? "bg-emerald-400/10 text-emerald-300"
                    : "text-gray-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span className="text-xl">{icon}</span>
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl border border-white/10 bg-[#121923] p-4">
            <span className="text-2xl">🛡️</span>
            <p className="mt-3 font-bold">Play responsibly</p>
            <p className="mt-1 text-xs leading-5 text-gray-400">
              This is a virtual-coin demo. Coins have no cash value.
            </p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-white/10 px-5 py-5 sm:px-8">
            <div className="flex items-center gap-3 md:hidden">
              <span className="text-2xl text-emerald-400">♠</span>
              <span className="text-lg font-black">
                Squad<span className="text-emerald-400">Bet</span>
              </span>
            </div>

            <div className="hidden md:block">
              <p className="text-sm text-gray-400">Welcome to the arena</p>
              <h1 className="text-xl font-bold">Find your next challenge.</h1>
            </div>

            <div className="flex items-center gap-3">
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 sm:px-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                  Demo coins
                </p>
                <p className="font-bold text-emerald-300">
                  🪙 {balance.toLocaleString()}
                </p>
              </div>
              <button
                onClick={() =>
                  setNotice(
                    "Player profiles and sign-in will be connected in the next stage."
                  )
                }
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#1b2430] font-bold"
                aria-label="Open profile"
              >
                P
              </button>
            </div>
          </header>

          <div className="p-5 sm:p-8 lg:p-10">
            <div className="relative overflow-hidden rounded-3xl border border-emerald-300/15 bg-gradient-to-br from-[#12372e] via-[#10241f] to-[#10151e] p-6 sm:p-10">
              <div className="pointer-events-none absolute -right-12 -top-16 h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl" />
              <div className="relative max-w-2xl">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-black/20 px-3 py-1.5 text-xs font-bold text-emerald-300">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  YOUR NEXT MATCH STARTS HERE
                </span>

                <h2 className="mt-6 text-4xl font-black leading-tight tracking-tight sm:text-6xl">
                  Bring your
                  <br />
                  <span className="text-emerald-400">A-game.</span>
                </h2>

                <p className="mt-4 max-w-md text-sm leading-6 text-gray-300 sm:text-base">
                  Challenge your friends, meet new rivals across Nigeria, and
                  climb the SquadBet leaderboard.
                </p>

                <button
                  onClick={() =>
                    document
                      .getElementById("games")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                  className="mt-7 rounded-xl bg-emerald-400 px-6 py-3 font-extrabold text-[#07120e] transition hover:bg-emerald-300"
                >
                  Explore games <span className="ml-2">→</span>
                </button>
              </div>

              <div className="pointer-events-none absolute bottom-3 right-4 hidden text-[150px] opacity-15 lg:block">
                🎱
              </div>
            </div>

            <div className="mt-9 flex flex-wrap items-end justify-between gap-4" id="games">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">
                  Choose your battle
                </p>
                <h2 className="mt-2 text-2xl font-black sm:text-3xl">
                  Popular games
                </h2>
                <p className="mt-2 text-sm text-gray-400">
                  Pick a game and set your virtual-coin stake.
                </p>
              </div>
              <span className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-400">
                3 GAMES AVAILABLE
              </span>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-3">
              {games.map((game) => (
                <article
                  key={game.name}
                  className="group overflow-hidden rounded-2xl border border-white/10 bg-[#10151d] transition duration-300 hover:-translate-y-1 hover:border-white/20"
                >
                  <div
                    className="relative flex h-44 items-center justify-center overflow-hidden"
                    style={{ background: game.gradient }}
                  >
                    <div
                      className="absolute h-36 w-36 rounded-full opacity-20 blur-2xl"
                      style={{ background: game.color }}
                    />
                    <span className="relative text-8xl drop-shadow-2xl transition duration-300 group-hover:scale-110">
                      {game.emoji}
                    </span>
                    <span className="absolute left-4 top-4 rounded-lg border border-white/10 bg-black/30 px-3 py-1 text-xs font-bold">
                      {game.players}
                    </span>
                  </div>

                  <div className="p-5">
                    <h3 className="text-xl font-extrabold">{game.name}</h3>
                    <p className="mt-2 min-h-10 text-sm leading-5 text-gray-400">
                      {game.description}
                    </p>
                    <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                      <span className="text-xs text-gray-500">
                        Virtual coins
                      </span>
                      <button
                        onClick={() => {
                          setSelectedGame(game);
                          setNotice("");
                          setCustomStake("");
                          setSelectedStake(500);
                        }}
                        className="rounded-xl px-4 py-2.5 text-sm font-extrabold text-black transition hover:brightness-110"
                        style={{ backgroundColor: game.color }}
                      >
                        Play now →
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <button
                onClick={() =>
                  setNotice(
                    "Friend invitations need registered player accounts. We'll build this feature next."
                  )
                }
                className="flex items-center gap-4 rounded-2xl border border-white/10 bg-[#10151d] p-5 text-left transition hover:border-emerald-400/30"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-400/10 text-2xl">
                  👥
                </span>
                <span>
                  <span className="block font-bold">Play with friends</span>
                  <span className="mt-1 block text-sm text-gray-400">
                    Invite your crew to a private match.
                  </span>
                </span>
                <span className="ml-auto text-gray-500">→</span>
              </button>

              <button
                onClick={() =>
                  setNotice(
                    "Nationwide player search will work after we add user accounts and a shared database."
                  )
                }
                className="flex items-center gap-4 rounded-2xl border border-white/10 bg-[#10151d] p-5 text-left transition hover:border-emerald-400/30"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-400/10 text-2xl">
                  🌍
                </span>
                <span>
                  <span className="block font-bold">Meet new players</span>
                  <span className="mt-1 block text-sm text-gray-400">
                    Connect with players around Nigeria.
                  </span>
                </span>
                <span className="ml-auto text-gray-500">→</span>
              </button>
            </div>

            {notice && (
              <div
                role="status"
                className="mt-6 flex items-start justify-between gap-4 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm leading-6 text-emerald-100"
              >
                <p>{notice}</p>
                <button
                  onClick={() => setNotice("")}
                  className="shrink-0 text-lg"
                  aria-label="Dismiss message"
                >
                  ×
                </button>
              </div>
            )}

            <footer className="mt-12 border-t border-white/10 py-6 text-center text-xs leading-6 text-gray-500">
              © 2026 SquadBet · Play fair. Respect every player.
              <br />
              Demo only. Virtual coins are not money and cannot be withdrawn.
            </footer>
          </div>
        </section>
      </div>

      {selectedGame && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedGame(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="stake-title"
            className="w-full max-w-md rounded-3xl border border-white/10 bg-[#111720] p-6 shadow-2xl sm:p-8"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">
                  Create a demo room
                </p>
                <h2 id="stake-title" className="mt-2 text-2xl font-black">
                  {selectedGame.emoji} {selectedGame.name}
                </h2>
              </div>
              <button
                onClick={() => setSelectedGame(null)}
                className="rounded-lg px-3 py-1 text-2xl text-gray-400 hover:bg-white/5"
                aria-label="Close dialog"
              >
                ×
              </button>
            </div>

            <p className="mt-3 text-sm leading-6 text-gray-400">
              Choose how many virtual coins to use for this demo room.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              {stakes.map((amount) => (
                <button
                  key={amount}
                  onClick={() => {
                    setSelectedStake(amount);
                    setCustomStake("");
                  }}
                  className={`rounded-xl border p-4 text-left font-bold transition ${
                    !customStake && selectedStake === amount
                      ? "border-emerald-400 bg-emerald-400/10 text-emerald-300"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20"
                  }`}
                >
                  🪙 {amount.toLocaleString()}
                </button>
              ))}
            </div>

            <label
              htmlFor="custom-stake"
              className="mt-5 block text-sm font-semibold text-gray-300"
            >
              Or enter a custom amount
            </label>
            <input
              id="custom-stake"
              type="number"
              min="1"
              step="1"
              value={customStake}
              onChange={(event) => setCustomStake(event.target.value)}
              placeholder="Enter virtual coins"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#080b10] px-4 py-3 outline-none focus:border-emerald-400"
            />

            <div className="mt-5 flex items-center justify-between rounded-xl bg-white/[0.04] p-4">
              <span className="text-sm text-gray-400">Your balance</span>
              <span className="font-bold">🪙 {balance.toLocaleString()}</span>
            </div>

            <button
              onClick={createRoom}
              className="mt-5 w-full rounded-xl bg-emerald-400 py-4 font-extrabold text-[#07120e] transition hover:bg-emerald-300"
            >
              Create demo room
            </button>

            <p className="mt-4 text-center text-xs leading-5 text-gray-500">
              No real-money deposits, bets, or payouts. This demo does not
              connect you to another player yet.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}