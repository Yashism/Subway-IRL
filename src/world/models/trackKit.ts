import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { basicMaterial, flatMaterial } from '../render/materials';
import { canvasTexture, seededRandom, speckle } from '../render/canvasTexture';

/**
 * Track kit: ballast bed, sleepers, rails, ground, catenary (OHE) and signals for the
 * three 2.5 m lanes. Everything is instanced on fixed grids along the track and laid
 * out with the floating origin: world z = -(itemS - runnerS).
 */

export const LANE_XS = [-2.5, 0, 2.5] as const;
/** Rail offset from each lane centre (broad gauge ~1.68 m). */
export const RAIL_OFFSET = 0.8;
/** The track bed occupies |x| < TRACK_HALF_WIDTH; scenery stays outside 4.2. */
export const TRACK_HALF_WIDTH = 4;
/** Ground level beside the track (the running surface / sleeper tops are at y = 0). */
export const GROUND_Y = -0.22;
export const RAIL_TOP_Y = 0.1;
export const VIEW_BEHIND = 15;
export const VIEW_AHEAD = 180;
export const SLEEPER_SPACING = 1.2;
export const BED_SEGMENT = 12;
export const GROUND_SEGMENT = 24;
export const MAST_SPACING = 25;
export const MAST_X = 4.0;
export const MAST_HEIGHT = 8.5;
export const CONTACT_WIRE_Y = 5.7;
export const MESSENGER_Y = 6.95;
export const SIGNAL_X = 4.35;
export const SIGNAL_HEIGHT = 4.5;

// ---------------------------------------------------------------------------------
// Pure grid helpers (no WebGL; unit-tested)

/** Index of the first point item (at k * spacing) not further than `behind` metres back. */
export function gridFirst(runnerS: number, spacing: number, behind: number): number {
  return Math.ceil((runnerS - behind) / spacing);
}

/** Index of the last point item (at k * spacing) not further than `ahead` metres forward. */
export function gridLast(runnerS: number, spacing: number, ahead: number): number {
  return Math.floor((runnerS + ahead) / spacing);
}

/** First index of a segment [k*L, k*L + L] that reaches into the view window. */
export function segmentFirst(runnerS: number, length: number, behind: number): number {
  return Math.floor((runnerS - behind) / length);
}

/** Last index of a segment [k*L, k*L + L] that starts inside the view window. */
export function segmentLast(runnerS: number, length: number, ahead: number): number {
  return Math.ceil((runnerS + ahead) / length) - 1;
}

/** Upper bound on how many grid items can be visible at once. */
export function gridCapacity(spacing: number, behind: number, ahead: number): number {
  return Math.floor((behind + ahead) / spacing) + 2;
}

/** Deterministic hash of an integer to [0, 1). */
export function hash01(n: number, salt = 0): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x51ed27, 0xc2b2ae35);
  x ^= x >>> 13;
  x = Math.imul(x, 0x27d4eb2f);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Which side (-1 / +1) the signal after mast k stands on, or 0 for no signal. */
export function signalSide(k: number): -1 | 0 | 1 {
  if (hash01(k, 11) >= 0.24) return 0;
  return hash01(k, 12) < 0.5 ? -1 : 1;
}

/** Signal aspect for mast k: 0 red, 1 yellow, 2 green. */
export function signalAspect(k: number): 0 | 1 | 2 {
  const h = hash01(k, 13);
  return h < 0.3 ? 0 : h < 0.55 ? 1 : 2;
}

// ---------------------------------------------------------------------------------
// Geometry building helpers (build-time only, shared with scenery.ts)

export type UVRect = readonly [number, number, number, number];

const scratchObj = new THREE.Object3D();
const scratchColor = new THREE.Color();
const upAxis = new THREE.Vector3(0, 1, 0);
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const unitBoxes = new Map<string, THREE.BoxGeometry>();
/** Segment length used so long parts follow the curved-world bend smoothly. */
export const CURVE_SEGMENT = 4;
const segs = (len: number) => Math.min(24, Math.max(1, Math.ceil(len / CURVE_SEGMENT)));

/** Unit box with the given segment counts (cached). */
export function unitBox(ws = 1, hs = 1, ds = 1): THREE.BoxGeometry {
  const key = `${ws}:${hs}:${ds}`;
  let g = unitBoxes.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(1, 1, 1, ws, hs, ds);
    unitBoxes.set(key, g);
  }
  return g;
}

