/**
 * The mixer as the *settings screen* sees it: three volumes and a mute, read from and written to
 * `subway-irl.audio.v1`.
 *
 * This is deliberately not the audio module. The engine owns that key too and reads it when it
 * boots; the app layer only has to be able to show the sliders and move them, which must work on a
 * page with no audio graph at all (a replay, a headless screenshot, a machine with no output
 * device). So the *contract* — the key and the shipped defaults — is imported from `audio/types`,
 * and nothing else about audio is. When the audio pass lands, its store replaces the guts of this
 * file and the settings screen does not change.
 */
import { AUDIO_SETTINGS_KEY, DEFAULT_SETTINGS, type AudioSettings } from '../audio/types';

export type AudioPrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** A volume from anything at all: a number in range, or the shipped default for that channel. */
const volume = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;

/** Normalises anything into usable mixer settings. Never throws; a bad field costs only that field. */
export function cleanAudio(raw: unknown): AudioSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    master: volume(o.master, DEFAULT_SETTINGS.master),
    music: volume(o.music, DEFAULT_SETTINGS.music),
    sfx: volume(o.sfx, DEFAULT_SETTINGS.sfx),
    muted: o.muted === true,
  };
}

function defaultStorage(): AudioPrefsStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

/**
 * The persisted mixer. Reads once; writes are best-effort — a blocked or full localStorage leaves
 * the sliders working for this session and loses nothing else.
 */
export class AudioPrefs {
  private current: AudioSettings;
  private readonly storage: AudioPrefsStorage | null;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: AudioPrefsStorage | null, private readonly key = AUDIO_SETTINGS_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let parsed: unknown = null;
    try {
      const raw = this.storage ? this.storage.getItem(key) : null;
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    this.current = cleanAudio(parsed);
  }

  get(): AudioSettings {
    return { ...this.current };
  }

  /** Merges a patch, cleans it, persists it. Returns what is now in force. */
  set(patch: Partial<AudioSettings>): AudioSettings {
    this.current = cleanAudio({ ...this.current, ...patch });
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or privacy mode: the session keeps the mixer in memory.
    }
    return this.get();
  }
}
