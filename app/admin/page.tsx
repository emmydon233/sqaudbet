"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../utils/supabase/client";

type Player = {
  id: string;
  username: string;
  state: string | null;
  city: string | null;
  created_at: string;
};

export default function AdminPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  const loadPlayers = useCallback(async () => {
    setLoadingPlayers(true);
    setMessage("");

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, state, city, created_at")
        .order("created_at", { ascending: false });

      if (error) {
        setMessage("Could not load players: " + error.message);
      } else {
        setPlayers((data ?? []) as Player[]);
      }
    } catch {
      setMessage("Unable to connect to Supabase. Please try again.");
    } finally {
      setLoadingPlayers(false);
    }
  }, []);

  useEffect(() => {
    async function checkAdmin() {
      try {
        const { data, error } = await supabase.auth.getUser();

        if (error || !data.user) {
          router.replace("/login");
          return;
        }

        const { data: roleRecord, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", data.user.id)
          .maybeSingle();

        if (roleError || roleRecord?.role !== "super_admin") {
          setAuthorized(false);
          setChecking(false);
          return;
        }

        setAuthorized(true);
        setChecking(false);
        await loadPlayers();
      } catch {
        setMessage("Could not verify administrator access.");
        setChecking(false);
      }
    }

    void checkAdmin();
  }, [router, loadPlayers]);

  const filteredPlayers = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) return players;

    return players.filter((player) =>
      [player.username, player.state ?? "", player.city ?? ""].some(
        (value) => value.toLowerCase().includes(term)
      )
    );
  }, [players, search]);

  const stateCount = useMemo(
    () => new Set(players.map((p) => p.state?.trim()).filter(Boolean)).size,
    [players]
  );
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
  }, []);


  const recentCount = useMemo(() => {
    if (now === null) return 0;
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    return players.filter((p) => {
      const date = new Date(p.created_at).getTime();
      return Number.isFinite(date) && date >= cutoff;
    }).length;
  }, [players, now]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#080d18] text-slate-300">
        Checking administrator access...
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#080d18] px-5 text-white">
        <div className="max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8">
          <h1 className="text-2xl font-bold">Admin access required</h1>
          <p className="mt-3 text-slate-400">
            This account has not been authorized as a SquadBet administrator.
          </p>
          <a href="/" className="mt-6 inline-block font-semibold text-emerald-400">
            Return to SquadBet
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#080d18] text-white">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-white/10 bg-[#0b1220] p-6 lg:block">
          <a href="/" className="text-2xl font-black tracking-tight">
            Squad<span className="text-emerald-400">Bet</span>
          </a>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-500">
            Administration
          </p>

          <nav className="mt-10 space-y-2">
            <a href="#overview" className="flex rounded-xl bg-emerald-400/10 px-4 py-3 font-semibold text-emerald-300">
              Overview
            </a>
            <a href="#players" className="flex rounded-xl px-4 py-3 text-slate-300 hover:bg-white/5">
              Player accounts
            </a>
            <a href="#challenges" className="flex rounded-xl px-4 py-3 text-slate-300 hover:bg-white/5">
              Challenges
            </a>
            <a href="#payments" className="flex rounded-xl px-4 py-3 text-slate-300 hover:bg-white/5">
              Payments
            </a>
            <a href="#finance" className="flex rounded-xl px-4 py-3 text-slate-300 hover:bg-white/5">
              Finance overview
            </a>
          </nav>

          <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-semibold">Admin workspace</p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              Manage your player community and monitor platform activity.
            </p>
          </div>
        </aside>

        <div className="min-w-0 flex-1 p-4 sm:p-8">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-emerald-400">SquadBet / Admin</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Dashboard overview
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                Monitor your community from one place.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => void loadPlayers()}
                disabled={loadingPlayers}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/5 disabled:opacity-50"
              >
                {loadingPlayers ? "Refreshing..." : "Refresh data"}
              </button>
              <button
                onClick={handleLogout}
                className="rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-emerald-300"
              >
                Log out
              </button>
            </div>
          </header>

          <section id="overview" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: "Registered players",
                value: players.length,
                detail: "Profiles currently loaded",
                icon: "U",
              },
              {
                label: "Joined in 30 days",
                value: recentCount,
                detail: "Based on profile creation dates",
                icon: "+",
              },
              {
                label: "States represented",
                value: stateCount,
                detail: "Distinct states in loaded profiles",
                icon: "N",
              },
              {
                label: "Search results",
                value: filteredPlayers.length,
                detail: "Matching your current search",
                icon: "S",
              },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-white/10 bg-[#101827] p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-400">{stat.label}</p>
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-400/10 font-bold text-emerald-300">
                    {stat.icon}
                  </span>
                </div>
                <p className="mt-5 text-3xl font-bold tabular-nums">
                  {stat.value.toLocaleString()}
                </p>
                <p className="mt-2 text-xs text-slate-500">{stat.detail}</p>
              </div>
            ))}
          </section>

          <AdminInsights />

          <section id="players" className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-[#101827]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 p-5 sm:p-6">
              <div>
                <h2 className="text-xl font-bold">Player accounts</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Search and review registered player profiles.
                </p>
              </div>
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300">
                {filteredPlayers.length} shown
              </span>
            </div>

            <div className="p-5 sm:p-6">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search username, state, or city..."
                aria-label="Search players"
                className="w-full rounded-xl border border-white/10 bg-[#080d18] px-4 py-3 text-sm outline-none placeholder:text-slate-500 focus:border-emerald-400 sm:max-w-md"
              />

              {message && (
                <p role="alert" className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
                  {message}
                </p>
              )}

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-3 py-4 font-medium">Player</th>
                      <th className="px-3 py-4 font-medium">State</th>
                      <th className="px-3 py-4 font-medium">City</th>
                      <th className="px-3 py-4 font-medium">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPlayers.map((player) => (
                      <tr key={player.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.025]">
                        <td className="px-3 py-4">
                          <div className="font-semibold">{player.username || "Unnamed player"}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {player.id.slice(0, 8)}...
                          </div>
                        </td>
                        <td className="px-3 py-4 text-slate-300">{player.state || "Not set"}</td>
                        <td className="px-3 py-4 text-slate-300">{player.city || "Not set"}</td>
                        <td className="px-3 py-4 text-slate-400">
                          {player.created_at && Number.isFinite(new Date(player.created_at).getTime())
                            ? new Date(player.created_at).toLocaleDateString()
                            : "Unknown"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {!loadingPlayers && filteredPlayers.length === 0 && (
                  <p className="py-12 text-center text-sm text-slate-400">
                    {message ? "Player data could not be loaded." : "No matching player accounts found."}
                  </p>
                )}

                {loadingPlayers && (
                  <p className="py-6 text-center text-sm text-slate-400">
                    Loading player accounts...
                  </p>
                )}
              </div>
            </div>
          </section>

          <PaymentReview />


          <footer className="mt-8 pb-4 text-xs text-slate-500">
            SquadBet Admin Â· Figures above are calculated from loaded profile records.
            No financial totals are shown until transaction records are verified.
          </footer>
        </div>
      </div>
    </main>
  );
}


type AdminOverviewData = {
  overview: { pendingChallenges:number; acceptedChallenges:number; totalChallenges:number; totalMatches:number; activeMatches:number; availableWalletKobo:number; reservedWalletKobo:number; totalPlayerWalletKobo:number; recordedPlatformEarningsKobo:number; successfulDepositKobo:number; pendingDepositKobo:number; pendingWithdrawalKobo:number; approvedWithdrawalKobo:number; completedLedgerEntries:number };
  challenges: { id:string; game:string; stake_amount:number; status:string; created_at:string; sender_id:string; recipient_id:string }[];
  recentLedger: { entry_type:string; amount_kobo:number; created_at:string }[];
};

function AdminInsights() {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const money = (kobo:number) => new Intl.NumberFormat("en-NG", { style:"currency", currency:"NGN", maximumFractionDigits:2 }).format(kobo / 100);

  const load = useCallback(async () => {
    setRefreshing(true); setError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired. Sign in again.");
      const response = await fetch("/api/admin/overview", { headers: { Authorization: `Bearer ${token}` }, cache:"no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load admin overview.");
      setData(result as AdminOverviewData);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load dashboard data."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const o = data?.overview;
  const cards = [
    { label:"Pending challenges", value:o?.pendingChallenges ?? 0, detail:"Waiting for invited players", icon:"â—·" },
    { label:"Active matches", value:o?.activeMatches ?? 0, detail:`${o?.totalMatches ?? 0} match records loaded`, icon:"â—‰" },
    { label:"Total player wallet balances", value:money(o?.totalPlayerWalletKobo ?? 0), detail:"Combined player wallet funds; counted once", icon:"â‚¦" },
    { label:"Player funds available", value:money(o?.availableWalletKobo ?? 0), detail:"Funds players can currently use", icon:"â—‰" },
  ];
  return <>
    <section id="finance" className="mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Live database summary</p><h2 className="mt-1 text-xl font-bold">Platform operations</h2></div><button onClick={()=>void load()} disabled={refreshing} className="rounded-xl border border-white/10 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">{refreshing?"Refreshingâ€¦":"Refresh overview"}</button></div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-200">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map((card)=><div key={card.label} className="rounded-2xl border border-white/10 bg-[#101827] p-5"><div className="flex items-center justify-between gap-3"><p className="text-sm text-slate-400">{card.label}</p><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-400/10 font-bold text-sky-200">{card.icon}</span></div><p className="mt-5 break-words text-2xl font-bold tabular-nums">{loading?"â€”":card.value}</p><p className="mt-2 text-xs text-slate-500">{card.detail}</p></div>)}</div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-[#101827] p-5"><p className="text-sm text-slate-400">Recorded platform earnings</p><p className="mt-2 text-2xl font-bold">{loading?"â€”":money(o?.recordedPlatformEarningsKobo??0)}</p><p className="mt-2 text-xs text-slate-500">Only fee records saved by settlement count; match-fee automation is not connected yet.</p></div>
        <div className="rounded-2xl border border-white/10 bg-[#101827] p-5"><p className="text-sm text-slate-400">Verified deposits</p><p className="mt-2 text-2xl font-bold">{loading?"â€”":money(o?.successfulDepositKobo??0)}</p><p className="mt-2 text-xs text-slate-500">Transactions marked successful</p></div>
        <div className="rounded-2xl border border-white/10 bg-[#101827] p-5"><p className="text-sm text-slate-400">Deposits awaiting review</p><p className="mt-2 text-2xl font-bold">{loading?"â€”":money(o?.pendingDepositKobo??0)}</p><p className="mt-2 text-xs text-slate-500">Do not credit until funds are confirmed</p></div>
        <div className="rounded-2xl border border-white/10 bg-[#101827] p-5"><p className="text-sm text-slate-400">Withdrawals awaiting action</p><p className="mt-2 text-2xl font-bold">{loading?"â€”":money((o?.pendingWithdrawalKobo??0)+(o?.approvedWithdrawalKobo??0))}</p><p className="mt-2 text-xs text-slate-500">Pending plus approved but not marked paid</p></div>
      </div>
    </section>
    <section id="challenges" className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-[#101827]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-5 sm:p-6"><div><h2 className="text-xl font-bold">Recent challenges</h2><p className="mt-1 text-sm text-slate-400">Read-only monitoring of the latest challenge activity.</p></div><span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300">{data?.challenges.length ?? 0} records</span></div>
      <div className="overflow-x-auto p-5 sm:p-6">{loading?<p className="py-5 text-sm text-slate-400">Loading challenge activityâ€¦</p>:!data?.challenges.length?<p className="py-5 text-sm text-slate-400">No challenge records found.</p>:<table className="w-full min-w-[680px] text-left text-sm"><thead className="text-xs uppercase tracking-wider text-slate-500"><tr><th className="pb-3 pr-4">Game</th><th className="pb-3 pr-4">Stake</th><th className="pb-3 pr-4">Sender</th><th className="pb-3 pr-4">Recipient</th><th className="pb-3 pr-4">Status</th><th className="pb-3">Created</th></tr></thead><tbody>{data.challenges.map(c=><tr key={c.id} className="border-t border-white/5"><td className="py-3 pr-4 font-medium">{c.game}</td><td className="py-3 pr-4">{money(Number(c.stake_amount)*100)}</td><td className="py-3 pr-4 font-mono text-xs">{c.sender_id.slice(0,8)}â€¦</td><td className="py-3 pr-4 font-mono text-xs">{c.recipient_id.slice(0,8)}â€¦</td><td className="py-3 pr-4"><span className="rounded-full border border-white/10 px-2.5 py-1 text-xs capitalize">{c.status}</span></td><td className="py-3 text-slate-400">{new Date(c.created_at).toLocaleDateString("en-NG")}</td></tr>)}</tbody></table>}</div>
    </section>
    <p className="mt-3 text-xs leading-5 text-slate-500">Total player wallet balances show combined player funds. Recorded platform earnings only include fee entries saved separately; they do not include deposits or playersâ€™ stakes. Reconcile these database figures with actual bank/OPay funds before payouts.</p>
  </>;
}


type DepositRequest = {
  reference: string;
  user_id: string;
  amount_kobo: number;
  fee_kobo: number;
  net_credit_kobo: number;
  status: string;
  transfer_reference: string | null;
  created_at: string;
  admin_note: string | null;
};

type WithdrawalRequest = {
  reference: string;
  user_id: string;
  amount_kobo: number;
  fee_kobo: number;
  net_payout_kobo: number;
  status: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  created_at: string;
  admin_note: string | null;
};

function PaymentReview() {
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [rejectingReference, setRejectingReference] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const money = (k: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN"
    }).format(Number(k || 0) / 100);

  const playerName = (id: string) =>
    `${usernames[id] || "Player"} (${id.slice(0, 8)}…)`;

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token;
    if (!t) return;

    setToken(t);

    const r = await fetch("/api/admin/payments", {
      headers: { Authorization: `Bearer ${t}` },
      cache: "no-store"
    });

    const j = await r.json().catch(() => null);

    if (!r.ok) {
      setNotice(j?.error || `Could not load payment requests (HTTP ${r.status}).`);
      return;
    }

    if (!j) {
      setNotice("Payment API returned an empty or invalid response.");
      return;
    }

    const nextDeposits: DepositRequest[] = j.deposits || [];
    const nextWithdrawals: WithdrawalRequest[] = j.withdrawals || [];

    setDeposits(nextDeposits);
    setWithdrawals(nextWithdrawals);

    const ids = [...new Set([
      ...nextDeposits.map((d) => d.user_id),
      ...nextWithdrawals.map((w) => w.user_id)
    ])];

    if (ids.length) {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id,username")
        .in("id", ids);

      if (!error && profiles) {
        const names: Record<string, string> = {};
        profiles.forEach((p) => {
          names[p.id] = p.username || "Player";
        });
        setUsernames(names);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    kind: "deposit" | "withdrawal",
    reference: string,
    action: "approve" | "reject" | "paid",
    note?: string
  ) {
    if (
      action === "approve" &&
      kind === "deposit" &&
      !window.confirm("Confirm the exact OPay transfer has actually arrived?")
    ) return;

    if (
      action === "paid" &&
      !window.confirm("Confirm you have actually transferred the money to the player's account?")
    ) return;

    if (kind === "withdrawal" && action === "reject" && !note?.trim()) {
      setNotice("Enter a rejection reason before continuing.");
      return;
    }

    setBusy(true);
    setNotice("");

    try {
      const r = await fetch("/api/admin/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ kind, reference, action, note })
      });

      const j = await r.json();

      if (!r.ok) throw new Error(j.error || "Review failed");

      setNotice(`${kind} request ${action}d successfully.`);
      if (kind === "withdrawal" && action === "reject") {
        setRejectingReference("");
        setRejectReason("");
      }
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not update request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="payments" className="mt-8 rounded-2xl border border-white/10 bg-[#101827] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Manual OPay payments</h2>
          <p className="mt-1 text-sm text-slate-400">
            Verify deposits in your OPay account. Withdrawal transfers are manual.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-xl border border-white/10 px-4 py-2 text-sm hover:bg-white/5"
        >
          Refresh requests
        </button>
      </div>

      {notice && (
        <p role="status" className="mt-4 rounded-xl bg-slate-950 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}

      <h3 className="mt-6 font-semibold">Deposit requests</h3>

      {deposits.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No deposit requests.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Player</th>
                <th className="py-2 pr-3">Gross deposit</th>
                <th className="py-2 pr-3">5% fee</th>
                <th className="py-2 pr-3">Wallet credit</th>
                <th className="py-2 pr-3">Transfer ref</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.reference} className="border-t border-white/10">
                  <td className="py-3 pr-3">{new Date(d.created_at).toLocaleString("en-NG")}</td>
                  <td className="py-3 pr-3 font-mono text-xs">{playerName(d.user_id)}</td>
                  <td className="py-3 pr-3">{money(d.amount_kobo)}</td>
                  <td className="py-3 pr-3">{money(d.fee_kobo)}</td>
                  <td className="py-3 pr-3 font-semibold text-emerald-300">{money(d.net_credit_kobo)}</td>
                  <td className="py-3 pr-3 font-mono text-xs">{d.transfer_reference || "—"}</td>
                  <td className="py-3 pr-3 capitalize">{d.status}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      {d.status === "pending" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => void act("deposit", d.reference, "approve")}
                            className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950"
                          >
                            Verify & credit
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void act("deposit", d.reference, "reject")}
                            className="rounded-lg border border-red-400/30 px-3 py-2 text-xs text-red-200"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-7 font-semibold">Withdrawal requests</h3>

      {withdrawals.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No withdrawal requests.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Player</th>
                <th className="py-2 pr-3">Gross request</th>
                <th className="py-2 pr-3">5% fee</th>
                <th className="py-2 pr-3">You transfer</th>
                <th className="py-2 pr-3">Bank details</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.reference} className="border-t border-white/10">
                  <td className="py-3 pr-3">{new Date(w.created_at).toLocaleString("en-NG")}</td>
                  <td className="py-3 pr-3 font-mono text-xs">{playerName(w.user_id)}</td>
                  <td className="py-3 pr-3">{money(w.amount_kobo)}</td>
                  <td className="py-3 pr-3">{money(w.fee_kobo)}</td>
                  <td className="py-3 pr-3 font-semibold text-emerald-300">{money(w.net_payout_kobo)}</td>
                  <td className="py-3 pr-3">
                    {w.bank_name}<br />
                    {w.account_name}<br />
                    <span className="font-mono text-xs">{w.account_number}</span>
                  </td>
                  <td className="py-3 pr-3 capitalize">{w.status}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      {w.status === "pending" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => void act("withdrawal", w.reference, "approve")}
                            className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950"
                          >
                            Approve
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setRejectingReference(w.reference);
                              setRejectReason("");
                            }}
                            className="rounded-lg border border-red-400/30 px-3 py-2 text-xs text-red-200"
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {w.status === "approved" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => void act("withdrawal", w.reference, "paid")}
                            className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950"
                          >
                            Mark paid
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setRejectingReference(w.reference);
                              setRejectReason("");
                            }}
                            className="rounded-lg border border-red-400/30 px-3 py-2 text-xs text-red-200"
                          >
                            Reject & refund
                          </button>
                        </>
                      )}
                    </div>

                    {rejectingReference === w.reference && (
                      <div className="mt-3 min-w-64 space-y-2">
                        <textarea
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Enter the reason for rejecting this withdrawal..."
                          rows={3}
                          maxLength={500}
                          className="w-full rounded-lg border border-white/20 bg-slate-950 p-2 text-xs text-white"
                        />
                        <div className="flex gap-2">
                          <button
                            disabled={busy || !rejectReason.trim()}
                            onClick={() => void act(
                              "withdrawal",
                              w.reference,
                              "reject",
                              rejectReason.trim()
                            )}
                            className="rounded-lg bg-red-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                          >
                            Confirm rejection & refund
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setRejectingReference("");
                              setRejectReason("");
                            }}
                            className="rounded-lg border border-white/20 px-3 py-2 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs leading-5 text-amber-200">
        Approve a withdrawal only when you are ready to transfer the displayed net amount.
        Mark paid only after the transfer is complete. Rejecting an approved request refunds
        the full withdrawal amount to the player's available balance.
      </p>
    </section>
  );
}


