import { TUNING } from '../game/config';
import type { GameEvent } from '../game/game';
import type { GameCommand } from '../input/commands';
import type { Baseline } from '../pose/calibration';
import type { PlayMode, Pose, PoseEvent, PoseStatus } from '../pose/types';
import {
  CONNECTION_TIMEOUT_MS,
  decodePoses,
  readFramePoses,
  type GameMessage,
  type MoveCheckEvent,
  type GameSample,
  type GameSnapshot,
  type InputSourceName,
  type SessionMeta,
  type SessionRecording,
  type StatusSample,
  type WireStatus,
} from '../telemetry/messages';

/** DOM-free monitor logic: reducer, selectors and formatting. main.ts only renders. */

export const TIMELINE_CAP = 400;
/** The idle bar spans this many ms. */
export const IDLE_BAR_MS = 3000;
/** A game-clock jump back by more than this means the game tab reloaded. */
const RESTART_JUMP_MS = 5000;

export type TimelineKind = 'pose' | 'command' | 'game' | 'note';
export type Tone = 'move' | 'good' | 'bad' | 'warn' | 'info';

export interface TimelineEntry {
  seq: number;
  /** Game-tab clock (live) or ms since recording start (offline). */
  t: number;
  kind: TimelineKind;
  source?: InputSourceName;
  label: string;
  tone: Tone;
  /** The raw game event type, so coins can be filtered. */
  type: string;
}

export interface Filters {
  pose: boolean;
  command: boolean;
  game: boolean;
  coins: boolean;
}

export interface LiveFrame {
  t: number;
  aspect: number;
  poses: Pose[];
}

export interface MonitorState {
  /** Monitor clock of the last game message. */
  lastSeen: number | null;
  bye: boolean;
  meta: SessionMeta | null;
  fullRate: boolean;
  backend: string | null;
  status: WireStatus | null;
  /** Game-tab clock when the status was sent. */
  statusT: number | null;
  base: Baseline | null;
  frame: LiveFrame | null;
  game: GameSnapshot | null;
  gameT: number | null;
  /** First game-clock time seen: timeline stamps are relative to it. */
  t0: number | null;
  latestT: number | null;
  timeline: TimelineEntry[];
  seq: number;
  counts: { frames: number; messages: number };
}

export type Action = { type: 'message'; msg: GameMessage; now: number } | { type: 'reset' };

export function initialState(): MonitorState {
  return {
    lastSeen: null,
    bye: false,
    meta: null,
    fullRate: false,
    backend: null,
    status: null,
    statusT: null,
    base: null,
    frame: null,
    game: null,
    gameT: null,
    t0: null,
    latestT: null,
    timeline: [],
    seq: 0,
    counts: { frames: 0, messages: 0 },
  };
}

const LANE_NAMES = ['left', 'centre', 'right'];
const arrow = (dir: number) => (dir < 0 ? '←' : '→');

export type Describable =
  | { kind: 'pose'; event: PoseEvent }
  | { kind: 'command'; command: GameCommand }
  | { kind: 'game'; event: GameEvent };

export function describeEntry(d: Describable): { label: string; tone: Tone; type: string } {
  if (d.kind === 'pose') {
    const e = d.event;
    const label = e.type === 'lane' ? `lane → ${LANE_NAMES[e.lane + 1]}` : e.type === 'laneShift' ? `laneShift ${arrow(e.dir)}` : e.type;
    const tone: Tone = e.type === 'lost' ? 'bad' : e.type === 'found' || e.type === 'start' || e.type === 'hoverboard' ? 'good' : 'move';
    return { label, tone, type: e.type };
  }
  if (d.kind === 'command') {
    const c = d.command;
    const label = c.type === 'setLane' ? `setLane ${LANE_NAMES[c.lane + 1]}` : c.type === 'shiftLane' ? `shiftLane ${arrow(c.dir)}` : c.type;
    const tone: Tone = c.type === 'pause' ? 'warn' : c.type === 'start' || c.type === 'hoverboard' ? 'good' : 'move';
    return { label, tone, type: c.type };
  }
  const e = d.event;
  switch (e.type) {
    case 'state':
      return { label: `state → ${e.state}`, tone: e.state === 'paused' ? 'warn' : e.state === 'caught' ? 'bad' : 'info', type: e.type };
    case 'caught':
      return { label: `caught (${e.reason})`, tone: 'bad', type: e.type };
    case 'pickup':
      return { label: `pickup ${e.kind}`, tone: 'good', type: e.type };
    case 'stumble':
      return { label: e.type, tone: 'bad', type: e.type };
    case 'hoverboard':
    case 'hoverboardSaved':
    case 'rocketLanding':
      return { label: e.type, tone: 'good', type: e.type };
    case 'coin':
      return { label: e.type, tone: 'info', type: e.type };
    default:
      return { label: e.type, tone: 'move', type: e.type };
  }
}

