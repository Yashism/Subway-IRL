import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SETTINGS_KEY,
  SettingsStore,
  applyUrlFlags,
  cleanSensitivity,
  cleanSettings,
  cleanWeight,
  sensitivityWords,
} from '../../src/app/settings';

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe('cleaning', () => {
  it('turns nothing at all into the defaults', () => {
    for (const bad of [null, undefined, 'nope', 42, [], () => {}]) {
      expect(cleanSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps a good record verbatim', () => {
    const good = { sensitivity: 1.1, mode: 'small', mirror: false, line: 'harbour', difficulty: 'beast', reducedMotion: true, reducedEffects: true, weightKg: 82 };
    expect(cleanSettings(good)).toEqual(good);
  });

  it('drops only the field that is wrong', () => {
    const s = cleanSettings({ line: 'monorail', difficulty: 'beast', mirror: false });
    expect(s.line).toBe(DEFAULT_SETTINGS.line);
    expect(s.difficulty).toBe('beast');
    expect(s.mirror).toBe(false);
  });

  it('refuses a truthy string where a boolean belongs', () => {
    const s = cleanSettings({ mirror: 'yes', reducedMotion: 1 });
    expect(s.mirror).toBe(DEFAULT_SETTINGS.mirror);
    expect(s.reducedMotion).toBe(false);
  });

  it('clamps and snaps the sensitivity to the band that actually does something', () => {
    expect(cleanSensitivity(0.1)).toBe(SENSITIVITY_MIN);
    expect(cleanSensitivity(9)).toBe(SENSITIVITY_MAX);
    expect(cleanSensitivity(1.02)).toBe(1);
    expect(cleanSensitivity(1.13)).toBe(1.15);
    expect(cleanSensitivity(Number.NaN)).toBe(1);
    expect(cleanSensitivity('1.2')).toBe(1);
  });

  it('describes the sensitivity in words at every point on the slider', () => {
    const seen = new Set<string>();
    for (let v = SENSITIVITY_MIN; v <= SENSITIVITY_MAX + 1e-9; v += 0.05) {
      const words = sensitivityWords(v);
      expect(words.length).toBeGreaterThan(8);
      seen.add(words);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(sensitivityWords(1)).toContain('default');
  });

  it('treats a weight as optional and never demands one', () => {
    expect(cleanWeight(undefined)).toBeNull();
    expect(cleanWeight(null)).toBeNull();
    expect(cleanWeight(0)).toBeNull();
    expect(cleanWeight(-70)).toBeNull();
    expect(cleanWeight('70')).toBeNull();
    expect(cleanWeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(cleanWeight(72.4)).toBe(72);
    expect(cleanWeight(2)).toBe(30);
    expect(cleanWeight(5000)).toBe(200);
  });
});

describe('the store', () => {
  it('starts at the defaults with no storage at all', () => {
    expect(new SettingsStore(null).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a change and reads it back next session', () => {
    const storage = memory();
    new SettingsStore(storage).set({ line: 'central', difficulty: 'beast' });
    const next = new SettingsStore(storage).get();
    expect(next.line).toBe('central');
    expect(next.difficulty).toBe('beast');
  });

  it('returns what is in force, not what was asked for', () => {
    const s = new SettingsStore(memory());
    expect(s.set({ sensitivity: 99 }).sensitivity).toBe(SENSITIVITY_MAX);
    expect(s.set({ line: 'monorail' as never }).line).toBe(DEFAULT_SETTINGS.line);
  });

  it('hands out a copy, so nobody can reach in and change it', () => {
    const s = new SettingsStore(memory());
    const got = s.get();
    got.line = 'harbour';
    expect(s.get().line).toBe(DEFAULT_SETTINGS.line);
  });

  it('survives a corrupt record without losing the session', () => {
    const storage = memory();
    storage.map.set(SETTINGS_KEY, '{not json');
    const s = new SettingsStore(storage);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(s.set({ mirror: false }).mirror).toBe(false);
  });

  it('survives a hostile record', () => {
    const storage = memory();
    storage.map.set(SETTINGS_KEY, JSON.stringify({ sensitivity: { toString: 1 }, line: ['harbour'], weightKg: '999999' }));
    expect(new SettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps playing when storage throws on every call', () => {
    const angry = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    const s = new SettingsStore(angry);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => s.set({ difficulty: 'beast' })).not.toThrow();
    expect(s.get().difficulty).toBe('beast');
  });

  it('tells listeners only about what really changed', () => {
    const s = new SettingsStore(memory());
    const seen = vi.fn();
    s.subscribe(seen);
    s.set({ difficulty: 'beast' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][1]).toEqual(['difficulty']);
    // Setting it to the value it already has is not a change.
    s.set({ difficulty: 'beast' });
    expect(seen).toHaveBeenCalledTimes(1);
    // A clamped value that lands where it already was is not a change either.
    s.set({ sensitivity: 1.005 });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops telling a listener that unsubscribed', () => {
    const s = new SettingsStore(memory());
    const seen = vi.fn();
    s.subscribe(seen)();
    s.set({ mirror: false });
    expect(seen).not.toHaveBeenCalled();
  });

  it('goes back to the defaults on reset, and persists that', () => {
    const storage = memory();
    const s = new SettingsStore(storage);
    s.set({ line: 'harbour', weightKg: 90, reducedMotion: true });
    expect(s.reset()).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('applies an override without writing it down', () => {
    const storage = memory();
    const s = new SettingsStore(storage);
    s.override({ difficulty: 'beast' });
    expect(s.get().difficulty).toBe('beast');
    expect(new SettingsStore(storage).get().difficulty).toBe(DEFAULT_SETTINGS.difficulty);
  });
});

describe('url flags', () => {
  it('applies the ones it recognises', () => {
    const s = applyUrlFlags(DEFAULT_SETTINGS, '?line=harbour&difficulty=beast&sens=1.2&reduced');
    expect(s.line).toBe('harbour');
    expect(s.difficulty).toBe('beast');
    expect(s.sensitivity).toBe(1.2);
    expect(s.reducedMotion).toBe(true);
    expect(s.reducedEffects).toBe(true);
  });

  it('ignores a flag it does not understand and leaves the rest alone', () => {
    const base = { ...DEFAULT_SETTINGS, line: 'central' as const };
    const s = applyUrlFlags(base, '?line=monorail&sens=lots&difficulty=');
    expect(s.line).toBe('central');
    expect(s.sensitivity).toBe(base.sensitivity);
    expect(s.difficulty).toBe(base.difficulty);
  });

  it('can be turned off explicitly', () => {
    expect(applyUrlFlags({ ...DEFAULT_SETTINGS, reducedMotion: true }, '?reduced=0').reducedMotion).toBe(false);
  });

  it('changes nothing with no query at all', () => {
    expect(applyUrlFlags(DEFAULT_SETTINGS, '')).toEqual(DEFAULT_SETTINGS);
  });
});
