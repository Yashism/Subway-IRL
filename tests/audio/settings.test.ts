/**
 * The mixer's memory. Storage is hostile until proved otherwise: none of this may ever throw.
 */
import { describe, expect, it } from 'vitest';
import { applyUrlFlags, AudioSettingsStore, cleanSettings } from '../../src/audio/settings';
import { AUDIO_SETTINGS_KEY, DEFAULT_SETTINGS, type SettingsStorage } from '../../src/audio/types';

class MemoryStorage implements SettingsStorage {
  constructor(readonly items: Record<string, string> = {}) {}
  getItem(k: string): string | null {
    return this.items[k] ?? null;
  }
  setItem(k: string, v: string): void {
    this.items[k] = v;
  }
  removeItem(k: string): void {
    delete this.items[k];
  }
}

class HostileStorage implements SettingsStorage {
  getItem(): string | null {
    throw new Error('blocked');
  }
  setItem(): void {
    throw new Error('quota');
  }
  removeItem(): void {
    throw new Error('blocked');
  }
}

describe('cleanSettings', () => {
  it('takes anything at all and gives back usable settings', () => {
    for (const raw of [
      null,
      undefined,
      42,
      'nope',
      [],
      {},
      { master: 'loud' },
      { master: Number.NaN },
      { master: Infinity },
      { music: -5, sfx: 900 },
      { muted: 'yes' },
      { __proto__: { master: 9 } },
    ]) {
      const s = cleanSettings(raw);
      for (const v of [s.master, s.music, s.sfx]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(typeof s.muted).toBe('boolean');
    }
  });

  it('clamps rather than rejects a volume that is merely out of range', () => {
    expect(cleanSettings({ music: -5, sfx: 900 })).toMatchObject({ music: 0, sfx: 1 });
  });

  it('only counts a literal true as muted', () => {
    expect(cleanSettings({ muted: 'yes' }).muted).toBe(false);
    expect(cleanSettings({ muted: 1 }).muted).toBe(false);
    expect(cleanSettings({ muted: true }).muted).toBe(true);
  });
});

describe('AudioSettingsStore', () => {
  it('defaults when there is nothing saved', () => {
    expect(new AudioSettingsStore(new MemoryStorage()).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    new AudioSettingsStore(storage).set({ music: 0.25, muted: true });
    expect(new AudioSettingsStore(storage).get()).toMatchObject({ music: 0.25, muted: true });
  });

  it('survives every shape of corruption', () => {
    for (const raw of ['', '{', 'null', '[]', '"a string"', '{"master":"loud"}', '{"muted":{}}', '0']) {
      const store = new AudioSettingsStore(new MemoryStorage({ [AUDIO_SETTINGS_KEY]: raw }));
      const s = store.get();
      expect(Number.isFinite(s.master), raw).toBe(true);
      expect(s.master, raw).toBeLessThanOrEqual(1);
    }
  });

  it('keeps working when storage throws on read and on write', () => {
    const store = new AudioSettingsStore(new HostileStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.set({ master: 0.2 })).not.toThrow();
    expect(store.get().master).toBe(0.2);
  });

  it('works with no storage at all', () => {
    const store = new AudioSettingsStore(null);
    store.set({ sfx: 0.1 });
    expect(store.get().sfx).toBe(0.1);
  });

  it('an override is for this session only and is never written back', () => {
    const storage = new MemoryStorage();
    const store = new AudioSettingsStore(storage);
    store.set({ master: 0.6 });
    store.override({ muted: true });
    expect(store.get().muted).toBe(true);
    expect(new AudioSettingsStore(storage).get().muted).toBe(false);
  });
});

describe('URL flags', () => {
  it('reads ?mute and ?vol', () => {
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?mute').muted).toBe(true);
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?mute=0').muted).toBe(false);
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?vol=0.25').master).toBe(0.25);
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?vol=9').master).toBe(1);
  });

  it('ignores nonsense', () => {
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?vol=loud').master).toBe(DEFAULT_SETTINGS.master);
    expect(applyUrlFlags(DEFAULT_SETTINGS, '').master).toBe(DEFAULT_SETTINGS.master);
    expect(applyUrlFlags(DEFAULT_SETTINGS, '?a=%%%').master).toBe(DEFAULT_SETTINGS.master);
  });
});

describe('a URL flag is heard for the session and never saved', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };
  const stored = (st: { getItem(k: string): string | null }) => JSON.parse(st.getItem(AUDIO_SETTINGS_KEY) ?? '{}');

  it('a later change writes the saved values plus that change, not the override', () => {
    const st = storage();
    const s = new AudioSettingsStore(st);
    s.set({ master: 0.9, music: 0.7 });
    // The shared link: quiet and muted for this session only.
    s.override(applyUrlFlags(s.get(), '?vol=0.2&mute'));
    expect(s.get().master).toBe(0.2);
    expect(s.get().muted).toBe(true);

    // Pressing mute writes mute — and leaves the master where the player actually put it.
    s.set({ muted: false });
    expect(stored(st).muted).toBe(false);
    expect(stored(st).master).toBe(0.9);
    // …while the session keeps playing at the volume the link asked for.
    expect(s.get().master).toBe(0.2);
  });

  it('a change the player really makes is saved, override or no override', () => {
    const st = storage();
    const s = new AudioSettingsStore(st);
    s.override(applyUrlFlags(s.get(), '?vol=0.2'));
    s.set({ music: 0.33 });
    expect(stored(st).music).toBe(0.33);
    expect(new AudioSettingsStore(st).get().music).toBe(0.33);
    expect(new AudioSettingsStore(st).get().master).not.toBe(0.2);
  });
});
