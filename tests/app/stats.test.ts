import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAYS_MAX, ProfileStore, dayKey, emptyProfile, shiftDay, type DayStat, type Profile, type RunInput } from '../../src/app/profile';
import { streakWords } from '../../src/ui/workout';
import {
  ASSUMED_WEIGHT_KG,
  JOG_MET,
  activeMinutes,
  allTime,
  bestStreak,
  calories,
  dayInitial,
  dayLabel,
  formatCount,
  formatDistance,
  formatDuration,
  recentRuns,
  relativeDay,
  streak,
  streakRun,
  weekDays,
  workoutStats,
} from '../../src/app/stats';

/** A run with everything filled in, so a test only has to say what it cares about. */
const run = (over: Partial<RunInput> = {}): RunInput => ({
  at: Date.now(),
  score: 100,
  coins: 10,
  distance: 200,
  timeSec: 60,
  jumps: 2,
  rolls: 1,
  laneChanges: 4,
  steps: 80,
  hoverboardsUsed: 0,
  caughtReason: null,
  difficulty: 'cardio',
  seed: 1,
  input: 'webcam',
  activeSeconds: 55,
  mode: 'full',
  ...over,
});

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

/** Local noon, `n` days before `from`. Stepped through the calendar, like the code under test. */
function at(n: number, from = new Date(), hour = 12): number {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

/** Builds a profile by actually recording runs, so the day map is built the way the game builds it. */
function profileOf(runs: RunInput[]): Profile {
  const store = new ProfileStore(memory());
  for (const r of runs) store.recordRun(r);
  return store.profile;
}

const today = dayKey(Date.now());

describe('day keys', () => {
  it('is the local calendar date, not UTC', () => {
    const d = new Date(2026, 8, 18, 23, 30);
    expect(dayKey(d)).toBe('2026-09-18');
    // 00:05 the next morning is a different day even though it is minutes later.
    expect(dayKey(new Date(2026, 8, 19, 0, 5))).toBe('2026-09-19');
  });

  it('pads single-digit months and days', () => {
    expect(dayKey(new Date(2026, 0, 5, 9))).toBe('2026-01-05');
  });

  it('refuses an invalid date rather than inventing one', () => {
    expect(dayKey(Number.NaN)).toBe('');
    expect(dayKey(new Date('nonsense'))).toBe('');
    expect(shiftDay('not-a-day', -1)).toBe('');
  });

  it('steps across month and year ends', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29'); // leap year
  });

  it('labels a day for the axis and for a screen reader', () => {
    expect(dayLabel('2026-09-18')).toBe('Fri 18 Sep');
    expect(dayInitial('2026-09-18')).toBe('F');
    expect(dayInitial('rubbish')).toBe('?');
  });

  it('names today and yesterday by name', () => {
    expect(relativeDay(today, today)).toBe('Today');
    expect(relativeDay(shiftDay(today, -1), today)).toBe('Yesterday');
    expect(relativeDay('2026-09-18', '2026-09-30')).toBe('Fri 18 Sep');
  });
});

describe('DST boundaries', () => {
  const realTz = process.env.TZ;
  // New York springs forward 8 Mar 2026 (a 23-hour day) and falls back 1 Nov 2026 (25 hours).
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = realTz;
  });

  it('does not skip the short day when the clocks go forward', () => {
    expect(shiftDay('2026-03-09', -1)).toBe('2026-03-08');
    expect(shiftDay('2026-03-08', -1)).toBe('2026-03-07');
    // 23 hours after local midnight on the 8th is still the 8th.
    expect(dayKey(new Date(2026, 2, 8, 23, 30))).toBe('2026-03-08');
  });

  it('does not repeat the long day when the clocks go back', () => {
    expect(shiftDay('2026-11-02', -1)).toBe('2026-11-01');
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
    expect(dayKey(new Date(2026, 10, 1, 1, 30))).toBe('2026-11-01');
  });

  it('keeps a streak across the spring-forward day', () => {
    const p = profileOf([
      run({ at: new Date(2026, 2, 7, 12).getTime() }),
      run({ at: new Date(2026, 2, 8, 12).getTime() }),
      run({ at: new Date(2026, 2, 9, 12).getTime() }),
    ]);
    expect(streak(p, '2026-03-09')).toBe(3);
  });

  it('walks seven distinct days back from a DST boundary', () => {
    const keys = weekDays(emptyProfile(), '2026-03-09').map((d) => d.key);
    expect(new Set(keys).size).toBe(7);
    expect(keys).toEqual(['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']);
  });
});

