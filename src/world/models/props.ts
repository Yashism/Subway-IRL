import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addOutline, applyCurve, basicMaterial, enableShadows, toonMaterial } from '../render/materials';
import { canvasTexture, seededRandom, speckle } from '../render/canvasTexture';

/*
 * Obstacle props and pickups (Mumbai theme).
 *
 * Obstacles follow the model contract: they stand on y = 0, are centred on x, and their
 * near end is at z = 0, extending toward -z. Pickups are centred on the origin, and the
 * caller positions them.
 *
 * Every builder bakes its parts once per (kind, variant) into a few merged geometries,
 * one per material, and caches them. Each call returns a fresh Group whose meshes share
 * those geometries and materials. Flat colours are vertex colours on one shared toon
 * material, so a prop costs only a few draw calls.
 */

const HAS_DOM = typeof document !== 'undefined';
const FONT = '"Arial Black", "Segoe UI Black", Impact, "Liberation Sans", sans-serif';
const DEVA = '"Nirmala UI", "Noto Sans Devanagari", Mangal, "Kohinoor Devanagari", FreeSans, sans-serif';

/** canvasTexture, or null when there is no DOM (node tests). */
function tex(
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  repeat = false,
): THREE.CanvasTexture | null {
  return HAS_DOM ? canvasTexture(`props:${key}`, w, h, draw, { repeat }) : null;
}

// ---------------------------------------------------------------------------
// Materials (module-level cache)

const materials = new Map<string, THREE.Material>();
function material(key: string, make: () => THREE.Material): THREE.Material {
  let m = materials.get(key);
  if (!m) {
    m = make();
    materials.set(key, m);
  }
  return m;
}

type Slot =
  | 'paint'
  | 'detail'
  | 'lampRed'
  | 'lampWarm'
  | 'glass'
  | 'hazard'
  | 'boom'
  | 'bamboo'
  | 'plaque'
  | 'wood'
  | 'price'
  | 'banner0'
  | 'banner1'
  | 'banner2'
  | 'plate'
  | 'meter'
  | 'jhool'
  | 'rocketPaper'
  | 'carpet'
  | 'glow'
  | 'spark'
  | 'wing';

/** Slots whose meshes get no outline (decals, glass, glows, tiny sparks). */
const NO_OUTLINE = new Set<Slot>(['detail', 'plaque', 'price', 'banner0', 'banner1', 'banner2', 'plate', 'meter', 'glass', 'glow', 'spark']);
/** Slots that never cast shadows. */
const NO_SHADOW = new Set<Slot>(['glass', 'glow', 'spark']);

/**
 * Adds a little of the surface's own colour as emission, so saturated paint stays
 * saturated under AgX and shadow sides never go muddy.
 */
function lift<T extends THREE.Material>(m: T, amount = 0.08, saturation = 1.6): T {
  const previous = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float propLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = max( mix( vec3( propLuma ), diffuseColor.rgb, ${saturation.toFixed(3)} ), 0.0 );
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * ${amount.toFixed(3)};`,
      );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|lift${amount}|${saturation}`;
  return m;
}

