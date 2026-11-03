"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../utils/supabase/client";

export default function AdminLoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error || !data.user) {
        setMessage(error?.message || "Login failed.");
        return;
      }

      const { data: roleRecord, error: roleError } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", data.user.id)
        .maybeSingle();

      if (roleError || roleRecord?.role !== "super_admin") {
        await supabase.auth.signOut();
        setMessage("Access denied. This account is not authorized as an administrator.");
        return;
      }

      router.replace("/admin");
      router.refresh();
    } catch {
      setMessage("Unable to sign in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none focus:border-emerald-400";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-white">
      <div className="w-full max-w-md">
        <Link href="/" className="text-2xl font-black text-emerald-400">
          SquadBet
        </Link>

        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
          <div className="mb-6">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Restricted area
            </p>
            <h1 className="mt-2 text-3xl font-bold">Admin Login</h1>
            <p className="mt-2 text-sm text-slate-400">
              Sign in with your authorized Super Admin account.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="admin-email" className="mb-1 block text-sm">
                Admin email address
              </label>
              <input
                id="admin-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="Enter your admin email"
              />
            </div>

            <div>
              <label htmlFor="admin-password" className="mb-1 block text-sm">
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                placeholder="Enter your password"
              />
            </div>

            {message && (
              <p role="alert" className="rounded-lg bg-slate-800 p-3 text-sm text-amber-300">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-60"
            >
              {loading ? "Verifying access..." : "Sign in to Admin"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-500">
            Authorized administrators only. All access is permission-checked.
          </p>

          <p className="mt-4 text-center text-sm">
            <Link href="/" className="text-slate-400 hover:text-white">
              Return to SquadBet
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
