/**
 * Local player profile (spec §5.9): best score, lifetime totals and recent runs,
 * kept in localStorage. Storage is optional: every access is guarded, and a failed
 * read or write leaves the game working with the profile held in memory.
 */

export interface RunRecord {
  /** Epoch ms when the run ended. */
  at: number;
  score: number;
  coins: number;
  distance: number;
  timeSec: number;
  jumps: number;
  rolls: number;
  laneChanges: number;
  steps: number;
  hoverboardsUsed: number;
  caughtReason: string | null;
  difficulty: string;
  seed: number;
  input: string;
}

/**
 * A run as the profile keeps it: everything the caller handed in, plus the three fields the store
 * fills in for the workout rollups. They are separate from `RunRecord` on purpose — a caller only
 * has to know about the run it just played, and an old record that has none of these still loads.
 */
export interface StoredRun extends RunRecord {
  /**
   * Seconds the player was actually working — the run's time minus anything paused.
   * Records written before this field existed fall back to `timeSec`, which is what they meant.
   */
  activeSeconds: number;
  /** The play mode this run used ('full' / 'small'), or '' when it was never recorded. */
  mode: string;
  /** Local date the run ended, `YYYY-MM-DD`. Stored so a rollup never re-derives it from a stale clock. */
  day: string;
}

/** One day's totals, kept long after the run itself has fallen off the end of `history`. */
export interface DayStat {
  activeSeconds: number;
  steps: number;
  distance: number;
  coins: number;
  runs: number;
}

export interface Profile {
  version: 1;
  bestScore: number;
  bestDistance: number;
  totalCoins: number;
  totalRuns: number;
  totalDistance: number;
  totalJumps: number;
  totalRolls: number;
  totalTimeSec: number;
  /** Lifetime seconds of actual movement. Backfilled from `totalTimeSec` for older profiles. */
  totalActiveSeconds: number;
  totalSteps: number;
  /** Newest first, at most HISTORY_MAX. */
  history: StoredRun[];
  /** Local day key → totals, newest DAYS_MAX days. Survives the history cap, so the streak does too. */
  days: Record<string, DayStat>;
}

/**
 * What a finished run hands in. Everything the store can work out for itself is optional, so the
 * caller that has only ever filled in the original fields keeps compiling — and keeps working.
 */
export type RunInput = RunRecord & Partial<Pick<StoredRun, 'activeSeconds' | 'mode' | 'day'>>;

export interface RecordResult {
  newBest: boolean;
  previousBest: number;
}

export type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const PROFILE_KEY = 'subway-irl.profile.v1';
export const HISTORY_MAX = 30;
/** Roughly half a year of daily totals: enough for any streak a person will actually hold. */
export const DAYS_MAX = 180;

export const emptyProfile = (): Profile => ({
  version: 1,
  bestScore: 0,
  bestDistance: 0,
  totalCoins: 0,
  totalRuns: 0,
  totalDistance: 0,
  totalJumps: 0,
  totalRolls: 0,
  totalTimeSec: 0,
  totalActiveSeconds: 0,
  totalSteps: 0,
  history: [],
  days: {},
});

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * The **local** calendar date of an instant, `YYYY-MM-DD`.
 *
 * Local, not UTC: a run at 11pm IST belongs to that evening's workout, not to tomorrow. Built from
 * the calendar getters rather than from an ISO string or millisecond arithmetic, so a day that is
 * 23 or 25 hours long across a DST change still resolves to exactly one key.
 */
export function dayKey(at: number | Date): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  const t = d.getTime();
  if (!Number.isFinite(t)) return '';
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `n` days before `key`'s date, stepped through the local calendar so DST cannot drop or repeat a day. */
export function shiftDay(key: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return '';
  return dayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A key that names a day that really exists. The shape alone is not enough: `2026-13-99` matches
 * the pattern, and the calendar would quietly normalise it into some *other* real date, filing a
 * run under a day the player never had.
 */
export function isDayKey(v: unknown): v is string {
  return typeof v === 'string' && DAY_RE.test(v) && shiftDay(v, 0) === v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite, non-negative number, else `fallback`. */
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const int = (v: unknown): number => Math.floor(num(v));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 40) : fallback);

