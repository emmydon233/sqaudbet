import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";

export async function POST(
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
      .select("id, player1_id, player2_id, status")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError || !match) {
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 }
      );
    }

    if (match.player1_id !== userId && match.player2_id !== userId) {
      return NextResponse.json(
        { success: false, error: "You are not part of this match" },
        { status: 403 }
      );
    }

    if (match.status !== "in_progress") {
      return NextResponse.json(
        { success: false, error: "Match is not active" },
        { status: 409 }
      );
    }

    const { data: session, error: sessionError } = await db
      .from("whot_game_sessions")
      .select("settlement_status")
      .eq("match_id", matchId)
      .maybeSingle();

    if (sessionError || !session || session.settlement_status !== "pending") {
      return NextResponse.json(
        { success: false, error: "Game session is unavailable" },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    const presenceUpdate =
      match.player1_id === userId
        ? {
            player1_last_seen: now,
            player1_disconnected_at: null,
            updated_at: now,
          }
        : {
            player2_last_seen: now,
            player2_disconnected_at: null,
            updated_at: now,
          };

    const { error: updateError } = await db
      .from("whot_game_sessions")
      .update(presenceUpdate)
      .eq("match_id", matchId);

    if (updateError) {
      console.error("Whot heartbeat update error:", updateError);
      return NextResponse.json(
        { success: false, error: "Could not update player presence" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, lastSeen: now });
  } catch (error) {
    console.error("Whot heartbeat API error:", error);
    return NextResponse.json(
      { success: false, error: "Unexpected server error" },
      { status: 500 }
    );
  }
}