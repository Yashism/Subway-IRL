import type { ActivityStatus, GameCommand } from '../input/commands';
import type { ChunkDef } from './chunks';
import { findHit, surfaceAt, type RunnerBox } from './collision';
import { laneX, TUNING, type Difficulty } from './config';
import { JoshMeter, Powerups } from './powerups';
import { Rng } from './rng';
import { Chaser, IdleClock, StumbleTracker, type IdleLevel } from './rules';
import { CHAPPAL_JUMP, NORMAL_JUMP, Runner } from './runner';
import { speedAt } from './speed';
import { Track, type PowerupKind } from './track';

export type GameState = 'menu' | 'countdown' | 'playing' | 'paused' | 'caught' | 'summary';
export type CaughtReason = 'crash' | 'stumble' | 'idle';

export type GameEvent =
  | { type: 'state'; state: GameState }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'lane' }
  | { type: 'coin' }
  | { type: 'pickup'; kind: PowerupKind }
  | { type: 'hoverboard' }
  | { type: 'hoverboardSaved' }
  | { type: 'stumble' }
  | { type: 'caught'; reason: CaughtReason }
  | { type: 'rocketLanding' };

export interface GameOptions {
  seed: number;
  difficulty: Difficulty;
  /** Debug: no crashes, no idle catch. */
  god?: boolean;
  /** Override the chunk set (tests). */
  chunks?: readonly ChunkDef[];
}

export interface RunStats {
  distance: number;
  coins: number;
  score: number;
  timeSec: number;
  jumps: number;
  rolls: number;
  laneChanges: number;
  steps: number;
  hoverboardsUsed: number;
}

const emptyStats = (): RunStats => ({
  distance: 0,
  coins: 0,
  score: 0,
  timeSec: 0,
  jumps: 0,
  rolls: 0,
  laneChanges: 0,
  steps: 0,
  hoverboardsUsed: 0,
});

export class Game {
  state: GameState = 'menu';
  countdown = 0;
  /** Seconds of play in the current run. */
  time = 0;
  s = 0;
  speed = TUNING.startSpeed;
  idleLevel: IdleLevel = 'ok';
  caughtReason: CaughtReason | null = null;
  pausedByLoss = false;
  runner = new Runner();
  track: Track;
  readonly powerups = new Powerups();
  readonly josh = new JoshMeter();
  readonly chaser = new Chaser();
  stats: RunStats = emptyStats();

  private readonly idle = new IdleClock();
  private readonly stumbles = new StumbleTracker();
  /** Milliseconds since the game was created (drives the idle clock). */
  private clockMs = 0;
  private catchTimer = 0;
  private runs = 0;
  private stepsAtStart = 0;

  constructor(readonly options: GameOptions) {
    this.track = this.newTrack();
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.pausedByLoss = false;
    this.state = 'paused';
  }

  step(dt: number, commands: readonly GameCommand[], activity: ActivityStatus): GameEvent[] {
    const events: GameEvent[] = [];
    this.clockMs += dt * 1000;
    const wants = (type: GameCommand['type']) => commands.some((c) => c.type === type);

    switch (this.state) {
      case 'menu':
      case 'summary':
        if (wants('start')) this.startRun(activity, events);
        break;
      case 'countdown':
        if (activity.lost || wants('pause')) {
          this.pausedByLoss = activity.lost;
          this.setState('paused', events);
          break;
        }
        this.countdown -= dt;
        if (this.countdown <= 1e-9) {
          this.idle.resume(this.clockMs);
          this.setState('playing', events);
        }
        break;
      case 'paused': {
        const resume = this.pausedByLoss ? !activity.lost : wants('start') || wants('pause');
        if (resume) {
          this.countdown = TUNING.countdownSeconds;
          this.setState('countdown', events);
        }
        break;
      }
      case 'playing':
        this.play(dt, commands, activity, events);
        break;
      case 'caught':
        this.catchTimer -= dt;
        if (this.catchTimer <= 1e-9) this.setState('summary', events);
        break;
    }
    return events;
  }

  private startRun(activity: ActivityStatus, events: GameEvent[]): void {
    this.track = this.newTrack();
    this.runs++;
    this.runner = new Runner();
    this.powerups.reset();
    this.josh.reset();
    this.chaser.reset();
    this.stumbles.reset();
    this.time = 0;
    this.s = 0;
    this.speed = TUNING.startSpeed;
    this.idleLevel = 'ok';
    this.caughtReason = null;
    this.stats = emptyStats();
    this.stepsAtStart = activity.steps;
    this.countdown = TUNING.countdownSeconds;
    this.setState('countdown', events);
  }

  private newTrack(): Track {
    return new Track(new Rng(this.options.seed + this.runs), this.options.difficulty, this.options.chunks);
  }

