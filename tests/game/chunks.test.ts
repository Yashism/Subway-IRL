import { describe, expect, it } from 'vitest';
import { CHUNK_LENGTH, CHUNKS, type ChunkDef } from '../../src/game/chunks';
import { TUNING, type Difficulty } from '../../src/game/config';
import { lengthOf, OBSTACLES, type ObstacleSpec } from '../../src/game/obstacles';
import { plan, toBlocks, unpassableFrom } from '../../src/game/solver';
import { minGapAt, speedAt, TIER_FRACTIONS, topSpeed, type Tier } from '../../src/game/speed';
import { replayPlan } from './helpers/replay';

const DIFFICULTIES: Difficulty[] = ['cardio', 'beast'];

function tierSpeeds(tier: Tier, d: Difficulty): [number, number] {
  if (tier === 0) return [TUNING.startSpeed, speedAt(TUNING.warmupSeconds, d)];
  const [lo, hi] = TIER_FRACTIONS[tier];
  const span = topSpeed(d) - TUNING.startSpeed;
  return [TUNING.startSpeed + span * lo, TUNING.startSpeed + span * hi];
}

const shifted = (c: ChunkDef, by: number): ObstacleSpec[] => c.obstacles.map((o) => ({ ...o, s: o.s + by }));

describe('chunk data', () => {
  it('has the planned number of chunks per tier and unique ids', () => {
    const count = (t: Tier) => CHUNKS.filter((c) => c.tier === t).length;
    expect([0, 1, 2, 3, 4].map((t) => count(t as Tier))).toEqual([4, 7, 7, 6, 6]);
    expect(new Set(CHUNKS.map((c) => c.id)).size).toBe(CHUNKS.length);
  });

  it.each(CHUNKS)('$id follows the authoring rules', (c) => {
    for (const o of c.obstacles) {
      expect(o.s).toBeGreaterThanOrEqual(15);
      expect(o.s).toBeLessThanOrEqual(45);
      if (o.kind === 'trainParked') expect(o.s + lengthOf(o)).toBeLessThanOrEqual(50);
      if (OBSTACLES[o.kind].moving) expect(o.s).toBeLessThanOrEqual(40);
      if (o.kind === 'ramp') {
        const train = c.obstacles.find((t) => t.kind === 'trainParked' && t.lane === o.lane && t.s === o.s + lengthOf(o));
        expect(train, `${c.id}: ramp at ${o.s} needs a train right after it`).toBeDefined();
      }
    }
    for (const run of c.coins) {
      expect(run.s0).toBeGreaterThanOrEqual(0);
      expect(run.s1).toBeLessThanOrEqual(CHUNK_LENGTH);
    }
    if (c.pickup) expect(c.pickup.s).toBeLessThanOrEqual(CHUNK_LENGTH);
  });
});

describe('chunk passability', () => {
  it.each(CHUNKS)('$id is passable from every lane at its tier speeds', (c) => {
    for (const d of DIFFICULTIES) {
      for (const v of tierSpeeds(c.tier, d)) {
        expect(unpassableFrom(c.obstacles, 0, CHUNK_LENGTH, v, minGapAt(v, d)), `${d} @ ${v.toFixed(1)} m/s`).toBeNull();
      }
    }
  });

  it.each(CHUNKS)('$id plans survive the real runner physics', (c) => {
    for (const d of DIFFICULTIES) {
      const v = tierSpeeds(c.tier, d)[1];
      const blocks = toBlocks(c.obstacles, v);
      for (const lane of [-1, 0, 1] as const) {
        const actions = plan(blocks, 0, CHUNK_LENGTH, { speed: v, minGap: minGapAt(v, d), startLane: lane })!;
        const hit = replayPlan(c.obstacles, actions, lane, v, CHUNK_LENGTH);
        expect(hit, `${d} lane ${lane}: hit ${hit?.obstacle.kind} (${hit?.kind})`).toBeNull();
      }
    }
  });

  it('every join into the same or next tier is passable', () => {
    const failures: string[] = [];
    for (const a of CHUNKS) {
      for (const b of CHUNKS) {
        if (b.tier !== a.tier && b.tier !== a.tier + 1) continue;
        const specs = [...a.obstacles, ...shifted(b, CHUNK_LENGTH)];
        for (const d of DIFFICULTIES) {
          const v = tierSpeeds(b.tier, d)[1];
          const lane = unpassableFrom(specs, 0, 2 * CHUNK_LENGTH, v, minGapAt(v, d));
          if (lane !== null) failures.push(`${a.id} -> ${b.id} (${d}, from lane ${lane})`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
