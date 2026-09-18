import { describe, expect, it } from 'vitest';
import {
  cleanLaneSpots,
  LANE_SPOTS_KEY,
  LaneSpotsStore,
  MAX_SPOT,
  MIN_SPOT_GAP,
  parseLaneSpots,
  spotZones,
  symmetricZones,
  type LaneSpots,
  type LaneSpotsStorage,
} from '../../src/pose/laneSpots';
import { nextLane } from '../../src/pose/moves';
import type { Lane } from '../../src/pose/types';

/** `nextLane` exactly as it was before lane spots, kept here as the oracle the automatic path must match. */
function nextLaneBefore(lane: Lane, offset: number, enter: number, exit: number): Lane {
  if (lane === 0) return offset <= -enter ? -1 : offset >= enter ? 1 : 0;
  if (lane === -1) return offset > -exit ? (offset >= enter ? 1 : 0) : -1;
  return offset < exit ? (offset <= -enter ? -1 : 0) : 1;
}

const LANES: readonly Lane[] = [-1, 0, 1];

/** Walks `offsets` through `nextLane` from `start`, returning every lane it passes through. */
function walk(offsets: readonly number[], zones: Parameters<typeof nextLane>[2], start: Lane = 0): Lane[] {
  let lane = start;
  return offsets.map((o) => (lane = nextLane(lane, o, zones)));
}

