import * as THREE from 'three';
import { createIntro, INTRO_BEATS, INTRO_DURATION, type IntroSequence } from './intro';
import { buildSkyDome, buildSkyline, createSideScenery, SKY_HORIZON } from './models/scenery';
import { createCatenary, createTrackBed } from './models/trackKit';

/**
 * Visual harness for the intro cinematic (not part of the build).
 *
 *   intro-harness.html?beat=1..4          jump to the start of a beat and hold
 *   intro-harness.html?t=2.7              jump to an absolute time and hold
 *   intro-harness.html?play                play it through in real time, then loop
 *   &seed=3 &variant=1 &skip=2.6          seed / poster variant / skip at that time
 *   &shot                                 hide the caption
 *
 * With no `play`, the sequence is stepped deterministically in 1/60 s steps from 0 to the
 * requested time and then frozen, so every screenshot of the same URL is identical.
 */

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1);
const variant = params.has('variant') ? Number(params.get('variant')) : undefined;
const play = params.has('play');
const skipAt = params.has('skip') ? Number(params.get('skip')) : null;
const beat = params.has('beat') ? Math.min(4, Math.max(1, Number(params.get('beat')))) : null;
const target = params.has('t') ? Number(params.get('t')) : beat !== null ? INTRO_BEATS[beat - 1] + 0.35 : 0;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// The same world dressing the game renders behind the cinematic.
const scene = new THREE.Scene();
const horizon = new THREE.Color(SKY_HORIZON);
scene.background = horizon;
scene.fog = new THREE.Fog(horizon, 60, 170);
scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b5b4a, 1.15));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 16, bottom: -16, near: 8, far: 60 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.position.set(-7, 15, 9);
sun.target.position.set(0, 0, 4);
scene.add(sun, sun.target);

const sky = buildSkyDome();
const skyline = buildSkyline();
scene.add(sky, skyline);
const side = createSideScenery(seed, { behind: 12, ahead: 175, lodFar: 55 });
const bed = createTrackBed(12, 175);
const ohe = createCatenary({ behind: 12, ahead: 175, signalFilter: (s) => !side.isStation(s) });
scene.add(bed.root, ohe.root, side.root);
side.update(0);
bed.update(0);
ohe.update(0);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);

let intro: IntroSequence = createIntro({ scene, camera, seed, variant });

const caption = document.getElementById('caption')!;
if (params.has('shot')) caption.style.display = 'none';

function follow(): void {
  sky.position.copy(camera.position);
  skyline.position.set(camera.position.x, skyline.position.y, camera.position.z);
  sun.position.set(camera.position.x - 7, 15, camera.position.z + 9);
  sun.target.position.set(camera.position.x, 0, camera.position.z - 4);
}

function label(): void {
  const i = renderer.info.render;
  caption.textContent =
    `t=${intro.time.toFixed(2)}s  beat ${intro.beat}  variant ${intro.posterVariant}` +
    `  ${i.calls} calls  ${(i.triangles / 1000).toFixed(0)}k tris${intro.done ? '  (done)' : ''}`;
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const ready = () => {
  const w = window as unknown as { __introReady: boolean; __intro: IntroSequence };
  w.__intro = intro;
  w.__introReady = true;
};

if (play) {
  const clock = new THREE.Clock();
  let skipped = false;
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (skipAt !== null && !skipped && intro.time + dt >= skipAt) {
      intro.seek(skipAt);
      intro.skip();
      skipped = true;
    } else if (!intro.update(dt)) {
      intro.dispose();
      intro = createIntro({ scene, camera, seed, variant });
      skipped = false;
    }
    follow();
    label();
    renderer.render(scene, camera);
    ready();
  });
} else {
  // Deterministic: step to the target in fixed frames, then hold.
  for (let t = 0; t < target - 1e-6; t = Math.min(target, t + 1 / 60)) intro.update(Math.min(1 / 60, target - t));
  if (skipAt !== null) intro.skip();
  follow();
  label();
  let frames = 0;
  renderer.setAnimationLoop(() => {
    intro.seek(intro.time); // re-place (the shout billboards to the camera)
    follow();
    renderer.render(scene, camera);
    label();
    if (frames++ > 2) ready();
  });
}
