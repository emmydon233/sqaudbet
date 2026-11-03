import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";


const MIN_DEPOSIT_NAIRA = 500;
const MAX_DEPOSIT_NAIRA = 50_000;

export async function POST(request: NextRequest) {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return NextResponse.json({ error: "Payments are not configured yet." }, { status: 503 });

    const authorization = request.headers.get("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

    const admin = createSupabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const user = authData.user;
    if (authError || !user || !user.email) return NextResponse.json({ error: "Your session is invalid. Please sign in again." }, { status: 401 });

    const body: unknown = await request.json();
    const amount = typeof body === "object" && body !== null && "amountNaira" in body
      ? Number((body as { amountNaira: unknown }).amountNaira)
      : NaN;
    if (!Number.isSafeInteger(amount) || amount < MIN_DEPOSIT_NAIRA || amount > MAX_DEPOSIT_NAIRA) {
      return NextResponse.json({ error: "Deposit must be between ₦500 and ₦50,000." }, { status: 400 });
    }

    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { count: recentAttempts, error: rateLimitError } = await admin
      .from("payment_transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", oneMinuteAgo);
    if (rateLimitError) {
      console.error("Could not check payment rate limit:", rateLimitError.message);
      return NextResponse.json({ error: "Unable to start checkout right now." }, { status: 500 });
    }
    if ((recentAttempts ?? 0) >= 5) {
      return NextResponse.json({ error: "Too many checkout attempts. Wait a minute and try again." }, { status: 429 });
    }

    const reference = `SB-${randomUUID()}`;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const { error: insertError } = await admin.from("payment_transactions").insert({
      reference,
      user_id: user.id,
      provider: "paystack",
      amount_kobo: amount * 100,
      currency: "NGN",
      status: "pending",
    });
    if (insertError) {
      console.error("Payment transaction insert failed:", insertError.message);
      return NextResponse.json({ error: "Could not start payment. Please try again." }, { status: 500 });
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        amount: amount * 100,
        currency: "NGN",
        reference,
        callback_url: `${appUrl}/wallet?reference=${encodeURIComponent(reference)}`,
        metadata: { user_id: user.id, app: "SquadBet" },
      }),
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || !result.status || !result.data?.authorization_url) {
      await admin.from("payment_transactions").update({ status: "failed" }).eq("reference", reference).eq("status", "pending");
      console.error("Paystack initialization failed:", result.message || response.status);
      return NextResponse.json({ error: "Payment provider could not start checkout. Please try again." }, { status: 502 });
    }

    return NextResponse.json({ authorizationUrl: result.data.authorization_url, reference });
  } catch (error) {
    console.error("Payment initialization error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Unable to start payment right now." }, { status: 500 });
  }
}
