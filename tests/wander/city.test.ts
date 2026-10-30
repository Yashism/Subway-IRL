import { describe, expect, it } from 'vitest';
import {
  BED_X0,
  CHUNK,
  CityIndex,
  LOT_MAX,
  LOT_MIN,
  PLATFORM_X0,
  PLATFORM_Y,
  RAMP_WIDTH,
  RAMP_X0,
  RAMP_Z,
  RAIL_CX,
  groundHeight,
  isCrossingLine,
  planChunk,
  spawnPoint,
  stationOfRow,
  tileKind,
  type Box,
  type Solids,
} from '../../src/wander/city';
import { createWalker, stepWalker, WALK } from '../../src/wander/walker';

const overlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

describe('chunk planning', () => {
  it('is deterministic: the same seed and chunk give the same plan', () => {
    for (const [cx, cz] of [[-3, 2], [0, 6], [1, 0], [5, -4]]) {
      expect(planChunk(42, cx, cz)).toEqual(planChunk(42, cx, cz));
    }
  });

  it('differs between seeds and between chunks', () => {
    expect(planChunk(1, 2, 2)).not.toEqual(planChunk(2, 2, 2));
    expect(planChunk(1, 2, 2)).not.toEqual(planChunk(1, 3, 2));
  });

  it('a plan does not depend on which plans were made before it', () => {
    const a = new CityIndex(7);
    const b = new CityIndex(7);
    a.plan(4, 4);
    a.plan(-1, 9);
    expect(a.plan(2, 3)).toEqual(b.plan(2, 3));
  });

  it('keeps every building inside its block and clear of the streets and footpaths', () => {
    for (let cx = -4; cx <= 4; cx++) {
      if (cx === RAIL_CX) continue;
      for (let cz = -4; cz <= 4; cz++) {
        const p = planChunk(9, cx, cz);
        for (const prop of p.props.filter((q) => q.kind === 'chawl')) expect(prop.variant).toBeGreaterThanOrEqual(0);
        const x0 = cx * CHUNK;
        const z0 = cz * CHUNK;
        // Chawl boxes are the larger boxes; autos are small. Every box must stay on the lot or kerb side.
        for (const b of p.boxes) {
          expect(b.x0).toBeGreaterThanOrEqual(x0 + 2.4);
          expect(b.x1).toBeLessThanOrEqual(x0 + CHUNK - 2.4);
          expect(b.z0).toBeGreaterThanOrEqual(z0 + 2.4);
          expect(b.z1).toBeLessThanOrEqual(z0 + CHUNK - 2.4);
        }
        const chawls = p.props.filter((q) => q.kind === 'chawl').length;
        const big = p.boxes.filter((b) => b.x1 - b.x0 > 6 && b.z1 - b.z0 > 6);
        expect(big.length).toBe(chawls);
        for (const b of big) {
          expect(b.x0).toBeGreaterThanOrEqual(x0 + LOT_MIN - 1e-6);
          expect(b.x1).toBeLessThanOrEqual(x0 + LOT_MAX + 1e-6);
          expect(b.z0).toBeGreaterThanOrEqual(z0 + LOT_MIN - 1e-6);
          expect(b.z1).toBeLessThanOrEqual(z0 + LOT_MAX + 1e-6);
        }
      }
    }
  });

  it('never overlaps two buildings', () => {
    for (let cx = -3; cx <= 3; cx++) {
      if (cx === RAIL_CX) continue;
      for (let cz = -3; cz <= 3; cz++) {
        const big = planChunk(5, cx, cz).boxes.filter((b) => b.x1 - b.x0 > 6 && b.z1 - b.z0 > 6);
        for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) expect(overlap(big[i], big[j])).toBe(false);
      }
    }
  });

  it('puts a station every sixth row of the railway, and a level crossing between', () => {
    expect(stationOfRow(0)).toBe(0);
    expect(stationOfRow(6)).toBe(1);
    expect(stationOfRow(-6)).toBe(-1);
    expect(stationOfRow(3)).toBeNull();
    expect(isCrossingLine(3)).toBe(true);
    expect(isCrossingLine(-3)).toBe(true);
    expect(isCrossingLine(0)).toBe(false);
    expect(tileKind(1, 0, 0)).toBe('station');
    expect(tileKind(1, 0, 2)).toBe('yardCrossS');
    expect(tileKind(1, 0, 3)).toBe('yardCrossN');
    expect(planChunk(1, 0, 6).station).toBe(1);
    expect(planChunk(1, 0, 6).props.some((p) => p.kind === 'platform')).toBe(true);
    expect(planChunk(1, 0, 1).props.some((p) => p.kind === 'platform')).toBe(false);
  });
});

