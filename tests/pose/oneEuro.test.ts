import { describe, expect, it } from 'vitest';
import { OneEuroFilter, PoseSmoother } from '../../src/pose/oneEuro';
import { synthPose } from '../helpers/synth';

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('OneEuroFilter', () => {
  it('passes the first value through and holds a constant signal', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.5, 0)).toBe(0.5);
    for (let i = 1; i < 30; i++) expect(f.filter(0.5, i * 33)).toBeCloseTo(0.5, 9);
  });

  it('reduces jitter', () => {
    const f = new OneEuroFilter(1, 0);
    const input: number[] = [];
    const output: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = 0.5 + (i % 2 ? 0.01 : -0.01);
      input.push(x);
      output.push(f.filter(x, i * 33.3));
    }
    expect(std(output.slice(10))).toBeLessThan(std(input) * 0.5);
  });

  it('follows a fast step change when beta is high', () => {
    const f = new OneEuroFilter(3, 10);
    f.filter(0, 0);
    let y = 0;
    for (let t = 33; t <= 500; t += 33) y = f.filter(1, t);
    expect(y).toBeGreaterThan(0.9);
  });
});

describe('PoseSmoother', () => {
  it('smooths tracked landmarks and leaves the input untouched', () => {
    const s = new PoseSmoother();
    const a = synthPose();
    const b = synthPose({ hipY: 0.7 });
    s.smooth(a, 0);
    const out = s.smooth(b, 33);
    expect(out[24].y).toBeGreaterThan(0.6);
    expect(out[24].y).toBeLessThan(0.7);
    expect(b[24].y).toBeCloseTo(0.7, 9);
  });
});
