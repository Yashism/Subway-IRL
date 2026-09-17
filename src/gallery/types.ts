import type * as THREE from 'three';

/** One model shown on the model gallery page (gallery.html). */
export interface GalleryEntry {
  id: string;
  /** Builds a fresh object. Dimensions are in metres, standing on y = 0, facing -z (away from the camera). */
  build: () => THREE.Object3D;
  /** Optional per-frame animation hook (seconds). */
  animate?: (object: THREE.Object3D, t: number, dt: number) => void;
}

/** Every `*.gallery.ts` file exports `entries`. */
export interface GalleryModule {
  entries: GalleryEntry[];
}
