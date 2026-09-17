import type { Lane } from '../pose/types';
import { CHUNK_LENGTH, CHUNKS, type ChunkDef, type CoinRun } from './chunks';
import { TUNING, type Difficulty } from './config';
import { lengthOf, movingFrontAt, OBSTACLES, type Obstacle } from './obstacles';
import type { Rng } from './rng';
import { NORMAL_JUMP } from './runner';
import { POWERUP_KINDS, type PowerupKind } from './powerups';
import { tierFor } from './speed';

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

function removeWhere<T>(items: T[], drop: (item: T) => boolean): void {
  let w = 0;
  for (const item of items) if (!drop(item)) items[w++] = item;
  items.length = w;
}

export class Track {
  readonly obstacles: Obstacle[] = [];
  readonly coins: Coin[] = [];
  readonly pickups: Pickup[] = [];
  /** Recently placed chunks, oldest first. */
  readonly placed: { id: string; s: number }[] = [];
  private nextS = FIRST_CHUNK_S;
  private nextId = 1;
  private lastChunk = '';

  constructor(
    private readonly rng: Rng,
    private readonly difficulty: Difficulty,
    private readonly chunks: readonly ChunkDef[] = CHUNKS,
  ) {}

  update(runnerS: number, speed: number, tSec: number, dt: number): void {
    for (const o of this.obstacles) if (OBSTACLES[o.kind].moving) o.front -= TUNING.oncomingTrainSpeed * dt;
    while (this.nextS < runnerS + TRACK_AHEAD) this.placeChunk(runnerS, speed, tSec);
    const cutoff = runnerS - TRACK_BEHIND;
    removeWhere(this.obstacles, (o) => o.front + o.length < cutoff);
    removeWhere(this.coins, (c) => c.taken || c.s < cutoff);
    removeWhere(this.pickups, (p) => p.taken || p.s < cutoff);
  }

  /** Removes every obstacle that overlaps [fromS, toS] (used for a safe rocket landing). */
  clearObstacles(fromS: number, toS: number): void {
    removeWhere(this.obstacles, (o) => o.front < toS && o.front + o.length > fromS);
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
    const eta = tSec + Math.max(0, base - runnerS) / speed;
    const tier = tierFor(eta, this.difficulty);
    let pool = this.chunks.filter((c) => c.tier === tier);
    if (pool.length > 1) pool = pool.filter((c) => c.id !== this.lastChunk);
    if (pool.length === 0) return;
    const chunk = this.rng.pick(pool);
    this.lastChunk = chunk.id;
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
