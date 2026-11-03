import { NextRequest, NextResponse } from "next/server";
import { verifySuperAdminToken } from "@/utils/supabase/server-admin";

export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: "Sign in required" }, { status: 401 });

  const admin = await verifySuperAdminToken(token);
  if (!admin.ok) {
    return NextResponse.json(
      { error: admin.error },
      { status: admin.status }
    );
  }
  const db = admin.db;

  const [challenges, matches, ledger, deposits, withdrawals, financialTotals] = await Promise.all([
    db.from("challenges").select("id,game,stake_amount,status,created_at,sender_id,recipient_id").order("created_at", { ascending: false }).limit(100),
    db.from("matches").select("id,game,stake_amount,status,created_at").order("created_at", { ascending: false }).limit(100),
    db.from("wallet_ledger").select("entry_type,amount_kobo,created_at").order("created_at", { ascending: false }).limit(500),
    db.from("payment_transactions").select("amount_kobo,status,provider,created_at"),
    db.from("withdrawal_requests").select("amount_kobo,status,created_at"),
    db.rpc("admin_financial_totals")
  ]);

  const failed = [challenges, matches, ledger, deposits, withdrawals, financialTotals].find((r) => r.error);
  if (failed) return NextResponse.json({ error: "Could not load all dashboard data. Confirm the database migrations and table permissions are set up." }, { status: 500 });

  const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const depositRows = deposits.data ?? [];
  const withdrawalRows = withdrawals.data ?? [];
  const challengeRows = challenges.data ?? [];
  const ledgerRows = ledger.data ?? [];
  const recentLedger = ledgerRows.slice(0, 12);

  return NextResponse.json({
    overview: {
      pendingChallenges: challengeRows.filter((r: any) => r.status === "pending").length,
      acceptedChallenges: challengeRows.filter((r: any) => r.status === "accepted").length,
      totalChallenges: challengeRows.length,
      totalMatches: (matches.data ?? []).length,
      activeMatches: (matches.data ?? []).filter((r: any) => !["completed", "finished", "cancelled", "failed"].includes(String(r.status).toLowerCase())).length,
      availableWalletKobo: Number(financialTotals.data?.available_wallet_kobo ?? 0),
      reservedWalletKobo: Number(financialTotals.data?.reserved_wallet_kobo ?? 0),
      totalPlayerWalletKobo: Number(financialTotals.data?.total_player_wallet_kobo ?? 0),
      recordedPlatformEarningsKobo: Number(financialTotals.data?.recorded_platform_earnings_kobo ?? 0),
      successfulDepositKobo: sum(depositRows.filter((r: any) => r.status === "success"), "amount_kobo"),
      pendingDepositKobo: sum(depositRows.filter((r: any) => r.status === "pending"), "amount_kobo"),
      pendingWithdrawalKobo: sum(withdrawalRows.filter((r: any) => r.status === "pending"), "amount_kobo"),
      approvedWithdrawalKobo: sum(withdrawalRows.filter((r: any) => r.status === "approved"), "amount_kobo"),
      completedLedgerEntries: ledgerRows.length
    },
    challenges: challengeRows.slice(0, 20),
    recentLedger,
  });
}

