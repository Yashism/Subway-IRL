/**
 * Move-check tuning: turning a measured peak into a threshold, and remembering the result.
 * Spec: docs/superpowers/specs/2026-09-17-move-check.md ("Tuning").
 *
 * A tuned threshold sits at TUNE_FRACTION of what the player actually did — comfortably reachable,
 * still above their noise floor — clamped to a band around the shipped default so a freak
 * measurement (or a hostile localStorage) can never make a move impossible or hair-trigger.
 * Sensitivity keeps working on top: the detectors divide by it after these values are in place.
 */
import { MOVE_ORDER, MOVE_TUNING_KEY, type MoveId, type MoveTuning } from './moveCheckTypes';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { PlayMode } from './types';

export type ThresholdKey = keyof Thresholds;

export const TUNE_FRACTION = 0.55;
export const TUNE_MIN_FACTOR = 0.6;
export const TUNE_MAX_FACTOR = 1.6;

/**
 * The re-arm (hysteresis) key that follows each enter key. Per the sensitivity-exemption ruling in
 * `thresholds.ts`, a re-arm key is never tuned on its own: it keeps its default ratio to the key it
 * belongs to, so the gap that stops one move firing twice scales with the move.
 */
export const REARM_OF = {
  kneeLift: 'kneeRelease',
  laneEnter: 'laneExit',
  leanDeg: 'leanRearmDeg',
  noseShift: 'noseRearm',
  jumpRise: 'jumpRearm',
  smallJumpRise: 'smallJumpRearm',
} as const satisfies Partial<Record<ThresholdKey, ThresholdKey>>;

/** The keys a check may write, including the re-arm companions. Nothing else is ever stored. */
export const TUNABLE_KEYS: readonly ThresholdKey[] = [
  'kneeLift',
  'kneeRelease',
  'wristPump',
  'bobMinAmp',
  'laneEnter',
  'laneExit',
  'leanDeg',
  'leanRearmDeg',
  'noseShift',
  'noseRearm',
  'jumpRise',
  'jumpRearm',
  'smallJumpRise',
  'smallJumpRearm',
  'rollDrop',
  'duckDrop',
];

const TUNABLE = new Set<string>(TUNABLE_KEYS);
const MOVES = new Set<string>(MOVE_ORDER);
const MODES: readonly PlayMode[] = ['full', 'small'];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The allowed band for `key`: a tuned value outside it is pulled back in. */
export function tuningRange(key: ThresholdKey): { min: number; max: number } {
  const d = DEFAULT_THRESHOLDS[key];
  return { min: TUNE_MIN_FACTOR * d, max: TUNE_MAX_FACTOR * d };
}

/**
 * The threshold for a player whose best attempt measured `peak`, in `key`'s own units.
 * A peak that is missing, negative or not a number lands on the bottom of the band — which is what
 * "use an easier setting" means when the move was never really seen.
 */
export function tunedValue(key: ThresholdKey, peak: number): number {
  const { min, max } = tuningRange(key);
  if (!Number.isFinite(peak) || peak <= 0) return min;
  return clamp(TUNE_FRACTION * peak, min, max);
}

/** Writes `key` — and its re-arm companion, proportionally — into `out`. */
export function tuneKey(out: Partial<Thresholds>, key: ThresholdKey, peak: number): void {
  const value = tunedValue(key, peak);
  out[key] = value;
  const rearm: ThresholdKey | undefined = (REARM_OF as Partial<Record<ThresholdKey, ThresholdKey>>)[key];
  if (rearm) out[rearm] = value * (DEFAULT_THRESHOLDS[rearm] / DEFAULT_THRESHOLDS[key]);
}

function cleanThresholds(v: unknown): Partial<Thresholds> {
  const out: Partial<Thresholds> = {};
  if (!isObj(v)) return out;
  for (const key of TUNABLE_KEYS) {
    const raw = Object.hasOwn(v, key) ? v[key] : undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    const { min, max } = tuningRange(key);
    out[key] = clamp(raw, min, max);
  }
  return out;
}

function cleanPeaks(v: unknown): Partial<Record<MoveId, number>> {
  const out: Partial<Record<MoveId, number>> = {};
  if (!isObj(v)) return out;
  for (const id of MOVE_ORDER) {
    const raw = Object.hasOwn(v, id) ? v[id] : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) out[id] = raw;
  }
  return out;
}

