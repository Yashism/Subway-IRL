import * as THREE from 'three';
import type { GalleryEntry } from '../../gallery/types';
import { buildRamp, buildTrain } from './trains';

/** Wraps a model that extends from z=0 to -len so it spins around its middle. */
function centered(object: THREE.Object3D, len: number): THREE.Group {
  const g = new THREE.Group();
  object.position.z = len / 2;
  g.add(object);
  return g;
}

export const entries: GalleryEntry[] = [
  { id: 'train-western-30', build: () => centered(buildTrain(30, { livery: 'western', seed: 1 }), 30) },
  { id: 'train-central-30', build: () => centered(buildTrain(30, { livery: 'central', seed: 2 }), 30) },
  { id: 'train-oncoming-30', build: () => centered(buildTrain(30, { livery: 'central', seed: 3, oncoming: true }), 30) },
  { id: 'train-short-10', build: () => centered(buildTrain(10, { livery: 'western', seed: 4 }), 10) },
  { id: 'ramp', build: () => centered(buildRamp(0), 8) },
];
