import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Node has no canvas: stub a 2D context that swallows every call.
const any: unknown = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : p === 'width' ? 10 : any),
  apply: () => any,
  set: () => true,
});

let trains: typeof import('../../src/world/models/trains');

beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => any }),
  });
  trains = await import('../../src/world/models/trains');
});

function bounds(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

describe('buildTrain', () => {
  for (const opts of [
    { livery: 'western' as const, seed: 1 },
    { livery: 'central' as const, seed: 2 },
    { livery: 'central' as const, seed: 3, oncoming: true },
  ]) {
    it(`fits the collision box (${opts.livery}${opts.oncoming ? ', oncoming' : ''})`, () => {
      const b = bounds(trains.buildTrain(30, opts));
      expect(b.min.x).toBeGreaterThanOrEqual(-1.2);
      expect(b.max.x).toBeLessThanOrEqual(1.2);
      expect(b.min.y).toBeCloseTo(0, 1);
      expect(b.max.y).toBeGreaterThanOrEqual(3.2);
      expect(b.max.y).toBeLessThanOrEqual(3.9);
      expect(Math.abs(b.min.z + 30)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(b.max.z)).toBeLessThanOrEqual(0.3);
    });
  }

  it('splits long trains into coaches and stays within short lengths', () => {
    const b = bounds(trains.buildTrain(10, { livery: 'western', seed: 4 }));
    expect(Math.abs(b.min.z + 10)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(b.max.z)).toBeLessThanOrEqual(0.3);
    const long = trains.buildTrain(60, { livery: 'western', seed: 5 });
    const coaches = long.children.filter((c) => c.type === 'Group');
    expect(coaches.length).toBeGreaterThanOrEqual(4);
  });
});

describe('buildRamp', () => {
  it('spans 8 m and rises to the roof', () => {
    const b = bounds(trains.buildRamp());
    expect(Math.abs(b.min.z + 8)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(b.max.z)).toBeLessThanOrEqual(0.3);
    expect(b.max.x).toBeLessThanOrEqual(1.2);
    expect(b.min.y).toBeCloseTo(0, 1);
    expect(b.max.y).toBeGreaterThanOrEqual(3.2);
  });
});
