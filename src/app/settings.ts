/**
 * The player's settings: the model, the validation and where it lives between sessions.
 * Spec: docs/superpowers/specs/2026-09-18-settings-workout.md ("Settings screen").
 *
 * Storage is never trusted and never fatal. A blocked, full, corrupt or actively hostile
 * localStorage leaves the game playable at sensible defaults — nothing in here throws, ever, and a
 * single bad field costs only that field. Two settings deliberately live elsewhere and are *not*
 * duplicated here: the chosen camera (`subway-irl.cameraId`, owned by the pose runtime) and the
 * mixer (`subway-irl.audio.v1`, owned by the audio settings store). The settings screen shows all
 * three together; only one of them is stored here.
 */
import type { ModeChoice } from './flow';
import { DEFAULT_OBSTACLES, OBSTACLE_AMOUNTS, obstacleLevel, type Difficulty, type ObstacleAmount } from '../game/config';
import type { LineId } from '../world/stations';

export const SETTINGS_KEY = 'subway-irl.settings.v1';

/**
 * The sensitivity band. Not the spec's 0.5–2.0: `PoseController` clamps to [0.75, 1.25], so a wider
 * slider would spend most of its travel doing nothing. This is the same range the debug monitor
 * offers, and the same value it sends.
 */
export const SENSITIVITY_MIN = 0.75;
export const SENSITIVITY_MAX = 1.25;
export const SENSITIVITY_STEP = 0.05;

export const LINES: readonly LineId[] = ['western', 'central', 'harbour'];
export const DIFFICULTIES: readonly Difficulty[] = ['chill', 'cardio', 'beast'];
export const MODE_CHOICES: readonly ModeChoice[] = ['auto', 'full', 'small'];

export interface GameSettings {
  /** How easily a move triggers. Higher is easier. */
  sensitivity: number;
  /** Which body the detectors expect; 'auto' lets calibration decide. */
  mode: ModeChoice;
  /** Mirror the camera preview. Display only — detection never sees this. */
  mirror: boolean;
  line: LineId;
  /** The run's pace: speed and how fast it builds. */
  difficulty: Difficulty;
  /** Obstacle difficulty 1–5: how hard the patterns get, and how soon (3 = as designed). */
  obstacleLevel: number;
  /** How busy the track is. */
  obstacleAmount: ObstacleAmount;
  /** Cuts screen shake and speed lines: comfort, and a cheap win on a weak GPU. */
  reducedMotion: boolean;
  /** Cuts bloom and the heavier effects. */
  reducedEffects: boolean;
  /**
   * Only ever set by a player who volunteered it, for the calorie estimate. Null means "use the
   * stated assumed weight" — the game never demands a number to show someone their own runs.
   */
  weightKg: number | null;
}

export const DEFAULT_SETTINGS: GameSettings = Object.freeze({
  sensitivity: 1,
  mode: 'auto',
  mirror: true,
  line: 'western',
  difficulty: 'cardio',
  obstacleLevel: DEFAULT_OBSTACLES.level,
  obstacleAmount: DEFAULT_OBSTACLES.amount,
  reducedMotion: false,
  reducedEffects: false,
  weightKg: null,
});

/** Human labels, used by the screen and by anything else that has to name one of these. */
export const LINE_NAMES: Record<LineId, string> = { western: 'Western', central: 'Central', harbour: 'Harbour' };
export const LINE_BLURBS: Record<LineId, string> = {
  western: 'Churchgate to Virar',
  central: 'CSMT to Kasara',
  harbour: 'CSMT to Panvel',
};
export const DIFFICULTY_NAMES: Record<Difficulty, string> = { chill: 'Chill', cardio: 'Cardio', beast: 'Beast' };
export const DIFFICULTY_BLURBS: Record<Difficulty, string> = {
  chill: 'Slower train, gentler ramp',
  cardio: 'The normal run',
  beast: 'Faster from the first whistle',
};
export const OBSTACLE_LEVEL_NAMES: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Gentle',
  2: 'Easy',
  3: 'Normal',
  4: 'Hard',
  5: 'Brutal',
};
export const OBSTACLE_LEVEL_BLURBS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Simple, one-at-a-time obstacles only',
  2: 'Nothing harder than the early patterns',
  3: 'The game as designed',
  4: 'The hard patterns arrive sooner',
  5: 'The hardest patterns, early and often',
};
export const OBSTACLE_AMOUNT_NAMES: Record<ObstacleAmount, string> = { few: 'Few', normal: 'Normal', lots: 'Lots' };
export const OBSTACLE_AMOUNT_BLURBS: Record<ObstacleAmount, string> = {
  few: 'Coin-only breathers between patterns',
  normal: 'The game as designed',
  lots: 'The busiest patterns more often',
};

/** Rounded into 1–5; anything that is not a number is the designed level. */
export const cleanObstacleLevel = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? obstacleLevel(v) : DEFAULT_OBSTACLES.level;

export const MODE_NAMES: Record<ModeChoice, string> = { auto: 'Auto', full: 'Full body', small: 'Small room' };
export const MODE_BLURBS: Record<ModeChoice, string> = {
  auto: 'Pick it from what the camera sees',
  full: 'Room to jog — knees and arms',
  small: 'Desk, sofa, small flat — lean and bob',
};

