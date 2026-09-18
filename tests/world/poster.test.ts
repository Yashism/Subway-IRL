import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Node has no canvas: stub a 2D context that swallows every call.
const any: unknown = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : p === 'width' ? 10 : any),
  apply: () => any,
  set: () => true,
});

let poster: typeof import('../../src/world/models/poster');

beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => any }),
  });
  poster = await import('../../src/world/models/poster');
});

function bounds(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o, true);
}

describe('buildPoster', () => {
  it('hangs from its origin: the sheet fills W x H below y = 0', () => {
    const p = poster.buildPoster(0);
    p.shape({ unfurl: 1, flap: 0, time: 0 });
    const b = bounds(p.root);
    expect(b.max.y).toBeCloseTo(0, 3);
    expect(b.min.y).toBeCloseTo(-poster.POSTER_H, 3);
    expect(b.max.x - b.min.x).toBeCloseTo(poster.POSTER_W, 3);
    // flat against the wall
    expect(Math.abs(b.max.z)).toBeLessThan(0.02);
    p.dispose();
  });

  it('rolls up from the bottom as unfurl drops', () => {
    const p = poster.buildPoster(0);
    const drop = (u: number) => {
      p.shape({ unfurl: u, flap: 0, time: 0 });
      return -bounds(p.root).min.y;
    };
    const full = drop(1);
    const half = drop(0.5);
    const shut = drop(0.05);
    expect(half).toBeLessThan(full - 0.3);
    expect(shut).toBeLessThan(half);
    // even fully rolled the roll has some thickness, so it never collapses to nothing
    expect(shut).toBeGreaterThan(0.02);
    p.dispose();
  });

  it('the rolled tail curls out from the wall', () => {
    const p = poster.buildPoster(0);
    p.shape({ unfurl: 1, flap: 0, time: 0 });
    const flat = bounds(p.root).max.z;
    p.shape({ unfurl: 0.3, flap: 0, time: 0 });
    expect(bounds(p.root).max.z).toBeGreaterThan(flat + 0.05);
    p.dispose();
  });

  it('flap lifts only the bottom corner, off the wall', () => {
    const p = poster.buildPoster(0);
    p.shape({ unfurl: 1, flap: 0, time: 0 });
    const flat = bounds(p.root).max.z;
    p.shape({ unfurl: 1, flap: 1, time: 0 });
    const lifted = bounds(p.root).max.z;
    expect(lifted).toBeGreaterThan(flat + 0.05);
    // the top edge stays pasted down
    const pos = p.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > -0.05) expect(Math.abs(pos.getZ(i))).toBeLessThan(0.02);
    }
    p.dispose();
  });

  it('shape() rewrites the same buffer, never a new one', () => {
    const p = poster.buildPoster(1);
    const attr = p.mesh.geometry.attributes.position;
    const array = attr.array;
    for (let t = 0; t < 1; t += 0.1) p.shape({ unfurl: t, flap: t, time: t });
    expect(p.mesh.geometry.attributes.position).toBe(attr);
    expect(p.mesh.geometry.attributes.position.array).toBe(array);
    p.dispose();
  });

  it('each variant has its own cached art, and materials are shared', () => {
    const a = poster.posterTexture(0);
    const b = poster.posterTexture(1);
    expect(a).not.toBe(b);
    expect(poster.posterTexture(0)).toBe(a);
    // out-of-range variants wrap instead of throwing
    expect(poster.posterTexture(poster.POSTER_VARIANTS)).toBe(a);
    expect(poster.posterTexture(-1)).toBe(b);
    expect(poster.posterMaterial(0)).toBe(poster.posterMaterial(0));
    expect(poster.posterMaterial(0)).not.toBe(poster.posterMaterial(1));
  });

  it('dispose drops the sheet geometry but leaves the shared material alone', () => {
    const p = poster.buildPoster(0);
    const geo = p.mesh.geometry;
    const mat = p.mesh.material as THREE.Material;
    const geoSpy = vi.spyOn(geo, 'dispose');
    const matSpy = vi.spyOn(mat, 'dispose');
    p.dispose();
    expect(geoSpy).toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(p.root.children).toHaveLength(0);
    matSpy.mockRestore();
  });

  it('the faded ad is wider than the bill it gets covered by', () => {
    const ad = poster.buildFadedAd(0);
    const b = bounds(ad);
    expect(b.max.x - b.min.x).toBeGreaterThan(poster.POSTER_W);
  });
});
