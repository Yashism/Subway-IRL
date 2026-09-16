import { describe, expect, it } from 'vitest';
import { Calibrator, driftBaseline, type Baseline } from '../../src/pose/calibration';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PlayMode } from '../../src/pose/types';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, STAND, synthPose, type SynthParams } from '../helpers/synth';

function feed(cal: Calibrator, fromMs: number, toMs: number, p: Partial<SynthParams>, mode: PlayMode | null = null) {
  let out: Baseline | null = null;
  for (let t = fromMs; t < toMs; t += 1000 / 30) out = cal.update(toBody(synthPose(p), ASPECT), t, mode) ?? out;
  return out;
}

describe('Calibrator', () => {
  it('needs 2 s of standing still', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 1900, {})).toBeNull();
    expect(cal.state.progress).toBeGreaterThan(0.9);
    const base = feed(cal, 1900, 2100, {});
    expect(base).not.toBeNull();
    expect(base!.mode).toBe('full');
    expect(base!.torso).toBeCloseTo(0.25, 3);
    expect(base!.hip.y).toBeCloseTo(0.6, 3);
    expect(base!.kneeRelL).toBeCloseTo(0.225, 3);
  });

  it('restarts the timer when the player moves', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    feed(cal, 0, 1000, {});
    expect(feed(cal, 1000, 2500, { hipX: STAND.hipX + 0.1 })).toBeNull();
  });

  it('picks small-room mode when the lower body is hidden', () => {
    const base = baselineFor({ lowerVisible: false });
    expect(base.mode).toBe('small');
    expect(base.kneeRelL).toBeNull();
  });

  it('respects a forced mode', () => {
    expect(baselineFor({}, 'small').mode).toBe('small');
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 2500, { lowerVisible: false }, 'full')).toBeNull();
    expect(cal.state.distance).toBe('back');
  });

  it('asks a far-away player to come closer', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 2500, { torso: 0.08 })).toBeNull();
    expect(cal.state.distance).toBe('closer');
  });

  it('resets progress when the body disappears', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    feed(cal, 0, 1000, {});
    cal.update(null, 1033, null);
    expect(cal.state).toEqual({ progress: 0, bodyVisible: false, distance: 'ok' });
  });
});

describe('driftBaseline', () => {
  it('eases vertical values toward the current body but never x', () => {
    const base = baselineFor();
    const body = toBody(synthPose({ hipY: 0.62, hipX: STAND.hipX + 0.05 }), ASPECT);
    for (let i = 0; i < 90; i++) driftBaseline(base, body, 1000 / 30);
    expect(base.hip.y).toBeGreaterThan(0.61);
    expect(base.hip.y).toBeLessThan(0.62);
    expect(base.hip.x).toBeCloseTo(STAND.hipX, 6);
  });

  it('also follows x when asked (small-room mode)', () => {
    const base = baselineFor({ lowerVisible: false });
    const body = toBody(synthPose({ lowerVisible: false, hipX: STAND.hipX + 0.05 }), ASPECT);
    for (let i = 0; i < 90; i++) driftBaseline(base, body, 1000 / 30, 3000, true);
    const eased = 0.05 * (1 - Math.exp(-1));
    expect(base.hip.x - STAND.hipX).toBeCloseTo(eased, 3);
    expect(base.shoulder.x - STAND.hipX).toBeCloseTo(eased, 3);
    expect(base.nose.x - STAND.hipX).toBeCloseTo(eased, 3);
  });
});
