"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/utils/supabase/client";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (resetError) setError("We couldn't send a reset email. Check the address and try again.");
      else setMessage("If an account exists for that email, a password reset link has been sent.");
    } catch { setError("Unable to request a reset right now. Please try again."); }
    finally { setBusy(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    if (password.length < 8) { setError("Use at least 8 characters for your new password."); setBusy(false); return; }
    if (password !== confirmPassword) { setError("The passwords do not match."); setBusy(false); return; }
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) setError("This reset link may have expired. Request a new one and try again.");
      else { setMessage("Password updated. You can now log in with your new password."); setRecoveryMode(false); }
    } catch { setError("Unable to update your password right now."); }
    finally { setBusy(false); }
  }

  // Supabase recovery links establish a session and include type=recovery in the URL hash.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.get("type") === "recovery") setRecoveryMode(true);
  }, []);

  const input = "w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-400";
  return <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-white"><div className="w-full max-w-md"><Link href="/" className="text-2xl font-black text-emerald-400">SquadBet</Link><section className="mt-7 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8"><h1 className="text-2xl font-bold">{recoveryMode ? "Choose a new password" : "Reset your password"}</h1><p className="mt-2 text-sm text-slate-400">{recoveryMode ? "Choose a strong password you have not used before." : "We'll send a secure reset link if this email is registered."}</p>
    <form className="mt-6 space-y-4" onSubmit={recoveryMode ? changePassword : requestReset}>{!recoveryMode ? <div><label htmlFor="email" className="mb-1 block text-sm">Email address</label><input className={input} id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></div> : <><div><label htmlFor="password" className="mb-1 block text-sm">New password</label><input className={input} id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></div><div><label htmlFor="confirmPassword" className="mb-1 block text-sm">Confirm password</label><input className={input} id="confirmPassword" type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></div></>}
    {message && <p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-200">{message}</p>}{error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}<button disabled={busy} className="w-full rounded-xl bg-emerald-400 px-4 py-3 font-bold text-slate-950 disabled:opacity-60">{busy ? "Please wait…" : recoveryMode ? "Update password" : "Send reset link"}</button></form><p className="mt-5 text-center text-sm text-slate-400"><Link className="text-emerald-300 hover:underline" href="/login">Back to login</Link></p></section></div></main>;
}
