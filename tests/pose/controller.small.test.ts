import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND, type SynthParams } from '../helpers/synth';

const T = STAND.torso;
const SMALL = { lowerVisible: false };
const S = 0.8 * T; // synthetic shoulder width
const calibrated = () => new Scenario().hold(2500, SMALL);

/** Small-room jogging on a continuous clock, with posture overrides that may change over the segment. */
function jog(sc: Scenario, ms: number, base: (t: number) => Partial<SynthParams> = () => ({})): Scenario {
  const t0 = sc.t;
  return sc.add(ms, (t) => jogParams(t0 + t, { small: true, base: base(t) }));
}

/** A 20 degree lean (ramp in, hold, ramp out) at a given hipX, followed by an upright pause. */
function leanStanding(sc: Scenario, dir: 1 | -1, hipX: number): Scenario {
  const lean = (deg: number) => ({ ...SMALL, hipX, tiltDeg: dir * deg });
  return sc
    .add(200, (t) => lean(20 * ramp(t, 200)))
    .hold(400, lean(20))
    .add(200, (t) => lean(20 * (1 - ramp(t, 200))))
    .hold(600, lean(0));
}

/** The same lean while jogging; `shift` (in S) also moves the whole upper body sideways with the lean. */
function leanJogging(sc: Scenario, dir: 1 | -1, hipX: number, holdMs = 400, shift = 0): Scenario {
  const at = (k: number) => ({ hipX: hipX + dir * shift * S * k, tiltDeg: dir * 20 * k });
  jog(sc, 200, (t) => at(ramp(t, 200)));
  jog(sc, holdMs, () => at(1));
  jog(sc, 200, (t) => at(1 - ramp(t, 200)));
  return jog(sc, 600, () => ({ hipX }));
}

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

  it('keeps following a sideways drift while jogging', () => {
    // Jogging is how the game is played, so the x reference must follow then too. The player
    // drifts 0.3 S right over 4 s of jogging; both leans afterwards must fire.
    const x = STAND.hipX + 0.3 * S;
    const sc = calibrated();
    jog(sc, 4000, (t) => ({ hipX: STAND.hipX + 0.3 * S * ramp(t, 4000) }));
    jog(sc, 1000, () => ({ hipX: x }));
    leanJogging(sc, 1, x);
    leanJogging(sc, 1, x);
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:1', 'shift:1']);
  });

  it.each([0.25, 0.5])('re-arms leans after returning %s S off the old spot', (dx) => {
    const x = STAND.hipX + dx * S;
    const sc = calibrated()
      .add(1500, () => null)
      .hold(1000, { ...SMALL, hipX: x });
    leanStanding(sc, 1, x);
    leanStanding(sc, -1, x);
    expect(names(play(new PoseController(), sc.frames))).toEqual(['lost', 'found', 'shift:1', 'shift:-1']);
  });

  it('re-arms leans after a gap while jogging', () => {
    const x = STAND.hipX + 0.25 * S;
    const sc = calibrated();
    jog(sc, 3000);
    sc.add(1500, () => null);
    jog(sc, 1500, () => ({ hipX: x }));
    leanJogging(sc, 1, x);
    expect(names(play(new PoseController(), sc.frames))).toContain('shift:1');
  });

  it('does not absorb a lean held while jogging', () => {
    // A tilt plus a 0.3 S body shift puts the nose about 0.5 S left. If the x reference followed
    // it during the 5 s hold, standing upright again would read about +0.5 S, past the 0.2 S
    // re-arm limit, and the second lean would be lost.
    const sc = calibrated();
    jog(sc, 2000);
    leanJogging(sc, -1, STAND.hipX, 5000, 0.3);
    leanJogging(sc, -1, STAND.hipX);
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:-1', 'shift:-1']);
  });
});
