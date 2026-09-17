import { describe, expect, it } from 'vitest';
import {
  connection,
  describeEntry,
  formatRel,
  idleBar,
  initialState,
  poseStatusOf,
  recordingTimeline,
  reduce,
  stallAge,
  TIMELINE_CAP,
  viewAt,
  visibleTimeline,
  type MonitorState,
} from '../../src/monitor/state';
import { MAX_RECORDING_FRAMES, MAX_RECORDING_MS, SessionRecorder } from '../../src/monitor/recorder';
import {
  decodeSession,
  isGameMessage,
  writeFrameData,
  type GameMessage,
  type GameSnapshot,
  type WireStatus,
} from '../../src/telemetry/messages';
import { synthPose } from '../helpers/synth';

const status: WireStatus = {
  tracking: true,
  calibrated: true,
  mode: 'full',
  lane: 0,
  poseFps: 30,
  confidence: 0.9,
  jog: { active: true, cadenceSpm: 150, msSinceStep: 120, steps: 12 },
  startProgress: 0,
  calibration: { progress: 1, bodyVisible: true, distance: 'ok' },
  lastFrameT: 1000,
  squatting: false,
  slowPose: false,
};

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  state: 'playing',
  s: 10,
  speed: 9,
  lane: 0,
  y: 0,
  rolling: false,
  airborne: false,
  flying: false,
  idleLevel: 'ok',
  idleMs: 100,
  countdown: 0,
  time: 2,
  josh: { value: 0, active: false },
  powerups: { magnet: 0, rocket: 0, chappal: 0, hoverboard: 0, grace: 0, hoverboardsLeft: 3 },
  pausedByLoss: false,
  caughtReason: null,
  coins: 0,
  score: 10,
  ...over,
});

function frameMsg(t: number, hipX = 0.5): GameMessage {
  const data = new Float32Array(132);
  writeFrameData([synthPose({ hipX })], data);
  return { kind: 'frame', t, aspect: 4 / 3, count: 1, data };
}

const META = { seed: 42, difficulty: 'cardio', input: 'webcam', mode: 'full', sensitivity: 1.1, thresholds: { jumpVel: 1.2 } };

function run(msgs: GameMessage[], now = 0, s: MonitorState = initialState()): MonitorState {
  return msgs.reduce((acc, msg) => reduce(acc, { type: 'message', msg, now }), s);
}

describe('monitor reducer', () => {
  it('starts waiting and connects on the first game message', () => {
    const s0 = initialState();
    expect(connection(s0, 0).state).toBe('waiting');
    const s1 = run([{ kind: 'meta', t: 500, meta: META, fullRate: false }], 100);
    const c = connection(s1, 1000);
    expect(c.state).toBe('connected');
    expect(c.label).toContain('seed 42');
    expect(c.label).toContain('webcam');
    expect(s1.meta).toEqual(META);
    expect(s0.meta).toBeNull();
  });

  it('goes back to waiting 3 s after the last message, or at once on bye', () => {
    const s1 = run([{ kind: 'meta', t: 500, meta: META, fullRate: false }], 100);
    expect(connection(s1, 3100).state).toBe('connected');
    expect(connection(s1, 3200).state).toBe('waiting');
    const s2 = run([{ kind: 'bye', t: 600 }], 200, s1);
    expect(connection(s2, 300).state).toBe('waiting');
    const s3 = run([{ kind: 'game', t: 700, game: snap() }], 400, s2);
    expect(connection(s3, 500).state).toBe('connected');
  });

  it('keeps the latest frame, status and game snapshot', () => {
    const s = run([
      frameMsg(1000, 0.4),
      frameMsg(1033, 0.9),
      { kind: 'status', t: 1400, backend: 'replay', status, base: null },
      { kind: 'game', t: 1050, game: snap({ lane: 1 }) },
    ]);
    expect(s.frame!.t).toBe(1033);
    expect(s.frame!.poses[0][24].x).toBeCloseTo(synthPose({ hipX: 0.9 })[24].x, 5);
    expect(s.counts.frames).toBe(2);
    expect(s.backend).toBe('replay');
    expect(s.game!.lane).toBe(1);
    expect(stallAge(s)).toBe(400);
    expect(s.t0).toBe(1000);
  });

  it('merges pose events, commands and game events into one timeline', () => {
    const s = run([
      { kind: 'poseEvents', t: 1000, events: [{ type: 'lane', lane: 1 }, { type: 'jump' }] },
      { kind: 'commands', t: 1010, source: 'pose', commands: [{ type: 'jump' }] },
      { kind: 'commands', t: 1020, source: 'keyboard', commands: [{ type: 'shiftLane', dir: -1 }] },
      { kind: 'gameEvents', t: 1030, events: [{ type: 'caught', reason: 'idle' }, { type: 'coin' }] },
    ]);
    expect(s.timeline.map((e) => [e.kind, e.label, e.source ?? null])).toEqual([
      ['pose', 'lane → right', null],
      ['pose', 'jump', null],
      ['command', 'jump', 'pose'],
      ['command', 'shiftLane ←', 'keyboard'],
      ['game', 'caught (idle)', null],
      ['game', 'coin', null],
    ]);
    expect(s.timeline.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.timeline[4].tone).toBe('bad');
  });

  it('caps the timeline', () => {
    const many: GameMessage[] = Array.from({ length: TIMELINE_CAP + 50 }, (_, i) => ({
      kind: 'gameEvents',
      t: i,
      events: [{ type: 'coin' }],
    }));
    const s = run(many);
    expect(s.timeline).toHaveLength(TIMELINE_CAP);
    expect(s.timeline.at(-1)!.seq).toBe(TIMELINE_CAP + 50);
  });

  it('notices a restarted game tab (clock jumped back) and rebases time', () => {
    const s1 = run([{ kind: 'game', t: 90_000, game: snap() }]);
    const s2 = run([{ kind: 'game', t: 1_000, game: snap() }], 0, s1);
    expect(s2.t0).toBe(1_000);
    expect(s2.timeline.at(-1)!.label).toMatch(/restarted/);
  });

  it('resets on demand', () => {
    const s = run([{ kind: 'poseEvents', t: 1, events: [{ type: 'jump' }] }]);
    expect(reduce(s, { type: 'reset' }).timeline).toEqual([]);
  });

  it('builds a PoseStatus for the overlay from status plus the latest frame pose', () => {
    expect(poseStatusOf(initialState()).pose).toBeNull();
    const s = run([frameMsg(1000), { kind: 'status', t: 1000, backend: 'replay', status, base: null }]);
    const ps = poseStatusOf(s);
    expect(ps.calibrated).toBe(true);
    expect(ps.pose).toHaveLength(33);
  });
});

