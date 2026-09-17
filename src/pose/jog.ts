import type { Baseline } from './calibration';
import type { Body } from './landmarks';
import { BobTracker } from './signals';
import type { Thresholds } from './thresholds';
import type { JogStatus, MoveMagnitudes } from './types';

const MIN_STEP_GAP_MS = 180;
const FALLBACK_AFTER_MS = 1000;
const ACTIVE_MS = 1000;

/** Detects jogging in place and reports steps, cadence and time since the last step. */
export class JogDetector {
  readonly bob = new BobTracker();
  private total = 0;
  private stepTimes: number[] = [];
  private lastStepT = -Infinity;
  private lastPrimaryT = -Infinity;
  private kneeUp = { L: false, R: false };
  private lastKnee: 'L' | 'R' | null = null;
  private wristSide: -1 | 0 | 1 = 0;
  private wristSideT = -Infinity;
  /** Last frame's primary jog signal, in its threshold's units: knee lift, or |wrist offset|. */
  private primaryMag = 0;

  /** `mag` is the controller's shared magnitude readout; the detector fills its jog fields. */
  constructor(private th: Thresholds, private mag: MoveMagnitudes | null = null) {}

  reset(): void {
    this.bob.reset();
    this.total = 0;
    if (this.mag) {
      this.mag.jogPrimary = 0;
      this.mag.bobAmp = 0;
      this.mag.jogSteps = 0;
    }
    this.stepTimes = [];
    this.lastStepT = -Infinity;
    this.lastPrimaryT = -Infinity;
    this.kneeUp = { L: false, R: false };
    this.lastKnee = null;
    this.wristSide = 0;
    this.wristSideT = -Infinity;
  }

  update(body: Body, base: Baseline, t: number, sens: number): boolean {
    const full = base.mode === 'full';
    const unit = full ? base.torso : base.shoulderWidth;
    const height = -(full ? body.hip.y : body.shoulder.y) / unit;
    const bobStep = this.bob.update(height, t, this.th.bobMinAmp / sens, this.th.bobMaxStepGapMs, this.th.bobMaxSwing);
    const primary = full ? this.kneeStep(body, base, sens) : this.wristStep(body, base, t, sens);
    if (this.mag) {
      this.mag.jogPrimary = this.primaryMag;
      this.mag.bobAmp = this.bob.amplitudeAt(t);
    }
    if (primary) {
      this.lastPrimaryT = t;
      return this.step(t);
    }
    if (bobStep && t - this.lastPrimaryT > FALLBACK_AFTER_MS) return this.step(t);
    return false;
  }

  /** `addStep`, keeping the shared magnitude readout's step count in sync. */
  private step(t: number): boolean {
    const counted = this.addStep(t);
    if (counted && this.mag) this.mag.jogSteps = this.total;
    return counted;
  }

  status(t: number): JogStatus {
    const ms = t - this.lastStepT;
    const n = this.stepTimes.length;
    const cadence = n >= 2 ? ((n - 1) / (this.stepTimes[n - 1] - this.stepTimes[0])) * 60000 : 0;
    return {
      active: ms < ACTIVE_MS,
      cadenceSpm: ms < ACTIVE_MS ? Math.round(cadence) : 0,
      msSinceStep: ms,
      steps: this.total,
    };
  }

  private addStep(t: number): boolean {
    if (t - this.lastStepT < MIN_STEP_GAP_MS) return false;
    this.lastStepT = t;
    this.total++;
    this.stepTimes.push(t);
    while (this.stepTimes.length && t - this.stepTimes[0] > 3000) this.stepTimes.shift();
    return true;
  }

  private kneeStep(body: Body, base: Baseline, sens: number): boolean {
    let stepped = false;
    this.primaryMag = 0;
    for (const side of ['L', 'R'] as const) {
      const knee = side === 'L' ? body.kneeL : body.kneeR;
      const rest = side === 'L' ? base.kneeRelL : base.kneeRelR;
      if (!knee || rest === null) {
        this.kneeUp[side] = false;
        continue;
      }
      const lift = (rest - (knee.y - body.hip.y)) / base.torso;
      if (lift > this.primaryMag) this.primaryMag = lift;
      if (!this.kneeUp[side] && lift > this.th.kneeLift / sens) {
        this.kneeUp[side] = true;
        if (this.lastKnee !== side) {
          this.lastKnee = side;
          stepped = true;
        }
      } else if (this.kneeUp[side] && lift < this.th.kneeRelease / sens) {
        this.kneeUp[side] = false;
      }
    }
    return stepped;
  }

  private wristStep(body: Body, base: Baseline, t: number, sens: number): boolean {
    const d = (body.wristL.y - body.wristR.y) / base.shoulderWidth;
    this.primaryMag = Math.abs(d);
    const a = this.th.wristPump / sens;
    const side = d > a ? 1 : d < -a ? -1 : 0;
    if (side === 0 || side === this.wristSide) return false;
    const counted = this.wristSide !== 0 && t - this.wristSideT <= 1000;
    this.wristSide = side;
    this.wristSideT = t;
    return counted;
  }
}
