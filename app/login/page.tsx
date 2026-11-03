
"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { supabase } from "../../utils/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    setLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setMessage(error.message);
        return;
      }

      const requestedNext = searchParams.get("next");
      const allowedRoutes = ["/", "/whot", "/snooker", "/ludo"];

      // Only allow known internal destinations.
      const destination =
        requestedNext &&
        allowedRoutes.includes(requestedNext) &&
        requestedNext.startsWith("/")
          ? requestedNext
          : "/";

      router.replace(destination);
      router.refresh();
    } catch {
      setMessage("Unable to log in right now. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none focus:border-emerald-400";

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-12 text-white">
      <div className="mx-auto max-w-md">
        <Link href="/" className="text-2xl font-black text-emerald-400">
          SquadBet
        </Link>

        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
          <h1 className="text-3xl font-bold">Welcome back</h1>
          <p className="mt-2 text-sm text-slate-400">
            Log in to your SquadBet account and get back into the arena.
          </p>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                placeholder="Your password"
              />
              <div className="mt-2 text-right">
                <Link href="/reset-password" className="text-sm text-emerald-300 hover:underline">Forgot password?</Link>
              </div>
            </div>

            {message && (
              <p
                role="alert"
                className="rounded-lg bg-slate-800 p-3 text-sm text-amber-300"
              >
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-60"
            >
              {loading ? "Logging in..." : "Log in"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-400">
            Don&apos;t have an account?{" "}
            <Link
              href="/register"
              className="font-semibold text-emerald-400 hover:underline"
            >
              Create account
            </Link>
          </p>

          <p className="mt-4 text-center text-sm">
            <Link href="/" className="text-slate-400 hover:text-white">
              ← Back to homepage
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
          Loading login...
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
