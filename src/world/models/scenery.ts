import * as THREE from 'three';
import { flatMaterial } from '../render/materials';
import { canvasTexture, seededRandom, speckle, streaks } from '../render/canvasTexture';
import {
  GROUND_Y,
  MAST_SPACING,
  PartBuilder,
  VIEW_AHEAD,
  VIEW_BEHIND,
  atlasRect,
  boxFaceRanges,
  curveBox,
  groupFromParts,
  remapUV,
  scaleUV,
  tf,
  vertexColorMaterial,
  type UVRect,
} from './trackKit';

/**
 * Mumbai rail-corridor scenery. Side pieces face +x (toward the track when placed on the
 * left), their front is at local x = 0 and they extend to -x; along the track they start
 * at z = 0 and extend toward -z (unless noted as centred). Everything stays at |x| >= 4.2
 * once placed.
 */

type Parts = { material: THREE.Material; geometry: THREE.BufferGeometry }[];

const FONT_BLOCK = '"Arial Black", Impact, "DejaVu Sans", "Liberation Sans", sans-serif';
const FONT_SANS = '"Liberation Sans", Arial, "DejaVu Sans", sans-serif';
const FONT_DEVA = '"Noto Sans Devanagari", "Nirmala UI", Mangal, FreeSans, sans-serif';

export const GRAFFITI = ['#E5399B', '#29C7E0', '#FF7A29', '#FFD400'] as const;
export const CHAWL_COLORS = ['#D9A441', '#4C8C7D', '#8FB8C9', '#C1622B', '#EDE6D6', '#E3A6AE', '#B7C98F'] as const;

