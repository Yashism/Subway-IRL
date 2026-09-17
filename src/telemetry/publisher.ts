import type { Game, GameEvent } from '../game/game';
import type { GameCommand } from '../input/commands';
import type { Baseline } from '../pose/calibration';
import type { PoseEvent, PoseFrame, PoseStatus } from '../pose/types';
import {
  CHANNEL_NAME,
  CONNECTION_TIMEOUT_MS,
  isControlMessage,
  LANDMARKS,
  writeFrameData,
  type ControlMessage,
  type FrameMsg,
  type GameMessage,
  type GameMsg,
  type GameSnapshot,
  type InputSourceName,
  type MetaMsg,
  type SessionMeta,
  type StatusMsg,
} from './messages';

const FRAME_INTERVAL_MS = 1000 / 15;
const STATUS_INTERVAL_MS = 100;
const GAME_INTERVAL_MS = 100;

/**
 * Rate limiter on a due-time grid. A call up to 10 ms early still counts, so 30 fps input gives a
 * steady 15 Hz (not 10) and 60 fps gives 10 Hz (not 12).
 */
class Throttle {
  private next = -Infinity;
  private readonly early: number;

  constructor(private readonly interval: number) {
    this.early = Math.min(10, interval * 0.2);
  }

  ready(now: number): boolean {
    if (now < this.next - this.early) return false;
    // Stay on the grid, unless we fell a whole interval behind (paused, or first call).
    this.next = now - this.next > this.interval ? now + this.interval : this.next + this.interval;
    return true;
  }
}

interface ChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  close(): void;
}

function openChannel(name: string): ChannelLike | null {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
  if (typeof BC !== 'function') return null;
  try {
    return new BC(name);
  } catch {
    return null;
  }
}

const emptySnapshot = (): GameSnapshot => ({
  state: 'menu',
  s: 0,
  speed: 0,
  lane: 0,
  y: 0,
  rolling: false,
  airborne: false,
  flying: false,
  idleLevel: 'ok',
  idleMs: 0,
  countdown: 0,
  time: 0,
  josh: { value: 0, active: false },
  powerups: { magnet: 0, rocket: 0, chappal: 0, hoverboard: 0, grace: 0, hoverboardsLeft: 0 },
  pausedByLoss: false,
  caughtReason: null,
  coins: 0,
  score: 0,
});

/**
 * Game-tab side of the live monitor. Sends nothing unless a monitor tab has said hello in the
 * last 3 s, and does nothing at all when BroadcastChannel is missing. Message objects and frame
 * buffers are reused (postMessage clones them), so the per-frame cost is one typed-array copy.
 */
export class TelemetryPublisher {
  private ch: ChannelLike | null;
  private lastHello = -Infinity;
  /** Last hello time of each recording monitor; recomputed into `recordingUntil` on every hello. */
  private recorders = new Map<string, number>();
  private recordingUntil = -Infinity;
  private frameGate = new Throttle(FRAME_INTERVAL_MS);
  private statusGate = new Throttle(STATUS_INTERVAL_MS);
  private gameGate = new Throttle(GAME_INTERVAL_MS);
  private metaValue: SessionMeta | null = null;
  private handlers = new Set<(msg: ControlMessage) => void>();
  /** Frame buffers by pose count. */
  private buffers: Float32Array[] = [];
  private frameMsg: FrameMsg = { kind: 'frame', t: 0, aspect: 1, count: 0, data: new Float32Array(0) };
  private gameMsg: GameMsg = { kind: 'game', t: 0, game: emptySnapshot() };

  constructor(
    channelName: string = CHANNEL_NAME,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.ch = openChannel(channelName);
    this.ch?.addEventListener('message', (e) => this.receive(e.data));
  }

  /** False when BroadcastChannel is unavailable or the publisher is closed. */
  get available(): boolean {
    return this.ch !== null;
  }

  /** A monitor has said hello within the last 3 s. */
  get connected(): boolean {
    return this.ch !== null && this.now() - this.lastHello <= CONNECTION_TIMEOUT_MS;
  }

  /** A connected monitor is recording, so every frame is sent. */
  get fullRate(): boolean {
    return this.ch !== null && this.now() <= this.recordingUntil;
  }

