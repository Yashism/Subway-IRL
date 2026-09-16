import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { ASPECT, Scenario, STAND, synthPose } from '../helpers/synth';

describe('PoseController — tracking and gestures', () => {
  it('emits lost after 1 s without a pose and found when the player returns', () => {
    const sc = new Scenario().hold(500).add(1500, () => null).hold(500);
    expect(names(play(new PoseController(), sc.frames))).toEqual(['lost', 'found']);
  });

  it('treats a low-confidence pose as no pose', () => {
    const ctrl = new PoseController();
    const frames = new Scenario().hold(2500).frames;
    // Shifted far enough to change lane if it were trusted.
    const faint = synthPose({ hipX: STAND.hipX + 0.8 * STAND.torso }).map((l) => ({ ...l, visibility: 0.1 }));
    for (let t = 2500; t < 5500; t += 1000 / 30) frames.push({ t, aspect: ASPECT, poses: [faint] });
    expect(names(play(ctrl, frames))).toEqual(['lost']);
    expect(ctrl.status.tracking).toBe(false);
    expect(ctrl.status.lane).toBe(0);
  });

  it('runs gestures before calibration', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(300).hold(1600, { arms: 'right-up' }).hold(300).hold(500, { arms: 'both-up' });
    expect(names(play(ctrl, sc.frames))).toEqual(['start', 'hoverboard']);
  });

  it('exposes start progress and the tracked pose in status', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(300).hold(800, { arms: 'right-up' }).frames);
    expect(ctrl.status.startProgress).toBeGreaterThan(0.4);
    expect(ctrl.status.tracking).toBe(true);
    expect(ctrl.status.pose).toHaveLength(33);
    expect(ctrl.status.poseFps).toBe(30);
  });

  it('recalibrate forgets the baseline', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(2500).frames);
    ctrl.recalibrate();
    expect(ctrl.status.calibrated).toBe(false);
    expect(ctrl.status.calibration.progress).toBe(0);
  });

  it('honours a forced mode', () => {
    const ctrl = new PoseController({ forcedMode: 'small' });
    play(ctrl, new Scenario().hold(2500).frames);
    expect(ctrl.status.mode).toBe('small');
  });
});
