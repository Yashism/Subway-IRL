import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const SMALL = { lowerVisible: false };
const S = 0.8 * T; // synthetic shoulder width
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

  it('keeps re-arming leans after the player drifts sideways', () => {
    // The player settles 0.3 S to the right: under the 0.35 S nose-shift trigger, but over the
    // 0.2 S re-arm limit, so with a fixed x reference no lean after the first could re-arm.
    // Standing still lets the x reference follow (tau 3 s): after the 300 ms step plus 4 s hold
    // the residual offset is about 0.3 * e^(-4.3/3) = 0.07 S. The held lean itself is not
    // absorbed (drift pauses while the lean is un-armed); back upright, |tilt| < 7 deg and
    // 0.07 S < 0.2 S re-arm it, so the second lean fires too.
    const right = { ...SMALL, hipX: STAND.hipX + 0.3 * S };
    const lean = (deg: number) => ({ ...right, tiltDeg: deg });
    const sc = calibrated()
      .add(300, (t) => ({ ...SMALL, hipX: STAND.hipX + 0.3 * S * ramp(t, 300) }))
      .hold(4000, right)
      .add(200, (t) => lean(20 * ramp(t, 200)))
      .hold(400, lean(20))
      .add(200, (t) => lean(20 * (1 - ramp(t, 200))))
      .hold(600, right)
      .add(200, (t) => lean(20 * ramp(t, 200)))
      .hold(400, lean(20));
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:1', 'shift:1']);
  });

  it('does not absorb a held head-shift lean into the baseline', () => {
    // A 0.5 S head shift held for 5 s must not drag the x reference along; otherwise coming
    // back to centre would read as -0.4 S (past the 0.2 S re-arm limit) and the next lean is lost.
    const at = (dx: number) => ({ ...SMALL, hipX: STAND.hipX + dx * S });
    const sc = calibrated()
      .add(200, (t) => at(0.5 * ramp(t, 200)))
      .hold(5000, at(0.5))
      .add(200, (t) => at(0.5 * (1 - ramp(t, 200))))
      .hold(600, at(0))
      .add(200, (t) => at(0.5 * ramp(t, 200)))
      .hold(400, at(0.5));
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:1', 'shift:1']);
  });

  it('detects a duck straight out of jogging', () => {
    const sc = calibrated()
      .add(3000, (t) => jogParams(t, { small: true }))
      .add(200, (t) => ({ ...SMALL, noseDrop: 0.5 * ramp(t, 200) }))
      .hold(400, { ...SMALL, noseDrop: 0.5 });
    expect(names(play(new PoseController(), sc.frames))).toEqual(['roll']);
  });
});