// ---------------------------------------------------------------------------------
// Small helpers

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  if (k < 0) c.multiplyScalar(1 + k);
  else c.lerp(new THREE.Color(1, 1, 1), k);
  return `#${c.getHexString()}`;
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, size: number, maxW: number): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    s = Math.floor((s * maxW) / w);
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Centred text scaled down to fit maxW. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxW: number, color: string, o: { weight?: string; family?: string; stroke?: string; strokeW?: number } = {}): void {
  fitFont(ctx, text, o.weight ?? '900', o.family ?? FONT_BLOCK, size, maxW);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (o.stroke) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.strokeW ?? size * 0.15;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Graffiti bubble letters: extruded shadow, white and black outlines, gradient fill. */
function bubbleText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, size: number, top: string, bottom: string, tilt = 0): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  ctx.font = `900 ${size}px ${FONT_BLOCK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width * 0.9);
  const total = widths.reduce((a, b) => a + b, 0);
  let x = -total / 2;
  const placed = chars.map((ch, i) => {
    const p = { ch, x: x + widths[i] / 2, y: Math.sin(i * 1.7) * size * 0.08, r: Math.sin(i * 2.3) * 0.13 };
    x += widths[i];
    return p;
  });
  const pass = (fn: (ch: string) => void) => {
    for (const p of placed) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      fn(p.ch);
      ctx.restore();
    }
  };
  ctx.fillStyle = '#141414';
  for (let d = size * 0.12; d > 0; d -= 2) pass((ch) => ctx.fillText(ch, d * 0.7, d));
  ctx.strokeStyle = '#F4F4F4';
  ctx.lineWidth = size * 0.3;
  pass((ch) => ctx.strokeText(ch, 0, 0));
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = size * 0.17;
  pass((ch) => ctx.strokeText(ch, 0, 0));
  pass((ch) => {
    const g = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillText(ch, 0, 0);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  pass(() => {
    ctx.beginPath();
    ctx.ellipse(-size * 0.12, -size * 0.22, size * 0.07, size * 0.035, -0.4, 0, Math.PI * 2);
    ctx.fill();
  });
  // Drips.
  ctx.fillStyle = bottom;
  pass(() => {
    if (Math.random() < 0.35) ctx.fillRect(-size * 0.05, size * 0.3, size * 0.04, size * (0.15 + Math.random() * 0.25));
  });
  ctx.restore();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, points = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.stroke();
}

function concrete(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rand: () => number, base = '#B8AFA0'): void {
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);
  speckle(ctx, w, h, rand, Math.floor((w * h) / 30), ['#a79e90', '#c6beb1', '#9d9486', '#cfc8bb'], 2);
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `rgba(70,60,50,${0.04 + rand() * 0.06})`;
    ctx.beginPath();
    ctx.ellipse(rand() * w, rand() * h, 10 + rand() * 40, 8 + rand() * 25, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function weather(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rand: () => number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);
  streaks(ctx, w, h, rand, Math.floor(w / 6), 'rgba(50,40,30,0.12)');
  const g = ctx.createLinearGradient(0, h * 0.7, 0, h);
  g.addColorStop(0, 'rgba(60,55,35,0)');
  g.addColorStop(1, 'rgba(60,55,35,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  speckle(ctx, w, h, rand, Math.floor((w * h) / 120), ['rgba(184,175,160,0.5)', 'rgba(90,80,70,0.3)'], 3);
  ctx.restore();
}

// ---------------------------------------------------------------------------------
// Detail atlas (alpha cut-outs, tinted by vertex colour): railings, laundry, fences, plants, people

const DETAIL_SIZE = 1024;
const D = (px: number, py: number, pw: number, ph: number) => atlasRect(px, py, pw, ph, DETAIL_SIZE, DETAIL_SIZE);
export const DETAIL = {
  railing: D(0, 0, 256, 128),
  railing2: D(256, 0, 256, 128),
  clothes: D(0, 128, 512, 128),
  clothes2: D(512, 128, 512, 128),
  fence: D(0, 256, 256, 256),
  plants: D(256, 256, 256, 128),
  mesh: D(512, 256, 256, 256),
  people: Array.from({ length: 8 }, (_, i) => D(i * 128, 512, 128, 256)),
} as const;

const CLOTH_COLORS = ['#E8433A', '#2F80C9', '#FFC93C', '#3FB27F', '#8E5FD1', '#E5399B', '#F4F4F4', '#FF7A29', '#29C7E0', '#7A2E3A'];

function drawClothes(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, rand: () => number, draped: boolean): void {
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + 6);
  ctx.quadraticCurveTo(x0 + w / 2, y0 + 14, x0 + w, y0 + 6);
  ctx.stroke();
  let x = x0 + 4;
  while (x < x0 + w - 30) {
    const kind = rand();
    const col = pick(rand, CLOTH_COLORS);
    const cw = kind < 0.3 ? 60 + rand() * 40 : 34 + rand() * 20;
    const ch = draped ? h * (0.5 + rand() * 0.4) : kind < 0.3 ? h * 0.85 : h * (0.45 + rand() * 0.25);
    const top = y0 + 8;
    ctx.fillStyle = col;
    if (kind < 0.3) {
      // Saree / dupatta: long cloth with a border.
      ctx.fillRect(x, top, cw, ch);
      ctx.fillStyle = pick(rand, ['#FFD400', '#E8433A', '#3FB27F']);
      ctx.fillRect(x, top + ch - 10, cw, 7);
      ctx.fillRect(x + 4, top, 4, ch);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      for (let i = 0; i < 4; i++) ctx.fillRect(x + 12 + i * 12, top + 10 + rand() * 20, 5, 5);
    } else if (kind < 0.65) {
      // Shirt.
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + cw, top);
      ctx.lineTo(x + cw + 6, top + ch * 0.35);
      ctx.lineTo(x + cw - 4, top + ch * 0.38);
      ctx.lineTo(x + cw - 4, top + ch);
      ctx.lineTo(x + 4, top + ch);
      ctx.lineTo(x + 4, top + ch * 0.38);
      ctx.lineTo(x - 6, top + ch * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x + cw / 2 - 1, top + 4, 2, ch - 6);
    } else if (kind < 0.85) {
      // Trousers.
      ctx.fillRect(x, top, cw, ch * 0.25);
      ctx.fillRect(x, top, cw * 0.44, ch);
      ctx.fillRect(x + cw * 0.56, top, cw * 0.44, ch);
    } else {
      // Towel with stripes.
      ctx.fillRect(x, top, cw, ch * 0.7);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(x, top + ch * 0.55, cw, 4);
      ctx.fillRect(x, top + ch * 0.1, cw, 4);
    }
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(x + 3, top - 4, 4, 9);
    ctx.fillRect(x + cw - 7, top - 4, 4, 9);
    x += cw + 6 + rand() * 14;
  }
}

function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rand: () => number, i: number): void {
  const cx = x + w / 2;
  const skin = pick(rand, ['#8d5524', '#a8704a', '#c68642', '#7a4a2a']);
  const top = pick(rand, CLOTH_COLORS);
  const bottom = pick(rand, ['#2c3e50', '#34495e', '#3b2f2f', '#1f3a5f', '#6d6d6d']);
  const female = i % 3 === 1;
  const headR = 13;
  const headY = y + 30;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 3;
  // Legs.
  ctx.fillStyle = female ? top : bottom;
  if (female) {
    ctx.beginPath();
    ctx.moveTo(cx - 20, y + 110);
    ctx.lineTo(cx + 20, y + 110);
    ctx.lineTo(cx + 26, y + 240);
    ctx.lineTo(cx - 26, y + 240);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pick(rand, ['#FFD400', '#E8433A', '#3FB27F']);
    ctx.fillRect(cx - 26, y + 228, 52, 8);
  } else {
    ctx.fillRect(cx - 17, y + 120, 15, 118);
    ctx.fillRect(cx + 2, y + 120, 15, 118);
    ctx.strokeRect(cx - 17, y + 120, 15, 118);
    ctx.strokeRect(cx + 2, y + 120, 15, 118);
  }
  ctx.fillStyle = '#222';
  ctx.fillRect(cx - 20, y + 238, 18, 10);
  ctx.fillRect(cx + 2, y + 238, 18, 10);
  // Torso.
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.roundRect(cx - 22, y + 48, 44, 78, 10);
  ctx.fill();
  ctx.stroke();
  if (female) {
    ctx.fillStyle = pick(rand, ['#E5399B', '#FF7A29', '#29C7E0']);
    ctx.beginPath();
    ctx.moveTo(cx + 22, y + 50);
    ctx.lineTo(cx - 22, y + 110);
    ctx.lineTo(cx - 22, y + 96);
    ctx.lineTo(cx + 12, y + 48);
    ctx.closePath();
    ctx.fill();
  }
  // Arms.
  ctx.fillStyle = top;
  ctx.fillRect(cx - 32, y + 52, 11, 58);
  ctx.fillRect(cx + 21, y + 52, 11, 58);
  ctx.fillStyle = skin;
  ctx.fillRect(cx - 32, y + 108, 11, 14);
  ctx.fillRect(cx + 21, y + 108, 11, 14);
  // Bag or phone.
  if (i % 2 === 0) {
    ctx.fillStyle = pick(rand, ['#1f3a5f', '#E8433A', '#333']);
    ctx.fillRect(cx + 18, y + 90, 24, 34);
    ctx.strokeRect(cx + 18, y + 90, 24, 34);
  }
  // Head and hair.
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1a1210';
  ctx.beginPath();
  ctx.arc(cx, headY - 3, headR, Math.PI, 0);
  ctx.fill();
  if (female) ctx.fillRect(cx - 4, headY, 8, 30);
  ctx.fillRect(cx - 7, headY + 13, 14, 6);
  ctx.fillStyle = skin;
  ctx.fillRect(cx - 6, headY + 12, 12, 8);
}

function detailTexture(): THREE.CanvasTexture {
  const tex = canvasTexture('scenery-detail', DETAIL_SIZE, DETAIL_SIZE, (ctx) => {
    const rand = seededRandom(5);
    ctx.clearRect(0, 0, DETAIL_SIZE, DETAIL_SIZE);
    // Railing 1: vertical bars with a decorative band (light grey, tinted per building).
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, 256, 10);
    ctx.fillRect(0, 118, 256, 10);
    ctx.fillRect(0, 44, 256, 6);
    ctx.fillRect(0, 78, 256, 6);
    for (let x = 4; x < 256; x += 16) ctx.fillRect(x, 0, 5, 128);
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = 4;
    for (let x = 12; x < 256; x += 32) {
      ctx.beginPath();
      ctx.arc(x, 64, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Railing 2: horizontal bars with waves.
    ctx.fillStyle = '#e6e6e6';
    for (let y = 0; y < 128; y += 22) ctx.fillRect(256, y, 256, 6);
    ctx.fillRect(256, 118, 256, 10);
    for (let x = 256; x < 512; x += 64) ctx.fillRect(x, 0, 7, 128);
    ctx.beginPath();
    for (let x = 256; x <= 512; x += 4) ctx.lineTo(x, 64 + Math.sin(x / 10) * 14);
    ctx.stroke();
    // Laundry.
    drawClothes(ctx, 0, 128, 512, 128, rand, false);
    drawClothes(ctx, 512, 128, 512, 110, rand, true);
    // Chain-link fence with barbed wire on top.
    ctx.strokeStyle = '#dcdcdc';
    ctx.lineWidth = 2;
    for (let d = -256; d < 512; d += 18) {
      ctx.beginPath();
      ctx.moveTo(d, 290);
      ctx.lineTo(d + 222, 512);
      ctx.moveTo(d + 222, 290);
      ctx.lineTo(d, 512);
      ctx.stroke();
    }
    ctx.clearRect(256, 256, 256, 256);
    ctx.fillStyle = '#dcdcdc';
    ctx.fillRect(0, 286, 256, 6);
    ctx.fillRect(0, 504, 256, 8);
    for (const y of [262, 274]) {
      ctx.fillRect(0, y, 256, 2);
      for (let x = 6; x < 256; x += 22) {
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 5);
        ctx.lineTo(x + 5, y + 7);
        ctx.moveTo(x + 5, y - 5);
        ctx.lineTo(x - 5, y + 7);
        ctx.stroke();
      }
    }
    // Potted plants.
    for (let x = 262; x < 500; x += 40 + rand() * 20) {
      ctx.fillStyle = '#b5552b';
      ctx.beginPath();
      ctx.moveTo(x, 348);
      ctx.lineTo(x + 30, 348);
      ctx.lineTo(x + 25, 382);
      ctx.lineTo(x + 5, 382);
      ctx.fill();
      for (let l = 0; l < 7; l++) {
        ctx.fillStyle = pick(rand, ['#3f8f3a', '#5cae45', '#2e6f2e']);
        ctx.beginPath();
        ctx.ellipse(x + 15 + (rand() - 0.5) * 30, 336 - rand() * 50, 8, 14, rand() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (rand() < 0.4) {
        ctx.fillStyle = pick(rand, ['#E8433A', '#FFD400', '#E5399B']);
        ctx.beginPath();
        ctx.arc(x + 15, 300 + rand() * 20, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Perforated steel mesh (bridge side panels).
    ctx.fillStyle = '#dcdcdc';
    ctx.fillRect(512, 256, 256, 256);
    for (let y = 262; y < 512; y += 12) for (let x = 518; x < 768; x += 12) ctx.clearRect(x, y, 7, 7);
    ctx.fillRect(512, 256, 256, 14);
    ctx.fillRect(512, 498, 256, 14);
    // People cut-outs.
    for (let i = 0; i < 8; i++) drawPerson(ctx, i * 128, 512, 128, 256, rand, i);
  });
  return tex;
}

function corrugatedTexture(): THREE.CanvasTexture {
  return canvasTexture(
    'scenery-corrugated',
    128,
    128,
    (ctx, w, h) => {
      const rand = seededRandom(9);
      for (let y = 0; y < h; y++) {
        const v = 0.7 + 0.3 * Math.sin((y / h) * Math.PI * 2 * 8);
        const c = Math.floor(170 + 80 * v);
        ctx.fillStyle = `rgb(${c},${c},${c})`;
        ctx.fillRect(0, y, w, 1);
      }
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = `rgba(150,80,40,${0.15 + rand() * 0.25})`;
        ctx.beginPath();
        ctx.ellipse(rand() * w, rand() * h, 3 + rand() * 10, 2 + rand() * 5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(60,50,40,0.12)';
      for (let i = 0; i < 20; i++) ctx.fillRect(rand() * w, 0, 1 + rand() * 2, h);
    },
    { repeat: true },
  );
}

// ---------------------------------------------------------------------------------
// Sign atlas: billboard ads, station boards, train indicator, shop signs

const SIGN_SIZE = 2048;
const S = (px: number, py: number, pw: number, ph: number) => atlasRect(px, py, pw, ph, SIGN_SIZE, SIGN_SIZE);
export const AD_VARIANTS = 5;
export const STATION_NAMES = [
  ['नवापुर', 'NAVAPUR'],
  ['धावडी रोड', 'DHAVDI ROAD'],
  ['भागोनगर', 'BHAAGONAGAR'],
] as const;
export const SIGN = {
  ads: Array.from({ length: AD_VARIANTS }, (_, i) => S(0, i * 384, 1024, 384)),
  station: STATION_NAMES.map((_, i) => S(1024, i * 256, 1024, 256)),
  indicator: S(1024, 768, 1024, 192),
  shops: Array.from({ length: 4 }, (_, i) => S(1024 + (i % 2) * 512, 960 + Math.floor(i / 2) * 96, 512, 96)),
  chai: S(1024, 1152, 512, 160),
  fob: S(1536, 1152, 512, 160),
} as const;

function adChai(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#FF9F1C');
  g.addColorStop(1, '#C1440E');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.moveTo(250, 200);
    const a = (i / 12) * Math.PI * 2;
    ctx.lineTo(250 + Math.cos(a) * 600, 200 + Math.sin(a) * 600);
    ctx.lineTo(250 + Math.cos(a + 0.2) * 600, 200 + Math.sin(a + 0.2) * 600);
    ctx.fill();
  }
  // Cutting-chai glass.
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#141414';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(150, 130);
  ctx.lineTo(330, 130);
  ctx.lineTo(305, 340);
  ctx.lineTo(175, 340);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#B5651D';
  ctx.beginPath();
  ctx.moveTo(158, 170);
  ctx.lineTo(322, 170);
  ctx.lineTo(302, 332);
  ctx.lineTo(178, 332);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#E0A060';
  ctx.fillRect(160, 170, 160, 14);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 7;
  for (const x of [200, 240, 280]) {
    ctx.beginPath();
    ctx.moveTo(x, 110);
    ctx.bezierCurveTo(x - 20, 80, x + 20, 60, x, 30);
    ctx.stroke();
  }
  label(ctx, 'KADAK CHAI', 690, 110, 120, 600, '#FFF3D0', { stroke: '#5a1e00', strokeW: 16 });
  label(ctx, 'कड़क चाय', 690, 215, 78, 520, '#FFD400', { family: FONT_DEVA, weight: 'bold', stroke: '#5a1e00', strokeW: 10 });
  label(ctx, 'Ek cutting, full energy!', 690, 300, 44, 560, '#FFFFFF', { family: FONT_SANS, weight: 'bold italic' });
  star(ctx, 930, 300, 70, '#FFD400', 12);
  label(ctx, '₹10', 930, 302, 44, 90, '#C1440E');
}

function adCricket(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1E88E5');
  g.addColorStop(0.62, '#64B5F6');
  g.addColorStop(0.62, '#3FB27F');
  g.addColorStop(1, '#2E7D4F');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Bat and ball.
  ctx.save();
  ctx.translate(820, 200);
  ctx.rotate(-0.6);
  ctx.fillStyle = '#F2D08A';
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(-40, -60, 80, 250, 16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.fillRect(-14, -170, 28, 115);
  ctx.strokeRect(-14, -170, 28, 115);
  ctx.restore();
  ctx.fillStyle = '#D7263D';
  ctx.beginPath();
  ctx.arc(640, 110, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(640, 110, 28, -1, 1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 5;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(560 - i * 30, 130 + i * 18);
    ctx.lineTo(470 - i * 40, 160 + i * 24);
    ctx.stroke();
  }
  label(ctx, 'GULLY CRICKET', 330, 90, 96, 600, '#FFD400', { stroke: '#0b2e59', strokeW: 16 });
  label(ctx, 'LEAGUE 2026', 330, 190, 80, 560, '#FFFFFF', { stroke: '#0b2e59', strokeW: 14 });
  ctx.fillStyle = '#E8433A';
  ctx.beginPath();
  ctx.roundRect(90, 262, 480, 84, 20);
  ctx.fill();
  label(ctx, 'SIXER MAARO!  छक्का!', 330, 305, 50, 440, '#FFFFFF', { family: FONT_DEVA, weight: 'bold' });
}

function adEnergy(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#FFD400';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#E5399B';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(w * 0.55, h);
  ctx.lineTo(w * 0.7, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 40; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 60 + Math.random() * 120, 4);
  // The can.
  ctx.save();
  ctx.translate(850, 195);
  ctx.rotate(0.18);
  ctx.fillStyle = '#29C7E0';
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.roundRect(-70, -150, 140, 300, 24);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#c9d2d6';
  ctx.fillRect(-60, -150, 120, 20);
  ctx.fillStyle = '#FFD400';
  ctx.beginPath();
  ctx.moveTo(10, -110);
  ctx.lineTo(-40, 10);
  ctx.lineTo(0, 10);
  ctx.lineTo(-20, 110);
  ctx.lineTo(45, -20);
  ctx.lineTo(5, -20);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  bubbleText(ctx, 'BHAAGO', 300, 100, 110, '#FFFFFF', '#29C7E0', -0.05);
  bubbleText(ctx, 'BHAAGO!', 330, 215, 110, '#FF7A29', '#E5399B', -0.05);
  label(ctx, 'ENERGY DRINK  ·  भागो भागो', 330, 320, 44, 560, '#141414', { family: FONT_DEVA, weight: 'bold' });
}

function adFilm(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#2a0845');
  g.addColorStop(0.5, '#8E2DE2');
  g.addColorStop(1, '#F37335');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const rg = ctx.createRadialGradient(780, 240, 20, 780, 240, 300);
  rg.addColorStop(0, 'rgba(255,220,120,0.9)');
  rg.addColorStop(1, 'rgba(255,220,120,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);
  // Hero silhouettes.
  ctx.fillStyle = '#1a0a24';
  for (const [x, s] of [
    [760, 1],
    [900, 0.8],
    [640, 0.75],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, 150 * s + 40, 34 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 70 * s, h);
    ctx.lineTo(x - 55 * s, 200 * s + 50);
    ctx.lineTo(x + 55 * s, 200 * s + 50);
    ctx.lineTo(x + 70 * s, h);
    ctx.fill();
  }
  label(ctx, 'DHOOM', 300, 110, 130, 520, '#FFD400', { stroke: '#141414', strokeW: 14 });
  label(ctx, 'DHADAKA', 300, 225, 110, 540, '#FF7A29', { stroke: '#141414', strokeW: 14 });
  label(ctx, 'IN CINEMAS THIS FRIDAY', 300, 320, 40, 520, '#FFFFFF', { family: FONT_SANS, weight: 'bold' });
  for (let i = 0; i < 5; i++) star(ctx, 60 + i * 30, 30, 11, '#FFD400');
}

function adVadaPav(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#D7263D';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#FFD400';
  for (let x = -h; x < w; x += 70) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + 30, h);
    ctx.lineTo(x + 30 + h, 0);
    ctx.lineTo(x + h, 0);
    ctx.fill();
  }
  ctx.fillStyle = '#D7263D';
  ctx.beginPath();
  ctx.roundRect(40, 30, 600, 324, 30);
  ctx.fill();
  // Vada pav.
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = 7;
  ctx.fillStyle = '#E7B062';
  ctx.beginPath();
  ctx.ellipse(830, 150, 140, 70, 0, Math.PI, 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#C98A2B';
  ctx.beginPath();
  ctx.ellipse(830, 200, 130, 45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#3FB27F';
  ctx.fillRect(710, 228, 240, 14);
  ctx.fillStyle = '#E7B062';
  ctx.beginPath();
  ctx.ellipse(830, 250, 140, 50, 0, 0, Math.PI);
  ctx.fill();
  ctx.stroke();
  label(ctx, 'VADA PAV', 340, 100, 120, 560, '#FFD400', { stroke: '#141414', strokeW: 16 });
  label(ctx, 'KING', 340, 205, 100, 400, '#FFFFFF', { stroke: '#141414', strokeW: 14 });
  label(ctx, 'मुंबई का बर्गर · ₹15', 340, 300, 50, 540, '#FFD400', { family: FONT_DEVA, weight: 'bold' });
}

function stationBoard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, deva: string, eng: string): void {
  ctx.fillStyle = '#141414';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#FFD400';
  ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
  ctx.fillStyle = '#141414';
  ctx.fillRect(x + 22, y + 22, w - 44, 4);
  ctx.fillRect(x + 22, y + h - 26, w - 44, 4);
  label(ctx, deva, x + w / 2, y + h * 0.33, 92, w - 80, '#141414', { family: FONT_DEVA, weight: 'bold' });
  label(ctx, eng, x + w / 2, y + h * 0.72, 84, w - 80, '#141414', { family: FONT_SANS, weight: 'bold' });
}

function signTexture(): THREE.CanvasTexture {
  return canvasTexture('scenery-signs', SIGN_SIZE, SIGN_SIZE, (ctx) => {
    const ads = [adChai, adCricket, adEnergy, adFilm, adVadaPav];
    ads.forEach((draw, i) => {
      ctx.save();
      ctx.translate(0, i * 384);
      ctx.beginPath();
      ctx.rect(0, 0, 1024, 384);
      ctx.clip();
      draw(ctx, 1024, 384);
      // Sun-faded vinyl sheen and seams.
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, 1024, 384);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      for (let x = 256; x < 1024; x += 256) ctx.fillRect(x, 0, 2, 384);
      ctx.restore();
    });
    STATION_NAMES.forEach(([d, e], i) => stationBoard(ctx, 1024, i * 256, 1024, 256, d, e));
    // Train indicator (amber LED rows).
    ctx.fillStyle = '#0c0c0c';
    ctx.fillRect(1024, 768, 1024, 192);
    const rows = [
      ['12:04', 'NAVAPUR', 'S', '12'],
      ['12:09', 'DHAVDI RD', 'F', '15'],
      ['12:13', 'BHAAGONAGAR', 'S', '12'],
    ];
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const y = 768 + 34 + i * 60;
      ctx.font = `bold 44px ${FONT_SANS}`;
      ctx.fillStyle = i === 0 ? '#FF3B30' : '#FFB000';
      ctx.textAlign = 'left';
      ctx.fillText(r[0], 1044, y);
      ctx.fillText(r[1], 1200, y);
      ctx.textAlign = 'right';
      ctx.fillText(r[2], 1880, y);
      ctx.fillText(r[3], 2020, y);
    });
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let x = 1024; x < 2048; x += 5) ctx.fillRect(x, 768, 2, 192);
    for (let y = 768; y < 960; y += 5) ctx.fillRect(1024, y, 1024, 2);
    // Shop signs.
    const shops: [string, string, string][] = [
      ['SAI KIRANA STORES', '#2F80C9', '#FFFFFF'],
      ['गणेश मेडिकल', '#3FB27F', '#FFFFFF'],
      ['BOMBAY TAILORS', '#FFD400', '#D7263D'],
      ['RAJU MOBILE REPAIR', '#E8433A', '#FFFFFF'],
    ];
    shops.forEach(([t, bg, fg], i) => {
      const x = 1024 + (i % 2) * 512;
      const y = 960 + Math.floor(i / 2) * 96;
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, 512, 96);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 3, y + 3, 506, 90);
      label(ctx, t, x + 256, y + 50, 56, 470, fg, { family: i === 1 ? FONT_DEVA : FONT_BLOCK, weight: 'bold' });
    });
    // Chai stall sign.
    ctx.fillStyle = '#B8322B';
    ctx.fillRect(1024, 1152, 512, 160);
    ctx.fillStyle = '#FFD400';
    ctx.fillRect(1024, 1152, 512, 14);
    ctx.fillRect(1024, 1298, 512, 14);
    label(ctx, 'चाय · CHAI', 1280, 1210, 78, 470, '#FFFFFF', { family: FONT_DEVA, weight: 'bold' });
    label(ctx, 'VADA PAV · SAMOSA · ₹10', 1280, 1272, 36, 470, '#FFD400', { family: FONT_SANS, weight: 'bold' });
    // FOB safety banner.
    ctx.fillStyle = '#F4F4F4';
    ctx.fillRect(1536, 1152, 512, 160);
    ctx.fillStyle = '#D7263D';
    ctx.fillRect(1536, 1152, 512, 40);
    label(ctx, 'रूळ ओलांडू नका', 1792, 1174, 30, 480, '#FFFFFF', { family: FONT_DEVA, weight: 'bold' });
    label(ctx, 'USE FOOT', 1792, 1225, 44, 480, '#D7263D', { family: FONT_BLOCK });
    label(ctx, 'OVERBRIDGE', 1792, 1278, 44, 480, '#D7263D', { family: FONT_BLOCK });
  });
}

// ---------------------------------------------------------------------------------
// Wall atlas: 6 rows, each a 16 m x 2.5 m mural split into 4 panels (256 x 160 px)

const WALL_W = 1024;
const WALL_H = 1024;
const WALL_ROW_H = 160;
export const WALL_ROWS = 6;
export const WALL_VARIANTS = 3;
export function wallCell(row: number, col: number): UVRect {
  return atlasRect(col * 256, row * WALL_ROW_H, 256, WALL_ROW_H, WALL_W, WALL_H);
}

function paintedAd(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg: string, lines: [string, string, number, string?][]): void {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(20,20,20,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
  const step = h / (lines.length + 1);
  lines.forEach(([t, col, size, fam], i) => label(ctx, t, x + w / 2, y + step * (i + 1), size, w - 20, col, { family: fam ?? FONT_BLOCK, weight: 'bold' }));
}

function wallTexture(): THREE.CanvasTexture {
  return canvasTexture('scenery-walls', WALL_W, WALL_H, (ctx) => {
    const rand = seededRandom(23);
    const H = WALL_ROW_H;
    for (let r = 0; r < WALL_ROWS; r++) {
      const y = r * H;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, 1024, H);
      ctx.clip();
      concrete(ctx, 0, y, 1024, H, rand, r === 3 ? '#E9E4D8' : '#B8AFA0');
      switch (r) {
        case 0:
          bubbleText(ctx, 'BOMBAY', 250, y + 82, 84, GRAFFITI[1], GRAFFITI[0], -0.04);
          star(ctx, 60, y + 40, 22, GRAFFITI[3]);
          star(ctx, 450, y + 120, 16, GRAFFITI[2]);
          // Cartoon face.
          ctx.fillStyle = GRAFFITI[3];
          ctx.strokeStyle = '#141414';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.arc(640, y + 80, 56, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#141414';
          ctx.fillRect(615, y + 60, 12, 20);
          ctx.fillRect(655, y + 60, 12, 20);
          ctx.beginPath();
          ctx.arc(640, y + 92, 28, 0.2, Math.PI - 0.2);
          ctx.stroke();
          bubbleText(ctx, 'ZOOM', 870, y + 70, 60, GRAFFITI[2], GRAFFITI[3], 0.08);
          label(ctx, 'STICK NO BILLS', 880, y + 135, 20, 200, 'rgba(30,30,30,0.6)', { family: FONT_SANS });
          break;
        case 1:
          paintedAd(ctx, 10, y + 18, 480, 120, '#FFD400', [
            ['BHAAGO BHAAGO', '#E5399B', 52],
            ['ENERGY DRINK', '#141414', 34],
          ]);
          paintedAd(ctx, 520, y + 24, 250, 110, '#2F80C9', [
            ['PAPPU TUITIONS', '#FFFFFF', 30],
            ['Maths · Science', '#FFD400', 22, FONT_SANS],
          ]);
          label(ctx, 'सुरक्षित यात्रा', 900, y + 80, 44, 220, '#B8322B', { family: FONT_DEVA, weight: 'bold' });
          break;
        case 2:
          bubbleText(ctx, 'CHALO', 200, y + 80, 90, GRAFFITI[3], GRAFFITI[2], 0.05);
          for (let i = 0; i < 6; i++) star(ctx, 380 + rand() * 120, y + 20 + rand() * 120, 8 + rand() * 10, pick(rand, GRAFFITI));
          bubbleText(ctx, 'LOCAL', 750, y + 82, 86, GRAFFITI[0], '#8E5FD1', -0.06);
          break;
        case 3:
          ctx.fillStyle = '#D7263D';
          ctx.fillRect(0, y + 14, 1024, 8);
          ctx.fillRect(0, y + 136, 1024, 8);
          label(ctx, 'रेल्वे रूळ ओलांडू नका', 260, y + 60, 44, 460, '#B8322B', { family: FONT_DEVA, weight: 'bold' });
          label(ctx, 'DO NOT CROSS THE RAILWAY TRACKS', 260, y + 108, 30, 470, '#141414', { family: FONT_SANS, weight: 'bold' });
          // Poster collage.
          for (let i = 0; i < 9; i++) {
            const px = 560 + (i % 5) * 88 + rand() * 10;
            const py = y + 26 + (i % 2) * 52 + rand() * 10;
            ctx.fillStyle = pick(rand, ['#F2C230', '#E8433A', '#F4F4F4', '#29C7E0', '#3FB27F']);
            ctx.fillRect(px, py, 70, 52);
            ctx.fillStyle = 'rgba(20,20,20,0.7)';
            ctx.fillRect(px + 8, py + 8, 54, 8);
            ctx.fillRect(px + 8, py + 24, 40, 5);
            ctx.fillRect(px + 8, py + 34, 48, 5);
          }
          break;
        case 4:
          bubbleText(ctx, 'AAMCHI', 190, y + 80, 76, GRAFFITI[2], GRAFFITI[0], -0.05);
          bubbleText(ctx, 'MUMBAI', 510, y + 82, 76, GRAFFITI[1], '#2F80C9', 0.04);
          // A little local train doodle.
          ctx.fillStyle = '#F0E6C8';
          ctx.strokeStyle = '#141414';
          ctx.lineWidth = 5;
          ctx.fillRect(720, y + 60, 280, 60);
          ctx.strokeRect(720, y + 60, 280, 60);
          ctx.fillStyle = '#7A2E3A';
          ctx.fillRect(720, y + 96, 280, 12);
          ctx.fillStyle = '#FFD400';
          ctx.fillRect(720, y + 60, 36, 60);
          ctx.fillStyle = '#29C7E0';
          for (let x = 770; x < 990; x += 40) ctx.fillRect(x, y + 70, 26, 18);
          ctx.fillStyle = '#E5399B';
          ctx.beginPath();
          ctx.arc(1004, y + 40, 12, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 5:
          paintedAd(ctx, 20, y + 20, 300, 118, '#F4F4F4', [
            ['AMBA CEMENT', '#D7263D', 40],
            ['मजबूत घर', '#141414', 30, FONT_DEVA],
          ]);
          paintedAd(ctx, 360, y + 26, 260, 106, '#7A2E3A', [
            ['KADAK CHAI', '#FFD400', 40],
            ['₹10 only', '#FFFFFF', 26, FONT_SANS],
          ]);
          // Sun-and-peacock mural.
          ctx.fillStyle = '#FF7A29';
          ctx.beginPath();
          ctx.arc(780, y + 80, 50, 0, Math.PI * 2);
          ctx.fill();
          for (let i = 0; i < 9; i++) {
            ctx.fillStyle = i % 2 ? '#29C7E0' : '#3FB27F';
            ctx.beginPath();
            ctx.ellipse(900, y + 90, 16, 64, -1.2 + i * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = '#2F80C9';
          ctx.beginPath();
          ctx.ellipse(900, y + 110, 18, 34, 0, 0, Math.PI * 2);
          ctx.fill();
          break;
      }
      weather(ctx, 0, y, 1024, H, rand);
      // Panel seams.
      ctx.fillStyle = 'rgba(40,35,30,0.35)';
      for (let x = 0; x <= 1024; x += 256) ctx.fillRect(x - 2, y, 4, H);
      ctx.restore();
    }
  });
}

// ---------------------------------------------------------------------------------
// Chawl facades

export const FLOOR_H = 3;
const PARAPET = 0.7;
const GALLERY = 1.4;
const END_MARGIN = 0.4;

export interface ChawlParams {
  seed: number;
  storeys: number;
  width: number;
  depth: number;
  color: string;
  grille: string;
  shops: boolean;
  name: string;
  sideAd: number;
}

const CHAWL_PRESETS: Omit<ChawlParams, 'seed'>[] = [
  { storeys: 4, width: 16, depth: 9, color: CHAWL_COLORS[0], grille: '#2f5d62', shops: true, name: 'SHANTI NIWAS · 1936', sideAd: 0 },
  { storeys: 3, width: 12.5, depth: 8, color: CHAWL_COLORS[1], grille: '#efe9dc', shops: false, name: 'LAXMI BHUVAN', sideAd: -1 },
  { storeys: 5, width: 18, depth: 10, color: CHAWL_COLORS[2], grille: '#39424e', shops: true, name: 'GANESH CHAWL · 1952', sideAd: 1 },
  { storeys: 6, width: 14, depth: 10, color: CHAWL_COLORS[3], grille: '#f2efe6', shops: true, name: 'NAVJIVAN MANSION', sideAd: 2 },
  { storeys: 4, width: 15, depth: 9, color: CHAWL_COLORS[4], grille: '#3d6f9e', shops: false, name: 'SAI KRUPA', sideAd: -1 },
];
export const CHAWL_VARIANTS = CHAWL_PRESETS.length;

/** Deterministic chawl parameters (pure). */
export function chawlParams(seed: number): ChawlParams {
  const preset = CHAWL_PRESETS[seed];
  if (preset) return { seed, ...preset };
  const rand = seededRandom(seed * 7919 + 13);
  return {
    seed,
    storeys: 3 + Math.floor(rand() * 4),
    width: 12 + Math.round(rand() * 12) / 2,
    depth: 8 + Math.floor(rand() * 3),
    color: pick(rand, CHAWL_COLORS),
    grille: pick(rand, ['#2f5d62', '#efe9dc', '#39424e', '#3d6f9e', '#6b2e2e']),
    shops: rand() < 0.6,
    name: pick(rand, ['PREM KUTIR', 'ASHA SADAN', 'GOKUL NIWAS', 'MOTI BHUVAN']),
    sideAd: rand() < 0.4 ? Math.floor(rand() * 3) : -1,
  };
}

/** Footprint of a chawl: length along the track and depth away from it (pure). */
export function chawlFootprint(seed: number): { length: number; depth: number; height: number } {
  const p = chawlParams(seed);
  return { length: p.width + END_MARGIN * 2, depth: p.depth + GALLERY, height: p.storeys * FLOOR_H + PARAPET };
}

function bays(p: ChawlParams): number {
  return Math.max(3, Math.round(p.width / 3.2));
}

function facadeTexture(p: ChawlParams): THREE.CanvasTexture {
  const Hb = p.storeys * FLOOR_H + PARAPET;
  const total = p.width + p.depth;
  const ppm = 1024 / total;
  const height = Math.ceil((Hb + 0.3) * ppm);
  return canvasTexture(`facade-${p.seed}`, 1024, height, (ctx, w, h) => {
    const rand = seededRandom(p.seed * 31 + 7);
    const Y = (y: number) => (Hb - y) * ppm;
    const X = (x: number) => x * ppm;
    const fw = X(p.width);
    ctx.fillStyle = p.color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = shade(p.color, -0.1);
    ctx.fillRect(fw, 0, w - fw, h);
    speckle(ctx, w, h, rand, 5000, [shade(p.color, -0.06), shade(p.color, 0.08), shade(p.color, -0.12)], 2);
    const nb = bays(p);
    const bw = p.width / nb;
    // Parapet band with the building name plaque.
    ctx.fillStyle = shade(p.color, 0.18);
    ctx.fillRect(0, Y(Hb), fw, X(PARAPET));
    ctx.fillStyle = shade(p.color, -0.3);
    ctx.fillRect(0, Y(Hb - PARAPET) - 3, fw, 4);
    ctx.fillStyle = '#F4F1E8';
    ctx.fillRect(fw / 2 - X(3), Y(Hb - 0.08), X(6), X(0.54));
    label(ctx, p.name, fw / 2, Y(Hb - 0.35), X(0.36), X(5.6), '#3a2a20', { family: FONT_SANS, weight: 'bold' });

    for (let f = 0; f < p.storeys; f++) {
      const y0 = f * FLOOR_H;
      for (let b = 0; b < nb; b++) {
        const x0 = b * bw;
        if (f === 0 && p.shops && b % 3 !== 1) {
          // Rolling shutter, some half open.
          const sx = X(x0 + 0.3);
          const sw = X(bw - 0.6);
          const open = rand() < 0.5;
          ctx.fillStyle = '#2a1e16';
          ctx.fillRect(sx, Y(2.5), sw, X(2.5));
          if (open) {
            for (let i = 0; i < 12; i++) {
              ctx.fillStyle = pick(rand, CLOTH_COLORS);
              ctx.fillRect(sx + rand() * (sw - 14), Y(0.4 + rand() * 1.6), 12, 10);
            }
          }
          const sh = open ? X(1.1) : X(2.5);
          ctx.fillStyle = '#8c9196';
          ctx.fillRect(sx, Y(2.5), sw, sh);
          ctx.fillStyle = 'rgba(40,40,40,0.35)';
          for (let yy = Y(2.5); yy < Y(2.5) + sh; yy += 5) ctx.fillRect(sx, yy, sw, 1.5);
          ctx.fillStyle = 'rgba(140,80,40,0.35)';
          ctx.fillRect(sx + rand() * sw * 0.6, Y(2.5) + sh * 0.6, sw * 0.3, sh * 0.3);
          continue;
        }
        // Door.
        const doorCol = pick(rand, ['#2f6fb0', '#3a8f5a', '#8b3a2e', '#6b4a2e', '#c9a227', '#5a3a6e']);
        const dx = X(x0 + 0.35);
        ctx.fillStyle = '#3a2a1e';
        ctx.fillRect(dx - 3, Y(y0 + 2.2) - 3, X(0.95) + 6, X(2.2) + 3);
        ctx.fillStyle = doorCol;
        ctx.fillRect(dx, Y(y0 + 2.2), X(0.95), X(2.2));
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(dx + 4, Y(y0 + 2.0), X(0.95) - 8, 2);
        ctx.fillRect(dx + 4, Y(y0 + 1.1), X(0.95) - 8, 2);
        ctx.fillStyle = '#F4F4F4';
        ctx.fillRect(dx + X(0.2), Y(y0 + 1.7), X(0.5), X(0.15));
        ctx.fillStyle = pick(rand, ['#E8433A', '#FFD400', '#FF7A29']);
        ctx.fillRect(dx - 2, Y(y0 + 2.35), X(0.95) + 4, X(0.1));
        // Window with grille, shutters or curtain.
        const wx = X(x0 + 1.6);
        const ww = X(Math.min(1.2, bw - 1.9));
        if (ww > 8) {
          const wy = Y(y0 + 2.1);
          const wh = X(1.2);
          ctx.fillStyle = '#F2EEE4';
          ctx.fillRect(wx - 4, wy - 4, ww + 8, wh + 8);
          ctx.fillStyle = '#2b3a44';
          ctx.fillRect(wx, wy, ww, wh);
          ctx.fillStyle = 'rgba(180,220,240,0.35)';
          ctx.beginPath();
          ctx.moveTo(wx, wy + wh * 0.6);
          ctx.lineTo(wx + ww * 0.5, wy);
          ctx.lineTo(wx + ww * 0.8, wy);
          ctx.lineTo(wx, wy + wh);
          ctx.fill();
          const style = rand();
          if (style < 0.35) {
            ctx.fillStyle = pick(rand, CLOTH_COLORS);
            ctx.fillRect(wx, wy, ww * 0.45, wh);
          } else if (style < 0.6) {
            ctx.fillStyle = pick(rand, ['#3a8f5a', '#2f6fb0', '#8b5a2b']);
            ctx.fillRect(wx - ww * 0.45, wy, ww * 0.4, wh);
            ctx.fillRect(wx + ww * 1.05, wy, ww * 0.4, wh);
          }
          ctx.fillStyle = 'rgba(30,30,30,0.8)';
          for (let gx = wx + 4; gx < wx + ww; gx += 6) ctx.fillRect(gx, wy, 1.5, wh);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(wx - 8, wy - 10, ww + 16, 6);
        }
      }
      // Baked shadow under each gallery slab.
      if (f > 0) {
        const g = ctx.createLinearGradient(0, Y(y0), 0, Y(y0 - 0.9));
        g.addColorStop(0, 'rgba(30,20,15,0.45)');
        g.addColorStop(1, 'rgba(30,20,15,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, Y(y0), fw, X(0.9));
      }
    }
    // Top floor under the roof slab.
    {
      const y0 = p.storeys * FLOOR_H;
      const g = ctx.createLinearGradient(0, Y(y0), 0, Y(y0 - 0.9));
      g.addColorStop(0, 'rgba(30,20,15,0.45)');
      g.addColorStop(1, 'rgba(30,20,15,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, Y(y0), fw, X(0.9));
    }
    // Cables sagging across the facade.
    ctx.strokeStyle = 'rgba(20,20,20,0.7)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      const yy = Y(2.6 + rand() * 1.5);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.quadraticCurveTo(fw / 2, yy + 10 + rand() * 12, fw, yy + rand() * 6);
      ctx.stroke();
    }
    // Side wall: small windows and maybe a painted ad.
    for (let f = 0; f < p.storeys; f++) {
      for (const u of [0.25, 0.7]) {
        const wx = fw + X(p.depth * u);
        const wy = Y(f * FLOOR_H + 2.1);
        ctx.fillStyle = '#EDE6D6';
        ctx.fillRect(wx - 3, wy - 3, X(0.8) + 6, X(1) + 6);
        ctx.fillStyle = '#2b3a44';
        ctx.fillRect(wx, wy, X(0.8), X(1));
      }
    }
    if (p.sideAd >= 0) {
      const ads: [string, string, string, string][] = [
        ['BHAAGO BHAAGO', 'ENERGY DRINK', '#FFD400', '#E5399B'],
        ['AMBA CEMENT', 'मजबूत घर', '#F4F4F4', '#D7263D'],
        ['JHAKAAS', 'SUITINGS', '#2F80C9', '#FFFFFF'],
      ];
      const [a, b, bg, fg] = ads[p.sideAd % ads.length];
      const ax = fw + X(0.6);
      const aw = X(p.depth - 1.2);
      const ay = Y(Hb - PARAPET - 0.3);
      const ah = X(Math.min(4.5, FLOOR_H * (p.storeys - 1) - 1.5));
      ctx.fillStyle = bg;
      ctx.fillRect(ax, ay, aw, ah);
      label(ctx, a, ax + aw / 2, ay + ah * 0.38, ah * 0.3, aw - 12, fg);
      label(ctx, b, ax + aw / 2, ay + ah * 0.72, ah * 0.2, aw - 12, '#141414', { family: FONT_DEVA, weight: 'bold' });
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(ax, ay, aw, ah);
    }
    // Monsoon stains, mould and peeling paint.
    for (let f = 1; f <= p.storeys; f++) {
      const yy = Y(f * FLOOR_H);
      for (let i = 0; i < w / 5; i++) {
        ctx.fillStyle = `rgba(40,35,25,${0.05 + rand() * 0.12})`;
        ctx.fillRect(rand() * w, yy, 1 + rand() * 4, X(0.4 + rand() * 1.8));
      }
    }
    for (let i = 0; i < 40; i++) {
      const x = rand() * w;
      const y = rand() < 0.5 ? rand() * X(1.2) : rand() * h;
      ctx.fillStyle = `rgba(40,50,30,${0.08 + rand() * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 6 + rand() * 30, 4 + rand() * 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = 'rgba(235,230,220,0.35)';
      ctx.beginPath();
      ctx.ellipse(rand() * w, rand() * h, 4 + rand() * 12, 3 + rand() * 8, rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    streaks(ctx, w, h, rand, 60, 'rgba(40,30,20,0.1)');
    const g = ctx.createLinearGradient(0, h - X(1.2), 0, h);
    g.addColorStop(0, 'rgba(50,40,30,0)');
    g.addColorStop(1, 'rgba(50,40,30,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - X(1.2), w, X(1.2));
  });
}

// ---------------------------------------------------------------------------------
// Materials (lazy, shared)

const matCache = new Map<string, THREE.Material>();
function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key);
  if (!m) {
    m = make();
    m.name = key;
    matCache.set(key, m);
  }
  return m as T;
}

