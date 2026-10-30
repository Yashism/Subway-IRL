/**
 * Keeping the frame rate steady on a laptop GPU that is also running the pose model.
 *
 * Two small, independent pieces, both pure so they can be tested without a page:
 *
 * - `FrameLimiter` draws at most ~60 frames a second. The game steps on a fixed clock, so extra
 *   frames on a 120 Hz screen only repeat the same picture at twice the GPU cost — cost that comes
 *   straight out of the pose model's share of the same iGPU.
 * - `RenderScale` trades resolution for frame time. When frames run long for a second and a half it
 *   steps the render resolution down; when they have been comfortable for a while it tries a step
 *   back up, and backs off for longer each time that probe fails.
 */

export class FrameLimiter {
  private last = -Infinity;

  /** `minMs` between drawn frames; 0 draws every frame. */
  constructor(private minMs = 13) {}

  setMinMs(minMs: number): void {
    this.minMs = minMs;
  }

  /** True when this animation frame should be drawn. `now` is the rAF timestamp. */
  accept(now: number): boolean {
    if (this.minMs <= 0 || now < this.last || now - this.last >= this.minMs) {
      this.last = now;
      return true;
    }
    return false;
  }
}

/** The resolutions tried, as a fraction of the normal render size. */
export const RENDER_SCALES: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6];

export interface RenderScaleOptions {
  /** A smoothed frame time above this counts as running slow. */
  slowMs?: number;
  /** A smoothed frame time at or below this counts as comfortable. */
  calmMs?: number;
  /** How long it must run slow before stepping down. */
  slowForMs?: number;
  /** How long it must be comfortable before trying a step up. */
  probeMs?: number;
}

const MAX_PROBE_MS = 64_000;
/** A gap this long is a hidden tab or a page load, not a measure of the GPU. */
const STALL_MS = 1000;
/** The most one frame counts as slow evidence: a lone shader-compile hitch must not step the scale down. */
const MAX_EVIDENCE_MS = 100;
/** A step down this soon after a step up means the step up did not hold. */
const FAILED_PROBE_MS = 6000;

export class RenderScale {
  private index = 0;
  private ema = 0;
  private slowFor = 0;
  private calmFor = 0;
  private probeMs: number;
  private lastUp = -Infinity;
  private t = 0;
  private readonly slowMs: number;
  private readonly calmMs: number;
  private readonly slowForMs: number;
  private readonly baseProbeMs: number;

  constructor(o: RenderScaleOptions = {}) {
    this.slowMs = o.slowMs ?? 20.5;
    this.calmMs = o.calmMs ?? 17.8;
    this.slowForMs = o.slowForMs ?? 1500;
    this.baseProbeMs = this.probeMs = o.probeMs ?? 8000;
  }

  /** Back to full resolution with no history, as if just started. */
  reset(): void {
    this.index = 0;
    this.ema = 0;
    this.slowFor = 0;
    this.calmFor = 0;
    this.probeMs = this.baseProbeMs;
    this.lastUp = -Infinity;
  }

  get scale(): number {
    return RENDER_SCALES[this.index];
  }

  /**
   * Feeds one drawn frame's duration. Returns the new scale when it changed, otherwise null.
   * A gap over a second resets the evidence rather than counting as it: it says nothing about the GPU.
   */
  update(frameMs: number): number | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    if (frameMs > STALL_MS) {
      this.slowFor = 0;
      this.calmFor = 0;
      this.ema = 0;
      return null;
    }
    this.t += frameMs;
    this.ema = this.ema ? this.ema * 0.9 + frameMs * 0.1 : frameMs;

    if (this.ema > this.slowMs) {
      this.slowFor += Math.min(frameMs, MAX_EVIDENCE_MS);
      this.calmFor = 0;
      if (this.slowFor >= this.slowForMs && this.index < RENDER_SCALES.length - 1) {
        // A step up that did not hold: wait longer before the next try.
        if (this.t - this.lastUp < FAILED_PROBE_MS) this.probeMs = Math.min(this.probeMs * 2, MAX_PROBE_MS);
        this.index++;
        this.slowFor = 0;
        this.ema = 0;
        return this.scale;
      }
      return null;
    }

    this.slowFor = 0;
    if (this.ema <= this.calmMs && this.index > 0) {
      this.calmFor += frameMs;
      if (this.calmFor >= this.probeMs) {
        this.index--;
        this.calmFor = 0;
        this.lastUp = this.t;
        this.ema = 0;
        return this.scale;
      }
    } else {
      this.calmFor = 0;
    }
    return null;
  }
}
