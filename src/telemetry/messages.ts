import type { GameCommand } from '../input/commands';
import type { CaughtReason, GameEvent, GameState } from '../game/game';
import type { IdleLevel } from '../game/rules';
import type { Baseline } from '../pose/calibration';
import type { PoseFixture } from '../pose/fixtures';
import type { MoveId, MoveTuning } from '../pose/moveCheckTypes';
import type { Lane, PlayMode, Pose, PoseEvent, PoseFrame, PoseStatus } from '../pose/types';

/** BroadcastChannel shared by the game tab and the monitor tab. */
export const CHANNEL_NAME = 'subway-irl';
/** The monitor says hello this often. */
export const HELLO_INTERVAL_MS = 1000;
/** A peer is considered gone after this long without a message. */
export const CONNECTION_TIMEOUT_MS = 3000;
export const LANDMARKS = 33;
const FIELDS = 4;

export type InputSourceName = 'pose' | 'keyboard' | 'autopilot';
export const INPUT_SOURCES: readonly InputSourceName[] = ['pose', 'keyboard', 'autopilot'];

/** PoseStatus without the landmark array (frames carry landmarks). */
export type WireStatus = Omit<PoseStatus, 'pose'>;

export interface SessionMeta {
  seed: number;
  difficulty: string;
  input: string;
  mode: string | null;
  sensitivity: number;
  /** The thresholds actually in force, move tuning already applied. A replay plays with these. */
  thresholds: Record<string, number>;
  /** The move-check record behind those thresholds, when there is one. */
  moveTuning?: MoveTuning | null;
}

export interface GameSnapshot {
  state: GameState;
  s: number;
  speed: number;
  lane: Lane;
  /** Runner feet height. */
  y: number;
  rolling: boolean;
  airborne: boolean;
  flying: boolean;
  idleLevel: IdleLevel;
  idleMs: number;
  countdown: number;
  /** Seconds of play in the current run. */
  time: number;
  josh: { value: number; active: boolean };
  powerups: { magnet: number; rocket: number; chappal: number; hoverboard: number; grace: number; hoverboardsLeft: number };
  pausedByLoss: boolean;
  caughtReason: CaughtReason | null;
  coins: number;
  score: number;
}

// ---- game → monitor -------------------------------------------------------------------------

/** Landmarks of `count` poses, flattened as [x, y, z, visibility] × 33 per pose. */
export interface FrameMsg {
  kind: 'frame';
  t: number;
  aspect: number;
  count: number;
  data: Float32Array;
}
export interface StatusMsg {
  kind: 'status';
  /** Game-tab clock when sent (same clock as frame t), so the monitor can age lastFrameT. */
  t: number;
  backend: string;
  status: WireStatus;
  /** Calibration baseline, for the skeleton guide lines. */
  base: Baseline | null;
}
export interface PoseEventsMsg {
  kind: 'poseEvents';
  t: number;
  events: PoseEvent[];
}
export interface CommandsMsg {
  kind: 'commands';
  t: number;
  source: InputSourceName;
  commands: GameCommand[];
}
export interface GameEventsMsg {
  kind: 'gameEvents';
  t: number;
  events: GameEvent[];
}
export interface GameMsg {
  kind: 'game';
  t: number;
  game: GameSnapshot;
}
export interface MetaMsg {
  kind: 'meta';
  t: number;
  meta: SessionMeta | null;
  /** True while the game is sending every frame (a monitor is recording). */
  fullRate: boolean;
}
export interface ByeMsg {
  kind: 'bye';
  t: number;
}

/**
 * Move-check progress (spec "Telemetry"): each step's start, its result with the peak that was
 * measured, and the tuned values once the check is over.
 */
export type MoveCheckEvent =
  | { phase: 'start'; move: MoveId }
  | { phase: 'result'; move: MoveId; result: 'done' | 'skipped'; peak: number | null; progress: number }
  | { phase: 'done'; tuned: Record<string, number>; note: string | null };

export interface MoveCheckMsg {
  kind: 'moveCheck';
  t: number;
  mode: PlayMode;
  event: MoveCheckEvent;
}

export type GameMessage =
  | FrameMsg
  | StatusMsg
  | PoseEventsMsg
  | CommandsMsg
  | GameEventsMsg
  | GameMsg
  | MetaMsg
  | MoveCheckMsg
  | ByeMsg;

// ---- monitor → game -------------------------------------------------------------------------