/** Move-check progress, as one timeline note. Notes are never filtered out. */
export function describeMoveCheck(mode: PlayMode, e: MoveCheckEvent): { label: string; tone: Tone } {
  if (e.phase === 'start') return { label: `move check (${mode}): ${e.move} — go`, tone: 'info' };
  if (e.phase === 'result') {
    const peak = e.peak === null ? '' : ` peak ${e.peak.toFixed(3)}`;
    return { label: `move check: ${e.move} ${e.result === 'done' ? '✓' : 'skipped'}${peak}`, tone: e.result === 'done' ? 'good' : 'warn' };
  }
  const keys = Object.keys(e.tuned).sort();
  const tuned = keys.length ? keys.map((k) => `${k}=${e.tuned[k].toFixed(3)}`).join(' ') : 'nothing';
  return { label: `move check done — tuned ${tuned}${e.note ? ` · ${e.note}` : ''}`, tone: 'info' };
}

function entriesOf(msg: GameMessage, seq: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const t = msg.t;
  if (msg.kind === 'moveCheck') out.push({ seq: ++seq, t, kind: 'note', type: `moveCheck:${msg.event.phase}`, ...describeMoveCheck(msg.mode, msg.event) });
  else if (msg.kind === 'poseEvents') for (const event of msg.events) out.push({ seq: ++seq, t, kind: 'pose', ...describeEntry({ kind: 'pose', event }) });
  else if (msg.kind === 'gameEvents') for (const event of msg.events) out.push({ seq: ++seq, t, kind: 'game', ...describeEntry({ kind: 'game', event }) });
  else if (msg.kind === 'commands') {
    for (const command of msg.commands) {
      out.push({ seq: ++seq, t, kind: 'command', source: msg.source, ...describeEntry({ kind: 'command', command }) });
    }
  }
  return out;
}

