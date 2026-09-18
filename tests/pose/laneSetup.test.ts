import { describe, expect, it } from 'vitest';
import {
  HINT_LOST,
  LaneSetup,
  SPOT_ADVANCE_MS,
  SPOT_HINT_MS,
  SPOT_HOLD_MS,
  SPOT_STEADY,
} from '../../src/pose/laneSetup';
import { MIN_SPOT_GAP } from '../../src/pose/laneSpots';

const FRAME = 1000 / 30;

/** Drives the setup at 30 Hz; `at(t)` is the offset `t` ms into this segment (null = not in view). */
class Rig {
  readonly setup = new LaneSetup();
  t = 0;
  feed(ms: number, at: number | null | ((t: number) => number | null)): this {
    const t0 = this.t;
    const end = this.t + ms;
    while (this.t < end - 1e-9) {
      const x = typeof at === 'function' ? at(this.t - t0) : at;
      this.setup.update(x, this.t);
      this.t += FRAME;
    }
    return this;
  }
  get m() {
    return this.setup.model;
  }
  /** Holds `x` long enough to take it and moves past the ✓. */
  take(x: number): this {
    return this.feed(SPOT_HOLD_MS + FRAME * 2, x).feed(SPOT_ADVANCE_MS + FRAME, x);
  }
}

describe('LaneSetup: taking a spot', () => {
  it('starts on the centre spot with nothing taken', () => {
    const m = new LaneSetup().model;
    expect(m.step).toBe('centre');
    expect(m.index).toBe(0);
    expect(m.spots).toEqual({ centre: null, left: null, right: null });
    expect(m.how).toBe('Stand where you want the centre lane');
    expect(m.result).toBeNull();
  });

  it('takes a spot after a 1 s hold, not before', () => {
    const r = new Rig().feed(SPOT_HOLD_MS - FRAME * 2, 0.1);
    expect(r.m.spots.centre).toBeNull();
    expect(r.m.hold).toBeGreaterThan(0.85);
    expect(r.m.hold).toBeLessThan(1);
    r.feed(FRAME * 3, 0.1);
    expect(r.m.spots.centre).toBeCloseTo(0.1, 9);
    expect(r.m.taken).toBe(true);
    expect(r.m.hold).toBe(1);
  });

  it('the hold ring fills in proportion to the time held', () => {
    const r = new Rig().feed(FRAME * 16, 0);
    expect(r.m.hold).toBeCloseTo((15 * FRAME) / SPOT_HOLD_MS, 6);
  });

  it('takes the mean of the hold, not the last frame', () => {
    const r = new Rig().feed(SPOT_HOLD_MS + FRAME * 2, (t) => (Math.floor(t / FRAME) % 2 ? 0.04 : 0));
    expect(r.m.spots.centre).toBeGreaterThan(0.015);
    expect(r.m.spots.centre).toBeLessThan(0.025);
  });

  it('shows the ✓ for a moment, then asks for the next spot', () => {
    const r = new Rig().feed(SPOT_HOLD_MS + FRAME * 2, 0);
    expect(r.m.step).toBe('centre');
    r.feed(SPOT_ADVANCE_MS - FRAME * 3, 0);
    expect(r.m.taken).toBe(true);
    r.feed(FRAME * 4, 0);
    expect(r.m.step).toBe('left');
    expect(r.m.taken).toBe(false);
    expect(r.m.hold).toBe(0);
    expect(r.m.how).toBe('Step to where you want the left lane');
  });
});

describe('LaneSetup: steadiness', () => {
  it('moving outside the band restarts the hold', () => {
    const r = new Rig().feed(SPOT_HOLD_MS * 0.8, 0);
    expect(r.m.hold).toBeGreaterThan(0.7);
    r.feed(FRAME, SPOT_STEADY * 1.5);
    expect(r.m.hold).toBe(0);
    r.feed(SPOT_HOLD_MS * 0.8, SPOT_STEADY * 1.5);
    expect(r.m.spots.centre).toBeNull();
    r.feed(SPOT_HOLD_MS * 0.3, SPOT_STEADY * 1.5);
    expect(r.m.spots.centre).toBeCloseTo(SPOT_STEADY * 1.5, 9);
  });

  it('a sway that never settles never takes a spot', () => {
    const r = new Rig().feed(5000, (t) => 0.3 * Math.sin((2 * Math.PI * t) / 700));
    expect(r.m.spots.centre).toBeNull();
    expect(r.m.step).toBe('centre');
  });

  it('small jitter inside the band still counts as holding still', () => {
    const r = new Rig().feed(SPOT_HOLD_MS + FRAME * 2, (t) => 0.2 + (SPOT_STEADY * 0.8) * Math.sin(t / 50));
    expect(r.m.spots.centre).not.toBeNull();
  });

  it('losing the player resets the hold and says so', () => {
    const r = new Rig().feed(SPOT_HOLD_MS * 0.8, 0);
    r.feed(FRAME, null);
    expect(r.m.hold).toBe(0);
    expect(r.m.live).toBeNull();
    expect(r.m.hint).toBe(HINT_LOST);
    r.feed(SPOT_HOLD_MS * 0.5, 0);
    expect(r.m.spots.centre).toBeNull();
    expect(r.m.hint).toBeNull();
  });

  it('a non-finite offset counts as nobody in view', () => {
    const r = new Rig().feed(SPOT_HOLD_MS * 0.5, 0);
    r.feed(FRAME, Number.NaN);
    expect(r.m.live).toBeNull();
    expect(r.m.hold).toBe(0);
  });
});

