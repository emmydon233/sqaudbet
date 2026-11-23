export type PoolBallSnapshot = {
  id: number;
  kind: "cue" | "solid" | "stripe" | "eight";
  x: number;
  z: number;
  vx: number;
  vz: number;
  pocketed: boolean;
};
export type PoolLastShot = {
  by: 0 | 1;
  pocketedIds: number[];
  foul: boolean;
  reasons: string[];
  scratch: boolean;
};
export type PoolSnapshot = {
  /** Server clock (ms epoch) when the current 30 s turn began. */
  turnStartedAt?: number;
  status: string;
  currentPlayer: 0 | 1;
  gameOver: boolean;
  winnerPlayer: 0 | 1 | null;
  shotInProgress: boolean;
  /** True when the player to move may relocate the cue ball anywhere legal (after a foul). */
  ballInHand?: boolean;
  lastShot?: PoolLastShot;
  groups: Array<"solid" | "stripe" | null>;
  balls: PoolBallSnapshot[];
  [key: string]: unknown;
};
export type PoolShotOptions = {
  /** -1 (left) .. +1 (right) */
  spinX?: number;
  /** -1 (back / draw) .. +1 (top / follow) */
  spinY?: number;
  /** Only honoured when the snapshot has ballInHand === true. */
  cuePlacement?: { x: number; z: number } | null;
};
export type PoolTraceEvent =
  | { f: number; k: "cue"; v: number }
  | { f: number; k: "b" | "c"; v: number }
  | { f: number; k: "p"; id: number; pocket: number };
export type PoolTrace = {
  hz: number;
  ids: number[];
  /** Per frame: [x, z, pocketed(0|1)] for every ball, in `ids` order. */
  frames: number[][];
  events: PoolTraceEvent[];
  startCue: { x: number; z: number };
};
export type ParsedShotInput = {
  power: number;
  angleRadians: number;
  expectedVersion: number;
  spinX: number;
  spinY: number;
  cuePlacement: { x: number; z: number } | null;
};
export const TABLE: {
  halfW: number; halfD: number; ballRadius: number; pocketRadius: number;
  cushionRestitution: number; ballRestitution: number; friction: number;
  stopSpeed: number; maxShotSpeed: number; step: number;
};
export const SPIN: {
  squirt: number; followK: number; drawK: number; contactKeep: number;
  sideK: number; cushionKeep: number; decayY: number; decayX: number;
};
export const pockets: ReadonlyArray<{ x: number; z: number; radius: number }>;
export function initialPoolState(): PoolSnapshot;
export function simulateShot(state: PoolSnapshot | Record<string, unknown>, power: number, angleRadians: number, options?: PoolShotOptions): PoolSnapshot;
export function simulateShotTrace(state: PoolSnapshot | Record<string, unknown>, power: number, angleRadians: number, options?: PoolShotOptions & { trace?: boolean }): { state: PoolSnapshot; trace: PoolTrace | null };
export function parseShotInput(body: unknown): ParsedShotInput;
export function pocketHoleAt(x: number, z: number): number;
export function isLegalPlacement(balls: Array<{ id: number; x: number; z: number; pocketed: boolean }>, x: number, z: number): boolean;
export const TURN_SECONDS: number;
export function applyTurnTimeout(state: PoolSnapshot | Record<string, unknown>): PoolSnapshot;
