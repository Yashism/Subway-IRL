import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const calibrated = () => new Scenario().hold(2500);
const at = (dx: number) => ({ hipX: STAND.hipX + dx * T });
const events = (sc: Scenario) => names(play(new PoseController(), sc.frames));

describe('PoseController — full-body mode', () => {
  it('calibrates after 2 s of standing', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(1800).frames);
    expect(ctrl.status.calibrated).toBe(false);
    const done = new PoseController();
    play(done, calibrated().frames);
    expect(done.status.calibrated).toBe(true);
    expect(done.status.mode).toBe('full');
  });

  it('maps standing position to lanes', () => {
    const sc = calibrated()
      .add(300, (t) => at(0.8 * ramp(t, 300)))
      .hold(700, at(0.8))
      .add(300, (t) => at(0.8 * (1 - ramp(t, 300))))
      .hold(700)
      .add(300, (t) => at(-0.8 * ramp(t, 300)))
      .hold(700, at(-0.8));
    expect(events(sc)).toEqual(['lane:1', 'lane:0', 'lane:-1']);
  });

  it('does not flicker near a lane boundary', () => {
    const sc = calibrated()
      .add(300, (t) => at(0.8 * ramp(t, 300)))
      .add(2000, (t) => at(0.5 + 0.1 * Math.sin(t / 100)));
    expect(events(sc)).toEqual(['lane:1']);
  });

  it('detects a jump', () => {
    const sc = calibrated()
      .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
      .hold(1000);
    expect(events(sc)).toEqual(['jump']);
  });

  it('detects two separate squats', () => {
    const down = (t: number) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) });
    const up = (t: number) => ({ hipY: STAND.hipY + 0.45 * T * (1 - ramp(t, 200)) });
    const sc = calibrated()
      .add(200, down).hold(600, down(200)).add(200, up).hold(800)
      .add(200, down).hold(600, down(200));
    expect(events(sc)).toEqual(['roll', 'roll']);
  });

  it('treats a pre-jump dip as part of the jump', () => {
    const sc = calibrated()
      .add(150, (t) => ({ hipY: STAND.hipY + 0.2 * T * Math.sin((Math.PI * t) / 150) }))
      .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
      .hold(800);
    expect(events(sc)).toEqual(['jump']);
  });

  it('detects a head duck as a roll', () => {
    const sc = calibrated()
      .add(200, (t) => ({ noseDrop: 0.5 * ramp(t, 200) }))
      .hold(400, { noseDrop: 0.5 });
    expect(events(sc)).toEqual(['roll']);
  });

  it('tracks jogging without triggering moves, then notices stopping', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    const jog = ctrl.status.jog;
    expect(jog.active).toBe(true);
    expect(jog.steps).toBeGreaterThanOrEqual(12);
    expect(jog.steps).toBeLessThanOrEqual(15);
    expect(jog.cadenceSpm).toBeGreaterThan(145);
    expect(jog.cadenceSpm).toBeLessThan(175);

    const from = sc.frames.length;
    sc.hold(1500);
    play(ctrl, sc.frames.slice(from));
    expect(ctrl.status.jog.active).toBe(false);
    expect(ctrl.status.jog.msSinceStep).toBeGreaterThan(1000);
  });

  it('detects a jump in the middle of jogging', () => {
    const sc = calibrated()
      .add(3000, (t) => jogParams(t))
      .add(500, (t) => {
        const j = jogParams(3000 + t);
        return { ...j, hipY: j.hipY - jumpArc(t, 500, 0.4) * T };
      })
      .add(2000, (t) => jogParams(3500 + t));
    expect(events(sc)).toEqual(['jump']);
  });

  it('keeps following the calibrated player when someone else walks in', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(1500, () => [{}, { hipX: STAND.hipX + 0.5, torso: 0.3 }]);
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.lane).toBe(0);
  });

  it('detects a squat straight out of jogging', () => {
    const sc = calibrated()
      .add(3000, (t) => jogParams(t))
      .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) }))
      .hold(600, { hipY: STAND.hipY + 0.45 * T });
    expect(events(sc)).toEqual(['roll']);
  });

  it('scales the lane step with sensitivity', () => {
    const sc = calibrated()
      .add(300, (t) => at(0.45 * ramp(t, 300)))
      .hold(700, at(0.45));
    expect(names(play(new PoseController(), sc.frames))).toEqual([]);
    expect(names(play(new PoseController({ sensitivity: 1.25 }), sc.frames))).toEqual(['lane:1']);
  });

  it('does not roll when the player returns from a tracking gap already crouched', () => {
    const squat = { hipY: STAND.hipY + 0.45 * T };
    const sc = calibrated()
      .add(1500, () => null)
      .hold(600, squat)
      .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * (1 - ramp(t, 200)) }))
      .hold(800)
      .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) }))
      .hold(600, squat);
    expect(events(sc)).toEqual(['lost', 'found', 'roll']);
  });

  it('keeps the lane and baseline across a tracking gap', () => {
    const ctrl = new PoseController();
    const sc = calibrated()
      .add(300, (t) => at(0.8 * ramp(t, 300)))
      .hold(500, at(0.8))
      .add(1500, () => null)
      .hold(500, at(0.8));
    expect(names(play(ctrl, sc.frames))).toEqual(['lane:1', 'lost', 'found']);
    expect(ctrl.status.calibrated).toBe(true);
    expect(ctrl.status.lane).toBe(1);
  });
});
