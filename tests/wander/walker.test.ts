import { describe, expect, it } from 'vitest';
import {
  CAMERA,
  NO_INPUT,
  WALK,
  angleDelta,
  clearDistance,
  createFollowCamera,
  createWalker,
  pushOutOfBox,
  resolveCollisions,
  stepFollowCamera,
  stepWalker,
  wrapAngle,
  type WalkInput,
} from '../../src/wander/walker';
import type { Solids } from '../../src/wander/city';

const open: Solids = { boxes: [], discs: [] };
const input = (o: Partial<WalkInput>): WalkInput => ({ ...NO_INPUT, ...o });
const run = (w: ReturnType<typeof createWalker>, i: WalkInput, seconds: number, solids: Solids = open) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepWalker(w, i, 1 / 60, solids);
};

describe('movement', () => {
  it('heading 0 faces -z, and forward walks that way at about the walk speed', () => {
    const w = createWalker(0, 0, 0);
    run(w, input({ forward: 1 }), 3);
    expect(w.x).toBeCloseTo(0, 5);
    expect(w.z).toBeLessThan(-8);
    expect(w.speed).toBeCloseTo(WALK.walkSpeed, 0);
  });

  it('turns right (towards +x) with positive turn', () => {
    const w = createWalker(0, 0, 0);
    run(w, input({ turn: 1 }), 0.5);
    expect(w.heading).toBeCloseTo(WALK.turnRate * 0.5, 1);
    const e = createWalker(0, 0, Math.PI / 2);
    run(e, input({ forward: 1 }), 2);
    expect(e.x).toBeGreaterThan(4);
    expect(Math.abs(e.z)).toBeLessThan(0.01);
  });

  it('runs faster than it walks and backs up slower', () => {
    const a = createWalker();
    const b = createWalker();
    const c = createWalker();
    run(a, input({ forward: 1 }), 3);
    run(b, input({ forward: 1, run: true }), 3);
    run(c, input({ forward: -1 }), 3);
    expect(Math.abs(b.z)).toBeGreaterThan(Math.abs(a.z) * 1.5);
    expect(c.z).toBeGreaterThan(0);
    expect(Math.abs(c.z)).toBeLessThan(Math.abs(a.z));
  });

  it('eases to a stop when the input stops', () => {
    const w = createWalker();
    run(w, input({ forward: 1 }), 2);
    run(w, NO_INPUT, 1);
    expect(w.speed).toBe(0);
    const z = w.z;
    run(w, NO_INPUT, 1);
    expect(w.z).toBe(z);
  });

  it('ignores a zero or invalid dt', () => {
    const w = createWalker(1, 2, 0.5);
    stepWalker(w, input({ forward: 1 }), 0, open);
    stepWalker(w, input({ forward: 1 }), NaN, open);
    expect([w.x, w.z, w.heading]).toEqual([1, 2, 0.5]);
  });

  it('does not tunnel through a thin wall at running speed with a long frame', () => {
    const wall: Solids = { boxes: [{ x0: -5, z0: -10.1, x1: 5, z1: -10 }], discs: [] };
    const w = createWalker(0, 0, 0);
    for (let i = 0; i < 40; i++) stepWalker(w, input({ forward: 1, run: true }), 0.1, wall);
    expect(w.z).toBeGreaterThanOrEqual(-10 + WALK.radius - 1e-6);
  });
});