const colorMat = () => vertexColorMaterial();
const detailMat = () => cachedMat('detail', () => flatMaterial({ map: detailTexture(), alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true }));
const corrugatedMat = () => cachedMat('corrugated', () => flatMaterial({ map: corrugatedTexture(), vertexColors: true, side: THREE.DoubleSide }));
const signMat = () => cachedMat('signs', () => flatMaterial({ map: signTexture(), roughness: 0.7, side: THREE.DoubleSide }));
const wallMat = () => cachedMat('walls', () => flatMaterial({ map: wallTexture() }));
const facadeMat = (p: ChawlParams) => cachedMat(`facade-${p.seed}`, () => flatMaterial({ map: facadeTexture(p) }));

const partsCache = new Map<string, Parts>();
function cachedParts(key: string, make: () => Parts): Parts {
  let p = partsCache.get(key);
  if (!p) {
    p = make();
    partsCache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------
// Sky dome and skyline (unlit, not curved)

export const SKY_TOP = '#7EC8F2';
export const SKY_HORIZON = '#FFE1A8';

function skyTexture(): THREE.CanvasTexture {
  return canvasTexture('sky-dome', 1024, 512, (ctx, w, h) => {
    const rand = seededRandom(3);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#5DB2EC');
    g.addColorStop(0.18, SKY_TOP);
    g.addColorStop(0.42, '#B9DDEB');
    g.addColorStop(0.5, SKY_HORIZON);
    g.addColorStop(1, SKY_HORIZON);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Sun glow.
    const sx = w * 0.62;
    const rg = ctx.createRadialGradient(sx, h * 0.4, 4, sx, h * 0.4, 220);
    rg.addColorStop(0, 'rgba(255,243,208,1)');
    rg.addColorStop(0.15, 'rgba(255,243,208,0.8)');
    rg.addColorStop(1, 'rgba(255,243,208,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
    // Puffy cartoon clouds (wrapping horizontally).
    for (let i = 0; i < 16; i++) {
      const cx = rand() * w;
      const cy = h * (0.22 + rand() * 0.24);
      const s = (0.5 + rand() * 0.9) * (0.6 + (cy / h) * 0.9);
      for (const off of [-w, 0, w]) {
        const bx = cx + off;
        if (bx < -140 || bx > w + 140) continue;
        const puffs = 5 + Math.floor(rand() * 4);
        const pts: [number, number, number][] = [];
        for (let k = 0; k < puffs; k++) pts.push([bx + (k - puffs / 2) * 16 * s, cy - Math.sin((k / (puffs - 1)) * Math.PI) * 14 * s, (12 + rand() * 12) * s]);
        ctx.fillStyle = 'rgba(236,222,214,0.95)';
        for (const [x, y, r] of pts) {
          ctx.beginPath();
          ctx.arc(x + 2, y + 4, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        for (const [x, y, r] of pts) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(236,222,214,0.95)';
        ctx.fillRect(pts[0][0], cy, pts[pts.length - 1][0] - pts[0][0], 5 * s);
      }
    }
  });
}

/** Gradient sky sphere, #7EC8F2 at the top to #FFE1A8 at the horizon. Keep it centred on the camera. */
export function buildSkyDome(radius = 380): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const mat = new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skyDome';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

function skylineTexture(): THREE.CanvasTexture {
  return canvasTexture('skyline', 2048, 512, (ctx, w, h) => {
    const rand = seededRandom(19);
    ctx.clearRect(0, 0, w, h);
    const base = h * 0.78;
    const layer = (color: string, count: number, minH: number, maxH: number, minW: number, maxW: number, detail: boolean) => {
      let x = -20;
      for (let i = 0; i < count && x < w; i++) {
        const bw = minW + rand() * (maxW - minW);
        const bh = minH + rand() * (maxH - minH);
        // Leave the sea gap on the left third mostly empty.
        const inSea = x > w * 0.08 && x < w * 0.32;
        const hh = inSea ? bh * 0.25 : bh;
        ctx.fillStyle = color;
        ctx.fillRect(x, base - hh, bw, hh + h);
        const crown = rand();
        if (!inSea && crown < 0.25) {
          ctx.beginPath();
          ctx.moveTo(x, base - hh);
          ctx.lineTo(x + bw / 2, base - hh - bw * 0.4);
          ctx.lineTo(x + bw, base - hh);
          ctx.fill();
        } else if (!inSea && crown < 0.45) {
          ctx.fillRect(x + bw * 0.45, base - hh - 30, 3, 30);
        } else if (!inSea && crown < 0.6) {
          ctx.fillRect(x + bw * 0.15, base - hh - 10, bw * 0.7, 10);
        }
        if (detail && !inSea) {
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          for (let yy = base - hh + 8; yy < base - 6; yy += 9) ctx.fillRect(x + 3, yy, bw - 6, 2);
          ctx.fillStyle = 'rgba(255,240,200,0.25)';
          ctx.fillRect(x, base - hh, 3, hh);
        }
        x += bw + rand() * 10 - 4;
      }
    };
    layer('#C4CFDA', 90, 40, 190, 18, 46, false);
    layer('#A7B7C9', 70, 30, 150, 24, 60, true);
    layer('#90A3B9', 60, 20, 90, 30, 70, true);
    // Sea strip with glints, and a cable-stayed bridge over it.
    const seaTop = base - 8;
    const sg = ctx.createLinearGradient(0, seaTop, 0, h);
    sg.addColorStop(0, '#7FC4D6');
    sg.addColorStop(1, '#A9D8DF');
    ctx.fillStyle = sg;
    ctx.fillRect(w * 0.06, seaTop, w * 0.3, h - seaTop);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 60; i++) ctx.fillRect(w * 0.07 + rand() * w * 0.28, seaTop + 6 + rand() * 40, 6 + rand() * 14, 2);
    ctx.strokeStyle = '#8397AD';
    ctx.fillStyle = '#8397AD';
    ctx.fillRect(w * 0.06, seaTop - 18, w * 0.3, 5);
    for (const px of [w * 0.15, w * 0.26]) {
      ctx.fillRect(px - 4, seaTop - 110, 8, 110);
      ctx.lineWidth = 1.2;
      for (let k = 1; k <= 8; k++) {
        ctx.beginPath();
        ctx.moveTo(px, seaTop - 100 + k * 3);
        ctx.lineTo(px - k * 18, seaTop - 16);
        ctx.moveTo(px, seaTop - 100 + k * 3);
        ctx.lineTo(px + k * 18, seaTop - 16);
        ctx.stroke();
      }
    }
    // Haze fading into the horizon colour at the bottom.
    const hg = ctx.createLinearGradient(0, base - 40, 0, h);
    hg.addColorStop(0, 'rgba(255,225,168,0)');
    hg.addColorStop(0.5, 'rgba(255,225,168,0.6)');
    hg.addColorStop(1, 'rgba(255,225,168,1)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, base - 40, w, h - base + 40);
  });
}

/**
 * Far skyline card: a 150° arc of Mumbai high-rises and the sea, radius ~200 m, centred
 * ahead (-z). Keep it centred on the camera's x/z. Its base sits below the horizon.
 */
export function buildSkyline(radius = 200, height = 64, baseY = -24): THREE.Mesh {
  const arc = (150 * Math.PI) / 180;
  const geo = new THREE.CylinderGeometry(radius, radius, height, 48, 1, true, Math.PI - arc / 2, arc);
  geo.translate(0, baseY + height / 2, 0);
  const mat = new THREE.MeshBasicMaterial({ map: skylineTexture(), transparent: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skyline';
  mesh.renderOrder = -9;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------------
// Builders

function subRect(r: UVRect, u0: number, u1: number, v0 = 0, v1 = 1): UVRect {
  const du = r[2] - r[0];
  const dv = r[3] - r[1];
  return [r[0] + du * u0, r[1] + dv * v0, r[0] + du * u1, r[1] + dv * v1];
}

const HALF_PI = Math.PI / 2;

function chawlParts(seed: number): Parts {
  const p = chawlParams(seed);
  const rand = seededRandom(seed * 977 + 3);
  const b = new PartBuilder();
  const cm = colorMat();
  const dm = detailMat();
  const W = p.width;
  const Dp = p.depth;
  const G = GALLERY;
  const M = END_MARGIN;
  const top = p.storeys * FLOOR_H;
  const Hb = top + PARAPET;
  const fu = W / (W + Dp);
  const zc = -M - W / 2;
  const nb = bays(p);
  const bw = W / nb;
  const bayZ = (i: number) => -M - (i + 0.5) * bw;

  const body = curveBox(Dp, Hb + 0.3, W);
  const front: UVRect = [0, 0, fu, 1];
  const side: UVRect = [fu, 0, 1, 1];
  const plain: UVRect = [fu + 0.01, 0.3, fu + 0.02, 0.31];
  const ranges = boxFaceRanges(body.parameters.widthSegments, body.parameters.heightSegments, body.parameters.depthSegments);
  [front, plain, plain, plain, side, side].forEach((r, i) => remapUV(body, r, ranges[i][0], ranges[i][1]));
  b.add(facadeMat(p), body, tf(-G - Dp / 2, (Hb - 0.3) / 2, zc));
  body.dispose();

  const slabCol = shade(p.color, 0.3);
  const colCol = shade(p.color, -0.12);
  // Ground-floor plinth (otla) and gallery slabs.
  b.box(cm, G, 0.55, W, -G / 2, -0.03, zc, { color: '#9d948a' });
  for (let f = 1; f <= p.storeys; f++) {
    b.box(cm, G + 0.1, 0.2, W + 0.2, -(G + 0.1) / 2, f * FLOOR_H - 0.1, zc, { color: slabCol });
    b.box(cm, 0.03, 0.08, W + 0.2, -0.015, f * FLOOR_H - 0.16, zc, { color: shade(p.color, -0.35) });
  }
  // Roof parapet over the gallery.
  b.box(cm, 0.16, PARAPET, W, -0.08, top + PARAPET / 2, zc, { color: shade(p.color, 0.18) });
  // Columns.
  for (let i = 0; i <= nb; i++) {
    const z = Math.min(-M - 0.14, Math.max(-M - W + 0.14, -M - i * bw));
    b.box(cm, 0.28, Hb + 0.3, 0.28, -0.14, (Hb - 0.3) / 2, z, { color: colCol });
  }
  // Galleries: railings, laundry, plants.
  const rail = seed % 2 === 0 ? DETAIL.railing : DETAIL.railing2;
  for (let f = 1; f < p.storeys; f++) {
    const fy = f * FLOOR_H;
    b.box(cm, 0.1, 0.07, W, -0.06, fy + 1.03, zc, { color: p.grille });
    for (let i = 0; i < nb; i++) {
      const z = bayZ(i);
      b.quad(dm, bw - 0.28, 1.0, -0.06, fy + 0.5, z, HALF_PI, { uv: rail, color: p.grille });
      if (rand() < 0.45) {
        const line = fy + FLOOR_H - 0.45;
        b.box(cm, 0.02, 0.02, bw * 0.9, -0.75, line, z, { color: '#dddddd' });
        const u = rand() * 0.5;
        b.quad(dm, bw * 0.85, 0.95, -0.75, line - 0.45, z, HALF_PI, { uv: subRect(DETAIL.clothes, u, u + 0.5) });
      }
      const r = rand();
      if (r < 0.28) {
        const u = rand() * 0.5;
        b.quad(dm, bw * 0.7, 0.55, -0.02, fy + 0.8, z, HALF_PI, { uv: subRect(DETAIL.clothes2, u, u + 0.5) });
      } else if (r < 0.55) {
        b.quad(dm, Math.min(1.6, bw * 0.7), 0.7, -0.1, fy + 1.4, z, HALF_PI, { uv: DETAIL.plants });
      }
    }
  }
  // Shop signs under the first gallery slab.
  if (p.shops) {
    for (let i = 0; i < nb; i++) {
      if (i % 3 === 1) continue;
      b.quad(signMat(), bw * 0.85, 0.5, -0.03, FLOOR_H - 0.5, bayZ(i), HALF_PI, { uv: SIGN.shops[(i + seed) % 4] });
    }
  }
  // AC units, pipes on the end walls.
  for (const [zFace, dir] of [
    [-M, 1],
    [-M - W, -1],
  ] as const) {
    for (let f = 0; f < p.storeys; f++) {
      for (const u of [0.25, 0.7]) {
        if (rand() < 0.45) continue;
        const x = -G - Dp + u * Dp + 0.4;
        const y = f * FLOOR_H + 0.55;
        b.box(cm, 0.85, 0.55, 0.32, x, y, zFace + dir * 0.17, { color: '#ececec' });
        b.rod(cm, x - 0.12, y, zFace + dir * 0.33, x - 0.12, y, zFace + dir * 0.35, 0.19, 0.19, 10, { color: '#4d4d4d' });
        b.box(cm, 0.05, 0.05, 0.3, x + 0.3, y - 0.3, zFace + dir * 0.15, { color: '#555555' });
      }
    }
    b.rod(cm, -G - 0.2, -0.2, zFace + dir * 0.1, -G - 0.2, Hb, zFace + dir * 0.1, 0.06, 0.06, 6, { color: '#474747' });
  }
  // Roof: stair room, water tanks, tarp, dish, antennas.
  const rx0 = -G - Dp + 0.9;
  const rx1 = -G - 0.9;
  const sx = -G - Dp * 0.6;
  const sz = -M - W * 0.75;
  b.box(cm, 2.4, 2.4, 2.8, sx, Hb + 1.2 - PARAPET, sz, { color: shade(p.color, -0.05) });
  b.box(cm, 2.6, 0.12, 3.0, sx, Hb + 2.46 - PARAPET, sz, { color: slabCol });
  b.box(cm, 0.03, 1.8, 0.9, sx + 1.21, Hb - PARAPET + 0.9, sz, { color: '#3a2a1e' });
  const tanks = 2 + Math.floor(rand() * 3);
  for (let t = 0; t < tanks; t++) {
    const x = rx0 + rand() * (rx1 - rx0);
    const z = -M - 1 - (t / tanks) * W * 0.5 - rand() * 0.6;
    const col = rand() < 0.75 ? '#1d1d1d' : '#2E6FB0';
    b.box(cm, 1.5, 0.45, 1.5, x, Hb + 0.22, z, { color: '#7a7a7a' });
    b.rod(cm, x, Hb + 0.45, z, x, Hb + 1.75, z, 0.66, 0.62, 10, { color: col });
    b.rod(cm, x, Hb + 1.75, z, x, Hb + 1.85, z, 0.25, 0.25, 8, { color: col });
  }
  if (rand() < 0.7) b.box(cm, 3, 0.05, 2.4, -G - Dp * 0.35, Hb + 0.35, -M - W * 0.55, { rz: 0.15, color: '#2E6FC0' });
  const dish = new THREE.SphereGeometry(0.45, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(cm, dish, tf(rx1, Hb + 0.9, -M - W + 1.2, 0.9, 0.6, 0, 1, 0.4, 1), { color: '#f0f0f0' });
  dish.dispose();
  b.rod(cm, rx1, Hb, -M - W + 1.2, rx1, Hb + 0.8, -M - W + 1.2, 0.04, 0.04, 5, { color: '#777' });
  for (let a = 0; a < 2; a++) {
    const x = rx0 + rand() * (rx1 - rx0);
    const z = -M - W * (0.3 + rand() * 0.6);
    b.rod(cm, x, Hb, z, x, Hb + 2.8, z, 0.03, 0.03, 4, { color: '#555' });
    b.box(cm, 0.03, 0.03, 1.2, x, Hb + 2.5, z, { color: '#555' });
    b.box(cm, 0.03, 0.03, 0.8, x, Hb + 2.2, z, { color: '#555' });
  }
  return b.merged();
}

/** A 3–6 storey Mumbai chawl. Front (galleries) at x = 0 facing +x, spans z 0 → -length. */
export function buildChawl(seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`chawl:${seed}`, () => chawlParts(seed)), `chawl-${seed}`);
}

function wallRows(seed: number): [number, number] {
  if (seed >= 0 && seed < WALL_VARIANTS) return [seed * 2, seed * 2 + 1];
  const r = seededRandom(seed * 131 + 1);
  return [Math.floor(r() * WALL_ROWS), Math.floor(r() * WALL_ROWS)];
}

function wallParts(length: number, seed: number): Parts {
  const b = new PartBuilder();
  const cm = colorMat();
  const panels = Math.max(1, Math.round(length / 4));
  const pl = length / panels;
  const rows = wallRows(seed);
  b.box(cm, 0.25, 2.8, length, -0.245, 1.1, -length / 2, { color: '#a39a8b' });
  for (let i = 0; i < panels; i++) {
    b.quad(wallMat(), pl, 2.5, -0.115, 1.25, -(i + 0.5) * pl, HALF_PI, { uv: wallCell(rows[Math.floor(i / 4) % 2], i % 4) });
  }
  for (let i = 0; i <= panels; i++) {
    const z = Math.min(-0.2, Math.max(-length + 0.2, -i * pl));
    b.box(cm, 0.4, 2.95, 0.4, -0.2, 1.17, z, { color: '#aaa192' });
    b.box(cm, 0.46, 0.1, 0.46, -0.2, 2.7, z, { color: '#8f8778' });
  }
  b.box(cm, 0.5, 0.12, length, -0.22, 2.56, -length / 2, { color: '#9c9384' });
  if (seed % 2 === 0) {
    for (let i = 0; i <= panels; i++) {
      const z = Math.min(-0.2, Math.max(-length + 0.2, -i * pl));
      b.beam(cm, -0.2, 2.6, z, -0.6, 3.05, z, 0.04, { color: '#555' });
    }
    for (const [x, y] of [
      [-0.3, 2.72],
      [-0.45, 2.88],
      [-0.58, 3.03],
    ]) {
      b.box(cm, 0.015, 0.015, length, x, y, -length / 2, { color: '#6a6a6a' });
    }
  }
  return b.merged();
}

/** Concrete boundary wall, ~2.5 m, with graffiti and painted ads. Front at x = 0 facing +x. */
export function buildWall(length = 32, seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`wall:${length}:${seed}`, () => wallParts(length, seed)), `wall-${seed}`);
}

function fenceParts(length: number): Parts {
  const b = new PartBuilder();
  const cm = colorMat();
  const panels = Math.max(1, Math.round(length / 3));
  const pl = length / panels;
  b.box(cm, 0.24, 0.5, length, -0.12, 0.0, -length / 2, { color: '#9f968a' });
  for (let i = 0; i <= panels; i++) {
    const z = Math.min(-0.08, Math.max(-length + 0.08, -i * pl));
    b.box(cm, 0.14, 2.5, 0.14, -0.1, 1.2, z, { color: '#b3aa9b' });
  }
  for (let i = 0; i < panels; i++) b.quad(detailMat(), pl, 2.2, -0.1, 1.35, -(i + 0.5) * pl, HALF_PI, { uv: DETAIL.fence, color: '#9aa3a8' });
  return b.merged();
}

/** Chain-link fence on a concrete plinth with barbed wire. Front at x = 0 facing +x. */
export function buildFence(length = 30): THREE.Group {
  return groupFromParts(cachedParts(`fence:${length}`, () => fenceParts(length)), 'fence');
}

export const PLATFORM_LENGTH = 64;
export const PLATFORM_DEPTH = 6.2;
export const PLATFORM_HEIGHT = 1.0;

function platformParts(L: number, seed: number): Parts {
  const b = new PartBuilder();
  const cm = colorMat();
  const dm = detailMat();
  const sm = signMat();
  const rand = seededRandom(L * 7 + seed);
  const zc = -L / 2;
  const Dp = PLATFORM_DEPTH;
  const station = SIGN.station[seed % SIGN.station.length];
  // Body, coping, tactile strip, paving band.
  b.box(cm, Dp - 0.25, 1.4, L, -(0.25 + (Dp - 0.25) / 2), 0.3, zc, { color: '#b7ad9d' });
  b.box(cm, 0.9, 0.12, L, -0.45, 0.94, zc, { color: '#dcd6ca' });
  b.box(cm, 0.05, 0.9, L, -0.27, 0.35, zc, { color: '#4b463f' });
  b.box(cm, 0.45, 0.02, L, -1.1, 1.01, zc, { color: '#FFD400' });
  b.box(cm, 0.06, 0.02, L, -0.72, 1.01, zc, { color: '#f4f4f4' });
  b.box(cm, 2.2, 0.01, L, -2.7, 1.005, zc, { color: '#c9c0ae' });
  // Columns, cantilever beams, braces and tube lights.
  const steel = '#2f6f7e';
  for (let z = -4; z > -L; z -= 8) {
    b.box(cm, 0.26, 4.0, 0.26, -3.4, 3.0, z, { color: steel });
    b.box(cm, 0.5, 0.08, 0.5, -3.4, 1.04, z, { color: '#555' });
    b.box(cm, 0.28, 0.3, 0.28, -3.4, 1.8, z, { color: '#f0ece0' });
    b.beam(cm, -6.3, 4.85, z, -0.3, 5.35, z, 0.22, { color: '#2a5f6c', tz: 0.18 });
    b.beam(cm, -3.4, 4.1, z, -1.6, 5.19, z, 0.1, { color: steel });
    b.beam(cm, -3.4, 4.1, z, -5.2, 4.98, z, 0.1, { color: steel });
    b.box(cm, 0.1, 0.06, 1.2, -1.8, 5.05, z - 1, { color: '#fffbe8' });
  }
  // Corrugated canopy sloping up toward the track.
  const roof = curveBox(6.1, 0.05, L + 0.6);
  scaleUV(roof, 3, (L + 0.6) / 0.8);
  b.add(corrugatedMat(), roof, tf(-3.3, 5.2, zc, 0, 0, Math.atan2(0.5, 6)), { color: '#9fb0bf' });
  roof.dispose();
  b.box(cm, 0.06, 0.4, L + 0.6, -0.28, 5.28, zc, { color: '#f0ece0' });
  b.box(cm, 0.07, 0.1, L + 0.6, -0.27, 5.3, zc, { color: '#2F80C9' });
  // Hanging boards facing the runner (+z): station name and train indicator.
  const hang = (z: number, y: number, w: number, h: number, uv: UVRect, frame: string) => {
    b.box(cm, w + 0.12, h + 0.12, 0.08, -3.2, y, z, { color: frame });
    b.quad(sm, w, h, -3.2, y, z + 0.045, 0, { uv });
    b.quad(sm, w, h, -3.2, y, z - 0.045, Math.PI, { uv });
    b.box(cm, 0.03, 5.1 - y - h / 2, 0.03, -3.2 - w * 0.35, (5.1 + y + h / 2) / 2, z, { color: '#333' });
    b.box(cm, 0.03, 5.1 - y - h / 2, 0.03, -3.2 + w * 0.35, (5.1 + y + h / 2) / 2, z, { color: '#333' });
  };
  hang(-2.2, 4.0, 2.8, 0.7, station, '#141414');
  hang(-L * 0.5 + 2, 4.1, 2.8, 0.53, SIGN.indicator, '#222222');
  // Name boards facing the track.
  for (const f of [0.3, 0.78]) {
    const z = -L * f;
    for (const dz of [-1.5, 1.5]) b.rod(cm, -2.05, 1.0, z + dz, -2.05, 3.35, z + dz, 0.05, 0.05, 6, { color: '#333' });
    b.box(cm, 0.08, 0.95, 3.4, -2.05, 2.85, z, { color: '#141414' });
    b.quad(sm, 3.3, 0.83, -2.005, 2.85, z, HALF_PI, { uv: station });
    b.quad(sm, 3.3, 0.83, -2.095, 2.85, z, -HALF_PI, { uv: station });
  }
  // Benches.
  for (let z = -8; z > -L + 2; z -= 10) {
    b.box(cm, 0.5, 0.06, 1.8, -4.9, 1.45, z, { color: '#2F80C9' });
    b.box(cm, 0.06, 0.45, 1.8, -5.15, 1.75, z, { color: '#2F80C9' });
    for (const dz of [-0.8, 0.8]) b.box(cm, 0.4, 0.45, 0.06, -4.95, 1.22, z + dz, { color: '#555' });
  }
  // Chai stall.
  const zS = -(Math.floor((L * 0.35) / 10) * 10 + 3);
  b.box(cm, 1.6, 2.3, 2.6, -5.3, 2.15, zS, { color: '#B8322B' });
  b.box(cm, 0.03, 0.95, 2.2, -4.49, 2.6, zS, { color: '#3a2418' });
  b.box(cm, 0.03, 0.15, 2.6, -4.49, 1.5, zS, { color: '#FFD400' });
  b.box(cm, 0.55, 0.08, 2.7, -4.3, 2.05, zS, { color: '#8b5a2b' });
  b.box(cm, 0.06, 0.86, 2.66, -4.52, 3.68, zS, { color: '#141414' });
  b.quad(sm, 2.6, 0.8, -4.48, 3.68, zS, HALF_PI, { uv: SIGN.chai });
  const stallRoof = new THREE.BoxGeometry(2.2, 0.06, 3.1);
  scaleUV(stallRoof, 1, 4);
  b.add(corrugatedMat(), stallRoof, tf(-5.1, 4.2, zS, 0, 0, 0.1), { color: '#c0392b' });
  stallRoof.dispose();
  b.rod(cm, -4.35, 2.09, zS - 0.7, -4.35, 2.4, zS - 0.7, 0.12, 0.1, 8, { color: '#c0c6c9' });
  b.rod(cm, -4.35, 2.09, zS - 0.2, -4.35, 2.3, zS - 0.2, 0.16, 0.16, 8, { color: '#a0764a' });
  for (let i = 0; i < 4; i++) b.rod(cm, -4.2, 2.09, zS + 0.3 + i * 0.12, -4.2, 2.19, zS + 0.3 + i * 0.12, 0.035, 0.04, 6, { color: '#c98a2b' });
  b.rod(cm, -5.6, 1.0, zS + 1.65, -5.6, 1.6, zS + 1.65, 0.15, 0.15, 8, { color: '#D7263D' });
  b.box(cm, 0.35, 0.45, 0.35, -3.9, 1.22, zS + 0.9, { color: '#6b4a2e' });
  // Commuters.
  const people = Math.floor(L / 4.5);
  for (let i = 0; i < people; i++) {
    const z = -2 - rand() * (L - 4);
    if (Math.abs(z - zS) < 2.2) continue;
    const x = -1.6 - rand() * 1.1;
    b.quad(dm, 0.9, 1.8, x, 1.0 + 0.9, z, HALF_PI - 0.45 - rand() * 0.4, { uv: DETAIL.people[i % 8] });
  }
  // Back railing and dustbins.
  for (let z = 0; z > -L; z -= 2) b.box(cm, 0.06, 1.1, 0.06, -6.1, 1.55, z - 0.03, { color: '#3a6f5e' });
  b.box(cm, 0.05, 0.05, L, -6.1, 2.05, zc, { color: '#3a6f5e' });
  b.box(cm, 0.05, 0.05, L, -6.1, 1.6, zc, { color: '#3a6f5e' });
  for (let z = -12; z > -L; z -= 16) b.rod(cm, -5.8, 1.0, z, -5.8, 1.8, z, 0.22, 0.2, 8, { color: '#2e7d32' });
  return b.merged();
}

/** Station platform (1 m high) with canopy, name boards, benches, chai stall and commuters. Edge at x = 0. */
export function buildPlatform(length = PLATFORM_LENGTH, seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`platform:${length}:${seed}`, () => platformParts(length, seed)), 'platform');
}

export const FOB_DECK_Y = 7.0;
export const FOB_HALF_SPAN = 12.4;
export const FOB_LENGTH = 17;

function fobParts(seed: number): Parts {
  const b = new PartBuilder();
  const cm = colorMat();
  const Y0 = FOB_DECK_Y;
  const DECK = 0.35;
  const zN = -0.5;
  const zF = -4.1;
  const zc = (zN + zF) / 2;
  const dw = zN - zF;
  const span = FOB_HALF_SPAN;
  const steel = '#4F7F6A';
  const steelD = '#3d6353';
  b.box(cm, 2 * span, DECK, dw + 0.2, 0, Y0 + DECK / 2, zc, { color: '#9a9388' });
  b.box(cm, 2 * span, 0.08, dw + 0.3, 0, Y0 + 0.04, zc, { color: '#6f685e' });
  for (const fz of [zN, zF]) {
    b.box(cm, 2 * span, 0.2, 0.2, 0, Y0 + 0.45, fz, { color: steel });
    b.box(cm, 2 * span, 0.2, 0.2, 0, Y0 + 2.5, fz, { color: steel });
    for (let x = -span; x <= span + 0.01; x += 2) {
      b.box(cm, 0.14, 2.05, 0.14, x, Y0 + 1.47, fz, { color: steelD });
      if (x < span - 0.01) {
        const x1 = x + 2;
        if (x1 <= 0) b.beam(cm, x, Y0 + 0.45, fz, x1, Y0 + 2.5, fz, 0.1, { color: steel });
        else b.beam(cm, x, Y0 + 2.5, fz, x1, Y0 + 0.45, fz, 0.1, { color: steel });
        b.quad(detailMat(), 2, 1.1, x + 1, Y0 + 1.1, fz + (fz === zN ? 0.02 : -0.02), 0, { uv: DETAIL.mesh, color: '#8fa89b' });
      }
    }
  }
  for (let x = -span; x <= span + 0.01; x += 4) b.box(cm, 0.1, 0.1, dw, x, Y0 + 2.5, zc, { color: steelD });
  // Gable roof (corrugations run down the slope).
  for (const dir of [1, -1]) {
    const g = curveBox(2.35, 0.05, 2 * span + 0.6);
    scaleUV(g, 1, (2 * span) / 0.8);
    g.rotateY(HALF_PI);
    const roof = new THREE.BufferGeometry().copy(g);
    b.add(corrugatedMat(), roof, tf(0, Y0 + 2.88, zc + dir * 1.05, dir * 0.33, 0, 0), { color: '#b9c3c9' });
    g.dispose();
    roof.dispose();
  }
  // Boards on the near face (seen by the runner) and a safety banner on the far face.
  b.box(cm, 5.2, 1.3, 0.1, 0, Y0 + 1.5, zN + 0.14, { color: '#141414' });
  b.quad(signMat(), 5.0, 1.2, 0, Y0 + 1.5, zN + 0.2, 0, { uv: SIGN.station[seed % SIGN.station.length] });
  for (const [x, ad] of [
    [-7.6, 1],
    [7.6, 3],
  ] as const) {
    b.box(cm, 3.7, 1.45, 0.08, x, Y0 + 1.47, zN + 0.12, { color: '#e8e8e8' });
    b.quad(signMat(), 3.6, 1.35, x, Y0 + 1.47, zN + 0.17, 0, { uv: SIGN.ads[ad] });
  }
  b.quad(signMat(), 3.2, 1.0, 0, Y0 + 1.5, zF - 0.15, Math.PI, { uv: SIGN.fob });
  // Columns.
  for (const x of [-5.2, 5.2, -span + 0.4, span - 0.4]) {
    for (const z of [zN - 0.2, zF + 0.2]) {
      b.box(cm, 0.4, Y0 + 0.3, 0.4, x, (Y0 - 0.3) / 2, z, { color: Math.abs(x) > 6 ? steel : '#8e877c' });
      b.box(cm, 0.8, 0.4, 0.8, x, -0.1, z, { color: '#a39a8b' });
    }
    b.beam(cm, x, 0.8, zN - 0.2, x, Y0 - 0.3, zF + 0.2, 0.1, { color: steelD });
    b.beam(cm, x, 0.8, zF + 0.2, x, Y0 - 0.3, zN - 0.2, 0.1, { color: steelD });
    b.box(cm, 0.6, 0.2, dw + 0.4, x, Y0 - 0.1, zc, { color: '#6f685e' });
  }
  // Stairs down to the ground on both sides, running along the track.
  const H = Y0 + DECK;
  const run = 12.5;
  const steps = 24;
  const a = Math.atan2(H, run);
  for (const sx of [-1, 1]) {
    const xc = sx * 11.4;
    for (let i = 0; i < steps; i++) {
      const top = H - (i + 1) * (H / steps);
      b.box(cm, 1.6, 0.3, run / steps + 0.02, xc, top - 0.15, zF - (i + 0.5) * (run / steps), { color: i % 2 ? '#a39a8b' : '#978e80' });
    }
    for (const ox of [-0.84, 0.84]) {
      b.beam(cm, xc + ox, H, zF, xc + ox, 0, zF - run, 0.1, { color: steel, tz: 0.45 });
      b.beam(cm, xc + ox, H + 1.0, zF, xc + ox, 1.0, zF - run, 0.06, { color: steelD });
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        b.box(cm, 0.04, 1.0, 0.04, xc + ox, H * (1 - t) + 0.5, zF - run * t, { color: steelD });
      }
    }
    const len = Math.hypot(H, run) + 0.6;
    const g = curveBox(len, 0.05, 2.0);
    scaleUV(g, 1, 2.5);
    const roof = new THREE.BufferGeometry().copy(g);
    b.add(corrugatedMat(), roof, tf(xc, H / 2 + 2.7, zF - run / 2, -a, HALF_PI, 0), { color: '#b9c3c9' });
    g.dispose();
    roof.dispose();
    for (const t of [0.15, 0.5, 0.85]) {
      for (const ox of [-0.9, 0.9]) {
        const y = H * (1 - t);
        b.box(cm, 0.08, 2.6, 0.08, xc + ox, y + 1.3, zF - run * t, { color: steel });
      }
    }
    b.box(cm, 1.8, 0.5, 1.5, xc, -0.1, zF - run - 0.6, { color: '#a39a8b' });
  }
  return b.merged();
}

/** Steel truss foot overbridge spanning x -12..12, deck underside at 7 m, stairs at both ends (z 0 → -17). */
export function buildFootOverbridge(seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`fob:${seed}`, () => fobParts(seed)), 'fob');
}

