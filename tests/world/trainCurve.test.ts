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

/** Longest z-span of any triangle in the outlined (silhouette) meshes. */
function longestSpan(root: THREE.Object3D): number {
  let worst = 0;
  const a = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.isOutline || o.userData.noOutline) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    for (let t = 0; t < count; t += 3) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        a.fromBufferAttribute(pos, index ? index.getX(t + k) : t + k);
        lo = Math.min(lo, a.z);
        hi = Math.max(hi, a.z);
      }
      worst = Math.max(worst, hi - lo);
    }
  });
  return worst;
}

describe('train geometry under the curved world', () => {
  it('has no face longer than ~3 m along the track, so the bend cannot bulge it', () => {
    for (const oncoming of [false, true]) {
      expect(longestSpan(trains.buildTrain(30, { livery: 'western', seed: 5, oncoming }))).toBeLessThanOrEqual(3.05);
    }
    expect(longestSpan(trains.buildTrain(10, { livery: 'central', seed: 2 }))).toBeLessThanOrEqual(3.05);
  });
});
