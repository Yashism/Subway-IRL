/**
 * The workout fields the profile gained: per-run activeSeconds / mode / day, the capped `days` map,
 * and the silent migration of a v1 record that has none of them.
 * (The original profile behaviour is covered by profile.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { DAYS_MAX, HISTORY_MAX, PROFILE_KEY, ProfileStore, dayKey, parseProfile, type RunInput } from '../../src/app/profile';

const run = (over: Partial<RunInput> = {}): RunInput => ({
  at: Date.now(),
  score: 100,
  coins: 10,
  distance: 200,
  timeSec: 120,
  jumps: 2,
  rolls: 1,
  laneChanges: 4,
  steps: 90,
  hoverboardsUsed: 0,
  caughtReason: null,
  difficulty: 'cardio',
  seed: 1,
  input: 'webcam',
  ...over,
});

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

/** Local noon, `n` days ago. */
function at(n: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

const today = dayKey(Date.now());

describe('the new per-run fields', () => {
  it('fills in the day key from when the run ended', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ at: at(3) }));
    expect(s.profile.history[0].day).toBe(dayKey(at(3)));
  });

  it('takes activeSeconds when it is given', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ timeSec: 200, activeSeconds: 150 }));
    expect(s.profile.history[0].activeSeconds).toBe(150);
    expect(s.profile.totalActiveSeconds).toBe(150);
  });

  it('falls back to the run length when it is not', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ timeSec: 200 }));
    expect(s.profile.history[0].activeSeconds).toBe(200);
  });

  it('never claims more active time than the run was long', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ timeSec: 60, activeSeconds: 9999 }));
    expect(s.profile.history[0].activeSeconds).toBe(60);
  });

  it('keeps the play mode, and shrugs off a nonsense one', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ mode: 'small' }));
    s.recordRun(run({ mode: undefined }));
    expect(s.profile.history[1].mode).toBe('small');
    expect(s.profile.history[0].mode).toBe('');
  });
});

describe('the days map', () => {
  it('adds up every run on a day', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ at: at(0, 8), timeSec: 100, steps: 50, distance: 300, coins: 5 }));
    s.recordRun(run({ at: at(0, 20), timeSec: 140, steps: 70, distance: 400, coins: 7 }));
    expect(s.profile.days[today]).toEqual({ activeSeconds: 240, steps: 120, distance: 700, coins: 12, runs: 2 });
  });

  it('outlives the 30-run history cap', () => {
    const s = new ProfileStore(memory());
    for (let i = 0; i < HISTORY_MAX + 5; i++) s.recordRun(run({ at: at(40 - i) }));
    expect(s.profile.history).toHaveLength(HISTORY_MAX);
    // Every day is still counted, including the ones whose runs have fallen off the list.
    expect(Object.keys(s.profile.days)).toHaveLength(HISTORY_MAX + 5);
  });

  it('keeps only the newest DAYS_MAX days', () => {
    const days: Record<string, unknown> = {};
    for (let i = 0; i < DAYS_MAX + 40; i++) {
      days[dayKey(at(i))] = { activeSeconds: 60, steps: 1, distance: 1, coins: 1, runs: 1 };
    }
    const p = parseProfile(JSON.stringify({ version: 1, days }));
    expect(Object.keys(p.days)).toHaveLength(DAYS_MAX);
    expect(p.days[today]).toBeDefined();
    expect(p.days[dayKey(at(DAYS_MAX + 10))]).toBeUndefined();
  });

  it('survives the cap while recording, keeping today', () => {
    const s = new ProfileStore(memory());
    for (let i = DAYS_MAX + 20; i >= 0; i--) s.recordRun(run({ at: at(i) }));
    expect(Object.keys(s.profile.days)).toHaveLength(DAYS_MAX);
    expect(s.profile.days[today]).toBeDefined();
  });
});

