import type { PoseFrame } from '../pose/types';
import {
  encodeSession,
  readFramePoses,
  type GameMessage,
  type GameSample,
  type RecordedEvent,
  type SessionMeta,
  type SessionRecording,
  type StatusSample,
} from '../telemetry/messages';

const byT = (a: { t: number }, b: { t: number }) => a.t - b.t;

/**
 * Caps, so a monitor left recording overnight cannot eat the tab: a pose frame is 33 landmarks
 * (~0.5 MB of JSON per minute at full rate), and saving stringifies the whole recording at once.
 */
export const MAX_RECORDING_MS = 10 * 60_000;
export const MAX_RECORDING_FRAMES = 20_000;
export const MAX_RECORDING_EVENTS = 20_000;
export const MAX_RECORDING_SAMPLES = 20_000;

/** Collects game messages between start() and stop() into a SessionRecording. */
export class SessionRecorder {
  active = false;
  /** True once a cap was hit: nothing more is collected, the UI asks the user to stop and save. */
  full = false;
  private meta: SessionMeta | null = null;
  private backend: string | null = null;
  private startT: number | null = null;
  private endT: number | null = null;
  private frames: PoseFrame[] = [];
  private events: RecordedEvent[] = [];
  private status: StatusSample[] = [];
  private game: GameSample[] = [];

  get frameCount(): number {
    return this.frames.length;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** Game-clock span covered so far. */
  get durationMs(): number {
    return this.startT === null || this.endT === null ? 0 : this.endT - this.startT;
  }

  start(init: { meta: SessionMeta | null; backend: string | null }): void {
    this.active = true;
    this.full = false;
    this.meta = init.meta;
    this.backend = init.backend;
    this.startT = this.endT = null;
    this.clear();
  }

  private clear(): void {
    this.frames = [];
    this.events = [];
    this.status = [];
    this.game = [];
  }

  /** True once any cap is reached; collection then stops until the next start(). */
  private capped(t: number): boolean {
    if (this.full) return true;
    this.full =
      this.frames.length >= MAX_RECORDING_FRAMES ||
      this.events.length >= MAX_RECORDING_EVENTS ||
      this.status.length + this.game.length >= MAX_RECORDING_SAMPLES ||
      (this.startT !== null && t - this.startT >= MAX_RECORDING_MS);
    return this.full;
  }

  /** `poses` lets the caller hand over landmarks it already decoded; it must not mutate them after. */
  push(msg: GameMessage, poses?: PoseFrame['poses']): void {
    if (!this.active) return;
    const t = msg.t;
    this.startT ??= t;
    if (this.capped(t)) return;
    this.endT = this.endT === null ? t : Math.max(this.endT, t);
    switch (msg.kind) {
      case 'frame':
        this.frames.push({ t, aspect: msg.aspect, poses: poses ?? readFramePoses(msg) });
        break;
      case 'poseEvents':
        for (const event of msg.events) this.events.push({ t, kind: 'pose', event });
        break;
      case 'commands':
        for (const command of msg.commands) this.events.push({ t, kind: 'command', source: msg.source, command });
        break;
      case 'gameEvents':
        for (const event of msg.events) this.events.push({ t, kind: 'game', event });
        break;
      case 'status':
        this.backend = msg.backend;
        this.status.push(structuredClone({ t, backend: msg.backend, status: msg.status, base: msg.base }));
        break;
      case 'game':
        this.game.push({ t, game: structuredClone(msg.game) });
        break;
      case 'meta':
        if (msg.meta) this.meta = msg.meta;
        break;
      default:
        break;
    }
  }

  stop(note: string, createdAt: string): SessionRecording {
    this.active = false;
    const startT = this.startT ?? 0;
    // Messages can arrive slightly out of time order (pose clock vs game loop); stable-sort them.
    const rec = encodeSession({
      note,
      createdAt,
      meta: this.meta,
      backend: this.backend,
      startT,
      endT: this.endT ?? startT,
      frames: this.frames.sort(byT),
      events: this.events.sort(byT),
      status: this.status.sort(byT),
      game: this.game.sort(byT),
    });
    // encodeSession copied everything it needs: drop the raw buffers so only one copy stays live.
    this.clear();
    return rec;
  }
}
