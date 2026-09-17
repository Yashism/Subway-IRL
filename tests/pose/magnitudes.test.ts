import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { play } from '../helpers/play';
import { jogParams, jumpArc, Scenario, STAND, type SynthParams } from '../helpers/synth';

const T = STAND.torso;

/** Calibrates, then plays `build` and returns the peak of `pick` over those frames. */
function peakOf(build: (sc: Scenario) => void, pick: (ctrl: PoseController) => number, small = false): number {
  const ctrl = new PoseController();
  const sc = new Scenario();
  const base: Partial<SynthParams> = small ? { lowerVisible: false } : {};
  sc.hold(2500, base);
  build(sc);
  let peak = -Infinity;
  for (const f of sc.frames) {
    ctrl.update(f);
    if (ctrl.baseline) peak = Math.max(peak, pick(ctrl));
  }
  return peak;
}

describe('PoseController.magnitudes', () => {
  it('starts at zero before anything happens', () => {
    const ctrl = new PoseController();
    expect(ctrl.magnitudes).toEqual({
      lane: 0,
      tiltDeg: 0,
      noseShift: 0,
      rise: 0,
      drop: 0,
      headDrop: 0,
      jogPrimary: 0,
      bobAmp: 0,
      jogSteps: 0,
    });
  });

  it('reports the sideways offset in torso lengths, signed like the lane', () => {
    const right = peakOf(
      (sc) => sc.hold(600, { hipX: STAND.hipX + 0.8 * T }),
      (c) => c.magnitudes.lane,
    );
    expect(right).toBeCloseTo(0.8, 1);
    const left = peakOf(
      (sc) => sc.hold(600, { hipX: STAND.hipX - 0.8 * T }),
      (c) => -c.magnitudes.lane,
    );
    expect(left).toBeCloseTo(0.8, 1);
  });

  it('reports the jump rise in the same units as jumpRise', () => {
    const rise = peakOf(
      (sc) => sc.add(1200, (t) => ({ hipY: STAND.hipY - jumpArc(t - 200, 500, 0.35) * T })),
      (c) => c.magnitudes.rise,
    );
    expect(rise).toBeCloseTo(0.35, 1);
    expect(rise).toBeGreaterThan(new PoseController().th.jumpRise);
  });

  it('reports the hip drop in the same units as rollDrop', () => {
    const drop = peakOf(
      (sc) => sc.hold(800, { hipY: STAND.hipY + 0.4 * T, noseDrop: 0.4 }),
      (c) => c.magnitudes.drop,
    );
    expect(drop).toBeCloseTo(0.4, 1);
  });

  it('reports the knee lift and the step count while jogging', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500);
    const t0 = sc.t;
    sc.add(4000, (t) => jogParams(t0 + t));
    play(ctrl, sc.frames);
    expect(ctrl.magnitudes.jogSteps).toBeGreaterThanOrEqual(8);
    const lift = peakOf(
      (s) => {
        const start = s.t;
        s.add(4000, (t) => jogParams(start + t));
      },
      (c) => c.magnitudes.jogPrimary,
    );
    expect(lift).toBeCloseTo(0.35, 1);
  });

  it('reports the lean, nose shift and head drop in small-room mode', () => {
    const tilt = peakOf((sc) => sc.hold(600, { lowerVisible: false, tiltDeg: -20 }), (c) => -c.magnitudes.tiltDeg, true);
    expect(tilt).toBeCloseTo(20, 0);

    const nose = peakOf((sc) => sc.hold(600, { lowerVisible: false, tiltDeg: -20 }), (c) => -c.magnitudes.noseShift, true);
    expect(nose).toBeGreaterThan(0.1);

    const head = peakOf(
      (sc) => sc.hold(800, { lowerVisible: false, noseDrop: 0.5 }),
      (c) => c.magnitudes.headDrop,
      true,
    );
    expect(head).toBeGreaterThan(new PoseController().th.duckDrop);
  });

  it('reports the bob amplitude in the same units as bobMinAmp while jogging', () => {
    const amp = peakOf(
      (sc) => {
        const start = sc.t;
        sc.add(4000, (t) => jogParams(start + t, { bob: 0.08 }));
      },
      (c) => c.magnitudes.bobAmp,
    );
    expect(amp).toBeGreaterThan(new PoseController().th.bobMinAmp);
    expect(amp).toBeCloseTo(0.08, 1);
  });

  it('zeroes the live magnitudes when tracking is lost, keeping the step count', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500);
    const t0 = sc.t;
    sc.add(3000, (t) => jogParams(t0 + t));
    sc.hold(600, { hipX: STAND.hipX + 0.8 * T });
    sc.hold(1500, null);
    play(ctrl, sc.frames);
    const m = ctrl.magnitudes;
    expect(m.lane).toBe(0);
    expect(m.rise).toBe(0);
    expect(m.drop).toBe(0);
    expect(m.jogPrimary).toBe(0);
    expect(m.bobAmp).toBe(0);
    expect(m.jogSteps).toBeGreaterThan(0);
  });

  it('forgets the step count on recalibrate', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500);
    const t0 = sc.t;
    sc.add(3000, (t) => jogParams(t0 + t));
    play(ctrl, sc.frames);
    expect(ctrl.magnitudes.jogSteps).toBeGreaterThan(0);
    ctrl.recalibrate();
    expect(ctrl.magnitudes.jogSteps).toBe(0);
  });
});
