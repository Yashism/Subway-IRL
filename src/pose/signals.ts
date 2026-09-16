/** Keeps (t, v) samples that fall inside a trailing time window. */
export class TimeWindow {
  private s: { t: number; v: number }[] = [];

  constructor(private spanMs: number) {}

  push(t: number, v: number): void {
    this.s.push({ t, v });
    while (this.s.length && t - this.s[0].t > this.spanMs) this.s.shift();
  }

  clear(): void {
    this.s = [];
  }

  get size(): number {
    return this.s.length;
  }

  mean(): number {
    return this.s.length ? this.s.reduce((a, x) => a + x.v, 0) / this.s.length : Number.NaN;
  }

  max(): number {
    let m = -Infinity;
    for (const x of this.s) if (x.v > m) m = x.v;
    return m;
  }

  min(): number {
    let m = Infinity;
    for (const x of this.s) if (x.v < m) m = x.v;
    return m;
  }
}

/** Follows the up/down bounce of a height signal and reports one step per bounce cycle. */
export class BobTracker {
  private dir: 'up' | 'down' = 'up';
  private ext = Number.NaN;
  private extT = 0;
  private lastPeak = Number.NaN;
  private lastTroughT = -Infinity;
  private swings: number[] = [];

  reset(): void {
    this.dir = 'up';
    this.ext = Number.NaN;
    this.lastPeak = Number.NaN;
    this.lastTroughT = -Infinity;
    this.swings = [];
  }

  /** Typical bounce amplitude (half the peak-to-trough swing); 0 once bouncing has stopped. */
  amplitudeAt(t: number): number {
    if (!this.swings.length || t - this.lastTroughT > 1000) return 0;
    return this.swings.reduce((a, b) => a + b, 0) / this.swings.length / 2;
  }

  update(v: number, t: number, minAmp: number, maxGapMs: number, maxSwing: number): boolean {
    if (Number.isNaN(this.ext)) {
      this.ext = v;
      this.extT = t;
      return false;
    }
    if (this.dir === 'up') {
      if (v > this.ext) {
        this.ext = v;
        this.extT = t;
      } else if (v < this.ext - minAmp) {
        this.lastPeak = this.ext;
        this.dir = 'down';
        this.ext = v;
        this.extT = t;
      }
      return false;
    }
    if (v < this.ext) {
      this.ext = v;
      this.extT = t;
      return false;
    }
    if (v <= this.ext + minAmp) return false;

    const troughT = this.extT;
    const swing = this.lastPeak - this.ext;
    this.dir = 'up';
    this.ext = v;
    this.extT = t;
    if (swing < 2 * minAmp || swing > maxSwing) return false;
    const gap = troughT - this.lastTroughT;
    this.lastTroughT = troughT;
    if (gap > maxGapMs) {
      // Bouncing had stopped: don't let amplitudeAt revive the old swings.
      this.swings = [];
      return false;
    }
    this.swings.push(swing);
    if (this.swings.length > 4) this.swings.shift();
    return true;
  }
}

/** Fires when a height rises fast and far enough above its reference; re-arms after coming back down. */
export class JumpDetector {
  private armed = true;
  private prev: { t: number; v: number } | null = null;
  private vel = new TimeWindow(200);

  get isArmed(): boolean {
    return this.armed;
  }

  /** `armed = false` makes the detector wait for the body to come back down before it can fire. */
  reset(armed = true): void {
    this.armed = armed;
    this.prev = null;
    this.vel.clear();
  }

  update(v: number, ref: number, t: number, minVel: number, minRise: number, rearm: number): boolean {
    if (this.prev && t > this.prev.t) this.vel.push(t, (v - this.prev.v) / ((t - this.prev.t) / 1000));
    this.prev = { t, v };
    const rise = v - ref;
    if (!this.armed) {
      if (rise < rearm) this.armed = true;
      return false;
    }
    if (rise > minRise && this.vel.max() > minVel) {
      this.armed = false;
      return true;
    }
    return false;
  }
}

export interface DropThresholds {
  drop: number;
  holdMs: number;
  headDrop: number;
  rearmDrop: number;
  rearmHead: number;
}

/** Fires on a body drop held for holdMs, or immediately on a large head drop. */
export class DropDetector {
  private armed = true;
  private since: number | null = null;

  get isArmed(): boolean {
    return this.armed;
  }

  get isDropping(): boolean {
    return this.since !== null;
  }

  /** `armed = false` makes the detector wait for the player to stand back up before it can fire. */
  reset(armed = true): void {
    this.armed = armed;
    this.since = null;
  }

  update(drop: number, headDrop: number, t: number, th: DropThresholds): boolean {
    if (!this.armed) {
      if (drop < th.rearmDrop && headDrop < th.rearmHead) this.armed = true;
      return false;
    }
    if (headDrop > th.headDrop) return this.fire();
    if (drop > th.drop) {
      this.since ??= t;
      if (t - this.since >= th.holdMs) return this.fire();
    } else {
      this.since = null;
    }
    return false;
  }

  private fire(): true {
    this.armed = false;
    this.since = null;
    return true;
  }
}

/** Resting height: the calibrated value when still, the 1 s average while jogging. */
export class VerticalRef {
  private win = new TimeWindow(1000);

  reset(): void {
    this.win.clear();
  }

  value(v: number, t: number, staticRef: number, jogging: boolean, frozen: boolean): number {
    if (!frozen) this.win.push(t, v);
    return jogging && this.win.size > 0 ? this.win.mean() : staticRef;
  }
}
