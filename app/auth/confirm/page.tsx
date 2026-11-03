"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../utils/supabase/client";

export default function ConfirmEmailPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Verifying your email...");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let active = true;

    async function confirmEmail() {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const tokenHash = url.searchParams.get("token_hash");
        const type = url.searchParams.get("type");

        let error = null;

        if (code) {
          const result = await supabase.auth.exchangeCodeForSession(code);
          error = result.error;
        } else if (tokenHash && type === "email") {
          const result = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: "email",
          });
          error = result.error;
        } else {
          const result = await supabase.auth.getSession();

          if (result.data.session?.user?.email_confirmed_at) {
            if (active) {
              setSuccess(true);
              setMessage("Your email is confirmed. Welcome to SquadBet!");
              router.replace("/dashboard");
            }
            return;
          }

          error = new Error("Confirmation link is missing or incomplete.");
        }

        if (error) {
          if (active) {
            setMessage(
              "We couldn't confirm your email. The link may have expired. Request a new confirmation email and try again."
            );
          }
          return;
        }

        if (active) {
          setSuccess(true);
          setMessage("Your email is confirmed! Taking you to SquadBet...");
          window.setTimeout(() => router.replace("/dashboard"), 1200);
        }
      } catch {
        if (active) {
          setMessage("Confirmation failed. Please request a new email and try again.");
        }
      }
    }

    void confirmEmail();

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
        <h1 className="text-2xl font-bold text-emerald-400">
          SquadBet Email Verification
        </h1>
        <p className="mt-4 text-slate-300" role="status">
          {message}
        </p>
        {!success && (
          <a
            href="/login"
            className="mt-6 inline-block font-semibold text-emerald-400 hover:underline"
          >
            Return to login
          </a>
        )}
      </div>
    </main>
  );
}