function appendCapped<T>(list: T[], items: T[], cap: number): T[] {
  if (!items.length) return list;
  const next = list.concat(items);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function reduce(s: MonitorState, a: Action): MonitorState {
  if (a.type === 'reset') return { ...initialState(), meta: s.meta, backend: s.backend, lastSeen: s.lastSeen, bye: s.bye };
  const { msg, now } = a;
  const next: MonitorState = { ...s, lastSeen: now, bye: false, counts: { ...s.counts, messages: s.counts.messages + 1 } };

  let notes: TimelineEntry[] = [];
  if (s.latestT !== null && msg.t < s.latestT - RESTART_JUMP_MS) {
    next.t0 = msg.t;
    next.seq++;
    notes = [{ seq: next.seq, t: msg.t, kind: 'note', label: 'game tab restarted', tone: 'warn', type: 'restart' }];
    next.frame = null;
    next.game = null;
    next.status = null;
    next.latestT = msg.t;
  } else {
    next.t0 ??= msg.t;
    next.latestT = s.latestT === null ? msg.t : Math.max(s.latestT, msg.t);
  }

  switch (msg.kind) {
    case 'frame':
      next.frame = { t: msg.t, aspect: msg.aspect, poses: readFramePoses(msg) };
      next.counts.frames++;
      break;
    case 'status':
      next.status = msg.status;
      next.statusT = msg.t;
      next.backend = msg.backend;
      next.base = msg.base;
      break;
    case 'game':
      next.game = msg.game;
      next.gameT = msg.t;
      break;
    case 'meta':
      next.meta = msg.meta ?? s.meta;
      next.fullRate = msg.fullRate;
      break;
    case 'bye':
      next.bye = true;
      break;
    default:
      break;
  }
  const items = entriesOf(msg, next.seq);
  next.seq += items.length;
  next.timeline = appendCapped(s.timeline, notes.length ? notes.concat(items) : items, TIMELINE_CAP);
  return next;
}

export interface Connection {
  state: 'waiting' | 'connected';
  label: string;
}

export function connection(s: MonitorState, now: number): Connection {
  if (s.lastSeen === null || s.bye || now - s.lastSeen > CONNECTION_TIMEOUT_MS) {
    return { state: 'waiting', label: s.bye ? 'game tab closed — waiting for game tab' : 'waiting for game tab' };
  }
  const m = s.meta;
  const parts = ['connected'];
  if (m) parts.push(`seed ${m.seed}`, m.difficulty, `input ${m.input}`, `mode ${m.mode ?? 'auto'}`);
  return { state: 'connected', label: parts.join(' · ') };
}

/** How long before the status was sent the last pose frame arrived. */
export function stallAge(s: MonitorState): number | null {
  const last = s.status?.lastFrameT;
  return s.statusT === null || last === null || last === undefined ? null : Math.max(0, s.statusT - last);
}

export function visibleTimeline(list: readonly TimelineEntry[], f: Filters): TimelineEntry[] {
  return list.filter((e) => isVisible(e, f));
}

export function isVisible(e: TimelineEntry, f: Filters): boolean {
  if (e.kind === 'note') return true;
  if (e.kind === 'game' && e.type === 'coin') return f.game && f.coins;
  return f[e.kind];
}

export function formatRel(t: number, t0: number | null): string {
  return t0 === null ? '—' : ((t - t0) / 1000).toFixed(3);
}

export function idleBar(idleMs: number): { fraction: number; level: 'ok' | 'warn' | 'caught' } {
  if (!Number.isFinite(idleMs) || idleMs < 0) return { fraction: 0, level: 'ok' };
  const level = idleMs >= TUNING.idleCaughtMs ? 'caught' : idleMs >= TUNING.idleWarnMs ? 'warn' : 'ok';
  return { fraction: Math.min(1, idleMs / IDLE_BAR_MS), level };
}

const IDLE_STATUS: WireStatus = {
  tracking: false,
  calibrated: false,
  mode: null,
  lane: 0,
  poseFps: 0,
  confidence: 0,
  jog: { active: false, cadenceSpm: 0, msSinceStep: Infinity, steps: 0 },
  startProgress: 0,
  calibration: { progress: 0, bodyVisible: false, distance: 'ok' },
  lastFrameT: null,
  squatting: false,
  slowPose: false,
};

export function toPoseStatus(status: WireStatus | null, pose: Pose | null): PoseStatus {
  return { ...(status ?? IDLE_STATUS), pose };
}

export function poseStatusOf(s: MonitorState): PoseStatus {
  return toPoseStatus(s.status, s.frame?.poses[0] ?? null);
}

// ---- offline recordings ---------------------------------------------------------------------

export function recordingTimeline(rec: SessionRecording): TimelineEntry[] {
  return rec.events.map((e, i) => {
    const d: Describable = e.kind === 'command' ? { kind: 'command', command: e.command } : e.kind === 'pose' ? { kind: 'pose', event: e.event } : { kind: 'game', event: e.event };
    return { seq: i + 1, t: e.t, kind: e.kind, source: e.kind === 'command' ? e.source : undefined, ...describeEntry(d) };
  });
}

/** Index of the last item with t ≤ time, or -1. */
export function lastAtOrBefore(list: readonly { t: number }[], time: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export interface RecordingView {
  frameIndex: number;
  frame: LiveFrame | null;
  status: StatusSample | null;
  game: GameSample | null;
  /** Timeline entries up to the scrub time (the most recent `limit`). */
  entries: TimelineEntry[];
}

export function viewAt(rec: SessionRecording, timeline: readonly TimelineEntry[], time: number, limit = TIMELINE_CAP): RecordingView {
  let fi = lastAtOrBefore(rec.frames, time);
  if (fi < 0 && rec.frames.length) fi = 0;
  const f = fi >= 0 ? rec.frames[fi] : null;
  const si = lastAtOrBefore(rec.status, time);
  const gi = lastAtOrBefore(rec.game, time);
  const ei = lastAtOrBefore(timeline, time);
  return {
    frameIndex: fi,
    frame: f ? { t: f.t, aspect: rec.aspect, poses: decodePoses(f.poses) } : null,
    status: si >= 0 ? rec.status[si] : null,
    game: gi >= 0 ? rec.game[gi] : null,
    entries: timeline.slice(Math.max(0, ei + 1 - limit), ei + 1),
  };
}
