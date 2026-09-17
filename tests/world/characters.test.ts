import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDog, createInspector, createRunner, type CharacterAction, type CharacterRig } from '../../src/world/models/characters';

const ACTIONS: CharacterAction[] = ['idle', 'run', 'jump', 'roll', 'fall', 'stumble', 'caught', 'hover', 'fly'];

function height(rig: CharacterRig): number {
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.root, true);
  return box.max.y - box.min.y;
}

function drive(rig: CharacterRig, action: CharacterAction, seconds: number, extra: { airborneT?: number } = {}): void {
  const state = { action, speed: 20, lean: 0, ...extra };
  for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60, state);
}

describe('characters', () => {
  it('runner is about 1.8 m tall while running', () => {
    const rig = createRunner();
    for (let i = 0; i < 6; i++) {
      drive(rig, 'run', 0.13);
      expect(height(rig)).toBeGreaterThan(1.65);
      expect(height(rig)).toBeLessThan(1.95);
    }
  });

  it('runner tucks under 0.9 m in a roll', () => {
    const rig = createRunner();
    drive(rig, 'run', 0.5);
    drive(rig, 'roll', 0.3);
    expect(height(rig)).toBeLessThanOrEqual(0.9);
    // and stays low through the whole tumble
    for (let i = 0; i < 10; i++) {
      drive(rig, 'roll', 0.05);
      expect(height(rig)).toBeLessThanOrEqual(0.9);
    }
  });

  it('inspector is about 1.85 m and the dog about 0.6 m', () => {
    const tt = createInspector();
    drive(tt, 'idle', 0.3);
    expect(height(tt)).toBeGreaterThan(1.7);
    expect(height(tt)).toBeLessThan(2.0);
    const dog = createDog();
    drive(dog, 'idle', 0.3);
    expect(height(dog)).toBeGreaterThan(0.5);
    expect(height(dog)).toBeLessThan(0.75);
  });

  it('update never throws for any action, and keeps finite transforms', () => {
    for (const make of [createRunner, createInspector, createDog]) {
      const rig = make();
      for (const a of ACTIONS) {
        expect(() => drive(rig, a, 0.4, { airborneT: 0.5 })).not.toThrow();
        expect(() => rig.update(0, { action: a, speed: 0, lean: -1 })).not.toThrow();
        expect(() => rig.update(5, { action: a, speed: 99, lean: 3 })).not.toThrow();
        expect(() => rig.update(Number.NaN, { action: a, speed: 12, lean: Number.NaN })).not.toThrow();
      }
      rig.root.updateMatrixWorld(true);
      rig.root.traverse((o) => {
        for (const v of o.matrixWorld.elements) expect(Number.isFinite(v)).toBe(true);
      });
    }
  });

  it('update does not grow the scene graph or allocate per call (sanity)', () => {
    const rig = createRunner();
    let count = 0;
    rig.root.traverse(() => count++);
    const state = { action: 'run' as CharacterAction, speed: 20, lean: 0.5, airborneT: 0 };
    const g = globalThis as { gc?: () => void };
    g.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) {
      state.action = ACTIONS[Math.floor(i / 50) % ACTIONS.length];
      state.airborneT = (i % 36) / 36;
      rig.update(1 / 60, state);
    }
    const grown = process.memoryUsage().heapUsed - before;
    let after = 0;
    rig.root.traverse(() => after++);
    expect(after).toBe(count);
    // Generous bound: 1000 updates must not leave megabytes behind.
    expect(grown).toBeLessThan(4 * 1024 * 1024);
  });
});
