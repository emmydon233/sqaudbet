type AccessResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; error: string };

export async function checkPoolAccess(
  db: any,
  matchId: string,
  userId: string,
  allowedStatuses: string[]
): Promise<AccessResult> {
  const { data: match, error: matchError } = await db
    .from("matches")
    .select("id,challenge_id,player1_id,player2_id,game,status")
    .eq("id", matchId)
    .maybeSingle();

  if (matchError || !match) {
    return { ok: false, status: 404, error: "Pool match not found." };
  }

  if (String(match.game ?? "").trim().toLowerCase() !== "8-ball pool") {
    return { ok: false, status: 409, error: "This is not an 8-ball Pool match." };
  }

  const status = String(match.status ?? "").trim().toLowerCase();
  if (!allowedStatuses.map((s) => s.toLowerCase()).includes(status)) {
    return { ok: false, status: 409, error: "This Pool match is not active." };
  }

  const player1 = match.player1_id;
  const player2 = match.player2_id;

  if (!player1 || !player2 || player1 === player2) {
    return { ok: false, status: 403, error: "Invalid Pool players." };
  }

  if (userId !== player1 && userId !== player2) {
    return { ok: false, status: 403, error: "You are not a player in this match." };
  }

  if (!match.challenge_id) {
    return { ok: false, status: 409, error: "This Pool match is not linked to an accepted challenge." };
  }

  const { data: challenge, error: challengeError } = await db
    .from("challenges")
    .select("id,status,game,sender_id,recipient_id")
    .eq("id", match.challenge_id)
    .maybeSingle();

  if (
    challengeError ||
    !challenge ||
    String(challenge.status ?? "").trim().toLowerCase() !== "accepted" ||
    String(challenge.game ?? "").trim().toLowerCase() !== "8-ball pool"
  ) {
    return { ok: false, status: 409, error: "This Pool match has no valid accepted challenge." };
  }

  const samePlayers =
    (challenge.sender_id === player1 && challenge.recipient_id === player2) ||
    (challenge.sender_id === player2 && challenge.recipient_id === player1);

  if (!samePlayers) {
    return { ok: false, status: 403, error: "The accepted challenge players do not match this Pool match." };
  }

  return { ok: true };
}
