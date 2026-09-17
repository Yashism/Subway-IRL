import { describe, expect, it } from 'vitest';
import { PROFILE_KEY, ProfileStore, emptyProfile, type RunRecord } from '../../src/app/profile';

class FakeStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.writes++;
    this.data.set(k, v);
  }
}

const throwing = {
  getItem(): string | null {
    throw new Error('SecurityError');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
};

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  at: 1_700_000_000_000,
  score: 100,
  coins: 10,
  distance: 90.5,
  timeSec: 12.3,
  jumps: 2,
  rolls: 1,
  laneChanges: 4,
  steps: 0,
  hoverboardsUsed: 0,
  caughtReason: 'crash',
  difficulty: 'cardio',
  seed: 3,
  input: 'keyboard',
  ...over,
});

const noNaN = (p: object): void => {
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
};

describe('ProfileStore', () => {
  it('starts empty with no stored data', () => {
    const s = new ProfileStore(new FakeStorage());
    expect(s.profile).toEqual(emptyProfile());
    expect(s.profile.version).toBe(1);
    expect(PROFILE_KEY).toBe('subway-irl.profile.v1');
  });

  it('records runs, totals and a best score, and persists them', () => {
    const storage = new FakeStorage();
    const s = new ProfileStore(storage);
    expect(s.recordRun(run({ score: 100 }))).toEqual({ newBest: true, previousBest: 0 });
    expect(s.recordRun(run({ score: 50, distance: 200, coins: 5 }))).toEqual({ newBest: false, previousBest: 100 });
    expect(s.recordRun(run({ score: 300, at: 3 }))).toEqual({ newBest: true, previousBest: 100 });
    const p = s.profile;
    expect(p.bestScore).toBe(300);
    expect(p.bestDistance).toBe(200);
    expect(p.totalRuns).toBe(3);
    expect(p.totalCoins).toBe(25);
    expect(p.totalDistance).toBeCloseTo(381);
    expect(p.totalJumps).toBe(6);
    expect(p.totalRolls).toBe(3);
    expect(p.totalTimeSec).toBeCloseTo(36.9);
    expect(p.history.map((r) => r.score)).toEqual([300, 50, 100]);

    const again = new ProfileStore(storage);
    expect(again.profile).toEqual(p);
  });

  it('does not call a tied score a new best, nor a zero-score first run', () => {
    const s = new ProfileStore(new FakeStorage());
    expect(s.recordRun(run({ score: 0 })).newBest).toBe(false);
    s.recordRun(run({ score: 40 }));
    expect(s.recordRun(run({ score: 40 }))).toEqual({ newBest: false, previousBest: 40 });
  });

  it('keeps only the newest 30 runs', () => {
    const s = new ProfileStore(new FakeStorage());
    for (let i = 0; i < 35; i++) s.recordRun(run({ score: i, at: i }));
    expect(s.profile.history).toHaveLength(30);
    expect(s.profile.history[0].at).toBe(34);
    expect(s.profile.history[29].at).toBe(5);
    expect(s.profile.totalRuns).toBe(35);
  });

  it('falls back to an empty profile on corrupt or foreign data', () => {
    for (const raw of ['{not json', 'null', '42', '"hi"', '[]', JSON.stringify({ version: 7, bestScore: 5 }), JSON.stringify({ foo: 1 })]) {
      const storage = new FakeStorage();
      storage.data.set(PROFILE_KEY, raw);
      const s = new ProfileStore(storage);
      expect(s.profile, raw).toEqual(emptyProfile());
    }
  });

  it('repairs bad fields without ever producing NaN', () => {
    const storage = new FakeStorage();
    storage.data.set(
      PROFILE_KEY,
      JSON.stringify({
        version: 1,
        bestScore: 'lots',
        bestDistance: -5,
        totalCoins: null,
        totalRuns: 4,
        totalDistance: 1e400,
        totalJumps: 2.7,
        history: [run({ score: 12 }), { score: 'x' }, 'junk', null, run({ score: Number.NaN })],
      }),
    );
    const s = new ProfileStore(storage);
    const p = s.profile;
    noNaN(p);
    expect(p.bestScore).toBe(12); // repaired from the history
    expect(p.bestDistance).toBe(90.5);
    expect(p.totalCoins).toBe(0);
    expect(p.totalRuns).toBe(4);
    expect(p.totalJumps).toBe(2);
    expect(p.history).toHaveLength(1); // records without a finite score are dropped
    for (const r of p.history) noNaN(r);
    s.recordRun(run({ score: Number.NaN, coins: Number.POSITIVE_INFINITY }));
    noNaN(s.profile);
    for (const r of s.profile.history) noNaN(r);
  });

  it('never throws when storage fails, and keeps the data in memory', () => {
    const s = new ProfileStore(throwing);
    expect(s.profile).toEqual(emptyProfile());
    expect(() => s.recordRun(run({ score: 70 }))).not.toThrow();
    expect(s.profile.bestScore).toBe(70);
    expect(s.recordRun(run({ score: 80 }))).toEqual({ newBest: true, previousBest: 70 });
    expect(() => s.reset()).not.toThrow();
    expect(s.profile.bestScore).toBe(0);
  });

  it('works with no storage at all', () => {
    const s = new ProfileStore(null);
    s.recordRun(run());
    expect(s.profile.totalRuns).toBe(1);
  });

  it('reset clears the stored profile', () => {
    const storage = new FakeStorage();
    const s = new ProfileStore(storage);
    s.recordRun(run());
    s.reset();
    expect(s.profile).toEqual(emptyProfile());
    expect(new ProfileStore(storage).profile).toEqual(emptyProfile());
  });

  it('uses a custom key', () => {
    const storage = new FakeStorage();
    new ProfileStore(storage, 'k').recordRun(run());
    expect(storage.data.has('k')).toBe(true);
    expect(storage.data.has(PROFILE_KEY)).toBe(false);
  });

  it('does not let callers mutate the stored profile through the getter', () => {
    const s = new ProfileStore(new FakeStorage());
    s.recordRun(run());
    expect(Object.isFrozen(s.profile)).toBe(true);
  });
});