/** Sensitivity in words, because "1.15" tells a player standing 2 m away nothing at all. */
export function sensitivityWords(value: number): string {
  const v = cleanSensitivity(value);
  if (v <= 0.85) return 'Moves need to be big and clear';
  if (v < 0.97) return 'Slightly bigger moves needed';
  if (v <= 1.03) return 'The default — balanced';
  if (v < 1.15) return 'Moves trigger a little more easily';
  return 'Moves trigger very easily';
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Snapped to the slider's step so the stored value and the shown value can never disagree. */
export function cleanSensitivity(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.sensitivity;
  const snapped = Math.round(clamp(v, SENSITIVITY_MIN, SENSITIVITY_MAX) / SENSITIVITY_STEP) * SENSITIVITY_STEP;
  return Math.round(snapped * 100) / 100;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** A volunteered weight, or null. Out-of-range numbers are pulled into a believable band. */
export function cleanWeight(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(clamp(v, 30, 200));
}

/** Normalises anything at all into usable settings. Every field falls back on its own. */
export function cleanSettings(raw: unknown): GameSettings {
  const o = isObj(raw) ? raw : {};
  return {
    sensitivity: cleanSensitivity(o.sensitivity),
    mode: pick(o.mode, MODE_CHOICES, DEFAULT_SETTINGS.mode),
    mirror: bool(o.mirror, DEFAULT_SETTINGS.mirror),
    line: pick(o.line, LINES, DEFAULT_SETTINGS.line),
    difficulty: pick(o.difficulty, DIFFICULTIES, DEFAULT_SETTINGS.difficulty),
    obstacleLevel: cleanObstacleLevel(o.obstacleLevel),
    obstacleAmount: pick(o.obstacleAmount, OBSTACLE_AMOUNTS, DEFAULT_SETTINGS.obstacleAmount),
    reducedMotion: bool(o.reducedMotion, DEFAULT_SETTINGS.reducedMotion),
    reducedEffects: bool(o.reducedEffects, DEFAULT_SETTINGS.reducedEffects),
    weightKg: cleanWeight(o.weightKg),
  };
}

/**
 * URL overrides, for a demo machine or a screenshot run: `?line=`, `?difficulty=`, `?sens=`,
 * `?obstacles=1..5`, `?amount=few|normal|lots`, `?reduced`. They apply for the session and are never written back — a shared link must not
 * quietly change someone's saved settings.
 */
export function applyUrlFlags(settings: GameSettings, search: string): GameSettings {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return settings;
  }
  const out = { ...settings };
  const line = params.get('line');
  if (line !== null) out.line = pick(line, LINES, out.line);
  const diff = params.get('difficulty');
  if (diff !== null) out.difficulty = pick(diff, DIFFICULTIES, out.difficulty);
  const lvl = params.get('obstacles');
  if (lvl !== null && lvl !== '') out.obstacleLevel = cleanObstacleLevel(Number(lvl));
  const amount = params.get('amount');
  if (amount !== null) out.obstacleAmount = pick(amount, OBSTACLE_AMOUNTS, out.obstacleAmount);
  const sens = params.get('sens');
  if (sens !== null && sens !== '') {
    const n = Number(sens);
    if (Number.isFinite(n)) out.sensitivity = cleanSensitivity(n);
  }
  if (params.has('reduced')) {
    const on = params.get('reduced') !== '0';
    out.reducedMotion = on;
    out.reducedEffects = on;
  }
  return out;
}

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

export type SettingsListener = (settings: GameSettings, changed: readonly (keyof GameSettings)[]) => void;

/**
 * The persisted settings. Reads once at construction; writes are best-effort.
 *
 * `set` is the only way in, and it returns what is now actually in force — the screen renders that
 * rather than what it asked for, so a value the store clamped can never be shown as accepted.
 */
export class SettingsStore {
  private current: GameSettings;
  private readonly storage: SettingsStorage | null;
  private readonly listeners = new Set<SettingsListener>();

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: SettingsStorage | null, private readonly key = SETTINGS_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let parsed: unknown = null;
    try {
      const raw = this.storage ? this.storage.getItem(key) : null;
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = null; // Unreadable or not JSON: defaults.
    }
    this.current = cleanSettings(parsed);
  }

  get(): GameSettings {
    return { ...this.current };
  }

  /** Merges a patch, cleans it, persists it and notifies. Returns what is now in force. */
  set(patch: Partial<GameSettings>): GameSettings {
    const next = cleanSettings({ ...this.current, ...patch });
    const changed = (Object.keys(next) as (keyof GameSettings)[]).filter((k) => next[k] !== this.current[k]);
    this.current = next;
    this.write();
    if (changed.length) for (const fn of this.listeners) fn(this.get(), changed);
    return this.get();
  }

  /** Sets the session's values without persisting them (URL flags). */
  override(patch: Partial<GameSettings>): GameSettings {
    this.current = cleanSettings({ ...this.current, ...patch });
    return this.get();
  }

  /** Back to the shipped defaults, persisted. */
  reset(): GameSettings {
    return this.set(DEFAULT_SETTINGS);
  }

  /** Fires whenever something actually changed. Returns the unsubscribe. */
  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or privacy mode: the session keeps the settings in memory.
    }
  }
}
