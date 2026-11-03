import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";



export async function POST(request: NextRequest) {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return NextResponse.json({ error: "Payments are not configured yet." }, { status: 503 });
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

    const admin = createSupabaseAdmin();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return NextResponse.json({ error: "Your session is invalid." }, { status: 401 });

    const body: unknown = await request.json();
    const reference = typeof body === "object" && body !== null && "reference" in body
      ? String((body as { reference: unknown }).reference)
      : "";
    if (!/^SB-[0-9a-f-]{36}$/i.test(reference)) return NextResponse.json({ error: "Invalid payment reference." }, { status: 400 });

    const { data: transaction, error: transactionError } = await admin
      .from("payment_transactions").select("user_id, amount_kobo, status, provider")
      .eq("reference", reference).maybeSingle();
    if (transactionError || !transaction || transaction.user_id !== authData.user.id || transaction.provider !== "paystack") {
      return NextResponse.json({ error: "Payment record was not found." }, { status: 404 });
    }
    if (transaction.status === "success") return NextResponse.json({ status: "success", message: "Deposit already confirmed." });
    if (transaction.status !== "pending") return NextResponse.json({ error: "This payment is not pending." }, { status: 409 });

    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` }, cache: "no-store",
    });
    const verified = await verifyResponse.json();
    const payment = verified.data;
    if (!verifyResponse.ok || !verified.status || payment?.status !== "success" || payment?.currency !== "NGN" || Number(payment?.amount) !== Number(transaction.amount_kobo)) {
      return NextResponse.json({ status: "pending", message: "Payment has not been confirmed yet. If you were charged, wait briefly and refresh." }, { status: 202 });
    }

    const { error: creditError } = await admin.rpc("credit_wallet_from_paystack", {
      p_reference: reference,
      p_amount_kobo: Number(payment.amount),
    });
    if (creditError) {
      console.error("Wallet credit RPC failed:", creditError.message);
      return NextResponse.json({ error: "Payment was verified but wallet update needs attention. Do not pay again; contact support with reference " + reference }, { status: 500 });
    }
    return NextResponse.json({ status: "success", message: "Deposit confirmed and wallet credited." });
  } catch (error) {
    console.error("Payment verification error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Unable to verify payment right now." }, { status: 500 });
  }
}
