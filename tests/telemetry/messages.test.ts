import { describe, expect, it } from 'vitest';
import {
  decodeSession,
  encodeSession,
  isControlMessage,
  isGameMessage,
  isMonitorMessage,
  readFramePoses,
  sessionToFixture,
  writeFrameData,
  type GameSnapshot,
  type SessionRecording,
  type WireStatus,
} from '../../src/telemetry/messages';
import { decodeFixture } from '../../src/pose/fixtures';
import { synthPose } from '../helpers/synth';

const status: WireStatus = {
  tracking: true,
  calibrated: true,
  mode: 'full',
  lane: 1,
  poseFps: 30,
  confidence: 0.9,
  jog: { active: true, cadenceSpm: 150, msSinceStep: 120, steps: 12 },
  startProgress: 0,
  calibration: { progress: 1, bodyVisible: true, distance: 'ok' },
  lastFrameT: 1000,
  squatting: false,
  slowPose: false,
};

const snapshot: GameSnapshot = {
  state: 'playing',
  s: 12.5,
  speed: 9,
  lane: 0,
  y: 0,
  rolling: false,
  airborne: false,
  flying: false,
  idleLevel: 'ok',
  idleMs: 200,
  countdown: 0,
  time: 3,
  josh: { value: 0.5, active: false },
  powerups: { magnet: 0, rocket: 0, chappal: 2, hoverboard: 0, grace: 0, hoverboardsLeft: 3 },
  pausedByLoss: false,
  caughtReason: null,
  coins: 4,
  score: 16,
};

describe('frame wire encoding', () => {
  it('packs poses into a flat Float32Array and reads them back', () => {
    const poses = [synthPose(), synthPose({ hipX: 0.3 })];
    const buf = new Float32Array(33 * 4 * 2);
    writeFrameData(poses, buf);
    const back = readFramePoses({ kind: 'frame', t: 5, aspect: 4 / 3, count: 2, data: buf });
    expect(back).toHaveLength(2);
    expect(back[1][24].x).toBeCloseTo(poses[1][24].x, 5);
    expect(back[0][0].visibility).toBeCloseTo(poses[0][0].visibility, 5);
  });

  it('reads an empty frame as no poses', () => {
    expect(readFramePoses({ kind: 'frame', t: 5, aspect: 1, count: 0, data: new Float32Array(0) })).toEqual([]);
  });
});

describe('message guards', () => {
  it('recognises game → monitor messages', () => {
    expect(isGameMessage({ kind: 'game', t: 1, game: snapshot })).toBe(true);
    expect(isGameMessage({ kind: 'status', t: 1, backend: 'replay', status, base: null })).toBe(true);
    expect(isGameMessage({ kind: 'hello', id: 'a', recording: false })).toBe(false);
    expect(isGameMessage(null)).toBe(false);
    expect(isGameMessage({ kind: 'nope' })).toBe(false);
  });

  it('recognises monitor → game messages and control messages', () => {
    expect(isMonitorMessage({ kind: 'hello', id: 'a', recording: true })).toBe(true);
    expect(isMonitorMessage({ kind: 'recalibrate' })).toBe(true);
    expect(isControlMessage({ kind: 'hello', id: 'a', recording: true })).toBe(false);
    expect(isControlMessage({ kind: 'setSensitivity', value: 1.1 })).toBe(true);
    expect(isControlMessage({ kind: 'setSensitivity', value: 'x' })).toBe(false);
    expect(isControlMessage({ kind: 'setThreshold', key: 'jumpVel', value: 1.4 })).toBe(true);
    expect(isControlMessage({ kind: 'setThreshold', key: 'jumpVel', value: Number.NaN })).toBe(false);
    expect(isControlMessage({ kind: 'forceMode', mode: 'small' })).toBe(true);
    expect(isControlMessage({ kind: 'forceMode', mode: null })).toBe(true);
    expect(isControlMessage({ kind: 'forceMode', mode: 'huge' })).toBe(false);
    expect(isControlMessage({ kind: 'frame' })).toBe(false);
  });
});

function sample(): SessionRecording {
  const pose = synthPose();
  return encodeSession({
    note: 'jump did not fire',
    createdAt: '2026-09-17T10:00:00.000Z',
    meta: { seed: 42, difficulty: 'cardio', input: 'webcam', mode: 'full', sensitivity: 1, thresholds: { jumpVel: 1.5 } },
    backend: 'worker-gpu-full',
    startT: 10_000,
    endT: 12_500,
    frames: [
      { t: 10_010, aspect: 4 / 3, poses: [pose] },
      { t: 10_043.3, aspect: 4 / 3, poses: [] },
    ],
    events: [
      { t: 10_020, kind: 'pose', event: { type: 'jump' } },
      { t: 10_021, kind: 'command', source: 'pose', command: { type: 'jump' } },
      { t: 10_030, kind: 'game', event: { type: 'caught', reason: 'idle' } },
    ],
    status: [{ t: 10_050, backend: 'worker-gpu-full', status, base: null }],
    game: [{ t: 10_060, game: snapshot }],
  });
}

describe('SessionRecording', () => {
  it('stores timestamps relative to the recording start with 4-decimal landmarks', () => {
    const rec = sample();
    expect(rec.version).toBe(1);
    expect(rec.format).toBe('subway-irl-session');
    expect(rec.durationMs).toBe(2500);
    expect(rec.aspect).toBeCloseTo(4 / 3);
    expect(rec.frames.map((f) => f.t)).toEqual([10, 43.3]);
    const x = rec.frames[0].poses[0][0][0];
    expect(Math.round(x * 1e4) / 1e4).toBe(x);
    expect(rec.events.map((e) => e.t)).toEqual([20, 21, 30]);
    expect(rec.status[0].t).toBe(50);
    expect(rec.game[0].t).toBe(60);
  });

  it('round-trips through JSON', () => {
    const rec = sample();
    const back = decodeSession(JSON.parse(JSON.stringify(rec)));
    expect(back).toEqual(rec);
  });

  it('rejects malformed recordings with a reason', () => {
    const good = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
    expect(() => decodeSession(null)).toThrow(/object/);
    expect(() => decodeSession({ ...good, version: 2 })).toThrow(/version/);
    expect(() => decodeSession({ ...good, format: 'other' })).toThrow(/format/);
    expect(() => decodeSession({ ...good, frames: 'x' })).toThrow(/frames/);
    expect(() => decodeSession({ ...good, frames: [{ t: 0, poses: [[[1, 2, 3]]] }] })).toThrow(/landmark/);
    expect(() => decodeSession({ ...good, frames: [{ t: 5, poses: [] }, { t: 1, poses: [] }] })).toThrow(/order/);
    expect(() => decodeSession({ ...good, events: [{ t: 0, kind: 'weird' }] })).toThrow(/event/);
    expect(() => decodeSession({ ...good, note: 3 })).toThrow(/note/);
  });

  it('fills optional sample arrays when absent', () => {
    const good = JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;
    delete good.status;
    delete good.game;
    const back = decodeSession(good);
    expect(back.status).toEqual([]);
    expect(back.game).toEqual([]);
  });

  it('converts to a pose fixture the replay source can play', () => {
    const fx = sessionToFixture(sample());
    const frames = decodeFixture(fx);
    expect(fx.name).toMatch(/session/);
    expect(frames).toHaveLength(2);
    expect(frames[0].t).toBe(10);
    expect(frames[0].poses[0]).toHaveLength(33);
  });
});