describe('monitor helpers', () => {
  it('filters the timeline by kind, with coins separately', () => {
    const s = run([
      { kind: 'poseEvents', t: 1, events: [{ type: 'jump' }] },
      { kind: 'commands', t: 2, source: 'pose', commands: [{ type: 'jump' }] },
      { kind: 'gameEvents', t: 3, events: [{ type: 'coin' }, { type: 'jump' }] },
    ]);
    const all = { pose: true, command: true, game: true, coins: true };
    expect(visibleTimeline(s.timeline, all)).toHaveLength(4);
    expect(visibleTimeline(s.timeline, { ...all, coins: false }).map((e) => e.label)).toEqual(['jump', 'jump', 'jump']);
    expect(visibleTimeline(s.timeline, { ...all, pose: false, game: false }).map((e) => e.kind)).toEqual(['command']);
  });

  it('formats relative times and idle levels', () => {
    expect(formatRel(1500, 1000)).toBe('0.500');
    expect(formatRel(62_345, 1000)).toBe('61.345');
    expect(formatRel(5, null)).toBe('—');
    expect(idleBar(500)).toEqual({ fraction: 500 / 3000, level: 'ok' });
    expect(idleBar(1000).level).toBe('warn');
    expect(idleBar(2500).level).toBe('caught');
    expect(idleBar(9000).fraction).toBe(1);
    expect(idleBar(Number.NaN).fraction).toBe(0);
  });

  it('describes every event kind', () => {
    expect(describeEntry({ kind: 'pose', event: { type: 'laneShift', dir: 1 } }).label).toBe('laneShift →');
    expect(describeEntry({ kind: 'pose', event: { type: 'lost' } }).tone).toBe('bad');
    expect(describeEntry({ kind: 'command', command: { type: 'setLane', lane: -1 } }).label).toBe('setLane left');
    expect(describeEntry({ kind: 'game', event: { type: 'state', state: 'paused' } }).label).toBe('state → paused');
    expect(describeEntry({ kind: 'game', event: { type: 'pickup', kind: 'magnet' } }).label).toBe('pickup magnet');
  });
});

