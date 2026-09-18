/**
 * Workout rollups: today, this week, the streak, all time, and a calorie *estimate*.
 * Spec: docs/superpowers/specs/2026-09-18-settings-workout.md ("Workout screen").
 *
 * Every function here is pure — profile in, numbers out — and every date question is answered in
 * **local** calendar time via `dayKey` / `shiftDay`, never by dividing milliseconds by 86 400 000.
 * A day is 23 or 25 hours long twice a year, and a streak that breaks on the clocks changing is a
 * bug the player would read as the game calling them lazy.
 */
import { dayKey, shiftDay, type DayStat, type Profile, type StoredRun } from './profile';

export const WEEK_DAYS = 7;

/**
 * Jogging in place, MET 8.0 (Ainsworth 2011 compendium, code 02048 "running in place").
 * A single number for an activity that varies with effort: this is why the screen says "rough".
 */
export const JOG_MET = 8;

/**
 * The weight assumed when the player has not offered one. Stated on screen beside every calorie
 * figure — the game asks nobody to step on a scale to see their own runs.
 */
export const ASSUMED_WEIGHT_KG = 70;

export const WEIGHT_MIN_KG = 30;
export const WEIGHT_MAX_KG = 200;

const EMPTY_DAY: DayStat = Object.freeze({ activeSeconds: 0, steps: 0, distance: 0, coins: 0, runs: 0 });

/** One day's totals, or a day of zeros. Never undefined: the week chart needs seven of these. */
export function dayStat(profile: Profile, key: string): DayStat {
  return profile.days[key] ?? EMPTY_DAY;
}

export interface WeekDay {
  /** `YYYY-MM-DD`, local. */
  key: string;
  /** Single letter for the axis: M T W T F S S. */
  initial: string;
  /** Short label for a screen reader: "Mon 15 Sep". */
  label: string;
  activeSeconds: number;
  runs: number;
  /** True for the last bar — the day the player is standing in right now. */
  today: boolean;
}

export interface WorkoutStats {
  /** The day everything was rolled up against, so a re-render at midnight is visibly a new day. */
  todayKey: string;
  today: DayStat;
  /** Oldest first, exactly WEEK_DAYS entries, ending today. */
  week: readonly WeekDay[];
  /** The tallest bar's active seconds; 0 when the week is empty. Scales the chart. */
  weekPeak: number;
  weekActiveSeconds: number;
  weekRuns: number;
  /** Consecutive days with at least one run, counting back from today (or yesterday). */
  streak: number;
  /** The longest streak anywhere in the kept day map. */
  bestStreak: number;
  allTime: AllTime;
  /** Newest first, straight off the profile, each flagged if it was a personal best at the time. */
  recent: readonly RecentRun[];
  /** True when nothing has ever been recorded — the screen shows its invitation instead. */
  empty: boolean;
}

export interface AllTime {
  runs: number;
  distance: number;
  coins: number;
  steps: number;
  activeSeconds: number;
  bestScore: number;
  bestDistance: number;
  /** The single longest run, in seconds. */
  longestRunSec: number;
  /** Days with at least one run. */
  activeDays: number;
}