function cleanRun(v: unknown): StoredRun | null {
  if (!isObj(v)) return null;
  if (typeof v.score !== 'number' || !Number.isFinite(v.score)) return null;
  return sanitizeRun(v);
}

function sanitizeRun(v: Record<string, unknown> | RunInput): StoredRun {
  const r = v as Record<string, unknown>;
  const at = num(r.at);
  const timeSec = num(r.timeSec);
  // A missing `activeSeconds` is an old record, not a lazy one: before the field existed the whole
  // run was the workout, so `timeSec` is the honest answer and beats showing the player a zero.
  const active = typeof r.activeSeconds === 'number' && Number.isFinite(r.activeSeconds) && r.activeSeconds >= 0 ? r.activeSeconds : timeSec;
  const day = isDayKey(r.day) ? r.day : at > 0 ? dayKey(at) : '';
  return Object.freeze({
    at,
    score: int(r.score),
    coins: int(r.coins),
    distance: num(r.distance),
    timeSec,
    jumps: int(r.jumps),
    rolls: int(r.rolls),
    laneChanges: int(r.laneChanges),
    steps: int(r.steps),
    hoverboardsUsed: int(r.hoverboardsUsed),
    caughtReason: typeof r.caughtReason === 'string' ? str(r.caughtReason) : null,
    difficulty: str(r.difficulty),
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : 0,
    input: str(r.input),
    // A paused run cannot have been more active than it was long.
    activeSeconds: Math.min(active, timeSec),
    mode: str(r.mode),
    day,
  });
}

function cleanDay(v: unknown): DayStat | null {
  if (!isObj(v)) return null;
  const d: DayStat = {
    activeSeconds: num(v.activeSeconds),
    steps: int(v.steps),
    distance: num(v.distance),
    coins: int(v.coins),
    runs: int(v.runs),
  };
  // A day nothing happened on is not worth a slot; a day with runs but no numbers still is.
  return d.runs || d.activeSeconds || d.steps || d.distance || d.coins ? d : null;
}

/**
 * The stored day map: bad keys and bad values dropped, newest DAYS_MAX kept. Hostile data here can
 * only ever cost the player a chart, never a total — the lifetime numbers are parsed separately.
 */
function cleanDays(v: unknown): Record<string, DayStat> {
  const out: Record<string, DayStat> = {};
  if (!isObj(v)) return out;
  const keys = Object.keys(v)
    .filter(isDayKey)
    .sort()
    .slice(-DAYS_MAX);
  for (const k of keys) {
    const d = cleanDay(v[k]);
    if (d) out[k] = d;
  }
  return out;
}

/** Folds one run into a day map, in place. */
function addToDays(days: Record<string, DayStat>, r: StoredRun): void {
  if (!r.day) return;
  const d = days[r.day] ?? { activeSeconds: 0, steps: 0, distance: 0, coins: 0, runs: 0 };
  days[r.day] = {
    activeSeconds: d.activeSeconds + r.activeSeconds,
    steps: d.steps + r.steps,
    distance: d.distance + r.distance,
    coins: d.coins + r.coins,
    runs: d.runs + 1,
  };
}

/** Drops all but the newest DAYS_MAX days, in place. */
function capDays(days: Record<string, DayStat>): void {
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - DAYS_MAX))) delete days[k];
}

