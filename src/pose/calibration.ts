import { dist, VISIBLE, type Body, type Vec2 } from './landmarks';
import type { Thresholds } from './thresholds';
import type { CalibrationState, DistanceHint, PlayMode } from './types';

export interface Baseline {
  hip: Vec2;
  shoulder: Vec2;
  nose: Vec2;
  /** knee.y - hip.y while standing; null when knees were not visible. */
  kneeRelL: number | null;
  kneeRelR: number | null;
  torso: number;
  shoulderWidth: number;
  mode: PlayMode;
}

const IDLE: CalibrationState = { progress: 0, bodyVisible: false, distance: 'ok' };

function average(bodies: Body[], f: (b: Body) => number | null): number | null {
  const xs = bodies.map(f).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Records the player's resting posture after they hold still for calibHoldMs. */
export class Calibrator {
  state: CalibrationState = { ...IDLE };
  private samples: { t: number; body: Body }[] = [];

  constructor(private th: Thresholds) {}

  reset(): void {
    this.samples = [];
    this.state = { ...IDLE };
  }

  update(body: Body | null, t: number, forcedMode: PlayMode | null): Baseline | null {
    if (!body || body.confidence < VISIBLE) {
      this.reset();
      return null;
    }
    const distance: DistanceHint =
      body.torso < this.th.calibMinTorso ? 'closer' : forcedMode === 'full' && !body.lowerBodyVisible ? 'back' : 'ok';
    if (distance !== 'ok') {
      this.samples = [];
      this.state = { progress: 0, bodyVisible: true, distance };
      return null;
    }

    const first = this.samples[0];
    if (first && dist(first.body.hip, body.hip) > this.th.calibStill * body.torso) this.samples = [];
    this.samples.push({ t, body });
    const span = t - this.samples[0].t;
    this.state = { progress: Math.min(1, span / this.th.calibHoldMs), bodyVisible: true, distance };
    if (span < this.th.calibHoldMs) return null;

    const bodies = this.samples.map((s) => s.body);
    const avg = (f: (b: Body) => number) => average(bodies, f)!;
    const lower = bodies.filter((b) => b.lowerBodyVisible).length > bodies.length / 2;
    const mode: PlayMode = forcedMode ?? (lower ? 'full' : 'small');
    const baseline: Baseline = {
      hip: { x: avg((b) => b.hip.x), y: avg((b) => b.hip.y) },
      shoulder: { x: avg((b) => b.shoulder.x), y: avg((b) => b.shoulder.y) },
      nose: { x: avg((b) => b.nose.x), y: avg((b) => b.nose.y) },
      kneeRelL: lower ? average(bodies, (b) => (b.kneeL ? b.kneeL.y - b.hip.y : null)) : null,
      kneeRelR: lower ? average(bodies, (b) => (b.kneeR ? b.kneeR.y - b.hip.y : null)) : null,
      torso: avg((b) => b.torso),
      shoulderWidth: avg((b) => b.shoulderWidth),
      mode,
    };
    this.reset();
    return baseline;
  }
}

/** Slowly follows posture changes (standing taller, stepping nearer) while the player is still. Never moves x. */
export function driftBaseline(base: Baseline, body: Body, dtMs: number, tauMs = 3000): void {
  const a = 1 - Math.exp(-dtMs / tauMs);
  const lerp = (p: number, q: number) => p + (q - p) * a;
  base.hip.y = lerp(base.hip.y, body.hip.y);
  base.shoulder.y = lerp(base.shoulder.y, body.shoulder.y);
  base.nose.y = lerp(base.nose.y, body.nose.y);
  base.torso = lerp(base.torso, body.torso);
  base.shoulderWidth = lerp(base.shoulderWidth, body.shoulderWidth);
  if (body.kneeL && base.kneeRelL !== null) base.kneeRelL = lerp(base.kneeRelL, body.kneeL.y - body.hip.y);
  if (body.kneeR && base.kneeRelR !== null) base.kneeRelR = lerp(base.kneeRelR, body.kneeR.y - body.hip.y);
}
