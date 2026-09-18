import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
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

/**
 * The readout writes into a shared object nobody in the game reads, so it must change no detection
 * behaviour at all. These pin the event stream and the step count of one busy scenario, so a future
 * edit to the detectors made "while I am in here anyway" cannot slip past as a readout change.
 */
describe('PoseController — the readout changes no detection behaviour', () => {
  it.each([false, true])('produces the same events and step count as ever (small: %s)', (small) => {
    const base = small ? { lowerVisible: false } : {};
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500, base);
    const t0 = sc.t;
    sc.add(3000, (t) => jogParams(t0 + t, { small }));
    sc.hold(600, { ...base, ...(small ? { tiltDeg: -20 } : { hipX: STAND.hipX - 0.8 * T }) });
    sc.hold(600, base);
    sc.add(500, (t) => ({ ...base, hipY: STAND.hipY - jumpArc(t, 500, 0.4) * T }));
    sc.hold(600, base);
    sc.hold(700, { ...base, hipY: STAND.hipY + 0.45 * T, noseDrop: 0.6 });
    sc.hold(600, base);
    sc.hold(600, { ...base, arms: 'both-up' });
    const events = names(play(ctrl, sc.frames));
    expect(events).toEqual(
      small
        ? ['shift:-1', 'jump', 'roll', 'hoverboard']
        : ['lane:-1', 'lane:0', 'jump', 'roll', 'hoverboard'],
    );
    expect(ctrl.status.jog.steps).toBe(small ? 8 : 9);
  });
});

/**
 * Drift normally follows a player who stands taller or steps nearer. It also chases one who is
 * holding a slow, sub-threshold attempt — which is exactly what a cautious first-timer does when
 * told to lean — and eats the very excursion the Move Check is trying to measure.
 */
describe('PoseController.freezeBaseline', () => {
  /** Holds a lean under the threshold for `ms` and reports the nose shift still visible at the end. */
  function heldLean(freeze: boolean, ms = 4000): number {
    const ctrl = new PoseController({ forcedMode: 'small' });
    const sc = new Scenario().hold(2500, { lowerVisible: false }).hold(ms, { lowerVisible: false, tiltDeg: -10 });
    for (const f of sc.frames) {
      ctrl.freezeBaseline = freeze && ctrl.baseline !== null;
      ctrl.update(f);
    }
    return -ctrl.magnitudes.noseShift;
  }

  it('stops a held sub-threshold lean being eaten by the baseline', () => {
    const drifting = heldLean(false);
    const frozen = heldLean(true);
    expect(frozen).toBeGreaterThan(0.08);
    expect(drifting).toBeLessThan(frozen / 2);
  });

  it('leaves drift alone by default', () => {
    expect(new PoseController().freezeBaseline).toBe(false);
  });

  it('keeps a slow knee lift measurable in full-body mode', () => {
    const lift = (freeze: boolean): number => {
      const ctrl = new PoseController({ forcedMode: 'full' });
      const sc = new Scenario().hold(2500).hold(4000, { kneeLiftL: 0.08 });
      for (const f of sc.frames) {
        ctrl.freezeBaseline = freeze && ctrl.baseline !== null;
        ctrl.update(f);
      }
      return ctrl.magnitudes.jogPrimary;
    };
    expect(lift(true)).toBeGreaterThan(0.07);
    expect(lift(false)).toBeLessThan(lift(true) / 2);
  });
});

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
      bobGated: 0,
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

  it.each([-1, 1] as const)('reports the lean and nose shift in small-room mode, leaning %i', (dir) => {
    const lean = { lowerVisible: false, tiltDeg: dir * 20 };
    expect(peakOf((sc) => sc.hold(600, lean), (c) => dir * c.magnitudes.tiltDeg, true)).toBeCloseTo(20, 0);
    // Pinned to a value, not just "> 0": in shoulder widths this is 0.45 sin20 / 0.8. Dividing by
    // the torso instead would give 0.153, which a loose bound would wave through — and the whole
    // premise of the readout is that its units match the threshold it will replace.
    expect(peakOf((sc) => sc.hold(600, lean), (c) => dir * c.magnitudes.noseShift, true)).toBeCloseTo(0.1914, 3);
  });

  it('reports the head drop in the units of each mode\u2019s own threshold', () => {
    const drop = (small: boolean) =>
      peakOf(
        (sc) => sc.hold(800, { lowerVisible: !small, noseDrop: 0.5 }),
        (c) => c.magnitudes.headDrop,
        small,
      );
    // 0.5 torso lengths of nose drop: that is 0.5 against rollHeadDrop, 0.5/0.8 against duckDrop.
    expect(drop(true)).toBeCloseTo(0.625, 2);
    expect(drop(false)).toBeCloseTo(0.5, 1);
    expect(drop(true)).toBeGreaterThan(new PoseController().th.duckDrop);
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

  it('reports a bob too small to count as a step, which the gated amplitude cannot', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500, { lowerVisible: false });
    const t0 = sc.t;
    sc.add(4000, (t) => jogParams(t0 + t, { small: true, arms: 'down', bob: ctrl.th.bobMinAmp * 0.8 }));
    let amp = 0;
    for (const f of sc.frames) {
      ctrl.update(f);
      if (ctrl.baseline) amp = Math.max(amp, ctrl.magnitudes.bobAmp);
    }
    // Nothing about this bob counts as a step — and that is exactly the player who needs to be told
    // "almost". A reading of 0 here would leave them with no feedback and nothing to tune from.
    expect(ctrl.magnitudes.jogSteps).toBe(0);
    expect(amp).toBeGreaterThan(0.3 * ctrl.th.bobMinAmp);
    expect(amp).toBeLessThan(ctrl.th.bobMinAmp);
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
