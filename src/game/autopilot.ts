import type { ActivityStatus, CommandSource, GameCommand } from '../input/commands';
import { TUNING } from './config';
import type { Game } from './game';
import { meetPointOf, OBSTACLES, type Obstacle, type ObstacleSpec } from './obstacles';
import { CHAPPAL_JUMP } from './runner';
import { plan, toBlocks, type PlanAction, type PlanOptions } from './solver';

/** Metres between replans while the runner is settled. */
const REPLAN_EVERY = 4;
/** The bot reacts faster than a person. */
const BOT_MIN_GAP = 0.3;
const HORIZON_SECONDS = 3;
const MIN_HORIZON = 60;
const BOT_CADENCE = 165;
const ROOF_TOLERANCE = 0.1;
/**
 * Plans assume the current speed, but the runner keeps speeding up, so an action fires up to
 * this many seconds before its planned time (max acceleration 0.24 m/s² × horizon² / 2 / speed).
 */
const SPEEDUP_DRIFT = 0.3;
/** Frames of slack for float rounding in power-up timers. */
const TIMER_SLACK_FRAMES = 2;

/** Current obstacles as specs the solver understands (oncoming trains back to meeting points). */
export function liveSpecs(obstacles: readonly Obstacle[], runnerS: number, speed: number): ObstacleSpec[] {
  return obstacles.map((o) => ({
    kind: o.kind,
    lane: o.lane,
    length: o.length,
    s: OBSTACLES[o.kind].moving ? meetPointOf(o.front, runnerS, speed) : o.front,
  }));
}

/** A bot player for demos and integration tests: plans with the solver and always "jogs". */
export class Autopilot implements CommandSource {
  private queue: GameCommand[] = [];
  private actions: PlanAction[] = [];
  private plannedAt = -Infinity;
  private chappalSeen = 0;

  constructor(private readonly game: Game) {}

  drain(): GameCommand[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  activity(tMs: number): ActivityStatus {
    return {
      tracksJogging: true,
      msSinceStep: 0,
      cadenceSpm: BOT_CADENCE,
      steps: Math.floor(tMs / (60_000 / BOT_CADENCE)),
      squatting: false,
      lost: false,
    };
  }

  /** Call once before every game step. */
  tick(): void {
    const g = this.game;
    if (g.state === 'menu' || g.state === 'summary') {
      this.queue.push({ type: 'start' });
      this.actions = [];
      this.plannedAt = -Infinity;
      this.chappalSeen = 0;
      return;
    }
    if (g.state !== 'playing') return;
    // Chappals picked up (or topped up) change how jumps go: the current plan is stale.
    const chappal = g.powerups.chappal;
    if (chappal > this.chappalSeen) this.plannedAt = -Infinity;
    this.chappalSeen = chappal;
    const r = g.runner;
    const settled = !r.airborne && !r.rolling && !r.changingLane && !r.flying;
    if (settled && g.s - this.plannedAt >= REPLAN_EVERY) this.replan();
    while (this.actions.length && this.actions[0].s <= g.s + 1e-6) {
      const a = this.actions.shift()!;
      this.queue.push(a.type === 'lane' ? { type: 'setLane', lane: a.lane } : { type: a.type });
    }
  }

  private replan(): void {
    const g = this.game;
    const specs = liveSpecs(g.track.obstacles, g.s, g.speed);
    const horizon = Math.max(MIN_HORIZON, g.speed * HORIZON_SECONDS);
    const onRoof = g.runner.y >= TUNING.trainHeight - ROOF_TOLERANCE;
    const options: PlanOptions = { speed: g.speed, minGap: BOT_MIN_GAP, startLane: g.runner.lane, onRoof };
    const chappal = g.powerups.chappal;
    if (chappal > 0) {
      // The game picks the jump profile when a jump starts; chappals run out after `chappal` s.
      const slack = TIMER_SLACK_FRAMES / TUNING.stepHz;
      options.jump = CHAPPAL_JUMP;
      options.jumpExpiry = {
        from: g.s + (chappal - slack) * g.speed,
        to: g.s + (chappal + SPEEDUP_DRIFT + slack) * g.speed,
      };
    }
    this.actions = plan(toBlocks(specs, g.speed), g.s, g.s + horizon, options) ?? [];
    this.plannedAt = g.s;
  }
}
