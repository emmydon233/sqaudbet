"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../utils/supabase/client";

export default function RegisterPage() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [stateName, setStateName] = useState("");
  const [city, setCity] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");

    const cleanUsername = username.trim();

    if (!/^[A-Za-z0-9_]{3,20}$/.test(cleanUsername)) {
      setMessage("Username must be 3–20 characters using letters, numbers, or underscores.");
      return;
    }

    if (password.length < 8) {
      setMessage("Password must contain at least 8 characters.");
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm`,
          data: {
            username: cleanUsername,
            state: stateName.trim(),
            city: city.trim(),
          },
        },
      });

      if (error) {
        setMessage(error.message);
        return;
      }

      if (data.user && data.session) {
        router.push("/");
        router.refresh();
      } else {
        setMessage("Account created! Check your email to confirm your account before logging in.");
      }
    } catch {
      setMessage("Unable to register right now. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none focus:border-emerald-400";

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-12 text-white">
      <div className="mx-auto max-w-md">
        <a href="/" className="text-2xl font-black text-emerald-400">
          SquadBet
        </a>

        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
          <h1 className="text-3xl font-bold">Create your account</h1>
          <p className="mt-2 text-sm text-slate-400">
            Join SquadBet and get ready to play with friends.
          </p>

          <form onSubmit={handleRegister} className="mt-6 space-y-4">
            <div>
              <label htmlFor="username" className="mb-1 block text-sm">Unique username</label>
              <input id="username" autoComplete="username" required minLength={3} maxLength={20}
                pattern="[A-Za-z0-9_]+" title="Use 3–20 letters, numbers, or underscores."
                value={username} onChange={(e) => setUsername(e.target.value)}
                className={inputClass} placeholder="e.g. SquadKing7" />
            </div>

            <div>
              <label htmlFor="email" className="mb-1 block text-sm">Email address</label>
              <input id="email" type="email" autoComplete="email" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                className={inputClass} placeholder="you@example.com" />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm">Password</label>
              <input id="password" type="password" autoComplete="new-password"
                minLength={8} required value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass} placeholder="At least 8 characters" />
            </div>

            <div>
              <label htmlFor="state" className="mb-1 block text-sm">State</label>
              <input id="state" required value={stateName}
                onChange={(e) => setStateName(e.target.value)}
                className={inputClass} placeholder="e.g. Oyo" />
            </div>

            <div>
              <label htmlFor="city" className="mb-1 block text-sm">City</label>
              <input id="city" required value={city}
                onChange={(e) => setCity(e.target.value)}
                className={inputClass} placeholder="e.g. Ibadan" />
            </div>

            {message && (
              <p role="status" className="rounded-lg bg-slate-800 p-3 text-sm text-amber-300">
                {message}
              </p>
            )}

            <button type="submit" disabled={loading}
              className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-60">
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-400">
            Already registered?{" "}
            <a href="/login" className="font-semibold text-emerald-400 hover:underline">
              Log in
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

