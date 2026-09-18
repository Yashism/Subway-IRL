import type { Lane } from '../pose/types';
import { CHUNK_LENGTH, CHUNKS, type ChunkDef, type CoinRun } from './chunks';
import { DEFAULT_OBSTACLES, TUNING, type Difficulty, type ObstacleAmount, type ObstacleSettings } from './config';
import { blockLengthOf, closingRate, lengthOf, meetOf, movingFrontAt, OBSTACLES, type Obstacle } from './obstacles';
import type { Rng } from './rng';
import { NORMAL_JUMP } from './runner';
import { POWERUP_KINDS, type PowerupKind } from './powerups';
import { tierFor, type Tier } from './speed';

export { POWERUP_KINDS, type PowerupKind };

export interface Coin {
  id: number;
  lane: Lane;
  s: number;
  y: number;
  taken: boolean;
}

export interface Pickup {
  id: number;
  kind: PowerupKind;
  lane: Lane;
  s: number;
  taken: boolean;
}

/** Track is laid out at least this far ahead of the runner. */
export const TRACK_AHEAD = 200;
const TRACK_BEHIND = 30;
const FIRST_CHUNK_S = 30;
const PLACED_HISTORY = 20;
/** With obstacle amount Few: the chance of a coin-only breather between two obstacle patterns. */
export const BREATHER_CHANCE = 0.5;
export const BREATHER_ID = 'breather';

function removeWhere<T>(items: T[], drop: (item: T) => boolean): void {
  let w = 0;
  for (const item of items) if (!drop(item)) items[w++] = item;
  items.length = w;
}

/**
 * Stretch of track on which the obstacle can touch a runner now at runnerS. An oncoming train is
 * taken where it will meet the runner, not where its front is now — from the closing rate it was
 * placed with, which holds however the runner's speed changes (see Obstacle.closing).
 */
function reachOf(o: Obstacle, runnerS: number): [number, number] {
  if (!OBSTACLES[o.kind].moving) return [o.front, o.front + o.length];
  const meet = meetOf(o, runnerS);
  return [meet, meet + blockLengthOf(o)];
}

function meetsWithin(o: Obstacle, fromS: number, toS: number, runnerS: number): boolean {
  const [s0, s1] = reachOf(o, runnerS);
  return s0 < toS && s1 > fromS;
}

export class Track {
  readonly obstacles: Obstacle[] = [];
  readonly coins: Coin[] = [];
  readonly pickups: Pickup[] = [];
  /** Recently placed chunks, oldest first. */
  readonly placed: { id: string; s: number }[] = [];
  private nextS = FIRST_CHUNK_S;
  /** Where the runner was at the last update: trains close by the distance run since. */
  private lastRunnerS = 0;
  private nextId = 1;
  private lastChunk = '';
  private lastTier: Tier = 0;
  private lastWasBreather = false;

  constructor(
    private readonly rng: Rng,
    private readonly difficulty: Difficulty,
    private readonly chunks: readonly ChunkDef[] = CHUNKS,
    /** The player's obstacle difficulty and amount; the game as designed by default. */
    private readonly settings: Readonly<ObstacleSettings> = DEFAULT_OBSTACLES,
  ) {}

  /**
   * Advances to a runner now at runnerS. Oncoming trains close by their closing rate times the
   * distance the runner covered since the last call, so each still meets the runner exactly where
   * it was placed to (see Obstacle.closing) — at a steady speed that is the same as moving at
   * `oncomingTrainSpeed`.
   */
  update(runnerS: number, speed: number, tSec: number): void {
    const ran = Math.max(0, runnerS - this.lastRunnerS);
    this.lastRunnerS = runnerS;
    for (const o of this.obstacles) {
      if (!OBSTACLES[o.kind].moving) continue;
      // A train added by hand rather than placed from a chunk takes the rate of the speed it met.
      o.closing ??= closingRate(speed);
      o.front -= o.closing * ran;
    }
    while (this.nextS < runnerS + TRACK_AHEAD) this.placeChunk(runnerS, speed, tSec);
    const cutoff = runnerS - TRACK_BEHIND;
    removeWhere(this.obstacles, (o) => o.front + o.length < cutoff);
    removeWhere(this.coins, (c) => c.taken || c.s < cutoff);
    removeWhere(this.pickups, (p) => p.taken || p.s < cutoff);
  }

  /**
   * Removes every obstacle a runner now at runnerS would meet in [fromS, toS].
   * Used for a safe rocket landing.
   */
  clearObstacles(fromS: number, toS: number, runnerS: number): void {
    removeWhere(this.obstacles, (o) => meetsWithin(o, fromS, toS, runnerS));
  }