  private play(dt: number, commands: readonly GameCommand[], activity: ActivityStatus, events: GameEvent[]): void {
    if (activity.lost) {
      this.pausedByLoss = true;
      this.setState('paused', events);
      return;
    }
    if (commands.some((c) => c.type === 'pause')) {
      this.pausedByLoss = false;
      this.setState('paused', events);
      return;
    }
    for (const c of commands) this.apply(c, events);

    this.time += dt;
    this.speed = speedAt(this.time, this.options.difficulty);
    this.s += this.speed * dt;
    this.track.update(this.s, this.speed, this.time, dt);

    const p = this.powerups;
    if (p.update(dt).rocketEnded) {
      const clear = TUNING.rocketLandingClearSeconds + TUNING.rocketFallSeconds;
      this.track.clearObstacles(this.s, this.s + this.speed * clear, this.s, this.speed);
      p.grace = Math.max(p.grace, clear);
      events.push({ type: 'rocketLanding' });
    }
    const r = this.runner;
    r.flying = p.rocket > 0;
    r.update(dt, surfaceAt(this.box(), this.track.obstacles));

    this.collect(events);
    this.collide(events);
    if (this.state !== 'playing') return;

    this.idleLevel = this.idle.update(this.clockMs, activity);
    if (this.idleLevel === 'caught' && !this.options.god) {
      this.catchPlayer('idle', events);
      return;
    }
    this.josh.update(dt, activity.tracksJogging ? activity.cadenceSpm : 0);
    this.chaser.update(dt, this.idleLevel !== 'ok' || this.stumbles.recent(this.time));

    this.stats.distance = this.s;
    this.stats.timeSec = this.time;
    this.stats.steps = Math.max(0, activity.steps - this.stepsAtStart);
    this.stats.score = Math.floor(this.s) + this.stats.coins;
  }

  private apply(c: GameCommand, events: GameEvent[]): void {
    const r = this.runner;
    switch (c.type) {
      case 'setLane':
      case 'shiftLane': {
        const moved = c.type === 'setLane' ? r.setLane(c.lane) : r.shiftLane(c.dir);
        if (moved) {
          this.stats.laneChanges++;
          this.idle.action(this.clockMs);
          events.push({ type: 'lane' });
        }
        break;
      }
      case 'jump':
        if (r.jump(this.powerups.chappal > 0 ? CHAPPAL_JUMP : NORMAL_JUMP)) {
          this.stats.jumps++;
          this.idle.action(this.clockMs);
          events.push({ type: 'jump' });
        }
        break;
      case 'roll':
        if (r.roll()) {
          this.stats.rolls++;
          this.idle.action(this.clockMs);
          events.push({ type: 'roll' });
        }
        break;
      case 'hoverboard':
        if (this.powerups.activateHoverboard()) {
          this.stats.hoverboardsUsed++;
          events.push({ type: 'hoverboard' });
        }
        break;
      default:
        break;
    }
  }

  private box(): RunnerBox {
    const r = this.runner;
    return { s: this.s, x: r.x, y: r.y, height: r.height };
  }

  private collect(events: GameEvent[]): void {
    const r = this.runner;
    const magnet = this.powerups.magnet > 0;
    for (const c of this.track.coins) {
      if (c.taken) continue;
      const ds = c.s - this.s;
      if (ds < -TUNING.coinReach) continue;
      const got = magnet
        ? ds <= TUNING.magnetCollect
        : ds <= TUNING.coinReach &&
          Math.abs(laneX(c.lane) - r.x) < TUNING.coinReach &&
          c.y >= r.y - TUNING.coinReachHeight &&
          c.y <= r.y + r.height + TUNING.coinReachHeight;
      if (!got) continue;
      c.taken = true;
      this.stats.coins += this.josh.multiplier;
      events.push({ type: 'coin' });
    }
    for (const pk of this.track.pickups) {
      if (pk.taken || r.flying || r.y > TUNING.pickupMaxHeight) continue;
      if (Math.abs(pk.s - this.s) > TUNING.pickupReach || Math.abs(laneX(pk.lane) - r.x) >= TUNING.pickupReach) continue;
      pk.taken = true;
      this.powerups.activate(pk.kind);
      events.push({ type: 'pickup', kind: pk.kind });
      if (pk.kind === 'rocket') {
        this.track.addCoinTrail(this.s + 15, this.s + this.speed * TUNING.rocketSeconds - 10, r.lane, TUNING.rocketHeight);
      }
    }
  }

  private collide(events: GameEvent[]): void {
    if (this.options.god || this.powerups.invulnerable) return;
    const r = this.runner;
    const hit = findHit(this.box(), r.lane, r.changingLane, this.track.obstacles);
    if (!hit) return;
    if (hit.kind === 'side') {
      r.bounceBack();
      events.push({ type: 'stumble' });
      if (this.stumbles.hit(this.time) === 'caught') this.catchPlayer('stumble', events);
      return;
    }
    if (this.powerups.absorbCrash()) {
      this.track.removeObstacle(hit.obstacle.id);
      // Whatever follows in this lane would be hit the moment the grace runs out.
      const reach = TUNING.crashClearMargin;
      this.track.clearLane(r.lane, this.s - reach, this.s + this.speed * TUNING.crashGraceSeconds + reach, this.s, this.speed);
      events.push({ type: 'hoverboardSaved' });
      return;
    }
    this.catchPlayer('crash', events);
  }

  private catchPlayer(reason: CaughtReason, events: GameEvent[]): void {
    this.caughtReason = reason;
    this.catchTimer = TUNING.catchSeconds;
    this.chaser.catchUp();
    this.setState('caught', events);
    events.push({ type: 'caught', reason });
  }

  private setState(state: GameState, events: GameEvent[]): void {
    this.state = state;
    events.push({ type: 'state', state });
  }
}
