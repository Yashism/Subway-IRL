import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHOP_ITEMS, shopItem, DEFAULT_BOARD, DEFAULT_CHARACTER } from '../../src/app/progression';
import { createRunner } from '../../src/world/models/characters';
import { buildHoverboard } from '../../src/world/models/props';
import { Fx, type FxFrame } from '../../src/world/fx';

/** Every vertex colour in the rig, as a sorted list of hex strings. */
function palette(root: THREE.Object3D): string[] {
  const seen = new Set<string>();
  const c = new THREE.Color();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const attr = mesh.isMesh ? (mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;
    if (!attr) return;
    for (let i = 0; i < attr.count; i++) {
      c.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i));
      seen.add(c.getHexString());
    }
  });
  return [...seen].sort();
}

describe('shop character skins', () => {
  it('the default character is the rig the game has always shown', () => {
    const plain = createRunner();
    const equipped = createRunner({ skin: { id: DEFAULT_CHARACTER, palette: shopItem(DEFAULT_CHARACTER)?.palette } });
    // The free skin carries no palette, so it must not build a second copy of anything.
    expect(shopItem(DEFAULT_CHARACTER)?.palette).toBeUndefined();
    expect(palette(equipped.root)).toEqual(palette(plain.root));
  });

  it('every paid character actually changes the colours on the runner', () => {
    const base = palette(createRunner().root);
    const paid = SHOP_ITEMS.filter((i) => i.kind === 'character' && i.palette);
    expect(paid.length).toBeGreaterThan(0);
    for (const item of paid) {
      const skinned = palette(createRunner({ skin: { id: item.id, palette: item.palette } }).root);
      expect(skinned, item.id).not.toEqual(base);
      // Its own palette colours are actually on the mesh.
      for (const value of Object.values(item.palette!)) {
        expect(skinned, `${item.id}:${value.toString(16)}`).toContain(new THREE.Color(value).getHexString());
      }
    }
  });

  it('a skin is built once: asking for it again gives the same geometry', () => {
    const a = createRunner({ skin: { id: 'runner-college', palette: shopItem('runner-college')!.palette } });
    const b = createRunner({ skin: { id: 'runner-college', palette: shopItem('runner-college')!.palette } });
    const geoA = (a.root.getObjectByName('body') as THREE.Mesh).geometry;
    const geoB = (b.root.getObjectByName('body') as THREE.Mesh).geometry;
    expect(geoA).toBe(geoB);
  });

  it('skins never move a bone: every rig has the same skeleton as the default', () => {
    const base = createRunner();
    const skinned = createRunner({ skin: { id: 'runner-cricket', palette: shopItem('runner-cricket')!.palette } });
    base.root.updateMatrixWorld(true);
    skinned.root.updateMatrixWorld(true);
    const box = (r: THREE.Object3D) => new THREE.Box3().setFromObject(r, true);
    const a = box(base.root);
    const b = box(skinned.root);
    expect(b.max.y).toBeCloseTo(a.max.y, 4);
    expect(b.min.y).toBeCloseTo(a.min.y, 4);
  });
});

describe('shop board skins', () => {
  it('the default board is untouched, and a skin gives its own materials', () => {
    const plain = buildHoverboard();
    const same = buildHoverboard({ id: DEFAULT_BOARD, palette: shopItem(DEFAULT_BOARD)?.palette });
    const carpetOf = (g: THREE.Group) =>
      (g.children.find((c) => c.name.endsWith('-carpet')) as THREE.Mesh | undefined)?.material;
    expect(carpetOf(same)).toBe(carpetOf(plain));

    const neon = shopItem('board-neon')!;
    const skinned = buildHoverboard({ id: neon.id, palette: neon.palette });
    expect(carpetOf(skinned)).not.toBe(carpetOf(plain));
    expect(palette(skinned)).not.toEqual(palette(plain));
  });
});

describe('reduced motion and effects', () => {
  const frame = (over: Partial<FxFrame> = {}): FxFrame => ({
    speed: 30,
    flying: true,
    magnet: false,
    josh: false,
    runnerPos: new THREE.Vector3(),
    ...over,
  });
  const make = () => {
    const scene = new THREE.Scene();
    return new Fx(scene, new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 400));
  };

  it('reduced motion cuts the shake, the roll, the FOV pulse and the speed lines', () => {
    const fx = make();
    for (let i = 0; i < 60; i++) fx.update(1 / 60, frame());
    fx.onEvents([{ type: 'caught', reason: 'crash' }], new THREE.Vector3());
    const loud = fx.update(1 / 60, frame());
    expect(loud.shake.length() + Math.abs(loud.roll) + Math.abs(loud.fovDelta)).toBeGreaterThan(0);
    expect(fx.speedLineIntensity).toBeGreaterThan(0);

    fx.setReduced({ motion: true });
    for (let i = 0; i < 60; i++) fx.update(1 / 60, frame());
    const quiet = fx.update(1 / 60, frame());
    expect(quiet.shake.length()).toBe(0);
    expect(quiet.roll).toBe(0);
    expect(quiet.fovDelta).toBeCloseTo(0, 3);
    expect(fx.speedLineIntensity).toBeCloseTo(0, 3);
  });

  it('reduced effects stops the particles, and turning it off brings them back', () => {
    const fx = make();
    const at = new THREE.Vector3();
    fx.onEvents([{ type: 'coin', value: 1, x: 0, y: 1, z: 0 } as never], at);
    fx.update(1 / 60, frame());
    expect(fx.particles).toBeGreaterThan(0);

    fx.setReduced({ effects: true });
    expect(fx.particles).toBe(0);
    fx.onEvents([{ type: 'coin', value: 1, x: 0, y: 1, z: 0 } as never], at);
    fx.update(1 / 60, frame());
    expect(fx.particles).toBe(0);

    fx.setReduced({ effects: false });
    fx.onEvents([{ type: 'coin', value: 1, x: 0, y: 1, z: 0 } as never], at);
    fx.update(1 / 60, frame());
    expect(fx.particles).toBeGreaterThan(0);
  });
});
