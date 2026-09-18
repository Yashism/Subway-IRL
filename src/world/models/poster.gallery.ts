import * as THREE from 'three';
import type { GalleryEntry } from '../../gallery/types';
import { flatMaterial } from '../render/materials';
import { buildFadedAd, buildPoster, buildRolledPoster, POSTER_H, POSTER_W } from './poster';

/** A scrap of coach wall to paste the bill onto, so the gallery shows it in context. */
function wall(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(POSTER_W * 2.0, POSTER_H * 1.24, 0.08), flatMaterial({ color: 0xf0e6c8 }));
  m.position.set(0, (POSTER_H * 1.24) / 2, -0.05);
  m.receiveShadow = true;
  return m;
}

function pasted(variant: number, unfurl = 1, flap = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(wall());
  const ad = buildFadedAd(variant);
  ad.position.set(0.02, POSTER_H * 0.52, 0.002);
  g.add(ad);
  const poster = buildPoster(variant);
  poster.shape({ unfurl, flap, time: 0.4 });
  poster.root.position.set(0, POSTER_H * 1.08, 0.012);
  g.add(poster.root);
  return g;
}

export const entries: GalleryEntry[] = [
  { id: 'poster-bhaago-0', build: () => pasted(0) },
  { id: 'poster-bhaago-1', build: () => pasted(1) },
  { id: 'poster-unfurling', build: () => pasted(0, 0.45) },
  { id: 'poster-flapping', build: () => pasted(1, 1, 1) },
  {
    id: 'poster-rolled',
    build: () => {
      const g = new THREE.Group();
      const roll = buildRolledPoster(0);
      roll.position.y = 0.6;
      roll.rotation.z = 0.25;
      g.add(roll);
      return g;
    },
  },
];
