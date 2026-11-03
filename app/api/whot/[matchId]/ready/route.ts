import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/utils/supabase/server-admin";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ matchId: string }> }
) {
  try {
    const { matchId } = await context.params;

    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Match ID is required" },
        { status: 400 }
      );
    }

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

    const { data, error } = await db.rpc("whot_set_ready", {
      p_match_id: matchId,
      p_user_id: authData.user.id,
    });

    if (error) {
      console.error("Whot ready-up error:", error);
      return NextResponse.json(
        { success: false, error: "Could not update ready status" },
        { status: 500 }
      );
    }

    if (!data?.success) {
      return NextResponse.json(data, { status: 400 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Whot ready API error:", error);
    return NextResponse.json(
      { success: false, error: "An unexpected server error occurred" },
      { status: 500 }
    );
  }
}