describe('migrating a profile that predates all of this', () => {
  /** Exactly what the shipped v1 store used to write: no days, no activeSeconds, no mode, no day. */
  const legacy = {
    version: 1,
    bestScore: 4210,
    bestDistance: 1800,
    totalCoins: 900,
    totalRuns: 14,
    totalDistance: 12000,
    totalJumps: 60,
    totalRolls: 40,
    totalTimeSec: 2400,
    history: [
      { at: at(1), score: 4210, coins: 88, distance: 1800, timeSec: 300, jumps: 14, rolls: 9, laneChanges: 30, steps: 400, hoverboardsUsed: 1, caughtReason: 'chaser', difficulty: 'cardio', seed: 3, input: 'webcam' },
      { at: at(2), score: 900, coins: 20, distance: 600, timeSec: 150, jumps: 4, rolls: 2, laneChanges: 11, steps: 180, hoverboardsUsed: 0, caughtReason: null, difficulty: 'cardio', seed: 4, input: 'webcam' },
    ],
  };

  it('loads, keeps every earned total and loses nothing', () => {
    const p = parseProfile(JSON.stringify(legacy));
    expect(p.bestScore).toBe(4210);
    expect(p.bestDistance).toBe(1800);
    expect(p.totalCoins).toBe(900);
    expect(p.totalRuns).toBe(14);
    expect(p.totalDistance).toBe(12000);
    expect(p.totalTimeSec).toBe(2400);
    expect(p.history).toHaveLength(2);
  });

  it('gains the new fields without the player noticing', () => {
    const p = parseProfile(JSON.stringify(legacy));
    expect(p.history[0].activeSeconds).toBe(300);
    expect(p.history[0].day).toBe(dayKey(at(1)));
    expect(p.history[0].mode).toBe('');
    // Time played is the only honest answer for a record written before active time existed.
    expect(p.totalActiveSeconds).toBe(2400);
    expect(p.totalSteps).toBe(580);
  });

  it('backfills the day map from the runs it still has, so the streak is not reset to zero', () => {
    const p = parseProfile(JSON.stringify(legacy));
    expect(p.days[dayKey(at(1))]).toEqual({ activeSeconds: 300, steps: 400, distance: 1800, coins: 88, runs: 1 });
    expect(p.days[dayKey(at(2))].runs).toBe(1);
  });

  it('never double-counts a day map that is already there', () => {
    const withDays = { ...legacy, days: { [dayKey(at(1))]: { activeSeconds: 300, steps: 400, distance: 1800, coins: 88, runs: 1 } } };
    const p = parseProfile(JSON.stringify(withDays));
    expect(p.days[dayKey(at(1))].runs).toBe(1);
    expect(Object.keys(p.days)).toHaveLength(1);
  });

  it('round-trips through the store and comes back the same', () => {
    const storage = memory();
    storage.map.set(PROFILE_KEY, JSON.stringify(legacy));
    const first = new ProfileStore(storage).profile;
    const second = new ProfileStore(storage).profile;
    expect(second.totalActiveSeconds).toBe(first.totalActiveSeconds);
    expect(Object.keys(second.days)).toEqual(Object.keys(first.days));
    // Re-reading a migrated profile must not fold the history in a second time.
    expect(second.days[dayKey(at(1))].runs).toBe(1);
  });

  it('keeps playing from where it left off', () => {
    const storage = memory();
    storage.map.set(PROFILE_KEY, JSON.stringify(legacy));
    const s = new ProfileStore(storage);
    expect(s.recordRun(run({ score: 9000, at: at(0) }))).toEqual({ newBest: true, previousBest: 4210 });
    expect(s.profile.totalRuns).toBe(15);
    expect(s.profile.days[today].runs).toBe(1);
  });
});

describe('corrupt and hostile data', () => {
  const totals = { version: 1, bestScore: 5000, totalCoins: 700, totalRuns: 9, totalDistance: 4000, totalTimeSec: 1200 };

  it('drops a broken days map without touching the totals', () => {
    for (const days of ['nonsense', 42, null, [], { '2026-13-99': { runs: 4 } }, { good: 'bad' }]) {
      const p = parseProfile(JSON.stringify({ ...totals, days }));
      expect(p.bestScore).toBe(5000);
      expect(p.totalCoins).toBe(700);
      expect(p.totalRuns).toBe(9);
      expect(Object.keys(p.days)).toHaveLength(0);
    }
  });

  it('drops only the bad days out of a half-good map', () => {
    const p = parseProfile(
      JSON.stringify({
        ...totals,
        days: {
          [today]: { activeSeconds: 100, steps: 10, distance: 20, coins: 3, runs: 1 },
          'not-a-day': { runs: 5 },
          '2026-01-02': 'rubbish',
          '2026-01-03': { activeSeconds: -5, steps: Number.NaN, distance: 'x', coins: null, runs: 2 },
        },
      }),
    );
    expect(Object.keys(p.days).sort()).toEqual(['2026-01-03', today].sort());
    expect(p.days[today].runs).toBe(1);
    // The bad numbers go, the run count survives — the day still happened.
    expect(p.days['2026-01-03']).toEqual({ activeSeconds: 0, steps: 0, distance: 0, coins: 0, runs: 2 });
  });

  it('never throws and never returns NaN for a hostile activeSeconds', () => {
    const p = parseProfile(
      JSON.stringify({
        ...totals,
        totalActiveSeconds: Number.MAX_VALUE,
        history: [{ ...run({ at: at(0), timeSec: 60 }), activeSeconds: 'lots', day: 'whenever' }],
      }),
    );
    expect(Number.isFinite(p.totalActiveSeconds)).toBe(true);
    // Never more than the time actually played.
    expect(p.totalActiveSeconds).toBe(1200);
    expect(p.history[0].activeSeconds).toBe(60);
    expect(p.history[0].day).toBe(dayKey(at(0)));
  });

  it('gives an exportable copy of everything it holds', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run({ score: 321 }));
    const parsed = JSON.parse(s.exportJson()) as { key: string; profile: { bestScore: number; days: Record<string, unknown> } };
    expect(parsed.key).toBe(PROFILE_KEY);
    expect(parsed.profile.bestScore).toBe(321);
    expect(Object.keys(parsed.profile.days)).toHaveLength(1);
  });

  it('clears the day map along with everything else on reset', () => {
    const s = new ProfileStore(memory());
    s.recordRun(run());
    s.reset();
    expect(s.profile.days).toEqual({});
    expect(s.profile.totalActiveSeconds).toBe(0);
    expect(s.profile.totalSteps).toBe(0);
  });
});
