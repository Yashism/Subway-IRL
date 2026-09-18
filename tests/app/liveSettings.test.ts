import { describe, expect, it } from 'vitest';
import { applyLiveSettings, type LiveTargets } from '../../src/app/liveSettings';
import { SettingsStore, DEFAULT_SETTINGS, SETTINGS_KEY, applyUrlFlags } from '../../src/app/settings';
import type { LineId } from '../../src/world/stations';

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function targets() {
  const lines: LineId[] = [];
  const reduced: { motion?: boolean; effects?: boolean }[] = [];
  const mirrors: boolean[] = [];
  const t: LiveTargets & { lines: LineId[]; reduced: typeof reduced; mirrors: boolean[] } = {
    lines,
    reduced,
    mirrors,
    controller: { sensitivity: 1 },
    game: { options: { difficulty: 'cardio' } },
    world: {
      setLine: (l) => lines.push(l),
      setReduced: (o) => reduced.push(o),
    },
    pip: { setMirror: (on) => mirrors.push(on) },
  };
  return t;
}

describe('applyLiveSettings', () => {
  it('carries every live setting to the thing that is already running', () => {
    const t = targets();
    applyLiveSettings(t, {
      ...DEFAULT_SETTINGS,
      sensitivity: 1.2,
      difficulty: 'beast',
      line: 'harbour',
      reducedMotion: true,
      reducedEffects: true,
      mirror: false,
    });
    expect(t.controller.sensitivity).toBe(1.2);
    expect(t.game.options.difficulty).toBe('beast');
    expect(t.lines).toEqual(['harbour']);
    expect(t.reduced).toEqual([{ motion: true, effects: true }]);
    expect(t.mirrors).toEqual([false]);
  });

  it('hands the obstacle settings to the game, for the next track it lays', () => {
    const t = targets();
    applyLiveSettings(t, { ...DEFAULT_SETTINGS, obstacleLevel: 1, obstacleAmount: 'few' });
    expect(t.game.options.obstacles).toEqual({ level: 1, amount: 'few' });
  });

  it('leaves the track alone while a recorded session replays — its difficulty and obstacles are the recording\'s', () => {
    const t = { ...targets(), ownsRun: false };
    t.game.options.difficulty = 'beast';
    t.game.options.obstacles = { level: 5, amount: 'lots' };
    applyLiveSettings(t, { ...DEFAULT_SETTINGS, difficulty: 'chill', obstacleLevel: 1, obstacleAmount: 'few' });
    expect(t.game.options.difficulty).toBe('beast');
    expect(t.game.options.obstacles).toEqual({ level: 5, amount: 'lots' });
    // What does not decide the track still follows the settings.
    expect(t.lines.length).toBe(1);
  });

  it('leaves the sensitivity alone while a recorded session is replaying', () => {
    const t = { ...targets(), ownsSensitivity: false };
    applyLiveSettings(t, { ...DEFAULT_SETTINGS, sensitivity: 1.25 });
    expect(t.controller.sensitivity).toBe(1);
    // Everything else still applies: only the replayed value is protected.
    expect(t.game.options.difficulty).toBe(DEFAULT_SETTINGS.difficulty);
  });
});

describe('a settings change applies live and persists', () => {
  it('a slider moved now is in force now, and is still there next session', () => {
    const storage = new FakeStorage();
    const store = new SettingsStore(storage);
    const t = targets();
    applyLiveSettings(t, store.get());
    expect(t.controller.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);

    applyLiveSettings(t, store.set({ sensitivity: 1.25, difficulty: 'chill', line: 'central' }));
    expect(t.controller.sensitivity).toBe(1.25);
    expect(t.game.options.difficulty).toBe('chill');
    expect(t.lines.at(-1)).toBe('central');

    // Next session: a fresh store over the same storage reads the same values back.
    const later = new SettingsStore(storage);
    expect(later.get().sensitivity).toBe(1.25);
    expect(later.get().line).toBe('central');
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).difficulty).toBe('chill');
  });

  it('a URL flag applies for the session without being written back', () => {
    const storage = new FakeStorage();
    const store = new SettingsStore(storage);
    store.set({ difficulty: 'chill' });
    const session = store.override(applyUrlFlags(store.get(), '?difficulty=beast&reduced'));
    const t = targets();
    applyLiveSettings(t, session);
    expect(t.game.options.difficulty).toBe('beast');
    expect(t.reduced.at(-1)).toEqual({ motion: true, effects: true });
    // The saved game is untouched: a shared link cannot change someone's settings.
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).difficulty).toBe('chill');
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).reducedMotion).toBe(false);
  });
});
