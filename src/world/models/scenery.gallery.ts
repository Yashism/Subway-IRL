import * as THREE from 'three';
import type { GalleryEntry } from '../../gallery/types';
import { curveUniforms, enableShadows } from '../render/materials';
import { createCatenary, createTrackBed } from './trackKit';
import {
  SKY_HORIZON,
  buildBillboard,
  buildChawl,
  buildFence,
  buildFootOverbridge,
  buildParkedAuto,
  buildPlatform,
  buildSkyDome,
  buildSkyline,
  buildTree,
  buildWall,
  createSideScenery,
} from './scenery';
import { LINES, isLineId } from '../stations';

/** Wraps an object so its footprint is centred on the gallery pivot. */
function centred(object: THREE.Object3D, shadows = true): THREE.Group {
  if (shadows) enableShadows(object);
  const box = new THREE.Box3().setFromObject(object);
  const c = box.getCenter(new THREE.Vector3());
  object.position.x -= c.x;
  object.position.z -= c.z;
  const g = new THREE.Group();
  g.add(object);
  return g;
}

const params = () => new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

function buildCorridor(): THREE.Object3D {
  const q = params();
  const runnerView = q.get('view') === 'runner';
  const behind = 15;
  const ahead = runnerView ? 180 : 105;
  const s0 = Number(q.get('s') ?? 0);
  const line = q.get('line');
  const side = createSideScenery(Number(q.get('seed') ?? 1), { behind, ahead, line: isLineId(line) ? line : undefined });
  const bed = createTrackBed(behind, ahead);
  const cat = createCatenary({ behind, ahead, signalFilter: (s) => !side.isStation(s) });
  const inner = new THREE.Group();
  inner.add(bed.root, cat.root, side.root);
  const outer = new THREE.Group();
  outer.add(inner);
  if (!runnerView) inner.position.z = (ahead - behind) / 2;
  const update = (s: number) => {
    bed.update(s);
    cat.update(s);
    side.update(s);
  };
  update(s0);
  outer.userData.update = update;
  (globalThis as unknown as { __corridor?: unknown }).__corridor = { side, bed, cat };
  outer.userData.s0 = s0;

  let setup = false;
  const hook = bed.meshes[0];
  hook.onBeforeRender = (_r, scene, camera) => {
    if (setup) return;
    setup = true;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry?.type === 'PlaneGeometry' && !m.parent?.userData.corridor) m.visible = false;
    });
    if (runnerView) {
      const cam = camera as THREE.PerspectiveCamera;
      cam.fov = Number(q.get('fov') ?? 62);
      cam.far = 1000;
      cam.position.set(Number(q.get('cx') ?? 0), Number(q.get('cy') ?? 3.4), 6.2);
      cam.lookAt(Number(q.get('lx') ?? Number(q.get('cx') ?? 0) * 0.6), Number(q.get('ly') ?? 1.2), Number(q.get('lz') ?? -10));
      cam.updateProjectionMatrix();
      scene.fog = new THREE.Fog(SKY_HORIZON, 60, 170);
      scene.background = new THREE.Color(SKY_HORIZON);
      curveUniforms.uCurveEnabled.value = q.get('curve') === '0' ? 0 : 1;
    }
  };
  outer.userData.corridor = true;
  inner.userData.corridor = true;
  if (runnerView) {
    const sky = buildSkyDome();
    const skyline = buildSkyline();
    sky.position.set(0, 3.4, 6.2);
    skyline.position.set(0, 3.4, 6.2);
    outer.add(sky, skyline);
  }
  return outer;
}

export const entries: GalleryEntry[] = [
  ...[0, 1, 2].map((i) => ({ id: `scene-chawl-${i}`, build: () => centred(buildChawl(i)) })),
  { id: 'scene-platform', build: () => centred(buildPlatform(40, 0)) },
  // Real station names, one platform per line (a long, a mid and a Marathi-conjunct-heavy name).
  ...([
    ['western', 'Vile Parle'],
    ['central', 'Chhatrapati Shivaji Maharaj Terminus'],
    ['harbour', 'Seawoods–Darave–Karave'],
  ] as const).map(([line, name]) => ({
    id: `scene-platform-${line}`,
    build: () => centred(buildPlatform(40, 0, LINES[line].stations.find((s) => s.en === name)!)),
  })),
  { id: 'scene-fob', build: () => centred(buildFootOverbridge(0, LINES.central.stations[18])) },
  { id: 'scene-fob-between', build: () => centred(buildFootOverbridge(1)) },
  { id: 'scene-wall', build: () => centred(buildWall(16, 0)) },
  { id: 'scene-fence', build: () => centred(buildFence(12)) },
  { id: 'scene-billboard', build: () => centred(buildBillboard(2)) },
  ...(['palm', 'banyan', 'gulmohar'] as const).map((name, i) => ({ id: `scene-tree-${name}`, build: () => centred(buildTree(i)) })),
  { id: 'scene-auto', build: () => centred(buildParkedAuto(1)) },
  {
    id: 'scene-corridor',
    build: buildCorridor,
    animate: (object, t) => {
      const speed = Number(params().get('speed') ?? 12);
      (object.userData.update as (s: number) => void)((object.userData.s0 as number) + t * speed);
    },
  },
];
