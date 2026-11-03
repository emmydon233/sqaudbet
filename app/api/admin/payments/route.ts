
import { NextRequest, NextResponse } from "next/server";
import { verifySuperAdminToken } from "@/utils/supabase/server-admin";

async function getAdmin(request: NextRequest) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    return { error: "Sign in required", status: 401 as const };
  }

  const admin = await verifySuperAdminToken(token);

  if (!admin.ok) {
    return { error: admin.error, status: admin.status };
  }

  return { db: admin.db, user: admin.user };
}

export async function GET(request: NextRequest) {
  try {
    const a = await getAdmin(request);

    if ("error" in a) {
      return NextResponse.json(
        { error: a.error },
        { status: a.status }
      );
    }

    const [d, w] = await Promise.all([
      a.db
        .from("payment_transactions")
        .select(
          "reference,user_id,amount_kobo,fee_kobo,net_credit_kobo,status,transfer_reference,created_at,admin_note"
        )
        .eq("provider", "opay_manual")
        .order("created_at", { ascending: false })
        .limit(100),

      a.db
        .from("withdrawal_requests")
        .select(
          "reference,user_id,amount_kobo,fee_kobo,net_payout_kobo,status,bank_name,account_name,account_number,created_at,admin_note"
        )
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    if (d.error || w.error) {
      console.error(
        "Admin payments query failed:",
        d.error?.message,
        w.error?.message
      );

      return NextResponse.json(
        { error: "Could not load payment requests. Check that the OPay SQL migration has been applied." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      deposits: d.data ?? [],
      withdrawals: w.data ?? [],
    });
  } catch (error) {
    console.error("Admin payments GET failed:", error);

    return NextResponse.json(
      { error: "The payments API encountered a server error. Check the VS Code terminal for details." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const a = await getAdmin(request);

    if ("error" in a) {
      return NextResponse.json(
        { error: a.error },
        { status: a.status }
      );
    }

    const b = await request.json() as {
      kind?: string;
      reference?: string;
      action?: string;
      note?: string;
    };

    if (!b.reference || typeof b.reference !== "string") {
      return NextResponse.json(
        { error: "Reference required" },
        { status: 400 }
      );
    }

    const note =
      typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";

    if (
      b.kind === "withdrawal" &&
      b.action === "reject" &&
      !note
    ) {
      return NextResponse.json(
        { error: "Please enter a reason before rejecting this withdrawal." },
        { status: 400 }
      );
    }

    let result;

    if (
      b.kind === "deposit" &&
      (b.action === "approve" || b.action === "reject")
    ) {
      result = await a.db.rpc("admin_review_opay_deposit", {
        p_admin: a.user.id,
        p_reference: b.reference,
        p_approve: b.action === "approve",
        p_note: note || null,
      });
    } else if (
      b.kind === "withdrawal" &&
      ["approve", "reject", "paid"].includes(b.action ?? "")
    ) {
      result = await a.db.rpc("admin_review_withdrawal", {
        p_admin: a.user.id,
        p_reference: b.reference,
        p_action: b.action,
        p_note: note || null,
      });
    } else {
      return NextResponse.json(
        { error: "Invalid review action" },
        { status: 400 }
      );
    }

    if (result.error) {
      console.error(
        "Admin payment review failed:",
        result.error.message
      );

      return NextResponse.json(
        { error: "Could not update request. It may already have been reviewed, or the database rejected the action." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Admin payments POST failed:", error);

    return NextResponse.json(
      { error: "The payment request failed on the server. Check the VS Code terminal for details." },
      { status: 500 }
    );
  }
}

