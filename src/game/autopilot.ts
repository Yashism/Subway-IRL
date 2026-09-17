import type { ActivityStatus, CommandSource, GameCommand } from '../input/commands';
import { TUNING } from './config';
import type { Game } from './game';
import { meetPointOf, OBSTACLES, type Obstacle, type ObstacleSpec } from './obstacles';
import { plan, toBlocks, type PlanAction } from './solver';

/** Metres between replans while the runner is settled. */
const REPLAN_EVERY = 4;
/** The bot reacts faster than a person. */
const BOT_MIN_GAP = 0.3;
const HORIZON_SECONDS = 3;
const MIN_HORIZON = 60;
const BOT_CADENCE = 165;
const ROOF_TOLERANCE = 0.1;

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
      return;
    }
    if (g.state !== 'playing') return;
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
    this.actions =
      plan(toBlocks(specs, g.speed), g.s, g.s + horizon, {
        speed: g.speed,
        minGap: BOT_MIN_GAP,
        startLane: g.runner.lane,
        onRoof,
      }) ?? [];
    this.plannedAt = g.s;
  }
}
