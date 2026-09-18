/**
 * Mixer settings and where they live between sessions.
 *
 * Storage is never trusted and never fatal: a blocked, full, corrupt or actively hostile
 * localStorage leaves the game audible at sensible defaults. Nothing here throws, ever — a thrown
 * error while reading a volume would take the whole game down on boot.
 */
import { AUDIO_SETTINGS_KEY, DEFAULT_SETTINGS, type AudioSettings, type SettingsStorage } from './types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** A volume from anything: a number in range, or the default. NaN, Infinity, strings and objects all fall back. */
function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}

/** Normalises anything at all into usable settings. */
export function cleanSettings(raw: unknown): AudioSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    master: volume(o.master, DEFAULT_SETTINGS.master),
    music: volume(o.music, DEFAULT_SETTINGS.music),
    sfx: volume(o.sfx, DEFAULT_SETTINGS.sfx),
    muted: o.muted === true,
  };
}

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

/**
 * URL overrides, for a demo machine or a screenshot run: `?mute`, `?vol=0.5`.
 * They apply for the session and are not written back — a shared link must not silence someone's
 * game for good.
 */
export function applyUrlFlags(settings: AudioSettings, search: string): AudioSettings {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return settings;
  }
  const out = { ...settings };
  if (params.has('mute')) out.muted = params.get('mute') !== '0';
  const vol = params.get('vol');
  if (vol !== null) {
    const n = Number(vol);
    if (Number.isFinite(n)) out.master = clamp01(n);
  }
  return out;
}

/**
 * The persisted mixer. Reads once at construction; writes are best-effort.
 *
 * Two values are kept, not one: what is in force now, and what belongs on disk. A URL flag
 * (`?mute`, `?vol=`) changes the first and not the second, so a shared link is heard the way the
 * sender meant and is forgotten afterwards. Without that split, the next change of *any* kind
 * writes the whole current state back and a link silently becomes the player's saved setting.
 */
export class AudioSettingsStore {
  private current: AudioSettings;
  /** What the next write should be built from: the stored values, never a URL override. */
  private persisted: AudioSettings;
  private readonly storage: SettingsStorage | null;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: SettingsStorage | null, private readonly key = AUDIO_SETTINGS_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let parsed: unknown = null;
    try {
      const raw = this.storage ? this.storage.getItem(key) : null;
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = null; // Unreadable or not JSON: defaults.
    }
    this.current = cleanSettings(parsed);
    this.persisted = { ...this.current };
  }

  get(): AudioSettings {
    return { ...this.current };
  }

  /**
   * Merges a deliberate change, cleans it and persists it. What is written is the change laid over
   * the *stored* values — a session override the player never asked for does not ride along.
   */
  set(patch: Partial<AudioSettings>): AudioSettings {
    this.current = cleanSettings({ ...this.current, ...patch });
    this.persisted = cleanSettings({ ...this.persisted, ...patch });
    this.write();
    return this.get();
  }

  /** Sets the session's values without persisting them (URL flags). */
  override(patch: Partial<AudioSettings>): AudioSettings {
    this.current = cleanSettings({ ...this.current, ...patch });
    return this.get();
  }

  private write(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.persisted));
    } catch {
      // Quota or privacy mode: the session keeps the settings in memory.
    }
  }
}
