import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";



export async function POST(request: NextRequest) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = request.headers.get("x-paystack-signature");
  if (!secret || !signature) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawBody = await request.text();
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const providedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const event = JSON.parse(rawBody) as { event?: string; data?: { reference?: string; status?: string; amount?: number; currency?: string } };
    if (event.event !== "charge.success") return NextResponse.json({ received: true });
    const payment = event.data;
    if (!payment?.reference || payment.status !== "success" || payment.currency !== "NGN" || !Number.isSafeInteger(payment.amount)) {
      return NextResponse.json({ error: "Invalid payment payload" }, { status: 400 });
    }
    const admin = createSupabaseAdmin();
    const { error } = await admin.rpc("credit_wallet_from_paystack", {
      p_reference: payment.reference,
      p_amount_kobo: payment.amount,
    });
    if (error) {
      console.error("Paystack webhook credit failed:", error.message);
      return NextResponse.json({ error: "Wallet credit failed" }, { status: 500 });
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Paystack webhook error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
}
