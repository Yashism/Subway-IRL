import { describe, expect, it } from 'vitest';
import { laneX, TUNING } from '../../src/game/config';
import { minGapAt, speedAt, speedFraction, tierFor, topSpeed } from '../../src/game/speed';

describe('speed curve', () => {
  it('starts at 12 m/s and reaches top speed after the ramp', () => {
    expect(speedAt(0, 'cardio')).toBe(12);
    expect(speedAt(240, 'cardio')).toBeCloseTo(30, 6);
    expect(speedAt(400, 'cardio')).toBeCloseTo(30, 6);
    expect(topSpeed('chill')).toBeCloseTo(24, 6);
    expect(topSpeed('beast')).toBeCloseTo(36, 6);
    expect(speedAt(200, 'beast')).toBeCloseTo(36, 6);
  });

  it('never slows down', () => {
    let prev = 0;
    for (let t = 0; t <= 300; t += 5) {
      const v = speedAt(t, 'cardio');
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('tightens the minimum action gap from 1.2 s to 0.8 s', () => {
    expect(minGapAt(12, 'cardio')).toBeCloseTo(1.2, 6);
    expect(minGapAt(30, 'cardio')).toBeCloseTo(0.8, 6);
    expect(minGapAt(21, 'cardio')).toBeCloseTo(1.0, 6);
    expect(speedFraction(50, 'cardio')).toBe(1);
  });

  it('uses warm-up for the first 20 s, then tiers by speed', () => {
    expect(tierFor(0, 'cardio')).toBe(0);
    expect(tierFor(19.9, 'cardio')).toBe(0);
    expect(tierFor(20, 'cardio')).toBe(1);
    expect(tierFor(240, 'cardio')).toBe(4);
    const tiers = Array.from({ length: 241 }, (_, t) => tierFor(t, 'cardio'));
    expect(tiers.every((x, i) => i === 0 || x >= tiers[i - 1])).toBe(true);
  });

  it('places lanes 2.5 m apart', () => {
    expect(laneX(-1)).toBe(-2.5);
    expect(laneX(1)).toBe(2.5);
    expect(TUNING.stepHz).toBe(60);
  });
});
