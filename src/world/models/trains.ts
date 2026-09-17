import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addOutline, enableShadows, toonMaterial } from '../render/materials';
import { canvasTexture, seededRandom, speckle, streaks } from '../render/canvasTexture';

/**
 * Mumbai local (EMU) trains and the roof ramp.
 * Original designs: chunky toon coaches with barred windows, open doorways,
 * livery waist bands and canvas-drawn graffiti. Near end at z = 0, extending to -z.
 */

export type Livery = 'western' | 'central';

// ---------------------------------------------------------------------------
// Dimensions (metres)
// ---------------------------------------------------------------------------
const HW = 1.13; // half width of the body shell (panels)
const CORE_HW = 1.0; // half width of the dark inner core (seen through doors)
const FLOOR = 0.96; // bottom of the body shell
const EAVE = 2.85; // top of the side walls, roof arc starts here
const ROOF_TOP = 3.2; // walkable roof height
const DOOR_TOP = 2.72;
const GAP = 0.4; // space between coupled coaches
const CAB_D = 0.55; // depth of the yellow cab nose block
const DOOR_FR = [0.22, 0.78]; // door centres as a fraction of coach length
const DOOR_W_FR = 0.104; // door width as a fraction of coach length
const TEX_REF_LEN = 12.5; // coach length the side texture is drawn for

const LIVERY = {
  western: { body: '#F0E6C8', band: '#7A2E3A', dark: '#4E1C26', code: 'WR', tint: 0xffe9c8 },
  central: { body: '#B7C4CC', band: '#274472', dark: '#172A48', code: 'CR', tint: 0xd6e4ff },
} as const;

const YELLOW = '#FFD400';
const RED = '#E8433A';
const INK = '#141414';
const ACCENTS = ['#E5399B', '#29C7E0', '#FF7A29', '#FFD400', '#3FB27F', '#8E5FD1'];
const GRAFFITI_VARIANTS = 4;
const STATIONS: Record<Livery, string[]> = {
  western: ['VIRAR', 'BORIVALI', 'CHURCHGATE'],
  central: ['CSMT', 'THANE', 'KALYAN'],
};
const HEAVY_FONT = '"Arial Black", Impact, "Ubuntu", "Liberation Sans", "DejaVu Sans", sans-serif';

/** Roof height at lateral offset x (rounded superellipse profile). */
function roofY(x: number): number {
  const c = Math.min(1, Math.abs(x) / HW);
  const s = Math.sqrt(1 - c * c);
  return EAVE + (ROOF_TOP - EAVE) * Math.sqrt(s);
}

// ---------------------------------------------------------------------------
// Geometry helpers: collect coloured parts and merge them into one mesh
// ---------------------------------------------------------------------------
const KEEP_ATTRS = new Set(['position', 'normal', 'uv', 'color']);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
/** Max length (m) of an unbroken edge along z, so the curved-world bend can't bulge long faces. */
const CURVE_STEP = 3;
const segBoxCache = new Map<number, THREE.BoxGeometry>();
/** Unit box split along z so that, scaled to depth d, no segment exceeds CURVE_STEP. */
function unitBoxFor(d: number): THREE.BoxGeometry {
  const n = Math.ceil(Math.abs(d) / CURVE_STEP);
  if (n <= 1) return unitBox;
  let g = segBoxCache.get(n);
  if (!g) segBoxCache.set(n, (g = new THREE.BoxGeometry(1, 1, 1, 1, 1, n)));
  return g;
}
const cylCache = new Map<string, THREE.CylinderGeometry>();
function unitCyl(seg: number, top = 1): THREE.CylinderGeometry {
  const k = `${seg}|${top}`;
  let g = cylCache.get(k);
  if (!g) cylCache.set(k, (g = new THREE.CylinderGeometry(top, 1, 1, seg)));
  return g;
}
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

type V3 = [number, number, number];

function prepare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(geo.attributes)) if (!KEEP_ATTRS.has(k)) geo.deleteAttribute(k);
  geo.clearGroups();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  return geo;
}

class Parts {
  readonly geos: THREE.BufferGeometry[] = [];

  addMatrix(g: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.ColorRepresentation): void {
    const geo = prepare(g);
    geo.applyMatrix4(matrix);
    _c.set(color);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geos.push(geo);
  }

  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): void {
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
    this.addMatrix(g, _m, color);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, rot?: V3): void {
    this.add(rot ? unitBox : unitBoxFor(d), color, [x, y, z], rot, [w, h, d]);
  }

  /** Cylinder with its axis along Y (rot to reorient). */
  cyl(r: number, h: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, rot?: V3, seg = 12, top = 1): void {
    this.add(unitCyl(seg, top), color, [x, y, z], rot, [r, h, r]);
  }

  /** A square bar from a to b. */
  bar(a: V3, b: V3, t: number, color: THREE.ColorRepresentation, seg = 0): void {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    _q.setFromUnitVectors(_up, dir.normalize());
    const r = seg ? t / 2 : t;
    _m.compose(_p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _s.set(r, len, r));
    this.addMatrix(seg ? unitCyl(seg) : unitBox, _m, color);
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    return merged;
  }
}

/** Rounded roof shell swept along -z from z0 to z1, with end caps. */
function roofGeometry(z0: number, z1: number, inset = 0): THREE.BufferGeometry {
  const N = 22;
  const pts: [number, number, number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI;
    const x = (HW - inset) * Math.cos(t);
    const y = roofY(x * (HW / (HW - inset))) - inset * 0.5;
    pts.push([x, y, 0, 0]);
  }
  for (let i = 0; i <= N; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) [nx, ny] = [1, 0];
    else if (i === N) [nx, ny] = [-1, 0];
    else {
      const dx = pts[i + 1][0] - pts[i - 1][0];
      const dy = pts[i + 1][1] - pts[i - 1][1];
      [nx, ny] = [dy, -dx];
      const l = Math.hypot(nx, ny);
      nx /= l;
      ny /= l;
    }
    pts[i][2] = nx;
    pts[i][3] = ny;
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const base = EAVE - 0.03;
  // Rings every <= CURVE_STEP m along z so the curved-world bend follows the roof.
  const M = Math.max(1, Math.ceil(Math.abs(z1 - z0) / CURVE_STEP));
  for (let i = 0; i <= N; i++) {
    const [x, y, nx, ny] = pts[i];
    for (let j = 0; j <= M; j++) {
      pos.push(x, y, z0 + ((z1 - z0) * j) / M);
      nor.push(nx, ny, 0);
      uv.push(i / N, j / M);
    }
  }
  const R = M + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * R + j;
      const b = a + 1;
      const a1 = a + R;
      const b1 = a1 + 1;
      idx.push(a, b, a1, a1, b, b1);
    }
  }
  // caps
  for (const [z, sign] of [
    [z0, 1],
    [z1, -1],
  ] as const) {
    const c = pos.length / 3;
    pos.push(0, base, z);
    nor.push(0, 0, sign);
    uv.push(0.5, 0.5);
    for (let i = 0; i <= N; i++) {
      pos.push(pts[i][0], pts[i][1], z);
      nor.push(0, 0, sign);
      uv.push(0.5, 0.5);
    }
    // bottom edge points so the cap closes down to the eave line
    for (let i = 0; i < N; i++) {
      if (sign > 0) idx.push(c, c + 1 + i, c + 2 + i);
      else idx.push(c, c + 2 + i, c + 1 + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Flat end-face shape (body rectangle + roof arc), UVs mapped x∈±HW, y∈FLOOR..ROOF_TOP. */
let faceGeo: THREE.BufferGeometry | null = null;
function faceGeometry(): THREE.BufferGeometry {
  if (faceGeo) return faceGeo;
  const shape = new THREE.Shape();
  shape.moveTo(-HW, FLOOR);
  shape.lineTo(HW, FLOOR);
  const N = 22;
  for (let i = 0; i <= N; i++) {
    const x = HW * Math.cos((i / N) * Math.PI);
    shape.lineTo(x, roofY(x));
  }
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (p.getX(i) + HW) / (2 * HW), (p.getY(i) - FLOOR) / (ROOF_TOP - FLOOR));
  }
  faceGeo = g;
  return g;
}

// ---------------------------------------------------------------------------
// Canvas art
// ---------------------------------------------------------------------------
type Ctx = CanvasRenderingContext2D;

function offscreen(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex: string, f: number): string {
  _c.set(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  _c.getHSL(hsl);
  _c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l * f)));
  return `#${_c.getHexString()}`;
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function star(ctx: Ctx, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.lineWidth = r * 0.35;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Bumpy cloud blob behind a piece. */
function blob(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, rand: () => number, fill: string): void {
  ctx.beginPath();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 0.86 + rand() * 0.22;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const am = ((i - 0.5) / n) * Math.PI * 2;
      ctx.quadraticCurveTo(cx + Math.cos(am) * rx * 1.18, cy + Math.sin(am) * ry * 1.18, x, y);
    }
  }
  ctx.closePath();
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
}