describe('the week', () => {
  it('is seven days ending today, oldest first', () => {
    const w = weekDays(emptyProfile(), today);
    expect(w).toHaveLength(7);
    expect(w[6].key).toBe(today);
    expect(w[6].today).toBe(true);
    expect(w.filter((d) => d.today)).toHaveLength(1);
    expect(w[0].key).toBe(shiftDay(today, -6));
  });

  it('carries the totals for each day, and zero for the days without one', () => {
    const p = profileOf([run({ at: at(2), timeSec: 130, activeSeconds: 120 }), run({ at: at(0), timeSec: 320, activeSeconds: 300 })]);
    const w = weekDays(p, today);
    expect(w[6].activeSeconds).toBe(300);
    expect(w[4].activeSeconds).toBe(120);
    expect(w[5].activeSeconds).toBe(0);
    expect(w[5].runs).toBe(0);
  });

  it('sums the week and finds its tallest bar', () => {
    const s = workoutStats(profileOf([run({ at: at(1), timeSec: 110, activeSeconds: 100 }), run({ at: at(0), timeSec: 260, activeSeconds: 250 })]));
    expect(s.weekActiveSeconds).toBe(350);
    expect(s.weekPeak).toBe(250);
    expect(s.weekRuns).toBe(2);
  });

  it('ignores a run older than the week when scaling the chart', () => {
    const s = workoutStats(profileOf([run({ at: at(20), timeSec: 5200, activeSeconds: 5000 }), run({ at: at(0), timeSec: 70, activeSeconds: 60 })]));
    expect(s.weekPeak).toBe(60);
  });
});

describe('streaks', () => {
  it('counts consecutive days ending today', () => {
    const p = profileOf([run({ at: at(2) }), run({ at: at(1) }), run({ at: at(0) })]);
    expect(streak(p, today)).toBe(3);
  });

  it('stops at a missed day', () => {
    const p = profileOf([run({ at: at(4) }), run({ at: at(3) }), run({ at: at(1) }), run({ at: at(0) })]);
    expect(streak(p, today)).toBe(2);
  });

  it('survives today not having happened yet', () => {
    const p = profileOf([run({ at: at(2) }), run({ at: at(1) })]);
    expect(streak(p, today)).toBe(2);
  });

  it('is broken once yesterday is missed too', () => {
    const p = profileOf([run({ at: at(3) }), run({ at: at(2) })]);
    expect(streak(p, today)).toBe(0);
  });

  it('is zero for a player who has never run', () => {
    expect(streak(emptyProfile(), today)).toBe(0);
    expect(bestStreak(emptyProfile())).toBe(0);
  });

  it('is one for a single run today', () => {
    expect(streak(profileOf([run({ at: at(0) })]), today)).toBe(1);
  });

  it('counts several runs on one day as one day', () => {
    const p = profileOf([run({ at: at(0, new Date(), 8) }), run({ at: at(0, new Date(), 20) })]);
    expect(streak(p, today)).toBe(1);
    expect(p.days[today].runs).toBe(2);
  });

  it('remembers the longest streak even after it is broken', () => {
    const p = profileOf([run({ at: at(9) }), run({ at: at(8) }), run({ at: at(7) }), run({ at: at(6) }), run({ at: at(1) }), run({ at: at(0) })]);
    expect(streak(p, today)).toBe(2);
    expect(bestStreak(p)).toBe(4);
  });
});

describe('all time', () => {
  it('reports the lifetime totals and the longest single run', () => {
    const p = profileOf([run({ at: at(1), timeSec: 90, score: 50 }), run({ at: at(0), timeSec: 240, score: 900, distance: 1500 })]);
    const a = allTime(p);
    expect(a.runs).toBe(2);
    expect(a.longestRunSec).toBe(240);
    expect(a.bestScore).toBe(900);
    expect(a.bestDistance).toBe(1500);
    expect(a.activeDays).toBe(2);
  });

  it('is all zeroes, not NaN, for an empty profile', () => {
    const a = allTime(emptyProfile());
    expect(Object.values(a).every((v) => v === 0)).toBe(true);
  });
});

describe('recent runs', () => {
  it('is newest first and flags the runs that were a best at the time', () => {
    const p = profileOf([run({ at: at(3), score: 100 }), run({ at: at(2), score: 80 }), run({ at: at(1), score: 500 })]);
    const list = recentRuns(p);
    expect(list.map((r) => r.score)).toEqual([500, 80, 100]);
    expect(list.map((r) => r.newBest)).toEqual([true, false, true]);
  });

  it('never flags a tie as a new best', () => {
    const p = profileOf([run({ at: at(2), score: 200 }), run({ at: at(1), score: 200 })]);
    expect(recentRuns(p).map((r) => r.newBest)).toEqual([false, true]);
  });

  it('is empty for an empty profile', () => {
    expect(recentRuns(emptyProfile())).toEqual([]);
  });
});

