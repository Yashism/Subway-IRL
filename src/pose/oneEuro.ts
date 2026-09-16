import { TRACKED_INDICES } from './landmarks';
import type { Pose } from './types';

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

/** One Euro filter (Casiez et al.): low lag on fast motion, strong smoothing when still. */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1,
    private beta = 0,
    private dCutoff = 1,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const dxHat = alpha(this.dCutoff, dt) * dx + (1 - alpha(this.dCutoff, dt)) * this.dxPrev;
    const a = alpha(this.minCutoff + this.beta * Math.abs(dxHat), dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/** Applies a One Euro filter to x and y of every landmark the detectors use. */
export class PoseSmoother {
  private filters = new Map<number, [OneEuroFilter, OneEuroFilter]>();

  constructor(
    private minCutoff = 3,
    private beta = 10,
  ) {}

  reset(): void {
    this.filters.clear();
  }

  smooth(pose: Pose, tMs: number): Pose {
    const out = pose.map((l) => ({ ...l }));
    for (const i of TRACKED_INDICES) {
      let f = this.filters.get(i);
      if (!f) {
        f = [new OneEuroFilter(this.minCutoff, this.beta), new OneEuroFilter(this.minCutoff, this.beta)];
        this.filters.set(i, f);
      }
      out[i].x = f[0].filter(pose[i].x, tMs);
      out[i].y = f[1].filter(pose[i].y, tMs);
    }
    return out;
  }
}
