import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";
import { checkPoolAccess } from "@/lib/pool/access";
import { isPoolPaused, POOL_PAUSED_RESPONSE } from "@/lib/pool/pause";
import { TURN_SECONDS, applyTurnTimeout, initialPoolState } from "@/lib/pool/authoritative";

/**
 * Turn timer (30 s, like 8 Ball Pool). The server owns the clock: the browser can only ask
 * "has the time run out?". The deadline comes from `turnStartedAt`, which the shot route stamps
 * with the server clock on every committed shot. If it has really passed, the turn is handed to
 * the opponent through the SAME commit RPC every shot uses. No wallet, stake or settlement code is touched.
 * Either player may call this (so a missing player cannot stall the match).
 */
const GRACE_MS = 1000;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ matchId: string }> }
) {
  try {
    const { matchId } = await context.params;
    if (!matchId) return NextResponse.json({ success: false, error: "Match ID is required." }, { status: 400 });
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!token) return NextResponse.json({ success: false, error: "Please log in again." }, { status: 401 });

    const body = await request.json().catch(() => null);
    const expectedVersion = Number(body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return NextResponse.json({ success: false, error: "A valid table version is required." }, { status: 400 });
    }

    const db = createSupabaseAdmin();
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return NextResponse.json({ success: false, error: "Your login session has expired." }, { status: 401 });
    const access = await checkPoolAccess(db, matchId, auth.user.id, ["in_progress"]);
    if (!access.ok) return NextResponse.json({ success: false, error: access.error }, { status: access.status });

    const { data: session, error: sessionError } = await db
      .from("pool_game_sessions")
      .select("game_state,state_version,settlement_status,started_at,disconnect_deadline,player1_disconnected_at,player2_disconnected_at")
      .eq("match_id", matchId)
      .maybeSingle();
    if (sessionError || !session) return NextResponse.json({ success: false, error: "The Pool game session is unavailable." }, { status: 409 });
    if (session.settlement_status !== "pending") return NextResponse.json({ success: false, error: "This match has already been settled." }, { status: 409 });

    // The turn clock never runs out while the match is frozen for a disconnection.
    if (isPoolPaused(session)) return NextResponse.json({ ...POOL_PAUSED_RESPONSE, disconnectDeadline: session.disconnect_deadline ?? null }, { status: 423 });

    const currentVersion = Number(session.state_version ?? 0);
    if (expectedVersion !== currentVersion) {
      // Someone already shot / timed out: just tell the caller to refresh.
      return NextResponse.json({ success: false, stale: true, error: "The table has already moved on.", stateVersion: currentVersion }, { status: 409 });
    }

    const stored = (session.game_state ?? {}) as { snapshot?: any; current_player_id?: string };
    const state = (stored.snapshot ?? initialPoolState()) as any;
    if (state.gameOver) return NextResponse.json({ success: false, error: "This match has already ended." }, { status: 409 });

    // First turn of the match has no stamped shot yet: its clock starts when the match started.
    let startedAt = Number(state.turnStartedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      const t = currentVersion === 0 && session.started_at ? Date.parse(session.started_at) : NaN;
      startedAt = t;
    }
    if (!Number.isFinite(startedAt)) {
      return NextResponse.json({ success: false, error: "No turn timer is running yet." }, { status: 409 });
    }
    const now = Date.now();
    if (now < startedAt + TURN_SECONDS * 1000 + GRACE_MS) {
      return NextResponse.json({ success: false, early: true, error: "The turn time has not run out yet.", remainingMs: startedAt + TURN_SECONDS * 1000 - now }, { status: 409 });
    }

    const { data: match, error: matchError } = await db
      .from("matches")
      .select("player1_id,player2_id")
      .eq("id", matchId)
      .maybeSingle();
    if (matchError || !match) return NextResponse.json({ success: false, error: "Pool match not found." }, { status: 404 });

    const timedOutPlayerId = stored.current_player_id ?? match.player1_id;
    const snapshot = applyTurnTimeout(state) as any;
    snapshot.turnStartedAt = now;
    const nextPlayerId = snapshot.currentPlayer === 0 ? match.player1_id : match.player2_id;

    const lastShot = { timeout: true, startSnapshot: state, stateVersion: currentVersion + 1 };
    // The commit RPC requires the CURRENT player as p_user_id; the server has verified the clock above.
    const { data: committed, error: commitError } = await db.rpc("pool_commit_authoritative_shot", {
      p_match_id: matchId,
      p_user_id: timedOutPlayerId,
      p_expected_version: currentVersion,
      p_snapshot: snapshot,
      p_next_player_id: nextPlayerId,
      p_game_over: false,
      p_winner_id: null,
      p_shot_meta: lastShot,
    });
    if (commitError) {
      console.error("Pool turn timeout commit failed:", commitError);
      return NextResponse.json({ success: false, error: "The turn could not be passed. Please wait for the table to synchronize." }, { status: 409 });
    }
    if (!committed?.success) {
      return NextResponse.json({ success: false, error: committed?.error || "The table changed before the turn could be passed." }, { status: 409 });
    }
    return NextResponse.json({ success: true, snapshot, stateVersion: committed.stateVersion });
  } catch (error) {
    console.error("Pool timeout API error:", error);
    return NextResponse.json({ success: false, error: "An unexpected error occurred." }, { status: 400 });
  }
}
