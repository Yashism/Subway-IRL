import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const SMALL = { lowerVisible: false };
const calibrated = () => new Scenario().hold(2500, SMALL);

describe('PoseController — small-room mode', () => {
  it('calibrates in small-room mode when knees are hidden', () => {
    const ctrl = new PoseController();
    play(ctrl, calibrated().frames);
    expect(ctrl.status.mode).toBe('small');
  });

  it('turns leans into lane shifts', () => {
    const sc = calibrated()
      .add(200, (t) => ({ ...SMALL, tiltDeg: -20 * ramp(t, 200) }))
      .hold(600, { ...SMALL, tiltDeg: -20 })
      .add(200, (t) => ({ ...SMALL, tiltDeg: -20 * (1 - ramp(t, 200)) }))
      .hold(400, SMALL)
      .add(200, (t) => ({ ...SMALL, tiltDeg: 20 * ramp(t, 200) }))
      .hold(400, { ...SMALL, tiltDeg: 20 });
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:-1', 'shift:1']);
  });

  it('detects a shoulder hop and a duck', () => {
    const sc = calibrated()
      .add(400, (t) => ({ ...SMALL, hipY: STAND.hipY - jumpArc(t, 400, 0.25) * T }))
      .hold(800, SMALL)
      .add(200, (t) => ({ ...SMALL, noseDrop: 0.5 * ramp(t, 200) }))
      .hold(400, { ...SMALL, noseDrop: 0.5 });
    expect(names(play(new PoseController(), sc.frames))).toEqual(['jump', 'roll']);
  });

  it('counts arm pumping as jogging without other moves', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t, { small: true, bob: 0 }));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(12);
    expect(ctrl.status.jog.steps).toBeLessThanOrEqual(15);
  });

  it('counts a shoulder bob as jogging without jumping', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t, { small: true, arms: 'down', bob: 0.08 }));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(10);
  });
});
