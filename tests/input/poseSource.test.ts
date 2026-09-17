import { describe, expect, it, vi } from 'vitest';
import { InputHub } from '../../src/input/hub';
import { PoseCommandSource } from '../../src/input/poseSource';
import { PoseController } from '../../src/pose/controller';
import type { PoseEvent, PoseFrame, PoseStatus } from '../../src/pose/types';
import { jogParams, Scenario } from '../helpers/synth';

/** A controller stand-in whose events and status the test sets directly. */
class StubController {
  next: PoseEvent[] = [];
  recalibrations = 0;
  status: PoseStatus = {
    tracking: true,
    calibrated: true,
    mode: 'full',
    lane: 0,
    poseFps: 30,
    confidence: 1,
    jog: { active: false, cadenceSpm: 0, msSinceStep: Infinity, steps: 0 },
    startProgress: 0,
    calibration: { progress: 1, bodyVisible: true, distance: 'ok' },
    pose: null,
    lastFrameT: null,
    squatting: false,
    slowPose: false,
  };

  statusInto(out: PoseStatus): PoseStatus {
    const s = this.status;
    Object.assign(out, { ...s, jog: out.jog, calibration: out.calibration });
    Object.assign(out.jog, s.jog);
    Object.assign(out.calibration, s.calibration);
    return out;
  }

  update(frame: PoseFrame): PoseEvent[] {
    this.status.lastFrameT = frame.t;
    const out = this.next;
    this.next = [];
    return out;
  }

  recalibrate(): PoseEvent[] {
    this.recalibrations++;
    this.status.jog = { ...this.status.jog, steps: 0 };
    return [{ type: 'lane', lane: 0 }];
  }
}

const frame = (t: number): PoseFrame => ({ t, aspect: 4 / 3, poses: [] });

function stubbed(opts?: { staleMs?: number }) {
  const stub = new StubController();
  const src = new PoseCommandSource(stub as unknown as PoseController, opts);
  const feed = (t: number, events: PoseEvent[] = []) => {
    stub.next = events;
    return src.push(frame(t));
  };
  return { stub, src, feed };
}

describe('PoseCommandSource mapping', () => {
  it('turns pose events into game commands, oldest first', () => {
    const { src, feed } = stubbed();
    feed(0, [{ type: 'lane', lane: 1 }, { type: 'laneShift', dir: -1 }, { type: 'jump' }]);
    feed(33, [{ type: 'roll' }, { type: 'hoverboard' }, { type: 'start' }, { type: 'lane', lane: -1 }]);
    expect(src.drain()).toEqual([
      { type: 'setLane', lane: 1 },
      { type: 'shiftLane', dir: -1 },
      { type: 'jump' },
      { type: 'roll' },
      { type: 'hoverboard' },
      { type: 'start' },
      { type: 'setLane', lane: -1 },
    ]);
    expect(src.drain()).toEqual([]);
  });

  it('returns the pose events each frame produced', () => {
    const { src, feed } = stubbed();
    const events: PoseEvent[] = [{ type: 'jump' }, { type: 'lost' }];
    expect(feed(0, events)).toEqual(events);
    expect(src.push(frame(33))).toEqual([]);
  });

  it('never turns lost or found into commands', () => {
    const { src, feed } = stubbed();
    feed(0, [{ type: 'lost' }]);
    feed(33, [{ type: 'found' }]);
    expect(src.drain()).toEqual([]);
  });

  it('remembers what it drained last, for telemetry', () => {
    const { src, feed } = stubbed();
    expect(src.source).toBe('pose');
    feed(0, [{ type: 'jump' }]);
    const out = src.drain();
    expect(src.lastDrained).toBe(out);
    expect(src.lastDrained).toEqual([{ type: 'jump' }]);
    src.drain();
    expect(src.lastDrained).toEqual([]);
  });

  it('does not hand out a shared empty list the caller could fill', () => {
    const { src } = stubbed();
    const a = src.drain();
    expect(() => a.push({ type: 'jump' })).toThrow();
    expect(src.drain()).toEqual([]);
  });
});

