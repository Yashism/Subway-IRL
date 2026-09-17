import * as THREE from 'three';
import type { GalleryEntry } from '../../gallery/types';
import { createDog, createInspector, createRunner, type CharacterAction, type CharacterRig } from './characters';

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
/** `&style=glb` shows the optional GLB rigs instead of the procedural ones. */
const style = params.get('style') === 'glb' ? 'glb' : 'procedural';
/** `&t=<seconds>` freezes the animation clock (for repeatable screenshots). */
const frozen = params.has('t') ? Number(params.get('t')) : null;

const SPEED = 20;
type Driver = (t: number) => { action: CharacterAction; lean: number; airborneT?: number; y?: number };

function rigOf(o: THREE.Object3D): CharacterRig {
  return o.userData.rig as CharacterRig;
}

const state = { action: 'run' as CharacterAction, speed: SPEED, lean: 0, airborneT: undefined as number | undefined };

/** Advance a rig; with a frozen clock, simulate up to t once and then hold. */
function drive(o: THREE.Object3D, t: number, dt: number, fn: Driver): void {
  const rig = rigOf(o);
  const step = (time: number, d: number) => {
    const s = fn(time);
    state.action = s.action;
    state.lean = s.lean;
    state.airborneT = s.airborneT;
    rig.update(d, state);
    rig.root.position.y = s.y ?? 0;
  };
  if (frozen === null) {
    step(t, dt);
    return;
  }
  if (o.userData.frozenDone) return;
  o.userData.frozenDone = true;
  const n = Math.round(frozen * 60);
  for (let i = 0; i <= n; i++) step(i / 60, 1 / 60);
}

const JUMP_LEN = 0.6;
const JUMP_H = 1.2;
const drivers: Record<string, Driver> = {
  run: () => ({ action: 'run', lean: 0 }),
  jump: (t) => {
    const c = t % 1.0;
    if (c >= JUMP_LEN) return { action: 'run', lean: 0 };
    const a = c / JUMP_LEN;
    return { action: 'jump', lean: 0, airborneT: a, y: 4 * JUMP_H * a * (1 - a) };
  },
  roll: (t) => ({ action: t % 1.1 < 0.8 ? 'roll' : 'run', lean: 0 }),
  hover: (t) => ({ action: 'hover', lean: Math.sin(t * 1.3) }),
  fly: () => ({ action: 'fly', lean: 0, y: 0.6 }),
  stumble: (t) => ({ action: t % 1.4 < 0.5 ? 'stumble' : 'run', lean: 0 }),
  caught: (t) => ({ action: t % 4 < 0.3 ? 'idle' : 'caught', lean: 0 }),
  idle: () => ({ action: 'idle', lean: 0 }),
  lean: (t) => ({ action: 'run', lean: Math.max(-1, Math.min(1, 2.5 * Math.sin(t * 1.6))) }),
};

const frameGeo = new THREE.BoxGeometry(1, 1, 1);
const frameMat = new THREE.MeshBasicMaterial({ visible: false });

/** Wraps a rig with an invisible box so the gallery camera frames the whole body. */
function framed(rig: CharacterRig, size: number): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.Mesh(frameGeo, frameMat);
  box.scale.setScalar(size);
  box.position.y = size / 2;
  g.add(box, rig.root);
  g.userData.rig = rig;
  return g;
}

function entry(id: string, make: () => CharacterRig, driver: Driver, size = 2.9): GalleryEntry {
  return {
    id,
    build: () => framed(make(), size),
    animate: (o, t, dt) => drive(o, t, dt, driver),
  };
}

const runner = () => createRunner({ style });
const inspector = () => createInspector({ style });
const dog = () => createDog({ style });

export const entries: GalleryEntry[] = [
  ...(['run', 'jump', 'roll', 'hover', 'fly', 'stumble', 'caught'] as const).map((a) => entry(`char-runner-${a}`, runner, drivers[a])),
  entry('char-runner-idle', runner, drivers.idle),
  entry('char-runner-lean', runner, drivers.lean),
  entry('char-inspector-run', inspector, drivers.run),
  entry('char-inspector-caught', inspector, (t) => ({ action: t % 4 < 0.3 ? 'run' : 'caught', lean: 0 })),
  entry('char-dog-run', dog, drivers.run, 1.3),
  entry('char-dog-idle', dog, drivers.idle, 1.3),
  {
    id: 'char-lineup',
    build: () => {
      const g = new THREE.Group();
      const rigs = [inspector(), runner(), dog()];
      rigs[0].root.position.x = -1.15;
      rigs[2].root.position.x = 1.0;
      for (const r of rigs) g.add(r.root);
      g.userData.rigs = rigs;
      return g;
    },
    animate: (o, t, dt) => {
      for (const r of o.userData.rigs as CharacterRig[]) drive(r.root, t, dt, drivers.run);
    },
  },
];