interface Glyph {
  ch: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
}

function layoutWord(ctx: Ctx, word: string, size: number, rand: () => number, wild: number): { glyphs: Glyph[]; width: number } {
  ctx.font = `900 ${size}px ${HEAVY_FONT}`;
  const glyphs: Glyph[] = [];
  let x = 0;
  for (const ch of word) {
    const m = ctx.measureText(ch).width || size * 0.7;
    const scale = 1 + (rand() - 0.4) * 0.3 * wild;
    glyphs.push({ ch, x: x + (m * scale) / 2, y: (rand() - 0.5) * size * 0.16 * wild, rot: (rand() - 0.5) * 0.36 * wild, scale });
    x += m * scale * 0.86;
  }
  return { glyphs, width: x };
}

function eachGlyph(ctx: Ctx, glyphs: Glyph[], ox: number, oy: number, fn: (g: Glyph) => void): void {
  for (const g of glyphs) {
    ctx.save();
    ctx.translate(ox + g.x, oy + g.y);
    ctx.rotate(g.rot);
    ctx.scale(g.scale, g.scale);
    fn(g);
    ctx.restore();
  }
}

/** Big wildstyle-ish "burner" piece centred at (cx, cy). */
function burner(ctx: Ctx, word: string, cx: number, cy: number, maxW: number, size: number, rand: () => number): void {
  const [c1, c2, c3] = [pick(rand, ACCENTS), pick(rand, ACCENTS), pick(rand, ACCENTS)];
  const hi = rand() < 0.5 ? '#F4F4F4' : pick(rand, ACCENTS);
  const lay = layoutWord(ctx, word, size, rand, 1);
  const sx = Math.min(1.3, maxW / lay.width);
  const pad = size * 0.5;
  const w = Math.ceil(lay.width * sx + pad * 2);
  const h = Math.ceil(size * 1.9);
  // fills on their own layer, so patterns can be clipped to the letters
  const fillLayer = offscreen(w, h);
  const fctx = fillLayer.ctx;
  fctx.textAlign = 'center';
  fctx.textBaseline = 'middle';
  fctx.font = `900 ${size}px ${HEAVY_FONT}`;
  fctx.save();
  fctx.translate(pad, h / 2);
  fctx.scale(sx, 1);
  eachGlyph(fctx, lay.glyphs, 0, 0, (g) => {
    const grad = fctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
    grad.addColorStop(0, c1);
    grad.addColorStop(0.55, c1);
    grad.addColorStop(0.56, c2);
    grad.addColorStop(1, c2);
    fctx.fillStyle = grad;
    fctx.fillText(g.ch, 0, 0);
  });
  fctx.restore();
  // pattern on letters: bubbles + shine stripe
  fctx.globalCompositeOperation = 'source-atop';
  fctx.fillStyle = shade(c2, 1.25);
  for (let i = 0; i < 26; i++) {
    fctx.beginPath();
    fctx.arc(rand() * w, h * 0.55 + rand() * h * 0.4, 3 + rand() * size * 0.07, 0, Math.PI * 2);
    fctx.fill();
  }
  fctx.fillStyle = 'rgba(255,255,255,0.55)';
  fctx.fillRect(0, h / 2 - size * 0.34, w, size * 0.06);
  fctx.fillStyle = c3;
  fctx.globalAlpha = 0.85;
  for (let i = 0; i < 3; i++) {
    const y = h / 2 - size * 0.1 + i * size * 0.13;
    fctx.fillRect(0, y, w, size * 0.03);
  }
  fctx.globalAlpha = 1;
  fctx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.translate(cx - w / 2, cy - h / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = `900 ${size}px ${HEAVY_FONT}`;
  ctx.save();
  ctx.translate(pad, h / 2);
  ctx.scale(sx, 1);
  // 3D block shadow
  const depth = Math.round(size * 0.14);
  ctx.fillStyle = shade(c3, 0.45);
  ctx.strokeStyle = shade(c3, 0.45);
  ctx.lineWidth = size * 0.2;
  for (let k = depth; k > 0; k -= 2) {
    eachGlyph(ctx, lay.glyphs, k, k, (g) => {
      ctx.strokeText(g.ch, 0, 0);
      ctx.fillText(g.ch, 0, 0);
    });
  }
  // thick outline, then highlight rim
  ctx.strokeStyle = INK;
  ctx.lineWidth = size * 0.3;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.strokeText(g.ch, 0, 0));
  ctx.strokeStyle = hi;
  ctx.lineWidth = size * 0.17;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.strokeText(g.ch, 0, 0));
  ctx.strokeStyle = INK;
  ctx.lineWidth = size * 0.06;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.strokeText(g.ch, 0, 0));
  ctx.restore();
  ctx.drawImage(fillLayer.canvas, 0, 0);
  ctx.restore();

  // arrows and sparkles
  const ax = cx + (lay.width * sx) / 2 + size * 0.1;
  ctx.save();
  ctx.translate(ax, cy - size * 0.25);
  ctx.rotate(-0.5);
  ctx.beginPath();
  ctx.moveTo(-size * 0.3, size * 0.06);
  ctx.lineTo(size * 0.15, size * 0.06);
  ctx.lineTo(size * 0.15, size * 0.18);
  ctx.lineTo(size * 0.42, 0);
  ctx.lineTo(size * 0.15, -size * 0.18);
  ctx.lineTo(size * 0.15, -size * 0.06);
  ctx.lineTo(-size * 0.3, -size * 0.06);
  ctx.closePath();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = c3;
  ctx.fill();
  ctx.restore();
  for (let i = 0; i < 3; i++) {
    star(ctx, cx + (rand() - 0.5) * lay.width * sx, cy - size * (0.55 + rand() * 0.2), size * (0.09 + rand() * 0.06), '#F4F4F4');
  }
}