const BB_LEN = 8;
const BB_H = 3;
const BB_Y = 4.6;

function billboardFrameParts(): Parts {
  const b = new PartBuilder();
  const cm = colorMat();
  const steel = '#6d7479';
  const H = BB_Y + BB_H + 0.5;
  for (const z of [-2.4, 2.4]) {
    b.box(cm, 0.35, H, 0.25, -0.9, H / 2 - 0.3, z, { color: steel });
    b.box(cm, 0.9, 0.5, 0.9, -0.9, -0.05, z, { color: '#a39a8b' });
    b.beam(cm, -0.9, BB_Y - 1.2, z, -0.35, BB_Y + 0.1, z, 0.08, { color: steel });
    b.beam(cm, -0.9, BB_Y - 1.0, z, 0.72, BB_Y - 0.23, z, 0.07, { color: steel });
  }
  for (const y of [BB_Y + 0.1, BB_Y + 1.5, BB_Y + 2.9]) b.box(cm, 0.08, 0.08, BB_LEN, -0.35, y, 0, { color: steel });
  for (let z = -4; z <= 4; z += 1) {
    b.box(cm, 0.06, 2.9, 0.06, -0.35, BB_Y + 1.5, z, { color: steel });
    if (z < 4) b.beam(cm, -0.35, BB_Y + 0.1, z, -0.35, BB_Y + 2.9, z + 1, 0.05, { color: steel });
  }
  b.box(cm, 0.1, BB_H + 0.24, BB_LEN + 0.24, -0.08, BB_Y + BB_H / 2, 0, { color: '#ececec' });
  // Catwalk with rail.
  b.box(cm, 0.8, 0.06, BB_LEN, 0.35, BB_Y - 0.2, 0, { color: '#5d6468' });
  b.box(cm, 0.04, 0.04, BB_LEN, 0.72, BB_Y + 0.6, 0, { color: '#5d6468' });
  for (let z = -4; z <= 4; z += 2) b.box(cm, 0.04, 0.8, 0.04, 0.72, BB_Y + 0.2, z, { color: '#5d6468' });
  // Lamps.
  for (const z of [-2.7, 0, 2.7]) {
    b.beam(cm, -0.05, BB_Y + BB_H + 0.1, z, 1.0, BB_Y + BB_H + 0.55, z, 0.05, { color: '#444' });
    b.box(cm, 0.35, 0.15, 0.25, 1.05, BB_Y + BB_H + 0.5, z, { color: '#333' });
  }
  return b.merged();
}

