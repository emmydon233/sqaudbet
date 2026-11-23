"use client";
/**
 * Tiny client-side queue between "something happened" (login, registration, confirmed game result) and the
 * single <NaijaPopupHost/> mounted in the root layout. The pending pop-up is parked in sessionStorage so it
 * survives the router navigation that follows a login/registration, and every pop-up carries a dedupe key so
 * repeated auth callbacks, realtime echoes or page reloads can never show the same occasion twice.
 */
import { pickNaijaMessage, type NaijaPopupKind } from "./messages";

export const NAIJA_POPUP_EVENT = "squadbet:naija-popup";
const PENDING_KEY = "squadbet.naija.pending";
const SEEN_KEY = "squadbet.naija.seen";
const LAST_KEY = "squadbet.naija.last";

export type NaijaPopupRequest = { kind: NaijaPopupKind; message: string; key: string };
type SeenMap = Record<string, number>;

function readJson<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function storageOf(kind: "local" | "session"): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** true if `key` was already used within `windowMs` (Infinity = ever). Records the use when it was new. */
export function claimNaijaKey(key: string, windowMs: number): boolean {
  const store = storageOf("local");
  const now = Date.now();
  const seen = readJson<SeenMap>(store, SEEN_KEY, {});
  const at = seen[key];
  if (at !== undefined && now - at < windowMs) return false;
  seen[key] = now;
  // keep the map small: newest 60 entries only
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 60);
  try { store?.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* storage unavailable */ }
  return true;
}

const memorySeen = new Map<string, number>();

/**
 * Queue one pop-up. `dedupeMs`: how long the same key is suppressed (default: forever, right for game results).
 * Returns false when it was suppressed as a duplicate.
 */
export function queueNaijaPopup(kind: NaijaPopupKind, key: string, dedupeMs = Number.POSITIVE_INFINITY): boolean {
  if (typeof window === "undefined") return false;
  const now = Date.now();
  const mem = memorySeen.get(key);
  if (mem !== undefined && now - mem < dedupeMs) return false; // same tab, even if storage is blocked
  if (!claimNaijaKey(key, dedupeMs)) return false;
  memorySeen.set(key, now);
  const last = readJson<Record<string, string>>(storageOf("local"), LAST_KEY, {})[kind] ?? null;
  const message = pickNaijaMessage(kind, last);
  try {
    const lastMap = readJson<Record<string, string>>(storageOf("local"), LAST_KEY, {});
    lastMap[kind] = message;
    storageOf("local")?.setItem(LAST_KEY, JSON.stringify(lastMap));
    storageOf("session")?.setItem(PENDING_KEY, JSON.stringify({ kind, message, key } satisfies NaijaPopupRequest));
  } catch { /* parking is best-effort; the event below still shows it on this page */ }
  window.dispatchEvent(new CustomEvent<NaijaPopupRequest>(NAIJA_POPUP_EVENT, { detail: { kind, message, key } }));
  return true;
}

/** Called by the host on mount: take (and clear) a pop-up parked before a navigation. */
export function takePendingNaijaPopup(): NaijaPopupRequest | null {
  const store = storageOf("session");
  const pending = readJson<NaijaPopupRequest | null>(store, PENDING_KEY, null);
  try { store?.removeItem(PENDING_KEY); } catch { /* ignore */ }
  return pending && pending.message && pending.kind ? pending : null;
}

/** Win/loss for any game (pool, whot, ludo). Call ONLY once the result is officially confirmed. */
export function queueGameResultPopup(game: "pool" | "whot" | "ludo", matchId: string, userId: string, won: boolean): boolean {
  return queueNaijaPopup(won ? "win" : "loss", `result:${game}:${matchId}:${userId}`);
}
