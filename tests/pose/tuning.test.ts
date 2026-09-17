import { describe, expect, it } from 'vitest';
import { MOVE_TUNING_KEY, type MoveTuning } from '../../src/pose/moveCheckTypes';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import {
  applyTuning,
  cleanTuning,
  MoveTuningStore,
  REARM_OF,
  TUNABLE_KEYS,
  TUNE_FRACTION,
  TUNE_MAX_FACTOR,
  TUNE_MIN_FACTOR,
  tunedValue,
  tuneKey,
  type TuningStorage,
} from '../../src/pose/tuning';
import type { PlayMode } from '../../src/pose/types';

/** An in-memory Storage stand-in; `fail` makes every call throw, like a blocked store. */
function memStore(seed: Record<string, string> = {}, fail = false): TuningStorage & { data: Record<string, string> } {
  const data = { ...seed };
  const boom = () => {
    throw new Error('storage blocked');
  };
  return {
    data,
    getItem: (k) => (fail ? boom() : (data[k] ?? null)),
    setItem: (k, v) => {
      if (fail) boom();
      data[k] = v;
    },
    removeItem: (k) => {
      if (fail) boom();
      delete data[k];
    },
  };
}

const tuning = (mode: PlayMode, over: Partial<MoveTuning> = {}): MoveTuning => ({
  mode,
  at: 1_700_000_000_000,
  thresholds: {},
  peaks: {},
  ...over,
});

describe('tunedValue', () => {
  it('sets the threshold at TUNE_FRACTION of what the player actually did', () => {
    // A 1.0-torso step with a 0.5 default: 0.55 sits inside the band (0.30 .. 0.80).
    expect(tunedValue('laneEnter', 1.0)).toBeCloseTo(TUNE_FRACTION * 1.0, 10);
    expect(TUNE_FRACTION).toBe(0.55);
  });

  it('clamps to [0.6, 1.6] times the default', () => {
    const d = DEFAULT_THRESHOLDS.jumpRise;
    expect(tunedValue('jumpRise', 0)).toBeCloseTo(TUNE_MIN_FACTOR * d, 10);
    expect(tunedValue('jumpRise', 100)).toBeCloseTo(TUNE_MAX_FACTOR * d, 10);
    expect(TUNE_MIN_FACTOR).toBe(0.6);
    expect(TUNE_MAX_FACTOR).toBe(1.6);
  });

  it('never returns a non-finite value, whatever the peak', () => {
    for (const peak of [NaN, Infinity, -Infinity, -5]) {
      const v = tunedValue('rollDrop', peak);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(TUNE_MIN_FACTOR * DEFAULT_THRESHOLDS.rollDrop);
      expect(v).toBeLessThanOrEqual(TUNE_MAX_FACTOR * DEFAULT_THRESHOLDS.rollDrop);
    }
  });
});

describe('tuneKey', () => {
  it('moves the re-arm key with its enter key, keeping the default ratio', () => {
    const out = {};
    tuneKey(out, 'laneEnter', 1.4);
    const ratio = DEFAULT_THRESHOLDS.laneExit / DEFAULT_THRESHOLDS.laneEnter;
    expect(out).toEqual({ laneEnter: expect.any(Number), laneExit: expect.any(Number) });
    const o = out as { laneEnter: number; laneExit: number };
    expect(o.laneEnter).toBeCloseTo(TUNE_FRACTION * 1.4, 10);
    expect(o.laneExit / o.laneEnter).toBeCloseTo(ratio, 10);
  });

  it.each([
    ['kneeLift', 'kneeRelease'],
    ['laneEnter', 'laneExit'],
    ['leanDeg', 'leanRearmDeg'],
    ['noseShift', 'noseRearm'],
    ['jumpRise', 'jumpRearm'],
    ['smallJumpRise', 'smallJumpRearm'],
  ] as const)('%s carries %s', (enter, rearm) => {
    expect(REARM_OF[enter]).toBe(rearm);
    const out: Record<string, number> = {};
    tuneKey(out, enter, DEFAULT_THRESHOLDS[enter] * 2);
    expect(out[rearm] / out[enter]).toBeCloseTo(DEFAULT_THRESHOLDS[rearm] / DEFAULT_THRESHOLDS[enter], 10);
  });

  it('leaves keys with no re-arm companion alone', () => {
    const out = {};
    tuneKey(out, 'rollDrop', 0.9);
    expect(Object.keys(out)).toEqual(['rollDrop']);
  });
});