function billboardAdParts(v: number): Parts {
  const b = new PartBuilder();
  b.quad(signMat(), BB_LEN, BB_H, -0.02, BB_Y + BB_H / 2, 0, HALF_PI, { uv: SIGN.ads[((v % AD_VARIANTS) + AD_VARIANTS) % AD_VARIANTS] });
  return b.merged();
}

/** Billboard on a steel frame (centred on the origin, board faces +x, 8 m x 3 m at 4.6–7.6 m). */
export function buildBillboard(seed = 0): THREE.Group {
  const g = groupFromParts(cachedParts('billboardFrame', billboardFrameParts), 'billboard');
  for (const m of groupFromParts(cachedParts(`ad:${seed % AD_VARIANTS}`, () => billboardAdParts(seed)), 'ad').children.slice()) g.add(m);
  return g;
}

// ---------------------------------------------------------------------------------
// Trees and parked autos (centred on the origin)

export const TREE_KINDS = ['palm', 'banyan', 'gulmohar', 'palm'] as const;
export const TREE_VARIANTS = TREE_KINDS.length;
/** Canopy reach from the trunk toward +x (the track side), in metres. */
export const TREE_REACH = [2.9, 3.7, 3.9, 2.9] as const;

function frond(b: PartBuilder, m: THREE.Material, ox: number, oy: number, oz: number, ang: number, len: number, lift: number, color: string): void {
  const dx = Math.cos(ang);
  const dz = Math.sin(ang);
  const px = -dz;
  const pz = dx;
  const K = 5;
  const spine: THREE.Vector3[] = [];
  for (let k = 0; k <= K; k++) {
    const s = k / K;
    spine.push(new THREE.Vector3(ox + dx * len * s, oy + lift * s * 1.6 - (lift + 1.6) * s * s, oz + dz * len * s));
  }
  const front: number[] = [];
  for (let k = 0; k < K; k++) {
    for (const side of [-1, 1]) {
      const s0 = k / K;
      const s1 = (k + 1) / K;
      const w0 = 0.55 * Math.sin(Math.PI * s0) + 0.04;
      const w1 = 0.55 * Math.sin(Math.PI * s1) + 0.04;
      const a = spine[k];
      const c = spine[k + 1];
      const e0 = [a.x + px * w0 * side, a.y - 0.3 * w0, a.z + pz * w0 * side];
      const e1 = [c.x + px * w1 * side + dx * 0.15, c.y - 0.3 * w1, c.z + pz * w1 * side + dz * 0.15];
      front.push(a.x, a.y, a.z, c.x, c.y, c.z, e1[0], e1[1], e1[2]);
      front.push(a.x, a.y, a.z, e1[0], e1[1], e1[2], e0[0], e0[1], e0[2]);
    }
  }
  const back: number[] = [];
  for (let i = 0; i < front.length; i += 9) back.push(front[i], front[i + 1], front[i + 2], front[i + 6], front[i + 7], front[i + 8], front[i + 3], front[i + 4], front[i + 5]);
  for (const arr of [front, back]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    b.add(m, g, undefined, { color, flat: true });
    g.dispose();
  }
}

