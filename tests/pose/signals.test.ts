import { describe, expect, it } from 'vitest';
import { BobTracker, DropDetector, JumpDetector, TimeWindow, VerticalRef } from '../../src/pose/signals';

const DROP = { drop: 0.3, holdMs: 100, headDrop: 0.4, rearmDrop: 0.15, rearmHead: 0.2 };

describe('TimeWindow', () => {
  it('keeps only samples inside the span', () => {
    const w = new TimeWindow(100);
    w.push(0, 1);
    w.push(50, 3);
    w.push(120, 5);
    expect(w.size).toBe(2);
    expect(w.mean()).toBe(4);
    expect(w.max()).toBe(5);
    expect(w.min()).toBe(3);
  });

  it('reports sentinel values when empty', () => {
    const w = new TimeWindow(100);
    expect(w.mean()).toBeNaN();
    expect(w.max()).toBe(-Infinity);
  });
});

describe('BobTracker', () => {
  const run = (amp: number, ms: number) => {
    const b = new BobTracker();
    let steps = 0;
    for (let t = 0; t < ms; t += 1000 / 30) {
      if (b.update(-amp * Math.cos((2 * Math.PI * t) / 375), t, 0.03, 700)) steps++;
    }
    return { b, steps };
  };

  it('counts one step per bob cycle and measures amplitude', () => {
    const { b, steps } = run(0.05, 3000);
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(steps).toBeLessThanOrEqual(7);
    expect(b.amplitudeAt(3000)).toBeCloseTo(0.05, 2);
    expect(b.amplitudeAt(5000)).toBe(0);
  });

  it('ignores bobs that are too small or too large', () => {
    expect(run(0.02, 3000).steps).toBe(0);
    const big = run(0.3, 3000);
    expect(big.steps).toBe(0);
    expect(big.b.amplitudeAt(3000)).toBe(0);
  });
});

describe('JumpDetector', () => {
  it('fires once on a fast rise and re-arms after landing', () => {
    const j = new JumpDetector();
    const fire: number[] = [];
    const heights = [0, 0, 0.1, 0.25, 0.3, 0.25, 0.1, 0, 0, 0.1, 0.25, 0.3];
    heights.forEach((v, i) => {
      if (j.update(v, 0, i * 33, 1.5, 0.15, 0.08)) fire.push(i);
    });
    expect(fire).toEqual([3, 10]);
  });

  it('ignores slow rises', () => {
    const j = new JumpDetector();
    let fired = false;
    for (let i = 0; i < 60; i++) fired ||= j.update(i * 0.005, 0, i * 33, 1.5, 0.15, 0.08);
    expect(fired).toBe(false);
  });
});

describe('DropDetector', () => {
  it('needs the drop held for holdMs and fires once', () => {
    const d = new DropDetector();
    expect(d.update(0.4, 0, 0, DROP)).toBe(false);
    expect(d.isDropping).toBe(true);
    expect(d.update(0.4, 0, 60, DROP)).toBe(false);
    expect(d.update(0.4, 0, 110, DROP)).toBe(true);
    expect(d.update(0.4, 0, 200, DROP)).toBe(false);
    expect(d.update(0, 0, 300, DROP)).toBe(false);
    expect(d.isArmed).toBe(true);
  });

  it('cancels a short dip', () => {
    const d = new DropDetector();
    d.update(0.4, 0, 0, DROP);
    d.update(0.1, 0, 50, DROP);
    expect(d.update(0.4, 0, 120, DROP)).toBe(false);
  });

  it('fires immediately on a head drop', () => {
    expect(new DropDetector().update(0, 0.5, 0, DROP)).toBe(true);
  });
});

describe('VerticalRef', () => {
  it('uses the static reference unless jogging', () => {
    const r = new VerticalRef();
    expect(r.value(1, 0, 5, false, false)).toBe(5);
    r.value(3, 10, 5, false, false);
    expect(r.value(2, 20, 5, true, false)).toBe(2);
    expect(r.value(100, 30, 5, true, true)).toBe(2);
  });
});