describe('calories', () => {
  it('is MET x kg x hours', () => {
    // One hour at the assumed weight.
    expect(calories(3600)).toBeCloseTo(JOG_MET * ASSUMED_WEIGHT_KG, 5);
    expect(calories(1800, 60)).toBeCloseTo((JOG_MET * 60) / 2, 5);
  });

  it('is zero rather than negative or NaN', () => {
    expect(calories(0)).toBe(0);
    expect(calories(-500)).toBe(0);
    expect(calories(Number.NaN)).toBe(0);
  });

  it('falls back to the assumed weight for a nonsense one', () => {
    expect(calories(3600, Number.NaN)).toBe(calories(3600));
    expect(calories(3600, 0)).toBe(calories(3600));
  });

  it('pulls an implausible weight into a believable band', () => {
    expect(calories(3600, 5)).toBe(calories(3600, 30));
    expect(calories(3600, 9000)).toBe(calories(3600, 200));
  });
});

describe('the whole rollup', () => {
  it('says "empty" only for a player who has never run', () => {
    expect(workoutStats(emptyProfile()).empty).toBe(true);
    expect(workoutStats(profileOf([run()])).empty).toBe(false);
  });

  it('answers a single run today with that run, everywhere', () => {
    const s = workoutStats(profileOf([run({ at: at(0), timeSec: 130, activeSeconds: 120, steps: 300, distance: 700, coins: 12 })]));
    expect(s.today.activeSeconds).toBe(120);
    expect(s.today.steps).toBe(300);
    expect(s.streak).toBe(1);
    expect(s.weekActiveSeconds).toBe(120);
    expect(s.allTime.runs).toBe(1);
    expect(s.recent).toHaveLength(1);
  });

  it('rolls up against the instant it was given, not the wall clock', () => {
    const p = profileOf([run({ at: at(0) })]);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const s = workoutStats(p, tomorrow.getTime());
    expect(s.todayKey).toBe(dayKey(tomorrow));
    expect(s.today.runs).toBe(0);
    // Yesterday still counts: it is early tomorrow, not a broken habit.
    expect(s.streak).toBe(1);
  });
});

describe('formatting', () => {
  it('shortens a duration to something readable across a room', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(48)).toBe('48s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(754)).toBe('12m'); // 12m 34s: rounding up would flatter the player
    expect(formatDuration(3840)).toBe('1h 04m');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });

  it('rounds active minutes and never goes negative', () => {
    expect(activeMinutes(0)).toBe(0);
    expect(activeMinutes(-90)).toBe(0);
    expect(activeMinutes(89)).toBe(1);
    expect(activeMinutes(150)).toBe(3);
  });

  it('switches from metres to kilometres', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(640.4)).toBe('640 m');
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(12460)).toBe('12.5 km');
  });

  it('groups a big count', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(-4)).toBe('0');
    expect(formatCount(1234)).toContain('1');
    expect(formatCount(1234).replace(/\D/g, '')).toBe('1234');
  });
});

describe('a streak longer than the history we keep', () => {
  /** A profile with `n` consecutive active days ending today, capped the way the store caps it. */
  const daily = (n: number, todayKey: string): Profile => {
    const p = emptyProfile();
    const days: Record<string, DayStat> = {};
    for (let i = 0; i < n; i++) days[shiftDay(todayKey, -i)] = { activeSeconds: 600, steps: 900, distance: 800, coins: 10, runs: 1 };
    return { ...p, totalRuns: n, days: Object.fromEntries(Object.entries(days).sort().slice(-DAYS_MAX)) };
  };

  it('counts a normal streak exactly, and does not claim it is a floor', () => {
    const r = streakRun(daily(9, '2026-09-18'), '2026-09-18');
    expect(r).toEqual({ days: 9, capped: false });
    expect(streakWords(r.days, true, r.capped)).toBe('9 days in a row');
  });

  it('says "180+" rather than telling a player of 400 days that they managed 180', () => {
    const r = streakRun(daily(400, '2026-09-18'), '2026-09-18');
    expect(r.days).toBe(DAYS_MAX);
    expect(r.capped).toBe(true);
    expect(streakWords(r.days, true, r.capped)).toBe('180+ days in a row');
  });

  it('marks the days-moved total as a floor too, and only when it really is one', () => {
    const long = workoutStats(daily(400, '2026-09-18'), new Date(2026, 8, 18));
    expect(long.activeDaysCapped).toBe(true);
    expect(long.allTime.activeDays).toBe(DAYS_MAX);
    const short = workoutStats(daily(9, '2026-09-18'), new Date(2026, 8, 18));
    expect(short.activeDaysCapped).toBe(false);
    expect(short.streakCapped).toBe(false);
  });

  it('a gap inside the kept window is a real end, not a cap', () => {
    const p = daily(20, '2026-09-18');
    delete p.days[shiftDay('2026-09-18', -4)];
    const r = streakRun(p, '2026-09-18');
    expect(r).toEqual({ days: 4, capped: false });
  });

  it('an empty profile has no streak and nothing to qualify', () => {
    expect(streakRun(emptyProfile(), '2026-09-18')).toEqual({ days: 0, capped: false });
  });
});