/** Bubbly two-tone throw-up. */
function throwUp(ctx: Ctx, word: string, cx: number, cy: number, size: number, rand: () => number): void {
  const fill = rand() < 0.5 ? '#E8ECEF' : pick(rand, ACCENTS);
  const rim = pick(rand, ACCENTS);
  const lay = layoutWord(ctx, word, size, rand, 0.6);
  ctx.save();
  ctx.translate(cx - lay.width / 2, cy);
  ctx.rotate((rand() - 0.5) * 0.15);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = `900 ${size}px ${HEAVY_FONT}`;
  ctx.strokeStyle = rim;
  ctx.lineWidth = size * 0.42;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.strokeText(g.ch, 0, 0));
  ctx.strokeStyle = INK;
  ctx.lineWidth = size * 0.22;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.strokeText(g.ch, 0, 0));
  ctx.fillStyle = fill;
  eachGlyph(ctx, lay.glyphs, 0, 0, (g) => ctx.fillText(g.ch, 0, 0));
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  eachGlyph(ctx, lay.glyphs, 0, 0, () => {
    ctx.beginPath();
    ctx.ellipse(-size * 0.12, -size * 0.2, size * 0.08, size * 0.04, -0.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

/** Loose handstyle tag with an underline flick. */
function tag(ctx: Ctx, word: string, x: number, y: number, size: number, rand: () => number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rand() - 0.5) * 0.35);
  ctx.transform(1, 0, -0.35, 1, 0, 0);
  ctx.font = `bold ${size}px "Ubuntu", "DejaVu Sans", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const col = rand() < 0.35 ? INK : pick(rand, ACCENTS);
  const w = ctx.measureText(word).width || size * word.length * 0.5;
  if (col !== INK) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = size * 0.18;
    ctx.strokeText(word, 0, 0);
  }
  ctx.fillStyle = col;
  ctx.fillText(word, 0, 0);
  ctx.strokeStyle = col === INK ? INK : col;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.beginPath();
  ctx.moveTo(-size * 0.1, size * 0.55);
  ctx.quadraticCurveTo(w * 0.5, size * 0.85, w + size * 0.3, size * 0.25);
  ctx.stroke();
  // drips
  ctx.fillStyle = col;
  for (let i = 0; i < 3; i++) {
    const dx = rand() * w;
    ctx.fillRect(dx, size * 0.2, Math.max(2, size * 0.06), size * (0.3 + rand() * 0.6));
  }
  ctx.restore();
}

function sticker(ctx: Ctx, x: number, y: number, s: number, rand: () => number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rand() - 0.5) * 0.6);
  ctx.fillStyle = '#F4F4F4';
  ctx.fillRect(-s, -s * 0.6, s * 2, s * 1.2);
  ctx.fillStyle = pick(rand, [RED, '#2F80C9', '#3FB27F']);
  ctx.fillRect(-s, -s * 0.6, s * 2, s * 0.45);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, s * 0.25);
  ctx.quadraticCurveTo(0, -s * 0.1, s * 0.7, s * 0.3);
  ctx.stroke();
  ctx.restore();
}

const BURNERS = ['BOMBAY', 'CHALO', 'JUGAAD', 'BINDAAS', 'DHOOM', 'TAPORI', 'DABBA', 'ZOOM'];
const THROWS = ['OK', 'BKC', 'ZIP', 'YO', 'MH', 'RAJ', 'SUP', 'K47'];
const TAGS = ['aamchi', 'rafta', 'bhai', 'ek no.', 'zing', 'sona', 'fast', 'dadar', 'ok boss', 'kurla', 'sk8', 'bhidu'];

/** Metres (coach y) → canvas y for the side texture. */
const sideY = (m: number, h: number) => ((EAVE - m) / (EAVE - FLOOR)) * h;

function doorSegments(): [number, number][] {
  const half = DOOR_W_FR / 2;
  return [
    [0, DOOR_FR[0] - half],
    [DOOR_FR[0] + half, DOOR_FR[1] - half],
    [DOOR_FR[1] + half, 1],
  ];
}

function drawWindows(ctx: Ctx, w: number, h: number, livery: Livery, rand: () => number): void {
  const pxm = w / TEX_REF_LEN;
  const top = sideY(2.62, h);
  const bot = sideY(1.99, h);
  for (const [a, b] of doorSegments()) {
    const segM = (b - a) * TEX_REF_LEN;
    const margin = 0.28;
    const winW = 1.08;
    const pillar = 0.2;
    const count = Math.max(1, Math.floor((segM - 2 * margin + pillar) / (winW + pillar)));
    const used = count * winW + (count - 1) * pillar;
    let x = a * w + ((segM - used) / 2) * pxm;
    for (let i = 0; i < count; i++) {
      const ww = winW * pxm;
      // frame
      ctx.fillStyle = '#D6D9DC';
      roundRect(ctx, x - 5, top - 5, ww + 10, bot - top + 10, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // interior
      const g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, '#2E3C4C');
      g.addColorStop(1, '#141B24');
      ctx.fillStyle = g;
      roundRect(ctx, x, top, ww, bot - top, 9);
      ctx.fill();
      // passengers
      ctx.fillStyle = '#0B1017';
      const heads = Math.floor(rand() * 4);
      for (let k = 0; k < heads; k++) {
        const hx = x + 14 + rand() * (ww - 28);
        const hy = top + (bot - top) * (0.45 + rand() * 0.15);
        ctx.beginPath();
        ctx.arc(hx, hy, 11, 0, Math.PI * 2);
        ctx.fill();
        roundRect(ctx, hx - 20, hy + 9, 40, bot - hy, 10);
        ctx.fill();
      }
      // glass sheen
      ctx.fillStyle = 'rgba(160,210,255,0.13)';
      ctx.beginPath();
      ctx.moveTo(x + ww * 0.15, top);
      ctx.lineTo(x + ww * 0.4, top);
      ctx.lineTo(x + ww * 0.2, bot);
      ctx.lineTo(x, bot);
      ctx.lineTo(x, top + 10);
      ctx.fill();
      // horizontal bars
      const bars = 5;
      for (let k = 1; k <= bars; k++) {
        const by = top + ((bot - top) * k) / (bars + 1);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x, by + 2, ww, 2);
        ctx.fillStyle = '#C9CED3';
        ctx.fillRect(x, by - 2, ww, 4);
      }
      ctx.fillStyle = '#C9CED3';
      ctx.fillRect(x + ww / 2 - 3, top, 6, bot - top);
      x += (winW + pillar) * pxm;
    }
  }
  void livery;
}

function drawSide(ctx: Ctx, w: number, h: number, livery: Livery, variant: number): void {
  const L = LIVERY[livery];
  const rand = seededRandom(9001 + variant * 131 + (livery === 'central' ? 7777 : 0));
  const pxm = w / TEX_REF_LEN;
  // base paint with a soft vertical light gradient
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, shade(L.body, 1.04));
  base.addColorStop(0.6, L.body);
  base.addColorStop(1, shade(L.body, 0.86));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  // panel seams + rivets
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let x = 0; x < w; x += pxm * 1.3) ctx.fillRect(x, 0, 2, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let x = 6; x < w; x += 24) {
    ctx.fillRect(x, sideY(1.1, h), 3, 3);
    ctx.fillRect(x, sideY(2.8, h), 3, 3);
  }
  // upper thin band and waist band
  ctx.fillStyle = L.band;
  ctx.fillRect(0, sideY(2.69, h), w, sideY(2.65, h) - sideY(2.69, h));
  const wbTop = sideY(1.97, h);
  const wbBot = sideY(1.78, h);
  ctx.fillRect(0, wbTop, w, wbBot - wbTop);
  ctx.fillStyle = L.dark;
  ctx.fillRect(0, wbBot - 5, w, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(0, wbTop, w, 3);
  // coach number stencils
  ctx.fillStyle = L.dark;
  ctx.font = `bold 20px "DejaVu Sans Mono", monospace`;
  for (const f of [0.1, 0.9]) ctx.fillText(`${L.code} ${5000 + variant * 37 + Math.round(f * 10)}`, f * w - 50, sideY(2.74, h));
  // grime at the bottom
  const grime = ctx.createLinearGradient(0, sideY(1.35, h), 0, h);
  grime.addColorStop(0, 'rgba(60,45,30,0)');
  grime.addColorStop(1, 'rgba(60,45,30,0.45)');
  ctx.fillStyle = grime;
  ctx.fillRect(0, sideY(1.35, h), w, h);

  // --- graffiti (lower panel, may spill over the waist band) ---
  const gTop = sideY(1.9, h);
  const gBot = sideY(1.02, h);
  const gMid = (gTop + gBot) / 2;
  const gH = gBot - gTop;
  const segs = doorSegments();
  const mid = segs[1];
  // background fill-in blobs for coverage
  blob(ctx, ((mid[0] + mid[1]) / 2) * w, gMid, (mid[1] - mid[0]) * w * 0.46, gH * 0.5, rand, shade(pick(rand, ACCENTS), 0.75));
  const word = BURNERS[(variant * 3 + (livery === 'central' ? 1 : 0)) % BURNERS.length];
  burner(ctx, word, ((mid[0] + mid[1]) / 2) * w, gMid + 4, (mid[1] - mid[0]) * w * 0.8, gH * 0.9, rand);
  // end segments: throw-ups
  for (const s of [segs[0], segs[2]]) {
    const cx = ((s[0] + s[1]) / 2) * w;
    const sw = (s[1] - s[0]) * w;
    if (rand() < 0.5) blob(ctx, cx, gMid, sw * 0.42, gH * 0.42, rand, pick(rand, ACCENTS));
    throwUp(ctx, pick(rand, THROWS), cx, gMid, gH * 0.62, rand);
  }
  // tags and stickers scattered over the lower panel and bands
  for (let i = 0; i < 16; i++) {
    tag(ctx, pick(rand, TAGS), rand() * w, gTop + rand() * gH, 18 + rand() * 18, rand);
  }
  for (let i = 0; i < 7; i++) sticker(ctx, rand() * w, sideY(1.2 + rand() * 1.4, h), 10 + rand() * 6, rand);
  // paint drips from the burner
  ctx.fillStyle = 'rgba(20,20,20,0.6)';
  for (let i = 0; i < 20; i++) {
    const x = (mid[0] + rand() * (mid[1] - mid[0])) * w;
    ctx.fillRect(x, gMid + gH * 0.3, 3, gH * (0.1 + rand() * 0.25));
  }

  // --- windows on top so they stay clean ---
  drawWindows(ctx, w, h, livery, rand);
  // gutter shadow + sole bar
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, w, 6);
  ctx.fillStyle = '#2E2E33';
  ctx.fillRect(0, sideY(1.02, h), w, h);
  // weathering
  streaks(ctx, w, h, rand, 140, 'rgba(50,40,30,0.12)');
  speckle(ctx, w, h, rand, 2600, ['rgba(40,30,20,0.25)', 'rgba(255,255,255,0.12)', 'rgba(120,70,40,0.2)'], 2);
}

function sideTexture(livery: Livery, variant: number): THREE.Texture {
  return canvasTexture(`train-side-${livery}-${variant}`, 2048, 320, (ctx, w, h) => drawSide(ctx, w, h, livery, variant), { anisotropy: 8 });
}

/** Maps face metres to canvas px for 512² end/cab textures. */
function faceXY(w: number, h: number) {
  return {
    fx: (m: number) => ((m + HW) / (2 * HW)) * w,
    fy: (m: number) => ((ROOF_TOP - m) / (ROOF_TOP - FLOOR)) * h,
  };
}

function ledText(ctx: Ctx, text: string, x: number, y: number, w: number, h: number, color: string): void {
  const cols = 72;
  const rows = 13;
  const small = offscreen(cols, rows);
  const s = small.ctx;
  s.fillStyle = '#fff';
  s.font = `bold 12px "DejaVu Sans Mono", "Liberation Mono", monospace`;
  s.textBaseline = 'middle';
  s.textAlign = 'center';
  const tw = s.measureText(text).width || cols;
  s.save();
  s.translate(cols / 2, rows / 2 + 0.5);
  s.scale(Math.min(1.25, (cols - 2) / tw), 1);
  s.fillText(text, 0, 0);
  s.restore();
  const img = s.getImageData(0, 0, cols, rows);
  const data = img?.data;
  const px = w / cols;
  const py = h / rows;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = data && typeof data[3] === 'number' ? data[(j * cols + i) * 4 + 3] : 0;
      ctx.fillStyle = a > 90 ? color : 'rgba(255,160,40,0.07)';
      ctx.beginPath();
      ctx.arc(x + (i + 0.5) * px, y + (j + 0.5) * py, Math.min(px, py) * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
}

function drawCab(ctx: Ctx, w: number, h: number, livery: Livery, station: string, idx: number): void {
  const L = LIVERY[livery];
  const rand = seededRandom(4242 + idx * 17 + (livery === 'central' ? 99 : 0));
  const { fx, fy } = faceXY(w, h);
  // yellow nose with rounded shading
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#E0A800');
  g.addColorStop(0.15, YELLOW);
  g.addColorStop(0.85, YELLOW);
  g.addColorStop(1, '#E0A800');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // livery band under windscreen and upper roof dome tint
  ctx.fillStyle = L.band;
  ctx.fillRect(0, fy(1.93), w, fy(1.8) - fy(1.93));
  ctx.fillStyle = L.dark;
  ctx.fillRect(0, fy(1.8) - 4, w, 4);
  // windscreen
  const wsTop = fy(2.68);
  const wsBot = fy(1.99);
  ctx.fillStyle = '#1E1E22';
  roundRect(ctx, fx(-0.98), wsTop - 8, fx(0.98) - fx(-0.98), wsBot - wsTop + 16, 18);
  ctx.fill();
  for (const [a, b] of [
    [-0.93, -0.05],
    [0.05, 0.93],
  ]) {
    const gl = ctx.createLinearGradient(0, wsTop, 0, wsBot);
    gl.addColorStop(0, '#3F7896');
    gl.addColorStop(1, '#122636');
    ctx.fillStyle = gl;
    roundRect(ctx, fx(a), wsTop, fx(b) - fx(a), wsBot - wsTop, 12);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    const x0 = fx(a);
    ctx.beginPath();
    ctx.moveTo(x0 + 30, wsTop);
    ctx.lineTo(x0 + 70, wsTop);
    ctx.lineTo(x0 + 20, wsBot);
    ctx.lineTo(x0 - 20, wsBot);
    ctx.fill();
    ctx.fillRect(x0 + 85, wsTop, 12, wsBot - wsTop);
    // motorman silhouette in the right pane
    if (a > 0) {
      ctx.fillStyle = 'rgba(5,10,15,0.7)';
      ctx.beginPath();
      ctx.arc(fx(0.5), wsBot - 50, 17, 0, Math.PI * 2);
      ctx.fill();
      roundRect(ctx, fx(0.5) - 34, wsBot - 34, 68, 40, 14);
      ctx.fill();
    }
    ctx.restore();
    // wiper
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(fx((a + b) / 2) - 10, wsBot - 4);
    ctx.lineTo(fx((a + b) / 2) - 50, wsTop + 30);
    ctx.stroke();
  }
  // destination board
  const bx = fx(-0.66);
  const by = fy(3.03);
  const bw = fx(0.66) - bx;
  const bh = fy(2.77) - by;
  ctx.fillStyle = '#2A2A2E';
  roundRect(ctx, bx - 6, by - 6, bw + 12, bh + 12, 8);
  ctx.fill();
  ctx.fillStyle = '#060607';
  ctx.fillRect(bx, by, bw, bh);
  const fast = idx % 2 === 0 ? 'F' : 'S';
  ctx.fillStyle = fast === 'F' ? RED : '#3FB27F';
  ctx.fillRect(bx + 4, by + 4, bh - 8, bh - 8);
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.round(bh * 0.7)}px ${HEAVY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fast, bx + bh / 2, by + bh / 2 + 2);
  ledText(ctx, station, bx + bh, by + 3, bw - bh - 4, bh - 6, '#FFA21F');
  // number + stencils
  ctx.fillStyle = INK;
  ctx.font = `bold 26px "DejaVu Sans Mono", monospace`;
  ctx.fillText(`${L.code} ${7100 + idx * 13}A`, w / 2, fy(1.62));
  // headlight surrounds
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#2A2A2E';
    ctx.beginPath();
    ctx.arc(fx(s * 0.72), fy(1.35), 42, 0, Math.PI * 2);
    ctx.fill();
  }
  // hazard chevrons along the bottom edge
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, fy(1.12), w, h - fy(1.12));
  ctx.clip();
  ctx.fillStyle = INK;
  for (let x = -40; x < w + 40; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + 20, h);
    ctx.lineTo(x + 50, fy(1.12));
    ctx.lineTo(x + 30, fy(1.12));
    ctx.fill();
  }
  ctx.restore();
  // a couple of tags + grime
  tag(ctx, pick(rand, TAGS), fx(-0.95), fy(1.62), 22, rand);
  if (rand() < 0.7) tag(ctx, pick(rand, TAGS), fx(0.35), fy(1.2), 20, rand);
  streaks(ctx, w, h, rand, 40, 'rgba(70,50,20,0.14)');
  speckle(ctx, w, h, rand, 700, ['rgba(60,40,10,0.25)', 'rgba(255,255,255,0.15)'], 2);
}

function cabTexture(livery: Livery, idx: number, station: string): THREE.Texture {
  const key = station === STATIONS[livery][idx] ? `train-cab-${livery}-${idx}` : `train-cab-${livery}-${idx}-${station}`;
  return canvasTexture(key, 512, 512, (ctx, w, h) => drawCab(ctx, w, h, livery, station, idx));
}

function drawEnd(ctx: Ctx, w: number, h: number, livery: Livery): void {
  const L = LIVERY[livery];
  const rand = seededRandom(livery === 'western' ? 31 : 32);
  const { fx, fy } = faceXY(w, h);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, shade(L.body, 0.82));
  g.addColorStop(0.2, L.body);
  g.addColorStop(0.8, L.body);
  g.addColorStop(1, shade(L.body, 0.82));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = shade(L.body, 0.8);
  ctx.fillRect(0, 0, w, fy(2.86));
  ctx.fillStyle = L.band;
  ctx.fillRect(0, fy(1.97), w, fy(1.78) - fy(1.97));
  ctx.fillRect(0, fy(2.69), w, fy(2.65) - fy(2.69));
  // graffiti on the lower end panel (behind the door)
  blob(ctx, fx(-0.7), fy(1.42), 70, 50, rand, pick(rand, ACCENTS));
  throwUp(ctx, pick(rand, THROWS), fx(-0.72), fy(1.42), 42, rand);
  throwUp(ctx, pick(rand, THROWS), fx(0.72), fy(1.5), 42, rand);
  // end gangway door
  const dx0 = fx(-0.36);
  const dx1 = fx(0.36);
  ctx.fillStyle = '#34353A';
  ctx.fillRect(dx0 - 8, fy(2.74), dx1 - dx0 + 16, h - fy(2.74));
  ctx.fillStyle = shade(L.body, 0.72);
  ctx.fillRect(dx0, fy(2.7), dx1 - dx0, h - fy(2.7));
  const wt = fy(2.52);
  const wb = fy(2.02);
  ctx.fillStyle = '#18202A';
  roundRect(ctx, dx0 + 16, wt, dx1 - dx0 - 32, wb - wt, 8);
  ctx.fill();
  ctx.fillStyle = '#C9CED3';
  for (let k = 1; k <= 4; k++) ctx.fillRect(dx0 + 16, wt + ((wb - wt) * k) / 5, dx1 - dx0 - 32, 4);
  tag(ctx, pick(rand, TAGS), dx0 + 10, fy(1.5), 24, rand);
  // side windows on the end
  for (const s of [-1, 1]) {
    const x = fx(s * 0.72);
    ctx.fillStyle = '#D6D9DC';
    roundRect(ctx, x - 44, wt - 4, 88, wb - wt + 8, 10);
    ctx.fill();
    ctx.fillStyle = '#18202A';
    roundRect(ctx, x - 38, wt + 2, 76, wb - wt - 4, 8);
    ctx.fill();
    ctx.fillStyle = '#C9CED3';
    for (let k = 1; k <= 4; k++) ctx.fillRect(x - 38, wt + ((wb - wt) * k) / 5, 76, 3);
    // tail lamp surround
    ctx.fillStyle = '#2A2A2E';
    ctx.beginPath();
    ctx.arc(fx(s * 0.8), fy(1.18), 22, 0, Math.PI * 2);
    ctx.fill();
  }
  // warning triangle
  ctx.fillStyle = YELLOW;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(fx(0.72), fy(2.83));
  ctx.lineTo(fx(0.72) + 22, fy(2.83) + 36);
  ctx.lineTo(fx(0.72) - 22, fy(2.83) + 36);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = L.dark;
  ctx.font = `bold 22px "DejaVu Sans Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`${L.code} 5${livery === 'western' ? 214 : 588}`, fx(-0.7), fy(2.74));
  streaks(ctx, w, h, rand, 50, 'rgba(50,40,30,0.15)');
  speckle(ctx, w, h, rand, 900, ['rgba(40,30,20,0.25)', 'rgba(255,255,255,0.12)'], 2);
}

function endTexture(livery: Livery): THREE.Texture {
  return canvasTexture(`train-end-${livery}`, 512, 512, (ctx, w, h) => drawEnd(ctx, w, h, livery));
}

// ---------------------------------------------------------------------------
// Materials (module-level caches)
// ---------------------------------------------------------------------------
const matCache = new Map<string, THREE.Material>();
function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) matCache.set(key, (m = make()));
  return m;
}
const bodyMaterial = () => cachedMat('body', () => toonMaterial({ vertexColors: true }));
const sideMaterial = (livery: Livery, variant: number, tint: boolean) =>
  cachedMat(`side-${livery}-${variant}-${tint}`, () => toonMaterial({ map: sideTexture(livery, variant), color: tint ? LIVERY[livery].tint : 0xffffff }));
