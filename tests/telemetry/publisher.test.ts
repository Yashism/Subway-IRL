import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryPublisher } from '../../src/telemetry/publisher';
import { isGameMessage, type ControlMessage, type FrameMsg, type GameMsg, type MetaMsg, type MoveCheckMsg, type StatusMsg } from '../../src/telemetry/messages';
import { Game } from '../../src/game/game';
import { PoseController } from '../../src/pose/controller';
import { Scenario, synthPose } from '../helpers/synth';
import { FakeBroadcastChannel, peer } from './fakeChannel';

const META = { seed: 7, difficulty: 'cardio', input: 'webcam', mode: null, sensitivity: 1, thresholds: { jumpVel: 1.5 } };
const frameAt = (t: number) => ({ t, aspect: 4 / 3, poses: [synthPose()] });

let clock = 0;
const now = () => clock;

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  clock = 1000;
});
afterEach(() => vi.unstubAllGlobals());

/** Feeds 30 fps frames for `ms`, advancing the clock. */
function feed(pub: TelemetryPublisher, ms: number): void {
  const start = clock;
  const n = Math.round((ms * 30) / 1000);
  for (let i = 0; i < n; i++) {
    clock = start + (i * 1000) / 30;
    pub.frame(frameAt(clock));
  }
  clock = start + ms;
}

describe('TelemetryPublisher without BroadcastChannel', () => {
  it('is a silent no-op', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const pub = new TelemetryPublisher(undefined, now);
    expect(pub.available).toBe(false);
    expect(() => {
      pub.frame(frameAt(0));
      pub.status(new PoseController().status, 'replay');
      pub.poseEvents([{ type: 'jump' }], 0);
      pub.commands([{ type: 'jump' }], 'pose', 0);
      pub.gameEvents([{ type: 'jump' }], 0);
      pub.game(new Game({ seed: 1, difficulty: 'cardio' }), 0, 0);
      pub.meta(META);
      pub.onControl(() => {})();
      pub.close();
    }).not.toThrow();
  });
});

describe('TelemetryPublisher handshake', () => {
  it('sends nothing until a monitor says hello', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    pub.meta(META);
    feed(pub, 1000);
    pub.poseEvents([{ type: 'jump' }], clock);
    pub.status(new PoseController().status, 'replay');
    expect(mon.got).toEqual([]);
    expect(pub.connected).toBe(false);
  });

  it('answers each hello with meta and starts publishing', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    pub.meta(META);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    expect(pub.connected).toBe(true);
    const meta = mon.kinds('meta') as unknown as MetaMsg[];
    expect(meta).toHaveLength(1);
    expect(meta[0].meta).toEqual(META);
    expect(meta[0].fullRate).toBe(false);
    pub.poseEvents([{ type: 'jump' }], clock);
    expect(mon.kinds('poseEvents')).toHaveLength(1);
  });

  it('stops publishing 3 s after the last hello', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    clock += 2900;
    pub.gameEvents([{ type: 'coin' }], clock);
    expect(mon.kinds('gameEvents')).toHaveLength(1);
    clock += 200;
    pub.gameEvents([{ type: 'coin' }], clock);
    expect(mon.kinds('gameEvents')).toHaveLength(1);
    expect(pub.connected).toBe(false);
  });

  it('re-sends meta to connected monitors when it changes', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    pub.meta({ ...META, sensitivity: 1.2 });
    const meta = mon.kinds('meta') as unknown as MetaMsg[];
    expect(meta.at(-1)!.meta!.sensitivity).toBe(1.2);
  });

  it('says bye on close and then goes quiet', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    pub.close();
    expect(mon.kinds('bye')).toHaveLength(1);
    expect(() => pub.poseEvents([{ type: 'jump' }], clock)).not.toThrow();
    expect(mon.kinds('poseEvents')).toHaveLength(0);
  });
});