/** Vertex [start, count] per face (px, nx, py, ny, pz, nz) of an indexed BoxGeometry. */
export function boxFaceRanges(ws: number, hs: number, ds: number): [number, number][] {
  const counts = [(ds + 1) * (hs + 1), (ds + 1) * (hs + 1), (ws + 1) * (ds + 1), (ws + 1) * (ds + 1), (ws + 1) * (hs + 1), (ws + 1) * (hs + 1)];
  let start = 0;
  return counts.map((c) => {
    const r: [number, number] = [start, c];
    start += c;
    return r;
  });
}

/** A box subdivided along its long axes (x and z) for the curved world. */
export function curveBox(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d, segs(w), 1, segs(d));
}

/** Builds a transform matrix (translation, Euler XYZ rotation, scale). The result is shared: use it at once. */
export function tf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  scratchObj.position.set(x, y, z);
  scratchObj.rotation.set(rx, ry, rz);
  scratchObj.scale.set(sx, sy, sz);
  scratchObj.updateMatrix();
  return scratchObj.matrix;
}

/** Converts a pixel rectangle of a canvas atlas into a UV rectangle (flipY textures). */
export function atlasRect(px: number, py: number, pw: number, ph: number, w: number, h: number): UVRect {
  return [px / w, 1 - (py + ph) / h, (px + pw) / w, 1 - py / h];
}

/** Remaps uvs (assumed 0..1) of a vertex range into a rectangle. */
export function remapUV(geo: THREE.BufferGeometry, rect: UVRect, start = 0, count = Infinity): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const end = Math.min(uv.count, start + count);
  for (let i = start; i < end; i++) {
    uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
  }
  uv.needsUpdate = true;
}

