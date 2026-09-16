import { describe, expect, it } from 'vitest';
import { JogDetector } from '../../src/pose/jog';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, jogParams, synthPose, type JogOptions, type SynthParams } from '../helpers/synth';

function jog(opts: JogOptions, ms: number, calib: Partial<SynthParams> = {}) {
  const base = baselineFor(calib);
  const d = new JogDetector(DEFAULT_THRESHOLDS);
  for (let t = 0; t < ms; t += 1000 / 30) d.update(toBody(synthPose(jogParams(t, opts)), ASPECT), base, t, 1);
  return d;
}

describe('JogDetector', () => {
  it('counts alternating knee lifts at the right cadence', () => {
    const s = jog({}, 5000).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(12);
    expect(s.steps).toBeLessThanOrEqual(15);
    expect(s.cadenceSpm).toBeGreaterThan(145);
    expect(s.cadenceSpm).toBeLessThan(175);
    expect(s.active).toBe(true);
  });

  it('goes inactive a second after the last step', () => {
    const s = jog({}, 5000).status(6200);
    expect(s.active).toBe(false);
    expect(s.msSinceStep).toBeGreaterThan(1000);
    expect(s.cadenceSpm).toBe(0);
  });

  it('counts only one step when the same knee lifts repeatedly', () => {
    const base = baselineFor();
    const d = new JogDetector(DEFAULT_THRESHOLDS);
    for (let t = 0; t < 3000; t += 1000 / 30) {
      const lift = Math.max(0, Math.sin((2 * Math.PI * t) / 375)) * 0.35;
      d.update(toBody(synthPose({ kneeLiftL: lift }), ASPECT), base, t, 1);
    }
    expect(d.status(3000).steps).toBe(1);
  });

  it('falls back to the hip bob when knees are hidden', () => {
    const s = jog({ bob: 0.06, base: { lowerVisible: false } }, 5000).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(10);
  });

  it('counts arm pumping in small-room mode', () => {
    const s = jog({ small: true, bob: 0 }, 5000, { lowerVisible: false }).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(12);
    expect(s.steps).toBeLessThanOrEqual(15);
  });

  it('counts the shoulder bob in small-room mode with arms down', () => {
    const s = jog({ small: true, arms: 'down', bob: 0.08 }, 5000, { lowerVisible: false }).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(10);
  });

  it('reports nothing before the first step', () => {
    const s = new JogDetector(DEFAULT_THRESHOLDS).status(1000);
    expect(s).toEqual({ active: false, cadenceSpm: 0, msSinceStep: Infinity, steps: 0 });
  });
});
