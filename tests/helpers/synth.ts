import type { Landmark, Pose, PoseFrame } from '../../src/pose/types';
import { LM } from '../../src/pose/landmarks';

export const ASPECT = 4 / 3;

/** Body posture in "height units" (x already multiplied by aspect). */
export interface SynthParams {
  hipX: number;
  hipY: number;
  torso: number;
  tiltDeg: number;
  /** Knee lift in torso lengths. */
  kneeLiftL: number;
  kneeLiftR: number;
  arms: 'down' | 'both-up' | 'right-up' | 'pump';
  /** wristL.y - wristR.y in shoulder widths (arms: 'pump'). */
  pump: number;
  /** Extra head drop in torso lengths. */
  noseDrop: number;
  lowerVisible: boolean;
}

export const STAND: SynthParams = {
  hipX: 0.5 * ASPECT,
  hipY: 0.6,
  torso: 0.25,
  tiltDeg: 0,
  kneeLiftL: 0,
  kneeLiftR: 0,
  arms: 'down',
  pump: 0,
  noseDrop: 0,
  lowerVisible: true,
};

export function synthPose(params: Partial<SynthParams> = {}): Pose {
  const q = { ...STAND, ...params };
  const T = q.torso;
  const S = 0.8 * T;
  const a = (q.tiltDeg * Math.PI) / 180;
  const C = { x: q.hipX, y: q.hipY - T };
  const shL = { x: C.x - (Math.cos(a) * S) / 2, y: C.y - (Math.sin(a) * S) / 2 };
  const shR = { x: C.x + (Math.cos(a) * S) / 2, y: C.y + (Math.sin(a) * S) / 2 };
  const nose = { x: C.x + 0.45 * T * Math.sin(a), y: C.y - 0.45 * T * Math.cos(a) + q.noseDrop * T };
  const hipL = { x: q.hipX - 0.2 * T, y: q.hipY };
  const hipR = { x: q.hipX + 0.2 * T, y: q.hipY };
  const kneeL = { x: hipL.x, y: q.hipY + 0.9 * T - q.kneeLiftL * T };
  const kneeR = { x: hipR.x, y: q.hipY + 0.9 * T - q.kneeLiftR * T };
  const down = q.hipY + 0.05 * T;
  const up = C.y - 0.7 * T;
  let wLy = down;
  let wRy = down;
  if (q.arms === 'both-up') wLy = wRy = up;
  if (q.arms === 'right-up') wRy = up;
  if (q.arms === 'pump') {
    const mid = q.hipY - 0.3 * T;
    wLy = mid + (q.pump * S) / 2;
    wRy = mid - (q.pump * S) / 2;
  }
  const wL = { x: shL.x - 0.05 * T, y: wLy };
  const wR = { x: shR.x + 0.05 * T, y: wRy };

  const lm = (p: { x: number; y: number }, visibility = 0.95): Landmark => ({ x: p.x / ASPECT, y: p.y, z: 0, visibility });
  const pose: Pose = Array.from({ length: 33 }, () => lm(C, 0.9));
  pose[LM.NOSE] = lm(nose);
  pose[LM.L_SHOULDER] = lm(shL);
  pose[LM.R_SHOULDER] = lm(shR);
  pose[LM.L_WRIST] = lm(wL);
  pose[LM.R_WRIST] = lm(wR);
  pose[LM.L_HIP] = lm(hipL);
  pose[LM.R_HIP] = lm(hipR);
  pose[LM.L_KNEE] = lm(kneeL, q.lowerVisible ? 0.95 : 0.1);
  pose[LM.R_KNEE] = lm(kneeR, q.lowerVisible ? 0.95 : 0.1);
  return pose;
}

export const ramp = (t: number, dur: number) => Math.min(1, Math.max(0, t / dur));

/** Parabolic jump height (torso lengths) at time t of a jump lasting dur ms. */
export const jumpArc = (t: number, dur: number, height: number) =>
  t >= 0 && t < dur ? 4 * height * (t / dur) * (1 - t / dur) : 0;

export interface JogOptions {
  spm?: number;
  /** Hip bob amplitude in torso lengths. */
  bob?: number;
  small?: boolean;
  arms?: SynthParams['arms'];
  base?: Partial<SynthParams>;
}

/** Jogging in place: alternating knee lifts (full) or arm pumping (small) plus a vertical bob once per step. */
export function jogParams(t: number, o: JogOptions = {}): SynthParams {
  const spm = o.spm ?? 160;
  const bob = o.bob ?? 0.05;
  const base = { ...STAND, ...o.base };
  const stepMs = 60000 / spm;
  const s = Math.sin((2 * Math.PI * t) / (2 * stepMs));
  const hipY = base.hipY + bob * base.torso * Math.cos((2 * Math.PI * t) / stepMs);
  if (o.small) {
    return { ...base, lowerVisible: false, hipY, arms: o.arms ?? 'pump', pump: 0.5 * s };
  }
  return { ...base, hipY, kneeLiftL: Math.max(0, s) * 0.35, kneeLiftR: Math.max(0, -s) * 0.35, arms: o.arms ?? 'down' };
}

type Step = Partial<SynthParams> | Partial<SynthParams>[] | null;

/** Builds a continuous timeline of synthetic frames. */
export class Scenario {
  t = 0;
  readonly frames: PoseFrame[] = [];
  constructor(readonly fps = 30) {}

  add(durationMs: number, fn: (t: number) => Step): this {
    const dt = 1000 / this.fps;
    for (let local = 0; local < durationMs - 1e-6; local += dt) {
      const p = fn(local);
      const list = p === null ? [] : Array.isArray(p) ? p : [p];
      this.frames.push({ t: this.t + local, aspect: ASPECT, poses: list.map((x) => synthPose(x)) });
    }
    this.t += durationMs;
    return this;
  }

  hold(durationMs: number, p: Step = {}): this {
    return this.add(durationMs, () => p);
  }
}