describe('session recorder', () => {
  it('records full-rate frames, events and samples between start and stop', () => {
    const rec = new SessionRecorder();
    rec.push(frameMsg(900));
    expect(rec.active).toBe(false);
    rec.start({ meta: META, backend: 'replay' });
    rec.push(frameMsg(1000));
    rec.push({ kind: 'poseEvents', t: 1010, events: [{ type: 'jump' }] });
    rec.push({ kind: 'commands', t: 1011, source: 'pose', commands: [{ type: 'jump' }] });
    rec.push({ kind: 'gameEvents', t: 1012, events: [{ type: 'jump' }] });
    rec.push({ kind: 'status', t: 1020, backend: 'worker-gpu-full', status, base: null });
    rec.push({ kind: 'game', t: 1030, game: snap() });
    rec.push({ kind: 'meta', t: 1040, meta: { ...META, sensitivity: 0.9 }, fullRate: true });
    rec.push(frameMsg(1033));
    rec.push(frameMsg(1066));
    expect(rec.frameCount).toBe(3);
    expect(rec.durationMs).toBe(66);
    const out = rec.stop('lane felt slow', '2026-09-17T10:00:00.000Z');
    expect(rec.active).toBe(false);
    expect(out.startT).toBe(1000);
    expect(out.durationMs).toBe(66);
    expect(out.frames.map((f) => f.t)).toEqual([0, 33, 66]);
    expect(out.events.map((e) => [e.t, e.kind])).toEqual([
      [10, 'pose'],
      [11, 'command'],
      [12, 'game'],
    ]);
    expect(out.status).toHaveLength(1);
    expect(out.game).toHaveLength(1);
    expect(out.meta!.sensitivity).toBe(0.9);
    expect(out.backend).toBe('worker-gpu-full');
    expect(out.note).toBe('lane felt slow');
    expect(decodeSession(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });

  it('copies samples so later reused messages do not change them', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: null, backend: null });
    const g = snap({ lane: 1 });
    rec.push({ kind: 'game', t: 1, game: g });
    g.lane = -1;
    expect(rec.stop('', 'x').game[0].game.lane).toBe(1);
  });

  it('reuses landmarks the caller already decoded', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: null, backend: null });
    const poses = [synthPose({ hipX: 0.42 })];
    rec.push(frameMsg(1000), poses);
    expect(rec.stop('', 'x').frames[0].poses[0][23][0]).toBeCloseTo(poses[0][23].x, 4);
  });

  // The monitor tab also runs the game's camera; a session left recording must not grow forever.
  it('frees its buffers on stop so only the encoded recording stays resident', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: META, backend: 'replay' });
    for (let i = 0; i < 5; i++) rec.push(frameMsg(1000 + i * 33));
    rec.push({ kind: 'poseEvents', t: 1100, events: [{ type: 'jump' }] });
    rec.push({ kind: 'status', t: 1100, backend: 'replay', status, base: null });
    rec.push({ kind: 'game', t: 1100, game: snap() });
    const out = rec.stop('', 'x');
    expect(out.frames).toHaveLength(5);
    expect(out.status).toHaveLength(1);
    expect(rec.frameCount).toBe(0);
    expect(rec.eventCount).toBe(0);
    // The returned recording is independent of the (now empty) recorder.
    rec.start({ meta: META, backend: 'replay' });
    rec.push(frameMsg(9000));
    expect(out.frames).toHaveLength(5);
  });

  it('stops collecting at the frame cap and says so, and a new start clears the flag', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: META, backend: 'replay' });
    for (let i = 0; i <= MAX_RECORDING_FRAMES + 20; i++) rec.push(frameMsg(1000 + i));
    expect(rec.full).toBe(true);
    expect(rec.frameCount).toBe(MAX_RECORDING_FRAMES);
    // Nothing after the cap lands, including the duration.
    expect(rec.durationMs).toBe(MAX_RECORDING_FRAMES - 1);
    rec.push({ kind: 'poseEvents', t: 99_000, events: [{ type: 'jump' }] });
    expect(rec.eventCount).toBe(0);
    const out = rec.stop('', 'x');
    expect(out.frames).toHaveLength(MAX_RECORDING_FRAMES);
    rec.start({ meta: META, backend: 'replay' });
    expect(rec.full).toBe(false);
  });

  it('stops collecting once the recording is longer than the duration cap', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: META, backend: 'replay' });
    rec.push(frameMsg(1000));
    rec.push(frameMsg(1000 + MAX_RECORDING_MS - 1));
    expect(rec.full).toBe(false);
    rec.push(frameMsg(1000 + MAX_RECORDING_MS));
    expect(rec.full).toBe(true);
    expect(rec.frameCount).toBe(2);
    expect(rec.durationMs).toBe(MAX_RECORDING_MS - 1);
  });
});