/** Validates and migrates stored JSON. Anything that is not a v1 profile becomes empty. */
export function parseProfile(raw: string | null): Profile {
  if (raw === null) return emptyProfile();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyProfile();
  }
  if (!isObj(data) || data.version !== 1) return emptyProfile();
  const history: StoredRun[] = [];
  if (Array.isArray(data.history)) {
    for (const item of data.history) {
      const r = cleanRun(item);
      if (r) history.push(r);
      if (history.length >= HISTORY_MAX) break;
    }
  }
  let histBest = 0;
  let histDist = 0;
  let histSteps = 0;
  for (const r of history) {
    histBest = Math.max(histBest, r.score);
    histDist = Math.max(histDist, r.distance);
    histSteps += r.steps;
  }
  const totalTimeSec = num(data.totalTimeSec);
  const days = cleanDays(data.days);
  // A profile saved before the day map existed still has up to 30 runs in it: fold those in so the
  // week chart and the streak are right on the very first load, rather than starting the player
  // back at zero. Only ever done when the map is *entirely* absent, so nothing can be counted twice.
  if (Object.keys(days).length === 0) {
    for (const r of history) addToDays(days, r);
    capDays(days);
  }
  return {
    version: 1,
    bestScore: Math.max(int(data.bestScore), histBest),
    bestDistance: Math.max(num(data.bestDistance), histDist),
    totalCoins: int(data.totalCoins),
    totalRuns: Math.max(int(data.totalRuns), history.length),
    totalDistance: num(data.totalDistance),
    totalJumps: int(data.totalJumps),
    totalRolls: int(data.totalRolls),
    totalTimeSec,
    // Same reasoning as a run's own activeSeconds: before the field existed, time played was time worked.
    totalActiveSeconds: Math.min(num(data.totalActiveSeconds, totalTimeSec), totalTimeSec),
    totalSteps: Math.max(int(data.totalSteps), histSteps),
    history,
    days,
  };
}

function defaultStorage(): ProfileStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

const freeze = (p: Profile): Readonly<Profile> => {
  Object.freeze(p.history);
  Object.freeze(p.days);
  return Object.freeze(p);
};

export class ProfileStore {
  private readonly storage: ProfileStorage | null;
  private current: Readonly<Profile>;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: ProfileStorage | null, private readonly key = PROFILE_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(key) : null;
    } catch {
      raw = null;
    }
    this.current = freeze(parseProfile(raw));
  }

  get profile(): Readonly<Profile> {
    return this.current;
  }

  /** Records a finished run. Never throws: storage failures keep the data in memory. */
  recordRun(run: RunInput): RecordResult {
    const r = sanitizeRun(run);
    const p = this.current;
    const previousBest = p.bestScore;
    const newBest = r.score > previousBest;
    const history = [r, ...p.history].slice(0, HISTORY_MAX);
    const days = { ...p.days };
    addToDays(days, r);
    capDays(days);
    this.current = freeze({
      version: 1,
      bestScore: Math.max(previousBest, r.score),
      bestDistance: Math.max(p.bestDistance, r.distance),
      totalCoins: p.totalCoins + r.coins,
      totalRuns: p.totalRuns + 1,
      totalDistance: p.totalDistance + r.distance,
      totalJumps: p.totalJumps + r.jumps,
      totalRolls: p.totalRolls + r.rolls,
      totalTimeSec: p.totalTimeSec + r.timeSec,
      totalActiveSeconds: p.totalActiveSeconds + r.activeSeconds,
      totalSteps: p.totalSteps + r.steps,
      history,
      days,
    });
    this.save();
    return { newBest, previousBest };
  }

  reset(): void {
    this.current = freeze(emptyProfile());
    this.save();
  }

  /**
   * Everything this game knows about the player, as pretty JSON — the file the "export my data"
   * button hands over. Nothing is withheld and nothing is added: it is the stored record verbatim.
   */
  exportJson(): string {
    return JSON.stringify({ key: this.key, exportedAt: new Date().toISOString(), profile: this.current }, null, 2);
  }

  private save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or privacy mode: keep playing with the in-memory profile.
    }
  }
}
