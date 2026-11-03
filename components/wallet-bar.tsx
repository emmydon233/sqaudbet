"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/utils/supabase/client";

type WalletRow = {
  available_balance_kobo: number;
};

export default function WalletBar() {
  const [userId, setUserId] = useState<string | null>(null);
  const [available, setAvailable] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadWallet = useCallback(async (id: string | null) => {
    if (!id) {
      setUserId(null);
      setAvailable(0);
      setLoading(false);
      return;
    }

    setUserId(id);
    setLoading(true);

    const { data, error } = await supabase
      .from("wallets")
      .select("available_balance_kobo")
      .eq("user_id", id)
      .maybeSingle<WalletRow>();

    if (error) {
      console.error("Could not load wallet:", error.message);
    } else {
      setAvailable(Number(data?.available_balance_kobo ?? 0));
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;

    const initialize = async () => {
      const { data, error } = await supabase.auth.getUser();

      if (!active) return;

      if (error || !data.user) {
        await loadWallet(null);
      } else {
        await loadWallet(data.user.id);
      }
    };

    void initialize();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      void loadWallet(session?.user?.id ?? null);
    });

    const refreshOnFocus = () => {
      if (document.visibilityState !== "visible") return;

      void supabase.auth.getUser().then(({ data }) => {
        if (active) void loadWallet(data.user?.id ?? null);
      });
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    return () => {
      active = false;
      subscription.unsubscribe();
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [loadWallet]);

  if (!userId) return null;

  const naira = (kobo: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(kobo / 100);

  return (
    <header className="w-full border-b border-white/10 bg-slate-950 text-white">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <a href="/" className="text-lg font-extrabold tracking-tight">
          Squad<span className="text-emerald-400">Bet</span>
        </a>

        <div className="flex flex-wrap items-center gap-3 sm:gap-5">
          <div>
            <p className="text-xs text-slate-400">Available Balance</p>
            <p className="font-bold text-emerald-400">
              {loading ? "Loading..." : naira(available)}
            </p>
          </div>

          <a
            href="/wallet"
            className="rounded-lg border border-emerald-400/40 px-3 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-400/10"
          >
            Wallet
          </a>
          <a
            href="/dashboard"
            className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
          >
            Dashboard
          </a>
        </div>
      </div>
    </header>
  );
}