/** Scales uvs (for repeating textures). */
export function scaleUV(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

export interface PartOptions {
  color?: THREE.ColorRepresentation;
  uv?: UVRect;
  /** Recompute faceted normals (low-poly look). */
  flat?: boolean;
}

/**
 * Collects geometry parts and merges them into one mesh per material, so a built
 * piece costs one draw call per material. Every part gets position/normal/uv/color.
 */
export class PartBuilder {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(material: THREE.Material, geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, o: PartOptions = {}): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    if (o.uv) remapUV(g, o.uv);
    if (matrix) g.applyMatrix4(matrix);
    if (o.flat || !g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    scratchColor.set(o.color ?? 0xffffff);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = scratchColor.r;
      colors[i * 3 + 1] = scratchColor.g;
      colors[i * 3 + 2] = scratchColor.b;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.morphAttributes = {};
    let list = this.parts.get(material);
    if (!list) {
      list = [];
      this.parts.set(material, list);
    }
    list.push(g);
    return this;
  }

  /** Axis-aligned (optionally rotated) box centred at (x, y, z). */
  box(material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, o: PartOptions & { rx?: number; ry?: number; rz?: number } = {}): this {
    return this.add(material, unitBox(segs(w), 1, segs(d)), tf(x, y, z, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, w, h, d), o);
  }

  /** A square beam of thickness t from point a to point b. */
  beam(material: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, o: PartOptions & { tz?: number } = {}): this {
    vA.set(bx - ax, by - ay, bz - az);
    const len = vA.length();
    const box = unitBox(1, segs(len), 1);
    vA.divideScalar(len || 1);
    scratchObj.quaternion.setFromUnitVectors(upAxis, vA);
    scratchObj.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    scratchObj.scale.set(t, len, o.tz ?? t);
    scratchObj.updateMatrix();
    return this.add(material, box, scratchObj.matrix, o);
  }

  /** A cylinder from point a to point b. */
  rod(material: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r0: number, r1 = r0, sides = 6, o: PartOptions = {}): this {
    const g = new THREE.CylinderGeometry(r1, r0, 1, sides, segs(Math.hypot(bx - ax, by - ay, bz - az)), false);
    vB.set(bx - ax, by - ay, bz - az);
    const len = vB.length();
    vB.divideScalar(len || 1);
    scratchObj.quaternion.setFromUnitVectors(upAxis, vB);
    scratchObj.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    scratchObj.scale.set(1, len, 1);
    scratchObj.updateMatrix();
    this.add(material, g, scratchObj.matrix, o);
    g.dispose();
    return this;
  }

  /** A textured quad of size w x h, facing +z before rotation, centred at (x, y, z). */
  quad(material: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0, o: PartOptions & { rx?: number; rz?: number } = {}): this {
    const g = new THREE.PlaneGeometry(w, h);
    this.add(material, g, tf(x, y, z, o.rx ?? 0, ry, o.rz ?? 0), o);
    g.dispose();
    return this;
  }

  /** One merged geometry per material. */
  merged(): { material: THREE.Material; geometry: THREE.BufferGeometry }[] {
    const out: { material: THREE.Material; geometry: THREE.BufferGeometry }[] = [];
    for (const [material, list] of this.parts) {
      const geometry = mergeGeometries(list, false)!;
      for (const g of list) g.dispose();
      geometry.computeBoundingSphere();
      out.push({ material, geometry });
    }
    this.parts.clear();
    return out;
  }
}

/** Turns merged parts into a Group (one Mesh per material). */
export function groupFromParts(parts: { material: THREE.Material; geometry: THREE.BufferGeometry }[], name = ''): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.name = `${name}:${p.material.name}`;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------------
// Shared materials (lazy, module-cached)

let vcMat: THREE.MeshStandardMaterial | null = null;
/** Plain vertex-coloured environment material, shared by every kit and scenery piece. */
export function vertexColorMaterial(): THREE.MeshStandardMaterial {
  if (!vcMat) {
    vcMat = flatMaterial({ vertexColors: true });
    vcMat.name = 'vc';
  }
  return vcMat;
}

const mats: Record<string, THREE.Material> = {};
function mat<T extends THREE.Material>(key: string, make: () => T): T {
  return (mats[key] ??= make()) as T;
}

const BED_WIDTH = 8.4;

function wrapDraw(w: number, h: number, x: number, y: number, r: number, draw: (x: number, y: number) => void): void {
  for (const dx of [-w, 0, w]) {
    for (const dy of [-h, 0, h]) {
      const px = x + dx;
      const py = y + dy;
      if (px + r < 0 || px - r > w || py + r < 0 || py - r > h) continue;
      draw(px, py);
    }
  }
}

function ballastTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'track-ballast',
    512,
    512,
    (ctx, w, h) => {
      const rand = seededRandom(41);
      const pxPerM = w / BED_WIDTH;
      const ux = (x: number) => (x + BED_WIDTH / 2) * pxPerM;
      ctx.fillStyle = '#7a746c';
      ctx.fillRect(0, 0, w, h);
      // Earthy shoulders.
      for (const side of [-1, 1]) {
        const g = ctx.createLinearGradient(ux(side * 3.4), 0, ux(side * 4.2), 0);
        g.addColorStop(0, 'rgba(110,90,70,0)');
        g.addColorStop(1, 'rgba(110,90,70,0.85)');
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(ux(side * 3.4), ux(side * 4.2)), 0, Math.abs(ux(side * 4.2) - ux(side * 3.4)), h);
      }
      speckle(ctx, w, h, rand, 14000, ['#5f5a54', '#8e877e', '#9f978c', '#4c4843', '#a89e92', '#6d645a', '#857466'], 3);
      // Individual stones with light tops.
      for (let i = 0; i < 2600; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 2 + rand() * 3.2;
        const shade = 95 + Math.floor(rand() * 70);
        wrapDraw(w, h, x, y, r, (px, py) => {
          ctx.fillStyle = `rgba(35,30,28,0.55)`;
          ctx.beginPath();
          ctx.ellipse(px + 0.8, py + 1.2, r, r * 0.75, rand() * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgb(${shade},${shade - 6},${shade - 12})`;
          ctx.beginPath();
          ctx.ellipse(px, py, r, r * 0.72, rand() * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255,250,240,0.25)`;
          ctx.fillRect(px - r * 0.4, py - r * 0.5, r * 0.6, r * 0.35);
        });
      }
      // Rust stains under the rails and dark oil in each lane centre.
      for (const lane of LANE_XS) {
        for (const off of [-RAIL_OFFSET, RAIL_OFFSET]) {
          const g = ctx.createLinearGradient(ux(lane + off - 0.35), 0, ux(lane + off + 0.35), 0);
          g.addColorStop(0, 'rgba(120,64,34,0)');
          g.addColorStop(0.5, 'rgba(120,64,34,0.45)');
          g.addColorStop(1, 'rgba(120,64,34,0)');
          ctx.fillStyle = g;
          ctx.fillRect(ux(lane + off - 0.35), 0, 0.7 * pxPerM, h);
        }
        for (let i = 0; i < 26; i++) {
          const x = ux(lane + (rand() - 0.5) * 0.9);
          const y = rand() * h;
          const r = 6 + rand() * 16;
          wrapDraw(w, h, x, y, r * 1.6, (px, py) => {
            ctx.fillStyle = 'rgba(28,24,20,0.22)';
            ctx.beginPath();
            ctx.ellipse(px, py, r, r * 1.6, 0, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }
      // A little litter: plastic flecks.
      speckle(ctx, w, h, rand, 50, ['#e8e2d0', '#3d7cc9', '#d8433a'], 2);
    },
    { repeat: true },
  );
}

function groundTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'track-ground',
    512,
    512,
    (ctx, w, h) => {
      const rand = seededRandom(77);
      ctx.fillStyle = '#9a7a57';
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, rand, 9000, ['#8a6b4c', '#a88763', '#7d6146', '#b39472'], 3);
      // Grass patches.
      for (let i = 0; i < 70; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 14 + rand() * 46;
        const col = rand() < 0.5 ? '#6f9e3c' : '#86b04a';
        wrapDraw(w, h, x, y, r * 1.4, (px, py) => {
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.75;
          ctx.beginPath();
          ctx.ellipse(px, py, r, r * (0.6 + rand() * 0.5), rand() * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        });
      }
      // Grass tufts.
      ctx.lineWidth = 2;
      for (let i = 0; i < 900; i++) {
        const x = rand() * w;
        const y = rand() * h;
        ctx.strokeStyle = rand() < 0.5 ? '#5a8a2e' : '#9cc255';
        ctx.beginPath();
        for (let b = 0; b < 3; b++) {
          ctx.moveTo(x + b * 2, y);
          ctx.lineTo(x + b * 2 + (rand() - 0.5) * 6, y - 4 - rand() * 6);
        }
        ctx.stroke();
      }
      // Puddles and stones.
      for (let i = 0; i < 5; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 10 + rand() * 18;
        wrapDraw(w, h, x, y, r * 1.5, (px, py) => {
          ctx.fillStyle = 'rgba(70,60,50,0.5)';
          ctx.beginPath();
          ctx.ellipse(px, py + 2, r * 1.5, r * 0.7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(150,190,210,0.65)';
          ctx.beginPath();
          ctx.ellipse(px, py, r * 1.4, r * 0.6, 0, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      speckle(ctx, w, h, rand, 500, ['#6e6a64', '#c9c0b0', '#57524c'], 5);
      speckle(ctx, w, h, rand, 40, ['#f2eee4', '#2f78c4', '#e0483c', '#f2c230'], 3);
    },
    { repeat: true },
  );
}

// ---------------------------------------------------------------------------------
// Geometry for the track bed

function bedGeometry(): THREE.BufferGeometry {
  // Cross-section: shoulder, flat top, shoulder. Rows every 3 m so the curve bends smoothly.
  const xs = [-4.2, -3.7, 3.7, 4.2];
  const ys = [GROUND_Y - 0.02, -0.03, -0.03, GROUND_Y - 0.02];
  const rows = 5;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r < rows; r++) {
    const z = -(r / (rows - 1)) * BED_SEGMENT;
    for (let c = 0; c < xs.length; c++) {
      pos.push(xs[c], ys[c], z);
      uv.push((xs[c] + BED_WIDTH / 2) / BED_WIDTH, -z / BED_WIDTH);
    }
  }
  const cols = xs.length;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function groundGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const inner = 3.9;
    const outer = 70;
    const g = new THREE.PlaneGeometry(outer - inner, GROUND_SEGMENT, 3, 8);
    g.rotateX(-Math.PI / 2);
    g.translate(side * (inner + outer) / 2, GROUND_Y, -GROUND_SEGMENT / 2);
    const p = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 12, -p.getZ(i) / 12);
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

function sleeperRowGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = vertexColorMaterial();
  for (const lane of LANE_XS) {
    b.box(m, 2.5, 0.12, 0.26, lane, -0.04, 0, { color: '#a59f95' });
    b.box(m, 2.3, 0.02, 0.2, lane, 0.025, 0, { color: '#b9b3a8' });
    for (const off of [-RAIL_OFFSET, RAIL_OFFSET]) {
      for (const clip of [-0.1, 0.1]) b.box(m, 0.07, 0.05, 0.1, lane + off + clip, 0.045, 0, { color: '#2b2a29' });
    }
  }
  return b.merged()[0].geometry;
}

function railGeometry(part: 'body' | 'head'): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = vertexColorMaterial();
  for (const lane of LANE_XS) {
    for (const off of [-RAIL_OFFSET, RAIL_OFFSET]) {
      const x = lane + off;
      const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 4);
      if (part === 'body') {
        b.add(m, g, tf(x, 0.03, -BED_SEGMENT / 2, 0, 0, 0, 0.15, 0.02, BED_SEGMENT), { color: '#4a3d34' });
        b.add(m, g, tf(x, 0.055, -BED_SEGMENT / 2, 0, 0, 0, 0.03, 0.035, BED_SEGMENT), { color: '#5b4a3e' });
        b.add(m, g, tf(x, 0.082, -BED_SEGMENT / 2, 0, 0, 0, 0.072, 0.024, BED_SEGMENT), { color: '#6a584b' });
      } else {
        b.add(m, g, tf(x, 0.097, -BED_SEGMENT / 2, 0, 0, 0, 0.066, 0.008, BED_SEGMENT), { color: '#ffffff' });
      }
      g.dispose();
    }
  }
  return b.merged()[0].geometry;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

export interface TrackBed {
  root: THREE.Group;
  meshes: THREE.InstancedMesh[];
  update(runnerS: number): void;
}

/** Ballast bed, ground, sleepers and rails for all three lanes. */
export function createTrackBed(behind = VIEW_BEHIND, ahead = VIEW_AHEAD): TrackBed {
  const root = new THREE.Group();
  root.name = 'trackBed';

  const bedMat = mat('bed', () => flatMaterial({ map: ballastTexture(), roughness: 1 }));
  const groundMat = mat('ground', () => flatMaterial({ map: groundTexture(), roughness: 1 }));
  const railHeadMat = mat('railHead', () => flatMaterial({ vertexColors: true, color: '#dfe5ea', metalness: 0.35, roughness: 0.28, emissive: '#5d6166' }));

  const segCap = gridCapacity(BED_SEGMENT, behind, ahead) + 1;
  const groundCap = gridCapacity(GROUND_SEGMENT, behind, ahead) + 1;
  const sleeperCap = gridCapacity(SLEEPER_SPACING, behind, ahead);

  const bed = instanced(bedGeometry(), bedMat, segCap, 'ballast');
  const ground = instanced(groundGeometry(), groundMat, groundCap, 'ground');
  const sleepers = instanced(sleeperRowGeometry(), vertexColorMaterial(), sleeperCap, 'sleepers');
  const railBody = instanced(railGeometry('body'), vertexColorMaterial(), segCap, 'railBody');
  const railHead = instanced(railGeometry('head'), railHeadMat, segCap, 'railHead');
  for (const m of [bed, ground, sleepers]) m.receiveShadow = true;
  const meshes = [ground, bed, sleepers, railBody, railHead];
  root.add(...meshes);

  const o = new THREE.Object3D();
  return {
    root,
    meshes,
    update(runnerS: number) {
      let n = 0;
      for (let k = segmentFirst(runnerS, BED_SEGMENT, behind), last = segmentLast(runnerS, BED_SEGMENT, ahead); k <= last && n < segCap; k++, n++) {
        o.position.set(0, 0, -(k * BED_SEGMENT - runnerS));
        o.updateMatrix();
        bed.setMatrixAt(n, o.matrix);
        railBody.setMatrixAt(n, o.matrix);
        railHead.setMatrixAt(n, o.matrix);
      }
      bed.count = railBody.count = railHead.count = n;
      n = 0;
      for (let k = segmentFirst(runnerS, GROUND_SEGMENT, behind), last = segmentLast(runnerS, GROUND_SEGMENT, ahead); k <= last && n < groundCap; k++, n++) {
        o.position.set(0, 0, -(k * GROUND_SEGMENT - runnerS));
        o.updateMatrix();
        ground.setMatrixAt(n, o.matrix);
      }
      ground.count = n;
      n = 0;
      for (let k = gridFirst(runnerS, SLEEPER_SPACING, behind), last = gridLast(runnerS, SLEEPER_SPACING, ahead); k <= last && n < sleeperCap; k++, n++) {
        o.position.set(0, 0, -(k * SLEEPER_SPACING - runnerS));
        o.updateMatrix();
        sleepers.setMatrixAt(n, o.matrix);
      }
      sleepers.count = n;
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------------
// Catenary (OHE) portals, wires and signals

const STEEL = '#8d979c';
const STEEL_DARK = '#5f686d';
const WIRE = '#2a2a2a';

function latticeMast(b: PartBuilder, m: THREE.Material, cx: number, height: number): void {
  const hw = 0.16;
  const t = 0.05;
  const corners: [number, number][] = [
    [-hw, -hw],
    [hw, -hw],
    [hw, hw],
    [-hw, hw],
  ];
  for (const [dx, dz] of corners) b.box(m, t, height, t, cx + dx, height / 2, dz, { color: STEEL });
  const step = 0.55;
  const levels = Math.floor(height / step);
  for (let i = 0; i < levels; i++) {
    const y0 = i * step + 0.3;
    const y1 = y0 + step;
    const flip = i % 2 === 0 ? 1 : -1;
    // Faces at z = ±hw (seen along the track) and at x = ±hw.
    for (const fz of [-hw, hw]) b.beam(m, cx - hw * flip, y0, fz, cx + hw * flip, y1, fz, 0.025, { color: STEEL });
    for (const fx of [-hw, hw]) b.beam(m, cx + fx, y0, -hw * flip, cx + fx, y1, hw * flip, 0.025, { color: STEEL });
  }
  // Concrete foundation and cap.
  b.box(m, 0.6, 0.5, 0.6, cx, GROUND_Y + 0.1, 0, { color: '#a8a296' });
  b.box(m, 0.42, 0.08, 0.42, cx, height, 0, { color: STEEL_DARK });
}

function insulator(b: PartBuilder, m: THREE.Material, x: number, y: number, z: number, horizontal: boolean): void {
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 0.07;
    const g = new THREE.CylinderGeometry(0.06, 0.06, 0.035, 8);
    b.add(m, g, horizontal ? tf(x + off, y, z, 0, 0, Math.PI / 2) : tf(x, y + off, z), { color: '#a0522d' });
    g.dispose();
  }
}

function portalGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = vertexColorMaterial();
  for (const side of [-1, 1]) latticeMast(b, m, side * MAST_X, MAST_HEIGHT);
  // Head-span lattice girder across the three tracks.
  const yb = 7.7;
  const yt = 8.3;
  const hz = 0.14;
  for (const fz of [-hz, hz]) {
    b.box(m, MAST_X * 2 + 0.3, 0.06, 0.06, 0, yb, fz, { color: STEEL });
    b.box(m, MAST_X * 2 + 0.3, 0.06, 0.06, 0, yt, fz, { color: STEEL });
    const bays = 12;
    for (let i = 0; i < bays; i++) {
      const x0 = -MAST_X + (i / bays) * MAST_X * 2;
      const x1 = -MAST_X + ((i + 1) / bays) * MAST_X * 2;
      if (i % 2 === 0) b.beam(m, x0, yb, fz, x1, yt, fz, 0.03, { color: STEEL });
      else b.beam(m, x0, yt, fz, x1, yb, fz, 0.03, { color: STEEL });
    }
  }
  for (let i = 0; i <= 6; i++) {
    const x = -MAST_X + (i / 6) * MAST_X * 2;
    b.box(m, 0.03, 0.03, hz * 2, x, yb, 0, { color: STEEL });
    b.box(m, 0.03, 0.03, hz * 2, x, yt, 0, { color: STEEL });
  }
  // Per-lane drop tube, cantilever and registration arm.
  for (const laneX of LANE_XS) {
    const lane = laneX === 0 ? 0.25 : laneX;
    const px = lane + 0.55;
    b.rod(m, px, yb, 0, px, CONTACT_WIRE_Y - 0.15, 0, 0.035, 0.035, 6, { color: STEEL_DARK });
    // Upper bracket to the messenger wire.
    b.rod(m, px, MESSENGER_Y + 0.05, 0, lane, MESSENGER_Y + 0.05, 0, 0.022, 0.022, 5, { color: STEEL_DARK });
    insulator(b, m, px - 0.18, MESSENGER_Y + 0.05, 0, true);
    // Diagonal stay and registration arm to the contact wire.
    b.rod(m, px, MESSENGER_Y - 0.25, 0, lane - 0.15, CONTACT_WIRE_Y + 0.08, 0, 0.02, 0.02, 5, { color: STEEL_DARK });
    b.rod(m, px, CONTACT_WIRE_Y + 0.02, 0, lane - 0.2, CONTACT_WIRE_Y + 0.02, 0, 0.02, 0.02, 5, { color: STEEL_DARK });
    insulator(b, m, px - 0.2, CONTACT_WIRE_Y + 0.02, 0, true);
  }
  // Feeder wire brackets on top of the masts.
  for (const side of [-1, 1]) {
    b.box(m, 0.9, 0.05, 0.05, side * (MAST_X + 0.3), MAST_HEIGHT - 0.3, 0, { color: STEEL_DARK });
    insulator(b, m, side * (MAST_X + 0.65), MAST_HEIGHT - 0.2, 0, false);
  }
  return b.merged()[0].geometry;
}

function wireSpanGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = vertexColorMaterial();
  const L = MAST_SPACING;
  const pieces = 10;
  const sag = (u: number, depth: number) => depth * 4 * u * (1 - u);
  for (const laneX of LANE_XS) {
    // The curved-world shader pinches by sign(x): keep the centre wires wholly on +x.
    const lane = laneX === 0 ? 0.25 : laneX;
    // Contact wire: level, with a slight zig-zag stagger.
    b.beam(m, lane - 0.2, CONTACT_WIRE_Y, 0, lane + 0.2, CONTACT_WIRE_Y, -L, 0.03, { color: WIRE });
    // Messenger wire: a sagging catenary.
    for (let i = 0; i < pieces; i++) {
      const u0 = i / pieces;
      const u1 = (i + 1) / pieces;
      b.beam(m, lane, MESSENGER_Y - sag(u0, 0.55), -u0 * L, lane, MESSENGER_Y - sag(u1, 0.55), -u1 * L, 0.028, { color: WIRE });
    }
    // Droppers.
    for (let i = 1; i < pieces; i++) {
      const u = i / pieces;
      const x = lane - 0.2 + 0.4 * u;
      b.beam(m, x, CONTACT_WIRE_Y, -u * L, lane, MESSENGER_Y - sag(u, 0.55), -u * L, 0.012, { color: '#3a3a3a' });
    }
  }
  // Feeder / return wires along the mast tops.
  for (const side of [-1, 1]) {
    const x = side * (MAST_X + 0.65);
    for (let i = 0; i < pieces; i++) {
      const u0 = i / pieces;
      const u1 = (i + 1) / pieces;
      b.beam(m, x, MAST_HEIGHT - 0.35 - sag(u0, 0.8), -u0 * L, x, MAST_HEIGHT - 0.35 - sag(u1, 0.8), -u1 * L, 0.035, { color: WIRE });
    }
  }
  return b.merged()[0].geometry;
}

function signalBodyGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const m = vertexColorMaterial();
  b.box(m, 0.5, 0.4, 0.5, 0, GROUND_Y + 0.1, 0, { color: '#a8a296' });
  // Pole with painted white/black bands near the base.
  b.rod(m, 0, 0, 0, 0, SIGNAL_HEIGHT - 0.3, 0, 0.07, 0.06, 8, { color: '#d9d9d4' });
  for (let i = 0; i < 3; i++) b.rod(m, 0, 0.4 + i * 0.5, 0, 0, 0.65 + i * 0.5, 0, 0.075, 0.075, 8, { color: '#1c1c1c' });
  // Ladder behind the pole.
  b.box(m, 0.03, SIGNAL_HEIGHT - 0.8, 0.03, -0.18, (SIGNAL_HEIGHT - 0.8) / 2, -0.15, { color: '#555' });
  b.box(m, 0.03, SIGNAL_HEIGHT - 0.8, 0.03, 0.18, (SIGNAL_HEIGHT - 0.8) / 2, -0.15, { color: '#555' });
  for (let y = 0.4; y < SIGNAL_HEIGHT - 0.8; y += 0.35) b.box(m, 0.36, 0.025, 0.025, 0, y, -0.15, { color: '#555' });
  // Head: black case with a white border plate.
  const hy = SIGNAL_HEIGHT - 0.55;
  b.box(m, 0.56, 1.36, 0.06, 0, hy, 0.07, { color: '#f2f2f2' });
  b.box(m, 0.44, 1.22, 0.3, 0, hy, 0.02, { color: '#151515' });
  for (let i = 0; i < 3; i++) {
    const ly = hy + 0.38 - i * 0.38;
    // Hood over each lamp.
    const hood = new THREE.CylinderGeometry(0.17, 0.17, 0.22, 10, 1, true, -Math.PI / 2, Math.PI);
    b.add(m, hood, tf(0, ly, 0.2, Math.PI / 2, 0, 0), { color: '#111' });
    hood.dispose();
    b.rod(m, 0, ly, 0.1, 0, ly, 0.12, 0.14, 0.14, 12, { color: '#050505' });
  }
  b.box(m, 0.2, 0.08, 0.2, 0, SIGNAL_HEIGHT + 0.16, 0.02, { color: '#151515' });
  // Platform ring for the maintainer.
  b.box(m, 0.8, 0.04, 0.6, 0, hy - 0.8, -0.05, { color: '#555' });
  return b.merged()[0].geometry;
}

const LAMP_ON: [number, number, number][] = [
  [2.2, 0.12, 0.08],
  [2.2, 1.45, 0.1],
  [0.2, 2.0, 0.7],
];
const LAMP_OFF: [number, number, number][] = [
  [0.16, 0.03, 0.03],
  [0.16, 0.12, 0.02],
  [0.02, 0.14, 0.06],
];

export interface CatenaryOptions {
  behind?: number;
  ahead?: number;
  /** Return false to suppress a signal at track position s on the given side (e.g. at platforms). */
  signalFilter?: (s: number, side: -1 | 1) => boolean;
}

export interface Catenary {
  root: THREE.Group;
  meshes: THREE.InstancedMesh[];
  update(runnerS: number): void;
}

/** OHE portals every 25 m, contact/messenger/feeder wires, and occasional signals. */
export function createCatenary(o: CatenaryOptions = {}): Catenary {
  const behind = o.behind ?? VIEW_BEHIND;
  const ahead = o.ahead ?? VIEW_AHEAD;
  const root = new THREE.Group();
  root.name = 'catenary';
  const cap = gridCapacity(MAST_SPACING, behind, ahead) + 1;
  const portals = instanced(portalGeometry(), vertexColorMaterial(), cap, 'ohePortals');
  portals.castShadow = true;
  const wires = instanced(wireSpanGeometry(), vertexColorMaterial(), cap, 'oheWires');
  const signals = instanced(signalBodyGeometry(), vertexColorMaterial(), cap, 'signals');
  signals.castShadow = true;
  const lampGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.03, 12);
  lampGeo.rotateX(Math.PI / 2);
  const lampMat = mat('lamp', () => basicMaterial({ color: 0xffffff, toneMapped: false }));
  const lamps = instanced(lampGeo, lampMat, cap * 3, 'signalLamps');
  const col = new THREE.Color();
  for (let i = 0; i < cap * 3; i++) lamps.setColorAt(i, col.setRGB(0, 0, 0));
  const meshes = [portals, wires, signals, lamps];
  root.add(...meshes);
  const filter = o.signalFilter;

  const obj = new THREE.Object3D();
  return {
    root,
    meshes,
    update(runnerS: number) {
      let n = 0;
      let w = 0;
      let sN = 0;
      const first = segmentFirst(runnerS, MAST_SPACING, behind);
      const last = gridLast(runnerS, MAST_SPACING, ahead);
      for (let k = first; k <= last; k++) {
        const z = -(k * MAST_SPACING - runnerS);
        obj.position.set(0, 0, z);
        obj.updateMatrix();
        if (z <= behind && n < cap) portals.setMatrixAt(n++, obj.matrix);
        if (w < cap) wires.setMatrixAt(w++, obj.matrix);
        const side = signalSide(k);
        const sS = k * MAST_SPACING + MAST_SPACING / 2;
        if (side === 0 || sN >= cap || sS - runnerS > ahead || runnerS - sS > behind) continue;
        if (filter && !filter(sS, side)) continue;
        obj.position.set(side * SIGNAL_X, 0, -(sS - runnerS));
        obj.updateMatrix();
        signals.setMatrixAt(sN, obj.matrix);
        const aspect = signalAspect(k);
        for (let l = 0; l < 3; l++) {
          obj.position.set(side * SIGNAL_X, SIGNAL_HEIGHT - 0.55 + 0.38 - l * 0.38, -(sS - runnerS) + 0.14);
          obj.updateMatrix();
          lamps.setMatrixAt(sN * 3 + l, obj.matrix);
          const c = l === aspect ? LAMP_ON[l] : LAMP_OFF[l];
          lamps.setColorAt(sN * 3 + l, col.setRGB(c[0], c[1], c[2]));
        }
        sN++;
      }
      portals.count = n;
      wires.count = w;
      signals.count = sN;
      lamps.count = sN * 3;
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    },
  };
}
