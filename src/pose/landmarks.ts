import type { Landmark, Pose } from './types';

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
} as const;

export const TRACKED_INDICES: readonly number[] = Object.values(LM);
export const VISIBLE = 0.6;

export interface Vec2 {
  x: number;
  y: number;
}

/** Body measurements in height units: y is normalized image height, x is scaled by aspect so both axes match. */
export interface Body {
  nose: Vec2;
  shoulder: Vec2;
  hip: Vec2;
  shoulderL: Vec2;
  shoulderR: Vec2;
  wristL: Vec2;
  wristR: Vec2;
  /** Wrist landmark visibility is at least VISIBLE; a hidden wrist is never treated as raised. */
  wristLVisible: boolean;
  wristRVisible: boolean;
  kneeL: Vec2 | null;
  kneeR: Vec2 | null;
  torso: number;
  shoulderWidth: number;
  /** Shoulder-line angle in degrees; negative means leaning to the player's left. */
  tiltDeg: number;
  lowerBodyVisible: boolean;
  confidence: number;
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function toBody(pose: Pose, aspect: number): Body {
  const pt = (l: Landmark): Vec2 => ({ x: l.x * aspect, y: l.y });
  const vis = (i: number) => pose[i].visibility;
  const shoulderL = pt(pose[LM.L_SHOULDER]);
  const shoulderR = pt(pose[LM.R_SHOULDER]);
  const shoulder = mid(shoulderL, shoulderR);
  const hip = mid(pt(pose[LM.L_HIP]), pt(pose[LM.R_HIP]));
  const kneesVisible = vis(LM.L_KNEE) >= VISIBLE && vis(LM.R_KNEE) >= VISIBLE;
  const hipsVisible = vis(LM.L_HIP) >= VISIBLE && vis(LM.R_HIP) >= VISIBLE;
  const core = [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];
  return {
    nose: pt(pose[LM.NOSE]),
    shoulder,
    hip,
    shoulderL,
    shoulderR,
    wristL: pt(pose[LM.L_WRIST]),
    wristR: pt(pose[LM.R_WRIST]),
    wristLVisible: vis(LM.L_WRIST) >= VISIBLE,
    wristRVisible: vis(LM.R_WRIST) >= VISIBLE,
    kneeL: kneesVisible ? pt(pose[LM.L_KNEE]) : null,
    kneeR: kneesVisible ? pt(pose[LM.R_KNEE]) : null,
    torso: dist(shoulder, hip),
    shoulderWidth: dist(shoulderL, shoulderR),
    tiltDeg: (Math.atan2(shoulderR.y - shoulderL.y, shoulderR.x - shoulderL.x) * 180) / Math.PI,
    lowerBodyVisible: kneesVisible && hipsVisible,
    confidence: core.reduce((s: number, i: number) => s + vis(i), 0) / core.length,
  };
}
