import * as THREE from 'three';
import { curveUniforms } from '../world/render/materials';
import type { GalleryEntry, GalleryModule } from './types';

const modules = import.meta.glob<GalleryModule>('../world/**/*.gallery.ts', { eager: true });
const params = new URLSearchParams(location.search);
const only = params.get('only');
const angle = params.has('angle') ? Number(params.get('angle')) : null;
const entries: GalleryEntry[] = Object.values(modules)
  .flatMap((m) => m.entries)
  .filter((e) => !only || only.split(',').some((o) => e.id.includes(o)));

curveUniforms.uCurveEnabled.value = 0;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfe3ff);
scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b5b4a, 1.0));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
sun.position.set(-8, 14, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
const items: { entry: GalleryEntry; object: THREE.Object3D; pivot: THREE.Group }[] = [];
const labels = document.createElement('div');
labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:13px system-ui;color:#123;';
document.body.append(labels);

let cell = 1;
for (const entry of entries) {
  const object = entry.build();
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  cell = Math.max(cell, size.x, size.z, size.y * 0.8);
  const pivot = new THREE.Group();
  pivot.add(object);
  items.push({ entry, object, pivot });
  scene.add(pivot);
}
cell *= 1.35;
const rows = Math.ceil(items.length / cols);
items.forEach((it, i) => {
  it.pivot.position.set((i % cols - (cols - 1) / 2) * cell, 0, (Math.floor(i / cols) - (rows - 1) / 2) * cell);
  if (angle !== null) it.pivot.rotation.y = (angle * Math.PI) / 180;
});

const ground = new THREE.Mesh(new THREE.PlaneGeometry(cols * cell + 20, rows * cell + 20), new THREE.MeshStandardMaterial({ color: 0xd8cfc0 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const span = Math.max(cols, rows) * cell;
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, span * 10);
camera.position.set(span * 0.55, span * 0.55, span * 1.05);
camera.lookAt(0, cell * 0.15, 0);
Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 4 });
sun.shadow.camera.updateProjectionMatrix();

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const clock = new THREE.Clock();
let frames = 0;
const tmp = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  for (const it of items) {
    if (angle === null) it.pivot.rotation.y += dt * 0.4;
    it.entry.animate?.(it.object, t, dt);
  }
  renderer.render(scene, camera);
  if (frames++ % 10 === 0) {
    labels.replaceChildren(
      ...items.map((it) => {
        tmp.copy(it.pivot.position).project(camera);
        const d = document.createElement('div');
        d.textContent = it.entry.id;
        d.style.cssText = `position:absolute;left:${((tmp.x + 1) / 2) * innerWidth}px;top:${((1 - tmp.y) / 2) * innerHeight + 14}px;transform:translateX(-50%);background:#fff9;padding:1px 4px;border-radius:3px`;
        return d;
      }),
    );
  }
  if (frames > 3) (window as unknown as { __galleryReady: boolean }).__galleryReady = true;
});