describe('TelemetryPublisher throttling', () => {
  it('sends ~15 frames per second normally', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    feed(pub, 1000);
    const n = mon.kinds('frame').length;
    expect(n).toBeGreaterThanOrEqual(14);
    expect(n).toBeLessThanOrEqual(16);
  });

  it('sends every frame while a monitor is recording, and drops back after it stops', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: true });
    expect((mon.kinds('meta')[0] as unknown as MetaMsg).fullRate).toBe(true);
    feed(pub, 1000);
    expect(mon.kinds('frame')).toHaveLength(30);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    mon.got.length = 0;
    feed(pub, 1000);
    expect(mon.kinds('frame').length).toBeLessThanOrEqual(16);
  });

  it('keeps full rate while any monitor is recording', () => {
    const rec = peer();
    const watch = peer();
    const pub = new TelemetryPublisher(undefined, now);
    rec.send({ kind: 'hello', id: 'rec', recording: true });
    watch.send({ kind: 'hello', id: 'watch', recording: false });
    feed(pub, 500);
    expect(watch.kinds('frame')).toHaveLength(15);
  });

  it('encodes frame landmarks correctly even though it reuses its buffer', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: true });
    pub.frame({ t: 1, aspect: 4 / 3, poses: [synthPose({ hipX: 0.4 })] });
    pub.frame({ t: 2, aspect: 4 / 3, poses: [synthPose({ hipX: 0.9 })] });
    pub.frame({ t: 3, aspect: 16 / 9, poses: [] });
    pub.frame({ t: 4, aspect: 4 / 3, poses: [synthPose(), synthPose({ hipX: 0.2 })] });
    const frames = mon.kinds('frame') as unknown as FrameMsg[];
    expect(frames.map((f) => f.count)).toEqual([1, 1, 0, 2]);
    expect(frames[0].data[24 * 4]).toBeCloseTo(synthPose({ hipX: 0.4 })[24].x, 5);
    expect(frames[1].data[24 * 4]).toBeCloseTo(synthPose({ hipX: 0.9 })[24].x, 5);
    expect(frames[2].aspect).toBeCloseTo(16 / 9);
    expect(frames[3].data[(33 + 24) * 4]).toBeCloseTo(synthPose({ hipX: 0.2 })[24].x, 5);
  });

  it('throttles status to ~10 Hz and leaves the pose out', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: true });
    const ctrl = new PoseController();
    for (const f of new Scenario().hold(1000).frames) {
      clock = 1000 + f.t;
      ctrl.update(f);
      pub.status(ctrl.status, 'replay', ctrl.baseline);
    }
    const st = mon.kinds('status') as unknown as StatusMsg[];
    expect(st.length).toBeGreaterThanOrEqual(9);
    expect(st.length).toBeLessThanOrEqual(11);
    expect(st[0].backend).toBe('replay');
    expect('pose' in st[0].status).toBe(false);
    expect(st.at(-1)!.status.tracking).toBe(true);
    expect(st.at(-1)!.t).toBeGreaterThan(clock - 150);
    expect(st.at(-1)!.t).toBeLessThanOrEqual(clock);
  });

  it('throttles game snapshots to ~10 Hz and reports the fields the monitor shows', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    const game = new Game({ seed: 3, difficulty: 'cardio' });
    const activity = { tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0, steps: 0, squatting: false, lost: false };
    game.step(1 / 60, [{ type: 'start' }], activity);
    for (let i = 0; i < 60; i++) {
      clock += 1000 / 60;
      game.step(1 / 60, [], activity);
      pub.game(game, 420, clock);
    }
    const snaps = mon.kinds('game') as unknown as GameMsg[];
    expect(snaps.length).toBeGreaterThanOrEqual(9);
    expect(snaps.length).toBeLessThanOrEqual(11);
    const g = snaps.at(-1)!.game;
    expect(g.state).toBe('countdown');
    expect(g.idleMs).toBe(420);
    expect(g.powerups.hoverboardsLeft).toBeGreaterThan(0);
    expect(g).toMatchObject({ lane: 0, rolling: false, airborne: false, caughtReason: null, pausedByLoss: false });
    expect(g.josh).toEqual({ value: 0, active: false });
    // Snapshots are cloned on send, so earlier ones are not overwritten by later ones.
    expect(snaps[0].game.countdown).toBeGreaterThan(g.countdown);
  });

  it('sends events and commands as they happen, skipping empty batches', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    pub.poseEvents([], 1);
    pub.commands([], 'keyboard', 1);
    pub.gameEvents([], 1);
    expect(mon.got.filter((m) => m.kind !== 'meta')).toEqual([]);
    pub.poseEvents([{ type: 'lane', lane: 1 }], 2);
    pub.poseEvents([{ type: 'jump' }], 2);
    pub.commands([{ type: 'jump' }], 'keyboard', 3);
    pub.gameEvents([{ type: 'caught', reason: 'idle' }], 4);
    expect(mon.kinds('poseEvents')).toEqual([
      { kind: 'poseEvents', t: 2, events: [{ type: 'lane', lane: 1 }] },
      { kind: 'poseEvents', t: 2, events: [{ type: 'jump' }] },
    ]);
    expect(mon.kinds('commands')).toEqual([{ kind: 'commands', t: 3, source: 'keyboard', commands: [{ type: 'jump' }] }]);
    expect(mon.kinds('gameEvents')).toEqual([{ kind: 'gameEvents', t: 4, events: [{ type: 'caught', reason: 'idle' }] }]);
  });
});

