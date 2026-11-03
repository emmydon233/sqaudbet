import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ matchId: string }> }
) {
  try {
    const { matchId } = await context.params;

    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;

    if (!token) {
      return NextResponse.json(
        { success: false, error: "You must log in first" },
        { status: 401 }
      );
    }

    const db = createSupabaseAdmin();

    const { data: authData, error: authError } =
      await db.auth.getUser(token);

    if (authError || !authData.user) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired session" },
        { status: 401 }
      );
    }

    const userId = authData.user.id;

    const { data: match, error: matchError } = await db
      .from("matches")
      .select("id, player1_id, player2_id, status, player1_ready, player2_ready")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError || !match) {
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 }
      );
    }

    const isPlayer1 = match.player1_id === userId;
    const isPlayer2 = match.player2_id === userId;

    if (!isPlayer1 && !isPlayer2) {
      return NextResponse.json(
        { success: false, error: "You are not part of this match" },
        { status: 403 }
      );
    }

    const { data: session, error: sessionError } = await db
      .from("whot_game_sessions")
      .select("game_state, settlement_status, winner_id, end_reason, player1_last_seen, player2_last_seen, player1_disconnected_at, player2_disconnected_at")
      .eq("match_id", matchId)
      .maybeSingle();

    if (sessionError) {
      console.error("Whot session read error:", sessionError);
      return NextResponse.json(
        { success: false, error: "Could not load game" },
        { status: 500 }
      );
    }

    if (!session) {
      return NextResponse.json({
        success: true,
        started: false,
        match: {
          status: match.status,
          player1Ready: match.player1_ready,
          player2Ready: match.player2_ready,
        },
      });
    }

    const state = session.game_state ?? {};

    const myHand = isPlayer1
      ? state.player1Hand ?? []
      : state.player2Hand ?? [];

    const opponentHand = isPlayer1
      ? state.player2Hand ?? []
      : state.player1Hand ?? [];

    const discard = Array.isArray(state.discard)
      ? state.discard
      : [];

    const topCard = discard.length
      ? discard[discard.length - 1]
      : null;

    return NextResponse.json({
      success: true,
      started: true,
      match: {
        status: match.status,
        player1_id: match.player1_id,
        player2_id: match.player2_id,
        player1Ready: match.player1_ready,
        player2Ready: match.player2_ready,
      },
      game: {
        myHand,
        opponentCardCount: opponentHand.length,
        topCard,
        turn: state.turn ?? null,
        chosenShape: state.chosenShape ?? null,
        status: state.status ?? "playing",
        message: state.message ?? "",
        mustDraw: Number(state.pendingPick ?? 0),
        skipNext: state.skipNext ?? false,
        deckCount: Array.isArray(state.deck) ? state.deck.length : 0,
        settlementStatus: session.settlement_status,
        winnerId: session.winner_id,
        endReason: session.end_reason,
        isMyTurn: state.turn === userId,
        player1LastSeen: session.player1_last_seen,
        player2LastSeen: session.player2_last_seen,
        player1DisconnectedAt: session.player1_disconnected_at,
        player2DisconnectedAt: session.player2_disconnected_at,
      },
    });
  } catch (error) {
    console.error("Whot game-state API error:", error);
    return NextResponse.json(
      { success: false, error: "An unexpected server error occurred" },
      { status: 500 }
    );
  }
}
