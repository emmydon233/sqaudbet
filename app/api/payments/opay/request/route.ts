import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!token) {
      return NextResponse.json({ error: "Please log in again." }, { status: 401 });
    }

    const db = createSupabaseAdmin();
    const { data: auth, error: authError } = await db.auth.getUser(token);

    if (authError || !auth.user) {
      return NextResponse.json({ error: "Your session is invalid." }, { status: 401 });
    }

    const body = await request.json();
    const amountNaira = Number(body.amountNaira);

    if (
      !Number.isInteger(amountNaira) ||
      amountNaira < 500 ||
      amountNaira > 50000
    ) {
      return NextResponse.json(
        { error: "Deposit must be between NGN 500 and NGN 50,000." },
        { status: 400 }
      );
    }

    const reference = `OPAY-${crypto.randomUUID()}`;

    const { error } = await db.from("payment_transactions").insert({
      reference,
      user_id: auth.user.id,
      provider: "opay_manual",
      amount_kobo: amountNaira * 100,
      currency: "NGN",
      status: "pending",
    });

    if (error) {
      console.error("OPay deposit request error:", error);
      return NextResponse.json(
        { error: "Could not submit your deposit request." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      reference,
      message: "Deposit request submitted for verification.",
    });
  } catch (error) {
    console.error("OPay deposit API error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    );
  }
}



