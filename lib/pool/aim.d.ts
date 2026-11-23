type V = { x: number; z: number };
export type AimPrediction = {
  launchAngle: number;
  cueStart: V;
  cueEnd: V | null;
  contact: { id: number; ghost: V; point: V; normal: V } | null;
  objectLine: { from: V; to: V; dir: V; pocket: number; cushion: boolean } | null;
  cueAfter: { from: V; to: V; dir: V } | null;
  cueBounce: { from: V; to: V } | null;
  cuePocket: number;
};
export function predictShot(
  balls: Array<{ id: number; x: number; z: number; pocketed: boolean }>,
  cue: V,
  angle: number,
  spin?: { x: number; y: number },
): AimPrediction;
