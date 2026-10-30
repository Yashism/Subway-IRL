import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addOutline, enableShadows, OUTLINE_INK, toonMaterial } from '../render/materials';
import { canvasTexture } from '../render/canvasTexture';

/**
 * Animated characters: the runner (a Mumbai street kid), the TT (ticket inspector)
 * and his street dog.
 *
 * Each character is ONE rigidly skinned mesh (every vertex follows exactly one bone)
 * plus one un-outlined "details" mesh for faces and decals, both sharing a bone
 * skeleton. That keeps a character at 3 draw calls (body, outline hull, details)
 * while the rig is still a plain hierarchy of pivots animated in code.
 *
 * Poses are flat Float32Arrays (7 channels per bone: rx ry rz, px py pz offset, scale).
 * Every frame the active action writes a target pose; on an action change the
 * current output is snapshotted and cross-faded into the new target over 0.1 s.
 * Nothing is allocated per frame.
 */

export type CharacterAction = 'idle' | 'run' | 'jump' | 'roll' | 'fall' | 'stumble' | 'caught' | 'hover' | 'fly';

export interface CharacterState {
  action: CharacterAction;
  /** Forward speed in m/s (drives the run-cycle playback rate). */
  speed: number;
  /** Lane-change direction, -1 (left) .. 1 (right). */
  lean: number;
  /** Normalised progress through the airborne phase of a jump, 0..1. */
  airborneT?: number;
}

export interface CharacterRig {
  root: THREE.Group;
  /** Advance the animation. speed is in m/s; lean runs -1..1 (lane change direction). */
  update(dt: number, state: CharacterState): void;
  /** Resolves when the rig's visuals are final (immediately for procedural rigs). */
  ready?: Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const CH = 7; // channels per bone
const FADE = 0.1; // cross-fade seconds
const OUTLINE_HUMAN = 0.02;
const OUTLINE_DOG = 0.012;
// addOutline caches its material by colour, so distinct (visually identical) colours
// keep our thicknesses independent of other modules' outlines.
const OUTLINE_COLOR_HUMAN = OUTLINE_INK;
const OUTLINE_COLOR_DOG = OUTLINE_INK;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Cycle rate multiplier: 0.85x at start speed (12 m/s) up to 1.4x at top speed (30 m/s). */
export function runPlaybackRate(speed: number): number {
  return 0.85 + 0.55 * clamp01((speed - 12) / 18);
}

// ---------------------------------------------------------------------------
// Texture atlas (one for all characters). Canvas top = v 1.
// ---------------------------------------------------------------------------

const ATLAS_W = 1024;
const ATLAS_H = 512;
type Rect = readonly [x: number, y: number, w: number, h: number];
const RECT_WHITE: Rect = [0, 0, 16, 16];
const RECT_HOODIE_BACK: Rect = [32, 0, 320, 192];
const RECT_BAG_TAG: Rect = [432, 0, 192, 128];
const RECT_TT_BADGE: Rect = [640, 0, 128, 64];
const RECT_CLIPBOARD: Rect = [784, 0, 176, 224];
const RECT_CAP_BADGE: Rect = [640, 80, 96, 96];

function drawAtlas(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

  // Hoodie back print: a graffiti crown tag over "MUMBAI", on the hoodie colour.
  {
    const [x, y, w, h] = RECT_HOODIE_BACK;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#FF5A36';
    ctx.fillRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    // crown
    ctx.save();
    ctx.translate(w / 2, 82);
    ctx.beginPath();
    ctx.moveTo(-86, 40);
    ctx.lineTo(-100, -40);
    ctx.lineTo(-50, 0);
    ctx.lineTo(0, -62);
    ctx.lineTo(50, 0);
    ctx.lineTo(100, -40);
    ctx.lineTo(86, 40);
    ctx.closePath();
    ctx.lineWidth = 18;
    ctx.strokeStyle = '#141414';
    ctx.stroke();
    ctx.fillStyle = '#FFD400';
    ctx.fill();
    ctx.fillStyle = '#E5399B';
    for (const [cx, cy] of [[-100, -40], [0, -62], [100, -40]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 13, 0, TAU);
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.fill();
    }
    ctx.fillStyle = '#29C7E0';
    ctx.fillRect(-70, 14, 140, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(-62, -8, 20, 30);
    ctx.restore();
    // drips
    ctx.fillStyle = '#FFD400';
    for (const dx of [-60, 10, 48]) ctx.fillRect(w / 2 + dx, 118, 8, 14 + ((dx + 70) % 17));
    ctx.font = '900 34px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#141414';
    ctx.strokeText('MUMBAI', w / 2, 162);
    ctx.fillStyle = '#F4F4F4';
    ctx.fillText('MUMBAI', w / 2, 162);
    ctx.restore();
  }

  // Backpack pocket tag: "22" in a spray bubble.
  {
    const [x, y, w, h] = RECT_BAG_TAG;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#8E5FD1';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#29C7E0';
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.4, h * 0.36, 0.1, 0, TAU);
    ctx.fill();
    ctx.font = '900 76px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#141414';
    ctx.strokeText('22', w / 2, h / 2 + 4);
    ctx.fillStyle = '#FFD400';
    ctx.fillText('22', w / 2, h / 2 + 4);
    ctx.fillStyle = '#FFD400';
    ctx.fillRect(0, h - 10, w, 10);
    ctx.restore();
  }

  // TT badge: brass plate with "TT".
  {
    const [x, y, w, h] = RECT_TT_BADGE;
    ctx.save();
    ctx.translate(x, y);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#FFE58A');
    g.addColorStop(1, '#C9921F');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#7A5410';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
    ctx.fillStyle = '#3B2A08';
    ctx.font = '900 46px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TT', w / 2, h / 2 + 2);
    ctx.restore();
  }

  // Cap badge: gold wheel emblem on navy.
  {
    const [x, y, w, h] = RECT_CAP_BADGE;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.fillStyle = '#1B2238';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#F2C53D';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * 30, Math.sin(a) * 30);
      ctx.stroke();
    }
    ctx.fillStyle = '#F2C53D';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Clipboard sheet: ticket-check form.
  {
    const [x, y, w, h] = RECT_CLIPBOARD;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#FBFAF4';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#C0392B';
    ctx.fillRect(0, 0, w, 34);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FINE ₹500', w / 2, 25);
    ctx.fillStyle = '#5B6B82';
    for (let r = 0; r < 8; r++) {
      const yy = 52 + r * 20;
      ctx.fillRect(14, yy, 18, 10);
      ctx.fillRect(40, yy + 3, w - 60 - (r * 17) % 50, 4);
    }
    ctx.strokeStyle = '#1F4FA3';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(30, h - 22);
    ctx.bezierCurveTo(60, h - 50, 80, h - 5, 110, h - 30);
    ctx.bezierCurveTo(125, h - 40, 140, h - 18, 155, h - 26);
    ctx.stroke();
    ctx.restore();
  }
}

let atlasTex: THREE.Texture | null | undefined;
function atlas(): THREE.Texture | null {
  if (atlasTex !== undefined) return atlasTex;
  atlasTex = typeof document === 'undefined' ? null : canvasTexture('characters-atlas', ATLAS_W, ATLAS_H, (ctx) => drawAtlas(ctx));
  return atlasTex;
}

let sharedMaterial: THREE.MeshToonMaterial | null = null;
function characterMaterial(): THREE.MeshToonMaterial {
  if (!sharedMaterial) sharedMaterial = toonMaterial({ vertexColors: true, map: atlas() });
  return sharedMaterial;
}

// ---------------------------------------------------------------------------
// Skeleton + geometry builder
// ---------------------------------------------------------------------------

interface BoneDef {
  name: string;
  parent: number; // -1 = attached to the root group
  pos: readonly [number, number, number];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Build-time transform helper: translate, rotate (XYZ euler), scale. */
function T(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

interface AddOptions {
  /** Put the part in the un-outlined details mesh. */
  detail?: boolean;
  /** Atlas rectangle for the part's UVs (default: a white texel). */
  rect?: Rect;
}

class PartBuilder {
  readonly body: THREE.BufferGeometry[] = [];
  readonly detail: THREE.BufferGeometry[] = [];
  private readonly color = new THREE.Color();

  constructor(private readonly boneWorld: THREE.Matrix4[]) {}

  add(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, bone: number, local: THREE.Matrix4, o: AddOptions = {}): void {
    const g = src.index ? src : src.setIndex([...Array(src.attributes.position.count).keys()]);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    g.clearGroups();
    g.applyMatrix4(_m.multiplyMatrices(this.boneWorld[bone], local));
    const n = g.attributes.position.count;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const r = o.rect ?? RECT_WHITE;
    for (let i = 0; i < n; i++) {
      const u = o.rect ? uv.getX(i) : 0.5;
      const v = o.rect ? uv.getY(i) : 0.5;
      uv.setXY(i, (r[0] + u * r[2]) / ATLAS_W, 1 - (r[1] + (1 - v) * r[3]) / ATLAS_H);
    }
    this.color.set(color);
    const col = new Float32Array(n * 3);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = this.color.r;
      col[i * 3 + 1] = this.color.g;
      col[i * 3 + 2] = this.color.b;
      si[i * 4] = bone;
      sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    (o.detail ? this.detail : this.body).push(g);
  }
}

// Geometry primitives (created per add at build time only; the merged result is cached).
const sphere = (r: number, w?: number, h?: number) => {
  // Segment count scales with size unless given: tiny details stay cheap.
  const auto = r < 0.03 ? 6 : r < 0.075 ? 9 : 12;
  return new THREE.SphereGeometry(r, w ?? auto, h ?? Math.max(4, Math.round((auto * 3) / 4)));
};
const hemi = (r: number, theta = Math.PI / 2, w = 16, h = 8) => new THREE.SphereGeometry(r, w, h, 0, TAU, 0, theta);
const capsule = (r: number, len: number, radial = 10) => new THREE.CapsuleGeometry(r, len, 3, radial);
const rbox = (w: number, h: number, d: number, r: number, seg = 1) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r: number, h: number, seg = 10) => new THREE.ConeGeometry(r, h, seg);
const torus = (r: number, tube: number, arc = TAU, seg = 16) => new THREE.TorusGeometry(r, tube, 6, seg, arc);
/** A plane bent around the y axis (for decals on rounded surfaces). Faces +z. */
function curvedPlane(w: number, h: number, bend: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 8, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (w / 2);
    p.setZ(i, -bend * x * x);
  }
  g.computeVertexNormals();
  return g;
}

interface BuiltCharacter {
  body: THREE.BufferGeometry;
  detail: THREE.BufferGeometry | null;
}