  /** Like clearObstacles, for one lane only (used after a hoverboard absorbs a crash). */
  clearLane(lane: Lane, fromS: number, toS: number, runnerS: number): void {
    removeWhere(this.obstacles, (o) => o.lane === lane && meetsWithin(o, fromS, toS, runnerS));
  }

  removeObstacle(id: number): void {
    removeWhere(this.obstacles, (o) => o.id === id);
  }

  addCoinTrail(fromS: number, toS: number, lane: Lane, y: number): void {
    for (let s = fromS; s <= toS + 1e-9; s += TUNING.coinSpacing) this.coins.push({ id: this.nextId++, lane, s, y, taken: false });
  }

  private placeChunk(runnerS: number, speed: number, tSec: number): void {
    const base = this.nextS;
    this.nextS += CHUNK_LENGTH;
    const { amount, level } = this.settings;
    // Few: half the time, a coin-only breather between two obstacle patterns (never two in a row,
    // and never in the warm-up, which is gentle already). It is not a tier step.
    if (amount === 'few' && this.lastTier > 0 && !this.lastWasBreather && this.rng.chance(BREATHER_CHANCE)) {
      this.lastWasBreather = true;
      const lane = (this.rng.int(3) - 1) as Lane;
      this.lay({ id: BREATHER_ID, tier: 0, obstacles: [], coins: [{ lane, s0: 15, s1: 45, shape: 'line' }] }, base, runnerS, speed);
      return;
    }
    this.lastWasBreather = false;
    const eta = tSec + Math.max(0, base - runnerS) / speed;
    const wanted = tierFor(eta, this.difficulty, level);
    const tier = Math.min(Math.max(wanted, this.lastTier), this.lastTier + 1) as Tier;
    let pool = this.chunks.filter((c) => c.tier === tier);
    if (pool.length > 1) pool = pool.filter((c) => c.id !== this.lastChunk);
    if (pool.length === 0) return;
    this.lastTier = tier;
    // Normal draws exactly as the game always has, so a seed still gives the same track.
    const chunk = amount === 'normal' ? this.rng.pick(pool) : this.pickByAmount(pool, amount);
    this.lastChunk = chunk.id;
    this.lay(chunk, base, runnerS, speed);
  }

  /**
   * Few favours sparse patterns and Lots busy ones, by weighting each pattern by how many obstacles
   * it asks the player to deal with (ramps do not count: they ask nothing).
   */
  private pickByAmount(pool: readonly ChunkDef[], amount: ObstacleAmount): ChunkDef {
    const weight = (c: ChunkDef) => {
      const n = c.obstacles.filter((o) => OBSTACLES[o.kind].action !== 'none').length;
      return amount === 'few' ? 1 / (1 + n) : 1 + n;
    };
    let total = 0;
    for (const c of pool) total += weight(c);
    let r = this.rng.next() * total;
    for (const c of pool) {
      r -= weight(c);
      if (r < 0) return c;
    }
    return pool[pool.length - 1];
  }

  /** Lays a chunk's obstacles, coins and pickup out from `base`. */
  private lay(chunk: ChunkDef, base: number, runnerS: number, speed: number): void {
    this.placed.push({ id: chunk.id, s: base });
    if (this.placed.length > PLACED_HISTORY) this.placed.shift();

    for (const spec of chunk.obstacles) {
      const s = base + spec.s;
      this.obstacles.push({
        id: this.nextId++,
        kind: spec.kind,
        lane: spec.lane,
        length: lengthOf(spec),
        front: OBSTACLES[spec.kind].moving ? movingFrontAt(s, runnerS, speed) : s,
        ...(OBSTACLES[spec.kind].moving ? { closing: closingRate(speed) } : {}),
      });
    }
    for (const run of chunk.coins) this.addCoinRun(run, base);
    if (chunk.pickup && this.rng.chance(TUNING.pickupChance)) {
      this.pickups.push({
        id: this.nextId++,
        kind: this.rng.pick(POWERUP_KINDS),
        lane: chunk.pickup.lane,
        s: base + chunk.pickup.s,
        taken: false,
      });
    }
  }

  private addCoinRun(run: CoinRun, base: number): void {
    const mid = (run.s0 + run.s1) / 2;
    const half = (run.s1 - run.s0) / 2;
    for (let cs = run.s0; cs <= run.s1 + 1e-9; cs += TUNING.coinSpacing) {
      let y = TUNING.coinHeight;
      if (run.shape === 'roof') y += TUNING.trainHeight;
      if (run.shape === 'arc') y += NORMAL_JUMP.height * (1 - ((cs - mid) / half) ** 2);
      this.coins.push({ id: this.nextId++, lane: run.lane, s: base + cs, y, taken: false });
    }
  }
}