const cabMaterial = (livery: Livery, idx: number, station = STATIONS[livery][idx]) =>
  cachedMat(`cab-${livery}-${idx}-${station}`, () => toonMaterial({ map: cabTexture(livery, idx, station) }));
const endMaterial = (livery: Livery) => cachedMat(`end-${livery}`, () => toonMaterial({ map: endTexture(livery) }));
const headlightMaterial = () => cachedMat('headlight', () => toonMaterial({ color: 0xfff6d0, emissive: 0xfff1b0, emissiveIntensity: 2.2 }));
const taillightMaterial = () => cachedMat('taillight', () => toonMaterial({ color: 0xff4030, emissive: 0xff2010, emissiveIntensity: 1.4 }));

// ---------------------------------------------------------------------------
// Coach geometry
// ---------------------------------------------------------------------------
interface CoachSpec {
  len: number;
  livery: Livery;
  cab: boolean;
  panto: boolean;
  first: boolean;
  tint: boolean;
  frontGang: boolean;
  rearGang: boolean;
  nearEnd: boolean;
  farEnd: boolean;
}

interface CoachGeos {
  side: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry | null;
}

function tinted(hex: string, tint: boolean, livery: Livery): THREE.Color {
  const c = new THREE.Color(hex);
  if (tint) c.multiply(new THREE.Color(LIVERY[livery].tint));
  return c;
}

