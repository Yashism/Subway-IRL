import type { PoseController } from '../pose/controller';
import type { PoseEvent, PoseFrame } from '../pose/types';
import type { ActivityStatus, CommandSource, GameCommand } from './commands';

export interface PoseCommandSourceOptions {
  /** A stream with no frame for longer than this (ms) counts as lost. Default 1500. */
  staleMs?: number;
}

const DEFAULT_STALE_MS = 1500;

// Commands are never mutated by the game, so each kind has one shared, frozen instance.
const freeze = <T extends GameCommand>(c: T): T => Object.freeze(c);
const SET_LANE = {
  [-1]: freeze({ type: 'setLane', lane: -1 }),
  0: freeze({ type: 'setLane', lane: 0 }),
  1: freeze({ type: 'setLane', lane: 1 }),
} as const;
const SHIFT_LEFT = freeze({ type: 'shiftLane', dir: -1 });
const SHIFT_RIGHT = freeze({ type: 'shiftLane', dir: 1 });
const JUMP = freeze({ type: 'jump' });
const ROLL = freeze({ type: 'roll' });
const HOVERBOARD = freeze({ type: 'hoverboard' });
const START = freeze({ type: 'start' });
/** Returned by drain() when nothing is queued; frozen so a caller cannot fill it by accident. */
const NONE = Object.freeze([]) as unknown as GameCommand[];

function toCommand(e: PoseEvent): GameCommand | null {
  switch (e.type) {
    case 'lane':
      return SET_LANE[e.lane];
    case 'laneShift':
      return e.dir < 0 ? SHIFT_LEFT : SHIFT_RIGHT;
    case 'jump':
      return JUMP;
    case 'roll':
      return ROLL;
    case 'hoverboard':
      return HOVERBOARD;
    case 'start':
      return START;
    default:
      // lost / found drive the `lost` flag, not a command.
      return null;
  }
}

/**
 * Webcam input for the game: turns PoseController events and status into GameCommands and an
 * ActivityStatus (spec "Pose → game mapping").
 *
 * Frames go in through push() on the pose clock; commands come out when the game drains. The
 * `tMs` given to activity() should be on the same clock as the frame timestamps
 * (performance.now() for both LivePoseSource and ReplayPoseSource) so a stalled stream ages.
 */
export class PoseCommandSource implements CommandSource {
  /** Tag for telemetry: which input produced `lastDrained`. */
  readonly source = 'pose' as const;
  /** The commands the last drain() returned (tagged by `source` for telemetry). Do not mutate. */
  lastDrained: readonly GameCommand[] = NONE;

  private readonly staleMs: number;
  private queue: GameCommand[] = [];
  private lostEvent = false;
  /** Steps from jog detectors that have since been reset. */
  private stepsBefore = 0;
  /** The controller's step count at the last look, to notice a reset done behind our back. */
  private lastRawSteps = 0;
  private readonly result: ActivityStatus = {
    tracksJogging: false,
    msSinceStep: Infinity,
    cadenceSpm: 0,
    steps: 0,
    squatting: false,
    lost: false,
  };

  constructor(
    readonly controller: PoseController,
    opts: PoseCommandSourceOptions = {},
  ) {
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  }

  /** Feeds one pose frame to the controller. Returns the pose events it produced (for telemetry). */
  push(frame: PoseFrame): readonly PoseEvent[] {
    const events = this.controller.update(frame);
    this.enqueue(events);
    return events;
  }

  drain(): GameCommand[] {
    if (this.queue.length === 0) {
      this.lastDrained = NONE;
      return NONE;
    }
    const out = this.queue;
    this.queue = [];
    this.lastDrained = out;
    return out;
  }

  /**
   * The current body activity. The returned object is reused and overwritten by the next call:
   * read or copy its fields straight away and never keep a reference (InputHub copies them).
   */
  activity(tMs: number): ActivityStatus {
    const st = this.controller.status;
    const raw = st.jog.steps;
    this.syncSteps(raw);
    const last = st.lastFrameT;
    // Only age by the gap when the game clock is at or past the last frame (same clock).
    const stall = last !== null && tMs >= last ? tMs - last : 0;
    const r = this.result;
    r.tracksJogging = st.calibrated;
    r.msSinceStep = st.jog.msSinceStep + stall;
    r.cadenceSpm = st.jog.cadenceSpm;
    r.steps = this.stepsBefore + raw;
    r.squatting = st.squatting;
    r.lost = this.lostEvent || stall > this.staleMs;
    return r;
  }

  /** Recalibrates the controller. Steps stay monotonic; a side-lane player is sent back to lane 0. */
  recalibrate(): void {
    this.syncSteps(this.controller.status.jog.steps);
    this.enqueue(this.controller.recalibrate());
    this.syncSteps(this.controller.status.jog.steps);
  }

  private enqueue(events: readonly PoseEvent[]): void {
    for (const e of events) {
      if (e.type === 'lost') this.lostEvent = true;
      else if (e.type === 'found') this.lostEvent = false;
      const cmd = toCommand(e);
      if (cmd) this.queue.push(cmd);
    }
  }

  /** A falling raw count means the jog detector was reset: bank what it had counted. */
  private syncSteps(raw: number): void {
    if (raw < this.lastRawSteps) this.stepsBefore += this.lastRawSteps;
    this.lastRawSteps = raw;
  }
}
