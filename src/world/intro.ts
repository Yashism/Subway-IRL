import * as THREE from 'three';
import { basicMaterial, toonMaterial } from './render/materials';
import { canvasTexture, seededRandom } from './render/canvasTexture';
import { createInspector, createRunner, type CharacterRig } from './models/characters';
import { buildFadedAd, buildPoster, POSTER_H, POSTER_VARIANTS, type Poster } from './models/poster';
import { buildTrain } from './models/trains';

/**
 * The intro cinematic: a kid pastes a hand-painted film bill on a parked local, the TT's
 * torch finds him, and he bolts — straight into the game's running camera.
 *
 * The whole thing is a pure function of time. `seek(t)` places every object, the camera
 * and the particles from `t` alone, so `update(dt)` and `skip()` share one code path, any
 * frame can be reproduced exactly for a screenshot, and a skip at any beat lands in the
 * same state as playing through. Only the character rigs carry state; they are stepped in
 * fixed sub-steps so a replayed seek reproduces them too.
 *
 * Everything lives under one group. `dispose()` puts the scene back exactly as it was.
 */

// ---------------------------------------------------------------------------
// Staging (metres, world space; the runner's home is the origin, forward is -z)
// ---------------------------------------------------------------------------

/** Beat boundaries in seconds: [start of 1, 2, 3, 4, end]. */
export const INTRO_BEATS = [0, 1.2, 2.4, 3.4, 4.2] as const;
export const INTRO_DURATION: number = INTRO_BEATS[4];

/** Where the game's running camera sits; the intro track ends exactly here. */
export interface IntroHandover {
  height: number;
  back: number;
  lookAhead: number;
  lookHeight: number;
  fov: number;
}
export const INTRO_HANDOVER: IntroHandover = { height: 3.4, back: 6.2, lookAhead: 10, lookHeight: 1.2, fov: 62 };

const TRAIN_X = 3.9;
const TRAIN_LEN = 13;
/** Near end of the coach; it extends to +z from here. */
const TRAIN_Z0 = 3.2;
/** Outside face of the coach side panel. */
const WALL_X = TRAIN_X - 1.13;
const POSTER_Z = 7.2;
const POSTER_TOP_Y = 2.06;

const KID_PASTE = new THREE.Vector3(1.78, 0, 7.02);
const KID_ADMIRE = new THREE.Vector3(1.15, 0, 4.9);
const TT_START = new THREE.Vector3(0.75, 0, 12.6);
const TT_SPOT = new THREE.Vector3(0.75, 0, 10.3);
const TT_CHASE = new THREE.Vector3(1.1, 0, 3.2);

/** Camera keys, one per beat boundary. The last one is the handover. */
interface CamKey {
  t: number;
  pos: [number, number, number];
  look: [number, number, number];
  fov: number;
}
const CAM_KEYS: CamKey[] = [
  // beat 1: over his shoulder, the coach side filling frame
  { t: 0.0, pos: [-0.55, 1.95, 4.95], look: [2.2, 1.5, 6.9], fov: 46 },
  // beat 2 opens wide (a long lens from across the track) as he steps back and the sheet
  // rolls down; the camera stays clear of the -x side he walks into
  { t: 1.2, pos: [-3.4, 2.2, 4.3], look: [2.4, 1.6, 6.9], fov: 32 },
  { t: 1.6, pos: [-3.2, 2.15, 4.5], look: [2.5, 1.55, 6.95], fov: 32 },
  // ...then a hard push in on the finished bill, with him behind the lens
  { t: 2.05, pos: [0.6, 1.75, 6.5], look: [2.72, 1.5, 7.2], fov: 42 },
  // beat 3 pulls back to him admiring it, then the torch arrives
  { t: 2.4, pos: [-1.4, 2.1, 4.1], look: [2.1, 1.62, 6.7], fov: 48 },
  { t: 3.4, pos: [-2.1, 2.6, 4.3], look: [1.6, 1.8, 8.0], fov: 48 },
  { t: 4.2, pos: [0, INTRO_HANDOVER.height, INTRO_HANDOVER.back], look: [0, INTRO_HANDOVER.lookHeight, -INTRO_HANDOVER.lookAhead], fov: INTRO_HANDOVER.fov },
];