/** Side panel box with UVs mapped over the whole coach side. */
function sidePanel(out: THREE.BufferGeometry[], side: number, z0: number, z1: number, y0: number, y1: number, L: number): void {
  const t = 0.12;
  const g = prepare(unitBoxFor(z1 - z0));
  g.applyMatrix4(_m.compose(_p.set(side * (HW - t / 2), (y0 + y1) / 2, (z0 + z1) / 2), _q.identity(), _s.set(t, y1 - y0, Math.abs(z1 - z0))));
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const f = -p.getZ(i) / L;
    uv.setXY(i, side > 0 ? f : 1 - f, (p.getY(i) - FLOOR) / (EAVE - FLOOR));
  }
  out.push(g);
}

const coachCache = new Map<string, CoachGeos>();

function coachGeos(spec: CoachSpec): CoachGeos {
  const key = `${spec.len.toFixed(2)}|${spec.livery}|${spec.cab}|${spec.panto}|${spec.first}|${spec.tint}|${spec.frontGang}|${spec.rearGang}|${spec.nearEnd}|${spec.farEnd}`;
  const hit = coachCache.get(key);
  if (hit) return hit;

  const L = spec.len;
  const liv = LIVERY[spec.livery];
  const bodyCol = tinted(liv.body, spec.tint, spec.livery);
  const bandCol = new THREE.Color(liv.band);
  const body = new Parts();
  const detail = new Parts();
  const lamps = new Parts();
  const sides: THREE.BufferGeometry[] = [];
  const mid = (FLOOR + EAVE) / 2;
  const zStart = spec.cab ? -CAB_D + 0.02 : 0;

  // --- shell ---
  body.box(2 * CORE_HW, EAVE - FLOOR, L, 0, mid, -L / 2, '#2B2A31');
  if (!spec.cab) body.box(2 * HW - 0.04, EAVE - FLOOR, 0.05, 0, mid, -0.025, bodyCol);
  body.box(2 * HW - 0.04, EAVE - FLOOR, 0.05, 0, mid, -L + 0.025, bodyCol);

  const doorW = Math.min(1.6, Math.max(1.05, DOOR_W_FR * L));
  const doors = DOOR_FR.map((f) => -f * L);
  const edges = [zStart, doors[0] + doorW / 2, doors[0] - doorW / 2, doors[1] + doorW / 2, doors[1] - doorW / 2, -L];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) sidePanel(sides, s, edges[k * 2], edges[k * 2 + 1], FLOOR, EAVE, L);
    for (const dz of doors) {
      sidePanel(sides, s, dz + doorW / 2, dz - doorW / 2, DOOR_TOP, EAVE, L);
      // door frame
      const fx = s * (HW - 0.045);
      for (const e of [-1, 1]) body.box(0.11, DOOR_TOP - FLOOR + 0.04, 0.07, fx + s * 0.01, (FLOOR + DOOR_TOP) / 2, dz + e * (doorW / 2 - 0.02), bandCol);
      body.box(0.11, 0.07, doorW, fx + s * 0.01, DOOR_TOP, dz, bandCol);
      // floor tread + step
      body.box(HW - CORE_HW, 0.04, doorW, s * (CORE_HW + (HW - CORE_HW) / 2), FLOOR + 0.02, dz, '#7B8086');
      body.box(0.1, 0.05, doorW * 0.8, s * (HW - 0.06), FLOOR - 0.16, dz, '#55595F');
      // half-open sliding leaf
      const leafW = doorW * 0.34;
      const lz = dz + doorW / 2 - leafW / 2 - 0.04;
      body.box(0.05, DOOR_TOP - FLOOR - 0.05, leafW, s * (CORE_HW + 0.03), (FLOOR + DOOR_TOP) / 2, lz, bodyCol);
      detail.box(0.02, 0.5, leafW * 0.7, s * (CORE_HW + 0.06), 2.3, lz, '#18202A');
      // grab pole
      detail.cyl(0.028, DOOR_TOP - FLOOR, s * (CORE_HW + 0.07), (FLOOR + DOOR_TOP) / 2, dz - 0.05, '#D5DADF', undefined, 8);
      // dim interior: a seat back and a handhold bar
      detail.box(0.02, 0.35, doorW * 0.5, s * (CORE_HW + 0.005), 1.5, dz - doorW * 0.12, '#4A3B6B');
    }
    // rain gutter and roof edge
    body.box(0.06, 0.05, L - (spec.cab ? CAB_D : 0), s * (HW - 0.02), EAVE + 0.02, (zStart - L) / 2, '#50555B');
    // window ledge (chunky trim under the window band)
    body.box(0.03, 0.03, L + zStart, s * (HW + 0.005), 1.975, (zStart - L) / 2, shade(liv.band, 0.8));
    // first-class stripe
    if (spec.first) body.box(0.02, 0.09, L - (spec.cab ? CAB_D : 0) - 0.3, s * (HW + 0.005), 2.77, (zStart - L) / 2, RED);
  }

  // --- roof ---
  body.add(roofGeometry(zStart, -L), '#8E959A', [0, 0, 0]);
  body.box(0.5, 0.025, L - 1.0 + zStart, 0, ROOF_TOP - 0.005, (zStart - L) / 2, '#6A7075');
  const pz = -2.3;
  const skip = (z: number) => spec.panto && z > pz - 1.3 && z < pz + 1.1;
  for (let z = zStart - 1.1; z > -L + 0.9; z -= 1.55) {
    if (skip(z)) continue;
    for (const x of [-0.46, 0.46]) {
      const y = roofY(x);
      body.cyl(0.13, 0.14, x, y + 0.03, z, '#737A80', undefined, 10);
      body.cyl(0.18, 0.06, x, y + 0.12, z, '#A4ABB0', undefined, 10, 0.75);
    }
  }
  for (let z = zStart - 2.6; z > -L + 2; z -= 3.6) {
    if (skip(z)) continue;
    body.box(0.62, 0.16, 0.95, 0, ROOF_TOP + 0.07, z, '#A9B0B5');
    detail.box(0.46, 0.02, 0.75, 0, ROOF_TOP + 0.16, z, '#3C4046');
  }
  if (spec.panto) {
    const ry = ROOF_TOP;
    for (const x of [-0.42, 0.42]) {
      for (const dz of [-0.36, 0.36]) {
        body.cyl(0.06, 0.2, x, ry + 0.1, pz + dz, '#EDE6D6', undefined, 8);
        body.cyl(0.08, 0.03, x, ry + 0.08, pz + dz, '#8A5A3C', undefined, 8);
      }
    }
    body.box(1.05, 0.06, 0.95, 0, ry + 0.23, pz, '#3A3D42');
    const hinge: V3 = [0, ry + 0.26, pz + 0.35];
    const knee: V3 = [0, ry + 0.5, pz - 0.6];
    const head: V3 = [0, ry + 0.6, pz + 0.05];
    for (const x of [-0.18, 0.18]) body.bar([x, hinge[1], hinge[2]], [x * 0.4, knee[1], knee[2]], 0.05, '#C8CDD2');
    body.bar(knee, head, 0.045, '#C8CDD2');
    body.bar([0, ry + 0.27, pz - 0.2], [0, ry + 0.42, pz - 0.4], 0.07, '#2B2D31');
    body.box(1.4, 0.05, 0.14, 0, head[1] + 0.02, head[2], '#2B2D31');
    detail.box(1.1, 0.02, 0.06, 0, head[1] + 0.055, head[2], '#B87333');
    for (const s of [-1, 1]) body.bar([s * 0.7, head[1] + 0.02, head[2]], [s * 0.86, head[1] - 0.1, head[2]], 0.04, '#2B2D31');
    // roof conduit
    detail.bar([0.28, ry + 0.02, pz - 0.5], [0.28, ry + 0.02, -L + 1.2], 0.05, '#5A5F66', 6);
  }

  // --- underframe (reads solid down to rail level) ---
  body.box(1.86, FLOOR - 0.18, L - 0.5, 0, (FLOOR + 0.18) / 2, -L / 2, '#26262B');
  body.box(2 * HW - 0.06, 0.12, L - 0.1, 0, FLOOR - 0.06, -L / 2, '#3A3C42');
  const bogies = [-2.0, -L + 2.0];
  const boxZ0 = -3.5;
  const boxZ1 = -L + 3.5;
  const eq = ['#4B4F55', '#5D6167', '#3F4A52', '#4E4A45'];
  const nb = Math.max(1, Math.round((boxZ0 - boxZ1) / 2.2));
  const span = (boxZ0 - boxZ1) / nb;
  for (let i = 0; i < nb; i++) {
    const zc = boxZ0 - span * (i + 0.5);
    const hgt = 0.36 + ((i * 7) % 3) * 0.08;
    body.box(1.98, hgt, span * 0.78, 0, FLOOR - 0.12 - hgt / 2, zc, eq[i % eq.length]);
    detail.box(2.0, 0.03, span * 0.6, 0, FLOOR - 0.12 - hgt * 0.35, zc, '#2A2C30');
  }
  for (const zb of bogies) {
    for (const s of [-1, 1]) {
      body.box(0.1, 0.2, 2.7, s * 1.03, 0.5, zb, '#33353A');
      body.box(0.12, 0.08, 2.9, s * 1.03, 0.64, zb, '#44474D');
      for (const dz of [-0.85, 0.85]) {
        body.cyl(0.43, 0.1, s * 0.91, 0.43, zb + dz, '#24252A', [0, 0, Math.PI / 2], 16);
        body.cyl(0.26, 0.12, s * 0.91, 0.43, zb + dz, '#8A9098', [0, 0, Math.PI / 2], 12);
        body.cyl(0.09, 0.2, s * 0.99, 0.43, zb + dz, '#2A2C30', [0, 0, Math.PI / 2], 8);
        body.box(0.16, 0.22, 0.32, s * 1.04, 0.43, zb + dz, '#2A2C30');
      }
      for (const dz of [-0.35, 0.35]) body.cyl(0.1, 0.2, s * 1.03, 0.78, zb + dz, '#C1622B', undefined, 10);
    }
    body.box(1.9, 0.2, 0.5, 0, 0.55, zb, '#303238');
  }

  // --- gangways / couplers (halves meet between coaches) ---
  const gang = (z0: number, z1: number) => {
    const zc = (z0 + z1) / 2;
    const d = Math.abs(z1 - z0);
    body.box(1.3, 1.66, d, 0, 1.86, zc, '#232327');
    for (let k = 0; k < 2; k++) detail.box(1.36, 1.7, 0.04, 0, 1.86, z0 + Math.sign(z1 - z0) * (0.05 + k * 0.07), '#3A3A40');
    body.box(0.26, 0.2, d, 0, 0.78, zc, '#1C1C20');
  };
  if (spec.frontGang) gang(0, GAP / 2);
  if (spec.rearGang) gang(-L, -L - GAP / 2);

  // --- exposed coach ends: buffer beam, door frame, handles ---
  const endKit = (zf: number, dir: number) => {
    bufferBeam(body, detail, zf, dir);
    const fz = zf + dir * 0.03;
    for (const x of [-0.4, 0.4]) body.box(0.07, DOOR_TOP - FLOOR, 0.06, x, (FLOOR + DOOR_TOP) / 2, fz, '#3A3C42');
    body.box(0.87, 0.07, 0.06, 0, DOOR_TOP + 0.02, fz, '#3A3C42');
    for (const x of [-0.52, 0.52]) detail.cyl(0.02, 0.9, x, 1.7, zf + dir * 0.06, '#D5DADF', undefined, 6);
    body.box(2 * HW - 0.1, 0.05, 0.08, 0, EAVE + 0.03, zf + dir * 0.02, '#50555B');
    // rubber gangway pad
    body.box(0.95, 0.12, 0.08, 0, FLOOR + 0.06, zf + dir * 0.03, '#1C1C20');
  };
  if (spec.nearEnd) endKit(0, 1);
  if (spec.farEnd) endKit(-L, -1);

  // --- cab nose (faces +z) ---
  if (spec.cab) {
    body.box(2 * HW, EAVE - FLOOR, CAB_D, 0, mid, -CAB_D / 2, YELLOW);
    body.add(roofGeometry(0, -CAB_D + 0.02), YELLOW, [0, 0, 0]);
    // visor over the windscreen
    body.box(2.0, 0.05, 0.14, 0, 2.74, 0.05, '#232327');
    // cab side windows
    for (const s of [-1, 1]) detail.box(0.02, 0.55, 0.32, s * (HW + 0.005), 2.3, -0.28, '#1C2533');
    // headlights
    for (const s of [-1, 1]) {
      body.cyl(0.16, 0.12, s * 0.72, 1.35, 0.05, '#2A2A2E', [Math.PI / 2, 0, 0], 16);
      lamps.cyl(0.115, 0.06, s * 0.72, 1.35, 0.1, '#ffffff', [Math.PI / 2, 0, 0], 16);
      lamps.cyl(0.045, 0.04, s * 0.84, 2.95, 0.02, '#ffffff', [Math.PI / 2, 0, 0], 8);
      detail.cyl(0.02, 0.62, s * 1.04, 2.28, 0.03, '#D5DADF', undefined, 6);
    }
    bufferBeam(body, detail, 0, 1);
    body.box(1.8, 0.34, 0.1, 0, 0.36, -0.08, '#3A3C42', [-0.25, 0, 0]);
    // horns on the roof
    for (const s of [-1, 1]) detail.cyl(0.04, 0.26, s * 0.3, ROOF_TOP + 0.03, -0.35, '#2A2A2E', [Math.PI / 2, 0, 0], 8, 1.6);
  }

  const out: CoachGeos = {
    side: (() => {
      const m = mergeGeometries(sides, false);
      for (const g of sides) g.dispose();
      return m;
    })(),
    body: body.build(),
    detail: detail.build(),
    lamps: lamps.geos.length ? lamps.build() : null,
  };
  if (coachCache.size < 64) coachCache.set(key, out);
  return out;
}

