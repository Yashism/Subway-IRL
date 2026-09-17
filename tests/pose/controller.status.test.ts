import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { ASPECT, Scenario, STAND, synthPose } from '../helpers/synth';

describe('PoseController — statusInto', () => {
  it('fills an existing object in place, with the same values as status', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(2500).frames);

    const out = ctrl.status; // allocate an initial snapshot to reuse as the target
    const outJog = out.jog;
    const outCalibration = out.calibration;

    const result = ctrl.statusInto(out);

    expect(result).toBe(out);
    expect(out.jog).toBe(outJog);
    expect(out.calibration).toBe(outCalibration);
    expect(out).toEqual(ctrl.status);
  });

  it('keeps tracking values current across further updates', () => {
    const ctrl = new PoseController();
    const out = ctrl.status;

    play(ctrl, new Scenario().hold(300).hold(800, { arms: 'right-up' }).frames);
    ctrl.statusInto(out);
    expect(out.startProgress).toBeGreaterThan(0.4);
    expect(out.tracking).toBe(true);

    play(ctrl, new Scenario().hold(1600, { arms: 'right-up' }).frames.map((f) => ({ ...f, t: f.t + 1100 })));
    ctrl.statusInto(out);
    expect(out).toEqual(ctrl.status);
  });
});

describe('PoseController — long frame gaps', () => {
  it('emits lost then found, and resets move state, when frames stop arriving entirely', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500); // stand still long enough to calibrate full-body
    play(ctrl, sc.frames);
    expect(ctrl.status.calibrated).toBe(true);
    const lastT = sc.t;

    // No update() calls at all for 2 s (not even empty frames) — simulates the pose source
    // outright stalling rather than sending empty poses.
    const shifted = synthPose({ hipX: STAND.hipX + 0.05 * STAND.torso });
    const resumeEvents = ctrl.update({ t: lastT + 2000, aspect: ASPECT, poses: [shifted] });
    expect(names(resumeEvents)).toEqual(['lost', 'found']);

    // Coming back standing in a slightly different spot (small shift, within thresholds) must not
    // produce spurious lane/jump/roll events.
    const after = new Scenario();
    after.t = lastT + 2000 + 1000 / 30;
    const moreEvents = play(ctrl, after.hold(500, { hipX: STAND.hipX + 0.05 * STAND.torso }).frames);
    expect(names(moreEvents)).toEqual([]);
  });

  it('does not double-emit lost when the stream already flagged lost via empty frames', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(2500).frames);
    const sc = new Scenario();
    sc.t = 2500;
    // Empty frames at normal cadence push the stream past lostMs and flag it themselves.
    const lostEvents = play(ctrl, sc.add(1100, () => null).frames);
    expect(names(lostEvents)).toEqual(['lost']);
    const afterEmptyT = sc.t;

    // Then the pose source stalls completely (no calls at all) for another 2 s before a pose
    // resumes: only one 'found' should appear, never a second 'lost'.
    const resumeEvents = ctrl.update({ t: afterEmptyT + 2000, aspect: ASPECT, poses: [synthPose()] });
    expect(names(resumeEvents)).toEqual(['found']);
  });

  it('resets calibration progress on a long gap while still uncalibrated (same rule as a stall)', () => {
    const ctrl = new PoseController();
    // Hold for less than calibHoldMs so calibration is still in progress, not complete.
    play(ctrl, new Scenario().hold(1000).frames);
    expect(ctrl.status.calibrated).toBe(false);
    expect(ctrl.status.calibration.progress).toBeGreaterThan(0);

    const resumeEvents = ctrl.update({ t: 1000 + 2000, aspect: ASPECT, poses: [synthPose()] });
    expect(names(resumeEvents)).toEqual(['lost', 'found']);
    // Calibration restarted: progress for a single fresh sample is 0 (span is 0).
    expect(ctrl.status.calibration.progress).toBe(0);
  });
});
