import * as THREE from 'three';
import type { GameEvent } from '../game/game';
import type { PowerupKind } from '../game/track';
import type { GalleryEntry } from '../gallery/types';
import { Fx } from './fx';
import { toonMaterial } from './render/materials';

interface DemoState {
  fx: Fx;
  pos: THREE.Vector3;
  marker: THREE.Object3D;
  next: number;
  beat: number;
  events: GameEvent[];
}

const KINDS: PowerupKind[] = ['magnet', 'rocket', 'chappal'];

/** A stand-in runner so the effects have something to wrap. */
function marker(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 4, 12), toonMaterial({ color: 0xff7a1a }));
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), toonMaterial({ color: 0xc68642 }));
  head.position.y = 1.55;
  g.add(body, head);
  return g;
}

function build(speedLines: boolean): THREE.Object3D {
  const root = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 100);
  const fx = new Fx(root, cam, { speedLines });
  const m = marker();
  root.add(m);
  const state: DemoState = { fx, pos: new THREE.Vector3(), marker: m, next: 0.3, beat: 0, events: [] };
  root.userData.demo = state;
  return root;
}

/**
 * A 6 s loop: coin sparkles every 0.4 s, a pickup burst every 1.2 s, a hop with
 * landing dust, then 2 s on the "rocket" (flame + smoke). The magnet aura and Josh
 * streaks stay on so a still frame shows everything at once.
 */
function animate(object: THREE.Object3D, t: number, dt: number, speedLines: boolean): void {
  const d = object.userData.demo as DemoState;
  const phase = t % 6;
  const flying = phase > 3.6;
  d.pos.set(0, flying ? 0.9 : phase > 2 && phase < 2.6 ? Math.sin(((phase - 2) / 0.6) * Math.PI) * 1.4 : 0, 0);
  d.marker.position.copy(d.pos);
  d.events.length = 0;
  if (t >= d.next) {
    d.next = t + 0.4;
    d.beat++;
    d.events.push({ type: 'coin' });
    if (d.beat % 3 === 0) d.events.push({ type: 'pickup', kind: KINDS[(d.beat / 3) % 3] });
    if (d.beat % 5 === 0) d.events.push({ type: 'stumble' });
  }
  d.fx.onEvents(d.events, d.pos);
  d.fx.update(dt, { speed: speedLines ? 32 : 6, flying: speedLines || flying, magnet: true, josh: true, runnerPos: d.pos });
}

export const entries: GalleryEntry[] = [
  { id: 'fx-demo', build: () => build(false), animate: (o, t, dt) => animate(o, t, dt, false) },
  { id: 'fx-speedlines', build: () => build(true), animate: (o, t, dt) => animate(o, t, dt, true) },
];