function makeSkeleton(defs: readonly BoneDef[]): { bones: THREE.Bone[]; top: THREE.Bone[]; world: THREE.Matrix4[] } {
  const bones = defs.map((d) => {
    const b = new THREE.Bone();
    b.name = d.name;
    b.position.set(d.pos[0], d.pos[1], d.pos[2]);
    return b;
  });
  const top: THREE.Bone[] = [];
  defs.forEach((d, i) => (d.parent < 0 ? top.push(bones[i]) : bones[d.parent].add(bones[i])));
  for (const b of top) b.updateMatrixWorld(true);
  return { bones, top, world: bones.map((b) => b.matrixWorld.clone()) };
}

const builtCache = new Map<string, BuiltCharacter>();

function buildCharacter(key: string, defs: readonly BoneDef[], parts: (b: PartBuilder) => void): BuiltCharacter {
  const hit = builtCache.get(key);
  if (hit) return hit;
  const { world } = makeSkeleton(defs);
  const pb = new PartBuilder(world);
  parts(pb);
  const built: BuiltCharacter = {
    body: mergeGeometries(pb.body)!,
    detail: pb.detail.length ? mergeGeometries(pb.detail)! : null,
  };
  built.body.computeBoundingSphere();
  builtCache.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------
// Rig runtime
// ---------------------------------------------------------------------------

type PoseFn = (p: Float32Array, rig: PoseRig, state: CharacterState) => void;

class PoseRig implements CharacterRig {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[];
  private readonly bind: Float32Array;
  private readonly cur: Float32Array;
  private readonly from: Float32Array;
  private readonly target: Float32Array;
  private action: CharacterAction | null = null;
  /** Seconds since the current action started. */
  actionT = 0;
  /** Seconds since the rig was created. */
  time = 0;
  /** Run/gallop cycle phase (radians), advanced by the pose functions. */
  phase = 0;
  /** Roll tumble angle (radians), unwrapped; applied on top of the blended pose. */
  spin = 0;
  /** Clamped frame dt, for the pose functions. */
  dt = 0;
  private fade = FADE;
  private leanS = 0;
  readonly ready = Promise.resolve();

  constructor(
    defs: readonly BoneDef[],
    built: BuiltCharacter,
    outline: { thickness: number; color: number },
    private readonly poses: Record<CharacterAction, PoseFn>,
    private readonly bank: { rootBone: number; twistBone: number; spinBone: number; amount: number },
  ) {
    const { bones, top } = makeSkeleton(defs);
    this.bones = bones;
    for (const b of top) this.root.add(b);
    const n = bones.length;
    this.bind = new Float32Array(n * 3);
    bones.forEach((b, i) => b.position.toArray(this.bind, i * 3));
    this.cur = new Float32Array(n * CH);
    this.from = new Float32Array(n * CH);
    this.target = new Float32Array(n * CH);
    for (let i = 0; i < n; i++) this.cur[i * CH + 6] = this.from[i * CH + 6] = 1;

    const skeleton = new THREE.Skeleton(bones);
    this.root.updateMatrixWorld(true);
    const body = new THREE.SkinnedMesh(built.body, characterMaterial());
    body.name = 'body';
    this.root.add(body);
    body.bind(skeleton);
    addOutline(body, outline.thickness, outline.color);
    if (built.detail) {
      const detail = new THREE.SkinnedMesh(built.detail, characterMaterial());
      detail.name = 'details';
      detail.userData.noOutline = true;
      this.root.add(detail);
      detail.bind(skeleton, body.bindMatrix);
    }
    enableShadows(this.root, true, false);
    // Skinned bounds follow the pose, so never cull from the stale bind-pose sphere.
    this.root.traverse((o) => (o.frustumCulled = false));
  }

  update(dt: number, state: CharacterState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this.dt = dt;
    this.time += dt;
    if (state.action !== this.action) {
      this.from.set(this.cur);
      this.fade = this.action === null ? FADE : 0;
      this.action = state.action;
      this.actionT = 0;
    } else {
      this.actionT += dt;
    }
    this.fade += dt;

    const t = this.target;
    t.fill(0);
    const n = this.bones.length;
    for (let i = 0; i < n; i++) t[i * CH + 6] = 1;
    (this.poses[state.action] ?? this.poses.run)(t, this, state);

    // Finish an interrupted roll tumble quickly instead of unwinding it.
    if (state.action !== 'roll' && this.spin !== 0) {
      const rest = Math.ceil(this.spin / TAU - 1e-6) * TAU;
      this.spin = Math.min(rest, this.spin + dt * TAU * 3);
      if (this.spin >= rest - 1e-6) this.spin = 0;
    }

    const w = smooth(0, FADE, this.fade);
    const c = this.cur;
    const f = this.from;
    for (let i = 0, l = n * CH; i < l; i++) c[i] = f[i] + (t[i] - f[i]) * w;

    this.leanS += (clampLean(state.lean) - this.leanS) * (1 - Math.exp(-dt / 0.05));
    const bind = this.bind;
    for (let i = 0; i < n; i++) {
      const b = this.bones[i];
      const o = i * CH;
      b.rotation.set(c[o], c[o + 1], c[o + 2]);
      b.position.set(bind[i * 3] + c[o + 3], bind[i * 3 + 1] + c[o + 4], bind[i * 3 + 2] + c[o + 5]);
      b.scale.setScalar(c[o + 6]);
    }
    const bank = this.bank;
    const amt = state.action === 'hover' ? bank.amount * 1.2 : bank.amount;
    this.bones[bank.rootBone].rotation.z -= this.leanS * amt;
    this.bones[bank.twistBone].rotation.y -= this.leanS * 0.17;
    this.bones[bank.spinBone].rotation.x -= this.spin;
  }
}

function clampLean(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x || 0;
}

// Channel writers.
function rot(p: Float32Array, b: number, x: number, y: number, z: number): void {
  const o = b * CH;
  p[o] = x;
  p[o + 1] = y;
  p[o + 2] = z;
}
function add(p: Float32Array, b: number, x: number, y: number, z: number): void {
  const o = b * CH;
  p[o] += x;
  p[o + 1] += y;
  p[o + 2] += z;
}
function off(p: Float32Array, b: number, x: number, y: number, z: number): void {
  const o = b * CH;
  p[o + 3] = x;
  p[o + 4] = y;
  p[o + 5] = z;
}
function scl(p: Float32Array, b: number, s: number): void {
  p[b * CH + 6] = s;
}
/** Mirrored limb rotation: rz > 0 is outward (abduction) on both sides, ry mirrored too. */
function limb(p: Float32Array, b: number, side: number, x: number, y: number, z: number): void {
  rot(p, b, x, side * y, side * z);
}

// ---------------------------------------------------------------------------
// Humanoid (runner + TT)
// ---------------------------------------------------------------------------

const H = {
  root: 0,
  pivot: 1,
  hips: 2,
  spine: 3,
  chest: 4,
  neck: 5,
  head: 6,
  shoulderL: 7,
  upperArmL: 8,
  forearmL: 9,
  handL: 10,
  shoulderR: 11,
  upperArmR: 12,
  forearmR: 13,
  handR: 14,
  thighL: 15,
  shinL: 16,
  footL: 17,
  thighR: 18,
  shinR: 19,
  footR: 20,
} as const;

interface HumanDims {
  pivotY: number;
  hipsY: number; // above pivot
  spine: number;
  chest: number;
  neck: number;
  head: number;
  shoulderX: number;
  shoulderY: number;
  upperArm: number;
  forearm: number;
  hipX: number;
  thigh: number;
  shin: number;
}

function humanBones(d: HumanDims): BoneDef[] {
  const defs: BoneDef[] = [
    { name: 'root', parent: -1, pos: [0, 0, 0] },
    { name: 'pivot', parent: H.root, pos: [0, d.pivotY, 0] },
    { name: 'hips', parent: H.pivot, pos: [0, d.hipsY, 0] },
    { name: 'spine', parent: H.hips, pos: [0, d.spine, 0] },
    { name: 'chest', parent: H.spine, pos: [0, d.chest, 0] },
    { name: 'neck', parent: H.chest, pos: [0, d.neck, 0] },
    { name: 'head', parent: H.neck, pos: [0, d.head, 0] },
  ];
  for (const s of [-1, 1]) {
    const tag = s < 0 ? 'L' : 'R';
    const sh = defs.length;
    defs.push(
      { name: `shoulder${tag}`, parent: H.chest, pos: [s * d.shoulderX, d.shoulderY, 0] },
      { name: `upperArm${tag}`, parent: sh, pos: [s * 0.05, 0, 0] },
      { name: `forearm${tag}`, parent: sh + 1, pos: [0, -d.upperArm, 0] },
      { name: `hand${tag}`, parent: sh + 2, pos: [0, -d.forearm, 0] },
    );
  }
  for (const s of [-1, 1]) {
    const tag = s < 0 ? 'L' : 'R';
    const th = defs.length;
    defs.push(
      { name: `thigh${tag}`, parent: H.hips, pos: [s * d.hipX, -0.04, 0] },
      { name: `shin${tag}`, parent: th, pos: [0, -d.thigh, 0] },
      { name: `foot${tag}`, parent: th + 1, pos: [0, -d.shin, 0] },
    );
  }
  return defs;
}

interface HumanStyle {
  heavy: number; // 0 = runner kid, 1 = TT
  /** Pose the left arm around a held clipboard instead of swinging it. */
  clipboard: boolean;
}

function humanPoses(style: HumanStyle): Record<CharacterAction, PoseFn> {
  const hv = style.heavy;

  const arms = (p: Float32Array, side: number, rx: number, rz: number, elbow: number) => {
    limb(p, side < 0 ? H.upperArmL : H.upperArmR, side, rx, 0, rz);
    limb(p, side < 0 ? H.forearmL : H.forearmR, side, elbow, 0, 0);
  };
  const clipboardArm = (p: Float32Array, bob: number) => {
    limb(p, H.upperArmL, -1, 0.3 + bob, 0.15, 0.12);
    limb(p, H.forearmL, -1, 1.75, 0.55, 0);
    limb(p, H.handL, -1, 0.1, -0.5, 0.25);
  };

  const run: PoseFn = (p, rig, s) => {
    const rate = runPlaybackRate(s.speed) * (hv ? 0.82 : 1);
    const cycleHz = 2.35 * rate;
    rig.phase = (rig.phase + TAU * cycleHz * lastDt(rig)) % (TAU * 64);
    writeRun(p, rig.phase, s.speed, 1);
  };

  const writeRun = (p: Float32Array, ph: number, speed: number, amp: number) => {
    const k = clamp01((speed - 10) / 20);
    const legAmp = (0.72 - hv * 0.22) * amp;
    for (const side of [-1, 1]) {
      const lp = ph + (side < 0 ? Math.PI : 0);
      const sn = Math.sin(lp);
      const thigh = side < 0 ? H.thighL : H.thighR;
      const shin = side < 0 ? H.shinL : H.shinR;
      const foot = side < 0 ? H.footL : H.footR;
      limb(p, thigh, side, 0.12 + legAmp * sn, 0, 0.04 + hv * 0.05);
      const flex = Math.pow(0.5 + 0.5 * Math.cos(lp + 0.3), 2.2);
      limb(p, shin, side, -(0.2 + (1.6 - hv * 0.7) * flex * amp), 0, 0);
      limb(p, foot, side, 0.1 + 0.35 * Math.sin(lp - 0.9) * amp, 0, 0);
      if (style.clipboard && side < 0) continue;
      const armSwing = (0.95 - hv * 0.25) * amp;
      arms(p, side, -armSwing * sn + 0.1, 0.14 + hv * 0.08, 1.35 + 0.3 * Math.max(0, sn) - hv * 0.35);
      limb(p, side < 0 ? H.handL : H.handR, side, 0.15, 0, 0);
    }
    const bob = Math.abs(Math.cos(ph - 0.5));
    off(p, H.hips, 0, -0.035 - hv * 0.02 + (0.055 + hv * 0.03) * bob * amp, 0);
    rot(p, H.hips, 0, 0.14 * Math.sin(ph) * amp, (0.05 + hv * 0.07) * Math.cos(ph) * amp);
    rot(p, H.spine, -0.12 - 0.06 * k + hv * 0.06, -0.08 * Math.sin(ph) * amp, 0);
    rot(p, H.chest, -0.1 - 0.04 * bob, -0.16 * Math.sin(ph) * amp, -0.03 * Math.cos(ph) * amp);
    rot(p, H.neck, 0.1, 0.05 * Math.sin(ph) * amp, 0);
    rot(p, H.head, 0.1 + 0.02 * k - 0.05 * bob, 0.06 * Math.sin(ph) * amp, 0);
    if (style.clipboard) clipboardArm(p, 0.08 * bob);
  };

  const idle: PoseFn = (p, rig) => {
    const t = rig.time;
    const breathe = Math.sin(t * 2.1);
    const look = Math.max(-1, Math.min(1, 1.7 * Math.sin(t * 0.55)));
    rot(p, H.chest, 0.03 * breathe, 0, 0);
    off(p, H.shoulderL, 0, 0.008 * breathe, 0);
    off(p, H.shoulderR, 0, 0.008 * breathe, 0);
    rot(p, H.neck, 0, 0.2 * look, 0);
    rot(p, H.head, 0.04 * Math.sin(t * 0.8), 0.35 * look, 0.05 * look);
    off(p, H.hips, 0.015 * Math.sin(t * 0.9), -0.01, 0);
    rot(p, H.hips, 0, 0, 0.03 * Math.sin(t * 0.9));
    rot(p, H.spine, hv * 0.06, 0, -0.02 * Math.sin(t * 0.9));
    limb(p, H.thighL, -1, 0.05, 0.1, 0.07);
    limb(p, H.thighR, 1, -0.03, 0.1, 0.05);
    limb(p, H.shinL, -1, -0.08, 0, 0);
    arms(p, 1, 0.08, 0.14 + hv * 0.1, 0.35);
    if (style.clipboard) {
      clipboardArm(p, 0.02 * breathe);
    } else {
      // Rattle the spray can every few seconds.
      const shake = Math.pow(Math.max(0, Math.sin(t * 0.9)), 10);
      arms(p, -1, 0.08, 0.14, 0.3);
      arms(p, 1, 0.35 * shake + 0.08, 0.14, 0.35 + 1.1 * shake + 0.35 * shake * Math.sin(t * 30));
    }
  };

  const jump: PoseFn = (p, rig, s) => {
    const a = s.airborneT ?? clamp01(rig.actionT / 0.6);
    const tuck = smooth(0.04, 0.3, a) * (1 - smooth(0.68, 0.95, a));
    const land = smooth(0.7, 1, a);
    const ext = 1 - smooth(0, 0.18, a);
    limb(p, H.thighR, 1, lerp(-0.1, 1.95 - hv * 0.5, tuck) + 0.35 * land, 0, 0.06);
    limb(p, H.thighL, -1, lerp(-0.45, 1.35 - hv * 0.4, tuck) + 0.2 * land, 0, 0.08);
    limb(p, H.shinR, 1, -(0.25 + (2.0 - hv * 0.6) * tuck + 0.35 * land), 0, 0);
    limb(p, H.shinL, -1, -(0.5 + (1.8 - hv * 0.6) * tuck + 0.25 * land), 0, 0);
    limb(p, H.footR, 1, -0.4 * ext + 0.2 * tuck, 0, 0);
    limb(p, H.footL, -1, -0.4 * ext + 0.2 * tuck, 0, 0);
    const armUp = ext;
    arms(p, 1, lerp(0.6, -0.5, tuck) + 1.6 * armUp, 0.55 + 0.5 * tuck + 0.3 * land, 0.9 - 0.4 * armUp);
    if (style.clipboard) clipboardArm(p, -0.2 * tuck);
    else arms(p, -1, lerp(0.2, 0.9, tuck) + 1.2 * armUp, 0.6 + 0.6 * tuck + 0.3 * land, 0.8 - 0.3 * armUp);
    rot(p, H.pivot, -0.12 * tuck, 0.08 * tuck, 0);
    off(p, H.hips, 0, 0.05 * tuck, 0);
    rot(p, H.spine, -0.28 * tuck + 0.08 * ext, 0, 0);
    rot(p, H.chest, -0.12 * tuck, 0, 0);
    rot(p, H.head, 0.2 * tuck - 0.1 * ext, 0, 0);
  };

  const roll: PoseFn = (p, rig) => {
    const t = rig.actionT;
    // One fast forward tumble every 0.5 s while rolling.
    rig.spin += lastDt(rig) * (TAU / 0.5) * smooth(0, 0.06, t);
    const tuckIn = smooth(0, 0.08, t);
    off(p, H.pivot, 0, -0.05 * tuckIn, 0);
    scl(p, H.pivot, lerp(1, 0.84, tuckIn));
    off(p, H.hips, 0, -0.62, 0.26);
    rot(p, H.hips, 0.2, 0, 0);
    rot(p, H.spine, -1.0, 0, 0);
    rot(p, H.chest, -0.6, 0, 0);
    rot(p, H.neck, -0.4, 0, 0);
    rot(p, H.head, -0.55, 0, 0);
    for (const side of [-1, 1]) {
      limb(p, side < 0 ? H.thighL : H.thighR, side, 2.45, 0, 0.12);
      limb(p, side < 0 ? H.shinL : H.shinR, side, -2.55, 0, 0);
      limb(p, side < 0 ? H.footL : H.footR, side, 0.3, 0, 0);
      arms(p, side, 1.1, 0.12, 1.5);
    }
    if (style.clipboard) clipboardArm(p, 0.3);
  };

  const fall: PoseFn = (p, rig) => {
    const t = rig.time;
    for (const side of [-1, 1]) {
      const o = side < 0 ? 0 : 1.7;
      arms(p, side, 0.25 + 0.2 * Math.sin(t * 11 + o), 2.55 + 0.3 * Math.sin(t * 13 + o), 0.35 + 0.25 * Math.sin(t * 9 + o));
      limb(p, side < 0 ? H.thighL : H.thighR, side, 0.5 + 0.55 * Math.sin(t * 9 + o * 1.8), 0, 0.15);
      limb(p, side < 0 ? H.shinL : H.shinR, side, -0.9 - 0.45 * Math.cos(t * 9 + o * 1.8), 0, 0);
    }
    if (style.clipboard) clipboardArm(p, 0.8);
    rot(p, H.spine, 0.18, 0, 0);
    rot(p, H.chest, 0.08, 0, 0.05 * Math.sin(t * 7));
    rot(p, H.head, -0.25, 0, 0);
  };

  const stumble: PoseFn = (p, rig, s) => {
    const t = rig.actionT;
    rig.phase = (rig.phase + TAU * 2.35 * runPlaybackRate(s.speed * 0.7) * lastDt(rig)) % (TAU * 64);
    const e = t < 0.36 ? Math.sin(Math.PI * (t / 0.36)) : 0;
    writeRun(p, rig.phase, s.speed * 0.7, 1 - 0.6 * e);
    const lurch = Math.sin(TAU * clamp01(t / 0.36));
    add(p, H.pivot, 0.12 * e, 0, 0.22 * Math.sin(t * 28) * e);
    add(p, H.spine, -0.35 * lurch * e, 0, 0);
    add(p, H.chest, 0.25 * e, 0.3 * e, 0);
    add(p, H.head, 0.3 * e, 0, 0);
    off(p, H.hips, 0, -0.1 * e, 0);
    for (const side of [-1, 1]) {
      if (style.clipboard && side < 0) continue;
      add(p, side < 0 ? H.upperArmL : H.upperArmR, -0.6 * e, 0, side * (1.5 + 0.5 * Math.sin(t * 30 + side)) * e);
      add(p, side < 0 ? H.forearmL : H.forearmR, -0.6 * e, 0, 0);
    }
  };

  const caught: PoseFn = (p, rig) => {
    const t = rig.actionT;
    const tt = rig.time;
    if (hv) {
      // TT: lunge and grab the collar.
      const u = smooth(0, 0.25, t);
      limb(p, H.upperArmR, 1, lerp(0.2, 1.75, u) + 0.05 * Math.sin(tt * 5), -0.3, -0.15);
      limb(p, H.forearmR, 1, 0.2, 0, 0);
      limb(p, H.handR, 1, 0.6, 0, 0);
      limb(p, H.upperArmL, -1, 0.5, 0, 0.55 + 0.1 * Math.sin(tt * 3));
      limb(p, H.forearmL, -1, 1.2, 0.5, 0);
      rot(p, H.spine, -0.2 * u, 0, 0);
      rot(p, H.chest, -0.15 * u + 0.03 * Math.sin(tt * 2.2), 0.15 * u, 0);
      rot(p, H.head, 0.2 * u, 0, 0.08 * Math.sin(tt * 1.3));
      limb(p, H.thighR, 1, 0.55 * u, 0, 0.1);
      limb(p, H.shinR, 1, -0.5 * u, 0, 0);
      limb(p, H.thighL, -1, -0.35 * u, 0, 0.12);
      limb(p, H.shinL, -1, -0.2 * u, 0, 0);
      off(p, H.hips, 0, -0.07 * u, 0);
      return;
    }
    // Runner: yanked up by the collar, arms up, legs dangling, then held.
    const u = smooth(0, 0.3, t);
    const pop = Math.sin(Math.PI * clamp01(t / 0.4));
    off(p, H.root, 0, 0.32 * u + 0.12 * pop, 0);
    rot(p, H.pivot, 0.05 * Math.sin(tt * 2.8), 0, 0.07 * Math.sin(tt * 2.1));
    const kick = 0.3 + 0.7 * Math.exp(-t * 1.5);
    for (const side of [-1, 1]) {
      const o = side < 0 ? 0 : 2.1;
      arms(p, side, 0.15, lerp(0.2, 2.75, u) + 0.12 * Math.sin(tt * 6 + o), 0.35);
      limb(p, side < 0 ? H.thighL : H.thighR, side, 0.15 + 0.35 * kick * Math.sin(tt * 7 + o), 0, 0.06);
      limb(p, side < 0 ? H.shinL : H.shinR, side, -0.35 - 0.3 * kick * Math.cos(tt * 7 + o), 0, 0);
      limb(p, side < 0 ? H.footL : H.footR, side, -0.55, 0, 0);
      off(p, side < 0 ? H.shoulderL : H.shoulderR, 0, 0.05 * u, 0);
    }
    rot(p, H.spine, 0.06, 0, 0);
    rot(p, H.neck, -0.15 * u, 0, 0);
    rot(p, H.head, -0.15 * u, 0.25 * Math.sin(tt * 1.2), 0);
  };

  const hover: PoseFn = (p, rig) => {
    const t = rig.time;
    off(p, H.root, 0, HOVER_LIFT + 0.03 * Math.sin(TAU * 1.0 * t), 0);
    off(p, H.hips, 0, -0.1, 0);
    rot(p, H.hips, 0, 0.55, 0);
    rot(p, H.spine, -0.1, -0.3, 0);
    rot(p, H.chest, -0.05, -0.15, 0.03 * Math.sin(t * 1.7));
    rot(p, H.head, 0.12, -0.12, 0);
    limb(p, H.thighL, -1, 0.5, 0, 0.1);
    limb(p, H.shinL, -1, -0.75, 0, 0);
    limb(p, H.footL, -1, 0.25, 0, -0.1);
    limb(p, H.thighR, 1, -0.28, 0, 0.1);
    limb(p, H.shinR, 1, -0.22, 0, 0);
    limb(p, H.footR, 1, 0.5, 0, -0.1);
    arms(p, 1, 0.1 + 0.1 * Math.sin(t * 2.2), 0.95 + 0.12 * Math.sin(t * 1.9 + 1), 0.45);
    if (style.clipboard) clipboardArm(p, 0);
    else arms(p, -1, 0.35 + 0.1 * Math.sin(t * 2), 0.85 + 0.12 * Math.sin(t * 1.9), 0.5);
  };

  const fly: PoseFn = (p, rig) => {
    const t = rig.time;
    rot(p, H.pivot, -0.32 + 0.03 * Math.sin(t * 2.3), 0, 0.06 * Math.sin(t * 3.1));
    off(p, H.pivot, 0, 0.05 * Math.sin(t * 2.2), 0);
    for (const side of [-1, 1]) {
      const o = side < 0 ? 0 : 1.9;
      limb(p, side < 0 ? H.thighL : H.thighR, side, -0.25 + 0.18 * Math.sin(t * 4.5 + o), 0, 0.1);
      limb(p, side < 0 ? H.shinL : H.shinR, side, -0.7 + 0.25 * Math.sin(t * 4.5 + o + 0.8), 0, 0);
      limb(p, side < 0 ? H.footL : H.footR, side, -0.5, 0, 0);
    }
    // Right fist punched forward, left hand gripping a strap.
    arms(p, 1, 2.75, 0.12, 0.15);
    limb(p, H.handR, 1, 0.2, 0, 0);
    if (style.clipboard) clipboardArm(p, 0);
    else arms(p, -1, 0.25, 0.3, 1.8);
    rot(p, H.spine, -0.08, 0, 0);
    rot(p, H.neck, 0.25, 0, 0);
    rot(p, H.head, 0.2, 0, 0);
  };

  return { idle, run, jump, roll, fall, stumble, caught, hover, fly };
}

function lastDt(rig: PoseRig): number {
  return rig.dt;
}

// ---------------------------------------------------------------------------
// Runner kid
// ---------------------------------------------------------------------------

/** Hover pose: the soles rest this high (the board's top surface is ~0.2 m up). */
export const HOVER_SOLE_HEIGHT = 0.2;
const HOVER_LIFT = 0.28;

const RUNNER_DIMS: HumanDims = {
  pivotY: 0.45,
  hipsY: 0.47,
  spine: 0.08,
  chest: 0.2,
  neck: 0.22,
  head: 0.07,
  shoulderX: 0.19,
  shoulderY: 0.16,
  upperArm: 0.25,
  forearm: 0.23,
  hipX: 0.1,
  thigh: 0.39,
  shin: 0.39,
};

const BASE_C = {
  skin: 0xb9774b,
  skinDark: 0x9a5d37,
  hair: 0x1d1512,
  hoodie: 0xff5a36,
  hoodieDark: 0xd8401f,
  accent: 0xffc93c,
  cap: 0x35d0e6,
  capDark: 0x1a6f9a,
  jeans: 0x3b5ea8,
  jeansDark: 0x2c4880,
  jeansLight: 0x6f8fcf,
  shoeUpper: 0xf4f4f4,
  shoeAccent: 0xe5399b,
  sole: 0xffc93c,
  bag: 0x8e5fd1,
  bagDark: 0x6a42a8,
  white: 0xffffff,
  black: 0x141414,
  can: 0x3fb27f,
  canCap: 0xe8433a,
};

const C = BASE_C;

/** A shop character's colour overrides: any subset of the runner's colour map. */
export type RunnerPalette = Readonly<Partial<Record<keyof typeof BASE_C, number>>>;

/** z of a point on the face sphere (front = -z). */
function faceZ(r: number, x: number, y: number, flat = 1): number {
  return -Math.sqrt(Math.max(0, r * r - x * x - y * y)) * flat;
}

function addFace(
  b: PartBuilder,
  head: number,
  cy: number,
  r: number,
  o: { brow: number; browTilt: number; eyeY: number; eyeX: number; eyeR: number; skin: number; mouthY: number },
): void {
  for (const s of [-1, 1]) {
    const ex = s * o.eyeX;
    const ez = faceZ(r, ex, o.eyeY);
    b.add(sphere(o.eyeR), C.white, head, T(ex, cy + o.eyeY, ez + 0.006, 0, s * 0.25, 0, 0.85, 1.15, 0.45), { detail: true });
    b.add(sphere(o.eyeR * 0.55), C.black, head, T(ex - s * 0.004, cy + o.eyeY - 0.004, ez - 0.005, 0, 0, 0, 1, 1.15, 0.5), { detail: true });
    b.add(sphere(o.eyeR * 0.18), C.white, head, T(ex - s * 0.004 + 0.008, cy + o.eyeY + 0.01, ez - 0.012), { detail: true });
    const by = o.brow;
    b.add(rbox(o.eyeR * 1.7, o.eyeR * 0.38, 0.02, 0.006), C.hair, head, T(ex, cy + by, faceZ(r, ex, by) + 0.004, -0.2, s * 0.25, -s * o.browTilt), { detail: true });
  }
  // Grin.
  b.add(torus(0.032, 0.007, Math.PI, 10), 0x5a2418, head, T(0, cy + o.mouthY + 0.012, faceZ(r, 0, o.mouthY) + 0.004, 0.25, 0, Math.PI, 1, 0.8, 1), { detail: true });
}

function runnerParts(b: PartBuilder, palette?: RunnerPalette): void {
  // A shop skin is the same kid in different clothes: the colour map is swapped for the build and
  // nothing else moves, so every hitbox, bone and pose is shared with the default runner.
  const C = palette ? { ...BASE_C, ...palette } : BASE_C;
  // --- Hips: jeans seat + hoodie hem.
  b.add(rbox(0.34, 0.2, 0.24, 0.08, 2), C.jeans, H.hips, T(0, -0.05, 0));
  b.add(rbox(0.36, 0.05, 0.26, 0.025), C.jeansDark, H.hips, T(0, 0.04, 0));
  // --- Spine: hoodie belly + kangaroo pocket.
  b.add(rbox(0.4, 0.22, 0.27, 0.1, 2), C.hoodie, H.spine, T(0, 0.08, 0));
  b.add(rbox(0.41, 0.06, 0.28, 0.03), C.hoodieDark, H.spine, T(0, -0.02, 0));
  b.add(rbox(0.26, 0.11, 0.03, 0.02), C.hoodieDark, H.spine, T(0, 0.07, -0.13));
  // --- Chest: hoodie torso, hood, strings, zipper, backpack.
  b.add(rbox(0.46, 0.3, 0.29, 0.12, 2), C.hoodie, H.chest, T(0, 0.08, 0));
  // Hood bunched around the neck (a thick roll, fuller at the back).
  b.add(torus(0.115, 0.05, TAU, 18), C.hoodieDark, H.chest, T(0, 0.245, 0.03, Math.PI / 2 - 0.2, 0, 0, 1.05, 1.15, 1));
  b.add(sphere(0.09), C.hoodie, H.chest, T(0, 0.25, 0.13, -0.3, 0, 0, 1.6, 0.55, 0.8));
  for (const s of [-1, 1]) {
    b.add(cyl(0.008, 0.008, 0.14, 5), C.accent, H.chest, T(s * 0.045, 0.1, -0.15), { detail: true });
    b.add(sphere(0.014), C.accent, H.chest, T(s * 0.045, 0.025, -0.15), { detail: true });
  }
  // Back print on the upper back, above a low-slung backpack.
  b.add(curvedPlane(0.27, 0.16, 0.03), C.white, H.chest, T(0, 0.11, 0.149), { detail: true, rect: RECT_HOODIE_BACK });
  // Backpack (worn low, on the lower back).
  b.add(rbox(0.3, 0.25, 0.14, 0.06, 2), C.bag, H.chest, T(0, -0.13, 0.2));
  b.add(rbox(0.31, 0.06, 0.15, 0.028), C.bagDark, H.chest, T(0, -0.02, 0.205, -0.1, 0, 0));
  b.add(rbox(0.22, 0.11, 0.05, 0.03), C.bagDark, H.chest, T(0, -0.16, 0.285));
  b.add(curvedPlane(0.19, 0.095, 0.0), C.white, H.chest, T(0, -0.155, 0.312), { detail: true, rect: RECT_BAG_TAG });
  for (const s of [-1, 1]) {
    // straps: down the back to the bag, over the shoulder, down the front
    b.add(rbox(0.045, 0.2, 0.025, 0.01), C.bagDark, H.chest, T(s * 0.165, 0.1, 0.15, -0.05, 0, 0));
    b.add(rbox(0.045, 0.025, 0.3, 0.01), C.bagDark, H.chest, T(s * 0.15, 0.225, 0.0));
    b.add(rbox(0.045, 0.24, 0.025, 0.01), C.bagDark, H.chest, T(s * 0.12, 0.1, -0.155, 0.1));
    b.add(rbox(0.02, 0.06, 0.02, 0.005), C.accent, H.chest, T(s * 0.13, -0.18, 0.28), { detail: true });
  }
  // --- Neck + head.
  b.add(cyl(0.06, 0.065, 0.12), C.skin, H.neck, T(0, 0.02, 0));
  const hr = 0.175;
  const hy = 0.13;
  b.add(sphere(hr, 18, 14), C.skin, H.head, T(0, hy, 0, 0, 0, 0, 1, 1.02, 0.98));
  b.add(sphere(0.07), C.skin, H.head, T(0, hy - 0.085, -0.07, 0, 0, 0, 1.45, 0.8, 1));
  for (const s of [-1, 1]) {
    b.add(sphere(0.042), C.skin, H.head, T(s * 0.178, hy - 0.005, 0.015, 0, 0, 0, 0.5, 0.95, 0.7));
  }
  b.add(sphere(0.022), C.skinDark, H.head, T(0, hy - 0.02, faceZ(hr, 0, -0.02) - 0.006, 0, 0, 0, 1.1, 0.85, 1));
  // Hair (under the cap): back and sides.
  b.add(hemi(hr + 0.008, 1.6, 18, 10), C.hair, H.head, T(0, hy + 0.01, 0.006, 0.85, 0, 0));
  for (const s of [-1, 1]) b.add(sphere(0.045), C.hair, H.head, T(s * 0.15, hy + 0.06, 0.03, 0, 0, 0, 0.5, 0.9, 1.1));
  // Backwards cap: crown, band, button, brim over the neck.
  b.add(hemi(hr + 0.02, 1.2, 18, 8), C.cap, H.head, T(0, hy + 0.03, 0.0, 0.12, 0, 0, 1, 1, 1.04));
  b.add(cyl(hr + 0.004, hr + 0.012, 0.035, 18), C.capDark, H.head, T(0, hy + 0.107, 0.012, 0.12, 0, 0, 1, 1, 1.04));
  b.add(sphere(0.022), C.accent, H.head, T(0, hy + 0.22, 0.026));
  // Brim sticking out over the nape: a half disc, yellow underside.
  b.add(new THREE.CylinderGeometry(0.15, 0.15, 0.022, 16, 1, false, -Math.PI / 2, Math.PI), C.capDark, H.head, T(0, hy + 0.105, 0.13, 0.22, 0, 0, 1.05, 1, 1.5));
  b.add(new THREE.CylinderGeometry(0.145, 0.145, 0.006, 16, 1, false, -Math.PI / 2, Math.PI), C.accent, H.head, T(0, hy + 0.091, 0.128, 0.22, 0, 0, 1.05, 1, 1.5), { detail: true });
  // snapback strap window above the forehead (the cap is on backwards)
  b.add(rbox(0.08, 0.035, 0.012, 0.005), C.skin, H.head, T(0, hy + 0.125, -0.155, -0.55, 0, 0), { detail: true });
  addFace(b, H.head, hy, hr, { brow: 0.083, browTilt: 0.18, eyeY: 0.03, eyeX: 0.066, eyeR: 0.036, skin: C.skin, mouthY: -0.075 });

  // --- Arms.
  for (const s of [-1, 1]) {
    const sh = s < 0 ? H.shoulderL : H.shoulderR;
    const ua = s < 0 ? H.upperArmL : H.upperArmR;
    const fa = s < 0 ? H.forearmL : H.forearmR;
    const hd = s < 0 ? H.handL : H.handR;
    b.add(sphere(0.095), C.hoodie, sh, T(s * 0.04, -0.01, 0));
    b.add(capsule(0.078, 0.16), C.hoodie, ua, T(0, -0.13, 0));
    b.add(capsule(0.066, 0.13), C.hoodie, fa, T(0, -0.1, 0));
    b.add(cyl(0.066, 0.066, 0.05, 14), C.accent, fa, T(0, -0.2, 0));
    b.add(sphere(0.068), C.skin, hd, T(0, -0.05, -0.005, 0, 0, 0, 0.85, 1.05, 1));
    b.add(sphere(0.026), C.skin, hd, T(s * -0.03, -0.03, -0.05, 0, 0, 0, 1, 1.4, 1));
  }
  // Spray can in the right hand.
  b.add(cyl(0.038, 0.038, 0.17, 12), C.can, H.handR, T(0, -0.05, -0.045));
  b.add(cyl(0.039, 0.039, 0.035, 12), C.white, H.handR, T(0, -0.1, -0.045));
  b.add(sphere(0.03), C.canCap, H.handR, T(0, 0.04, -0.045, 0, 0, 0, 1, 0.9, 1));
  b.add(cyl(0.008, 0.008, 0.02, 6), C.black, H.handR, T(0, 0.07, -0.045));

  // --- Legs.
  for (const s of [-1, 1]) {
    const th = s < 0 ? H.thighL : H.thighR;
    const sn = s < 0 ? H.shinL : H.shinR;
    const ft = s < 0 ? H.footL : H.footR;
    b.add(capsule(0.1, 0.24), C.jeans, th, T(0, -0.18, 0));
    b.add(capsule(0.083, 0.24), C.jeans, sn, T(0, -0.18, 0));
    b.add(cyl(0.095, 0.09, 0.07, 14), C.jeansLight, sn, T(0, -0.31, 0));
    // Big sneakers.
    b.add(rbox(0.165, 0.024, 0.345, 0.011), C.sole, ft, T(0, -0.088, -0.065));
    b.add(rbox(0.158, 0.05, 0.335, 0.024, 2), C.white, ft, T(0, -0.058, -0.065));
    b.add(rbox(0.145, 0.1, 0.27, 0.05, 2), C.shoeUpper, ft, T(0, -0.02, -0.045));
    b.add(sphere(0.075), C.shoeUpper, ft, T(0, -0.035, -0.17, 0, 0, 0, 0.95, 0.75, 1));
    b.add(rbox(0.09, 0.07, 0.1, 0.03), C.cap, ft, T(0, 0.03, 0.03));
    b.add(rbox(0.11, 0.05, 0.16, 0.02), C.shoeAccent, ft, T(0, 0.005, -0.08, 0.35, 0, 0), { detail: false });
    for (let i = 0; i < 3; i++) {
      b.add(rbox(0.07, 0.012, 0.018, 0.005), C.white, ft, T(0, 0.028 - i * 0.017, -0.035 - i * 0.04, 0.35, 0, 0), { detail: true });
    }
    b.add(rbox(0.006, 0.04, 0.16, 0.003), C.accent, ft, T(s * 0.074, -0.03, -0.04, -0.2, 0, 0), { detail: true });
  }
}

const RUNNER_BONES = humanBones(RUNNER_DIMS);

export interface CreateRunnerOptions {
  /** 'procedural' (default) or 'glb' (CC-BY Quaternius model, loaded async). */
  style?: 'procedural' | 'glb';
  /**
   * An equipped shop character (src/app/progression.ts): `id` keys the built-geometry cache, so
   * every skin is merged once and re-equipping one afterwards costs nothing.
   */
  skin?: { id: string; palette?: RunnerPalette } | null;
}

export function createRunner(opts: CreateRunnerOptions = {}): CharacterRig {
  if (opts.style === 'glb') return createGlbRig('runner');
  const skin = opts.skin ?? null;
  const palette = skin?.palette;
  return makeHumanRig(
    palette ? `runner:${skin!.id}` : 'runner',
    RUNNER_BONES,
    (b) => runnerParts(b, palette),
    { heavy: 0, clipboard: false },
  );
}

function makeHumanRig(key: string, defs: BoneDef[], parts: (b: PartBuilder) => void, style: HumanStyle): CharacterRig {
  const built = buildCharacter(key, defs, parts);
  const rig = new PoseRig(defs, built, { thickness: OUTLINE_HUMAN, color: OUTLINE_COLOR_HUMAN }, humanPoses(style), {
    rootBone: H.root,
    twistBone: H.chest,
    spinBone: H.pivot,
    amount: 0.3,
  });
  return finishRig(rig, key);
}

function finishRig(rig: PoseRig, name: string): CharacterRig {
  rig.root.name = name;
  rig.root.userData.rig = rig;
  return rig;
}

// ---------------------------------------------------------------------------
// TT (ticket inspector)
// ---------------------------------------------------------------------------

const TT_DIMS: HumanDims = {
  pivotY: 0.45,
  hipsY: 0.48,
  spine: 0.09,
  chest: 0.21,
  neck: 0.24,
  head: 0.06,
  shoulderX: 0.23,
  shoulderY: 0.17,
  upperArm: 0.27,
  forearm: 0.25,
  hipX: 0.12,
  thigh: 0.4,
  shin: 0.39,
};

const TC = {
  skin: 0xa0633c,
  skinDark: 0x80492a,
  coat: 0x262830,
  coatLight: 0x3d404b,
  shirt: 0xf3f1ea,
  trousers: 0x2a2d35,
  shoe: 0x141416,
  tie: 0x7a2e3a,
  cap: 0x1b2238,
  capBand: 0x10141f,
  gold: 0xf2c53d,
  moustache: 0x17110e,
  grey: 0x57524e,
  leather: 0x7a4a24,
  leatherDark: 0x5a3417,
  board: 0x8a5a2b,
  clip: 0xc7cdd1,
};

function inspectorParts(b: PartBuilder): void {
  // Hips: trousers + coat tails (open at the front).
  b.add(rbox(0.38, 0.22, 0.27, 0.09, 2), TC.trousers, H.hips, T(0, -0.05, 0));
  for (const s of [-1, 1]) b.add(rbox(0.225, 0.3, 0.06, 0.03), TC.coat, H.hips, T(s * 0.115, -0.1, 0.13, 0.08, s * 0.05, 0));
  b.add(rbox(0.3, 0.05, 0.03, 0.012), TC.coatLight, H.spine, T(0, 0.0, 0.16));
  for (const s of [-1, 1]) b.add(sphere(0.014), TC.gold, H.spine, T(s * 0.12, 0.0, 0.178), { detail: true });
  for (const s of [-1, 1]) {
    b.add(rbox(0.06, 0.3, 0.26, 0.03), TC.coat, H.hips, T(s * 0.21, -0.1, 0.0, 0, 0, s * 0.06));
    b.add(rbox(0.11, 0.28, 0.05, 0.02), TC.coat, H.hips, T(s * 0.16, -0.09, -0.13, -0.06, 0, 0));
  }
  b.add(rbox(0.36, 0.045, 0.28, 0.02), TC.shoe, H.hips, T(0, 0.045, 0));
  b.add(rbox(0.05, 0.035, 0.02, 0.006), TC.gold, H.hips, T(0, 0.045, -0.142), { detail: true });
  // Spine: shirt belly under an open coat.
  b.add(sphere(0.22), TC.shirt, H.spine, T(0, 0.08, -0.03, 0, 0, 0, 1, 0.8, 0.85));
  b.add(rbox(0.46, 0.26, 0.3, 0.1, 2), TC.coat, H.spine, T(0, 0.09, 0.02));
  // Chest: coat torso with lapels, shirt V and tie.
  b.add(rbox(0.54, 0.32, 0.32, 0.12, 2), TC.coat, H.chest, T(0, 0.08, 0));
  b.add(rbox(0.16, 0.32, 0.04, 0.02), TC.shirt, H.chest, T(0, 0.08, -0.15), { detail: false });
  b.add(rbox(0.05, 0.28, 0.02, 0.01), TC.tie, H.chest, T(0, 0.06, -0.172), { detail: true });
  b.add(sphere(0.03), TC.tie, H.chest, T(0, 0.2, -0.17, 0, 0, 0, 1, 0.8, 0.6), { detail: true });
  for (const s of [-1, 1]) {
    b.add(rbox(0.06, 0.28, 0.02, 0.008), TC.coatLight, H.chest, T(s * 0.095, 0.08, -0.155, 0, 0, s * 0.22));
    b.add(sphere(0.012), TC.gold, H.chest, T(s * 0.1, -0.02 - 0.0, -0.17), { detail: true });
  }
  b.add(sphere(0.012), TC.gold, H.spine, T(0.11, 0.08, -0.17), { detail: true });
  b.add(sphere(0.012), TC.gold, H.spine, T(-0.11, 0.08, -0.17), { detail: true });
  // TT badge on the left chest (his left = -x) and a pen in the pocket.
  b.add(new THREE.PlaneGeometry(0.1, 0.05), TC.shirt, H.chest, T(-0.16, 0.14, -0.168, 0, Math.PI, 0), { detail: true, rect: RECT_TT_BADGE });
  b.add(cyl(0.007, 0.007, 0.07, 6), 0x1f4fa3, H.chest, T(0.17, 0.12, -0.165), { detail: true });
  // Collar.
  b.add(torus(0.085, 0.03, TAU, 16), TC.shirt, H.chest, T(0, 0.23, 0, Math.PI / 2, 0, 0));
  b.add(torus(0.1, 0.035, TAU, 16), TC.coat, H.chest, T(0, 0.22, 0.02, Math.PI / 2 - 0.2, 0, 0));
  // Leather satchel strap across the back (right shoulder to left hip).
  b.add(rbox(0.05, 0.5, 0.025, 0.01), TC.leather, H.chest, T(0.0, 0.05, 0.165, 0.05, 0, -0.62));
  b.add(rbox(0.05, 0.03, 0.2, 0.01), TC.leather, H.chest, T(0.15, 0.235, 0.0));
  b.add(rbox(0.07, 0.24, 0.26, 0.04, 2), TC.leather, H.hips, T(-0.27, -0.05, 0.02));
  b.add(rbox(0.075, 0.1, 0.265, 0.03), TC.leatherDark, H.hips, T(-0.272, 0.02, 0.02));
  b.add(rbox(0.012, 0.03, 0.03, 0.005), TC.gold, H.hips, T(-0.31, -0.01, 0.02), { detail: true });
  // Back seam + vent detail.
  b.add(rbox(0.012, 0.3, 0.01, 0.004), TC.coatLight, H.chest, T(0, 0.06, 0.162), { detail: true });

  // Neck + head.
  b.add(cyl(0.07, 0.075, 0.12), TC.skin, H.neck, T(0, 0.02, 0));
  const hr = 0.165;
  const hy = 0.13;
  b.add(sphere(hr, 18, 14), TC.skin, H.head, T(0, hy, 0, 0, 0, 0, 1, 1.06, 1));
  b.add(sphere(0.1), TC.skin, H.head, T(0, hy - 0.09, -0.05, 0, 0, 0, 1.3, 0.8, 1.05));
  for (const s of [-1, 1]) {
    b.add(sphere(0.04), TC.skin, H.head, T(s * 0.163, hy, 0.01, 0, 0, 0, 0.45, 1, 0.7));
    // greying sideburns
    b.add(sphere(0.05), TC.grey, H.head, T(s * 0.14, hy + 0.03, 0.05, 0, 0, 0, 0.5, 0.9, 1));
    // bushy moustache
    b.add(capsule(0.024, 0.06, 8), TC.moustache, H.head, T(s * 0.038, hy - 0.055, faceZ(hr, 0.035, -0.05) - 0.02, 0, 0, s * 1.2), { detail: false });
  }
  b.add(hemi(hr + 0.008, 1.8, 18, 10), TC.grey, H.head, T(0, hy, 0.015, 0.85, 0, 0));
  b.add(sphere(0.036), TC.skinDark, H.head, T(0, hy - 0.015, faceZ(hr, 0, -0.015) - 0.012, 0, 0, 0, 1, 0.95, 1));
  // Peaked TT cap: band, flared crown, top, visor, badge.
  b.add(cyl(hr + 0.012, hr + 0.012, 0.06, 18), TC.capBand, H.head, T(0, hy + 0.1, 0, -0.08, 0, 0));
  b.add(cyl(hr + 0.045, hr + 0.012, 0.07, 18), TC.cap, H.head, T(0, hy + 0.16, 0.005, -0.1, 0, 0, 1, 1, 1.02));
  b.add(cyl(hr + 0.045, hr + 0.045, 0.015, 18), TC.cap, H.head, T(0, hy + 0.2, 0.01, -0.1, 0, 0, 1, 1, 1.02));
  b.add(cyl(0.12, 0.12, 0.018, 18, ), 0x0b0e16, H.head, T(0, hy + 0.075, -0.15, -0.3, 0, 0, 1, 1, 0.7));
  b.add(torus(hr + 0.014, 0.006, TAU, 24), TC.gold, H.head, T(0, hy + 0.1, 0, Math.PI / 2 - 0.08, 0, 0), { detail: true });
  b.add(new THREE.PlaneGeometry(0.07, 0.07), TC.shirt, H.head, T(0, hy + 0.16, -0.205, -0.1, Math.PI, 0), { detail: true, rect: RECT_CAP_BADGE });
  addFace(b, H.head, hy, hr, { brow: 0.075, browTilt: -0.22, eyeY: 0.02, eyeX: 0.062, eyeR: 0.03, skin: TC.skin, mouthY: -0.1 });

  // Arms.
  for (const s of [-1, 1]) {
    const sh = s < 0 ? H.shoulderL : H.shoulderR;
    const ua = s < 0 ? H.upperArmL : H.upperArmR;
    const fa = s < 0 ? H.forearmL : H.forearmR;
    const hd = s < 0 ? H.handL : H.handR;
    b.add(sphere(0.1), TC.coat, sh, T(s * 0.04, -0.01, 0, 0, 0, 0, 1.1, 0.9, 1));
    b.add(capsule(0.082, 0.18), TC.coat, ua, T(0, -0.14, 0));
    b.add(capsule(0.072, 0.15), TC.coat, fa, T(0, -0.1, 0));
    b.add(cyl(0.062, 0.062, 0.04, 12), TC.shirt, fa, T(0, -0.215, 0));
    b.add(sphere(0.07), TC.skin, hd, T(0, -0.055, 0, 0, 0, 0, 0.9, 1.05, 1.05));
    b.add(sphere(0.026), TC.skin, hd, T(s * -0.035, -0.03, -0.05, 0, 0, 0, 1, 1.4, 1));
  }
  // Clipboard in the left hand, face toward the hand's front.
  b.add(rbox(0.23, 0.3, 0.014, 0.012), TC.board, H.handL, T(0.02, -0.1, -0.075, 0, 0, 0));
  b.add(new THREE.PlaneGeometry(0.2, 0.25), TC.shirt, H.handL, T(0.02, -0.12, -0.084, 0, Math.PI, 0), { detail: true, rect: RECT_CLIPBOARD });
  b.add(rbox(0.09, 0.035, 0.02, 0.008), TC.clip, H.handL, T(0.02, 0.04, -0.086));
  b.add(new THREE.PlaneGeometry(0.2, 0.26), 0xe9e4d4, H.handL, T(0.02, -0.11, -0.066), { detail: true });

  // Legs.
  for (const s of [-1, 1]) {
    const th = s < 0 ? H.thighL : H.thighR;
    const sn = s < 0 ? H.shinL : H.shinR;
    const ft = s < 0 ? H.footL : H.footR;
    b.add(capsule(0.105, 0.25), TC.trousers, th, T(0, -0.19, 0));
    b.add(capsule(0.085, 0.25), TC.trousers, sn, T(0, -0.18, 0));
    b.add(cyl(0.09, 0.095, 0.06, 14), TC.trousers, sn, T(0, -0.33, 0));
    b.add(rbox(0.13, 0.03, 0.3, 0.012), 0x0a0a0a, ft, T(0, -0.085, -0.06));
    b.add(rbox(0.12, 0.08, 0.27, 0.04, 2), TC.shoe, ft, T(0, -0.04, -0.05));
    b.add(sphere(0.06), TC.shoe, ft, T(0, -0.045, -0.15, 0, 0, 0, 1, 0.7, 1.1));
    b.add(sphere(0.012), 0x9fa6b0, ft, T(0.02, -0.02, -0.19), { detail: true });
  }
}

const TT_BONES = humanBones(TT_DIMS);

export function createInspector(opts: CreateRunnerOptions = {}): CharacterRig {
  if (opts.style === 'glb') return createGlbRig('inspector');
  return makeHumanRig('inspector', TT_BONES, inspectorParts, { heavy: 1, clipboard: true });
}

// ---------------------------------------------------------------------------
// Street dog
// ---------------------------------------------------------------------------

const D = {
  root: 0,
  body: 1,
  chest: 2,
  pelvis: 3,
  neck: 4,
  head: 5,
  jaw: 6,
  frontUpperL: 7,
  frontLowerL: 8,
  frontPawL: 9,
  frontUpperR: 10,
  frontLowerR: 11,
  frontPawR: 12,
  rearUpperL: 13,
  rearLowerL: 14,
  rearPawL: 15,
  rearUpperR: 16,
  rearLowerR: 17,
  rearPawR: 18,
  tail1: 19,
  tail2: 20,
  tail3: 21,
} as const;

const DOG_BONES: BoneDef[] = (() => {
  const defs: BoneDef[] = [
    { name: 'root', parent: -1, pos: [0, 0, 0] },
    { name: 'body', parent: D.root, pos: [0, 0.34, 0] },
    { name: 'chest', parent: D.body, pos: [0, 0, -0.1] },
    { name: 'pelvis', parent: D.body, pos: [0, 0, 0.1] },
    { name: 'neck', parent: D.chest, pos: [0, 0.05, -0.1] },
    { name: 'head', parent: D.neck, pos: [0, 0.12, -0.05] },
    { name: 'jaw', parent: D.head, pos: [0, -0.03, -0.03] },
  ];
  for (const s of [-1, 1]) {
    const tag = s < 0 ? 'L' : 'R';
    const i = defs.length;
    defs.push(
      { name: `frontUpper${tag}`, parent: D.chest, pos: [s * 0.065, -0.04, -0.04] },
      { name: `frontLower${tag}`, parent: i, pos: [0, -0.14, 0] },
      { name: `frontPaw${tag}`, parent: i + 1, pos: [0, -0.12, 0] },
    );
  }
  for (const s of [-1, 1]) {
    const tag = s < 0 ? 'L' : 'R';
    const i = defs.length;
    defs.push(
      { name: `rearUpper${tag}`, parent: D.pelvis, pos: [s * 0.065, -0.01, 0.06] },
      { name: `rearLower${tag}`, parent: i, pos: [0, -0.14, 0] },
      { name: `rearPaw${tag}`, parent: i + 1, pos: [0, -0.12, 0] },
    );
  }
  defs.push(
    { name: 'tail1', parent: D.pelvis, pos: [0, 0.05, 0.13] },
    { name: 'tail2', parent: D.tail1, pos: [0, 0, 0.08] },
    { name: 'tail3', parent: D.tail2, pos: [0, 0, 0.07] },
  );
  return defs;
})();

const DC = {
  fur: 0xc99355,
  furDark: 0x9c6a36,
  cream: 0xf0dcb4,
  nose: 0x1c1512,
  pink: 0xe07a82,
  innerEar: 0xd9a58a,
  collar: 0xe8433a,
};

function dogParts(b: PartBuilder): void {
  // Torso: deep chest, tucked waist, lean rump.
  b.add(sphere(0.105), DC.fur, D.chest, T(0, 0.0, -0.01, 0, 0, 0, 0.9, 1.05, 1.35));
  b.add(sphere(0.08), DC.cream, D.chest, T(0, -0.045, -0.07, 0, 0, 0, 0.9, 1.1, 1));
  b.add(sphere(0.07), DC.furDark, D.chest, T(0, 0.055, 0.02, 0, 0, 0, 1, 0.5, 1.6));
  b.add(sphere(0.09), DC.fur, D.pelvis, T(0, 0.01, 0.02, 0, 0, 0, 0.9, 0.95, 1.35));
  b.add(sphere(0.06), DC.furDark, D.pelvis, T(0, 0.06, 0.0, 0, 0, 0, 1, 0.5, 1.6));
  b.add(sphere(0.06), DC.cream, D.pelvis, T(0, -0.05, -0.03, 0, 0, 0, 0.9, 0.8, 1.3));
  // Neck with a red rag collar.
  b.add(capsule(0.052, 0.09, 10), DC.fur, D.neck, T(0, 0.05, -0.02, -0.45, 0, 0));
  b.add(torus(0.05, 0.013, TAU, 14), DC.collar, D.neck, T(0, 0.04, -0.015, Math.PI / 2 - 0.45, 0, 0));
  b.add(sphere(0.045), DC.cream, D.neck, T(0, 0.02, -0.05, 0, 0, 0, 0.9, 1.2, 0.8));
  // Head: skull, muzzle, nose, ears.
  b.add(sphere(0.07), DC.fur, D.head, T(0, 0.02, 0, 0, 0, 0, 1, 0.95, 1.05));
  b.add(capsule(0.036, 0.06, 10), DC.cream, D.head, T(0, -0.005, -0.085, Math.PI / 2 - 0.12, 0, 0, 1, 1, 0.85));
  b.add(sphere(0.02), DC.nose, D.head, T(0, 0.012, -0.145, 0, 0, 0, 1.2, 0.9, 1));
  for (const s of [-1, 1]) {
    b.add(cone(0.035, 0.1, 8), DC.fur, D.head, T(s * 0.042, 0.1, 0.01, 0.15, 0, -s * 0.28, 1, 1, 0.55));
    b.add(cone(0.02, 0.06, 6), DC.innerEar, D.head, T(s * 0.042, 0.095, -0.004, 0.15, 0, -s * 0.28, 1, 1, 0.3), { detail: true });
    // eyes + brow dots
    b.add(sphere(0.014), DC.nose, D.head, T(s * 0.035, 0.035, -0.058), { detail: true });
    b.add(sphere(0.004), 0xffffff, D.head, T(s * 0.035 + 0.004, 0.04, -0.07), { detail: true });
    b.add(sphere(0.009), DC.cream, D.head, T(s * 0.032, 0.058, -0.056), { detail: true });
  }
  // Jaw + tongue.
  b.add(capsule(0.024, 0.05, 8), DC.cream, D.jaw, T(0, -0.005, -0.05, Math.PI / 2, 0, 0, 1, 0.8, 1));
  b.add(rbox(0.032, 0.008, 0.06, 0.004), DC.pink, D.jaw, T(0, 0.012, -0.06, 0.1, 0, 0), { detail: true });
  // Legs.
  for (const s of [-1, 1]) {
    const fu = s < 0 ? D.frontUpperL : D.frontUpperR;
    const fl = s < 0 ? D.frontLowerL : D.frontLowerR;
    const fp = s < 0 ? D.frontPawL : D.frontPawR;
    const ru = s < 0 ? D.rearUpperL : D.rearUpperR;
    const rl = s < 0 ? D.rearLowerL : D.rearLowerR;
    const rp = s < 0 ? D.rearPawL : D.rearPawR;
    b.add(capsule(0.032, 0.1, 8), DC.fur, fu, T(0, -0.06, 0));
    b.add(capsule(0.024, 0.1, 8), DC.fur, fl, T(0, -0.06, 0));
    b.add(sphere(0.028), DC.cream, fp, T(0, -0.02, -0.015, 0, 0, 0, 1, 0.75, 1.4));
    b.add(sphere(0.052), DC.fur, ru, T(0, -0.045, 0.0, 0, 0, 0, 0.7, 1.4, 1));
    b.add(capsule(0.022, 0.1, 8), DC.fur, rl, T(0, -0.06, 0));
    b.add(sphere(0.028), DC.cream, rp, T(0, -0.02, -0.015, 0, 0, 0, 1, 0.75, 1.4));
  }
  // Tail (curled; the last segment is cream-tipped).
  b.add(capsule(0.022, 0.06, 8), DC.fur, D.tail1, T(0, 0, 0.04, Math.PI / 2, 0, 0));
  b.add(capsule(0.024, 0.05, 8), DC.fur, D.tail2, T(0, 0, 0.035, Math.PI / 2, 0, 0));
  b.add(capsule(0.021, 0.05, 8), DC.cream, D.tail3, T(0, 0, 0.035, Math.PI / 2, 0, 0));
}

const IDLE_STATE: CharacterState = { action: 'idle', speed: 0, lean: 0 };

function dogPoses(): Record<CharacterAction, PoseFn> {
  const stand = (p: Float32Array) => {
    for (const s of [-1, 1]) {
      limb(p, s < 0 ? D.frontUpperL : D.frontUpperR, s, 0.05, 0, 0.02);
      limb(p, s < 0 ? D.frontLowerL : D.frontLowerR, s, -0.05, 0, 0);
      limb(p, s < 0 ? D.rearUpperL : D.rearUpperR, s, 0.35, 0, 0.02);
      limb(p, s < 0 ? D.rearLowerL : D.rearLowerR, s, -0.75, 0, 0);
      limb(p, s < 0 ? D.rearPawL : D.rearPawR, s, 0.4, 0, 0);
    }
    rot(p, D.tail1, -1.0, 0, 0);
    rot(p, D.tail2, -0.8, 0, 0);
    rot(p, D.tail3, -0.7, 0, 0);
    rot(p, D.neck, 0.05, 0, 0);
    rot(p, D.head, 0.1, 0, 0);
  };

  const gallop = (p: Float32Array, rig: PoseRig, s: CharacterState, amp: number) => {
    const hz = 2.9 * runPlaybackRate(s.speed);
    rig.phase = (rig.phase + TAU * hz * lastDt(rig)) % (TAU * 64);
    const ph = rig.phase;
    const lead = [0, 0.45];
    for (const side of [-1, 1]) {
      const i = side < 0 ? 0 : 1;
      const r = ph + lead[i];
      const f = ph + Math.PI - 0.5 + lead[i];
      limb(p, side < 0 ? D.rearUpperL : D.rearUpperR, side, 0.35 + 0.8 * Math.sin(r) * amp, 0, 0.03);
      limb(p, side < 0 ? D.rearLowerL : D.rearLowerR, side, -0.8 - 0.45 * Math.cos(r) * amp, 0, 0);
      limb(p, side < 0 ? D.rearPawL : D.rearPawR, side, 0.45 + 0.5 * Math.cos(r) * amp, 0, 0);
      limb(p, side < 0 ? D.frontUpperL : D.frontUpperR, side, 0.1 + 0.85 * Math.sin(f) * amp, 0, 0.03);
      limb(p, side < 0 ? D.frontLowerL : D.frontLowerR, side, -1.2 * Math.max(0, Math.cos(f + 0.6)) * amp, 0, 0);
      limb(p, side < 0 ? D.frontPawL : D.frontPawR, side, -0.5 * Math.max(0, Math.cos(f + 1.2)) * amp, 0, 0);
    }
    // Spine gathers and extends; one flight phase per stride.
    const flex = Math.sin(ph + 0.3);
    rot(p, D.body, 0.1 * Math.sin(ph - 0.6) * amp, 0, 0);
    off(p, D.body, 0, (0.035 * Math.sin(ph - 1.2) - 0.02) * amp, 0);
    rot(p, D.chest, 0.14 * flex * amp, 0, 0);
    rot(p, D.pelvis, -0.16 * flex * amp, 0, 0);
    off(p, D.chest, 0, 0, 0.02 * flex * amp);
    off(p, D.pelvis, 0, 0, -0.02 * flex * amp);
    rot(p, D.neck, -0.2 - 0.12 * Math.sin(ph - 0.6) * amp, 0, 0);
    rot(p, D.head, 0.25, 0, 0);
    rot(p, D.jaw, -0.3, 0, 0);
    rot(p, D.tail1, -0.45 + 0.15 * Math.sin(ph), 0.25 * Math.sin(ph * 0.5), 0);
    rot(p, D.tail2, -0.35, 0.2 * Math.sin(ph * 0.5 - 0.6), 0);
    rot(p, D.tail3, -0.3, 0.2 * Math.sin(ph * 0.5 - 1.2), 0);
  };

  const run: PoseFn = (p, rig, s) => gallop(p, rig, s, 1);

  const idle: PoseFn = (p, rig) => {
    const t = rig.time;
    stand(p);
    // Two barks every 1.8 s.
    const c = t % 1.8;
    const bark = Math.max(0, Math.sin(Math.PI * clamp01(c / 0.16))) + Math.max(0, Math.sin(Math.PI * clamp01((c - 0.26) / 0.16)));
    rot(p, D.neck, 0.05 - 0.12 * bark, 0, 0);
    rot(p, D.head, 0.1 + 0.35 * bark, 0, 0.04 * Math.sin(t * 0.7));
    rot(p, D.jaw, -0.55 * bark, 0, 0);
    off(p, D.body, 0, -0.012 * bark, 0.01 * bark);
    rot(p, D.chest, -0.05 * bark, 0, 0);
    const wag = Math.sin(t * 16);
    add(p, D.tail1, 0, 0.55 * wag, 0);
    add(p, D.tail2, 0, 0.3 * Math.sin(t * 16 - 0.8), 0);
    rot(p, D.body, 0, 0, 0.03 * wag);
  };

  const jump: PoseFn = (p, rig, s) => {
    const a = s.airborneT ?? clamp01(rig.actionT / 0.6);
    const stretch = Math.sin(Math.PI * a);
    rot(p, D.body, 0.25 - 0.5 * a, 0, 0);
    for (const side of [-1, 1]) {
      limb(p, side < 0 ? D.frontUpperL : D.frontUpperR, side, 0.6 + 0.6 * stretch, 0, 0.03);
      limb(p, side < 0 ? D.frontLowerL : D.frontLowerR, side, -0.6 * (1 - stretch), 0, 0);
      limb(p, side < 0 ? D.rearUpperL : D.rearUpperR, side, -0.4 - 0.5 * stretch, 0, 0.03);
      limb(p, side < 0 ? D.rearLowerL : D.rearLowerR, side, -0.3, 0, 0);
      limb(p, side < 0 ? D.rearPawL : D.rearPawR, side, -0.2, 0, 0);
    }
    rot(p, D.neck, -0.2, 0, 0);
    rot(p, D.head, 0.3, 0, 0);
    rot(p, D.jaw, -0.3, 0, 0);
    rot(p, D.tail1, -0.2, 0, 0);
  };

  const caught: PoseFn = (p, rig) => {
    // Excited bouncing and barking at the busted runner.
    idle(p, rig, IDLE_STATE);
    const hop = Math.abs(Math.sin(rig.time * 7));
    off(p, D.body, 0, 0.05 * hop, 0);
    add(p, D.body, -0.15 * hop, 0, 0);
    add(p, D.frontUpperL, 0.5 * hop, 0, 0);
    add(p, D.frontUpperR, 0.5 * hop, 0, 0);
  };

  const stumble: PoseFn = (p, rig, s) => {
    gallop(p, rig, s, 1);
    const e = rig.actionT < 0.35 ? Math.sin(Math.PI * rig.actionT / 0.35) : 0;
    add(p, D.body, 0.2 * e, 0, 0.2 * Math.sin(rig.actionT * 30) * e);
  };

  return { idle, run, jump, roll: run, fall: jump, stumble, caught, hover: run, fly: run };
}

export function createDog(opts: CreateRunnerOptions = {}): CharacterRig {
  if (opts.style === 'glb') return createGlbRig('dog');
  const built = buildCharacter('dog', DOG_BONES, dogParts);
  const rig = new PoseRig(DOG_BONES, built, { thickness: OUTLINE_DOG, color: OUTLINE_COLOR_DOG }, dogPoses(), {
    rootBone: D.root,
    twistBone: D.chest,
    spinBone: D.body,
    amount: 0.2,
  });
  return finishRig(rig, 'dog');
}

// ---------------------------------------------------------------------------
// Optional GLB path: CC0 / CC-BY Quaternius models (see public/models/CREDITS.md).
// The procedural rig is shown (and animated) until the GLB has loaded.
// ---------------------------------------------------------------------------

type GlbKind = 'runner' | 'inspector' | 'dog';

interface GlbSpec {
  url: string;
  height: number;
  /** Clip-name suffix per action, and how to time it. */
  clips: Record<CharacterAction, { name: string; mode: 'cycle' | 'once' | 'airborne' | 'loop'; seconds?: number }>;
  /** Material name -> tint (multiplies nothing: replaces the colour). */
  tints: Record<string, number>;
}

const GLB_SPECS: Record<GlbKind, GlbSpec> = {
  runner: {
    url: 'models/runner-quaternius.glb',
    height: 1.8,
    clips: {
      idle: { name: 'Idle_Loop', mode: 'loop' },
      run: { name: 'Sprint_Loop', mode: 'cycle' },
      jump: { name: 'Jump_Loop', mode: 'airborne' },
      roll: { name: 'Roll', mode: 'once', seconds: 0.6 },
      fall: { name: 'Jump_Loop', mode: 'loop' },
      stumble: { name: 'Hit_Chest', mode: 'once', seconds: 0.35 },
      caught: { name: 'Hit_Head', mode: 'once', seconds: 0.4 },
      hover: { name: 'Crouch_Idle_Loop', mode: 'loop' },
      fly: { name: 'Swim_Fwd_Loop', mode: 'loop' },
    },
    tints: { M_Main: C.hoodie, M_Joints: C.jeans },
  },
  inspector: {
    url: 'models/inspector-quaternius.glb',
    height: 1.85,
    clips: {
      idle: { name: 'Man_Idle', mode: 'loop' },
      run: { name: 'Man_Run', mode: 'cycle' },
      jump: { name: 'Man_Jump', mode: 'airborne' },
      roll: { name: 'Man_Jump', mode: 'once', seconds: 0.6 },
      fall: { name: 'Man_Death', mode: 'once' },
      stumble: { name: 'Man_Standing', mode: 'once', seconds: 0.35 },
      caught: { name: 'Man_Punch', mode: 'once' },
      hover: { name: 'Man_Standing', mode: 'loop' },
      fly: { name: 'Man_RunningJump', mode: 'loop' },
    },
    tints: { Shirt: TC.coat, Pants: TC.trousers, Skin: TC.skin, Hair: TC.grey, Details: TC.gold },
  },
  dog: {
    url: 'models/dog-quaternius.glb',
    height: 0.62,
    clips: {
      idle: { name: 'Idle', mode: 'loop' },
      run: { name: 'Run', mode: 'cycle' },
      jump: { name: 'Jump_Loop', mode: 'airborne' },
      roll: { name: 'Run', mode: 'cycle' },
      fall: { name: 'Jump_Loop', mode: 'loop' },
      stumble: { name: 'Run', mode: 'cycle' },
      caught: { name: 'Headbutt', mode: 'loop' },
      hover: { name: 'Run', mode: 'cycle' },
      fly: { name: 'Run', mode: 'cycle' },
    },
    tints: { AtlasMaterial: 0xffe2b8 },
  },
};

const OUTLINE_COLOR_GLB: Record<GlbKind, number> = { runner: OUTLINE_INK, inspector: OUTLINE_INK, dog: OUTLINE_INK };

class GlbRig implements CharacterRig {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<CharacterAction, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentAction: CharacterAction | null = null;
  private leanS = 0;
  private lift = 0;
  private baseY = 0;

  constructor(
    private readonly kind: GlbKind,
    private readonly fallback: CharacterRig,
  ) {
    this.root.name = `${kind}-glb`;
    this.root.add(fallback.root);
    this.ready = this.load().catch((err: unknown) => {
      console.warn(`[characters] ${kind} GLB failed, keeping the procedural rig`, err);
    });
  }

  private async load(): Promise<void> {
    const spec = GLB_SPECS[this.kind];
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const base = typeof import.meta.env !== 'undefined' ? import.meta.env.BASE_URL : '/';
    const gltf = await new GLTFLoader().loadAsync(base + spec.url);
    const model = gltf.scene;
    // glTF characters face +z; ours face -z.
    model.rotation.y = Math.PI;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const s = spec.height / Math.max(1e-6, box.max.y - box.min.y);
    model.scale.setScalar(s);
    model.position.y = this.baseY = -box.min.y * s;

    const mats = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material): THREE.Material => {
        let out = mats.get(m);
        if (!out) {
          const src = m as THREE.MeshStandardMaterial;
          const tint = spec.tints[src.name];
          out = toonMaterial({
            color: tint ?? src.color,
            map: src.map ?? null,
            vertexColors: !!mesh.geometry.attributes.color,
          });
          mats.set(m, out);
        }
        return out;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    // Skinned vertices live in armature units (often centimetres), so express the
    // outline thickness in geometry units: world thickness / (world size / geometry size).
    let geoSize = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const g = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      geoSize = Math.max(geoSize, g.x, g.y, g.z);
    });
    const worldSize = Math.max(...box.getSize(new THREE.Vector3()).multiplyScalar(s).toArray());
    const thickness = (this.kind === 'dog' ? OUTLINE_DOG : OUTLINE_HUMAN) * (geoSize / Math.max(1e-6, worldSize));
    // A distinct colour per kind keeps addOutline's per-colour material cache separate.
    addOutline(model, thickness, OUTLINE_COLOR_GLB[this.kind]);
    enableShadows(model, true, false);
    model.traverse((o) => (o.frustumCulled = false));

    const mixer = new THREE.AnimationMixer(model);
    const find = (suffix: string) => gltf.animations.find((c) => c.name.split('|').pop() === suffix);
    for (const action of Object.keys(spec.clips) as CharacterAction[]) {
      const c = spec.clips[action];
      const clip = find(c.name) ?? find(spec.clips.run.name);
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      if (c.mode === 'once') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      if (c.seconds) a.timeScale = clip.duration / c.seconds;
      this.actions.set(action, a);
    }
    this.model = model;
    this.mixer = mixer;
    this.root.add(model);
    this.fallback.root.visible = false;
  }

  update(dt: number, state: CharacterState): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (!this.model || !this.mixer) {
      this.fallback.update(dt, state);
      return;
    }
    const spec = GLB_SPECS[this.kind].clips[state.action] ?? GLB_SPECS[this.kind].clips.run;
    const next = this.actions.get(state.action) ?? this.actions.get('run');
    if (next && state.action !== this.currentAction) {
      next.reset();
      next.enabled = true;
      next.setEffectiveWeight(1);
      next.play();
      if (this.current && this.current !== next) this.current.crossFadeTo(next, FADE, false);
      this.current = next;
      this.currentAction = state.action;
    }
    if (next) {
      if (spec.mode === 'cycle') {
        next.timeScale = next.getClip().duration * 2.35 * runPlaybackRate(state.speed);
      } else if (spec.mode === 'airborne') {
        next.paused = false;
        next.timeScale = 0;
        next.time = clamp01(state.airborneT ?? 0.5) * next.getClip().duration;
      }
    }
    this.mixer.update(dt);
    this.leanS += (clampLean(state.lean) - this.leanS) * (1 - Math.exp(-dt / 0.05));
    this.model.rotation.z = -this.leanS * 0.3;
    const lift = state.action === 'hover' ? HOVER_LIFT : 0;
    this.lift += (lift - this.lift) * (1 - Math.exp(-dt / 0.05));
    this.model.position.y = this.baseY + this.lift;
  }
}

function createGlbRig(kind: GlbKind): CharacterRig {
  const fallback = kind === 'runner' ? createRunner() : kind === 'inspector' ? createInspector() : createDog();
  const rig = new GlbRig(kind, fallback);
  rig.root.userData.rig = rig;
  return rig;
}

/** Triangle count of a rig's visible meshes (excluding outline hulls). */
export function characterTriangles(rig: CharacterRig): number {
  let tris = 0;
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !o.userData.isOutline) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  });
  return tris;
}