  frame(f: PoseFrame): void {
    if (!this.connected) return;
    if (!this.frameGate.ready(this.now()) && !this.fullRate) return;
    const count = f.poses.length;
    const buf = (this.buffers[count] ??= new Float32Array(count * LANDMARKS * 4));
    writeFrameData(f.poses, buf);
    const m = this.frameMsg;
    m.t = f.t;
    m.aspect = f.aspect;
    m.count = count;
    m.data = buf;
    this.post(m);
  }

  /** `base` (optional) lets the monitor draw the calibration guide lines. */
  status(s: PoseStatus, backend: string, base: Baseline | null = null): void {
    if (!this.connected) return;
    const now = this.now();
    if (!this.statusGate.ready(now)) return;
    const { pose: _pose, ...status } = s;
    this.post({ kind: 'status', t: now, backend, status, base } satisfies StatusMsg);
  }

  poseEvents(e: readonly PoseEvent[], t: number): void {
    if (e.length && this.connected) this.post({ kind: 'poseEvents', t, events: e as PoseEvent[] });
  }

  commands(c: readonly GameCommand[], source: InputSourceName, t: number): void {
    if (c.length && this.connected) this.post({ kind: 'commands', t, source, commands: c as GameCommand[] });
  }

  gameEvents(e: readonly GameEvent[], t: number): void {
    if (e.length && this.connected) this.post({ kind: 'gameEvents', t, events: e as GameEvent[] });
  }

  game(g: Game, idleMs: number, t: number): void {
    if (!this.connected) return;
    if (!this.gameGate.ready(this.now())) return;
    const m = this.gameMsg;
    const s = m.game;
    const r = g.runner;
    const p = g.powerups;
    m.t = t;
    s.state = g.state;
    s.s = g.s;
    s.speed = g.speed;
    s.lane = r.lane;
    s.y = r.y;
    s.rolling = r.rolling;
    s.airborne = r.airborne;
    s.flying = r.flying;
    s.idleLevel = g.idleLevel;
    s.idleMs = idleMs;
    s.countdown = g.countdown;
    s.time = g.time;
    s.josh.value = g.josh.value;
    s.josh.active = g.josh.active;
    s.powerups.magnet = p.magnet;
    s.powerups.rocket = p.rocket;
    s.powerups.chappal = p.chappal;
    s.powerups.hoverboard = p.hoverboard;
    s.powerups.grace = p.grace;
    s.powerups.hoverboardsLeft = p.hoverboardsLeft;
    s.pausedByLoss = g.pausedByLoss;
    s.caughtReason = g.caughtReason;
    s.coins = g.stats.coins;
    s.score = g.stats.score;
    this.post(m);
  }

  /** Session settings. Cached; sent now if a monitor is connected and in reply to every hello. */
  meta(m: SessionMeta): void {
    this.metaValue = m;
    if (this.connected) this.sendMeta();
  }

  onControl(handler: (msg: ControlMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (!this.ch) return;
    if (this.connected) this.post({ kind: 'bye', t: this.now() });
    this.ch.close();
    this.ch = null;
    this.handlers.clear();
  }

  private sendMeta(): void {
    this.post({ kind: 'meta', t: this.now(), meta: this.metaValue, fullRate: this.fullRate } satisfies MetaMsg);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const kind = (data as { kind?: unknown }).kind;
    if (kind === 'hello') {
      const now = this.now();
      const hello = data as { id?: unknown; recording?: unknown };
      const id = typeof hello.id === 'string' ? hello.id : '';
      this.lastHello = now;
      if (hello.recording === true) this.recorders.set(id, now);
      else this.recorders.delete(id);
      this.recordingUntil = -Infinity;
      for (const [key, t] of this.recorders) {
        if (now - t > CONNECTION_TIMEOUT_MS) this.recorders.delete(key);
        else this.recordingUntil = Math.max(this.recordingUntil, t + CONNECTION_TIMEOUT_MS);
      }
      this.sendMeta();
      return;
    }
    if (!isControlMessage(data)) return;
    for (const h of this.handlers) {
      try {
        h(data);
      } catch (err) {
        console.error('telemetry control handler failed', err);
      }
    }
  }

  private post(m: GameMessage): void {
    try {
      this.ch?.postMessage(m);
    } catch {
      // A closed or broken channel must never break the game loop.
    }
  }
}