/** Buffer beam with hazard stripes, two buffers and a coupler, facing dir (±1) at z = zf. */
function bufferBeam(body: Parts, detail: Parts, zf: number, dir: number): void {
  body.box(2.12, 0.34, 0.3, 0, 0.74, zf - dir * 0.15 + dir * 0.03, '#2B2B30');
  for (let i = 0; i < 8; i++) detail.box(0.25, 0.3, 0.02, -0.92 + i * 0.263, 0.74, zf + dir * 0.04, i % 2 ? INK : YELLOW);
  for (const s of [-1, 1]) {
    body.cyl(0.08, 0.2, s * 0.78, 0.74, zf + dir * 0.1, '#1F2024', [Math.PI / 2, 0, 0], 10);
    body.cyl(0.15, 0.04, s * 0.78, 0.74, zf + dir * 0.2, '#3A3C42', [Math.PI / 2, 0, 0], 12);
  }
  body.box(0.24, 0.2, 0.3, 0, 0.6, zf + dir * 0.05, '#1C1C20');
  body.box(0.12, 0.12, 0.2, 0.3, 0.5, zf + dir * 0.02, '#1C1C20');
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, noOutline = false): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  if (noOutline) m.userData.noOutline = true;
  return m;
}

/** Parked coach (or a coupled run of coaches) filling `length` metres; near end at z=0, extending to -z; solid body fills y 0..3.2, width ≤ 2.3. */
export function buildTrain(
  length: number,
  opts: {
    livery: Livery;
    seed: number;
    oncoming?: boolean;
    /** Front destination board choices (e.g. a suburban line's termini); default per livery. */
    destinations?: readonly string[];
  },
): THREE.Group {
  const { livery, seed } = opts;
  const oncoming = !!opts.oncoming;
  const rand = seededRandom(seed * 7919 + 17);
  let n = Math.max(1, Math.round(length / 13));
  while ((length - (n - 1) * GAP) / n > 15.5) n++;
  while (n > 1 && (length - (n - 1) * GAP) / n < 9.5) n--;
  const per = (length - (n - 1) * GAP) / n;
  const pantoIdx = Math.floor(rand() * n);
  const group = new THREE.Group();
  group.name = oncoming ? 'train-oncoming' : 'train';
  const baseVariant = Math.abs(Math.floor(seed)) % GRAFFITI_VARIANTS;

  for (let i = 0; i < n; i++) {
    const spec: CoachSpec = {
      len: per,
      livery,
      cab: oncoming && i === 0,
      panto: i === pantoIdx || rand() < 0.2,
      first: rand() < 0.4,
      tint: oncoming,
      frontGang: i > 0,
      rearGang: i < n - 1,
      nearEnd: i === 0 && !oncoming,
      farEnd: i === n - 1,
    };
    const geos = coachGeos(spec);
    const coach = new THREE.Group();
    coach.position.z = -i * (per + GAP);
    const variant = (baseVariant + i * 3) % GRAFFITI_VARIANTS;
    coach.add(mesh(geos.side, sideMaterial(livery, variant, oncoming)));
    coach.add(mesh(geos.body, bodyMaterial()));
    coach.add(mesh(geos.detail, bodyMaterial(), true));
    if (geos.lamps) coach.add(mesh(geos.lamps, headlightMaterial(), true));
    group.add(coach);
  }

  // textured end faces
  const cabIdx = Math.abs(Math.floor(seed)) % 3;
  const dests = opts.destinations?.length ? opts.destinations : null;
  const dest = dests ? dests[Math.abs(Math.floor(seed)) % dests.length] : STATIONS[livery][cabIdx];
  const nearFace = oncoming ? mesh(faceGeometry(), cabMaterial(livery, cabIdx, dest), true) : mesh(faceGeometry(), endMaterial(livery), true);
  nearFace.position.z = 0.004;
  group.add(nearFace);
  if (!oncoming) {
    group.add(mesh(tailGeometry(), taillightMaterial(), true));
  }
  const farFace = mesh(faceGeometry(), endMaterial(livery), true);
  farFace.rotation.y = Math.PI;
  farFace.position.z = -length - 0.004;
  group.add(farFace);

  addOutline(group, 0.035);
  enableShadows(group);
  return group;
}