/** Rig sub-step, so a seek reproduces the animation state. */
/**
 * When the brush hits the wall: the moments paste is thrown off it, and the moments the sequence
 * makes a noise. Exported so the app layer can put a sound on each stroke without guessing.
 */
export const INTRO_BRUSH_STROKES: readonly number[] = Object.freeze([0.16, 0.42, 0.66, 0.9, 1.1]);

const RIG_STEP = 1 / 60;
const MAX_RIG_STEPS = 12;
const SPLATS = 26;

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0..1 ramp over [a, b]. */
const ramp = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
/** Overshoots past 1 and settles — used for the poster snapping flat and the "OY!" pop. */
const backOut = (x: number) => 1 + 2.1 * Math.pow(x - 1, 3) + 1.1 * Math.pow(x - 1, 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Small props, built here because nothing else in the kit needs them
// ---------------------------------------------------------------------------

interface Owned {
  dispose(): void;
}

/** A tin of maida paste. Origin at its base. */
function buildBucket(own: Owned[]): THREE.Group {
  const g = new THREE.Group();
  const tin = new THREE.CylinderGeometry(0.15, 0.12, 0.26, 12, 1, true);
  tin.translate(0, 0.13, 0);
  const paste = new THREE.CircleGeometry(0.135, 12);
  paste.rotateX(-Math.PI / 2);
  paste.translate(0, 0.21, 0);
  const handle = new THREE.TorusGeometry(0.15, 0.011, 4, 12, Math.PI);
  handle.rotateY(Math.PI / 2);
  handle.translate(0, 0.25, 0);
  own.push(tin, paste, handle);
  const tinMat = toonMaterial({ color: 0x8e9aa3, side: THREE.DoubleSide });
  const pasteMat = toonMaterial({ color: 0xe8dfc4 });
  const wireMat = toonMaterial({ color: 0x3c4249 });
  own.push(tinMat, pasteMat, wireMat);
  g.add(new THREE.Mesh(tin, tinMat), new THREE.Mesh(paste, pasteMat), new THREE.Mesh(handle, wireMat));
  g.name = 'paste-tin';
  return g;
}

/** The TT's torch, held in his right hand (origin at the grip, lens down its -y). */
function buildTorch(own: Owned[]): THREE.Group {
  const g = new THREE.Group();
  const barrel = new THREE.CylinderGeometry(0.026, 0.032, 0.18, 10);
  barrel.translate(0, -0.09, 0);
  const head = new THREE.CylinderGeometry(0.055, 0.034, 0.07, 12);
  head.translate(0, -0.21, 0);
  const lens = new THREE.CircleGeometry(0.05, 12);
  lens.rotateX(Math.PI / 2);
  lens.translate(0, -0.245, 0);
  own.push(barrel, head, lens);
  const shell = toonMaterial({ color: 0x2c3138 });
  const chrome = toonMaterial({ color: 0xaeb6bd });
  const glass = toonMaterial({ color: 0xfff6d2, emissive: 0xffe89a, emissiveIntensity: 2.4 });
  own.push(shell, chrome, glass);
  g.add(new THREE.Mesh(barrel, shell), new THREE.Mesh(head, chrome), new THREE.Mesh(lens, glass));
  g.name = 'torch';
  return g;
}

/** A pasting brush, held in the kid's right hand (origin at the grip). */
function buildBrush(own: Owned[]): THREE.Group {
  const g = new THREE.Group();
  const grip = new THREE.CylinderGeometry(0.021, 0.026, 0.27, 8);
  grip.translate(0, 0.045, 0);
  const head = new THREE.BoxGeometry(0.06, 0.04, 0.17);
  head.translate(0, -0.13, 0);
  const bristles = new THREE.BoxGeometry(0.05, 0.12, 0.16);
  bristles.translate(0, -0.21, 0);
  own.push(grip, head, bristles);
  const wood = toonMaterial({ color: 0xa5703c });
  const ferrule = toonMaterial({ color: 0x9aa4ac });
  const hair = toonMaterial({ color: 0xd9c79a });
  own.push(wood, ferrule, hair);
  g.add(new THREE.Mesh(grip, wood), new THREE.Mesh(head, ferrule), new THREE.Mesh(bristles, hair));
  g.name = 'brush';
  return g;
}

/** Soft radial blob, for the torch's hot spot and its glow. */
function glowTexture(): THREE.Texture {
  return canvasTexture('intro-glow', 128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,248,215,1)');
    g.addColorStop(0.35, 'rgba(255,232,160,0.55)');
    g.addColorStop(1, 'rgba(255,220,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** The TT's shout: a comic burst reading "OY!". */
function shoutTexture(): THREE.Texture {
  return canvasTexture('intro-shout', 512, 384, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h * 0.46;
    ctx.beginPath();
    const spikes = 13;
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = (i % 2 === 0 ? 1 : 0.72) * (i % 4 === 0 ? 1.04 : 0.98);
      const x = cx + Math.cos(a) * w * 0.46 * r;
      const y = cy + Math.sin(a) * h * 0.44 * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 16;
    ctx.strokeStyle = '#141414';
    ctx.stroke();
    ctx.fillStyle = '#FFD400';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 190px "Arial Black", Impact, "Ubuntu", "DejaVu Sans", sans-serif';
    ctx.lineWidth = 26;
    ctx.strokeStyle = '#141414';
    ctx.strokeText('OY!', cx, cy + 6);
    ctx.fillStyle = '#E8433A';
    ctx.fillText('OY!', cx, cy + 6);
    // tail toward the speaker
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.1, cy + h * 0.38);
    ctx.lineTo(cx + w * 0.02, cy + h * 0.38);
    ctx.lineTo(cx - w * 0.05, h * 0.99);
    ctx.closePath();
    ctx.lineWidth = 16;
    ctx.strokeStyle = '#141414';
    ctx.stroke();
    ctx.fillStyle = '#FFD400';
    ctx.fill();
  });
}

/** Flecks of paste thrown off the brush. One instanced mesh, positions solved from t. */
interface Splat {
  t0: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  size: number;
  life: number;
}

function makeSplats(rand: () => number, bursts: readonly number[]): Splat[] {
  const out: Splat[] = [];
  for (let i = 0; i < SPLATS; i++) {
    const t0 = bursts[i % bursts.length] + rand() * 0.05;
    const up = 0.9 + rand() * 1.9;
    out.push({
      t0,
      p: new THREE.Vector3(WALL_X - 0.04, 1.2 + rand() * 0.7, POSTER_Z + (rand() - 0.5) * 0.7),
      v: new THREE.Vector3(-0.7 - rand() * 1.5, up, (rand() - 0.5) * 1.4),
      size: 0.016 + rand() * 0.026,
      life: 0.55 + rand() * 0.45,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bone overrides: the rigs' actions cover running, not pasting a bill, so beats 1–3
// add a little rotation on top of the idle pose after the rig has written it.
// ---------------------------------------------------------------------------

const ARM_BONES = ['chest', 'head', 'shoulderR', 'upperArmR', 'forearmR', 'handR', 'upperArmL', 'forearmL'] as const;
type ArmBone = (typeof ARM_BONES)[number];

function boneMap(rig: CharacterRig): Record<ArmBone, THREE.Object3D | null> {
  const out = {} as Record<ArmBone, THREE.Object3D | null>;
  for (const name of ARM_BONES) out[name] = rig.root.getObjectByName(name) ?? null;
  return out;
}

function addRot(b: THREE.Object3D | null, x: number, y: number, z: number): void {
  if (!b) return;
  b.rotation.x += x;
  b.rotation.y += y;
  b.rotation.z += z;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IntroOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Picks the poster variant and the scatter of the paste. */
  seed?: number;
  /** Where the camera must end up. Defaults to the game's running camera. */
  handover?: IntroHandover;
  /** Force a poster variant (otherwise chosen from the seed). */
  variant?: number;
}

export interface IntroSequence {
  /** Advance; returns true while still playing. */
  update(dt: number): boolean;
  /** Jump straight to the end (skip). Safe at any beat. */
  skip(): void;
  /** Remove everything; the world must be exactly as it was. */
  dispose(): void;
  /** Place everything at an absolute time. `update` and `skip` both go through this. */
  seek(t: number): void;
  readonly done: boolean;
  readonly time: number;
  readonly duration: number;
  /** The beat being shown, 1..4. */
  readonly beat: number;
  /** Everything the intro added to the scene. */
  readonly root: THREE.Group;
  readonly posterVariant: number;
}

export function createIntro(o: IntroOptions): IntroSequence {
  const { scene, camera } = o;
  const seed = o.seed ?? 1;
  const rand = seededRandom(seed * 2654435761);
  const variant = ((o.variant ?? Math.floor(rand() * POSTER_VARIANTS)) % POSTER_VARIANTS + POSTER_VARIANTS) % POSTER_VARIANTS;
  const handover = o.handover ?? INTRO_HANDOVER;
  const keys = CAM_KEYS.map((k, i) =>
    i === CAM_KEYS.length - 1
      ? { ...k, pos: [0, handover.height, handover.back] as [number, number, number], look: [0, handover.lookHeight, -handover.lookAhead] as [number, number, number], fov: handover.fov }
      : k,
  );

  const own: Owned[] = [];
  const root = new THREE.Group();
  root.name = 'intro';

  // ---- the parked local
  // buildTrain draws entirely on module caches (coach geometries, liveries, materials),
  // so the intro owns nothing here: removing the group is the whole teardown.
  const train = buildTrain(TRAIN_LEN, { livery: variant === 1 ? 'central' : 'western', seed: 40 + seed });
  train.position.set(TRAIN_X, 0, TRAIN_Z0 + TRAIN_LEN);
  root.add(train);

  // ---- the old bill, and the new one over it
  const ad = buildFadedAd(seed);
  own.push(ad.geometry);
  ad.position.set(WALL_X - 0.012, POSTER_TOP_Y - POSTER_H * 0.47, POSTER_Z + 0.06);
  ad.rotation.y = -Math.PI / 2;
  root.add(ad);

  const poster: Poster = buildPoster(variant);
  poster.root.position.set(WALL_X - 0.02, POSTER_TOP_Y, POSTER_Z);
  poster.root.rotation.y = -Math.PI / 2;
  root.add(poster.root);
  own.push(poster);

  // ---- the kid and the TT
  const kid = createRunner();
  kid.root.position.copy(KID_PASTE);
  kid.root.rotation.y = -Math.PI / 2; // facing the coach side (+x)
  root.add(kid.root);
  const kidBones = boneMap(kid);

  const tt = createInspector();
  tt.root.position.copy(TT_START);
  tt.root.rotation.y = 0; // rigs face -z at 0; he walks down the platform toward the kid
  tt.root.visible = false;
  root.add(tt.root);
  const ttBones = boneMap(tt);

  // ---- tin and brush
  const bucket = buildBucket(own);
  bucket.position.set(WALL_X - 0.42, 0, POSTER_Z - 0.65);
  root.add(bucket);

  // The brush is driven along the coach side rather than parented to the hand bone: the
  // hand's own axes bury a held prop inside the sleeve at this arm angle.
  const brush = buildBrush(own);
  root.add(brush);

  const torch = buildTorch(own);
  torch.rotation.x = -0.35;
  (tt.root.getObjectByName('handR') ?? tt.root).add(torch);

  // ---- paste flecks
  const splats = makeSplats(rand, INTRO_BRUSH_STROKES);
  const splatGeo = new THREE.IcosahedronGeometry(1, 0);
  const splatMat = toonMaterial({ color: 0xece2c6 });
  own.push(splatGeo, splatMat);
  const splatMesh = new THREE.InstancedMesh(splatGeo, splatMat, SPLATS);
  splatMesh.name = 'paste-splatter';
  splatMesh.frustumCulled = false;
  splatMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(splatMesh);

  // ---- torch: a beam cone plus the hot spot it throws on the coach
  const beamH = 6;
  const beamGeo = new THREE.ConeGeometry(0.3, beamH, 14, 1, true);
  beamGeo.translate(0, -beamH / 2, 0);
  beamGeo.rotateX(-Math.PI / 2);
  const beamMat = basicMaterial({ color: 0xfff0bc, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  own.push(beamGeo, beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = 'torch-beam';
  beam.frustumCulled = false;
  beam.visible = false;
  root.add(beam);

  const spotGeo = new THREE.PlaneGeometry(2.4, 2.4);
  const spotMat = basicMaterial({ map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  own.push(spotGeo, spotMat);
  const spot = new THREE.Mesh(spotGeo, spotMat);
  spot.name = 'torch-spot';
  spot.rotation.y = -Math.PI / 2;
  spot.visible = false;
  root.add(spot);

  // ---- the shout
  const shoutGeo = new THREE.PlaneGeometry(2.2, 1.65);
  const shoutMat = basicMaterial({ map: shoutTexture(), transparent: true, opacity: 1, depthWrite: false, depthTest: false });
  own.push(shoutGeo, shoutMat);
  const shout = new THREE.Mesh(shoutGeo, shoutMat);
  shout.name = 'shout';
  shout.renderOrder = 10;
  shout.visible = false;
  root.add(shout);

  scene.add(root);

  // -------------------------------------------------------------------------
  // Per-frame scratch (nothing is allocated while playing)
  // -------------------------------------------------------------------------
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const _kid = new THREE.Vector3();
  const _tt = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _hand = new THREE.Vector3();
  const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
  const IDENT = new THREE.Quaternion();

  let time = 0;
  let rigTime = 0;
  let disposed = false;

  /** Where the kid is at time t (he only moves in beats 2 and 4). */
  function kidAt(t: number, out: THREE.Vector3): void {
    const step = smooth(ramp(t, 1.15, 1.8));
    out.lerpVectors(KID_PASTE, KID_ADMIRE, step);
    const bolt = ramp(t, INTRO_BEATS[3], INTRO_DURATION);
    if (bolt > 0) {
      const k = Math.pow(bolt, 1.3);
      out.x = lerp(out.x, 0, k);
      out.z = lerp(out.z, 0, k);
    }
  }

  function ttAt(t: number, out: THREE.Vector3): void {
    const walk = smooth(ramp(t, 2.42, 3.1));
    out.lerpVectors(TT_START, TT_SPOT, walk);
    const chase = Math.pow(ramp(t, 3.25, INTRO_DURATION), 1.15);
    if (chase > 0) out.lerp(TT_CHASE, chase);
  }

  function camera_at(t: number): void {
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const u = smooth(clamp01((t - a.t) / (b.t - a.t)));
    _pos.set(lerp(a.pos[0], b.pos[0], u), lerp(a.pos[1], b.pos[1], u), lerp(a.pos[2], b.pos[2], u));
    _look.set(lerp(a.look[0], b.look[0], u), lerp(a.look[1], b.look[1], u), lerp(a.look[2], b.look[2], u));
    // Beat 4 whips around the kid before releasing to the handover aim.
    if (t > INTRO_BEATS[3]) {
      const w = ramp(t, INTRO_BEATS[3], INTRO_DURATION);
      const arc = Math.sin(w * Math.PI);
      _pos.x -= arc * 0.6;
      kidAt(t, _target);
      _target.y += 1.35;
      _look.lerp(_target, Math.pow(1 - w, 1.6) * 0.95);
    }
    camera.position.copy(_pos);
    camera.lookAt(_look);
    const fov = lerp(a.fov, b.fov, u);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Beats 1–3 pose the arms on top of the rig's idle; beat 4 leaves the run alone. */
  function poseKid(t: number): void {
    if (t >= INTRO_BEATS[3]) return;
    const slap = ramp(t, 0.0, 0.18);
    // brush sweeps: a fast diagonal wipe, four of them through beats 1 and 2
    const phase = (t - 0.2) * 3.4;
    const sweep = Math.sin(phase) * ramp(t, 0.18, 0.35) * (1 - ramp(t, 1.15, 1.5));
    const reach = lerp(0.35, 1, slap) * (1 - ramp(t, 1.2, 1.75));
    // A bone points down its own -y; +rx swings it forward (his local -z, i.e. the wall)
    // and +rz swings it sideways, so the sweep is a diagonal wipe in both.
    addRot(kidBones.upperArmR, 1.62 * reach + 0.3 * sweep, 0, 0.32 * sweep);
    addRot(kidBones.forearmR, 0.75 * reach - 0.25 * sweep, 0, 0);
    // left hand steadies the sheet, then drops
    const steady = reach * (1 - ramp(t, 0.9, 1.3));
    addRot(kidBones.upperArmL, 1.6 * steady, 0, -0.25 * steady);
    addRot(kidBones.forearmL, 0.45 * steady, 0, 0);
    // wiping his hands on his shorts while he admires it
    const wipe = ramp(t, 1.8, 2.05) * (1 - ramp(t, 2.1, 2.35));
    addRot(kidBones.upperArmR, 0.45 * wipe + 0.3 * wipe * Math.sin(t * 17), 0, 0);
    // lean into the wall, then back to take the whole bill in
    const lean = 0.2 * reach - 0.16 * ramp(t, 1.75, 2.1);
    addRot(kidBones.chest, -lean, 0, 0);
    addRot(kidBones.head, lean * 0.5 - 0.14 * ramp(t, 1.75, 2.1), 0, 0);
  }

  /** The brush sweeps the wall in time with his arm, then rests in the tin. */
  function placeBrush(t: number): void {
    brush.visible = t < INTRO_BEATS[3];
    if (!brush.visible) return;
    const sweep = Math.sin((t - 0.2) * 3.4) * ramp(t, 0.16, 0.34);
    const down = smooth(ramp(t, 1.25, 1.75));
    const wx = lerp(WALL_X - 0.3, bucket.position.x, down);
    const wy = lerp(1.54 + 0.24 * sweep, 0.34, down);
    const wz = lerp(KID_PASTE.z - 0.3 + 0.24 * sweep, bucket.position.z, down);
    brush.position.set(wx, wy, wz);
    brush.rotation.set(0, 0, lerp(-1.15 + 0.32 * sweep, -0.35, down));
  }

  function poseTT(t: number): void {
    if (t >= 3.5) return;
    // torch arm out, level, and a shout
    const up = ramp(t, 2.42, 2.62);
    addRot(ttBones.upperArmR, 1.5 * up, 0, -0.3 * up);
    addRot(ttBones.forearmR, 0.2 * up, 0, 0);
    addRot(ttBones.chest, -0.12 * up, 0, 0);
  }

  function place(t: number): void {
    // ---- poster
    const unfurl = t < INTRO_BEATS[1] ? lerp(0.05, 0.24, easeOut(ramp(t, 0.05, 1.15))) : lerp(0.24, 1, backOut(ramp(t, INTRO_BEATS[1], 2.0)));
    const flap = smooth(ramp(t, 2.55, 3.15)) * (1 - 0.3 * ramp(t, 3.8, INTRO_DURATION));
    poster.shape({ unfurl: Math.min(1, unfurl), flap, time: t });

    // ---- kid
    kidAt(t, _kid);
    kid.root.position.copy(_kid);
    // beats 1-2 face the wall; beat 3 snaps around toward the TT; beat 4 turns and runs
    const snap = backOut(ramp(t, 2.8, 3.08));
    const turn = smooth(ramp(t, INTRO_BEATS[3], 3.62));
    kid.root.rotation.y = lerp(lerp(-Math.PI / 2, -Math.PI, Math.min(1.08, snap)), -Math.PI * 2, turn);

    // ---- TT
    ttAt(t, _tt);
    tt.root.position.copy(_tt);
    tt.root.visible = t >= INTRO_BEATS[2];

    // ---- paste flecks
    for (let i = 0; i < SPLATS; i++) {
      const s = splats[i];
      const dt = t - s.t0;
      if (dt < 0 || dt > s.life || t > INTRO_BEATS[2]) {
        _m.compose(s.p, IDENT, ZERO_SCALE);
      } else {
        _p.copy(s.v).multiplyScalar(dt).add(s.p);
        _p.y -= 4.6 * dt * dt;
        const k = s.size * (1 - 0.5 * (dt / s.life));
        _m.compose(_p, IDENT, _s.set(k, k, k));
      }
      splatMesh.setMatrixAt(i, _m);
    }
    splatMesh.instanceMatrix.needsUpdate = true;
    splatMesh.visible = t <= INTRO_BEATS[2];

    // ---- torch
    const lit = ramp(t, 2.42, 2.62) * (1 - ramp(t, 4.0, INTRO_DURATION));
    beam.visible = lit > 0;
    spot.visible = lit > 0;
    if (lit > 0) {
      tt.root.updateMatrixWorld(true);
      torch.getWorldPosition(_hand);
      // sweep along the coach, find the poster, then stay on the kid
      const sweepU = smooth(ramp(t, 2.42, 2.74));
      _target.set(WALL_X, lerp(2.6, POSTER_TOP_Y - POSTER_H * 0.5, sweepU), lerp(TT_SPOT.z - 1.2, POSTER_Z, sweepU));
      const onKid = smooth(ramp(t, 2.84, 3.12));
      if (onKid > 0) {
        _p.copy(_kid);
        _p.y += 1.1;
        _target.lerp(_p, onKid);
      }
      beam.position.copy(_hand);
      beam.lookAt(_target);
      const len = _hand.distanceTo(_target);
      beam.scale.set(1, 1, Math.max(0.2, len / beamH));
      beamMat.opacity = 0.22 * lit;
      spot.position.copy(_target);
      spot.position.x = Math.min(_target.x, WALL_X - 0.03);
      if (onKid > 0.5) spot.position.copy(_target).setX(WALL_X - 0.03);
      spotMat.opacity = 0.95 * lit * (1 - 0.45 * onKid);
      const pulse = 1 + 0.06 * Math.sin(t * 22);
      spot.scale.set(pulse, pulse, 1);
    }

    // ---- the shout
    const shoutK = backOut(ramp(t, 2.72, 2.95)) * (1 - ramp(t, 3.3, 3.55));
    shout.visible = shoutK > 0.02;
    if (shout.visible) {
      shout.position.copy(_tt);
      shout.position.y = 3.15;
      shout.position.x += 0.5;
      shout.quaternion.copy(camera.quaternion);
      shout.scale.set(shoutK, shoutK, 1);
      shoutMat.opacity = clamp01(shoutK * 1.4);
    }

    camera_at(t);
  }

  /** Steps the rigs to `t` in fixed sub-steps, then lays the pose overrides on top. */
  function driveRigs(t: number): void {
    if (t < rigTime) rigTime = t; // a backward seek just resumes from here
    // A big jump (a skip) only simulates the last few frames, but it simulates them at the
    // actions the TARGET time calls for, so a skip lands in the same pose as playing on.
    rigTime = Math.max(rigTime, t - MAX_RIG_STEPS * RIG_STEP);
    let steps = 0;
    while (rigTime < t - 1e-6 && steps < MAX_RIG_STEPS) {
      const dt = Math.min(RIG_STEP, t - rigTime);
      rigTime += dt;
      const running = rigTime >= INTRO_BEATS[3];
      kid.update(dt, { action: running ? 'run' : 'idle', speed: running ? 9 : 0, lean: 0 });
      tt.update(dt, { action: rigTime >= 3.3 ? 'run' : 'idle', speed: rigTime >= 3.3 ? 8 : 0, lean: 0 });
      steps++;
    }
    if (steps === 0) {
      kid.update(0, { action: t >= INTRO_BEATS[3] ? 'run' : 'idle', speed: t >= INTRO_BEATS[3] ? 9 : 0, lean: 0 });
      tt.update(0, { action: t >= 3.3 ? 'run' : 'idle', speed: t >= 3.3 ? 8 : 0, lean: 0 });
    }
    rigTime = t;
    poseKid(t);
    poseTT(t);
    placeBrush(t);
  }

  function seek(t: number): void {
    if (disposed) return;
    // Snap the last sliver so a played-through final frame is bit-identical to a skip:
    // several fades end exactly at the duration.
    time = t < 0 ? 0 : t > INTRO_DURATION - 1e-6 ? INTRO_DURATION : t;
    driveRigs(time);
    place(time);
  }

  seek(0);

  return {
    root,
    posterVariant: variant,
    duration: INTRO_DURATION,
    get time() {
      return time;
    },
    get done() {
      return time >= INTRO_DURATION;
    },
    get beat() {
      let b = 1;
      for (let i = 1; i < 4; i++) if (time >= INTRO_BEATS[i]) b = i + 1;
      return b;
    },
    seek,
    update(dt: number): boolean {
      if (disposed) return false;
      seek(time + (dt > 0 ? Math.min(dt, 0.1) : 0));
      return time < INTRO_DURATION;
    },
    skip(): void {
      seek(INTRO_DURATION);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      brush.removeFromParent();
      root.removeFromParent();
      root.clear();
      for (const d of own) d.dispose();
      own.length = 0;
    },
  };
}