describe('nextLane: the automatic path is unchanged', () => {
  it('matches the old implementation over a sweep of offsets, lanes, thresholds and sensitivities', () => {
    let checked = 0;
    const enters = [0.5, 0.33, 0.3, 0.8];
    for (const enter of enters) {
      const exit = enter * 0.7;
      for (const sens of [0.75, 0.9, 1, 1.1, 1.25]) {
        const e = enter / sens;
        const x = exit / sens;
        const zones = symmetricZones(e, x);
        for (const lane of LANES) {
          for (let i = -3000; i <= 3000; i++) {
            const offset = i / 1000;
            expect(nextLane(lane, offset, zones)).toBe(nextLaneBefore(lane, offset, e, x));
            checked++;
          }
          // Exactly on each edge, and the specials.
          for (const offset of [e, -e, x, -x, 0, -0, Infinity, -Infinity, Number.NaN]) {
            expect(nextLane(lane, offset, zones)).toBe(nextLaneBefore(lane, offset, e, x));
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300_000);
  });

  it('a whole random walk takes the same lanes as before', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const offsets = Array.from({ length: 5000 }, () => rnd() * 1.2);
    let before: Lane = 0;
    const expected = offsets.map((o) => (before = nextLaneBefore(before, o, 0.5, 0.35)));
    expect(walk(offsets, symmetricZones(0.5, 0.35))).toEqual(expected);
  });
});

describe('spotZones', () => {
  const SPOTS: LaneSpots = { left: -0.8, centre: 0.1, right: 0.6 };

  it('puts the boundaries halfway between the centre spot and each side spot', () => {
    const z = spotZones(SPOTS, 1);
    expect(z.enterL).toBeCloseTo(-0.35, 12);
    expect(z.enterR).toBeCloseTo(0.35, 12);
  });

  it('leaves a side lane 30 % of the way back from its boundary to the centre spot', () => {
    const z = spotZones(SPOTS, 1);
    // Left boundary -0.35 is 0.45 from the centre spot; 30 % back is 0.135 → -0.215.
    expect(z.exitL).toBeCloseTo(-0.215, 12);
    // Right boundary 0.35 is 0.25 from the centre spot; 30 % back is 0.075 → 0.275.
    expect(z.exitR).toBeCloseTo(0.275, 12);
  });

  it('symmetric spots at ±1 give exactly today’s 0.5 / 0.35 zones', () => {
    const z = spotZones({ left: -1, centre: 0, right: 1 }, 1);
    expect(z.enterL).toBeCloseTo(-0.5, 12);
    expect(z.exitL).toBeCloseTo(-0.35, 12);
    expect(z.enterR).toBeCloseTo(0.5, 12);
    expect(z.exitR).toBeCloseTo(0.35, 12);
  });

  it('divides each boundary’s distance from the centre spot by the sensitivity', () => {
    const z = spotZones(SPOTS, 1.25);
    expect(z.enterL).toBeCloseTo(0.1 - 0.45 / 1.25, 12);
    expect(z.enterR).toBeCloseTo(0.1 + 0.25 / 1.25, 12);
    const easy = spotZones(SPOTS, 0.75);
    expect(easy.enterR).toBeCloseTo(0.1 + 0.25 / 0.75, 12);
    // Hysteresis keeps its 30 % of the scaled distance.
    expect(z.exitR - 0.1).toBeCloseTo((0.25 / 1.25) * 0.7, 12);
  });

  it('with asymmetric spots, lanes change exactly at the recorded midpoints', () => {
    const z = spotZones(SPOTS, 1);
    const bL = (SPOTS.left + SPOTS.centre) / 2;
    const bR = (SPOTS.right + SPOTS.centre) / 2;
    // To within floating-point rounding of the midpoint itself.
    expect(nextLane(0, bL + 1e-9, z)).toBe(0);
    expect(nextLane(0, bL - 1e-9, z)).toBe(-1);
    expect(nextLane(0, bR - 1e-9, z)).toBe(0);
    expect(nextLane(0, bR + 1e-9, z)).toBe(1);
  });

  it('hysteresis: a side lane holds until the hips pass the exit point', () => {
    const z = spotZones(SPOTS, 1);
    expect(walk([-0.4, -0.3, -0.22, -0.2], z)).toEqual([-1, -1, -1, 0]);
    expect(walk([0.4, 0.3, 0.28, 0.27], z)).toEqual([1, 1, 1, 0]);
  });

  it('a move straight from the left spot to the right spot goes directly to the right lane', () => {
    const z = spotZones(SPOTS, 1);
    expect(walk([-0.8, 0.6], z)).toEqual([-1, 1]);
    expect(walk([0.6, -0.8], z)).toEqual([1, -1]);
  });

  it('a centre spot off the calibrated centre moves the whole middle lane with it', () => {
    const z = spotZones({ left: 0.1, centre: 0.7, right: 1.3 }, 1);
    expect(nextLane(0, 0, z)).toBe(-1);
    expect(nextLane(0, 0.7, z)).toBe(0);
    expect(nextLane(0, 1.0, z)).toBe(1);
  });

  it('fills the object it is given and allocates nothing else', () => {
    const out = symmetricZones(0, 0);
    expect(spotZones(SPOTS, 1, out)).toBe(out);
    expect(symmetricZones(0.5, 0.35, out)).toBe(out);
  });
});

describe('cleanLaneSpots', () => {
  it('keeps real spots', () => {
    expect(cleanLaneSpots({ left: -0.6, centre: 0, right: 0.5 })).toEqual({ left: -0.6, centre: 0, right: 0.5 });
  });

  it('drops extra fields', () => {
    expect(cleanLaneSpots({ left: -0.6, centre: 0, right: 0.5, at: 3, evil: 'x' })).toEqual({ left: -0.6, centre: 0, right: 0.5 });
  });

  it.each([
    ['null', null],
    ['a number', 3],
    ['an array', [-1, 0, 1]],
    ['a missing side', { left: -0.6, centre: 0 }],
    ['a string spot', { left: '-0.6', centre: 0, right: 0.5 }],
    ['NaN', { left: Number.NaN, centre: 0, right: 0.5 }],
    ['Infinity', { left: -0.6, centre: 0, right: Infinity }],
    ['out of order', { left: 0.5, centre: 0, right: -0.6 }],
    ['left beyond centre', { left: 0.1, centre: 0, right: 0.6 }],
    ['a side too close', { left: -(MIN_SPOT_GAP - 0.01), centre: 0, right: 0.6 }],
    ['equal spots', { left: 0, centre: 0, right: 0 }],
    ['beyond any room', { left: -(MAX_SPOT + 1), centre: 0, right: 0.6 }],
  ])('refuses %s', (_name, v) => {
    expect(cleanLaneSpots(v)).toBeNull();
  });

  it('ignores inherited fields (a hostile prototype)', () => {
    const proto = { left: -0.6, centre: 0, right: 0.5 };
    expect(cleanLaneSpots(Object.create(proto))).toBeNull();
  });
});

class MemStorage implements LaneSpotsStorage {
  data = new Map<string, string>();
  throwOn: 'get' | 'set' | 'remove' | null = null;
  getItem(k: string): string | null {
    if (this.throwOn === 'get') throw new Error('blocked');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOn === 'set') throw new Error('quota');
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    if (this.throwOn === 'remove') throw new Error('blocked');
    this.data.delete(k);
  }
}

describe('LaneSpotsStore', () => {
  const SPOTS = { left: -0.7, centre: 0.05, right: 0.55 };

  it('starts empty and round-trips a saved record', () => {
    const storage = new MemStorage();
    const a = new LaneSpotsStore(storage);
    expect(a.empty).toBe(true);
    expect(a.get()).toBeNull();
    expect(a.save(SPOTS, 1234)).toBe(true);
    expect(JSON.parse(storage.data.get(LANE_SPOTS_KEY)!)).toEqual({ ...SPOTS, at: 1234 });
    const b = new LaneSpotsStore(storage);
    expect(b.get()).toEqual({ ...SPOTS, at: 1234 });
    expect(b.empty).toBe(false);
  });

  it('refuses to save spots that fail validation and keeps the old ones', () => {
    const s = new LaneSpotsStore(new MemStorage());
    s.save(SPOTS, 1);
    expect(s.save({ left: 0.4, centre: 0, right: 0.5 }, 2)).toBe(false);
    expect(s.get()).toEqual({ ...SPOTS, at: 1 });
  });

  it('hands out copies, so a caller cannot edit the saved record', () => {
    const s = new LaneSpotsStore(new MemStorage());
    s.save(SPOTS, 1);
    s.get()!.left = 3;
    expect(s.get()!.left).toBe(SPOTS.left);
  });

  it('clear forgets the record and removes the key', () => {
    const storage = new MemStorage();
    const s = new LaneSpotsStore(storage);
    s.save(SPOTS, 1);
    s.clear();
    expect(s.get()).toBeNull();
    expect(storage.data.has(LANE_SPOTS_KEY)).toBe(false);
  });

  it.each([
    ['not JSON', '{nope'],
    ['JSON null', 'null'],
    ['a number', '42'],
    ['partial', JSON.stringify({ left: -0.7, centre: 0 })],
    ['out of order', JSON.stringify({ left: 0.55, centre: 0.05, right: -0.7, at: 1 })],
    ['non-finite (serialised as null)', JSON.stringify({ left: -Infinity, centre: 0, right: 0.5 })],
    ['strings', JSON.stringify({ left: '-0.7', centre: '0', right: '0.5' })],
    ['a prototype attack', '{"__proto__":{"left":-0.7,"centre":0,"right":0.5}}'],
  ])('loads %s as no spots, without throwing', (_name, raw) => {
    const storage = new MemStorage();
    storage.data.set(LANE_SPOTS_KEY, raw);
    expect(() => new LaneSpotsStore(storage)).not.toThrow();
    expect(new LaneSpotsStore(storage).get()).toBeNull();
    expect(parseLaneSpots(raw)).toBeNull();
  });

  it('a bad timestamp costs only the timestamp', () => {
    expect(parseLaneSpots(JSON.stringify({ ...SPOTS, at: 'yesterday' }))).toEqual({ ...SPOTS, at: 0 });
    expect(parseLaneSpots(JSON.stringify({ ...SPOTS, at: -5 }))).toEqual({ ...SPOTS, at: 0 });
  });

  it('survives storage that throws on every call, keeping the spots in memory', () => {
    const storage = new MemStorage();
    storage.throwOn = 'get';
    const s = new LaneSpotsStore(storage);
    expect(s.get()).toBeNull();
    storage.throwOn = 'set';
    expect(s.save(SPOTS, 1)).toBe(true);
    expect(s.get()).toEqual({ ...SPOTS, at: 1 });
    storage.throwOn = 'remove';
    expect(() => s.clear()).not.toThrow();
    expect(s.get()).toBeNull();
  });

  it('works with no storage at all', () => {
    const s = new LaneSpotsStore(null);
    expect(s.save(SPOTS, 1)).toBe(true);
    expect(s.get()).toEqual({ ...SPOTS, at: 1 });
  });
});
