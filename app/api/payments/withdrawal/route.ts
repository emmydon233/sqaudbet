import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";

const MIN_WITHDRAWAL = 500;
const MAX_WITHDRAWAL = 50000;

async function getAuthenticatedUser(request: NextRequest) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    return { error: "Please sign in.", status: 401 as const };
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db.auth.getUser(token);

  if (error || !data.user) {
    return { error: "Your session is invalid. Please sign in again.", status: 401 as const };
  }

  return { db, user: data.user };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);

    if ("error" in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status }
      );
    }

    const { data, error } = await auth.db
      .from("withdrawal_requests")
      .select("reference,amount_kobo,fee_kobo,net_payout_kobo,status,bank_name,account_name,account_number,created_at,admin_note")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("Withdrawal history error:", error.message);
      return NextResponse.json(
        { error: "Could not load withdrawal history." },
        { status: 500 }
      );
    }

    return NextResponse.json({ withdrawals: data ?? [] });
  } catch (error) {
    console.error("Withdrawal history API error:", error);
    return NextResponse.json(
      { error: "A server error occurred while loading withdrawal history." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);

    if ("error" in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status }
      );
    }

    const body = await request.json();

    const amountNaira = Number(body.amountNaira);
    const bankName =
      typeof body.bankName === "string" ? body.bankName.trim() : "";
    const accountName =
      typeof body.accountName === "string" ? body.accountName.trim() : "";
    const accountNumber =
      typeof body.accountNumber === "string"
        ? body.accountNumber.trim()
        : "";

    if (
      !Number.isSafeInteger(amountNaira) ||
      amountNaira < MIN_WITHDRAWAL ||
      amountNaira > MAX_WITHDRAWAL
    ) {
      return NextResponse.json(
        { error: "Withdrawals must be between ₦500 and ₦50,000." },
        { status: 400 }
      );
    }

    if (
      bankName.length < 2 ||
      bankName.length > 100 ||
      accountName.length < 2 ||
      accountName.length > 100 ||
      !/^\d{10}$/.test(accountNumber)
    ) {
      return NextResponse.json(
        {
          error:
            "Enter a valid bank name, account name, and 10-digit account number.",
        },
        { status: 400 }
      );
    }

    const { data, error } = await auth.db.rpc("request_manual_withdrawal", {
      p_user_id: auth.user.id,
      p_amount_kobo: amountNaira * 100,
      p_bank_name: bankName,
      p_account_name: accountName,
      p_account_number: accountNumber,
    });

    if (error) {
      console.error("Withdrawal request failed:", error.message);
      return NextResponse.json(
        {
          error:
            "Could not submit the withdrawal. Check your available balance and try again.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      result: data,
      message:
        "Withdrawal request submitted. It is pending administrator review.",
    });
  } catch (error) {
    console.error("Withdrawal API error:", error);
    return NextResponse.json(
      { error: "A server error occurred while submitting the withdrawal." },
      { status: 500 }
    );
  }
}