export interface HelloMsg {
  kind: 'hello';
  /** Random per monitor tab. */
  id: string;
  /** Asks the game for full-rate frames. */
  recording: boolean;
}

export type ControlMessage =
  | { kind: 'setSensitivity'; value: number }
  | { kind: 'setThreshold'; key: string; value: number }
  | { kind: 'recalibrate' }
  | { kind: 'forceMode'; mode: PlayMode | null };

export type MonitorMessage = HelloMsg | ControlMessage;

const GAME_KINDS = new Set<string>(['frame', 'status', 'poseEvents', 'commands', 'gameEvents', 'game', 'meta', 'moveCheck', 'bye']);

type Rec = Record<string, unknown>;
const isObj = (x: unknown): x is Rec => typeof x === 'object' && x !== null;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * A move-check event the monitor can render without checking every field again. The other kinds
 * are trusted on their `kind` alone, but this one carries numbers the monitor formats directly.
 */
function isMoveCheckEvent(e: unknown): boolean {
  if (!isObj(e)) return false;
  switch (e.phase) {
    case 'start':
      return typeof e.move === 'string';
    case 'result':
      return (
        typeof e.move === 'string' &&
        (e.result === 'done' || e.result === 'skipped') &&
        (e.peak === null || isNum(e.peak)) &&
        isNum(e.progress)
      );
    case 'done':
      return isObj(e.tuned) && (e.note === null || typeof e.note === 'string');
    default:
      return false;
  }
}

export function isGameMessage(x: unknown): x is GameMessage {
  if (!isObj(x) || typeof x.kind !== 'string' || !GAME_KINDS.has(x.kind)) return false;
  if (x.kind !== 'moveCheck') return true;
  return (x.mode === 'full' || x.mode === 'small') && isMoveCheckEvent(x.event);
}

export function isControlMessage(x: unknown): x is ControlMessage {
  if (!isObj(x)) return false;
  switch (x.kind) {
    case 'setSensitivity':
      return isNum(x.value);
    case 'setThreshold':
      return typeof x.key === 'string' && isNum(x.value);
    case 'recalibrate':
      return true;
    case 'forceMode':
      return x.mode === null || x.mode === 'full' || x.mode === 'small';
    default:
      return false;
  }
}

export function isMonitorMessage(x: unknown): x is MonitorMessage {
  if (isObj(x) && x.kind === 'hello') return typeof x.id === 'string' && typeof x.recording === 'boolean';
  return isControlMessage(x);
}

// ---- landmark encoding ----------------------------------------------------------------------

/** Writes poses into `out` (length ≥ poses.length × 132). */
export function writeFrameData(poses: readonly Pose[], out: Float32Array): void {
  let o = 0;
  for (const pose of poses) {
    for (let i = 0; i < LANDMARKS; i++) {
      const l = pose[i];
      out[o++] = l.x;
      out[o++] = l.y;
      out[o++] = l.z;
      out[o++] = l.visibility;
    }
  }
}