describe('PoseCommandSource activity', () => {
  it('does not track jogging until the controller is calibrated', () => {
    const { stub, src } = stubbed();
    stub.status.calibrated = false;
    expect(src.activity(0).tracksJogging).toBe(false);
    stub.status.calibrated = true;
    expect(src.activity(0).tracksJogging).toBe(true);
  });

  it('passes cadence and squatting straight through', () => {
    const { stub, src } = stubbed();
    stub.status.jog = { active: true, cadenceSpm: 158, msSinceStep: 100, steps: 4 };
    stub.status.squatting = true;
    expect(src.activity(0)).toMatchObject({ cadenceSpm: 158, squatting: true, steps: 4 });
  });

  it('ages msSinceStep by the time since the last pose frame', () => {
    const { stub, src, feed } = stubbed();
    feed(1000);
    stub.status.jog = { active: true, cadenceSpm: 150, msSinceStep: 120, steps: 3 };
    expect(src.activity(1000).msSinceStep).toBe(120);
    expect(src.activity(1400).msSinceStep).toBe(520);
  });

  it('does not age msSinceStep before any frame or when the game clock is behind the pose clock', () => {
    const { stub, src, feed } = stubbed();
    stub.status.jog = { active: true, cadenceSpm: 150, msSinceStep: 120, steps: 3 };
    expect(src.activity(5000).msSinceStep).toBe(120);
    feed(1000);
    expect(src.activity(900).msSinceStep).toBe(120);
  });

  it('sets lost from a lost event until found', () => {
    const { src, feed } = stubbed();
    feed(0);
    expect(src.activity(0).lost).toBe(false);
    feed(33, [{ type: 'lost' }]);
    expect(src.activity(33).lost).toBe(true);
    feed(66);
    expect(src.activity(66).lost).toBe(true);
    feed(100, [{ type: 'found' }]);
    expect(src.activity(100).lost).toBe(false);
  });

  it('reports a stalled stream as lost after staleMs', () => {
    const { src, feed } = stubbed();
    expect(src.activity(10_000).lost).toBe(false);
    feed(1000);
    expect(src.activity(2500).lost).toBe(false);
    expect(src.activity(2501).lost).toBe(true);
    feed(2600);
    expect(src.activity(2600).lost).toBe(false);
  });

  it('takes a custom staleMs', () => {
    const { src, feed } = stubbed({ staleMs: 300 });
    feed(0);
    expect(src.activity(300).lost).toBe(false);
    expect(src.activity(301).lost).toBe(true);
  });

  it('keeps steps monotonic across recalibrate and queues the lane reset', () => {
    const { stub, src } = stubbed();
    stub.status.jog = { active: true, cadenceSpm: 150, msSinceStep: 0, steps: 12 };
    expect(src.activity(0).steps).toBe(12);
    src.recalibrate();
    expect(stub.recalibrations).toBe(1);
    expect(src.activity(0).steps).toBe(12);
    stub.status.jog = { ...stub.status.jog, steps: 3 };
    expect(src.activity(0).steps).toBe(15);
    expect(src.drain()).toEqual([{ type: 'setLane', lane: 0 }]);
  });

  it('keeps steps monotonic when the controller is recalibrated behind its back', () => {
    const { stub, src } = stubbed();
    stub.status.jog = { active: true, cadenceSpm: 150, msSinceStep: 0, steps: 12 };
    expect(src.activity(0).steps).toBe(12);
    stub.recalibrate();
    expect(src.activity(0).steps).toBe(12);
    stub.status.jog = { ...stub.status.jog, steps: 2 };
    expect(src.activity(0).steps).toBe(14);
  });

  it('reuses one result object, which InputHub copies', () => {
    const { stub, src } = stubbed();
    stub.status.jog = { active: true, cadenceSpm: 150, msSinceStep: 50, steps: 7 };
    const a = src.activity(0);
    expect(src.activity(0)).toBe(a);

    const hub = new InputHub([src]);
    const merged = hub.activity(0);
    expect(merged).not.toBe(a);
    stub.status.jog = { active: false, cadenceSpm: 0, msSinceStep: 900, steps: 9 };
    stub.status.squatting = true;
    hub.activity(0);
    expect(merged).toEqual({ tracksJogging: true, msSinceStep: 50, cadenceSpm: 150, steps: 7, squatting: false, lost: false });
  });
});

describe('PoseCommandSource with a real controller', () => {
  it('tracks jogging after calibration and keeps steps across recalibrate', () => {
    const ctrl = new PoseController();
    const src = new PoseCommandSource(ctrl);
    expect(src.controller).toBe(ctrl);
    const sc = new Scenario().hold(2500);
    for (const f of sc.frames) src.push(f);
    expect(src.activity(sc.t).tracksJogging).toBe(true);

    const t0 = sc.t;
    sc.add(3000, (t) => jogParams(t0 + t));
    for (const f of sc.frames.slice(-90)) src.push(f);
    const before = src.activity(sc.t);
    expect(before.steps).toBeGreaterThanOrEqual(6);
    expect(before.msSinceStep).toBeLessThan(500);
    const steps = before.steps;

    src.recalibrate();
    const after = src.activity(sc.t);
    expect(after.tracksJogging).toBe(false);
    expect(after.steps).toBe(steps);
  });

  it('ages a real stall: 1.4 s without frames is not lost yet, 1.6 s is', () => {
    const ctrl = new PoseController();
    const src = new PoseCommandSource(ctrl);
    const sc = new Scenario().hold(2500);
    for (const f of sc.frames) src.push(f);
    const last = sc.frames.at(-1)!.t;
    const at = src.activity(last).msSinceStep;
    expect(src.activity(last + 1400)).toMatchObject({ lost: false, msSinceStep: at + 1400 });
    expect(src.activity(last + 1600).lost).toBe(true);
  });
});

describe('PoseCommandSource allocation', () => {
  it('reads the controller through statusInto, never the allocating status getter', () => {
    const ctrl = new PoseController();
    const getter = vi.spyOn(ctrl, 'status', 'get');
    const src = new PoseCommandSource(ctrl);
    src.push({ t: 0, aspect: 4 / 3, poses: [] });
    src.activity(10);
    src.activity(20);
    src.recalibrate();
    expect(getter).not.toHaveBeenCalled();
  });
});
