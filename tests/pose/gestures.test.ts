import { describe, expect, it } from 'vitest';
import { GestureDetector } from '../../src/pose/gestures';
import { LM, toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PoseEvent } from '../../src/pose/types';
import { ASPECT, synthPose, type SynthParams } from '../helpers/synth';

function run(g: GestureDetector, from: number, to: number, arms: SynthParams['arms']) {
  const out: PoseEvent[] = [];
  for (let t = from; t < to; t += 1000 / 30) out.push(...g.update(toBody(synthPose({ arms }), ASPECT), t));
  return out.map((e) => e.type);
}

describe('GestureDetector', () => {
  it('fires hoverboard once per raise of both hands', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    expect(run(g, 0, 1000, 'both-up')).toEqual(['hoverboard']);
    expect(run(g, 1000, 1300, 'down')).toEqual([]);
    expect(run(g, 1300, 1800, 'both-up')).toEqual(['hoverboard']);
  });

  it('ignores a quick raise of both hands', () => {
    expect(run(new GestureDetector(DEFAULT_THRESHOLDS), 0, 200, 'both-up')).toEqual([]);
  });

  it('fires start after holding the right hand up, with progress', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    run(g, 0, 750, 'right-up');
    expect(g.startProgress).toBeGreaterThan(0.4);
    expect(g.startProgress).toBeLessThan(0.6);
    expect(run(g, 750, 1700, 'right-up')).toEqual(['start']);
    expect(run(g, 1700, 3500, 'right-up')).toEqual([]);
  });

  it('resets start progress when the hand drops early', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    run(g, 0, 500, 'right-up');
    run(g, 500, 550, 'down');
    expect(g.startProgress).toBe(0);
  });

  it('ignores a raised right wrist that the model cannot see', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    const pose = synthPose({ arms: 'right-up' });
    pose[LM.R_WRIST] = { ...pose[LM.R_WRIST], visibility: 0.1 };
    const out: PoseEvent[] = [];
    for (let t = 0; t < 2000; t += 1000 / 30) out.push(...g.update(toBody(pose, ASPECT), t));
    expect(out).toEqual([]);
    expect(g.startProgress).toBe(0);
  });

  it('does not start while both hands are up', () => {
    expect(run(new GestureDetector(DEFAULT_THRESHOLDS), 0, 2000, 'both-up')).toEqual(['hoverboard']);
  });
});