function blob(b: PartBuilder, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, ry = 0): void {
  const g = new THREE.IcosahedronGeometry(1, 1);
  b.add(m, g, tf(x, y, z, 0, ry, 0, sx, sy, sz), { color, flat: true });
  g.dispose();
}

function treeParts(seed: number): Parts {
  const kind = TREE_KINDS[((seed % TREE_VARIANTS) + TREE_VARIANTS) % TREE_VARIANTS];
  const rand = seededRandom(seed * 53 + 11);
  const b = new PartBuilder();
  const cm = colorMat();
  if (kind === 'palm') {
    const H = 7 + rand() * 1.8 + (seed % 4 === 3 ? 1.5 : 0);
    const bend = 0.8 + rand() * 0.8;
    const bz = (rand() - 0.5) * 0.6;
    let prev = new THREE.Vector3(0, -0.2, 0);
    const N = 7;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const p = new THREE.Vector3(-bend * t * t, H * t, bz * t * t);
      b.rod(cm, prev.x, prev.y, prev.z, p.x, p.y, p.z, 0.22 - 0.08 * (t - 1 / N), 0.22 - 0.08 * t, 7, { color: i % 2 ? '#8a6f55' : '#7a5f47', flat: true });
      prev = p;
    }
    const top = prev;
    const fronds = 11;
    for (let j = 0; j < fronds; j++) {
      const ang = (j / fronds) * Math.PI * 2 + rand() * 0.3;
      frond(b, cm, top.x, top.y, top.z, ang, 2.2 + rand() * 0.6, 0.4 + rand() * 0.6, j % 2 ? '#3f8f3a' : '#5aad45');
    }
    for (let j = 0; j < 4; j++) {
      const g = new THREE.IcosahedronGeometry(0.17, 0);
      const a = (j / 4) * Math.PI * 2;
      b.add(cm, g, tf(top.x + Math.cos(a) * 0.25, top.y - 0.3, top.z + Math.sin(a) * 0.25), { color: '#6b7a2e', flat: true });
      g.dispose();
    }
    blob(b, cm, 0, -0.1, 0, 0.5, 0.25, 0.5, '#6b5a40');
  } else if (kind === 'banyan') {
    b.rod(cm, 0, -0.2, 0, 0, 3.4, 0, 0.75, 0.5, 8, { color: '#6d5846', flat: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rand();
      b.rod(cm, Math.cos(a) * 1.1, -0.1, Math.sin(a) * 1.1, Math.cos(a) * 0.3, 1.4, Math.sin(a) * 0.3, 0.2, 0.1, 5, { color: '#5e4a3a', flat: true });
      b.rod(cm, 0, 2.8, 0, Math.cos(a) * 2.2, 4.3 + rand() * 0.6, Math.sin(a) * 2.2, 0.28, 0.12, 5, { color: '#6d5846', flat: true });
    }
    const greens = ['#3d7a34', '#4f8f3f', '#2f6a2c', '#62a04a'];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.4;
      const r = i === 0 ? 0 : 1.2 + rand() * 0.9;
      blob(b, cm, Math.cos(a) * r, 5.0 + rand() * 1.0 + (i === 0 ? 0.8 : 0), Math.sin(a) * r, 1.6 + rand() * 0.4, 1.1 + rand() * 0.3, 1.6 + rand() * 0.4, greens[i % 4], rand() * 3);
    }
    for (let i = 0; i < 8; i++) {
      const a = rand() * Math.PI * 2;
      const r = 1.0 + rand() * 1.8;
      b.rod(cm, Math.cos(a) * r, 4.3, Math.sin(a) * r, Math.cos(a) * r, 0.5 + rand() * 2.2, Math.sin(a) * r, 0.04, 0.03, 4, { color: '#6b5040' });
    }
  } else {
    const lean = (rand() - 0.5) * 0.4;
    b.rod(cm, 0, -0.2, 0, lean, 2.7, 0, 0.36, 0.24, 7, { color: '#5b4b3e', flat: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rand();
      b.rod(cm, lean, 2.5, 0, Math.cos(a) * 2.3, 3.9 + rand() * 0.4, Math.sin(a) * 2.3, 0.16, 0.07, 5, { color: '#5b4b3e', flat: true });
    }
    const reds = ['#F0301A', '#FF5A14', '#E0201C', '#FF7A1F', '#F0301A', '#4f9a34', '#FF5A14', '#5fa83e', '#E0201C', '#FF7A1F', '#4f9a34'];
    for (let i = 0; i < reds.length; i++) {
      const a = (i / reds.length) * Math.PI * 2 + rand() * 0.5;
      const r = i === 0 ? 0 : 1.0 + rand() * 1.4;
      blob(b, cm, Math.cos(a) * r, 4.2 + rand() * 0.7, Math.sin(a) * r, 1.4 + rand() * 0.3, 0.65 + rand() * 0.2, 1.4 + rand() * 0.3, reds[i], rand() * 3);
    }
  }
  return b.merged();
}