describe('collision', () => {
  it('slides along a wall instead of sticking', () => {
    const wall: Solids = { boxes: [{ x0: -20, z0: -10, x1: 20, z1: -9 }], discs: [] };
    const w = createWalker(0, -5, -Math.PI / 4);
    run(w, input({ forward: 1 }), 3, wall);
    expect(w.z).toBeGreaterThanOrEqual(-9 + 1e-6);
    expect(w.z).toBeLessThan(-9 + WALK.radius + 0.01);
    // Slid sideways (heading is north-west, so x went negative).
    expect(w.x).toBeLessThan(-4);
  });

  it('pushes a disc out of a box by the nearest face, even from inside', () => {
    const p = { x: 0.9, z: 0 };
    expect(pushOutOfBox(p, 0.4, { x0: -1, z0: -1, x1: 1, z1: 1 })).toBe(true);
    expect(p.x).toBeCloseTo(1.4, 6);
    const inside = { x: 0.2, z: 0.7 };
    pushOutOfBox(inside, 0.4, { x0: -1, z0: -1, x1: 1, z1: 1 });
    expect(inside.z).toBeCloseTo(1.4, 6);
  });

  it('settles in a corner between two walls', () => {
    const corner: Solids = { boxes: [{ x0: 0, z0: -10, x1: 1, z1: 10 }, { x0: -10, z0: 0, x1: 10, z1: 1 }], discs: [] };
    const p = { x: -0.1, z: -0.1 };
    resolveCollisions(p, 0.4, corner);
    expect(p.x).toBeLessThanOrEqual(-0.4 + 1e-6);
    expect(p.z).toBeLessThanOrEqual(-0.4 + 1e-6);
  });

  it('is blocked by a round trunk and by a moving solid passed as extra', () => {
    const tree: Solids = { boxes: [], discs: [{ x: 0, z: -5, r: 0.5 }] };
    const w = createWalker(0, 0, 0);
    run(w, input({ forward: 1 }), 4, tree);
    expect(Math.hypot(w.x, w.z + 5)).toBeGreaterThanOrEqual(0.5 + WALK.radius - 1e-6);
    const t = createWalker(0, 0, Math.PI / 2);
    const train = [{ x0: 3, z0: -50, x1: 5.6, z1: 50 }];
    for (let i = 0; i < 240; i++) stepWalker(t, input({ forward: 1 }), 1 / 60, open, train);
    expect(t.x).toBeLessThanOrEqual(3 - WALK.radius + 1e-6);
  });
});

describe('angles', () => {
  it('wraps and finds the short way round', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 6);
  });
});

describe('follow camera', () => {
  it('swings round behind the walker over a second or two', () => {
    const cam = createFollowCamera(0);
    const w = createWalker(0, 0, Math.PI / 2);
    for (let i = 0; i < 120; i++) stepFollowCamera(cam, w, 1 / 60, open);
    expect(cam.yaw).toBeGreaterThan(Math.PI / 2 - 0.1);
    expect(cam.distance).toBeCloseTo(CAMERA.distance, 3);
  });

  it('turns the short way across the +-PI seam', () => {
    const cam = createFollowCamera(3);
    const w = createWalker(0, 0, -3);
    stepFollowCamera(cam, w, 1 / 30, open);
    expect(Math.abs(cam.yaw)).toBeGreaterThan(3);
  });

  it('is pulled in when a wall is behind the walker, and eases back out', () => {
    // Walker faces north, camera is south of it; a wall 2.5 m behind.
    const wall: Solids = { boxes: [{ x0: -10, z0: 2.5, x1: 10, z1: 3 }], discs: [] };
    const cam = createFollowCamera(0);
    const w = createWalker(0, 0, 0);
    stepFollowCamera(cam, w, 1 / 60, wall, true);
    expect(cam.distance).toBeLessThan(2.5);
    expect(cam.distance).toBeGreaterThanOrEqual(CAMERA.minDistance);
    for (let i = 0; i < 240; i++) stepFollowCamera(cam, w, 1 / 60, open);
    expect(cam.distance).toBeCloseTo(CAMERA.distance, 1);
  });

  it('measures clear distance to boxes and discs', () => {
    const s: Solids = { boxes: [{ x0: -1, z0: 4, x1: 1, z1: 5 }], discs: [{ x: 0, z: 2, r: 0.3 }] };
    expect(clearDistance(0, 0, 0, 1, 10, s, 0)).toBeCloseTo(2, 6);
    expect(clearDistance(0, 0, 0, -1, 10, s, 0)).toBe(10);
    expect(clearDistance(5, 0, 0, 1, 10, { boxes: s.boxes, discs: [] }, 0)).toBe(10);
  });
});