export function readFramePoses(msg: FrameMsg): Pose[] {
  const d = msg.data;
  const poses: Pose[] = [];
  for (let p = 0; p < msg.count; p++) {
    const pose: Pose = [];
    const base = p * LANDMARKS * FIELDS;
    for (let i = 0; i < LANDMARKS; i++) {
      const o = base + i * FIELDS;
      pose.push({ x: d[o], y: d[o + 1], z: d[o + 2], visibility: d[o + 3] });
    }
    poses.push(pose);
  }
  return poses;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** Relative times keep 0.1 ms. */
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Same compact form as src/pose/fixtures.ts: [x, y, z, visibility] with 4 decimals. */
export function encodePoses(poses: readonly Pose[]): number[][][] {
  return poses.map((p) => p.map((l) => [r4(l.x), r4(l.y), r4(l.z), r4(l.visibility)]));
}

export function decodePoses(poses: number[][][]): Pose[] {
  return poses.map((p) => p.map(([x, y, z, visibility]) => ({ x, y, z, visibility })));
}

// ---- session recording ----------------------------------------------------------------------

export type RecordedEvent =
  | { t: number; kind: 'pose'; event: PoseEvent }
  | { t: number; kind: 'command'; source: InputSourceName; command: GameCommand }
  | { t: number; kind: 'game'; event: GameEvent };

export interface StatusSample {
  t: number;
  backend: string;
  status: WireStatus;
  base: Baseline | null;
}

export interface GameSample {
  t: number;
  game: GameSnapshot;
}

/** A recorded play session. All `t` are ms since `startT` (the game-tab clock at record start). */
export interface SessionRecording {
  version: 1;
  format: 'subway-irl-session';
  createdAt: string;
  note: string;
  meta: SessionMeta | null;
  backend: string | null;
  aspect: number;
  startT: number;
  durationMs: number;
  /** Every pose frame, full rate. */
  frames: { t: number; poses: number[][][] }[];
  events: RecordedEvent[];
  /** Pose status, ~10 Hz. */
  status: StatusSample[];
  /** Game snapshots, ~10 Hz. */
  game: GameSample[];
}

export interface SessionInput {
  note: string;
  createdAt: string;
  meta: SessionMeta | null;
  backend: string | null;
  /** Absolute game-tab times. */
  startT: number;
  endT: number;
  frames: readonly PoseFrame[];
  events: readonly RecordedEvent[];
  status: readonly StatusSample[];
  game: readonly GameSample[];
}

export function encodeSession(s: SessionInput): SessionRecording {
  const rel = (t: number) => r1(t - s.startT);
  return {
    version: 1,
    format: 'subway-irl-session',
    createdAt: s.createdAt,
    note: s.note,
    meta: s.meta,
    backend: s.backend,
    aspect: s.frames[0]?.aspect ?? 4 / 3,
    startT: s.startT,
    durationMs: r1(s.endT - s.startT),
    frames: s.frames.map((f) => ({ t: rel(f.t), poses: encodePoses(f.poses) })),
    events: s.events.map((e) => ({ ...e, t: rel(e.t) })),
    status: s.status.map((x) => ({ ...x, t: rel(x.t) })),
    game: s.game.map((x) => ({ ...x, t: rel(x.t) })),
  };
}

function fail(msg: string): never {
  throw new Error(`Invalid session recording: ${msg}`);
}

const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isStr = (x: unknown): x is string => typeof x === 'string';
/** JSON turns Infinity/NaN into null, so every "ms" field may legitimately arrive as null. */
const isNumOrNull = (x: unknown): boolean => x === null || isNum(x);

type Check = (v: unknown) => boolean;

function checkShape(x: unknown, where: string, spec: Record<string, Check>): Rec {
  if (!isObj(x)) fail(`${where} must be an object`);
  for (const key of Object.keys(spec)) {
    if (!spec[key](x[key])) fail(`${where}.${key} is missing or invalid`);
  }
  return x;
}

const STATUS_SHAPE: Record<string, Check> = {
  tracking: isBool,
  calibrated: isBool,
  mode: (v) => v === null || v === 'full' || v === 'small',
  lane: isNum,
  poseFps: isNum,
  confidence: isNum,
  startProgress: isNum,
  lastFrameT: isNumOrNull,
  squatting: isBool,
  slowPose: isBool,
};
const JOG_SHAPE: Record<string, Check> = { active: isBool, cadenceSpm: isNum, msSinceStep: isNumOrNull, steps: isNum };
const CALIBRATION_SHAPE: Record<string, Check> = { progress: isNum, bodyVisible: isBool, distance: isStr };

/** Every field `renderPose` reads, so a stale recording fails to load instead of killing the monitor. */
function checkStatus(x: unknown, where: string): void {
  const s = checkShape(x, where, STATUS_SHAPE);
  checkShape(s.jog, `${where}.jog`, JOG_SHAPE);
  checkShape(s.calibration, `${where}.calibration`, CALIBRATION_SHAPE);
}

const GAME_SHAPE: Record<string, Check> = {
  state: isStr,
  s: isNum,
  speed: isNum,
  lane: isNum,
  y: isNum,
  rolling: isBool,
  airborne: isBool,
  flying: isBool,
  idleLevel: isStr,
  idleMs: isNumOrNull,
  countdown: isNum,
  time: isNum,
  pausedByLoss: isBool,
  caughtReason: (v) => v === null || isStr(v),
  coins: isNum,
  score: isNum,
};
const JOSH_SHAPE: Record<string, Check> = { value: isNum, active: isBool };
const POWERUP_SHAPE: Record<string, Check> = {
  magnet: isNum,
  rocket: isNum,
  chappal: isNum,
  hoverboard: isNum,
  grace: isNum,
  hoverboardsLeft: isNum,
};

const META_SHAPE: Record<string, Check> = {
  seed: isNum,
  difficulty: isStr,
  input: isStr,
  mode: (v) => v === null || isStr(v),
  sensitivity: isNum,
};

/** `syncControls` calls `meta.sensitivity.toFixed`, so a half-written meta must not load. */
function checkMeta(x: unknown): void {
  const m = checkShape(x, 'meta', META_SHAPE);
  if (m.thresholds === undefined) m.thresholds = {};
  else if (!isObj(m.thresholds)) fail('meta.thresholds must be an object');
}

/** Every field `renderGame` reads. */
function checkSnapshot(x: unknown, where: string): void {
  const g = checkShape(x, where, GAME_SHAPE);
  checkShape(g.josh, `${where}.josh`, JOSH_SHAPE);
  checkShape(g.powerups, `${where}.powerups`, POWERUP_SHAPE);
}

function checkTimed(list: unknown, name: string, each: (x: Rec, i: number) => void): void {
  if (!Array.isArray(list)) fail(`${name} must be an array`);
  let prev = -Infinity;
  list.forEach((x: unknown, i) => {
    if (!isObj(x) || !isNum(x.t)) fail(`${name}[${i}] needs a numeric t`);
    if (x.t < prev) fail(`${name} out of order at ${i}`);
    prev = x.t;
    each(x, i);
  });
}

/** Validates parsed JSON and returns it as a SessionRecording; throws with a reason otherwise. */
export function decodeSession(json: unknown): SessionRecording {
  if (!isObj(json)) fail('expected an object');
  if (json.version !== 1) fail(`unsupported version ${String(json.version)}`);
  if (json.format !== 'subway-irl-session') fail(`unknown format ${String(json.format)}`);
  if (typeof json.note !== 'string') fail('note must be a string');
  if (!isNum(json.aspect) || json.aspect <= 0) fail('aspect must be a positive number');
  if (!isNum(json.startT) || !isNum(json.durationMs)) fail('startT and durationMs must be numbers');
  if (json.meta !== null && json.meta !== undefined) checkMeta(json.meta);
  checkTimed(json.frames, 'frames', (f, i) => {
    if (!Array.isArray(f.poses)) fail(`frames[${i}].poses must be an array`);
    for (const p of f.poses as unknown[]) {
      if (!Array.isArray(p) || p.length !== LANDMARKS) fail(`frames[${i}] pose needs ${LANDMARKS} landmarks`);
      for (const l of p as unknown[]) {
        if (!Array.isArray(l) || l.length !== FIELDS || !l.every(isNum)) fail(`frames[${i}] has a bad landmark`);
      }
    }
  });
  checkTimed(json.events, 'events', (e, i) => {
    const ok =
      ((e.kind === 'pose' || e.kind === 'game') && isObj(e.event) && typeof e.event.type === 'string') ||
      (e.kind === 'command' && isObj(e.command) && typeof e.command.type === 'string' && INPUT_SOURCES.includes(e.source as InputSourceName));
    if (!ok) fail(`events[${i}] is not a pose, command or game event`);
  });
  const status = json.status ?? [];
  const game = json.game ?? [];
  checkTimed(status, 'status', (x, i) => {
    checkStatus(x.status, `status[${i}].status`);
    if (x.base !== null && x.base !== undefined && !isObj(x.base)) fail(`status[${i}].base must be an object or null`);
    if (x.backend === undefined) x.backend = '';
    else if (!isStr(x.backend)) fail(`status[${i}].backend must be a string`);
  });
  checkTimed(game, 'game', (x, i) => checkSnapshot(x.game, `game[${i}].game`));
  return {
    version: 1,
    format: 'subway-irl-session',
    createdAt: typeof json.createdAt === 'string' ? json.createdAt : '',
    note: json.note,
    meta: (json.meta ?? null) as SessionMeta | null,
    backend: typeof json.backend === 'string' ? json.backend : null,
    aspect: json.aspect,
    startT: json.startT,
    durationMs: json.durationMs,
    frames: json.frames as SessionRecording['frames'],
    events: json.events as RecordedEvent[],
    status: status as StatusSample[],
    game: game as GameSample[],
  };
}

/** The pose frames of a session as a replay fixture (for ReplayPoseSource / `?session=`). */
export function sessionToFixture(rec: SessionRecording, name = `session-${rec.createdAt || 'recording'}`): PoseFixture {
  return { version: 1, name, note: rec.note, aspect: rec.aspect, frames: rec.frames };
}

/** File name for a download, e.g. session-2026-09-17T10-00-00.json. */
export function sessionFileName(createdAt: string): string {
  return `session-${createdAt.replace(/\.\d+Z$/, '').replace(/[:]/g, '-')}.json`;
}