let tailGeo: THREE.BufferGeometry | null = null;
function tailGeometry(): THREE.BufferGeometry {
  if (tailGeo) return tailGeo;
  const tail = new Parts();
  for (const s of [-1, 1]) tail.cyl(0.07, 0.05, s * 0.8, 1.18, 0.02, '#ffffff', [Math.PI / 2, 0, 0], 10);
  return (tailGeo = tail.build());
}

// ---------------------------------------------------------------------------
// Ramp
// ---------------------------------------------------------------------------
const RAMP_RISE = 7;
const RAMP_LEN = 8;
const RAMP_W = 2.0; // deck width; curbs/rails bring the total to ~2.2
const SLOPE = ROOF_TOP / RAMP_RISE;
const DECK_T = 0.2;

function hazardTexture(): THREE.Texture {
  return canvasTexture(
    'ramp-hazard',
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = YELLOW;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = INK;
      for (let k = -2; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo(k * w, h);
        ctx.lineTo(k * w + w / 2, h);
        ctx.lineTo(k * w + w, 0);
        ctx.lineTo(k * w + w / 2, 0);
        ctx.fill();
      }
      const rand = seededRandom(5);
      speckle(ctx, w, h, rand, 160, ['rgba(0,0,0,0.25)', 'rgba(255,255,255,0.2)'], 2);
    },
    { repeat: true },
  );
}

function deckTexture(variant: number): THREE.Texture {
  return canvasTexture(`ramp-deck-${variant}`, 256, 1024, (ctx, w, h) => {
    const rand = seededRandom(77 + variant);
    const woods = variant === 0 ? ['#B07A45', '#A56E3C', '#BE8A52', '#9C6535'] : ['#9C8468', '#8E7659', '#A89274', '#85705A'];
    const plank = 30;
    for (let y = 0; y < h; y += plank) {
      ctx.fillStyle = pick(rand, woods);
      ctx.fillRect(0, y, w, plank);
      ctx.fillStyle = 'rgba(60,30,10,0.18)';
      for (let k = 0; k < 4; k++) ctx.fillRect(rand() * w, y + 4 + rand() * (plank - 8), 30 + rand() * 90, 2);
      ctx.fillStyle = '#3A2414';
      ctx.fillRect(0, y + plank - 3, w, 3);
      ctx.fillStyle = '#2A2A2A';
      for (const x of [14, w / 2 - 2, w - 18]) {
        ctx.fillRect(x, y + 8, 4, 4);
        ctx.fillRect(x, y + plank - 12, 4, 4);
      }
    }
    // steel grip strips along the edges
    ctx.fillStyle = '#6B7076';
    ctx.fillRect(0, 0, 10, h);
    ctx.fillRect(w - 10, 0, 10, h);
    // chevrons pointing up the ramp (towards canvas top = far end)
    for (let y = 140; y < h - 180; y += 150) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(w / 2, y);
      ctx.lineTo(w / 2 + 70, y + 60);
      ctx.lineTo(w / 2 + 70, y + 92);
      ctx.lineTo(w / 2, y + 32);
      ctx.lineTo(w / 2 - 70, y + 92);
      ctx.lineTo(w / 2 - 70, y + 60);
      ctx.closePath();
      ctx.fill();
    }
    // hazard bands at the toe and the top lip
    for (const [y0, hh] of [
      [h - 60, 60],
      [0, 40],
    ]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, w, hh);
      ctx.clip();
      ctx.fillStyle = YELLOW;
      ctx.fillRect(0, y0, w, hh);
      ctx.fillStyle = INK;
      for (let x = -80; x < w + 80; x += 48) {
        ctx.beginPath();
        ctx.moveTo(x, y0 + hh);
        ctx.lineTo(x + 24, y0 + hh);
        ctx.lineTo(x + 24 + hh, y0);
        ctx.lineTo(x + hh, y0);
        ctx.fill();
      }
      ctx.restore();
    }
    streaks(ctx, w, h, rand, 30, 'rgba(30,20,10,0.12)');
    speckle(ctx, w, h, rand, 1800, ['rgba(30,20,10,0.3)', 'rgba(255,255,255,0.1)'], 2);
  });
}

