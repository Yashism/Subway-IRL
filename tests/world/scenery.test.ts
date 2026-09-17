import { describe, expect, it } from 'vitest';
import {
  CHAWL_VARIANTS,
  CORRIDOR_PERIOD,
  FOB_LENGTH,
  FOB_MAST_OFFSET,
  MIN_SCENERY_X,
  PLATFORM_LENGTH,
  chawlFootprint,
  chawlParams,
  forEachVisible,
  isStationAt,
  maxConcurrent,
  planCorridor,
  platformNumberAt,
  FOB_STATION,
  type Placement,
} from '../../src/world/models/scenery';
import {
  MAST_SPACING,
  gridCapacity,
  gridFirst,
  gridLast,
  segmentFirst,
  segmentLast,
  signalAspect,
  signalSide,
} from '../../src/world/models/trackKit';

const plan = planCorridor(1);

describe('track grid helpers', () => {
  it('lists point items inside the window', () => {
    const s = 123.4;
    const first = gridFirst(s, 1.2, 15);
    const last = gridLast(s, 1.2, 180);
    expect(first * 1.2).toBeGreaterThanOrEqual(s - 15);
    expect((first - 1) * 1.2).toBeLessThan(s - 15);
    expect(last * 1.2).toBeLessThanOrEqual(s + 180);
    expect((last + 1) * 1.2).toBeGreaterThan(s + 180);
    expect(last - first + 1).toBeLessThanOrEqual(gridCapacity(1.2, 15, 180));
  });

  it('covers the window with segments', () => {
    for (const s of [0, 7.3, 11.99, 12, 500.5]) {
      const first = segmentFirst(s, 12, 15);
      const last = segmentLast(s, 12, 180);
      expect(first * 12).toBeLessThanOrEqual(s - 15);
      expect((first + 1) * 12).toBeGreaterThan(s - 15);
      expect((last + 1) * 12).toBeGreaterThanOrEqual(s + 180);
      expect(last * 12).toBeLessThan(s + 180);
      expect(last - first + 1).toBeLessThanOrEqual(gridCapacity(12, 15, 180) + 1);
    }
  });

  it('places occasional, deterministic signals', () => {
    let count = 0;
    for (let k = 0; k < 400; k++) {
      expect(signalSide(k)).toBe(signalSide(k));
      if (signalSide(k) !== 0) {
        count++;
        expect([0, 1, 2]).toContain(signalAspect(k));
      }
    }
    expect(count).toBeGreaterThan(40);
    expect(count).toBeLessThan(160);
  });
});

describe('chawl parameters', () => {
  it('are deterministic and within 3–6 storeys', () => {
    for (let seed = 0; seed < 30; seed++) {
      const p = chawlParams(seed);
      expect(p).toEqual(chawlParams(seed));
      expect(p.storeys).toBeGreaterThanOrEqual(3);
      expect(p.storeys).toBeLessThanOrEqual(6);
      expect(chawlFootprint(seed).length).toBeGreaterThan(p.width);
    }
    const storeys = new Set(Array.from({ length: CHAWL_VARIANTS }, (_, i) => chawlParams(i).storeys));
    expect(storeys.size).toBeGreaterThanOrEqual(3);
  });
});

describe('planCorridor', () => {
  it('is deterministic and seed dependent', () => {
    expect(planCorridor(1)).toEqual(plan);
    expect(planCorridor(2).placements).not.toEqual(plan.placements);
  });

  it('keeps every piece off the track and inside the period', () => {
    for (const p of plan.placements) {
      expect(p.minAbsX, `${p.kind} ${p.side}`).toBeGreaterThanOrEqual(MIN_SCENERY_X);
      expect(p.s0).toBeGreaterThanOrEqual(0);
      expect(p.s1).toBeLessThanOrEqual(plan.period);
      if (p.side !== 0) expect(Math.sign(p.x)).toBe(p.side);
    }
  });

  it('is sorted and indexed', () => {
    plan.placements.forEach((p, i) => {
      expect(p.index).toBe(i);
      if (i > 0) expect(p.s0).toBeGreaterThanOrEqual(plan.placements[i - 1].s0);
    });
  });

  const byLayer = (side: number, layers: string[], kinds?: string[]) =>
    plan.placements.filter((p) => p.side === side && layers.includes(p.layer) && (!kinds || kinds.includes(p.kind)));

  const noOverlap = (list: Placement[]) => {
    const sorted = [...list].sort((a, b) => a.s0 - b.s0);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].s0, `${sorted[i - 1].kind}→${sorted[i].kind}`).toBeGreaterThanOrEqual(sorted[i - 1].s1 - 1e-9);
  };

  it('never overlaps near-layer structures or mid-layer chawls on one side', () => {
    for (const side of [-1, 1]) {
      noOverlap(byLayer(side, ['near'], ['wall', 'fence', 'platform']));
      noOverlap(byLayer(side, ['mid'], ['chawl']));
      noOverlap(byLayer(side, ['back']));
    }
  });

  it('builds stations with platforms on both sides and a foot overbridge', () => {
    expect(plan.stations.length).toBeGreaterThanOrEqual(3);
    for (const [a, b] of plan.stations) {
      expect(b - a).toBe(PLATFORM_LENGTH);
      for (const side of [-1, 1]) expect(plan.placements.some((p) => p.kind === 'platform' && p.side === side && p.s0 === a)).toBe(true);
      expect(plan.fobs.some((f) => f >= a && f + 5 <= b)).toBe(true);
      expect(isStationAt(plan, (a + b) / 2)).toBe(true);
      expect(isStationAt(plan, (a + b) / 2 + plan.period)).toBe(true);
    }
    expect(isStationAt(plan, plan.stations[0][0] - 20)).toBe(false);
  });

  it('keeps foot overbridges between masts and clear of chawls and billboards', () => {
    for (const f of plan.fobs) {
      expect(((f % MAST_SPACING) + MAST_SPACING) % MAST_SPACING).toBeCloseTo(FOB_MAST_OFFSET, 6);
      for (const p of plan.placements) {
        if ((p.kind === 'chawl' && p.layer === 'mid') || p.kind === 'billboard') {
          expect(p.s1 <= f || p.s0 >= f + FOB_LENGTH, `${p.kind} at ${p.s0}`).toBe(true);
        }
      }
    }
  });

  it('keeps billboards away from platforms', () => {
    for (const p of plan.placements.filter((q) => q.kind === 'billboard')) {
      for (const [a, b] of plan.stations) expect(p.s1 <= a || p.s0 >= b).toBe(true);
    }
  });

  it('is varied: every kind appears and neighbours differ', () => {
    const kinds = new Set(plan.placements.map((p) => p.kind));
    for (const k of ['wall', 'fence', 'platform', 'fob', 'chawl', 'billboard', 'tree', 'auto']) expect(kinds.has(k as Placement['kind'])).toBe(true);
    for (const side of [-1, 1]) {
      const chawls = byLayer(side, ['mid'], ['chawl']);
      for (let i = 1; i < chawls.length; i++) expect(chawls[i].variant).not.toBe(chawls[i - 1].variant);
      const walls = byLayer(side, ['near'], ['wall']).sort((a, b) => a.s0 - b.s0);
      for (let i = 1; i < walls.length; i++) {
        if (walls[i].s0 - walls[i - 1].s1 < 1) expect(walls[i].variant).not.toBe(walls[i - 1].variant);
      }
    }
  });
});

