import { describe, expect, it, vi } from 'vitest';
import { NO_INPUT, type WalkInput } from '../../src/wander/walker';
import { POSE_RUN_SPM, POSE_TURN, POSE_WALK_HOLD_MS, WanderKeys, keysToInput, mergeInput, poseToInput, type PoseSample } from '../../src/wander/controls';

const fresh = (): WalkInput => ({ ...NO_INPUT });
const sample = (o: Partial<PoseSample> = {}): PoseSample => ({
  running: true,
  tracking: true,
  calibrated: true,
  jogActive: false,
  msSinceStep: Infinity,
  cadenceSpm: 0,
  lane: 0,
  ...o,
});

describe('keyboard', () => {
  it('maps WASD and the arrows to walk, turn and sidestep, Shift to run', () => {
    expect(keysToInput(new Set(['KeyW']), fresh())).toEqual({ forward: 1, turn: 0, strafe: 0, run: false });
    expect(keysToInput(new Set(['ArrowDown', 'ArrowLeft']), fresh())).toEqual({ forward: -1, turn: -1, strafe: 0, run: false });
    expect(keysToInput(new Set(['KeyD', 'KeyW', 'ShiftLeft']), fresh())).toEqual({ forward: 1, turn: 1, strafe: 0, run: true });
    expect(keysToInput(new Set(['KeyQ']), fresh()).strafe).toBe(-1);
    expect(keysToInput(new Set(['KeyE']), fresh()).strafe).toBe(1);
  });

  it('opposite keys cancel', () => {
    expect(keysToInput(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']), fresh())).toEqual(NO_INPUT);
  });

  it('holds keys until released, and forgets them on blur or release()', () => {
    const k = new WanderKeys({ exit: vi.fn(), pause: vi.fn(), camera: vi.fn() });
    k.keyDown({ code: 'KeyW' });
    expect(k.read(fresh()).forward).toBe(1);
    k.keyUp({ code: 'KeyW' });
    expect(k.read(fresh()).forward).toBe(0);
    k.keyDown({ code: 'KeyW' });
    k.release();
    expect(k.read(fresh()).forward).toBe(0);
  });

  it('Esc leaves, P and Space pause, C asks for the camera; browser shortcuts are left alone', () => {
    const h = { exit: vi.fn(), pause: vi.fn(), camera: vi.fn() };
    const k = new WanderKeys(h);
    expect(k.keyDown({ code: 'Escape' })).toBe(true);
    k.keyDown({ code: 'KeyP' });
    k.keyDown({ code: 'Space' });
    k.keyDown({ code: 'KeyC' });
    expect([h.exit, h.pause, h.camera].map((f) => f.mock.calls.length)).toEqual([1, 2, 1]);
    // A held key repeating does not fire twice, and Ctrl+P is the browser's.
    k.keyDown({ code: 'Escape', repeat: true });
    expect(k.keyDown({ code: 'KeyP', ctrlKey: true })).toBe(false);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.pause).toHaveBeenCalledTimes(2);
  });
});

describe('the body', () => {
  it('does nothing without a calibrated body in view', () => {
    expect(poseToInput(null, fresh())).toEqual(NO_INPUT);
    expect(poseToInput(sample({ running: false, jogActive: true }), fresh())).toEqual(NO_INPUT);
    expect(poseToInput(sample({ calibrated: false, jogActive: true }), fresh())).toEqual(NO_INPUT);
    expect(poseToInput(sample({ tracking: false, jogActive: true }), fresh())).toEqual(NO_INPUT);
  });

  it('jogging in place walks, and keeps walking through the gap between steps', () => {
    expect(poseToInput(sample({ jogActive: true }), fresh()).forward).toBe(1);
    expect(poseToInput(sample({ msSinceStep: POSE_WALK_HOLD_MS - 50 }), fresh()).forward).toBe(1);
    expect(poseToInput(sample({ msSinceStep: POSE_WALK_HOLD_MS + 50 }), fresh()).forward).toBe(0);
  });

  it('a fast jog runs', () => {
    expect(poseToInput(sample({ jogActive: true, cadenceSpm: POSE_RUN_SPM }), fresh()).run).toBe(true);
    expect(poseToInput(sample({ jogActive: true, cadenceSpm: POSE_RUN_SPM - 20 }), fresh()).run).toBe(false);
    // Standing still never runs, however the cadence last read.
    expect(poseToInput(sample({ cadenceSpm: 200 }), fresh()).run).toBe(false);
  });

  it('leaning or stepping to a side steers that way', () => {
    expect(poseToInput(sample({ lane: -1 }), fresh()).turn).toBe(-POSE_TURN);
    expect(poseToInput(sample({ lane: 1 }), fresh()).turn).toBe(POSE_TURN);
    expect(poseToInput(sample({ lane: 0 }), fresh()).turn).toBe(0);
  });
});

describe('merging', () => {
  it('lets the keys win axis by axis and the body fill in the rest', () => {
    const keys: WalkInput = { forward: 0, turn: -1, strafe: 0, run: false };
    const pose: WalkInput = { forward: 1, turn: 0.7, strafe: 0, run: true };
    expect(mergeInput(keys, pose, fresh())).toEqual({ forward: 1, turn: -1, strafe: 0, run: true });
    expect(mergeInput({ ...keys, forward: -1 }, pose, fresh()).forward).toBe(-1);
  });
});
