import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { ASPECT, ramp, Scenario, STAND, synthPose } from '../helpers/synth';

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

  it('recalibrate returns the player to the centre lane', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(2500).hold(500, { hipX: STAND.hipX + 0.8 * STAND.torso }).frames);
    expect(ctrl.status.lane).toBe(1);
    expect(ctrl.recalibrate()).toEqual([{ type: 'lane', lane: 0 }]);
    expect(ctrl.status.lane).toBe(0);
    expect(ctrl.recalibrate()).toEqual([]);
  });

  it('reports the time of the last frame, with or without a pose', () => {
    const ctrl = new PoseController();
    expect(ctrl.status.lastFrameT).toBeNull();
    ctrl.update({ t: 1234, aspect: ASPECT, poses: [synthPose()] });
    expect(ctrl.status.lastFrameT).toBe(1234);
    ctrl.update({ t: 1300, aspect: ASPECT, poses: [] });
    expect(ctrl.status.lastFrameT).toBe(1300);
  });

  it('reports squatting while a full-body squat is held', () => {
    const ctrl = new PoseController();
    const squat = { hipY: STAND.hipY + 0.45 * STAND.torso };
    play(ctrl, new Scenario().hold(2500).frames);
    expect(ctrl.status.squatting).toBe(false);
    const sc = new Scenario();
    sc.t = 2500;
    sc.add(200, (t) => ({ hipY: STAND.hipY + 0.45 * STAND.torso * ramp(t, 200) })).hold(600, squat);
    expect(names(play(ctrl, sc.frames))).toEqual(['roll']);
    expect(ctrl.status.squatting).toBe(true);
    const up = new Scenario();
    up.t = sc.t;
    play(ctrl, up.add(200, (t) => ({ hipY: STAND.hipY + 0.45 * STAND.torso * (1 - ramp(t, 200)) })).hold(600).frames);
    expect(ctrl.status.squatting).toBe(false);
  });

  it('reports squatting while a small-room duck is held', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(2500, { lowerVisible: false }).hold(500, { lowerVisible: false, noseDrop: 0.5 });
    expect(names(play(ctrl, sc.frames))).toEqual(['roll']);
    expect(ctrl.status.squatting).toBe(true);
  });

  it('flags a slow pose stream only after 2 s of frames', () => {
    const slow = new PoseController();
    play(slow, new Scenario(10).hold(1500).frames);
    expect(slow.status.poseFps).toBe(10);
    expect(slow.status.slowPose).toBe(false);
    play(slow, new Scenario(10).hold(1500).frames.map((f) => ({ ...f, t: f.t + 1500 })));
    expect(slow.status.slowPose).toBe(true);
    const fast = new PoseController();
    play(fast, new Scenario(30).hold(3000).frames);
    expect(fast.status.slowPose).toBe(false);
  });

  it('honours a forced mode', () => {
    const ctrl = new PoseController({ forcedMode: 'small' });
    play(ctrl, new Scenario().hold(2500).frames);
    expect(ctrl.status.mode).toBe('small');
  });
});