describe('station numbering', () => {
  it('tags each platform and station bridge with its station, in running order', () => {
    const platforms = plan.placements.filter((p) => p.kind === 'platform');
    for (const p of platforms) expect(plan.stations[p.station][0]).toBe(p.s0);
    for (const p of plan.placements.filter((q) => q.kind === 'fob')) {
      if (p.variant === FOB_STATION) {
        const [a, b] = plan.stations[p.station];
        expect(p.s0 >= a && p.s0 < b).toBe(true);
      } else expect(p.station).toBe(-1);
    }
    expect(plan.placements.filter((p) => p.kind === 'fob' && p.variant === FOB_STATION)).toHaveLength(plan.stations.length);
    for (const p of plan.placements) if (p.kind !== 'platform' && p.kind !== 'fob') expect(p.station).toBe(-1);
  });

  it('numbers the platform at or ahead of the runner, continuing across repeats', () => {
    const st = plan.stations;
    const n = st.length;
    expect(platformNumberAt(plan, 0)).toBe(0);
    expect(platformNumberAt(plan, st[0][0] + 1)).toBe(0);
    expect(platformNumberAt(plan, st[0][1] - 0.01)).toBe(0);
    expect(platformNumberAt(plan, st[0][1] + 0.01)).toBe(1);
    expect(platformNumberAt(plan, st[n - 1][1] + 1)).toBe(n);
    expect(platformNumberAt(plan, plan.period + st[1][0])).toBe(n + 1);
    expect(platformNumberAt(plan, 5 * plan.period + 1)).toBe(5 * n);
    let prev = -1;
    for (let s = 0; s < 3 * plan.period; s += 7) {
      const k = platformNumberAt(plan, s);
      expect(k === prev || k === prev + 1).toBe(true);
      prev = k;
    }
    expect(prev).toBe(3 * n);
  });
});

describe('forEachVisible', () => {
  const brute = (a: number, b: number) => {
    const out: string[] = [];
    for (let m = Math.floor(a / plan.period) - 1; m <= Math.floor(b / plan.period) + 1; m++) {
      for (const p of plan.placements) if (p.s1 + m * plan.period > a && p.s0 + m * plan.period < b) out.push(`${p.index}@${m}`);
    }
    return out.sort();
  };

  it('matches a brute-force scan, including across the period seam', () => {
    for (const s of [0, 5, 431.7, CORRIDOR_PERIOD - 30, CORRIDOR_PERIOD + 12, 3 * CORRIDOR_PERIOD - 100]) {
      const got: string[] = [];
      forEachVisible(plan, s - 15, s + 180, (p, off) => got.push(`${p.index}@${off / plan.period}`));
      expect(got.sort()).toEqual(brute(s - 15, s + 180));
    }
  });

  it('never exceeds the computed instance capacity', () => {
    const keys = [...new Set(plan.placements.flatMap((p) => p.keys))];
    const caps = new Map(keys.map((k) => [k, maxConcurrent(plan, k, 15, 180)]));
    for (let s = 0; s < CORRIDOR_PERIOD * 1.2; s += 3.7) {
      const counts = new Map<string, number>();
      forEachVisible(plan, s - 15, s + 180, (p) => {
        for (const k of p.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
      });
      for (const [k, n] of counts) expect(n, k).toBeLessThanOrEqual(caps.get(k)!);
    }
  });
});