export interface RecentRun extends StoredRun {
  /** True when this run beat every run before it — the profile's history is newest first. */
  newBest: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDay(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "Mon 15 Sep" for a day key, or the key itself if it is somehow not one. */
export function dayLabel(key: string): string {
  const d = parseDay(key);
  return d ? `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` : key;
}

/** The weekday initial for the chart axis. */
export function dayInitial(key: string): string {
  const d = parseDay(key);
  return d ? WEEKDAYS[d.getDay()][0] : '?';
}

/** The seven days ending on `todayKey`, oldest first. */
export function weekDays(profile: Profile, todayKey: string): WeekDay[] {
  const out: WeekDay[] = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const key = shiftDay(todayKey, -i);
    const stat = dayStat(profile, key);
    out.push({ key, initial: dayInitial(key), label: dayLabel(key), activeSeconds: stat.activeSeconds, runs: stat.runs, today: i === 0 });
  }
  return out;
}

/**
 * Days in a row ending today. Today not being run *yet* does not break a streak — it is still
 * early — so a streak that reaches yesterday counts, and only a gap before that ends it.
 */
export function streak(profile: Profile, todayKey: string): number {
  const ran = (key: string) => dayStat(profile, key).runs > 0;
  let cursor = ran(todayKey) ? todayKey : shiftDay(todayKey, -1);
  let n = 0;
  while (cursor && ran(cursor)) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/** The longest run of consecutive active days anywhere in the kept history. */
export function bestStreak(profile: Profile): number {
  const keys = Object.keys(profile.days)
    .filter((k) => profile.days[k].runs > 0)
    .sort();
  let best = 0;
  let run = 0;
  let prev = '';
  for (const k of keys) {
    run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
    prev = k;
    if (run > best) best = run;
  }
  return best;
}

export function allTime(profile: Profile): AllTime {
  let longestRunSec = 0;
  for (const r of profile.history) longestRunSec = Math.max(longestRunSec, r.timeSec);
  let activeDays = 0;
  for (const k in profile.days) if (profile.days[k].runs > 0) activeDays++;
  return {
    runs: profile.totalRuns,
    distance: profile.totalDistance,
    coins: profile.totalCoins,
    steps: profile.totalSteps,
    activeSeconds: profile.totalActiveSeconds,
    bestScore: profile.bestScore,
    bestDistance: profile.bestDistance,
    longestRunSec,
    activeDays,
  };
}

/**
 * The history with a "new best" flag on each run. History is newest first, so a run is flagged when
 * it beat everything *after* it in the list — which is everything that came before it in time.
 */
export function recentRuns(profile: Profile): RecentRun[] {
  const h = profile.history;
  const out: RecentRun[] = [];
  let bestSoFar = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    const r = h[i];
    out.push({ ...r, newBest: r.score > bestSoFar });
    bestSoFar = Math.max(bestSoFar, r.score);
  }
  return out.reverse();
}

/**
 * A **rough** calorie estimate: MET × weight(kg) × hours. Never shown without the word "rough" and
 * the weight it assumed beside it. It is a serviceable ballpark for a workout log and nothing more.
 */
export function calories(activeSeconds: number, weightKg: number = ASSUMED_WEIGHT_KG): number {
  if (!Number.isFinite(activeSeconds) || activeSeconds <= 0) return 0;
  const kg = Number.isFinite(weightKg) && weightKg > 0 ? Math.min(WEIGHT_MAX_KG, Math.max(WEIGHT_MIN_KG, weightKg)) : ASSUMED_WEIGHT_KG;
  return (JOG_MET * kg * activeSeconds) / 3600;
}

/** Everything the workout screen shows, from a profile and the instant it is being looked at. */
export function workoutStats(profile: Profile, now: number | Date = Date.now()): WorkoutStats {
  const todayKey = dayKey(now);
  const week = weekDays(profile, todayKey);
  let weekPeak = 0;
  let weekActiveSeconds = 0;
  let weekRuns = 0;
  for (const d of week) {
    weekPeak = Math.max(weekPeak, d.activeSeconds);
    weekActiveSeconds += d.activeSeconds;
    weekRuns += d.runs;
  }
  return {
    todayKey,
    today: dayStat(profile, todayKey),
    week,
    weekPeak,
    weekActiveSeconds,
    weekRuns,
    streak: streak(profile, todayKey),
    bestStreak: bestStreak(profile),
    allTime: allTime(profile),
    recent: recentRuns(profile),
    empty: profile.totalRuns === 0 && profile.history.length === 0,
  };
}

// ---------------------------------------------------------------- formatting

/** "12m", "1h 04m", "48s" — short enough to read across a room. */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Active minutes, the headline number: whole minutes, rounded, never negative. */
export const activeMinutes = (seconds: number): number => (Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0);

/** Metres under a kilometre, then kilometres to one decimal. */
export function formatDistance(metres: number): string {
  const m = Number.isFinite(metres) && metres > 0 ? metres : 0;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Thousands separated, so 12480 steps reads at a glance. */
export function formatCount(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return v.toLocaleString('en-IN');
}

/** "Today", "Yesterday", else "Mon 15 Sep". */
export function relativeDay(key: string, todayKey: string): string {
  if (key === todayKey) return 'Today';
  if (key === shiftDay(todayKey, -1)) return 'Yesterday';
  return dayLabel(key);
}

/** "9:42 pm", local, from a run's epoch ms. */
export function formatTimeOfDay(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const h = d.getHours();
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}
