import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Rng } from '../../src/game/rng';
import { POWERUP_KINDS, Track, TRACK_AHEAD } from '../../src/game/track';

const DT = 1 / 60;

describe('Track', () => {
  it('is deterministic for a seed', () => {
    const ids = (seed: number) => {
      const t = new Track(new Rng(seed), 'cardio');
      for (let i = 0; i < 20; i++) t.update(i * 100, 20, i * 5, DT);
      return t.placed.map((p) => p.id);
    };
    expect(ids(5)).toEqual(ids(5));
    expect(ids(5)).not.toEqual(ids(6));
  });

  it('lays out warm-up chunks ahead of the runner from s = 30', () => {
    const t = new Track(new Rng(1), 'cardio');
    t.update(0, 12, 0, DT);
    expect(t.placed[0].s).toBe(30);
    const last = t.placed[t.placed.length - 1];
    expect(last.s + 60).toBeGreaterThanOrEqual(TRACK_AHEAD);
    expect(t.placed.every((p) => p.id.startsWith('w-'))).toBe(true);
    expect(t.placed.every((p, i) => i === 0 || p.id !== t.placed[i - 1].id)).toBe(true);
  });

  it('moves to harder tiers later and drops what is far behind', () => {
    const t = new Track(new Rng(2), 'cardio');
    t.update(0, 12, 0, DT);
    t.update(5000, 30, 300, DT);
    expect(t.placed[t.placed.length - 1].id.startsWith('t4-')).toBe(true);
    expect(t.obstacles.every((o) => o.front + o.length >= 5000 - 30)).toBe(true);
    expect(t.coins.every((c) => c.s >= 5000 - 30)).toBe(true);
  });

  it('moves oncoming trains toward the runner', () => {
    const chunks: ChunkDef[] = [{ id: 'm', tier: 0, obstacles: [{ kind: 'trainMoving', lane: 0, s: 30 }], coins: [] }];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const train = t.obstacles[0];
    expect(train.front).toBeCloseTo(60 + 60 * (TUNING.oncomingTrainSpeed / 12), 6);
    t.update(0, 12, 0, 0.5);
    expect(train.front).toBeCloseTo(60 + 50 - 5, 6);
  });

  it('shapes coin arcs and roof runs', () => {
    const chunks: ChunkDef[] = [
      { id: 'c', tier: 0, obstacles: [], coins: [{ lane: 0, s0: 24, s1: 36, shape: 'arc' }, { lane: 1, s0: 10, s1: 13, shape: 'roof' }] },
    ];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const arc = t.coins.filter((c) => c.lane === 0 && c.s < 90).map((c) => [c.s, c.y]);
    expect(arc.map(([s]) => s)).toEqual([54, 57, 60, 63, 66]);
    expect(arc[0][1]).toBeCloseTo(TUNING.coinHeight, 6);
    expect(arc[2][1]).toBeCloseTo(TUNING.coinHeight + 1.2, 6);
    const roofCoins = t.coins.filter((c) => c.lane === 1 && c.s < 90);
    expect(roofCoins.map((c) => c.y)).toEqual([TUNING.coinHeight + TUNING.trainHeight, TUNING.coinHeight + TUNING.trainHeight]);
  });

  it('sometimes offers power-ups at chunk pickup slots', () => {
    const chunks: ChunkDef[] = [{ id: 'p', tier: 0, obstacles: [], coins: [], pickup: { lane: -1, s: 20 } }];
    const t = new Track(new Rng(3), 'cardio', chunks);
    const seen = new Map<number, string>();
    for (let s = 0; s <= 12_000; s += 150) {
      t.update(s, 12, 0, DT);
      for (const p of t.pickups) {
        expect(p.lane).toBe(-1);
        seen.set(p.id, p.kind);
      }
    }
    // ~200 slots at a 35% chance: a few dozen pickups, never all of them.
    expect(seen.size).toBeGreaterThan(20);
    expect(seen.size).toBeLessThan(150);
    expect([...seen.values()].every((k) => POWERUP_KINDS.includes(k as never))).toBe(true);
  });

  it('clears obstacles from a stretch and lays coin trails', () => {
    const chunks: ChunkDef[] = [
      { id: 'x', tier: 0, obstacles: [{ kind: 'barrierLow', lane: 0, s: 20 }, { kind: 'auto', lane: 1, s: 40 }], coins: [] },
    ];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const before = t.obstacles.length;
    t.clearObstacles(45, 65);
    expect(t.obstacles.length).toBe(before - 1);
    expect(t.obstacles.some((o) => o.front === 70)).toBe(true);
    t.addCoinTrail(100, 109, 0, TUNING.rocketHeight);
    expect(t.coins.filter((c) => c.y === TUNING.rocketHeight).map((c) => c.s)).toEqual([100, 103, 106, 109]);
  });
});
