
"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/utils/supabase/client";

type Wallet = {
  available_balance_kobo: number;
};

type Payment = {
  reference: string;
  amount_kobo: number;
  status: string;
  created_at: string;
};

type Withdrawal = {
  reference: string;
  amount_kobo: number;
  fee_kobo: number;
  net_payout_kobo: number;
  status: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  created_at: string;
  admin_note?: string | null;
};

const money = (kobo: number) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(kobo / 100);

const inputClass =
  "w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400";

const statusClass = (status: string) => {
  switch (status.toLowerCase()) {
    case "paid":
    case "success":
      return "text-emerald-300";
    case "approved":
      return "text-blue-300";
    case "rejected":
    case "failed":
      return "text-red-300";
    default:
      return "text-amber-300";
  }
};

export default function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");

  const [amount, setAmount] = useState("500");
  const [withdrawAmount, setWithdrawAmount] = useState("500");
  const [withdrawBank, setWithdrawBank] = useState("");
  const [withdrawAccountName, setWithdrawAccountName] = useState("");
  const [withdrawAccountNumber, setWithdrawAccountNumber] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const accountName = process.env.NEXT_PUBLIC_OPAY_ACCOUNT_NAME || "";
  const accountNumber = process.env.NEXT_PUBLIC_OPAY_ACCOUNT_NUMBER || "";
  const bankName = process.env.NEXT_PUBLIC_OPAY_BANK_NAME || "OPay";

  const refresh = useCallback(async () => {
    const { data, error: sessionError } = await supabase.auth.getSession();
    const session = data.session;

    if (sessionError || !session) {
      window.location.assign("/login?next=%2Fwallet");
      return;
    }

    setToken(session.access_token);

    const [w, p, withdrawalResponse] = await Promise.all([
      supabase
        .from("wallets")
        .select("available_balance_kobo")
        .eq("user_id", session.user.id)
        .maybeSingle(),

      supabase
        .from("payment_transactions")
        .select("reference,amount_kobo,status,created_at")
        .eq("user_id", session.user.id)
        .eq("provider", "opay_manual")
        .order("created_at", { ascending: false })
        .limit(10),

      fetch("/api/payments/withdrawal", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      }),
    ]);

    if (w.error) {
      setError("Could not load wallet balance.");
    } else {
      setWallet(
        w.data ?? {
          available_balance_kobo: 0,
        }
      );
    }

    if (p.error) {
      setError("Could not load deposit history.");
    } else {
      setPayments((p.data ?? []) as Payment[]);
    }

    if (withdrawalResponse.ok) {
      const result = await withdrawalResponse.json();
      setWithdrawals((result.withdrawals ?? []) as Withdrawal[]);
    } else {
      setError("Could not load withdrawal history. Please refresh.");
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withdrawalNaira = Number(withdrawAmount);
  const validWithdrawalAmount =
    Number.isSafeInteger(withdrawalNaira) &&
    withdrawalNaira >= 500 &&
    withdrawalNaira <= 50000;

  const grossKobo = validWithdrawalAmount ? withdrawalNaira * 100 : 0;
  const feeKobo = Math.floor((grossKobo * 5) / 100);
  const netKobo = grossKobo - feeKobo;

  async function requestDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    const amountNaira = Number(amount);

    if (
      !Number.isSafeInteger(amountNaira) ||
      amountNaira < 500 ||
      amountNaira > 50000
    ) {
      setError("Deposit must be between ₦500 and ₦50,000.");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/payments/opay/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amountNaira }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not submit deposit request.");
      }

      setNotice(
        "Deposit request submitted. Your wallet will be credited only after an administrator verifies the transfer."
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit deposit.");
    } finally {
      setBusy(false);
    }
  }

  async function requestWithdrawal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (!validWithdrawalAmount) {
      setError("Withdrawal must be between ₦500 and ₦50,000.");
      return;
    }

    if (grossKobo > (wallet?.available_balance_kobo ?? 0)) {
      setError("Your available wallet balance is not enough for this withdrawal.");
      return;
    }

    if (
      withdrawBank.trim().length < 2 ||
      withdrawAccountName.trim().length < 2 ||
      !/^\d{10}$/.test(withdrawAccountNumber.trim())
    ) {
      setError("Enter a valid bank name, account name and 10-digit account number.");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/payments/withdrawal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amountNaira: withdrawalNaira,
          bankName: withdrawBank.trim(),
          accountName: withdrawAccountName.trim(),
          accountNumber: withdrawAccountNumber.trim(),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not submit withdrawal request.");
      }

      setNotice(
        `Withdrawal request submitted. ${money(netKobo)} will be paid after approval.`
      );

      setWithdrawAmount("500");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit withdrawal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href="/dashboard" className="text-sm text-emerald-300 hover:underline">
          ← Dashboard
        </Link>

        <h1 className="mt-3 text-3xl font-black">Your wallet</h1>
        <p className="mt-2 text-slate-400">
          Manage your deposits, withdrawals and wallet balance.
        </p>

        {notice && (
          <p role="status" className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-200">
            {notice}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-200">
            {error}
          </p>
        )}

        <section className="mt-7 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="text-lg font-bold">Wallet balance</h2>

          {loading ? (
            <p className="mt-5 text-slate-400">Loading balance...</p>
          ) : (
            <div className="mt-5 rounded-xl bg-slate-950 p-5">
              <p className="text-sm text-slate-400">Available Balance</p>
              <p className="mt-2 text-3xl font-black text-emerald-300">
                {money(wallet?.available_balance_kobo ?? 0)}
              </p>
            </div>
          )}

          <p className="mt-4 text-xs text-slate-500">
            Your available balance is read directly from your wallet account.
          </p>
        </section>

        <section className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          <div className="grid grid-cols-2 border-b border-slate-800">
            <button
              type="button"
              onClick={() => {
                setTab("deposit");
                setError("");
                setNotice("");
              }}
              className={`px-4 py-4 font-bold ${
                tab === "deposit"
                  ? "border-b-2 border-emerald-400 text-emerald-300"
                  : "text-slate-400"
              }`}
            >
              Deposit
            </button>

            <button
              type="button"
              onClick={() => {
                setTab("withdraw");
                setError("");
                setNotice("");
              }}
              className={`px-4 py-4 font-bold ${
                tab === "withdraw"
                  ? "border-b-2 border-emerald-400 text-emerald-300"
                  : "text-slate-400"
              }`}
            >
              Withdraw
            </button>
          </div>

          <div className="p-6">
            {tab === "deposit" ? (
              <div className="mx-auto max-w-xl">
                <h2 className="text-xl font-bold">Deposit by transfer</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Minimum ₦500 · Maximum ₦50,000
                </p>

                <div className="mt-5 rounded-xl bg-slate-950 p-4 text-sm">
                  <p className="text-slate-400">Bank</p>
                  <p className="font-semibold">{bankName}</p>

                  <p className="mt-3 text-slate-400">Account name</p>
                  <p className="font-semibold">{accountName || "Not configured"}</p>

                  <p className="mt-3 text-slate-400">Account number</p>
                  <p className="font-semibold">{accountNumber || "Not configured"}</p>
                </div>

                <form onSubmit={requestDeposit} className="mt-5 space-y-4">
                  <label htmlFor="deposit-amount" className="block text-sm font-medium">
                    Amount (₦)
                  </label>

                  <input
                    id="deposit-amount"
                    className={inputClass}
                    type="number"
                    min="500"
                    max="50000"
                    step="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />

                  <p className="text-xs leading-5 text-slate-400">
                    Transfer to the account above, then submit your request.
                    Your wallet is credited only after we confirm receipt.
                  </p>

                  <button
                    type="submit"
                    disabled={busy || loading || !token || !accountName || !accountNumber}
                    className="w-full rounded-xl bg-emerald-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
                  >
                    {busy ? "Submitting..." : "Submit deposit request"}
                  </button>
                </form>
              </div>
            ) : (
              <div className="mx-auto max-w-xl">
                <h2 className="text-xl font-bold">Withdraw to your bank</h2>

                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <h3 className="font-bold text-amber-200">Withdrawal rules</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-300">
                    <li>Minimum withdrawal: ₦500.</li>
                    <li>Maximum withdrawal: ₦50,000.</li>
                    <li>Enter the correct bank name and account name.</li>
                    <li>Enter a valid 10-digit account number.</li>
                    <li>Incorrect or invalid bank details may cause rejection.</li>
                    <li>A 5% withdrawal fee applies.</li>
                    <li>The full requested amount is deducted when you submit. If rejected, it is refunded.</li>
                  </ul>
                </div>

                <form onSubmit={requestWithdrawal} className="mt-5 space-y-4">
                  <div>
                    <label htmlFor="withdraw-amount" className="mb-2 block text-sm font-medium">
                      Withdrawal amount (₦)
                    </label>
                    <input
                      id="withdraw-amount"
                      className={inputClass}
                      type="number"
                      min="500"
                      max="50000"
                      step="1"
                      required
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                    />
                  </div>

                  <div className="rounded-xl border border-slate-700 bg-slate-950 p-4">
                    <p className="text-sm text-slate-400">Withdrawal fee (5%)</p>
                    <p className="mt-1 font-semibold">{money(feeKobo)}</p>

                    <div className="my-3 border-t border-slate-800" />

                    <p className="text-sm text-slate-400">You will receive</p>
                    <p className="mt-1 text-2xl font-black text-emerald-300">
                      {money(netKobo)}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      Your full withdrawal amount is deducted once when the request is submitted.
                      Approval and marking the transfer as paid should not deduct it again.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="withdraw-bank" className="mb-2 block text-sm font-medium">
                      Bank name
                    </label>
                    <input
                      id="withdraw-bank"
                      className={inputClass}
                      type="text"
                      maxLength={100}
                      required
                      placeholder="e.g. OPay, GTBank, Access Bank"
                      value={withdrawBank}
                      onChange={(e) => setWithdrawBank(e.target.value)}
                    />
                  </div>

                  <div>
                    <label htmlFor="withdraw-account-name" className="mb-2 block text-sm font-medium">
                      Account name
                    </label>
                    <input
                      id="withdraw-account-name"
                      className={inputClass}
                      type="text"
                      maxLength={100}
                      required
                      placeholder="Name on your bank account"
                      value={withdrawAccountName}
                      onChange={(e) => setWithdrawAccountName(e.target.value)}
                    />
                  </div>

                  <div>
                    <label htmlFor="withdraw-account-number" className="mb-2 block text-sm font-medium">
                      10-digit account number
                    </label>
                    <input
                      id="withdraw-account-number"
                      className={inputClass}
                      type="text"
                      inputMode="numeric"
                      maxLength={10}
                      minLength={10}
                      required
                      placeholder="0123456789"
                      value={withdrawAccountNumber}
                      onChange={(e) =>
                        setWithdrawAccountNumber(
                          e.target.value.replace(/\D/g, "").slice(0, 10)
                        )
                      }
                    />
                  </div>

                  <p className="text-xs leading-5 text-slate-400">
                    Your withdrawal will be reviewed by an administrator.
                    Please make sure your bank details are correct.
                  </p>

                  <button
                    type="submit"
                    disabled={
                      busy ||
                      loading ||
                      !token ||
                      !validWithdrawalAmount ||
                      grossKobo > (wallet?.available_balance_kobo ?? 0)
                    }
                    className="w-full rounded-xl bg-emerald-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-50"
                  >
                    {busy ? "Submitting..." : "Submit withdrawal request"}
                  </button>
                </form>
              </div>
            )}
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Recent deposit requests</h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-sm text-emerald-300 hover:underline"
            >
              Refresh
            </button>
          </div>

          {payments.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No OPay deposits yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="text-slate-400">
                  <tr>
                    <th className="py-3 pr-4">Date</th>
                    <th className="py-3 pr-4">Reference</th>
                    <th className="py-3 pr-4">Amount</th>
                    <th className="py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.reference} className="border-t border-slate-800">
                      <td className="py-3 pr-4">
                        {new Date(p.created_at).toLocaleString("en-NG")}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs">{p.reference}</td>
                      <td className="py-3 pr-4">{money(p.amount_kobo)}</td>
                      <td className={`py-3 capitalize ${statusClass(p.status)}`}>
                        {p.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Withdrawal history</h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-sm text-emerald-300 hover:underline"
            >
              Refresh
            </button>
          </div>

          {withdrawals.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">
              No withdrawal requests yet.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {withdrawals.map((w) => (
                <div
                  key={w.reference}
                  className="rounded-xl border border-slate-800 bg-slate-950 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold">{money(w.amount_kobo)}</p>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {w.reference}
                      </p>
                    </div>
                    <span className={`text-sm font-bold capitalize ${statusClass(w.status)}`}>
                      {w.status}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    <p className="text-slate-400">
                      Bank: <span className="text-white">{w.bank_name}</span>
                    </p>
                    <p className="text-slate-400">
                      Account: <span className="text-white">{w.account_name}</span>
                    </p>
                    <p className="text-slate-400">
                      Account number: <span className="text-white">{w.account_number}</span>
                    </p>
                    <p className="text-slate-400">
                      Fee: <span className="text-white">{money(w.fee_kobo ?? 0)}</span>
                    </p>
                    <p className="text-slate-400">
                      Net payout: <span className="text-emerald-300">{money(w.net_payout_kobo ?? 0)}</span>
                    </p>
                    <p className="text-slate-400">
                      Date: <span className="text-white">{new Date(w.created_at).toLocaleString("en-NG")}</span>
                    </p>
                  </div>

                  {w.admin_note && (
                    <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-200">
                      Rejection reason / Admin note: {w.admin_note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