/** Low-poly roadside tree: palm, banyan or gulmohar by seed (trunk at the origin). */
export function buildTree(seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`tree:${seed}`, () => treeParts(seed)), `tree-${seed}`);
}

export const AUTO_VARIANTS = 2;

function oneAuto(b: PartBuilder, z0: number): void {
  const cm = colorMat();
  const black = '#1a1a1a';
  const yellow = '#FFD400';
  b.box(cm, 1.3, 0.45, 2.1, 0, 0.55, z0 - 0.1, { color: black });
  b.box(cm, 0.7, 1.1, 0.5, 0, 0.9, z0 + 1.0, { color: black });
  b.box(cm, 0.45, 0.14, 0.55, 0, 0.47, z0 + 1.05, { color: black });
  b.rod(cm, 0, 1.18, z0 + 1.24, 0, 1.18, z0 + 1.3, 0.09, 0.09, 8, { color: '#fff7c2' });
  b.box(cm, 1.1, 0.6, 0.04, 0, 1.35, z0 + 0.72, { rx: -0.15, color: '#9fd3e6' });
  b.box(cm, 1.36, 0.08, 1.9, 0, 1.72, z0 - 0.25, { color: yellow });
  for (const sx of [-1, 1]) {
    b.box(cm, 0.04, 0.5, 1.5, sx * 0.66, 1.45, z0 - 0.45, { color: yellow });
    b.rod(cm, sx * 0.6, 0.8, z0 + 0.72, sx * 0.6, 1.7, z0 + 0.72, 0.025, 0.025, 4, { color: black });
    b.rod(cm, sx * 0.72, 0.23, z0 - 0.75, sx * 0.57, 0.23, z0 - 0.75, 0.23, 0.23, 10, { color: '#111' });
    b.rod(cm, sx * 0.74, 0.23, z0 - 0.75, sx * 0.72, 0.23, z0 - 0.75, 0.1, 0.1, 8, { color: '#bbb' });
  }
  b.rod(cm, 0.08, 0.23, z0 + 1.0, -0.08, 0.23, z0 + 1.0, 0.23, 0.23, 10, { color: '#111' });
  b.box(cm, 1.34, 0.75, 0.06, 0, 1.3, z0 - 1.18, { color: yellow });
  b.box(cm, 1.34, 0.5, 0.06, 0, 0.62, z0 - 1.18, { color: black });
  b.box(cm, 0.4, 0.14, 0.02, 0, 0.62, z0 - 1.22, { color: '#f4f4f4' });
  b.box(cm, 1.1, 0.25, 0.6, 0, 0.95, z0 - 0.7, { color: '#3b2a20' });
  b.box(cm, 1.1, 0.5, 0.12, 0, 1.2, z0 - 0.98, { color: '#3b2a20' });
}

function autoParts(seed: number): Parts {
  const b = new PartBuilder();
  if (seed % AUTO_VARIANTS === 0) oneAuto(b, 0);
  else {
    oneAuto(b, 1.5);
    oneAuto(b, -1.5);
  }
  return b.merged();
}

/** Parked black-and-yellow auto-rickshaw (variant 1: two in a row), centred, facing +z. */
export function buildParkedAuto(seed = 0): THREE.Group {
  return groupFromParts(cachedParts(`auto:${seed % AUTO_VARIANTS}`, () => autoParts(seed)), 'parkedAuto');
}

// ---------------------------------------------------------------------------------
// Corridor layout (pure; unit-tested)

export type PieceKind = 'wall' | 'fence' | 'platform' | 'fob' | 'chawl' | 'billboard' | 'tree' | 'auto';
export type PieceLayer = 'near' | 'mid' | 'back' | 'span';

export interface Placement {
  index: number;
  kind: PieceKind;
  variant: number;
  side: -1 | 0 | 1;
  layer: PieceLayer;
  /** Extent along the track (metres, within one period). */
  s0: number;
  s1: number;
  /** Track position of the object's local origin. */
  anchorS: number;
  x: number;
  y: number;
  rotY: number;
  scale: number;
  /** Closest approach to the track centreline. */
  minAbsX: number;
  /** Instanced-set keys this piece draws with. */
  keys: string[];
}

export interface CorridorPlan {
  period: number;
  placements: Placement[];
  stations: [number, number][];
  fobs: number[];
  maxExtent: number;
}

export const CORRIDOR_PERIOD = 2400;
export const WALL_LENGTH = 32;
export const FENCE_LENGTH = 30;
export const NEAR_X = 4.5;
export const PLATFORM_X = 4.2;
export const MID_X = 13;
export const BACK_X = 25;
export const MIN_SCENERY_X = 4.2;
/** FOB near end, metres after a mast (the deck spans 0.3–4.3 m of that). */
export const FOB_MAST_OFFSET = 8;
const BILLBOARD_X = 8.4;
const BILLBOARD_YAW = 0.45;
const BILLBOARD_REACH = 2.7;
const BILLBOARD_RADIUS = 4.3;
const TREE_RADIUS = 4.5;

