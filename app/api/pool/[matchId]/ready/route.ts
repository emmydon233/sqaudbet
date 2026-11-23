import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";
import { checkPoolAccess } from "@/lib/pool/access";
export async function POST(req: NextRequest, ctx: { params: Promise<{ matchId: string }> }) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return NextResponse.json({ success: false, error: "Login required" }, { status: 401 });
  const db = createSupabaseAdmin();
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) return NextResponse.json({ success: false, error: "Invalid session" }, { status: 401 });
  const { matchId } = await ctx.params;
  const access = await checkPoolAccess(db, matchId, auth.user.id, ["lobby", "waiting", "ready", "in_progress"]);
  if (!access.ok) {
    return NextResponse.json({ success: false, error: access.error }, { status: access.status });
  }
  const { data, error } = await db.rpc("pool_set_ready", { p_match_id: matchId, p_user_id: auth.user.id });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