/** Height of the walkable surface at distance u (= -z) from the toe. */
function rampY(u: number): number {
  return Math.min(ROOF_TOP, Math.max(0, u * SLOPE));
}

interface RampGeos {
  steel: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  hazard: THREE.BufferGeometry;
}
let rampGeos: RampGeos | null = null;

function buildRampGeos(): RampGeos {
  if (rampGeos) return rampGeos;
  const steel = new Parts();
  // deck slab: profile in (u, y), extruded across x
  const off = DECK_T * Math.hypot(1, SLOPE);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(RAMP_RISE, ROOF_TOP);
  shape.lineTo(RAMP_LEN, ROOF_TOP);
  shape.lineTo(RAMP_LEN, ROOF_TOP - DECK_T);
  shape.lineTo((ROOF_TOP - DECK_T + off) / SLOPE, ROOF_TOP - DECK_T);
  shape.lineTo(off / SLOPE, 0);
  shape.closePath();
  const slab = new THREE.ExtrudeGeometry(shape, { depth: RAMP_W, bevelEnabled: false });
  slab.translate(0, 0, -RAMP_W / 2);
  slab.rotateY(Math.PI / 2);
  steel.add(slab, '#5B6066', [0, 0, 0]);
  slab.dispose();

  // hazard curbs along both deck edges (textured, separate)
  const hz: THREE.BufferGeometry[] = [];
  const slopeLen = Math.hypot(RAMP_RISE, ROOF_TOP);
  const angle = Math.atan2(ROOF_TOP, RAMP_RISE);
  const curb = (x: number, len: number, cy: number, cz: number, rotX: number) => {
    const b = new THREE.BoxGeometry(0.12, 0.3, len);
    const uv = b.attributes.uv;
    const reps = len / 0.6;
    for (let i = 0; i < 8; i++) uv.setX(i, uv.getX(i) * reps); // ±x faces: u runs along the length
    for (let i = 8; i < 16; i++) uv.setY(i, uv.getY(i) * reps); // ±y faces: v runs along the length
    const g = prepare(b);
    b.dispose();
    _e.set(rotX, 0, 0);
    g.applyMatrix4(_m.compose(_p.set(x, cy, cz), _q.setFromEuler(_e), _s.set(1, 1, 1)));
    hz.push(g);
  };
  for (const s of [-1, 1]) {
    const x = s * (RAMP_W / 2 + 0.04);
    const u0 = 0.45;
    const cu = (u0 + RAMP_RISE) / 2;
    curb(x, Math.hypot(RAMP_RISE - u0, (RAMP_RISE - u0) * SLOPE) + 0.08, rampY(cu) + 0.02, -cu, angle);
    curb(x, RAMP_LEN - RAMP_RISE + 0.05, ROOF_TOP + 0.02, -(RAMP_RISE + RAMP_LEN) / 2 - 0.02, 0);
  }
  // toe plate
  const toe = new THREE.BoxGeometry(RAMP_W + 0.2, 0.05, 0.3);
  const tuv = toe.attributes.uv;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) * 4, tuv.getY(i));
  const tg = prepare(toe);
  toe.dispose();
  tg.translate(0, 0.02, -0.12);
  hz.push(tg);

  // guard rails: posts + a top tube following the slope
  const railH = 0.5;
  for (const s of [-1, 1]) {
    const x = s * (RAMP_W / 2 + 0.05);
    const postsU = [1.2, 2.6, 4.0, 5.4, 6.8, 7.9];
    for (const u of postsU) steel.box(0.07, railH, 0.07, x, rampY(u) + 0.12 + railH / 2, -u, '#34373C');
    steel.bar([x, rampY(1.2) + 0.12 + railH, -1.2], [x, ROOF_TOP + 0.12 + railH, -RAMP_RISE], 0.07, '#FFC93C', 8);
    steel.bar([x, ROOF_TOP + 0.12 + railH, -RAMP_RISE], [x, ROOF_TOP + 0.12 + railH, -RAMP_LEN + 0.05], 0.07, '#FFC93C', 8);
    steel.bar([x, rampY(1.2) + 0.12 + railH, -1.2], [x, rampY(0.5) + 0.12, -0.5], 0.07, '#FFC93C', 8);
  }

  // support trestles
  const legsU = [2.0, 3.6, 5.2, 6.7, 7.85];
  for (const u of legsU) {
    const top = rampY(u) - DECK_T * 1.05;
    for (const s of [-1, 1]) {
      steel.box(0.16, top, 0.16, s * 0.82, top / 2, -u, '#C1622B');
      steel.box(0.32, 0.05, 0.32, s * 0.82, 0.025, -u, '#2E3035');
    }
    steel.box(1.8, 0.12, 0.14, 0, top - 0.08, -u, '#8F4A25');
    if (top > 1.2) steel.box(1.8, 0.1, 0.1, 0, top * 0.45, -u, '#8F4A25');
    if (top > 1.0) {
      steel.bar([-0.78, 0.15, -u], [0.78, top - 0.2, -u], 0.07, '#8F4A25');
    }
  }
  for (let i = 0; i < legsU.length - 1; i++) {
    const [u0, u1] = [legsU[i], legsU[i + 1]];
    const t0 = rampY(u0) - DECK_T * 1.05;
    for (const s of [-1, 1]) {
      steel.bar([s * 0.82, 0.12, -u0], [s * 0.82, Math.min(t0, rampY(u1) - 0.4), -u1], 0.08, '#8F4A25');
      steel.bar([s * 0.82, t0 * 0.5, -u0], [s * 0.82, t0 * 0.5, -u1], 0.07, '#8F4A25');
    }
  }
  // longitudinal stringers under the deck
  for (const s of [-1, 1]) {
    const x = s * 0.82;
    steel.bar([x, 0.06, -1.0], [x, ROOF_TOP - DECK_T - 0.08, -RAMP_RISE - 0.1], 0.14, '#33363B');
  }

  // deck top surface (textured)
  const total = slopeLen + (RAMP_LEN - RAMP_RISE);
  const e = 0.006;
  const hx = RAMP_W / 2;
  const vSlope = slopeLen / total;
  const pos = [
    -hx, e, 0, hx, e, 0, hx, ROOF_TOP + e, -RAMP_RISE, -hx, ROOF_TOP + e, -RAMP_RISE,
    -hx, ROOF_TOP + e, -RAMP_RISE, hx, ROOF_TOP + e, -RAMP_RISE, hx, ROOF_TOP + e, -RAMP_LEN, -hx, ROOF_TOP + e, -RAMP_LEN,
  ];
  const nn = new THREE.Vector3(0, RAMP_RISE, ROOF_TOP).normalize();
  const nor = [nn.x, nn.y, nn.z, nn.x, nn.y, nn.z, nn.x, nn.y, nn.z, nn.x, nn.y, nn.z, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const uvs = [0, 0, 1, 0, 1, vSlope, 0, vSlope, 0, vSlope, 1, vSlope, 1, 1, 0, 1];
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  deck.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  deck.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  deck.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  rampGeos = { steel: steel.build(), deck, hazard: mergeGeometries(hz, false) };
  for (const g of hz) g.dispose();
  return rampGeos;
}

/** 8 m ramp whose walkable surface rises from 0 at z=0 to 3.2 at z=-7 and stays 3.2 to z=-8; width ~2.2. */
export function buildRamp(seed = 0): THREE.Group {
  const geos = buildRampGeos();
  const variant = Math.abs(Math.floor(seed)) % 2;
  const group = new THREE.Group();
  group.name = 'ramp';
  group.add(mesh(geos.steel, bodyMaterial()));
  group.add(mesh(geos.hazard, cachedMat('ramp-hazard', () => toonMaterial({ map: hazardTexture() }))));
  group.add(mesh(geos.deck, cachedMat(`ramp-deck-${variant}`, () => toonMaterial({ map: deckTexture(variant) })), true));
  addOutline(group, 0.035);
  enableShadows(group);
  return group;
}
