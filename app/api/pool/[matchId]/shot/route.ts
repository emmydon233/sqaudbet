import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";
import { checkPoolAccess } from "@/lib/pool/access";
import { isPoolPaused, POOL_PAUSED_RESPONSE } from "@/lib/pool/pause";
import { initialPoolState, parseShotInput, simulateShot } from "@/lib/pool/authoritative";


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

    const rawBody = await request.json().catch(() => null);
    let shot: ReturnType<typeof parseShotInput>;
    try {
      // Strictly validates power, angle, table version, optional spin and optional ball-in-hand placement.
      shot = parseShotInput(rawBody);
    } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "A valid shot is required." }, { status: 400 });
    }

    const db = createSupabaseAdmin();
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return NextResponse.json({ success: false, error: "Your login session has expired." }, { status: 401 });
    const access = await checkPoolAccess(db, matchId, auth.user.id, ["in_progress"]);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: access.error }, { status: access.status });
    }


    const { data: session, error: sessionError } = await db
      .from("pool_game_sessions")
      .select("game_state,state_version,settlement_status,disconnect_deadline,player1_disconnected_at,player2_disconnected_at")
      .eq("match_id", matchId)
      .maybeSingle();
    if (sessionError || !session) return NextResponse.json({ success: false, error: "The Pool game session is unavailable." }, { status: 409 });
    if (session.settlement_status !== "pending") return NextResponse.json({ success: false, error: "This match has already been settled." }, { status: 409 });

    // Frozen while either player is disconnected (also enforced inside the commit RPC).
    if (isPoolPaused(session)) return NextResponse.json({ ...POOL_PAUSED_RESPONSE, disconnectDeadline: session.disconnect_deadline ?? null }, { status: 423 });

    const currentVersion = Number(session.state_version ?? 0);
    if (shot.expectedVersion !== currentVersion) {
      return NextResponse.json({ success: false, error: "The table has changed. Wait for the latest game state before shooting.", stateVersion: currentVersion }, { status: 409 });
    }

    const stored = (session.game_state ?? {}) as { snapshot?: unknown; current_player_id?: string };
    const state = (stored.snapshot ?? initialPoolState()) as any;
    const { data: match, error: matchError } = await db
      .from("matches")
      .select("player1_id,player2_id")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError || !match) {
      return NextResponse.json(
        { success: false, error: "Pool match not found." },
        { status: 404 }
      );
    }


    const currentPlayerId = stored.current_player_id ?? match.player1_id;
    if (currentPlayerId !== auth.user.id) {
      return NextResponse.json({ success: false, error: "It is not your turn." }, { status: 403 });
    }

    // The browser never submits ball coordinates, pocket reports, turn changes or a winner.
    // All of those are calculated from the last committed server snapshot here.
    // Spin and ball-in-hand placement are inputs to the SAME server simulation; the server rejects
    // a placement unless its own stored snapshot says the player has ball-in-hand.
    const snapshot = simulateShot(state, shot.power, shot.angleRadians, { spinX: shot.spinX, spinY: shot.spinY, cuePlacement: shot.cuePlacement });
    // Server clock: when the next player's 30-second turn timer starts.
    (snapshot as any).turnStartedAt = Date.now();
    const nextPlayerId = snapshot.currentPlayer === 0 ? match.player1_id : match.player2_id;
    const winnerId = snapshot.gameOver
      ? (snapshot.winnerPlayer === 0 ? match.player1_id : match.player2_id)
      : null;

    const lastShot = { startSnapshot: state, power: shot.power, angleRadians: shot.angleRadians, spinX: shot.spinX, spinY: shot.spinY, cuePlacement: shot.cuePlacement, stateVersion: currentVersion + 1 };
    const { data: committed, error: commitError } = await db.rpc("pool_commit_authoritative_shot", {
      p_match_id: matchId,
      p_user_id: auth.user.id,
      p_expected_version: currentVersion,
      p_snapshot: snapshot,
      p_next_player_id: nextPlayerId,
      p_game_over: Boolean(snapshot.gameOver),
      p_winner_id: winnerId,
      p_shot_meta: lastShot,
    });
    if (commitError) {
      console.error("Pool authoritative shot commit failed:", commitError);
      return NextResponse.json({ success: false, error: "The shot could not be committed. Please wait for the table to synchronize." }, { status: 409 });
    }
    if (!committed?.success) {
      return NextResponse.json({ success: false, error: committed?.error || "The table changed before this shot could be saved." }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      snapshot,
      lastShot,
      stateVersion: committed.stateVersion,
      settled: Boolean(committed.settled),
      winnerId: committed.winnerId ?? null,
    });
  } catch (error) {
    console.error("Pool shot API error:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "An unexpected error occurred." }, { status: 400 });
  }
}