describe('cleanTuning', () => {
  it('keeps a well-formed record', () => {
    const t = tuning('full', { thresholds: { laneEnter: 0.4 }, peaks: { left: 0.7 } });
    expect(cleanTuning(t)).toEqual(t);
  });

  it.each([null, undefined, 42, 'nope', [], {}, { mode: 'sideways' }])('rejects %o', (bad) => {
    expect(cleanTuning(bad)).toBeNull();
  });

  it('accepts a record whose fields are junk, with nothing tuned', () => {
    expect(cleanTuning({ mode: 'full', at: 'yesterday', thresholds: 7, peaks: null })).toEqual({
      mode: 'full',
      at: 0,
      thresholds: {},
      peaks: {},
    });
  });

  it('drops threshold keys the check may not tune', () => {
    const t = cleanTuning(tuning('full', { thresholds: { lostMs: 5, laneEnter: 0.4 } as never }));
    expect(t?.thresholds).toEqual({ laneEnter: 0.4 });
  });

  it('drops non-finite and out-of-range threshold values', () => {
    const t = cleanTuning(
      tuning('full', { thresholds: { laneEnter: NaN, jumpRise: 99, rollDrop: -1, kneeLift: 0.1 } as never }),
    );
    expect(t?.thresholds.laneEnter).toBeUndefined();
    expect(t?.thresholds.rollDrop).toBeUndefined();
    // Out of range is clamped back, not dropped: a stored value may predate a default change.
    expect(t?.thresholds.jumpRise).toBeCloseTo(TUNE_MAX_FACTOR * DEFAULT_THRESHOLDS.jumpRise, 10);
    expect(t?.thresholds.kneeLift).toBe(0.1);
  });

  it('drops junk peaks but keeps the good ones', () => {
    const t = cleanTuning(tuning('small', { peaks: { jump: 0.4, roll: NaN, nonsense: 3 } as never }));
    expect(t?.peaks).toEqual({ jump: 0.4 });
  });

  it('round-trips the per-key peaks, and leaves them out when there are none', () => {
    const t = cleanTuning(tuning('small', { keyPeaks: { leanDeg: 22, noseShift: 0.3, lostMs: 9 } as never }));
    expect(t?.keyPeaks).toEqual({ leanDeg: 22, noseShift: 0.3 });
    expect(cleanTuning(tuning('small', { keyPeaks: {} }))).not.toHaveProperty('keyPeaks');
  });
});

describe('applyTuning', () => {
  it('overwrites only the tuned keys', () => {
    const th = { ...DEFAULT_THRESHOLDS };
    applyTuning(th, tuning('full', { thresholds: { laneEnter: 0.4, laneExit: 0.28 } }));
    expect(th.laneEnter).toBe(0.4);
    expect(th.laneExit).toBe(0.28);
    expect(th.jumpRise).toBe(DEFAULT_THRESHOLDS.jumpRise);
  });

  it('restores the defaults for keys the new tuning does not mention', () => {
    const th = { ...DEFAULT_THRESHOLDS, laneEnter: 0.4, jumpRise: 0.22 };
    applyTuning(th, tuning('full', { thresholds: { jumpRise: 0.2 } }));
    expect(th.laneEnter).toBe(DEFAULT_THRESHOLDS.laneEnter);
    expect(th.jumpRise).toBe(0.2);
  });

  it('puts every tunable key back to its default for a null tuning', () => {
    const th = { ...DEFAULT_THRESHOLDS, laneEnter: 0.4, kneeLift: 0.3 };
    applyTuning(th, null);
    expect(th).toEqual(DEFAULT_THRESHOLDS);
  });

  it('never leaves a NaN or out-of-range threshold behind', () => {
    const th = { ...DEFAULT_THRESHOLDS };
    applyTuning(th, tuning('full', { thresholds: { laneEnter: NaN, jumpRise: 1e9, rollDrop: -4 } as never }));
    for (const key of TUNABLE_KEYS) {
      const d = DEFAULT_THRESHOLDS[key];
      expect(Number.isFinite(th[key])).toBe(true);
      expect(th[key]).toBeGreaterThanOrEqual(TUNE_MIN_FACTOR * d - 1e-9);
      expect(th[key]).toBeLessThanOrEqual(TUNE_MAX_FACTOR * d + 1e-9);
    }
  });
});

