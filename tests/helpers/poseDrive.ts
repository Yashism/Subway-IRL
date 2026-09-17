import type { ChunkDef } from '../../src/game/chunks';
import { Game, type GameEvent, type GameOptions, type GameState } from '../../src/game/game';
import { lengthOf, type ObstacleSpec } from '../../src/game/obstacles';
import type { GameCommand } from '../../src/input/commands';
import { InputHub } from '../../src/input/hub';
import { KeyboardInput } from '../../src/input/keyboard';
import { PoseCommandSource } from '../../src/input/poseSource';
import { PoseController, type PoseControllerOptions } from '../../src/pose/controller';
import type { PoseEvent } from '../../src/pose/types';
import { jogParams, Scenario, type JogOptions, type SynthParams } from './synth';

/** A track with no generated obstacles or coins: tests place what they need. */
export const EMPTY_TRACK: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];

const GAME_HZ = 60;
const GAME_DT_MS = 1000 / GAME_HZ;
const EPS = 1e-6;

export interface Stamped<T> {
  t: number;
  e: T;
}

export interface PoseDriveOptions {
  game?: Partial<GameOptions>;
  pose?: PoseControllerOptions;
  staleMs?: number;
  /** Synthetic poses hide the knees (small-room mode). */
  small?: boolean;
}

let nextObstacleId = 50_000;

/**
 * Headless pose-controlled game: synthetic 30 Hz pose frames → PoseController → PoseCommandSource
 * → InputHub (with a keyboard alongside) → Game stepped at 60 Hz, all on one shared clock (ms).
 *
 * Build the pose timeline on `sc` (its `t` is the end of the timeline), then `run()` to play it.
 * Leave a gap in the stream (a stall) with `gap(ms)`.
 */
export class PoseDrive {
  readonly sc = new Scenario(30);
  readonly ctrl: PoseController;
  readonly pose: PoseCommandSource;
  readonly keyboard = new KeyboardInput();
  readonly hub: InputHub;
  readonly game: Game;
  readonly small: boolean;
  /** Shared clock, ms. */
  now = 0;
  readonly poseEvents: Stamped<PoseEvent>[] = [];
  readonly commands: Stamped<GameCommand>[] = [];
  readonly gameEvents: Stamped<GameEvent>[] = [];
  private steps = 0;
  private nextFrame = 0;

  constructor(opts: PoseDriveOptions = {}) {
    this.small = opts.small ?? false;
    this.ctrl = new PoseController(opts.pose);
    this.pose = new PoseCommandSource(this.ctrl, { staleMs: opts.staleMs });
    this.hub = new InputHub([this.keyboard, this.pose]);
    this.game = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY_TRACK, ...opts.game });
  }

  get state(): GameState {
    return this.game.state;
  }

  /** Posture defaults for this rig (hidden knees in small-room mode). */
  base(p: Partial<SynthParams> = {}): Partial<SynthParams> {
    return this.small ? { lowerVisible: false, ...p } : p;
  }

  /** Stand still for `ms`. */
  stand(ms: number, p: Partial<SynthParams> = {}): this {
    this.sc.hold(ms, this.base(p));
    return this;
  }

  /** Jog in place for `ms` on a continuous jog phase; `base` may vary the posture over the segment. */
  jog(ms: number, base: (t: number) => Partial<SynthParams> = () => ({}), o: Omit<JogOptions, 'base' | 'small'> = {}): this {
    const t0 = this.sc.t;
    this.sc.add(ms, (t) => jogParams(t0 + t, { ...o, small: this.small, base: this.base(base(t)) }));
    return this;
  }

  /** Any posture over time, merged over this rig's defaults; null means nobody in view. */
  posture(ms: number, fn: (t: number) => Partial<SynthParams> | null): this {
    this.sc.add(ms, (t) => {
      const p = fn(t);
      return p === null ? null : this.base(p);
    });
    return this;
  }

  /** No frames at all for `ms` (a stalled stream). */
  gap(ms: number): this {
    this.sc.t += ms;
    return this;
  }

  /** Stand to calibrate, then hold the right hand up to Start. */
  calibrateAndStart(): this {
    return this.stand(2500).stand(1600, { arms: 'right-up' });
  }

  /**
   * Plays the shared clock up to `untilMs` (default: the end of the pose timeline). Before each
   * 60 Hz game step, every pose frame due by then is pushed. Stops early once `stop` is true.
   */
  run(untilMs = this.sc.t, stop?: (d: PoseDrive) => boolean): this {
    const frames = this.sc.frames;
    for (;;) {
      const next = (this.steps + 1) * GAME_DT_MS;
      if (next > untilMs + EPS) break;
      this.steps++;
      this.now = next;
      while (this.nextFrame < frames.length && frames[this.nextFrame].t <= this.now + EPS) {
        const f = frames[this.nextFrame++];
        for (const e of this.pose.push(f)) this.poseEvents.push({ t: f.t, e });
      }
      const cmds = this.hub.drain();
      for (const e of cmds) this.commands.push({ t: this.now, e });
      for (const e of this.game.step(1 / GAME_HZ, cmds, this.hub.activity(this.now))) this.gameEvents.push({ t: this.now, e });
      if (stop?.(this)) break;
    }
    return this;
  }

  /** Plays until `stop` holds, for at most `maxMs`. Returns whether it held. */
  runUntil(stop: (d: PoseDrive) => boolean, maxMs = this.sc.t - this.now): boolean {
    this.run(this.now + maxMs, stop);
    return stop(this);
  }

  /** Puts an obstacle on the track (like tests/game/game.test.ts). */
  place(spec: ObstacleSpec): number {
    const id = nextObstacleId++;
    this.game.track.obstacles.push({ id, kind: spec.kind, lane: spec.lane, length: lengthOf(spec), front: spec.s });
    return id;
  }

  /** Game states entered, in order. */
  get states(): GameState[] {
    return this.gameEvents.flatMap(({ e }) => (e.type === 'state' ? [e.state] : []));
  }

  /** Commands as short names: setLane:1, shiftLane:-1, jump, ... */
  get commandNames(): string[] {
    return this.commands.map(({ e }) =>
      e.type === 'setLane' ? `setLane:${e.lane}` : e.type === 'shiftLane' ? `shiftLane:${e.dir}` : e.type,
    );
  }

  /** First time a game state was entered at or after `fromMs`, or null. */
  enteredAt(state: GameState, fromMs = 0): number | null {
    const hit = this.gameEvents.find(({ t, e }) => t >= fromMs && e.type === 'state' && e.state === state);
    return hit ? hit.t : null;
  }
}