function slotMaterial(slot: Slot): THREE.Material {
  if (slot === 'detail') return slotMaterial('paint');
  return material(slot, () => {
    const vc = { vertexColors: true };
    switch (slot) {
      case 'paint':
        return lift(toonMaterial(vc));
      case 'lampRed':
        return toonMaterial({ ...vc, emissive: 0xff2a1a, emissiveIntensity: 0.9 });
      case 'lampWarm':
        return toonMaterial({ ...vc, emissive: 0xfff0b0, emissiveIntensity: 1.2 });
      case 'spark':
        return basicMaterial({ vertexColors: true, toneMapped: false });
      case 'wing':
        return basicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
      case 'glass':
        return toonMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
      case 'glow': {
        const m = basicMaterial({
          map: glowTexture(),
          color: 0x7fe3ff,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        return m;
      }
      default:
        return lift(toonMaterial({ ...vc, map: slotTexture(slot) }), slot.startsWith('banner') || slot === 'plate' || slot === 'plaque' ? 0.22 : 0.08);
    }
  });
}

function slotTexture(slot: Slot): THREE.Texture | null {
  switch (slot) {
    case 'hazard':
      return hazardTexture();
    case 'boom':
      return boomTexture();
    case 'bamboo':
      return bambooTexture();
    case 'plaque':
      return plaqueTexture();
    case 'wood':
      return woodTexture();
    case 'price':
      return priceTexture();
    case 'banner0':
    case 'banner1':
    case 'banner2':
      return bannerTexture(Number(slot.slice(6)));
    case 'plate':
      return plateTexture();
    case 'meter':
      return meterTexture();
    case 'jhool':
      return jhoolTexture();
    case 'rocketPaper':
      return rocketTexture();
    case 'carpet':
      return carpetTexture();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Kit: collects transformed, coloured parts per material slot, then merges them.

type V3 = [number, number, number];
interface Place {
  p?: V3;
  r?: V3;
  s?: V3 | number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

class Kit {
  readonly parts = new Map<Slot, THREE.BufferGeometry[]>();

  add(slot: Slot, geo: THREE.BufferGeometry, place: Place = {}, color: THREE.ColorRepresentation = 0xffffff): THREE.BufferGeometry {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const s = place.s ?? 1;
    _e.set(...(place.r ?? [0, 0, 0]));
    _q.setFromEuler(_e);
    _v.set(...(place.p ?? [0, 0, 0]));
    if (typeof s === 'number') _s.setScalar(s);
    else _s.set(...s);
    _m.compose(_v, _q, _s);
    g.applyMatrix4(_m);
    _c.set(color);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    let list = this.parts.get(slot);
    if (!list) this.parts.set(slot, (list = []));
    list.push(g);
    geo.dispose();
    return g;
  }
}

interface Baked {
  slot: Slot;
  geometry: THREE.BufferGeometry;
  part?: string;
}

const bakeCache = new Map<string, Baked[]>();

/**
 * Merges a kit (plus optional separately named kits) into cached geometries.
 * If `nearEndAtZero`, everything is shifted so that the maximum z is exactly 0.
 */
function bake(key: string, make: () => { kit: Kit; named?: Record<string, Kit> }, nearEndAtZero: boolean): Baked[] {
  const hit = bakeCache.get(key);
  if (hit) return hit;
  const { kit, named = {} } = make();
  const out: Baked[] = [];
  const collect = (k: Kit, part?: string) => {
    for (const [slot, geos] of k.parts) {
      const geometry = mergeGeometries(geos, false);
      if (!geometry) throw new Error(`props: failed to merge ${key}/${slot}`);
      for (const g of geos) g.dispose();
      out.push({ slot, geometry, part });
    }
  };
  collect(kit);
  for (const [part, k] of Object.entries(named)) collect(k, part);
  if (nearEndAtZero) {
    let maxZ = -Infinity;
    for (const b of out) {
      b.geometry.computeBoundingBox();
      maxZ = Math.max(maxZ, b.geometry.boundingBox!.max.z);
    }
    for (const b of out) b.geometry.translate(0, 0, -maxZ);
  }
  for (const b of out) {
    b.geometry.computeBoundingBox();
    b.geometry.computeBoundingSphere();
  }
  bakeCache.set(key, out);
  return out;
}

function instantiate(baked: Baked[], name: string, shadows: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  for (const b of baked) {
    const mesh = new THREE.Mesh(b.geometry, slotMaterial(b.slot));
    mesh.name = b.part ? `${name}-${b.part}` : `${name}-${b.slot}`;
    if (b.part) mesh.userData.part = b.part;
    if (NO_OUTLINE.has(b.slot)) mesh.userData.noOutline = true;
    group.add(mesh);
  }
  addOutline(group);
  if (shadows) {
    enableShadows(group);
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.isOutline) {
        const slot = baked.find((b) => b.geometry === mesh.geometry)?.slot;
        if (slot && NO_SHADOW.has(slot)) mesh.castShadow = mesh.receiveShadow = false;
      }
    });
  }
  return group;
}

// ---------------------------------------------------------------------------
// Primitive shortcuts (all built fresh; the kit clones and disposes them)

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, r = 0.04) => new RoundedBoxGeometry(w, h, d, 1, r);
const cyl = (rt: number, rb: number, h: number, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
const ball = (r = 1, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const HALF_PI = Math.PI / 2;

/** A cylinder from point a to point b. */
function rod(kit: Kit, slot: Slot, a: V3, b: V3, r: number, color: THREE.ColorRepresentation, seg = 6, rEnd = r): void {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = cyl(rEnd, r, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  const e = new THREE.Euler().setFromQuaternion(q);
  const mid = va.add(vb).multiplyScalar(0.5);
  kit.add(slot, g, { p: [mid.x, mid.y, mid.z], r: [e.x, e.y, e.z] }, color);
}

function shade(hex: number, f: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(f);
}

// ---------------------------------------------------------------------------
// Textures

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Big bold text with a dark outline, sized to fit maxW. */
function boldText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxW: number, fill: string, stroke = '#141414', font = FONT, strokeW = 0.14): void {
  ctx.font = `900 ${size}px ${font}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size *= maxW / w;
    ctx.font = `900 ${size}px ${font}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (stroke) {
    ctx.lineWidth = size * strokeW;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function hazardTexture() {
  return tex('hazard', 16, 128, (ctx, w, h) => {
    ctx.fillStyle = '#FFD400';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1b1b1b';
    for (let i = 0; i < 6; i++) ctx.fillRect(0, (i * h) / 6, w, h / 12);
  });
}

function boomTexture() {
  return tex('boom', 512, 48, (ctx, w, h) => {
    ctx.fillStyle = '#F4F4F4';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#E8433A';
    const step = 64;
    for (let x = -h; x < w + h; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + h, 0);
      ctx.lineTo(x + h + step / 2, 0);
      ctx.lineTo(x + step / 2, h);
      ctx.fill();
    }
    // reflector studs
    for (const x of [w * 0.25, w * 0.5, w * 0.75]) {
      ctx.fillStyle = '#7a0d08';
      ctx.beginPath();
      ctx.arc(x, h / 2, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff5040';
      ctx.beginPath();
      ctx.arc(x, h / 2, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd0c8';
      ctx.beginPath();
      ctx.arc(x - 3, h / 2 - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, h - 4, w, 4);
  });
}

function bambooTexture() {
  return tex('bamboo', 32, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#b98a3e');
    g.addColorStop(0.5, '#e2bb6a');
    g.addColorStop(1, '#b98a3e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const rand = seededRandom(7);
    ctx.fillStyle = 'rgba(120,80,30,0.35)';
    for (let i = 0; i < 20; i++) ctx.fillRect(rand() * w, rand() * h, 1, 10 + rand() * 30);
    for (let y = 20; y < h; y += 64) {
      ctx.fillStyle = '#7d5423';
      ctx.fillRect(0, y, w, 5);
      ctx.fillStyle = '#f0d08a';
      ctx.fillRect(0, y + 5, w, 2);
    }
  }, true);
}

function plaqueTexture() {
  return tex('plaque', 256, 112, (ctx, w, h) => {
    ctx.fillStyle = '#FFD400';
    roundRect(ctx, 0, 0, w, h, 14);
    ctx.fill();
    ctx.fillStyle = '#E8433A';
    roundRect(ctx, 7, 7, w - 14, h - 14, 10);
    ctx.fill();
    boldText(ctx, 'रुकिए', w / 2, h * 0.33, 40, w - 30, '#ffffff', '#6b0f0a', DEVA, 0.12);
    boldText(ctx, 'STOP', w / 2, h * 0.72, 38, w - 40, '#ffffff', '#6b0f0a');
  });
}

function woodTexture() {
  return tex('wood', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#b07a44';
    ctx.fillRect(0, 0, w, h);
    const rand = seededRandom(11);
    const plank = h / 5;
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = ['#b07a44', '#a06a38', '#bb8650', '#a87140', '#9c6634'][i];
      ctx.fillRect(0, i * plank, w, plank);
      ctx.fillStyle = 'rgba(70,40,15,0.25)';
      for (let k = 0; k < 6; k++) ctx.fillRect(0, i * plank + rand() * plank, w, 1);
      ctx.fillStyle = '#5a3515';
      ctx.fillRect(0, i * plank, w, 2);
      ctx.fillStyle = '#3a220c';
      ctx.fillRect(6, i * plank + plank / 2 - 1, 3, 3);
      ctx.fillRect(w - 9, i * plank + plank / 2 - 1, 3, 3);
    }
  });
}

function priceTexture() {
  return tex('price', 128, 96, (ctx, w, h) => {
    ctx.fillStyle = '#f7f2e4';
    roundRect(ctx, 0, 0, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = '#2F80C9';
    ctx.lineWidth = 5;
    roundRect(ctx, 5, 5, w - 10, h - 10, 6);
    ctx.stroke();
    boldText(ctx, '₹40', w / 2, h * 0.42, 44, w - 22, '#E8433A', '', FONT);
    boldText(ctx, 'किलो', w / 2, h * 0.78, 22, w - 30, '#1d3f73', '', DEVA);
  });
}

const BANNERS = [
  {
    bg: ['#FF7A29', '#FFC93C'],
    top: 'स्वागतम्',
    mid: 'WELCOME',
    sub: 'PAREL NAGAR MITRA MANDAL',
    ink: '#8a1c12',
  },
  {
    bg: ['#1a8f86', '#29C7E0'],
    top: 'CHAI GARAM',
    mid: 'कटिंग चाय ₹10',
    sub: 'MUNNA TEA STALL • DADAR WEST',
    ink: '#0b3b3a',
  },
  {
    bg: ['#E8433A', '#FF9A3C'],
    top: 'VADA PAV KING',
    mid: 'मुंबई का असली स्वाद',
    sub: 'SINCE 1987 • 2 FOR ₹30',
    ink: '#5a0f0a',
  },
] as const;

function bannerTexture(v: number) {
  const b = BANNERS[v % BANNERS.length];
  return tex(`banner${v}`, 512, 440, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, b.bg[0]);
    g.addColorStop(1, b.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // sunburst
    ctx.save();
    ctx.translate(w / 2, h * 0.52);
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    for (let i = 0; i < 18; i++) {
      ctx.rotate((Math.PI * 2) / 18);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, -60);
      ctx.lineTo(w, 60);
      ctx.fill();
    }
    ctx.restore();
    // scalloped border
    ctx.strokeStyle = '#FFD400';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, w - 14, h - 14);
    ctx.fillStyle = '#E5399B';
    for (let x = 22; x < w; x += 30) {
      ctx.beginPath();
      ctx.arc(x, 7, 5, 0, Math.PI * 2);
      ctx.arc(x, h - 7, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // illustration
    ctx.save();
    ctx.translate(w / 2, h * 0.53);
    if (v % 3 === 0) {
      // diya
      ctx.fillStyle = '#FFE680';
      ctx.beginPath();
      ctx.ellipse(0, -30, 18, 38, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FF5A1F';
      ctx.beginPath();
      ctx.ellipse(0, -22, 9, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9b3a12';
      ctx.beginPath();
      ctx.ellipse(0, 18, 70, 22, 0, 0, Math.PI);
      ctx.fill();
      ctx.fillStyle = '#c85a24';
      ctx.fillRect(-70, 10, 140, 10);
    } else if (v % 3 === 1) {
      // cutting-chai glass
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(-40, -50);
      ctx.lineTo(40, -50);
      ctx.lineTo(30, 40);
      ctx.lineTo(-30, 40);
      ctx.fill();
      ctx.fillStyle = '#b8742e';
      ctx.beginPath();
      ctx.moveTo(-37, -28);
      ctx.lineTo(37, -28);
      ctx.lineTo(30, 36);
      ctx.lineTo(-30, 36);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 6;
      for (const x of [-18, 0, 18]) {
        ctx.beginPath();
        ctx.moveTo(x, -60);
        ctx.bezierCurveTo(x + 12, -75, x - 12, -85, x, -100);
        ctx.stroke();
      }
    } else {
      // vada pav
      ctx.fillStyle = '#d98b3a';
      ctx.beginPath();
      ctx.ellipse(0, -18, 80, 34, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#6aa33a';
      ctx.fillRect(-78, -20, 156, 8);
      ctx.fillStyle = '#c4861f';
      ctx.beginPath();
      ctx.ellipse(0, -6, 74, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e09a45';
      ctx.fillRect(-80, 6, 160, 26);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-30, -36, 24, 7, -0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    const deva = (s: string) => /[ऀ-ॿ]/.test(s);
    boldText(ctx, b.top, w / 2, h * 0.17, 84, w - 60, '#ffffff', b.ink, deva(b.top) ? DEVA : FONT);
    boldText(ctx, b.mid, w / 2, h * 0.76, 62, w - 60, '#FFE14D', b.ink, deva(b.mid) ? DEVA : FONT);
    ctx.fillStyle = b.ink;
    roundRect(ctx, 40, h * 0.86, w - 80, 40, 20);
    ctx.fill();
    boldText(ctx, b.sub, w / 2, h * 0.86 + 21, 24, w - 120, '#ffffff', '');
  });
}

function plateTexture() {
  return tex('plate', 256, 72, (ctx, w, h) => {
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#FFD400';
    roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.fill();
    boldText(ctx, 'MH 02 ZX 4721', w / 2, h / 2 + 2, 40, w - 26, '#141414', '', '"Liberation Sans", Arial, sans-serif');
  });
}

function meterTexture() {
  return tex('meter', 96, 64, (ctx, w, h) => {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#080808';
    ctx.fillRect(8, 10, w - 16, 30);
    ctx.shadowColor = '#ff3b30';
    ctx.shadowBlur = 8;
    boldText(ctx, '23.00', w / 2, 26, 26, w - 24, '#ff4a3a', '', 'monospace');
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#FFD400';
    ctx.fillRect(10, 48, 20, 8);
    ctx.fillStyle = '#3FB27F';
    ctx.fillRect(38, 48, 20, 8);
    ctx.fillStyle = '#E8433A';
    ctx.fillRect(66, 48, 20, 8);
  });
}

function jhoolTexture() {
  return tex('jhool', 256, 128, (ctx, w, h) => {
    const bands = ['#E5399B', '#FFD400', '#2F80C9', '#3FB27F', '#E8433A', '#8E5FD1'];
    const bh = h / bands.length;
    bands.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(0, i * bh, w, bh);
      ctx.fillStyle = i % 2 ? '#fff4c2' : '#ffffff';
      for (let x = (i % 2) * 11; x < w; x += 22) {
        ctx.beginPath();
        ctx.arc(x + 5, i * bh + bh / 2, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.fillStyle = '#FFD400';
    ctx.fillRect(0, h - 8, w, 8);
    const rand = seededRandom(3);
    speckle(ctx, w, h, rand, 60, ['rgba(255,255,255,0.7)'], 2);
  }, true);
}

function rocketTexture() {
  return tex('rocket', 128, 128, (ctx, w, h) => {
    const cols = ['#E5399B', '#FFD400', '#29C7E0', '#FF7A29'];
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = cols[i % cols.length];
      ctx.fillRect(0, (i * h) / 8, w, h / 8);
    }
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 8; i++) {
      const y = (i * h) / 8 + h / 16;
      for (let x = 0; x < w; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 8, y - 5);
        ctx.lineTo(x + 16, y);
        ctx.lineTo(x + 8, y + 5);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(20,20,20,0.35)';
    for (let i = 1; i < 8; i++) ctx.fillRect(0, (i * h) / 8 - 1, w, 2);
  });
}

/** The default carpet's three colours; a board skin overrides any of them. */
export const BOARD_BASE: Required<BoardPalette> = { base: 0xb3122e, trim: 0xffc93c, glow: 0xe5399b };

export interface BoardPalette {
  /** The field of the rug. */
  base?: number;
  /** Border, medallion rays and tassels. */
  trim?: number;
  /** The magic glow under it, and every other tassel. */
  glow?: number;
}

const hex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
/** A darker shade of a palette colour, as a CSS string, for the rug's own pattern. */
const dim = (n: number, k: number): string => `#${shade(n, k).getHexString()}`;

function carpetTexture(key = 'carpet', p: Required<BoardPalette> = BOARD_BASE) {
  return tex(key, 256, 512, (ctx, w, h) => {
    ctx.fillStyle = hex(p.base);
    ctx.fillRect(0, 0, w, h);
    // borders
    const border = (inset: number, width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    };
    border(10, 20, dim(p.glow, 0.7));
    border(10, 4, hex(p.trim));
    border(26, 4, hex(p.trim));
    ctx.fillStyle = hex(p.trim);
    for (let y = 14; y < h; y += 24) {
      ctx.beginPath();
      ctx.arc(10, y, 4, 0, Math.PI * 2);
      ctx.arc(w - 10, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // field pattern
    ctx.fillStyle = dim(p.base, 0.62);
    for (let y = 60; y < h - 40; y += 40) {
      for (let x = 50; x < w - 40; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, y - 12);
        ctx.lineTo(x + 12, y);
        ctx.lineTo(x, y + 12);
        ctx.lineTo(x - 12, y);
        ctx.fill();
      }
    }
    // central medallion
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.fillStyle = dim(p.glow, 0.7);
    ctx.beginPath();
    ctx.ellipse(0, 0, 80, 130, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hex(p.trim);
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = hex(p.trim);
    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.ellipse(0, -52, 12, 34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = hex(p.glow);
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = hex(p.trim);
    for (const y of [70, h - 70]) {
      ctx.save();
      ctx.translate(w / 2, y);
      ctx.beginPath();
      ctx.moveTo(0, -22);
      ctx.lineTo(26, 0);
      ctx.lineTo(0, 22);
      ctx.lineTo(-26, 0);
      ctx.fill();
      ctx.restore();
    }
  });
}

function glowTexture() {
  return tex('glow', 64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function coinTexture() {
  return tex('coin', 256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    ctx.fillStyle = '#F5BA10';
    ctx.fillRect(0, 0, w, h);
    // face
    const g = ctx.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, 100);
    g.addColorStop(0, '#FFF6B0');
    g.addColorStop(0.55, '#FFE03A');
    g.addColorStop(1, '#F8C21A');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 99, 0, Math.PI * 2);
    ctx.fill();
    // inner ring (bevel groove)
    ctx.strokeStyle = '#C9800A';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 84, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,248,200,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 81, Math.PI * 0.9, Math.PI * 1.7);
    ctx.stroke();
    // embossed rupee sign: dark offset, then light face
    ctx.font = `900 132px ${DEVA}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9c5a00';
    ctx.fillText('₹', cx + 5, cy + 11);
    ctx.fillStyle = '#FFF6C4';
    ctx.fillText('₹', cx - 3, cy + 3);
    ctx.fillStyle = '#F7B90F';
    ctx.fillText('₹', cx, cy + 6);
    // rim (outside the lathe face radius maps here)
    ctx.strokeStyle = '#FFD23A';
    ctx.lineWidth = 30;
    ctx.beginPath();
    ctx.arc(cx, cy, 116, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Low barrier: railway-crossing boom on striped posts, with a bamboo rail.

const CONCRETE = 0xb8afa0;

export function buildLowBarrier(seed = 0): THREE.Group {
  const variant = Math.abs(Math.floor(seed)) % 2;
  const baked = bake(`barrier:${variant}`, () => {
    const kit = new Kit();
    const zc = -0.25;
    for (const sx of [-1, 1]) {
      const x = sx * 0.86;
      kit.add('paint', rbox(0.34, 0.1, 0.5, 0.03), { p: [x, 0.05, zc] }, CONCRETE);
      kit.add('hazard', cyl(0.07, 0.075, 0.8, 10), { p: [x, 0.5, zc - 0.05] });
      kit.add('paint', cyl(0.09, 0.09, 0.05, 10), { p: [x, 0.905, zc - 0.05] }, 0x2b2b2b);
      kit.add('lampRed', ball(0.065, 10, 6), { p: [x, 0.94, zc - 0.05] }, 0xff3b30);
      // bolt plate holding the boom
      kit.add('paint', box(0.18, 0.24, 0.04), { p: [x, 0.74, zc + 0.03] }, 0x3a3a3a);
    }
    // boom (red/white) in front of the posts
    kit.add('boom', rbox(2.0, 0.15, 0.1, 0.035), { p: [0, 0.74, zc + 0.1] });
    // bamboo rail + a leaning brace
    kit.add('bamboo', cyl(0.045, 0.045, 1.66, 8), { p: [0, 0.34, zc - 0.05], r: [0, 0, HALF_PI] });
    rod(kit, 'bamboo', [-0.8, 0.2, zc - 0.12], [0.8, 0.64, zc - 0.12], 0.032, 0xffffff, 6);
    // rope lashings
    for (const sx of [-1, 1]) kit.add('detail', new THREE.TorusGeometry(0.06, 0.018, 4, 8), { p: [sx * 0.8, 0.34, zc - 0.05], r: [0, HALF_PI, 0] }, 0x8a6a3a);
    // hanging warning plaque
    kit.add('paint', rbox(0.6, 0.28, 0.04, 0.02), { p: [0, 0.47, zc + 0.12] }, 0x2b2b2b);
    kit.add('plaque', new THREE.PlaneGeometry(0.56, 0.245), { p: [0, 0.47, zc + 0.142] });
    for (const sx of [-1, 1]) rod(kit, 'detail', [sx * 0.2, 0.6, zc + 0.12], [sx * 0.2, 0.68, zc + 0.12], 0.012, 0x777777, 4);
    if (variant === 1) {
      // a hanging red flag cloth on the boom
      kit.add('paint', new THREE.ConeGeometry(0.12, 0.22, 3), { p: [0.62, 0.55, zc + 0.12], r: [Math.PI, 0, 0], s: [1, 1, 0.2] }, 0xe8433a);
      kit.add('paint', new THREE.ConeGeometry(0.12, 0.22, 3), { p: [-0.62, 0.55, zc + 0.12], r: [Math.PI, 0, 0], s: [1, 1, 0.2] }, 0xffd400);
    }
    return { kit };
  }, true);
  return instantiate(baked, 'barrierLow', true);
}

// ---------------------------------------------------------------------------
// Handcart (thela) with fruit and vegetables.

const FRUIT = {
  mango: [0xffb21c, 0xffc93c, 0xf29a16, 0xe8b830],
  tomato: [0xe8332a, 0xd8261e, 0xf04a30],
  onion: [0xa8325a, 0xc0476b, 0x933050],
  lime: [0x7cc242, 0x69b334, 0x8fd14f],
  brinjal: [0x5b2a86, 0x4a2270],
  orange: [0xff8a1f, 0xff9b2e, 0xf07a12],
} as const;

type Heap = { kind: keyof typeof FRUIT | 'banana'; z: number };

const CART_LOADS: Heap[][] = [
  [
    { kind: 'tomato', z: -0.46 },
    { kind: 'mango', z: -0.86 },
    { kind: 'banana', z: -1.24 },
  ],
  [
    { kind: 'onion', z: -0.46 },
    { kind: 'lime', z: -0.86 },
    { kind: 'brinjal', z: -1.24 },
  ],
  [
    { kind: 'orange', z: -0.46 },
    { kind: 'banana', z: -0.86 },
    { kind: 'mango', z: -1.24 },
  ],
];
const CART_PAINT = [0x2f80c9, 0x3fb27f, 0xe8433a];

function addWheel(kit: Kit, x: number, y: number, z: number, r: number, rim: number, spoke: number): void {
  kit.add('paint', new THREE.TorusGeometry(r, 0.045, 5, 16), { p: [x, y, z], r: [0, HALF_PI, 0] }, 0x2a2a2a);
  kit.add('detail', new THREE.TorusGeometry(r - 0.05, 0.022, 4, 16), { p: [x, y, z], r: [0, HALF_PI, 0] }, rim);
  kit.add('paint', cyl(0.07, 0.07, 0.12, 8), { p: [x, y, z], r: [0, 0, HALF_PI] }, 0x3a3a3a);
  for (let i = 0; i < 4; i++) {
    kit.add('detail', box(0.03, (r - 0.05) * 2, 0.035), { p: [x, y, z], r: [(i * Math.PI) / 4, 0, 0] }, spoke);
  }
}

export function buildHandcart(seed = 0): THREE.Group {
  const variant = Math.abs(Math.floor(seed)) % CART_LOADS.length;
  const baked = bake(`handcart:${variant}`, () => {
    const kit = new Kit();
    const rand = seededRandom(97 + variant * 13);
    const paint = CART_PAINT[variant];
    const bedY = 0.58;
    const zc = -0.84;
    // bed and painted rails
    kit.add('wood', rbox(1.12, 0.1, 1.2, 0.03), { p: [0, bedY, zc] });
    kit.add('paint', box(1.16, 0.06, 1.24), { p: [0, bedY - 0.07, zc] }, shade(paint, 0.7));
    for (const sx of [-1, 1]) kit.add('paint', box(0.05, 0.12, 1.24), { p: [sx * 0.585, bedY + 0.1, zc] }, paint);
    for (const z of [zc + 0.6, zc - 0.6]) kit.add('paint', box(1.2, 0.12, 0.05), { p: [0, bedY + 0.1, z] }, paint);
    // handles toward the near end, and a stand
    for (const sx of [-1, 1]) {
      kit.add('paint', cyl(0.028, 0.028, 0.5, 6), { p: [sx * 0.42, bedY + 0.02, -0.25], r: [HALF_PI, 0, 0] }, 0x6b4420);
      kit.add('detail', cyl(0.036, 0.036, 0.1, 6), { p: [sx * 0.42, bedY + 0.02, -0.05], r: [HALF_PI, 0, 0] }, 0x8a5a2e);
      rod(kit, 'paint', [sx * 0.45, 0, -0.3], [sx * 0.45, bedY - 0.08, -0.3], 0.025, 0x4a3324, 5);
      rod(kit, 'paint', [sx * 0.45, 0, -1.38], [sx * 0.45, bedY - 0.08, -1.38], 0.025, 0x4a3324, 5);
    }
    // axle and big spoked wheels
    kit.add('paint', cyl(0.03, 0.03, 1.44, 6), { p: [0, 0.43, zc], r: [0, 0, HALF_PI] }, 0x3a3a3a);
    for (const sx of [-1, 1]) addWheel(kit, sx * 0.72, 0.43, zc, 0.38, 0xffc93c, 0xe8433a);
    // heaps of produce
    const top = bedY + 0.05;
    for (const heap of CART_LOADS[variant]) {
      const base = heap.kind === 'banana' ? 0x6aa33a : heap.kind === 'brinjal' ? 0x3f7d2a : 0x8a5a2e;
      // gunny cloth under the heap
      kit.add('paint', box(1.02, 0.02, 0.36), { p: [0, top + 0.01, heap.z] }, heap.kind === 'banana' ? 0x3f8a3a : 0xc9a66b);
      kit.add('paint', ball(1, 8, 4), { p: [0, top + 0.02, heap.z], s: [0.46, 0.13, 0.16] }, base);
      if (heap.kind === 'banana') {
        for (let i = 0; i < 4; i++) {
          const x = -0.33 + i * 0.22;
          for (let k = 0; k < 4; k++) {
            kit.add('detail', new THREE.TorusGeometry(0.13, 0.03, 4, 6, 1.7), {
              p: [x + (k - 1.5) * 0.03, top + 0.12 + k * 0.035, heap.z + 0.05],
              r: [HALF_PI - 0.4, 0, 0.5 + k * 0.1 + rand() * 0.2],
            }, k % 2 ? 0xffd93c : 0xffe45a);
          }
          kit.add('detail', cyl(0.02, 0.02, 0.08, 4), { p: [x - 0.08, top + 0.18, heap.z + 0.05], r: [0, 0, 1] }, 0x5a7a2a);
        }
        continue;
      }
      const cols = FRUIT[heap.kind];
      const r = heap.kind === 'lime' ? 0.055 : heap.kind === 'tomato' ? 0.068 : 0.075;
      const layers: [number, number, number][] = [
        [5, 2, 0],
        [4, 1, 1],
        [2, 1, 2],
      ];
      for (const [nx, nz, layer] of layers) {
        for (let ix = 0; ix < nx; ix++) {
          for (let iz = 0; iz < nz; iz++) {
            const x = (ix - (nx - 1) / 2) * r * 1.85 + (rand() - 0.5) * 0.02;
            const z = heap.z + (iz - (nz - 1) / 2) * r * 1.8 + (rand() - 0.5) * 0.02;
            const y = top + 0.1 + layer * r * 1.45;
            const col = cols[Math.floor(rand() * cols.length)];
            if (heap.kind === 'brinjal') {
              kit.add('detail', ball(1, 6, 5), { p: [x, y, z], r: [HALF_PI, 0, rand()], s: [r * 0.8, r * 1.5, r * 0.8] }, col);
              kit.add('detail', new THREE.ConeGeometry(0.03, 0.05, 4), { p: [x, y, z - r * 1.4], r: [-HALF_PI, 0, 0] }, 0x4f8a2e);
            } else {
              const sq = heap.kind === 'mango' ? [r * 1.25, r * 0.95, r * 0.9] as V3 : [r, r * 0.9, r] as V3;
              kit.add('detail', ball(1, 6, 5), { p: [x, y, z], r: [0, rand() * 3, 0], s: sq }, col);
              if (heap.kind === 'tomato' || heap.kind === 'onion') {
                kit.add('detail', new THREE.ConeGeometry(0.018, 0.035, 4), { p: [x, y + r * 0.9, z] }, heap.kind === 'tomato' ? 0x3f8a2e : 0xd9c08a);
              }
            }
          }
        }
      }
    }
    // price card on a stick
    rod(kit, 'detail', [0.36, top, -0.66], [0.36, 0.95, -0.66], 0.012, 0x6b4420, 4);
    kit.add('paint', box(0.23, 0.18, 0.015), { p: [0.36, 0.98, -0.668] }, 0x2a2a2a);
    kit.add('price', new THREE.PlaneGeometry(0.21, 0.16), { p: [0.36, 0.98, -0.66] });
    // weighing scale hanging off the handle side
    rod(kit, 'detail', [-0.42, top, -0.66], [-0.42, 1.02, -0.66], 0.014, 0x6b4420, 4);
    kit.add('detail', box(0.34, 0.02, 0.02), { p: [-0.42, 1.02, -0.66] }, 0x8a7a50);
    for (const sx of [-1, 1]) {
      rod(kit, 'detail', [-0.42 + sx * 0.16, 1.01, -0.66], [-0.42 + sx * 0.16, 0.9, -0.66], 0.004, 0x555555, 3);
      kit.add('detail', cyl(0.06, 0.04, 0.02, 8), { p: [-0.42 + sx * 0.16, 0.89, -0.66] }, 0xc9a24a);
    }
    return { kit };
  }, true);
  return instantiate(baked, 'handcart', true);
}

// ---------------------------------------------------------------------------
// Banner: flex board on two thin bamboo poles, with marigold garlands.

export function buildBanner(seed = 0): THREE.Group {
  const variant = Math.abs(Math.floor(seed)) % BANNERS.length;
  const baked = bake(`banner:${variant}`, () => {
    const kit = new Kit();
    const posts = new Kit();
    const rand = seededRandom(31 + variant);
    const zc = -0.25;
    // poles at the lane edges
    for (const sx of [-1, 1]) {
      posts.add('bamboo', cyl(0.045, 0.05, 3.12, 8), { p: [sx * 1.1, 1.56, zc - 0.06] });
      posts.add('paint', cyl(0.055, 0.06, 0.12, 8), { p: [sx * 1.1, 0.06, zc - 0.06] }, 0x5a5550);
      // rear strut (fills the 0.5 m obstacle depth; stays at the lane edge)
      rod(posts, 'bamboo', [sx * 1.1, 1.7, zc - 0.08], [sx * 1.1, 0.02, zc - 0.34], 0.03, 0xffffff, 6);
      posts.add('paint', box(0.1, 0.06, 0.12), { p: [sx * 1.1, 0.03, zc - 0.34] }, 0x5a5550);
      posts.add('paint', new THREE.ConeGeometry(0.07, 0.18, 3), { p: [sx * 1.02, 3.04, zc - 0.06], r: [0, 0, sx * HALF_PI], s: [1, 1, 0.25] }, 0xff7a29);
    }
    // board: frame + flex print
    kit.add('paint', rbox(2.2, 2.0, 0.06, 0.025), { p: [0, 2.0, zc] }, 0x2d2d33);
    kit.add(`banner${variant}` as Slot, new THREE.PlaneGeometry(2.1, 1.9), { p: [0, 2.0, zc + 0.032] });
    // rope ties at the corners
    for (const sx of [-1, 1]) {
      for (const y of [1.1, 2.9]) kit.add('detail', new THREE.TorusGeometry(0.06, 0.015, 4, 8), { p: [sx * 1.08, y, zc - 0.02], r: [HALF_PI, 0, 0] }, 0xd9c08a);
    }
    // marigold garland swags along the top
    const marigold = [0xff8a00, 0xffb000, 0xff6a00, 0xffc93c];
    const bead = (x: number, y: number, z: number, i: number, r = 0.05) =>
      kit.add('detail', new THREE.IcosahedronGeometry(r, 0), { p: [x, y, z], r: [rand() * 3, rand() * 3, 0] }, marigold[i % marigold.length]);
    const swags = 3;
    const perSwag = 12;
    for (let s = 0; s < swags; s++) {
      const x0 = -1.05 + (2.1 / swags) * s;
      for (let i = 0; i <= perSwag; i++) {
        const t = i / perSwag;
        const x = x0 + (2.1 / swags) * t;
        const y = 2.94 - Math.sin(t * Math.PI) * 0.22;
        bead(x, y, zc + 0.08, i + s);
        if (i === perSwag / 2) {
          // hanging tassel of flowers + mango leaf
          for (let k = 1; k <= 3; k++) bead(x, y - k * 0.075, zc + 0.08, k + 1, 0.042);
          kit.add('detail', new THREE.OctahedronGeometry(0.06, 0), { p: [x, y - 0.3, zc + 0.08], s: [0.6, 1.5, 0.25] }, 0x3fae3a);
        }
      }
    }
    // mango-leaf toran along the top edge
    for (let i = 0; i < 11; i++) {
      kit.add('detail', new THREE.OctahedronGeometry(0.07, 0), { p: [-1.0 + i * 0.2, 2.9, zc + 0.05], s: [0.55, 1.2, 0.2] }, i % 2 ? 0x3fae3a : 0x2e8f3a);
    }
    // vertical strands at the sides (stay above 1.0 m)
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 17; k++) bead(sx * 1.02, 2.88 - k * 0.1, zc + 0.08, k, 0.045);
    }
    return { kit, named: { post: posts } };
  }, true);
  return instantiate(baked, 'bannerHigh', true);
}

// ---------------------------------------------------------------------------
// Mumbai auto-rickshaw, facing +z.

const AUTO_BLACK = 0x26282d;
const AUTO_YELLOW = 0xffc600;
const CHROME = 0xd6dde2;

function extrudeSide(shape: THREE.Shape, depth: number, bevel: number, curveSegments = 6): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
  });
  // shape (u, v) -> world (z = -u, y = v), extrusion -> x, centred
  g.translate(0, 0, -depth / 2);
  g.rotateY(HALF_PI);
  return g;
}

export function buildAuto(seed = 0): THREE.Group {
  const variant = Math.abs(Math.floor(seed)) % 2;
  const baked = bake(`auto:${variant}`, () => {
    const kit = new Kit();
    // lower body
    const body = new THREE.Shape();
    body.moveTo(0.08, 0.6);
    body.quadraticCurveTo(0.0, 0.95, 0.14, 1.2);
    body.quadraticCurveTo(0.22, 1.32, 0.45, 1.32);
    body.lineTo(0.62, 1.3);
    body.lineTo(0.68, 0.86);
    body.lineTo(2.18, 0.86);
    body.lineTo(2.26, 1.22);
    body.lineTo(2.9, 1.22);
    body.quadraticCurveTo(3.0, 0.8, 2.92, 0.34);
    body.lineTo(2.66, 0.34);
    body.absarc(2.36, 0.34, 0.3, 0, Math.PI, false);
    body.lineTo(0.72, 0.34);
    body.lineTo(0.62, 0.6);
    body.closePath();
    kit.add('paint', extrudeSide(body, 1.12, 0.05), {}, AUTO_BLACK);
    // yellow waist stripe
    const stripe = new THREE.Shape();
    stripe.moveTo(0.7, 0.7);
    stripe.lineTo(2.9, 0.7);
    stripe.lineTo(2.92, 0.78);
    stripe.lineTo(0.69, 0.78);
    stripe.closePath();
    kit.add('paint', extrudeSide(stripe, 1.235, 0, 1), {}, AUTO_YELLOW);
    // canopy (yellow hood, sloping down at the back)
    const hood = new THREE.Shape();
    hood.moveTo(0.52, 1.74);
    hood.quadraticCurveTo(0.52, 1.95, 0.8, 1.95);
    hood.lineTo(2.5, 1.95);
    hood.quadraticCurveTo(3.0, 1.93, 2.98, 1.2);
    hood.lineTo(2.88, 1.2);
    hood.quadraticCurveTo(2.9, 1.84, 2.5, 1.85);
    hood.lineTo(0.8, 1.85);
    hood.quadraticCurveTo(0.62, 1.85, 0.62, 1.74);
    hood.closePath();
    kit.add('paint', extrudeSide(hood, 1.24, 0.04), {}, AUTO_YELLOW);
    // hood side flaps (rolled-up rain curtains)
    for (const sx of [-1, 1]) kit.add('paint', cyl(0.05, 0.05, 1.6, 8), { p: [sx * 0.64, 1.8, -1.7], r: [HALF_PI, 0, 0] }, 0x1f1f22);
    // pillars
    for (const sx of [-1, 1]) {
      rod(kit, 'paint', [sx * 0.56, 1.28, -0.62], [sx * 0.56, 1.85, -0.62], 0.025, AUTO_BLACK, 6);
      rod(kit, 'paint', [sx * 0.6, 1.2, -2.3], [sx * 0.6, 1.88, -2.3], 0.025, AUTO_BLACK, 6);
    }
    // windscreen with frame and wiper
    kit.add('glass', new THREE.PlaneGeometry(1.08, 0.52), { p: [0, 1.56, -0.6], r: [-0.12, 0, 0] });
    kit.add('paint', box(1.16, 0.05, 0.05), { p: [0, 1.84, -0.63] }, AUTO_BLACK);
    kit.add('paint', box(1.16, 0.05, 0.06), { p: [0, 1.3, -0.57] }, AUTO_BLACK);
    rod(kit, 'detail', [0.34, 1.35, -0.565], [-0.12, 1.37, -0.575], 0.008, 0x111111, 4);
    // headlight and indicators on the nose
    kit.add('paint', cyl(0.13, 0.13, 0.08, 14), { p: [0, 0.98, 0.02], r: [HALF_PI, 0, 0] }, CHROME);
    kit.add('lampWarm', cyl(0.1, 0.1, 0.02, 14), { p: [0, 0.98, 0.065], r: [HALF_PI, 0, 0] }, 0xfff6d0);
    for (const sx of [-1, 1]) {
      kit.add('lampWarm', rbox(0.1, 0.06, 0.05, 0.02), { p: [sx * 0.34, 1.16, -0.05] }, 0xff9a1f);
      // mirrors on stalks
      rod(kit, 'detail', [sx * 0.5, 1.3, -0.52], [sx * 0.62, 1.52, -0.5], 0.012, 0x111111, 4);
      kit.add('paint', cyl(0.07, 0.07, 0.02, 10), { p: [sx * 0.63, 1.56, -0.5], r: [HALF_PI, 0, 0] }, CHROME);
    }
    kit.add('paint', box(0.05, 0.36, 0.04), { p: [0, 0.74, 0.005], r: [-0.25, 0, 0] }, CHROME);
    // number plate on the nose
    kit.add('paint', box(0.38, 0.12, 0.03), { p: [0, 0.68, 0.05] }, 0x141414);
    kit.add('plate', new THREE.PlaneGeometry(0.36, 0.1), { p: [0, 0.68, 0.066] });
    // front wheel, fork and mudguard
    kit.add('paint', cyl(0.26, 0.26, 0.14, 14), { p: [0, 0.26, -0.3], r: [0, 0, HALF_PI] }, 0x1a1a1a);
    kit.add('paint', cyl(0.13, 0.13, 0.16, 10), { p: [0, 0.26, -0.3], r: [0, 0, HALF_PI] }, CHROME);
    kit.add('paint', new THREE.TorusGeometry(0.3, 0.05, 4, 10, Math.PI), { p: [0, 0.3, -0.3], r: [0, HALF_PI, 0], s: [1, 1, 1.6] }, AUTO_BLACK);
    // rear wheels
    for (const sx of [-1, 1]) {
      kit.add('paint', cyl(0.26, 0.26, 0.16, 14), { p: [sx * 0.5, 0.26, -2.36], r: [0, 0, HALF_PI] }, 0x1a1a1a);
      kit.add('paint', cyl(0.13, 0.13, 0.17, 10), { p: [sx * 0.5, 0.26, -2.36], r: [0, 0, HALF_PI] }, CHROME);
    }
    // interior: handlebar, driver seat, passenger bench
    kit.add('detail', cyl(0.02, 0.02, 0.8, 6), { p: [0, 1.28, -0.72], r: [0, 0, HALF_PI] }, 0x111111);
    for (const sx of [-1, 1]) kit.add('detail', cyl(0.03, 0.03, 0.12, 6), { p: [sx * 0.42, 1.28, -0.72], r: [0, 0, HALF_PI] }, 0x8a1f1f);
    const seat = variant ? 0x8e2a2a : 0x2f5d8a;
    kit.add('paint', rbox(0.42, 0.12, 0.34, 0.04), { p: [0, 0.98, -1.05] }, seat);
    kit.add('paint', rbox(0.42, 0.3, 0.08, 0.03), { p: [0, 1.16, -1.24] }, seat);
    kit.add('paint', rbox(1.06, 0.16, 0.5, 0.05), { p: [0, 0.95, -1.95] }, seat);
    kit.add('paint', rbox(1.06, 0.5, 0.14, 0.05), { p: [0, 1.42, -2.28] }, seat);
    // fare meter on a stalk at the left
    rod(kit, 'detail', [-0.56, 1.2, -0.8], [-0.66, 1.4, -0.8], 0.015, 0x111111, 4);
    kit.add('paint', rbox(0.1, 0.12, 0.2, 0.02), { p: [-0.66, 1.46, -0.8] }, 0x333333);
    kit.add('meter', new THREE.PlaneGeometry(0.17, 0.1), { p: [-0.66, 1.46, -0.699] });
    // tail lights
    for (const sx of [-1, 1]) kit.add('lampRed', rbox(0.1, 0.08, 0.04, 0.015), { p: [sx * 0.45, 0.82, -2.99] }, 0xff3b30);
    // rear plate on the back of the body
    kit.add('paint', box(0.38, 0.12, 0.03), { p: [0, 0.6, -2.98] }, 0x141414);
    return { kit };
  }, true);
  return instantiate(baked, 'auto', true);
}

// ---------------------------------------------------------------------------
// Cow (standing or sitting), head toward +z.

const COW_COATS = [0xfffaf2, 0xf2e2c4, 0xe6e2dc];

export function buildCow(seed = 0): THREE.Group {
  const s = Math.abs(Math.floor(seed));
  const sitting = s % 2 === 1;
  const coat = COW_COATS[s % COW_COATS.length];
  const baked = bake(`cow:${sitting ? 'sit' : 'stand'}:${s % COW_COATS.length}`, () => {
    const kit = new Kit();
    const bodyY = sitting ? 0.46 : 1.0;
    const dark = shade(coat, 0.72);
    // body, hump, jhool cloth
    kit.add('paint', ball(1, 14, 10), { p: [0, bodyY, -1.45], s: [0.46, 0.37, 0.86] }, coat);
    kit.add('paint', ball(1, 10, 8), { p: [0, bodyY + 0.3, -0.85], s: [0.2, 0.2, 0.26] }, coat);
    kit.add('jhool', new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, 0, 1.2), { p: [0, bodyY - 0.02, -1.5], s: [0.48, 0.4, 0.74] });
    // patches on the flank
    if (s % 3 === 2) {
      for (const [x, y, z] of [[0.3, 0.1, -1.7], [-0.32, 0.05, -1.25]] as V3[]) kit.add('paint', ball(1, 8, 6), { p: [x, bodyY + y, z], s: [0.14, 0.16, 0.22] }, 0x8a8580);
    }
    // neck and dewlap
    if (sitting) {
      kit.add('paint', ball(1, 10, 8), { p: [0, 0.86, -0.52], r: [-0.5, 0, 0], s: [0.19, 0.38, 0.22] }, coat);
      kit.add('paint', ball(1, 8, 6), { p: [0, 0.7, -0.36], s: [0.05, 0.22, 0.14] }, coat);
    } else {
      kit.add('paint', ball(1, 10, 8), { p: [0, 1.12, -0.58], r: [0.4, 0, 0], s: [0.19, 0.26, 0.3] }, coat);
      kit.add('paint', ball(1, 8, 6), { p: [0, 0.86, -0.5], s: [0.05, 0.24, 0.2] }, coat);
    }
    // head
    const hy = 1.18;
    const hz = -0.32;
    kit.add('paint', ball(1, 10, 8), { p: [0, hy, hz], r: [0.55, 0, 0], s: [0.16, 0.18, 0.28] }, coat);
    kit.add('paint', ball(1, 10, 6), { p: [0, hy - 0.15, hz + 0.21], s: [0.12, 0.1, 0.1] }, 0xc9a09a);
    for (const sx of [-1, 1]) {
      kit.add('detail', ball(1, 6, 4), { p: [sx * 0.045, hy - 0.13, hz + 0.3], s: [0.02, 0.015, 0.01] }, 0x2a1a18);
      // eyes with catchlights
      kit.add('detail', ball(0.042, 8, 6), { p: [sx * 0.125, hy + 0.05, hz + 0.1] }, 0x1a1210);
      kit.add('spark', ball(0.014, 4, 3), { p: [sx * 0.14, hy + 0.07, hz + 0.14] }, 0xffffff);
      // droopy ears
      kit.add('paint', ball(1, 8, 5), { p: [sx * 0.24, hy + 0.02, hz - 0.12], r: [0, sx * 0.4, -sx * 0.6], s: [0.14, 0.05, 0.07] }, dark);
      // painted horns (two segments) with brass tips
      const base: V3 = [sx * 0.08, hy + 0.14, hz - 0.12];
      const mid: V3 = [sx * 0.17, hy + 0.27, hz - 0.14];
      const tip: V3 = [sx * 0.15, 1.56, hz - 0.08];
      rod(kit, 'paint', base, mid, 0.045, sx < 0 ? 0xe8433a : 0x2f80c9, 6, 0.035);
      rod(kit, 'paint', mid, tip, 0.035, sx < 0 ? 0x2f80c9 : 0xe8433a, 6, 0.018);
      kit.add('detail', ball(0.026, 6, 4), { p: tip }, 0xffc93c);
    }
    // tilak on the forehead
    kit.add('detail', cyl(0.035, 0.035, 0.01, 8), { p: [0, hy + 0.1, hz + 0.13], r: [1.05, 0, 0] }, 0xe8261e);
    // neck cord, bell and bead necklace
    const cordY = sitting ? 0.82 : 0.98;
    const cordZ = sitting ? -0.46 : -0.5;
    kit.add('paint', new THREE.TorusGeometry(0.2, 0.025, 4, 14), { p: [0, cordY, cordZ], r: [HALF_PI + 0.5, 0, 0] }, 0xe8433a);
    const bellY = cordY - 0.2;
    kit.add('paint', new THREE.LatheGeometry([new THREE.Vector2(0.075, -0.06), new THREE.Vector2(0.06, -0.04), new THREE.Vector2(0.04, 0.03), new THREE.Vector2(0.001, 0.06)], 10), { p: [0, bellY, cordZ + 0.16] }, 0xe0a82e);
    kit.add('detail', ball(0.02, 5, 4), { p: [0, bellY - 0.07, cordZ + 0.16] }, 0x7a5a1a);
    const beads = [0xffd400, 0x29c7e0, 0xe5399b, 0x3fb27f];
    for (let i = 0; i < 8; i++) {
      const a = -HALF_PI + ((i - 3.5) / 8) * 2.4;
      kit.add('detail', new THREE.IcosahedronGeometry(0.03, 0), { p: [Math.cos(a) * 0.19, cordY - 0.1 + Math.sin(a) * 0.08 + 0.08, cordZ + 0.12 + Math.sin(a + HALF_PI) * 0.0] }, beads[i % 4]);
    }
    // legs
    if (sitting) {
      for (const sx of [-1, 1]) {
        kit.add('paint', cyl(0.07, 0.07, 0.4, 8), { p: [sx * 0.2, 0.08, -0.82], r: [HALF_PI, 0, 0] }, coat);
        kit.add('paint', cyl(0.06, 0.06, 0.07, 8), { p: [sx * 0.2, 0.08, -0.6], r: [HALF_PI, 0, 0] }, 0x3a2e28);
        kit.add('paint', ball(1, 8, 6), { p: [sx * 0.36, 0.14, -2.0], s: [0.12, 0.14, 0.32] }, coat);
        kit.add('paint', cyl(0.06, 0.06, 0.07, 8), { p: [sx * 0.42, 0.06, -1.7], r: [HALF_PI, 0, 0] }, 0x3a2e28);
      }
    } else {
      for (const z of [-0.85, -2.02]) {
        for (const sx of [-1, 1]) {
          kit.add('paint', cyl(0.085, 0.06, 0.62, 8), { p: [sx * 0.22, 0.41, z] }, coat);
          kit.add('paint', ball(0.075, 6, 5), { p: [sx * 0.22, 0.4, z] }, coat);
          kit.add('paint', cyl(0.062, 0.07, 0.1, 8), { p: [sx * 0.22, 0.05, z] }, 0x3a2e28);
        }
      }
      // udder hint
      kit.add('paint', ball(1, 8, 5), { p: [0, 0.66, -1.8], s: [0.12, 0.08, 0.14] }, 0xe8b4a8);
    }
    // tail with tuft
    const tailTop: V3 = [0, bodyY + 0.22, -2.28];
    const tailEnd: V3 = sitting ? [0.35, 0.14, -2.42] : [0.03, 0.45, -2.42];
    rod(kit, 'paint', tailTop, tailEnd, 0.022, coat, 5, 0.018);
    kit.add('paint', ball(1, 6, 5), { p: [tailEnd[0], tailEnd[1] - 0.05, tailEnd[2]], s: [0.05, 0.1, 0.05] }, 0x2a2420);
    return { kit };
  }, true);
  return instantiate(baked, 'cow', true);
}

// ---------------------------------------------------------------------------
// Coin (single geometry + material, instancing-friendly).

let coinGeo: THREE.BufferGeometry | null = null;
let coinMat: THREE.Material | null = null;

/** Rupee coin geometry: diameter 0.7 m, faces toward ±z, centred at the origin (280 triangles). */
export function coinGeometry(): THREE.BufferGeometry {
  if (coinGeo) return coinGeo;
  const R = 0.35;
  const t = 0.035; // face half-thickness
  const rim = 0.058; // rim half-thickness
  const pts = [
    [0.0, -t],
    [0.27, -t],
    [0.29, -rim],
    [R, -0.045],
    [R, 0.045],
    [0.29, rim],
    [0.27, t],
    [0.0, t],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const lathe = new THREE.LatheGeometry(pts, 20);
  lathe.rotateX(HALF_PI); // lathe axis (y) -> z
  const pos = lathe.getAttribute('position');
  const uv = lathe.getAttribute('uv');
  const d = R * 2 * 1.13; // face texture radius 99/256 of the canvas vs rim ring
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const back = pos.getZ(i) < 0;
    let u = x / d + 0.5;
    if (back) u = 1 - u;
    uv.setXY(i, u, y / d + 0.5);
  }
  uv.needsUpdate = true;
  lathe.computeBoundingBox();
  lathe.computeBoundingSphere();
  coinGeo = lathe;
  return lathe;
}

/** Shared emissive gold coin material (toon-shaded, curved). */
export function coinMaterial(): THREE.Material {
  if (coinMat) return coinMat;
  const map = coinTexture();
  const m = lift(toonMaterial({ color: map ? 0xffffff : 0xffc93c, map, emissive: 0xffe066, emissiveIntensity: 0.28 }), 0.1, 1.15);
  if (map) m.emissiveMap = map;
  coinMat = m;
  return m;
}

export function buildCoin(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'coin';
  const mesh = new THREE.Mesh(coinGeometry(), coinMaterial());
  mesh.name = 'coin-body';
  group.add(mesh);
  addOutline(group);
  return group;
}

// ---------------------------------------------------------------------------
// Pickups

export type PickupKind = 'magnet' | 'rocket' | 'chappal';

function centerBaked(baked: Baked[]): void {
  const b3 = new THREE.Box3();
  for (const b of baked) {
    b.geometry.computeBoundingBox();
    b3.union(b.geometry.boundingBox!);
  }
  const c = b3.getCenter(new THREE.Vector3());
  for (const b of baked) {
    b.geometry.translate(-c.x, -c.y, -c.z);
    b.geometry.computeBoundingBox();
    b.geometry.computeBoundingSphere();
  }
}

function sparkle(kit: Kit, p: V3, size: number, color: THREE.ColorRepresentation): void {
  kit.add('spark', new THREE.OctahedronGeometry(size, 0), { p, s: [0.35, 1, 0.35] }, color);
  kit.add('spark', new THREE.OctahedronGeometry(size, 0), { p, s: [1, 0.35, 0.35] }, color);
}

function magnetKit(): Kit {
  const kit = new Kit();
  const R = 0.24;
  const tube = 0.1;
  kit.add('paint', new THREE.TorusGeometry(R, tube, 8, 16, Math.PI), {}, 0xe8332a);
  for (const sx of [-1, 1]) {
    kit.add('paint', cyl(tube, tube, 0.2, 12), { p: [sx * R, -0.1, 0] }, 0xe8332a);
    kit.add('paint', cyl(tube * 1.02, tube * 1.02, 0.16, 12), { p: [sx * R, -0.28, 0] }, 0xdfe6ea);
    kit.add('paint', cyl(tube * 1.04, tube * 1.04, 0.025, 12), { p: [sx * R, -0.2, 0] }, 0x8a949a);
  }
  // glint
  kit.add('spark', new THREE.TorusGeometry(R, 0.02, 3, 8, 0.9), { p: [0, 0, 0.085], r: [0, 0, 1.6] }, 0xffd0c8);
  sparkle(kit, [0.36, 0.28, 0.05], 0.07, 0xfff3a0);
  sparkle(kit, [-0.4, -0.02, 0.05], 0.05, 0xffffff);
  return kit;
}

function rocketKit(): Kit {
  const kit = new Kit();
  // stick
  kit.add('paint', cyl(0.016, 0.016, 0.95, 5), { p: [-0.07, -0.08, 0] }, 0x9a6a34);
  // paper tube + nose cone + base
  kit.add('rocketPaper', cyl(0.095, 0.095, 0.4, 14), { p: [0.04, 0.12, 0] });
  kit.add('paint', new THREE.ConeGeometry(0.11, 0.2, 14), { p: [0.04, 0.42, 0] }, 0xe8332a);
  kit.add('paint', ball(0.03, 6, 4), { p: [0.04, 0.53, 0] }, 0xffd400);
  kit.add('paint', cyl(0.1, 0.1, 0.03, 14), { p: [0.04, 0.32, 0] }, 0xffd400);
  kit.add('paint', cyl(0.08, 0.06, 0.05, 12), { p: [0.04, -0.1, 0] }, 0x3a3a3a);
  // twine ties
  for (const y of [0.0, 0.22]) kit.add('detail', new THREE.TorusGeometry(0.1, 0.012, 3, 12), { p: [0.04, y, 0], r: [HALF_PI, 0, 0] }, 0xf4f4f4);
  // fuse and sparks
  rod(kit, 'detail', [0.04, -0.12, 0], [0.08, -0.22, 0.02], 0.008, 0x3fb27f, 3);
  sparkle(kit, [0.09, -0.26, 0.04], 0.07, 0xffe45a);
  sparkle(kit, [0.02, -0.32, 0.06], 0.05, 0xff7a29);
  sparkle(kit, [0.15, -0.3, 0.02], 0.04, 0xffffff);
  return kit;
}

function soleShape(mirror: number): THREE.Shape {
  const s = new THREE.Shape();
  const m = (x: number) => x * mirror;
  s.moveTo(m(0), 0);
  s.bezierCurveTo(m(0.1), 0, m(0.11), 0.1, m(0.1), 0.2);
  s.bezierCurveTo(m(0.09), 0.3, m(0.15), 0.4, m(0.14), 0.52);
  s.bezierCurveTo(m(0.13), 0.66, m(0.02), 0.68, m(-0.04), 0.64);
  s.bezierCurveTo(m(-0.12), 0.6, m(-0.12), 0.46, m(-0.11), 0.36);
  s.bezierCurveTo(m(-0.1), 0.24, m(-0.1), 0.08, m(-0.08), 0.03);
  s.bezierCurveTo(m(-0.06), 0, m(-0.03), 0, m(0), 0);
  return s;
}

function wingShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0.02, 0.1);
  s.quadraticCurveTo(0.12, 0.24, 0.3, 0.26);
  s.quadraticCurveTo(0.26, 0.2, 0.3, 0.17);
  s.quadraticCurveTo(0.24, 0.12, 0.27, 0.08);
  s.quadraticCurveTo(0.18, 0.05, 0.2, 0.0);
  s.quadraticCurveTo(0.1, 0.03, 0, 0);
  return s;
}

function chappalKit(): Kit {
  const kit = new Kit();
  const sole = 0x8a4a1c;
  const top = 0xd08a44;
  const strap = 0xb2581e;
  for (const side of [-1, 1]) {
    const x0 = side * 0.17;
    const angle = side * 0.12;
    const pl = (x: number, y: number, z: number): V3 => {
      // sole-local (x across, z along the foot, toe toward -z), rotated about y by `angle`
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      return [x0 + x * c + z * sn, y, -x * sn + z * c];
    };
    const soleGeo = new THREE.ExtrudeGeometry(soleShape(side), { depth: 0.035, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 5 });
    // shape (x, y) lies in xy; lay it flat: y (along foot) -> -z, extrusion -> y
    soleGeo.rotateX(-HALF_PI);
    soleGeo.translate(0, 0, 0.32);
    kit.add('paint', soleGeo, { p: [x0, 0, 0], r: [0, angle, 0] }, sole);
    const insole = new THREE.ExtrudeGeometry(soleShape(side), { depth: 0.01, bevelEnabled: false, curveSegments: 5 });
    insole.scale(0.86, 0.94, 1);
    insole.rotateX(-HALF_PI);
    insole.translate(0, 0.045, 0.3);
    kit.add('detail', insole, { p: [x0, 0, 0], r: [0, angle, 0] }, top);
    // wide cross straps
    for (const [z, rz] of [[-0.12, 0.25], [-0.16, -0.25]] as [number, number][]) {
      kit.add('paint', new THREE.TorusGeometry(0.115, 0.022, 4, 10, Math.PI), { p: pl(0, 0.05, z), r: [0, angle + rz, 0], s: [1, 0.9, 2.2] }, strap);
    }
    // braided front band with a gold stud
    kit.add('detail', new THREE.TorusGeometry(0.12, 0.016, 4, 10, Math.PI), { p: pl(0, 0.05, -0.02), r: [0, angle, 0] }, 0xe8433a);
    kit.add('detail', ball(0.026, 6, 4), { p: pl(0, 0.17, -0.02) }, 0xffc93c);
    // toe ring
    kit.add('detail', new THREE.TorusGeometry(0.03, 0.01, 4, 8), { p: pl(side * -0.05, 0.08, -0.25), r: [0, angle + HALF_PI, 0] }, strap);
    // wing at the heel, outer side
    const wingPos = pl(side * 0.1, 0.06, 0.2);
    const wingRot: V3 = [0, side > 0 ? -0.5 : Math.PI + 0.5, 0.25];
    kit.add('wing', new THREE.ExtrudeGeometry(wingShape(), { depth: 0.024, bevelEnabled: false, curveSegments: 4 }), { p: wingPos, r: wingRot }, 0xffffff);
    // pale blue inner feathers
    const inner = new THREE.ExtrudeGeometry(wingShape(), { depth: 0.03, bevelEnabled: false, curveSegments: 3 });
    inner.scale(0.62, 0.62, 1);
    inner.translate(0.02, 0.02, -0.003);
    kit.add('detail', inner, { p: wingPos, r: wingRot }, 0x8fdcff);
  }
  sparkle(kit, [0.42, 0.28, 0.0], 0.06, 0xfff3a0);
  sparkle(kit, [-0.44, 0.2, -0.1], 0.045, 0xffffff);
  return kit;
}

export function buildPickup(kind: PickupKind): THREE.Group {
  const baked = bake(`pickup:${kind}`, () => {
    const kit = kind === 'magnet' ? magnetKit() : kind === 'rocket' ? rocketKit() : chappalKit();
    return { kit };
  }, false);
  if (!baked[0].geometry.userData.centred) {
    centerBaked(baked);
    for (const b of baked) b.geometry.userData.centred = true;
  }
  const inner = instantiate(baked, kind, false);
  // pose each pickup so it reads from the chase camera
  const scale = kind === 'magnet' ? 1.08 : kind === 'rocket' ? 1.0 : 1.05;
  inner.scale.setScalar(scale);
  if (kind === 'rocket') inner.rotation.z = -0.55;
  if (kind === 'magnet') inner.rotation.z = -0.3;
  if (kind === 'chappal') inner.rotation.x = 0.75;
  const group = new THREE.Group();
  group.name = `pickup-${kind}`;
  group.add(inner);
  return group;
}

// ---------------------------------------------------------------------------
// Hoverboard: a flying carpet with tassels.

const carpetWave = (z: number) => 0.035 * Math.sin(z * 4.2) + (z < -0.7 ? (z + 0.7) * (z + 0.7) * 0.9 : 0);

/**
 * The flying carpet, optionally in a shop skin (src/app/progression.ts). A skin is a recolour:
 * `id` keys the baked geometry, the rug texture and the two materials that are not vertex-coloured,
 * so a board is built once and equipping it again later costs nothing.
 */
export function buildHoverboard(skin?: { id: string; palette?: BoardPalette } | null): THREE.Group {
  const p: Required<BoardPalette> = { ...BOARD_BASE, ...(skin?.palette ?? {}) };
  const key = skin?.palette ? `hoverboard:${skin.id}` : 'hoverboard';
  const baked = bake(key, () => {
    const kit = new Kit();
    const W = 0.9;
    const L = 1.8;
    const cloth = new THREE.BoxGeometry(W, 0.045, L, 3, 1, 14);
    const pos = cloth.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + carpetWave(pos.getZ(i)));
    cloth.computeVertexNormals();
    kit.add('carpet', cloth);
    // tassels at both short ends
    for (const z of [-L / 2, L / 2]) {
      const dir = Math.sign(z);
      for (let i = 0; i < 6; i++) {
        const x = -W / 2 + 0.075 + i * ((W - 0.15) / 5);
        const zz = z + dir * 0.03;
        const y = carpetWave(z);
        kit.add('detail', ball(0.022, 5, 4), { p: [x, y, zz] }, p.trim);
        kit.add('detail', new THREE.ConeGeometry(0.03, 0.1, 5), { p: [x, y - 0.02, zz + dir * 0.06], r: [-dir * 1.25, 0, 0] }, i % 2 ? p.trim : p.glow);
      }
    }
    // magic glow under the carpet
    kit.add('glow', new THREE.PlaneGeometry(1.4, 2.3), { p: [0, -0.14, 0.05], r: [-HALF_PI, 0, 0] });
    sparkle(kit, [0.36, 0.1, 0.6], 0.06, 0xbff4ff);
    sparkle(kit, [-0.38, 0.08, -0.2], 0.05, 0xffffff);
    sparkle(kit, [0.34, 0.08, -0.5], 0.04, 0xfff3a0);
    return { kit };
  }, false);
  if (!baked[0].geometry.userData.centred) {
    centerBaked(baked);
    for (const b of baked) b.geometry.userData.centred = true;
  }
  const group = instantiate(baked, 'hoverboard', false);
  if (skin?.palette) {
    // The rug and the glow are the two parts whose colour is not in the vertex stream: give this
    // skin its own materials rather than tinting the shared ones out from under the default board.
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.isOutline) continue;
      if (mesh.name.endsWith('-carpet')) mesh.material = carpetMaterial(key, p);
      else if (mesh.name.endsWith('-glow')) mesh.material = boardGlowMaterial(key, p);
    }
  }
  return group;
}

function carpetMaterial(key: string, p: Required<BoardPalette>): THREE.Material {
  return material(`${key}:carpet`, () => lift(toonMaterial({ vertexColors: true, map: carpetTexture(key, p) }), 0.08));
}

function boardGlowMaterial(key: string, p: Required<BoardPalette>): THREE.Material {
  return material(`${key}:glow`, () =>
    basicMaterial({
      map: glowTexture(),
      color: p.glow,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
}

// ---------------------------------------------------------------------------
// Magnet aura: translucent fresnel sphere + equator ring. Radius 1; scale as needed.

let auraGeo: THREE.SphereGeometry | null = null;
let auraRingGeo: THREE.TorusGeometry | null = null;
let auraMat: THREE.MeshBasicMaterial | null = null;
let auraRingMat: THREE.MeshBasicMaterial | null = null;

function makeAuraMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: 0x6fd1ff,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFresnel;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vFresnel = 1.0 - abs( dot( normalize( normalMatrix * normal ), normalize( -mvPosition.xyz ) ) );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFresnel;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= 0.35 + 2.6 * pow( vFresnel, 2.2 );');
  };
  m.customProgramCacheKey = () => 'magnet-aura';
  return applyCurve(m);
}

export function buildMagnetAura(): THREE.Mesh {
  auraGeo ??= new THREE.SphereGeometry(1, 24, 16);
  auraRingGeo ??= new THREE.TorusGeometry(1, 0.025, 4, 48);
  auraMat ??= makeAuraMaterial();
  auraRingMat ??= basicMaterial({ color: 0x9fe4ff, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const aura = new THREE.Mesh(auraGeo, auraMat);
  aura.name = 'magnetAura';
  aura.renderOrder = 10;
  const ring = new THREE.Mesh(auraRingGeo, auraRingMat);
  ring.rotation.x = HALF_PI;
  ring.name = 'magnetAura-ring';
  aura.add(ring);
  return aura;
}

/**
 * Pulses an aura made by buildMagnetAura (period 0.6 s). `t` is time in seconds,
 * `radius` its base radius. Note: the aura material is shared, so opacity pulses
 * for all auras at once (there is only ever one).
 */
export function updateMagnetAura(aura: THREE.Object3D, t: number, radius = 1.2): void {
  const k = Math.sin((t * Math.PI * 2) / 0.6);
  aura.scale.setScalar(radius * (1 + 0.05 * k));
  const ring = aura.children[0];
  if (ring) {
    ring.rotation.z = t * 1.5;
    ring.position.y = 0.35 * Math.sin(t * 2.4);
    ring.scale.setScalar(Math.cos(Math.asin(Math.min(0.95, ring.position.y))) );
  }
  if (auraMat) auraMat.opacity = 0.2 + 0.05 * k;
}