function cleanKeyPeaks(v: unknown): Partial<Record<ThresholdKey, number>> | undefined {
  if (!isObj(v)) return undefined;
  const out: Partial<Record<ThresholdKey, number>> = {};
  let any = false;
  for (const key of TUNABLE_KEYS) {
    const raw = Object.hasOwn(v, key) ? v[key] : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      out[key] = raw;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Validates one stored record. Returns null only when it is not an object with a real play mode;
 * anything else — junk fields, unknown threshold keys, NaNs, values outside the band — is dropped
 * or pulled back into range, so a survivor is always safe to apply.
 */
export function cleanTuning(v: unknown): MoveTuning | null {
  if (!isObj(v)) return null;
  const mode = v.mode;
  if (mode !== 'full' && mode !== 'small') return null;
  const at = typeof v.at === 'number' && Number.isFinite(v.at) && v.at >= 0 ? v.at : 0;
  const out: MoveTuning = { mode, at, thresholds: cleanThresholds(v.thresholds), peaks: cleanPeaks(v.peaks) };
  const keyPeaks = cleanKeyPeaks(v.keyPeaks);
  if (keyPeaks) out.keyPeaks = keyPeaks;
  return out;
}

/**
 * Puts `tuning` in force on a live thresholds object, in place. Every tunable key it does not
 * mention goes back to its default, so re-applying is total rather than cumulative; a null tuning
 * restores the defaults outright. The result can never hold a NaN or a value outside the band.
 */
export function applyTuning(th: Thresholds, tuning: MoveTuning | null): void {
  const clean = tuning ? cleanTuning(tuning) : null;
  for (const key of TUNABLE_KEYS) {
    const v = clean?.thresholds[key];
    th[key] = v === undefined ? DEFAULT_THRESHOLDS[key] : v;
  }
}

export type TuningStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredFile {
  version: 1;
  modes: Partial<Record<PlayMode, MoveTuning>>;
}

/** Reads the stored file. Corrupt, wrong-version or hostile data yields no records and never throws. */
export function parseTuningFile(raw: string | null): Partial<Record<PlayMode, MoveTuning>> {
  const out: Partial<Record<PlayMode, MoveTuning>> = {};
  if (raw === null) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObj(data) || data.version !== 1 || !isObj(data.modes)) return out;
  const modes = data.modes;
  for (const mode of MODES) {
    if (!Object.hasOwn(modes, mode)) continue;
    const record = cleanTuning(modes[mode]);
    // A record filed under the wrong mode is a mix-up, not a migration: drop it.
    if (record && record.mode === mode) out[mode] = record;
  }
  return out;
}

function defaultStorage(): TuningStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

/**
 * The saved move tuning, one record per play mode. Storage is optional at every step: a blocked or
 * full localStorage leaves the tuning working for this session, held in memory.
 */
export class MoveTuningStore {
  private readonly storage: TuningStorage | null;
  private readonly modes: Partial<Record<PlayMode, MoveTuning>>;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: TuningStorage | null, private readonly key = MOVE_TUNING_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(key) : null;
    } catch {
      raw = null;
    }
    this.modes = parseTuningFile(raw);
  }

  get(mode: PlayMode): MoveTuning | null {
    return this.modes[mode] ?? null;
  }

  /** True when this machine has never recorded a check — the cue to run one unprompted. */
  get empty(): boolean {
    return MODES.every((m) => this.modes[m] === undefined);
  }

  save(tuning: MoveTuning): void {
    const clean = cleanTuning(tuning);
    if (!clean) return;
    this.modes[clean.mode] = clean;
    this.write();
  }

  /** Forgets one mode's tuning, or every mode's when called with no argument. */
  clear(mode?: PlayMode): void {
    for (const m of MODES) if (mode === undefined || m === mode) delete this.modes[m];
    this.write();
  }

  private write(): void {
    if (!this.storage) return;
    try {
      if (this.empty) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify({ version: 1, modes: this.modes } satisfies StoredFile));
    } catch {
      // Quota or privacy mode: keep playing with the in-memory tuning.
    }
  }
}
