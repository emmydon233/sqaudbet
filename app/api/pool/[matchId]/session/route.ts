import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";
import { checkPoolAccess } from "@/lib/pool/access";

/**
 * Server-enforced entry point for the Pool gameplay screen.
 *
 * The page calls this BEFORE it initialises the table. It authenticates the caller, then runs the
 * same accepted-challenge / participant / match-state checks (checkPoolAccess) that guard every
 * other Pool route, so opening /pool3d?matchId=... directly or guessing an id yields nothing.
 * It returns only what the HUD needs: both players' public identity, readiness, stake, and the
 * current authoritative session. It never returns wallet data.
 *
 * POST (not GET) to match the other Pool routes and stay clear of response caching.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ matchId: string }> }) {
  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) return NextResponse.json({ success: false, error: "Login required" }, { status: 401 });

    const db = createSupabaseAdmin();
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return NextResponse.json({ success: false, error: "Invalid session" }, { status: 401 });

    const { matchId } = await ctx.params;
    if (!matchId) return NextResponse.json({ success: false, error: "Match ID is required." }, { status: 400 });

    const access = await checkPoolAccess(db, matchId, auth.user.id, ["lobby", "waiting", "ready", "in_progress"]);
    if (!access.ok) return NextResponse.json({ success: false, error: access.error }, { status: access.status });

    const getTurnStartedAt = (session: any): number | null => {
      const gameState = session?.game_state;
      const snapshot = gameState?.snapshot ?? gameState;
      const timestamp = snapshot?.turnStartedAt;
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
      const startedAt = session?.started_at ? Date.parse(session.started_at) : NaN;
      return Number.isFinite(startedAt) ? startedAt : null;
    };
    // Light mode used by the game screen to catch up on a missed realtime event: same authentication and
    // accepted-challenge access check as above, but only the live session row (no profiles / stats queries).
    if (req.nextUrl.searchParams.get("sync") === "1") {
      const [{ data: m }, { data: sess }] = await Promise.all([
        db.from("matches").select("player1_id,status").eq("id", matchId).maybeSingle(),
        db.from("pool_game_sessions").select("game_state,state_version,started_at,disconnect_deadline,settlement_status,end_reason").eq("match_id", matchId).maybeSingle(),
      ]);
      return NextResponse.json({
        success: true,
        status: m?.status ?? null,
        localPlayerIndex: m?.player1_id === auth.user.id ? 0 : 1,
        session: sess ?? null,
        serverNow: Date.now(),
        turnStartedAt: getTurnStartedAt(sess),
      });
    }

    const { data: match } = await db
      .from("matches")
      .select("id,player1_id,player2_id,stake_amount,status,player1_ready,player2_ready")
      .eq("id", matchId)
      .maybeSingle();
    if (!match) return NextResponse.json({ success: false, error: "Pool match not found." }, { status: 404 });

    const ids = [match.player1_id, match.player2_id] as string[];
    const { data: profileRows } = await db.from("profiles").select("*").in("id", ids);
    const profileOf = (id: string) => {
      const row = (profileRows ?? []).find((p: Record<string, unknown>) => p.id === id) as Record<string, unknown> | undefined;
      const avatar = row ? (row.avatar_url ?? row.avatar ?? row.photo_url ?? null) : null;
      return {
        id,
        username: typeof row?.username === "string" && row.username ? row.username : "Player",
        // Only http(s) URLs are ever passed to an <img>; otherwise the HUD draws an initials avatar.
        avatarUrl: typeof avatar === "string" && /^https?:\/\//i.test(avatar) ? avatar : null,
      };
    };

    // Lightweight public stats. Any failure just means "no stats" - never blocks the game.
    const statsFor = async (id: string) => {
      try {
        const [played, won] = await Promise.all([
          db.from("matches").select("id", { count: "exact", head: true }).eq("game", "8-ball Pool").eq("status", "completed").or(`player1_id.eq.${id},player2_id.eq.${id}`),
          db.from("pool_game_sessions").select("match_id", { count: "exact", head: true }).eq("winner_id", id).eq("settlement_status", "settled"),
        ]);
        if (played.error || won.error) return null;
        return { played: played.count ?? 0, won: won.count ?? 0 };
      } catch {
        return null;
      }
    };
    const [stats1, stats2] = await Promise.all([statsFor(match.player1_id), statsFor(match.player2_id)]);

    const { data: session } = await db
      .from("pool_game_sessions")
      .select("game_state,state_version,started_at,disconnect_deadline,settlement_status,end_reason")
      .eq("match_id", matchId)
      .maybeSingle();

    return NextResponse.json({
      success: true,
      matchId: match.id,
      status: match.status,
      stake: Number(match.stake_amount),
      localPlayerIndex: match.player1_id === auth.user.id ? 0 : 1,
      players: [
        { ...profileOf(match.player1_id), ready: Boolean(match.player1_ready), stats: stats1 },
        { ...profileOf(match.player2_id), ready: Boolean(match.player2_ready), stats: stats2 },
      ],
      session: session ?? null,
      serverNow: Date.now(),
      turnStartedAt: getTurnStartedAt(session),
    });
  } catch (error) {
    console.error("Pool session API error:", error);
    return NextResponse.json({ success: false, error: "Could not load the Pool match." }, { status: 500 });
  }
}
