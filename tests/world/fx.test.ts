import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/game/game';
import { Fx, FX, type FxFrame } from '../../src/world/fx';

const make = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 400);
  return { scene, camera, fx: new Fx(scene, camera) };
};

const frame = (over: Partial<FxFrame> = {}): FxFrame => ({
  speed: 12,
  flying: false,
  magnet: false,
  josh: false,
  runnerPos: new THREE.Vector3(),
  ...over,
});

const run = (fx: Fx, seconds: number, f: FxFrame, dt = 1 / 60) => {
  let out = fx.update(dt, f);
  for (let t = dt; t < seconds - 1e-9; t += dt) out = fx.update(dt, f);
  return out;
};

describe('Fx', () => {
  it('attaches its layer to the scene and the speed-line quad to the camera', () => {
    const { scene, camera, fx } = make();
    expect(fx.root.parent).toBe(scene);
    expect(camera.parent).toBe(scene);
    expect(camera.children.some((c) => c.name === 'fx-speedlines')).toBe(true);
  });

  it('bursts 8-12 sparks for a coin and lets them die out', () => {
    const { fx } = make();
    const pos = new THREE.Vector3();
    fx.onEvents([{ type: 'coin' }], pos);
    fx.update(1 / 60, frame());
    expect(fx.particles).toBeGreaterThanOrEqual(8);
    expect(fx.particles).toBeLessThanOrEqual(13);
    run(fx, 1, frame());
    expect(fx.particles).toBe(0);
  });

  it('bursts on pickups and puffs dust on stumbles, landings and rocket landings', () => {
    const { fx } = make();
    const pos = new THREE.Vector3();
    const events: GameEvent[] = [{ type: 'pickup', kind: 'rocket' }, { type: 'stumble' }, { type: 'rocketLanding' }];
    fx.onEvents(events, pos);
    fx.update(1 / 60, frame());
    expect(fx.particles).toBeGreaterThan(40);

    const { fx: fx2 } = make();
    const f = frame();
    // A jump arc: up, then down, then resting on the ground for a few frames.
    for (let i = 0; i <= 36; i++) {
      f.runnerPos.y = Math.max(0, Math.sin((i / 36) * Math.PI) * 1.5);
      fx2.update(1 / 60, f);
    }
    expect(fx2.particles).toBe(0);
    run(fx2, 0.1, f);
    expect(fx2.particles).toBeGreaterThan(5);
  });

  it('does not mistake a frame without a sim step for a landing', () => {
    const { fx } = make();
    const f = frame();
    f.runnerPos.y = 2;
    fx.update(1 / 60, f);
    f.runnerPos.y = 1.8;
    fx.update(1 / 60, f);
    fx.update(0.004, f); // no game step happened: y unchanged mid-fall
    f.runnerPos.y = 1.6;
    fx.update(1 / 60, f);
    expect(fx.particles).toBe(0);
  });

  it('streams rocket flame while flying and Josh streaks while josh is active', () => {
    const { fx } = make();
    run(fx, 0.5, frame({ flying: true, runnerPos: new THREE.Vector3(0, 3, 0) }));
    const flying = fx.particles;
    expect(flying).toBeGreaterThan(15);
    const { fx: fx2 } = make();
    run(fx2, 0.5, frame({ josh: true }));
    expect(fx2.particles).toBeGreaterThan(10);
  });

  it('shakes hard on caught and softly on stumble, decaying to zero', () => {
    const { fx } = make();
    fx.onEvents([{ type: 'caught', reason: 'crash' }], new THREE.Vector3());
    let peak = 0;
    let peakRoll = 0;
    for (let i = 0; i < 20; i++) {
      const o = fx.update(1 / 120, frame());
      peak = Math.max(peak, o.shake.length());
      peakRoll = Math.max(peakRoll, Math.abs(o.roll));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(FX.caught.amp * 1.3);
    expect(peakRoll).toBeLessThanOrEqual((3 * Math.PI) / 180);
    const after = run(fx, 0.3, frame());
    expect(after.shake.length()).toBe(0);
    expect(after.roll).toBe(0);

    const { fx: fx2 } = make();
    fx2.onEvents([{ type: 'stumble' }], new THREE.Vector3());
    let soft = 0;
    for (let i = 0; i < 10; i++) soft = Math.max(soft, fx2.update(1 / 120, frame()).shake.length());
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThanOrEqual(FX.stumble.amp * 1.3);
    expect(run(fx2, 0.2, frame()).shake.length()).toBe(0);
  });

  it('eases the FOV up by 5 degrees while flying and back down after', () => {
    const { fx } = make();
    const fly = frame({ flying: true });
    expect(fx.update(1 / 60, fly).fovDelta).toBeLessThan(1);
    expect(run(fx, 0.5, fly).fovDelta).toBeCloseTo(5, 1);
    expect(run(fx, 1, frame()).fovDelta).toBeLessThan(0.05);
  });

  it('shows speed lines only above 18 m/s, strongest when flying', () => {
    const { fx } = make();
    run(fx, 1, frame({ speed: 15 }));
    expect(fx.speedLineIntensity).toBeLessThan(0.01);
    run(fx, 1.5, frame({ speed: 26 }));
    const fast = fx.speedLineIntensity;
    expect(fast).toBeGreaterThan(0.1);
    run(fx, 1.5, frame({ speed: 26, flying: true }));
    expect(fx.speedLineIntensity).toBeGreaterThan(fast);
  });

  it('returns the same output object every frame (no per-frame allocation)', () => {
    const { fx } = make();
    const a = fx.update(1 / 60, frame());
    const b = fx.update(1 / 60, frame({ magnet: true, josh: true, flying: true }));
    expect(a).toBe(b);
    expect(a.shake).toBe(b.shake);
  });
});
