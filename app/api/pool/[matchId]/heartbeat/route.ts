import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";
import { checkPoolAccess } from "@/lib/pool/access";
import { DISCONNECT_WINDOW_MS } from "@/lib/pool/pause";
import { initialPoolState } from "@/lib/pool/authoritative";

export async function POST(req: NextRequest, ctx: { params: Promise<{ matchId: string }> }) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return NextResponse.json({ success: false, error: "Login required" }, { status: 401 });
  const db = createSupabaseAdmin();
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) return NextResponse.json({ success: false, error: "Invalid session" }, { status: 401 });

  const { matchId } = await ctx.params;
  const access = await checkPoolAccess(db, matchId, auth.user.id, ["lobby", "waiting", "ready", "in_progress"]);
  if (!access.ok) return NextResponse.json({ success: false, error: access.error }, { status: access.status });

  // Capture the authoritative pause start and turn snapshot before pool_presence clears
  // this player's disconnect timestamp. The first returning player persists the marker;
  // the final returning player uses it to restore the clock.
  const [{ data: match }, { data: before, error: readError }] = await Promise.all([
    db.from("matches").select("player1_id,player2_id,status").eq("id", matchId).maybeSingle(),
    db.from("pool_game_sessions")
      .select("game_state,state_version,started_at,disconnect_deadline,player1_disconnected_at,player2_disconnected_at,settlement_status")
      .eq("match_id", matchId).maybeSingle(),
  ]);
  if (readError) return NextResponse.json({ success: false, error: "Could not read Pool presence" }, { status: 409 });

  // Detect a silent opponent before pool_presence updates this player's heartbeat.
  // Only live, unsettled matches are eligible.
  const isP1 = match?.player1_id === auth.user.id;

  if (
    match?.status === "in_progress" &&
    before?.settlement_status === "pending" &&
    (isP1 || match?.player2_id === auth.user.id)
  ) {
    const otherLastSeenColumn = isP1
      ? "player2_last_seen"
      : "player1_last_seen";

    const otherDisconnectedColumn = isP1
      ? "player2_disconnected_at"
      : "player1_disconnected_at";

    const now = new Date();
    const staleCutoff = new Date(now.getTime() - 12_000).toISOString();
    const disconnectedAt = now.toISOString();

    const deadline = before.disconnect_deadline ??
      new Date(now.getTime() + DISCONNECT_WINDOW_MS).toISOString();

    let staleUpdate = db.from("pool_game_sessions")
      .update({
        [otherDisconnectedColumn]: disconnectedAt,
        disconnect_deadline: deadline,
        updated_at: disconnectedAt,
      })
      .eq("match_id", matchId)
      .eq("settlement_status", "pending")
      .is(otherDisconnectedColumn, null)
      .lt(otherLastSeenColumn, staleCutoff);

    if (before.disconnect_deadline) {
      staleUpdate = staleUpdate.eq("disconnect_deadline", before.disconnect_deadline);
    } else {
      staleUpdate = staleUpdate.is("disconnect_deadline", null);
    }

    const { error: staleUpdateError } = await staleUpdate;

    if (staleUpdateError) {
      return NextResponse.json(
        { success: false, error: "Could not update Pool disconnect presence" },
        { status: 409 }
      );
    }
  }
  const mine = isP1 ? before?.player1_disconnected_at : before?.player2_disconnected_at;
  const other = isP1 ? before?.player2_disconnected_at : before?.player1_disconnected_at;
  const disconnectedTimes = [before?.player1_disconnected_at, before?.player2_disconnected_at]
    .filter((v): v is string => Boolean(v)).map((v) => Date.parse(v)).filter(Number.isFinite);
  const observedPauseStart = disconnectedTimes.length ? Math.min(...disconnectedTimes) : null;
  const wasLivePaused = match?.status === "in_progress" && before?.settlement_status === "pending" && Boolean(before?.disconnect_deadline || mine || other);
  const priorGameState = (before?.game_state ?? {}) as any;
  const priorSnapshot = (priorGameState.snapshot ?? initialPoolState()) as any;
  const savedPauseStart = Number(priorSnapshot.pauseStartedAt);
  const pauseStart = Number.isFinite(savedPauseStart) && savedPauseStart > 0
    ? savedPauseStart
    : observedPauseStart;
  const version = Number(before?.state_version ?? 0);

  const { data, error } = await db.rpc("pool_presence", {
    p_match_id: matchId, p_action: "heartbeat", p_user_id: auth.user.id,
  });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });

  if (wasLivePaused && mine && data?.returned && !data?.settled && pauseStart) {
    const { data: after, error: afterError } = await db.from("pool_game_sessions")
      .select("game_state,state_version,disconnect_deadline,player1_disconnected_at,player2_disconnected_at,settlement_status")
      .eq("match_id", matchId).maybeSingle();

    if (!afterError && after && after.settlement_status === "pending" && Number(after.state_version) === version) {
      const stillPaused = Boolean(after.disconnect_deadline || after.player1_disconnected_at || after.player2_disconnected_at);
      const gameState = (after.game_state ?? priorGameState) as any;
      const snapshot = { ...(gameState.snapshot ?? priorSnapshot) } as any;
      const pauseMarker = new Date(pauseStart).toISOString();

      if (stillPaused) {
        // Preserve the ORIGINAL start across a staggered reconnect, because pool_presence
        // resets disconnect_deadline when one player returns while the other remains away.
        if (!snapshot.pauseStartedAt) {
          snapshot.pauseStartedAt = pauseStart;
          await db.from("pool_game_sessions").update({ game_state: { ...gameState, snapshot } })
            .eq("match_id", matchId).eq("state_version", version).eq("settlement_status", "pending");
        }
      } else if (snapshot.pauseAdjustedFor !== pauseMarker && !snapshot.gameOver) {
        const stamped = Number(snapshot.turnStartedAt);
        const startedAt = Number.isFinite(stamped) && stamped > 0
          ? stamped
          : (gameState.snapshot ? NaN : Date.parse(before?.started_at ?? ""));
        const pausedMs = Math.min(DISCONNECT_WINDOW_MS, Math.max(0, Date.now() - pauseStart));
        if (Number.isFinite(startedAt) && pausedMs > 0) {
          snapshot.turnStartedAt = startedAt + pausedMs;
          snapshot.pauseAdjustedFor = pauseMarker;
          delete snapshot.pauseStartedAt;
          // The JSON marker condition is checked in the same UPDATE as the write. This makes
          // concurrent/retried heartbeats unable to add the same pause duration twice.
          await db.from("pool_game_sessions").update({ game_state: { ...gameState, snapshot } })
            .eq("match_id", matchId).eq("state_version", version).eq("settlement_status", "pending")
            .not("game_state->snapshot->>pauseAdjustedFor", "eq", pauseMarker);
        }
      }
    }
  }

  const { data: timeout, error: timeoutError } = await db.rpc("pool_resolve_disconnect", {
    p_match_id: matchId, p_user_id: auth.user.id,
  });
  if (timeoutError) return NextResponse.json({ success: false, error: timeoutError.message }, { status: 400 });
  return NextResponse.json({ ...data, timeout });
}
