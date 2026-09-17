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
  /** Newest first, at most HISTORY_MAX. */
  history: RunRecord[];
}

export interface RecordResult {
  newBest: boolean;
  previousBest: number;
}

export type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const PROFILE_KEY = 'subway-irl.profile.v1';
export const HISTORY_MAX = 30;

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
  history: [],
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite, non-negative number, else `fallback`. */
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const int = (v: unknown): number => Math.floor(num(v));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 40) : fallback);

function cleanRun(v: unknown): RunRecord | null {
  if (!isObj(v)) return null;
  if (typeof v.score !== 'number' || !Number.isFinite(v.score)) return null;
  return sanitizeRun(v);
}

function sanitizeRun(v: Record<string, unknown> | RunRecord): RunRecord {
  const r = v as Record<string, unknown>;
  return Object.freeze({
    at: num(r.at),
    score: int(r.score),
    coins: int(r.coins),
    distance: num(r.distance),
    timeSec: num(r.timeSec),
    jumps: int(r.jumps),
    rolls: int(r.rolls),
    laneChanges: int(r.laneChanges),
    steps: int(r.steps),
    hoverboardsUsed: int(r.hoverboardsUsed),
    caughtReason: typeof r.caughtReason === 'string' ? str(r.caughtReason) : null,
    difficulty: str(r.difficulty),
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? r.seed : 0,
    input: str(r.input),
  });
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
  const history: RunRecord[] = [];
  if (Array.isArray(data.history)) {
    for (const item of data.history) {
      const r = cleanRun(item);
      if (r) history.push(r);
      if (history.length >= HISTORY_MAX) break;
    }
  }
  let histBest = 0;
  let histDist = 0;
  for (const r of history) {
    histBest = Math.max(histBest, r.score);
    histDist = Math.max(histDist, r.distance);
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
    totalTimeSec: num(data.totalTimeSec),
    history,
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
  recordRun(run: RunRecord): RecordResult {
    const r = sanitizeRun(run);
    const p = this.current;
    const previousBest = p.bestScore;
    const newBest = r.score > previousBest;
    const history = [r, ...p.history].slice(0, HISTORY_MAX);
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
      history,
    });
    this.save();
    return { newBest, previousBest };
  }

  reset(): void {
    this.current = freeze(emptyProfile());
    this.save();
  }

  private save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or privacy mode: keep playing with the in-memory profile.
    }
  }
}
