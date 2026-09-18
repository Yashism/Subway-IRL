import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OBSTACLES } from '../../src/game/obstacles';
import {
  buildAuto,
  buildBanner,
  buildCoin,
  buildCow,
  buildHandcart,
  buildHoverboard,
  buildLowBarrier,
  buildMagnetAura,
  buildPickup,
  coinGeometry,
  coinMaterial,
} from '../../src/world/models/props';

const TOL = 0.15;

function boxOf(root: THREE.Object3D, filter: (m: THREE.Mesh) => boolean = () => true): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.isOutline || !filter(mesh)) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

function triangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.isOutline) return;
    const g = mesh.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return n;
}

function expectContract(root: THREE.Object3D, length: number, height: number, width: number): void {
  const b = boxOf(root);
  expect(b.max.z).toBeCloseTo(0, 5); // near end at z = 0
  expect(Math.abs(-b.min.z - length)).toBeLessThanOrEqual(TOL); // extends toward -z
  expect(b.min.y).toBeGreaterThanOrEqual(-0.01); // stands on the floor
  expect(b.min.y).toBeLessThanOrEqual(0.05);
  expect(Math.abs(b.max.y - height)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(b.max.x - b.min.x - width)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(b.max.x + b.min.x)).toBeLessThanOrEqual(0.05); // centred on x
  expect(triangles(root)).toBeLessThan(4000);
}

describe('obstacle props match the model contract', () => {
  it.each([0, 1])('low barrier (seed %i): 0.5 long, 1.0 tall, 2.0 wide', (seed) => {
    expectContract(buildLowBarrier(seed), 0.5, 1.0, 2.0);
  });

  it.each([0, 1, 2])('handcart (seed %i): 1.5 long, up to 1.1 tall, 1.6 wide', (seed) => {
    const cart = buildHandcart(seed);
    expectContract(cart, 1.5, 1.1, 1.6);
    expect(boxOf(cart).max.y).toBeLessThanOrEqual(1.1 + 0.02);
  });

  it.each([0, 1, 2])('banner (seed %i): board 1.0..3.0, 2.2 wide, thin posts at the edges', (seed) => {
    const banner = buildBanner(seed);
    const b = boxOf(banner);
    expect(b.max.z).toBeCloseTo(0, 5);
    expect(Math.abs(-b.min.z - 0.5)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b.max.y - 3.0)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b.max.x - b.min.x - 2.2)).toBeLessThanOrEqual(TOL);

    const isPost = (m: THREE.Mesh) => m.userData.part === 'post';
    const board = boxOf(banner, (m) => !isPost(m));
    expect(board.min.y).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(board.min.y - 1.0)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(board.max.x - board.min.x - 2.2)).toBeLessThanOrEqual(TOL);

    // posts: thin, and only at x = ±1.1
    const posts = boxOf(banner, isPost);
    expect(posts.min.y).toBeLessThanOrEqual(0.01);
    const post = banner.children.find((c) => c.userData.part === 'post') as THREE.Mesh;
    const pos = post.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > 0.95) continue; // below the board, only the posts may exist
      expect(Math.abs(Math.abs(pos.getX(i)) - 1.1)).toBeLessThanOrEqual(0.12);
    }
    expect(triangles(banner)).toBeLessThan(4000);
  });

  it.each([0, 1])('auto (seed %i): 3.0 long, 2.0 tall, 1.4 wide', (seed) => {
    expectContract(buildAuto(seed), 3.0, 2.0, 1.4);
  });

  it.each([0, 1, 2])('standing cow (seed %i): 2.5 long, 1.6 tall, 1.0 wide', (seed) => {
    expectContract(buildCow(seed, 'stand'), 2.5, OBSTACLES.cow.yMax, 1.0);
  });

  it.each([0, 1, 2])('sitting cow (seed %i): 2.5 long, 0.95 tall, 1.0 wide — nothing pokes above what a jump clears', (seed) => {
    const cow = buildCow(seed, 'sit');
    expectContract(cow, 2.5, OBSTACLES.cowSitting.yMax, 1.0);
    // A runner passes over this: a head or horn above the collision top would be jumped *through*.
    expect(boxOf(cow).max.y).toBeLessThanOrEqual(OBSTACLES.cowSitting.yMax + 0.02);
  });

  it('obstacles are outlined and cast shadows', () => {
    for (const root of [buildLowBarrier(), buildHandcart(), buildBanner(), buildAuto(), buildCow()]) {
      let outlines = 0;
      let casters = 0;
      root.traverse((o) => {
        if (o.userData.isOutline) outlines++;
        else if ((o as THREE.Mesh).isMesh && o.castShadow) casters++;
      });
      expect(outlines).toBeGreaterThan(0);
      expect(casters).toBeGreaterThan(0);
    }
  });

  it('shares geometry between builds', () => {
    const a = buildAuto(0).children[0] as THREE.Mesh;
    const b = buildAuto(0).children[0] as THREE.Mesh;
    expect(a).not.toBe(b);
    expect(a.geometry).toBe(b.geometry);
  });
});

describe('pickups', () => {
  it('coin is ~0.7 m, centred, cheap and instancing-friendly', () => {
    const coin = buildCoin();
    const b = boxOf(coin);
    const size = b.getSize(new THREE.Vector3());
    expect(Math.abs(size.x - 0.7)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(size.y - 0.7)).toBeLessThanOrEqual(0.05);
    expect(size.z).toBeLessThan(0.2);
    expect(b.getCenter(new THREE.Vector3()).length()).toBeLessThan(0.02);
    expect(triangles(coin)).toBeLessThan(300);
    expect(coinGeometry()).toBe(coinGeometry());
    expect(coinMaterial()).toBe(coinMaterial());
    let outlined = false;
    coin.traverse((o) => (outlined ||= !!o.userData.isOutline));
    expect(outlined).toBe(true);
  });

  it.each(['magnet', 'rocket', 'chappal'] as const)('%s is ~0.9 m and centred at the origin', (kind) => {
    const p = buildPickup(kind);
    const b = boxOf(p);
    const size = b.getSize(new THREE.Vector3());
    const biggest = Math.max(size.x, size.y, size.z);
    expect(biggest).toBeGreaterThan(0.7);
    expect(biggest).toBeLessThan(1.15);
    expect(b.getCenter(new THREE.Vector3()).length()).toBeLessThan(0.15);
    expect(triangles(p)).toBeLessThan(4000);
  });

  it('hoverboard is a ~0.9 x 1.8 m board centred at the origin', () => {
    const board = buildHoverboard();
    const b = boxOf(board, (m) => m.name !== 'hoverboard-glow');
    const size = b.getSize(new THREE.Vector3());
    expect(Math.abs(size.x - 0.9)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(size.z - 1.8)).toBeLessThanOrEqual(0.3);
    expect(size.y).toBeLessThan(0.5);
    expect(triangles(board)).toBeLessThan(4000);
  });

  it('magnet aura is a translucent cyan mesh', () => {
    const aura = buildMagnetAura();
    const m = aura.material as THREE.MeshBasicMaterial;
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBeGreaterThan(0.1);
    expect(m.opacity).toBeLessThan(0.3);
    expect(m.color.getHex()).toBe(new THREE.Color(0x6fd1ff).getHex());
  });
});