describe('MoveTuningStore', () => {
  it('round-trips a record per mode', () => {
    const storage = memStore();
    const store = new MoveTuningStore(storage);
    store.save(tuning('full', { thresholds: { laneEnter: 0.4 }, peaks: { left: 0.7, right: 0.75 } }));
    store.save(tuning('small', { thresholds: { leanDeg: 12 }, peaks: { left: 22 } }));

    const reopened = new MoveTuningStore(storage);
    expect(reopened.get('full')?.thresholds).toEqual({ laneEnter: 0.4 });
    expect(reopened.get('small')?.thresholds).toEqual({ leanDeg: 12 });
    expect(reopened.get('full')?.peaks).toEqual({ left: 0.7, right: 0.75 });
    expect(storage.data[MOVE_TUNING_KEY]).toContain('laneEnter');
  });

  it('keeps the modes separate when one is re-saved', () => {
    const storage = memStore();
    new MoveTuningStore(storage).save(tuning('full', { thresholds: { laneEnter: 0.4 } }));
    new MoveTuningStore(storage).save(tuning('small', { thresholds: { leanDeg: 12 } }));
    const s3 = new MoveTuningStore(storage);
    expect(s3.get('full')?.thresholds).toEqual({ laneEnter: 0.4 });
    expect(s3.get('small')?.thresholds).toEqual({ leanDeg: 12 });
    s3.save(tuning('full', { thresholds: { laneEnter: 0.45 } }));
    expect(new MoveTuningStore(storage).get('small')?.thresholds).toEqual({ leanDeg: 12 });
  });

  it('forgets one mode or both', () => {
    const storage = memStore();
    const store = new MoveTuningStore(storage);
    store.save(tuning('full', { thresholds: { laneEnter: 0.4 } }));
    store.save(tuning('small', { thresholds: { leanDeg: 12 } }));
    store.clear('full');
    expect(store.get('full')).toBeNull();
    expect(store.get('small')).not.toBeNull();
    store.clear();
    expect(store.get('small')).toBeNull();
    expect(new MoveTuningStore(storage).get('small')).toBeNull();
  });

  it.each([
    ['not json at all', '{{{'],
    ['a bare array', '[1,2,3]'],
    ['null', 'null'],
    ['a string', '"hello"'],
    ['the wrong version', JSON.stringify({ version: 99, modes: { full: { mode: 'full', thresholds: {} } } })],
    ['no version', JSON.stringify({ modes: { full: { mode: 'full', thresholds: {} } } })],
    ['modes as an array', JSON.stringify({ version: 1, modes: [] })],
    ['a mode holding junk', JSON.stringify({ version: 1, modes: { full: 'nope', small: 3 } })],
    ['a prototype-pollution attempt', '{"version":1,"modes":{"__proto__":{"polluted":true},"full":null}}'],
  ])('ignores %s', (_name, raw) => {
    const store = new MoveTuningStore(memStore({ [MOVE_TUNING_KEY]: raw }));
    expect(store.get('full')).toBeNull();
    expect(store.get('small')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps the good mode when only one is corrupt', () => {
    const raw = JSON.stringify({
      version: 1,
      modes: { full: { mode: 'full', at: 1, thresholds: { laneEnter: 0.4 }, peaks: {} }, small: 'junk' },
    });
    const store = new MoveTuningStore(memStore({ [MOVE_TUNING_KEY]: raw }));
    expect(store.get('full')?.thresholds).toEqual({ laneEnter: 0.4 });
    expect(store.get('small')).toBeNull();
  });

  it('ignores a record filed under the wrong mode', () => {
    const raw = JSON.stringify({ version: 1, modes: { full: { mode: 'small', at: 1, thresholds: {}, peaks: {} } } });
    expect(new MoveTuningStore(memStore({ [MOVE_TUNING_KEY]: raw })).get('full')).toBeNull();
  });

  it('works with no storage at all, keeping the tuning in memory', () => {
    const store = new MoveTuningStore(null);
    store.save(tuning('full', { thresholds: { laneEnter: 0.4 } }));
    expect(store.get('full')?.thresholds).toEqual({ laneEnter: 0.4 });
  });

  it('never throws when storage itself throws', () => {
    const store = new MoveTuningStore(memStore({}, true));
    expect(store.get('full')).toBeNull();
    expect(() => store.save(tuning('full', { thresholds: { laneEnter: 0.4 } }))).not.toThrow();
    expect(store.get('full')?.thresholds).toEqual({ laneEnter: 0.4 });
    expect(() => store.clear()).not.toThrow();
    expect(store.get('full')).toBeNull();
  });
});
