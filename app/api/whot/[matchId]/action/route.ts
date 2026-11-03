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

    const body = await request.json();
    const action = body.action;
    const cardId = body.cardId ?? null;
    const chosenShape = body.chosenShape ?? null;
    const userId = authData.user.id;

    if (!["play", "draw", "pass", "choose_shape", "market"].includes(action)) {
      return NextResponse.json(
        { success: false, error: "Invalid game action" },
        { status: 400 }
      );
    }

    if (
      action === "play" &&
      (!Number.isInteger(cardId) || cardId <= 0)
    ) {
      return NextResponse.json(
        { success: false, error: "A valid card ID is required" },
        { status: 400 }
      );
    }

    if (
      action === "choose_shape" &&
      !["Circle", "Triangle", "Cross", "Square", "Star"].includes(chosenShape)
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid shape selection" },
        { status: 400 }
      );
    }

    const { data, error } =
      action === "market"
        ? await db.rpc("whot_market_draw", {
            p_match_id: matchId,
            p_user_id: userId,
          })
        : await db.rpc("whot_apply_action", {
            p_match_id: matchId,
            p_user_id: userId,
            p_action: action,
            p_card_id: cardId,
            p_chosen_shape: chosenShape,
          });

    if (error) {
      console.error("Whot action RPC error:", error);
      return NextResponse.json(
        { success: false, error: "Could not process your move" },
        { status: 500 }
      );
    }

    if (
      !data?.success &&
      (
        (action === "draw" && data?.error === "Not enough cards remain in the pile") ||
        (action === "market" && data?.error === "No cards remain in the market")
      )
    ) {
      const { data: exhaustionData, error: exhaustionError } =
        await db.rpc("whot_resolve_exhaustion", {
          p_match_id: matchId,
          p_user_id: userId,
          p_action: action,
        });

      if (exhaustionError) {
        console.error("Whot exhaustion resolution error:", exhaustionError);
        return NextResponse.json(
          { success: false, error: "Could not resolve the exhausted deck" },
          { status: 500 }
        );
      }

      if (exhaustionData?.success) {
        return NextResponse.json(exhaustionData);
      }
    }

    if (!data?.success) {
      return NextResponse.json(data, { status: 400 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Whot action API error:", error);
    return NextResponse.json(
      { success: false, error: "Unexpected server error" },
      { status: 500 }
    );
  }
}
