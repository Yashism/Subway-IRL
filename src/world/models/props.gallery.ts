import * as THREE from 'three';
import type { GalleryEntry } from '../../gallery/types';
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
  updateMagnetAura,
  type PickupKind,
} from './props';

/** Pickups are centred on the origin; lift them off the gallery floor (in game they float at 1 m). */
function lifted(object: THREE.Object3D, y = 0.55): THREE.Group {
  const g = new THREE.Group();
  object.position.y = y;
  g.add(object);
  return g;
}

const spin = (object: THREE.Object3D, t: number) => {
  const inner = object.children[0];
  inner.rotation.y = t * Math.PI; // 180 deg/s
  inner.position.y = 0.55 + 0.05 * Math.sin(t * Math.PI * 2);
};

const pickup = (kind: PickupKind): GalleryEntry => ({
  id: `pickup-${kind}`,
  build: () => lifted(buildPickup(kind)),
  animate: (o, t) => {
    const inner = o.children[0];
    inner.rotation.y = Math.sin(t * 1.5) * 0.6;
    inner.position.y = 0.55 + 0.05 * Math.sin(t * Math.PI * 2);
  },
});

export const entries: GalleryEntry[] = [
  { id: 'prop-barrier', build: () => buildLowBarrier(0) },
  { id: 'prop-barrier-b', build: () => buildLowBarrier(1) },
  ...[0, 1, 2].map((s): GalleryEntry => ({ id: `prop-handcart-${s}`, build: () => buildHandcart(s) })),
  ...[0, 1, 2].map((s): GalleryEntry => ({ id: `prop-banner-${s}`, build: () => buildBanner(s) })),
  { id: 'prop-auto', build: () => buildAuto(0) },
  { id: 'prop-auto-b', build: () => buildAuto(1) },
  { id: 'prop-cow-standing', build: () => buildCow(0) },
  { id: 'prop-cow-sitting', build: () => buildCow(1) },
  { id: 'prop-cow-patched', build: () => buildCow(2) },
  { id: 'pickup-coin', build: () => lifted(buildCoin()), animate: spin },
  { id: 'pickup-coin-face', build: () => lifted(buildCoin()) },
  pickup('magnet'),
  pickup('rocket'),
  pickup('chappal'),
  {
    id: 'pickup-hoverboard',
    build: () => lifted(buildHoverboard(), 0.4),
    animate: (o, t) => {
      o.children[0].position.y = 0.4 + 0.04 * Math.sin(t * 3);
    },
  },
  {
    id: 'pickup-magnet-aura',
    build: () => lifted(buildMagnetAura(), 0.9),
    animate: (o, t) => updateMagnetAura(o.children[0], t, 0.9),
  },
];