describe('TelemetryPublisher controls', () => {
  it('hands valid control messages to handlers and ignores the rest', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    const got: ControlMessage[] = [];
    const off = pub.onControl((m) => got.push(m));
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    mon.send({ kind: 'setSensitivity', value: 1.1 });
    mon.send({ kind: 'setThreshold', key: 'jumpVel', value: 'big' });
    mon.send({ kind: 'recalibrate' });
    mon.send({ kind: 'frame', t: 0 });
    expect(got).toEqual([{ kind: 'setSensitivity', value: 1.1 }, { kind: 'recalibrate' }]);
    off();
    mon.send({ kind: 'recalibrate' });
    expect(got).toHaveLength(2);
  });

  it('only hello keeps the connection alive', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    mon.send({ kind: 'recalibrate' });
    expect(pub.connected).toBe(false);
    mon.send({ kind: 'hello', id: 'm1', recording: false });
    clock += 2500;
    mon.send({ kind: 'recalibrate' });
    clock += 2500;
    expect(pub.connected).toBe(false);
  });
});

describe('TelemetryPublisher: move check', () => {
  it('publishes step starts, results and the tuned values once a monitor is listening', () => {
    const mon = peer();
    const pub = new TelemetryPublisher(undefined, now);
    // Nothing before the handshake.
    pub.moveCheck('full', { phase: 'start', move: 'jog' }, clock);
    expect(mon.got).toEqual([]);

    mon.send({ kind: 'hello', id: 'm1', recording: false });
    pub.moveCheck('full', { phase: 'start', move: 'jump' }, clock);
    pub.moveCheck('full', { phase: 'result', move: 'jump', result: 'done', peak: 0.32, progress: 1 }, clock);
    pub.moveCheck('full', { phase: 'done', tuned: { jumpRise: 0.18 }, note: null }, clock);
    const sent = mon.kinds('moveCheck') as unknown as MoveCheckMsg[];
    expect(sent.map((m) => m.event.phase)).toEqual(['start', 'result', 'done']);
    expect(sent.every((m) => m.mode === 'full')).toBe(true);
    expect(sent[2].event).toEqual({ phase: 'done', tuned: { jumpRise: 0.18 }, note: null });
    expect(sent.every((m) => isGameMessage(m))).toBe(true);
  });
});