describe('LaneSetup: side spots', () => {
  it('refuses a left spot on the wrong side, saying step further left', () => {
    const r = new Rig().take(0).feed(SPOT_HOLD_MS * 2, 0.5);
    expect(r.m.step).toBe('left');
    expect(r.m.spots.left).toBeNull();
    expect(r.m.blocked).toBe('wrongSide');
    expect(r.m.hint).toBe('Step further left');
    expect(r.m.hold).toBe(0);
  });

  it('refuses a left spot too close to the centre spot', () => {
    const r = new Rig().take(0.1).feed(SPOT_HOLD_MS * 2, 0.1 - (MIN_SPOT_GAP - 0.02));
    expect(r.m.spots.left).toBeNull();
    expect(r.m.blocked).toBe('tooClose');
    expect(r.m.hint).toBe('Step further left');
  });

  it('refuses a right spot too close, or on the wrong side', () => {
    const close = new Rig().take(0).take(-0.6).feed(SPOT_HOLD_MS * 2, MIN_SPOT_GAP - 0.02);
    expect(close.m.step).toBe('right');
    expect(close.m.blocked).toBe('tooClose');
    expect(close.m.hint).toBe('Step further right');
    const wrong = new Rig().take(0).take(-0.6).feed(SPOT_HOLD_MS * 2, -0.3);
    expect(wrong.m.blocked).toBe('wrongSide');
    expect(wrong.m.hint).toBe('Step further right');
    expect(wrong.m.spots.right).toBeNull();
  });

  it('the hint waits until the player has stopped, rather than flashing mid-step', () => {
    const r = new Rig().take(0).feed(SPOT_HINT_MS - FRAME * 2, -0.05);
    expect(r.m.blocked).toBe('tooClose');
    expect(r.m.hint).toBeNull();
    r.feed(FRAME * 3, -0.05);
    expect(r.m.hint).toBe('Step further left');
  });

  it('takes a side spot exactly at the minimum gap', () => {
    const r = new Rig().take(0).take(-MIN_SPOT_GAP);
    expect(r.m.spots.left).toBeCloseTo(-MIN_SPOT_GAP, 9);
    expect(r.m.step).toBe('right');
  });

  it('stepping on from a refused spot to a good one takes the good one', () => {
    const r = new Rig().take(0).feed(SPOT_HOLD_MS * 2, -0.1);
    expect(r.m.hint).toBe('Step further left');
    r.take(-0.7);
    expect(r.m.spots.left).toBeCloseTo(-0.7, 9);
    expect(r.m.hint).toBeNull();
  });

  it('refuses a spot beyond any real room', () => {
    const r = new Rig().feed(SPOT_HOLD_MS * 2, 9);
    expect(r.m.blocked).toBe('tooFar');
    expect(r.m.spots.centre).toBeNull();
  });
});

describe('LaneSetup: order, result and redo', () => {
  it('goes centre → left → right and ends with all three', () => {
    const r = new Rig();
    expect(r.m.step).toBe('centre');
    r.take(0.05);
    expect(r.m.step).toBe('left');
    r.take(-0.62);
    expect(r.m.step).toBe('right');
    r.take(0.6);
    expect(r.m.step).toBeNull();
    expect(r.m.index).toBe(3);
    expect(r.setup.finished).toBe(true);
    expect(r.m.result!.centre).toBeCloseTo(0.05, 9);
    expect(r.m.result!.left).toBeCloseTo(-0.62, 9);
    expect(r.m.result!.right).toBeCloseTo(0.6, 9);
  });

  it('a spot the player stands on first never counts for a later step', () => {
    // Standing on the right spot during the left step is the wrong side, not a left spot.
    const r = new Rig().take(0).feed(SPOT_HOLD_MS * 3, 0.6);
    expect(r.m.step).toBe('left');
    expect(r.m.spots.right).toBeNull();
  });

  it('once finished, frames only move the live marker', () => {
    const r = new Rig().take(0).take(-0.6).take(0.6);
    const result = r.m.result;
    r.feed(SPOT_HOLD_MS * 2, 0.1);
    expect(r.m.result).toBe(result);
    expect(r.m.live).toBeCloseTo(0.1, 9);
  });

  it('redo forgets every spot and starts again from the centre', () => {
    const r = new Rig().take(0).take(-0.6).take(0.6);
    r.setup.redo();
    expect(r.m.step).toBe('centre');
    expect(r.m.index).toBe(0);
    expect(r.m.spots).toEqual({ centre: null, left: null, right: null });
    expect(r.m.result).toBeNull();
    expect(r.setup.finished).toBe(false);
    r.take(0.2).take(-0.4).take(0.9);
    expect(r.m.result!.centre).toBeCloseTo(0.2, 9);
  });

  it('redo mid-step drops a half-held spot too', () => {
    const r = new Rig().take(0).feed(SPOT_HOLD_MS * 0.8, -0.6);
    r.setup.redo();
    r.feed(FRAME, -0.6);
    expect(r.m.step).toBe('centre');
    expect(r.m.hold).toBe(0);
  });

  it('the model is the same object every frame', () => {
    const r = new Rig();
    const m = r.m;
    r.take(0).take(-0.6);
    expect(r.m).toBe(m);
  });
});