describe('platform and ramps', () => {
  it('is flat at street level except over a station row', () => {
    expect(groundHeight(0, 18)).toBe(0);
    expect(groundHeight(100, 100)).toBe(0);
    expect(groundHeight((PLATFORM_X0 + 35.8) / 2, 20 + 64 * 6)).toBe(PLATFORM_Y);
    // Beside the platform row but not a station row: still ground.
    expect(groundHeight(32, 64 * 2 + 10)).toBe(0);
  });

  it('rises along a ramp from the forecourt to the platform', () => {
    const z = RAMP_Z[0];
    expect(groundHeight(RAMP_X0 + 0.01, z)).toBeCloseTo(0, 1);
    const mid = groundHeight((RAMP_X0 + PLATFORM_X0) / 2, z);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(groundHeight(PLATFORM_X0 + 0.01, z)).toBeCloseTo(PLATFORM_Y, 1);
    // Beside the ramp it is still the forecourt.
    expect(groundHeight((RAMP_X0 + PLATFORM_X0) / 2, z + RAMP_WIDTH)).toBe(0);
  });
});

describe('walking the city', () => {
  const walk = (city: CityIndex, x: number, z: number, heading: number, seconds: number, run = false) => {
    const w = createWalker(x, z, heading);
    const solids: Solids = { boxes: [], discs: [] };
    for (let t = 0; t < seconds; t += 1 / 60) {
      city.solidsNear(w.x, w.z, solids);
      stepWalker(w, { forward: 1, turn: 0, strafe: 0, run }, 1 / 60, solids);
    }
    return w;
  };

  it('spawns on open street', () => {
    const city = new CityIndex(1);
    const s = spawnPoint();
    const solids = city.solidsNear(s.x, s.z, { boxes: [], discs: [] });
    for (const b of solids.boxes) expect(s.x > b.x0 - WALK.radius && s.x < b.x1 + WALK.radius && s.z > b.z0 - WALK.radius && s.z < b.z1 + WALK.radius).toBe(false);
  });

  it('walks the whole length of a street without being stopped', () => {
    const city = new CityIndex(1);
    // The north-south street at x = -64 (between cx -2 and -1), heading south from z = 100.
    const w = walk(city, -64, 100, Math.PI, 20);
    expect(w.z).toBeGreaterThan(100 + 20 * WALK.walkSpeed * 0.8);
  });

  it('cannot walk through the railway yard from the street', () => {
    const city = new CityIndex(1);
    // East from the street at x = 0 along a plain row (z = 64 * 4 + 32) towards the tracks.
    const w = walk(city, 3, 64 * 4 + 32, Math.PI / 2, 15);
    expect(w.x).toBeLessThan(7.5);
  });

  it('can cross the railway at a level crossing', () => {
    const city = new CityIndex(1);
    const z = 64 * 3 + 2;
    const w = walk(city, 3, z, Math.PI / 2, 25, true);
    expect(w.x).toBeGreaterThan(64);
  });

  it('can walk from the forecourt up a ramp onto the platform but not off its edge', () => {
    const city = new CityIndex(1);
    const w = walk(city, 14, RAMP_Z[0], Math.PI / 2, 12);
    expect(w.x).toBeGreaterThan(PLATFORM_X0 + 0.5);
    expect(w.x).toBeLessThan(BED_X0 - WALK.radius + 0.01);
    expect(groundHeight(w.x, w.z)).toBe(PLATFORM_Y);
  });

  it('is stopped by the platform wall away from the ramps', () => {
    const city = new CityIndex(1);
    const w = walk(city, 14, 32, Math.PI / 2, 12);
    expect(w.x).toBeLessThan(PLATFORM_X0);
  });

  it('is blocked by a chawl', () => {
    const city = new CityIndex(1);
    const plan = city.plan(-2, 1);
    const b = plan.boxes.find((q) => q.x1 - q.x0 > 6 && q.z1 - q.z0 > 6)!;
    const z = (b.z0 + b.z1) / 2;
    const w = walk(city, b.x0 - 6, z, Math.PI / 2, 6);
    expect(w.x).toBeLessThanOrEqual(b.x0 - WALK.radius + 1e-6);
  });
});