function frontPiece(kind: PieceKind, variant: number, side: -1 | 1, s: number, length: number, xFront: number, y: number, layer: PieceLayer, keys: string[], scale = 1): Placement {
  return { index: 0, kind, variant, side, layer, s0: s, s1: s + length, anchorS: side > 0 ? s + length : s, x: side * xFront, y, rotY: side > 0 ? Math.PI : 0, scale, minAbsX: xFront, keys };
}

function centred(kind: PieceKind, variant: number, side: -1 | 1, s: number, radius: number, absX: number, y: number, rotY: number, reach: number, layer: PieceLayer, keys: string[]): Placement {
  return { index: 0, kind, variant, side, layer, s0: s - radius, s1: s + radius, anchorS: s, x: side * absX, y, rotY, scale: 1, minAbsX: absX - reach, keys };
}

const overlaps = (a0: number, a1: number, zones: readonly (readonly [number, number])[]) => zones.some(([z0, z1]) => a0 < z1 && a1 > z0);

/** Deterministic, varied corridor dressing for one period of track (both sides). */
export function planCorridor(seed = 1, period = CORRIDOR_PERIOD): CorridorPlan {
  const rand = seededRandom(seed * 7 + 101);
  const out: Placement[] = [];
  const stations: [number, number][] = [];
  for (let s = 70 + rand() * 40; s + PLATFORM_LENGTH < period - 60; s += PLATFORM_LENGTH + 330 + rand() * 200) stations.push([s, s + PLATFORM_LENGTH]);

  const fobs: number[] = [];
  const fobVariant: number[] = [];
  // Foot overbridges sit mid-span between OHE portals so the girders never clash.
  const midSpan = (s: number) => Math.floor(s / MAST_SPACING) * MAST_SPACING + FOB_MAST_OFFSET;
  stations.forEach(([a, b], i) => {
    fobs.push(midSpan(a + 22));
    fobVariant.push(i % SIGN.station.length);
    const next = i + 1 < stations.length ? stations[i + 1][0] : period;
    const f = midSpan((b + next) / 2 - FOB_LENGTH / 2);
    if (rand() < 0.6 && f + FOB_LENGTH < next - 10 && f + FOB_LENGTH < period) {
      fobs.push(f);
      fobVariant.push(Math.floor(rand() * SIGN.station.length));
    }
  });
  const fobZones = fobs.map((f) => [f - 2, f + FOB_LENGTH + 2] as [number, number]);
  fobs.forEach((f, i) => {
    out.push({ index: 0, kind: 'fob', variant: fobVariant[i], side: 0, layer: 'span', s0: f, s1: f + FOB_LENGTH, anchorS: f, x: 0, y: 0, rotY: 0, scale: 1, minAbsX: 5.0, keys: [`fob:${fobVariant[i]}`] });
  });

  const addTree = (side: -1 | 1, s: number, layer: PieceLayer, baseX: number) => {
    const v = Math.floor(rand() * TREE_VARIANTS);
    const absX = Math.max(baseX, MIN_SCENERY_X + TREE_REACH[v] + 0.3) + rand() * 1.2;
    out.push(centred('tree', v, side, s, TREE_RADIUS, absX, GROUND_Y, side > 0 ? Math.PI : 0, TREE_REACH[v], layer, [`tree:${v}`]));
  };

  for (const side of [-1, 1] as const) {
    // Near layer: walls, fences, platforms and open gaps with trees and parked autos.
    let c = rand() * 6;
    let lastWall = -1;
    while (c < period - 1) {
      const si = stations.findIndex(([a, b]) => a <= c && c < b);
      if (si >= 0) {
        const [a, b] = stations[si];
        const v = si % SIGN.station.length;
        out.push(frontPiece('platform', v, side, a, PLATFORM_LENGTH, PLATFORM_X, 0, 'near', [`platform:${v}`]));
        c = b + 0.5 + rand() * 1.5;
        continue;
      }
      const next = stations.find(([a]) => a > c)?.[0] ?? period;
      const room = next - c;
      const r = rand();
      let len: number;
      if (r < 0.58 && room >= WALL_LENGTH) {
        const v = (lastWall + 1 + Math.floor(rand() * (WALL_VARIANTS - 1))) % WALL_VARIANTS;
        out.push(frontPiece('wall', v, side, c, WALL_LENGTH, NEAR_X, GROUND_Y, 'near', [`wall:${v}`]));
        lastWall = v;
        len = WALL_LENGTH;
      } else if (r < 0.76 && room >= FENCE_LENGTH) {
        out.push(frontPiece('fence', 0, side, c, FENCE_LENGTH, NEAR_X, GROUND_Y, 'near', ['fence']));
        if (rand() < 0.7) addTree(side, c + 8 + rand() * 14, 'near', 6.5);
        len = FENCE_LENGTH;
      } else {
        len = Math.min(room, 8 + rand() * 12);
        if (len < 3) {
          c = next;
          continue;
        }
        const v = rand() < 0.5 ? 0 : 1;
        const radius = v ? 3.1 : 1.6;
        if (len >= radius * 2 + 1 && rand() < 0.75) {
          const rotY = (side > 0 ? Math.PI : 0) + (rand() - 0.5) * 0.3;
          out.push(centred('auto', v, side, c + radius + 0.5, radius, 5.6 + rand() * 1.0, GROUND_Y, rotY, 0.8, 'near', [`auto:${v}`]));
        }
        if (len >= 9 && rand() < 0.85) addTree(side, c + len - 2, 'near', 6.5);
      }
      c += len + (rand() < 0.3 ? rand() * 2 : 0);
    }

    // Billboards rising above the walls.
    for (let b = 30 + rand() * 50; b < period - 10; ) {
      if (overlaps(b - 12, b + 12, stations) || overlaps(b - 8, b + 8, fobZones)) {
        b += 15;
        continue;
      }
      const v = Math.floor(rand() * AD_VARIANTS);
      const rotY = side > 0 ? Math.PI + BILLBOARD_YAW : -BILLBOARD_YAW;
      out.push(centred('billboard', v, side, b, BILLBOARD_RADIUS, BILLBOARD_X, GROUND_Y, rotY, BILLBOARD_REACH, 'mid', ['billboardFrame', `ad:${v}`]));
      for (let i = out.length - 1; i >= 0; i--) {
        const p = out[i];
        if (p.kind === 'tree' && p.side === side && p.layer === 'near' && Math.abs(p.anchorS - b) < 9) out.splice(i, 1);
      }
      b += 70 + rand() * 80;
    }

    // Mid layer: a street of chawls (kept clear of foot-overbridge stairs).
    let prev = -1;
    for (let m = rand() * 4; m < period; ) {
      const v = (prev + 1 + Math.floor(rand() * (CHAWL_VARIANTS - 1))) % CHAWL_VARIANTS;
      const len = chawlFootprint(v).length;
      if (m + len > period) break;
      const hit = fobZones.find(([a, b]) => m < b && m + len > a);
      if (hit) {
        m = hit[1];
        continue;
      }
      if (rand() < 0.12 && m + 9 < period && !overlaps(m, m + 9, fobZones)) {
        addTree(side, m + 4.5, 'mid', MID_X + 1);
        m += 9;
        continue;
      }
      out.push(frontPiece('chawl', v, side, m, len, MID_X + rand() * 1.2, GROUND_Y, 'mid', [`chawl:${v}`]));
      prev = v;
      m += len + 0.3 + rand() * 2.2;
    }

    // Back layer: bigger, older blocks.
    for (let m = rand() * 10; m < period; ) {
      const v = Math.floor(rand() * CHAWL_VARIANTS);
      const scale = 1.35 + rand() * 0.4;
      const len = chawlFootprint(v).length * scale;
      if (m + len > period) break;
      out.push(frontPiece('chawl', v, side, m, len, BACK_X + rand() * 5, GROUND_Y, 'back', [`chawl:${v}`], scale));
      m += len + 1 + rand() * 5;
    }
  }

  out.sort((a, b) => a.s0 - b.s0);
  let maxExtent = 0;
  out.forEach((p, i) => {
    p.index = i;
    maxExtent = Math.max(maxExtent, p.s1 - p.s0);
  });
  return { period, placements: out, stations, fobs, maxExtent };
}

/** Calls visit for each placement overlapping [a, b] (track metres), across period repeats. Allocation-free. */
export function forEachVisible(plan: CorridorPlan, a: number, b: number, visit: (p: Placement, offset: number) => void): void {
  const list = plan.placements;
  const P = plan.period;
  const m0 = Math.floor((a - plan.maxExtent) / P);
  const m1 = Math.floor(b / P);
  for (let m = m0; m <= m1; m++) {
    const off = m * P;
    const target = a - plan.maxExtent - off;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s0 < target) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length; i++) {
      const p = list[i];
      if (p.s0 + off >= b) break;
      if (p.s1 + off > a) visit(p, off);
    }
  }
}

/** Most placements using `key` that can be visible at once for a view window (pure). */
export function maxConcurrent(plan: CorridorPlan, key: string, behind = VIEW_BEHIND, ahead = VIEW_AHEAD): number {
  const events: [number, number][] = [];
  for (const p of plan.placements) {
    if (!p.keys.includes(key)) continue;
    for (let m = -1; m <= 1; m++) {
      events.push([p.s0 + m * plan.period - ahead, 1]);
      events.push([p.s1 + m * plan.period + behind, -1]);
    }
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

/** True if track position s is at (or within `margin` of) a station platform. */
export function isStationAt(plan: CorridorPlan, s: number, margin = 3): boolean {
  const local = ((s % plan.period) + plan.period) % plan.period;
  return plan.stations.some(([a, b]) => local > a - margin && local < b + margin);
}

// ---------------------------------------------------------------------------------
// Instanced side scenery

function partsForKey(key: string): Parts {
  const [kind, v] = key.split(':');
  const n = Number(v ?? 0);
  switch (kind) {
    case 'chawl':
      return cachedParts(`chawl:${n}`, () => chawlParts(n));
    case 'wall':
      return cachedParts(`wall:${WALL_LENGTH}:${n}`, () => wallParts(WALL_LENGTH, n));
    case 'fence':
      return cachedParts(`fence:${FENCE_LENGTH}`, () => fenceParts(FENCE_LENGTH));
    case 'platform':
      return cachedParts(`platform:${PLATFORM_LENGTH}:${n}`, () => platformParts(PLATFORM_LENGTH, n));
    case 'fob':
      return cachedParts(`fob:${n}`, () => fobParts(n));
    case 'billboardFrame':
      return cachedParts('billboardFrame', billboardFrameParts);
    case 'ad':
      return cachedParts(`ad:${n}`, () => billboardAdParts(n));
    case 'tree':
      return cachedParts(`tree:${n}`, () => treeParts(n));
    case 'auto':
      return cachedParts(`auto:${n}`, () => autoParts(n));
    default:
      throw new Error(`unknown scenery key ${key}`);
  }
}

const CAST = /^(wall|platform|fob|billboardFrame|tree)/;
const RECEIVE = /^(wall|platform|fence|fob)/;

export interface SideScenery {
  root: THREE.Group;
  plan: CorridorPlan;
  meshes: THREE.InstancedMesh[];
  update(runnerS: number): void;
  isStation(s: number): boolean;
}

interface InstSet {
  meshes: THREE.InstancedMesh[];
  count: number;
  cap: number;
}

/**
 * Both sides of the corridor from a precomputed plan. Each (piece, variant) is one set
 * of InstancedMeshes (one per material), so draw calls depend on variant count only.
 */
export function createSideScenery(seed = 1, o: { behind?: number; ahead?: number } = {}): SideScenery {
  const behind = o.behind ?? VIEW_BEHIND;
  const ahead = o.ahead ?? VIEW_AHEAD;
  const plan = planCorridor(seed);
  const root = new THREE.Group();
  root.name = 'sideScenery';
  const sets = new Map<string, InstSet>();
  const meshes: THREE.InstancedMesh[] = [];
  const keys = [...new Set(plan.placements.flatMap((p) => p.keys))].sort();
  for (const key of keys) {
    const cap = Math.max(1, maxConcurrent(plan, key, behind, ahead));
    const set: InstSet = { meshes: [], count: 0, cap };
    for (const part of partsForKey(key)) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, cap);
      mesh.name = `${key}:${part.material.name}`;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = CAST.test(key);
      mesh.receiveShadow = RECEIVE.test(key);
      set.meshes.push(mesh);
      meshes.push(mesh);
      root.add(mesh);
    }
    sets.set(key, set);
  }
  const setsFor = plan.placements.map((p) => p.keys.map((k) => sets.get(k)!));
  const setList = [...sets.values()];
  const obj = new THREE.Object3D();
  let runner = 0;
  const visit = (p: Placement, off: number) => {
    obj.position.set(p.x, p.y, -(p.anchorS + off - runner));
    obj.rotation.set(0, p.rotY, 0);
    obj.scale.setScalar(p.scale);
    obj.updateMatrix();
    const list = setsFor[p.index];
    for (let i = 0; i < list.length; i++) {
      const set = list[i];
      if (set.count >= set.cap) continue;
      for (let j = 0; j < set.meshes.length; j++) set.meshes[j].setMatrixAt(set.count, obj.matrix);
      set.count++;
    }
  };
  return {
    root,
    plan,
    meshes,
    update(runnerS: number) {
      runner = runnerS;
      for (let i = 0; i < setList.length; i++) setList[i].count = 0;
      forEachVisible(plan, runnerS - behind, runnerS + ahead, visit);
      for (let i = 0; i < setList.length; i++) {
        const set = setList[i];
        for (let j = 0; j < set.meshes.length; j++) {
          const m = set.meshes[j];
          m.count = set.count;
          m.visible = set.count > 0;
          m.instanceMatrix.needsUpdate = true;
        }
      }
    },
    isStation: (s: number) => isStationAt(plan, s),
  };
}