describe('offline recording view', () => {
  function recording() {
    const rec = new SessionRecorder();
    rec.start({ meta: META, backend: 'replay' });
    for (let i = 0; i < 10; i++) rec.push(frameMsg(1000 + i * 100, 0.3 + i * 0.05));
    rec.push({ kind: 'poseEvents', t: 1150, events: [{ type: 'jump' }] });
    rec.push({ kind: 'gameEvents', t: 1450, events: [{ type: 'caught', reason: 'crash' }] });
    rec.push({ kind: 'status', t: 1200, backend: 'replay', status, base: null });
    rec.push({ kind: 'game', t: 1300, game: snap({ lane: -1 }) });
    return rec.stop('note', 'now');
  }

  it('shows the frame, samples and events at or before the scrub time', () => {
    const r = recording();
    const tl = recordingTimeline(r);
    expect(tl.map((e) => e.label)).toEqual(['jump', 'caught (crash)']);
    const v = viewAt(r, tl, 420);
    expect(v.frameIndex).toBe(4);
    expect(v.frame!.poses[0][24].x).toBeCloseTo(synthPose({ hipX: 0.5 })[24].x, 3);
    expect(v.status!.status.calibrated).toBe(true);
    expect(v.game!.game.lane).toBe(-1);
    expect(v.entries.map((e) => e.label)).toEqual(['jump']);
    const early = viewAt(r, tl, 50);
    expect(early.frameIndex).toBe(0);
    expect(early.status).toBeNull();
    expect(early.entries).toEqual([]);
    expect(viewAt(r, tl, 10_000).entries).toHaveLength(2);
  });

  it('handles an empty recording', () => {
    const rec = new SessionRecorder();
    rec.start({ meta: null, backend: null });
    const r = rec.stop('', 'now');
    const v = viewAt(r, recordingTimeline(r), 0);
    expect(v.frame).toBeNull();
    expect(v.frameIndex).toBe(-1);
  });
});

describe('monitor: move-check progress', () => {
  const msgs: GameMessage[] = [
    { kind: 'moveCheck', t: 100, mode: 'full', event: { phase: 'start', move: 'jump' } },
    { kind: 'moveCheck', t: 200, mode: 'full', event: { phase: 'result', move: 'jump', result: 'done', peak: 0.321, progress: 1 } },
    { kind: 'moveCheck', t: 300, mode: 'full', event: { phase: 'result', move: 'roll', result: 'skipped', peak: null, progress: 0.4 } },
    { kind: 'moveCheck', t: 400, mode: 'full', event: { phase: 'done', tuned: { jumpRise: 0.176 }, note: 'lopsided' } },
  ];

  it('lands on the timeline as notes, in order, and never as a filtered-out row', () => {
    const s = run(msgs, 10);
    expect(s.timeline.map((e) => e.label)).toEqual([
      'move check (full): jump — go',
      'move check: jump ✓ peak 0.321',
      'move check: roll skipped',
      'move check done — tuned jumpRise=0.176 · lopsided',
    ]);
    expect(s.timeline.map((e) => e.tone)).toEqual(['info', 'good', 'warn', 'info']);
    const hidden = visibleTimeline(s.timeline, { pose: false, command: false, game: false, coins: false });
    expect(hidden).toHaveLength(4);
  });

  it('renders whatever keys the tuning carries, however many', () => {
    // The tuned set is not fixed: the logic half derives re-arm and velocity companions, and may
    // add more. Nothing here may hard-code which keys arrive.
    const many = {
      kneeLift: 0.22,
      kneeRelease: 0.11,
      jumpRise: 0.176,
      jumpRearm: 0.088,
      jumpVel: 1.1,
      laneEnter: 0.3,
      laneExit: 0.15,
    };
    const s = run([{ kind: 'moveCheck', t: 10, mode: 'full', event: { phase: 'done', tuned: many, note: null } }], 1);
    const label = s.timeline[0].label;
    for (const key of Object.keys(many)) expect(label).toContain(key);
    // ...and an empty one says so rather than trailing off.
    const none = run([{ kind: 'moveCheck', t: 10, mode: 'small', event: { phase: 'done', tuned: {}, note: null } }], 1);
    expect(none.timeline[0].label).toBe('move check done — tuned nothing');
  });

  it('is a game message the strict check accepts, and the recorder ignores without complaint', () => {
    for (const m of msgs) expect(isGameMessage(m)).toBe(true);
    const rec = new SessionRecorder();
    rec.start({ meta: META, backend: 'worker' });
    expect(() => msgs.forEach((m) => rec.push(m))).not.toThrow();
    expect(rec.eventCount).toBe(0);
  });
});
