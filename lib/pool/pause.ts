/**
 * Pause rule shared by every Pool route that changes the table.
 * While either player is disconnected (the server has started the 5-minute reconnection window) the whole
 * match is frozen for BOTH players: no shots, no turn changes, no turn-timer timeouts.
 * The money outcome is decided separately by the existing disconnect/refund rules; pausing never settles anything.
 */
export const DISCONNECT_WINDOW_MS = 5 * 60 * 1000;

export type PoolPresenceRow = {
  disconnect_deadline?: string | null;
  player1_disconnected_at?: string | null;
  player2_disconnected_at?: string | null;
} | null | undefined;

export function isPoolPaused(session: PoolPresenceRow): boolean {
  return Boolean(session && (session.disconnect_deadline || session.player1_disconnected_at || session.player2_disconnected_at));
}

/** Server-clock moment the pause began (the deadline is always "start + 5 min"), or null. */
export function poolPauseStartedAt(session: PoolPresenceRow): number | null {
  if (!session?.disconnect_deadline) return null;
  const t = Date.parse(session.disconnect_deadline);
  return Number.isFinite(t) ? t - DISCONNECT_WINDOW_MS : null;
}

export const POOL_PAUSED_RESPONSE = {
  success: false,
  paused: true,
  error: "The game is paused because a player disconnected. Play resumes when they are back.",
} as const;
