import * as THREE from 'three';
import { addOutline, toonMaterial } from '../render/materials';
import { canvasTexture, seededRandom, speckle } from '../render/canvasTexture';

/**
 * The hero prop of the intro cinematic: a hand-painted film bill the kid pastes on a
 * local train.
 *
 * Everything on it is INVENTED — the film (भागो! / BHAAGO!), the banner, the stars, the
 * certificate and the release strip. No real film, studio, person or logo is referenced,
 * and nothing here is meant to pass for a real poster.
 *
 * The sheet is a segmented plane hinged at its TOP edge (local y runs 0 → -POSTER_H), so
 * `shape()` can roll it up from the bottom (beat 1 → 2) and lift a corner in the draught
 * (beat 3) by rewriting its positions in place. Nothing is allocated per frame.
 */

export const POSTER_W = 0.73;
export const POSTER_H = 1.06;
export const POSTER_VARIANTS = 2;

/** Texture size: same 0.69 aspect as the sheet. */
const TEX_W = 896;
const TEX_H = 1300;
/** Radius of the roll the un-pasted tail curls around (m). */
const ROLL_R = 0.075;
const SEG_X = 6;
const SEG_Y = 12;

const INK = '#141414';
const HEAVY = '"Arial Black", Impact, "Ubuntu", "Liberation Sans", "DejaVu Sans", sans-serif';
const DEVA = '"Noto Sans Devanagari", "Lohit Devanagari", "Mukta", "Kohinoor Devanagari", "Nirmala UI", "FreeSans", sans-serif';
const CONDENSED = '"Ubuntu Condensed", "Liberation Sans Narrow", "DejaVu Sans Condensed", "Arial Narrow", sans-serif';

type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Invented credits. Fictional names only — see the header.
// ---------------------------------------------------------------------------

interface PosterCopy {
  banner: string;
  stars: string[];
  director: string;
  music: string;
  tagline: string;
  release: string;
  cert: string;
  reel: string;
}

const COPY: PosterCopy[] = [
  {
    banner: 'JHAKAAS PICTURES',
    stars: ['CHHOTU KHAMBATA', 'RANI VAGHELA', 'TIGER BHANDARI'],
    director: 'A DIGGU BHAI FILM',
    music: 'MUSIC: TUTTU & PARTY',
    tagline: 'EK LOCAL. EK CHANCE. BHAAGO!',
    release: 'IS SHUKRAVAR — SAB THEATRE MEIN',
    cert: 'U/A · 2026',
    reel: 'PLATFORM 4 · 100% JUGAAD',
  },
  {
    banner: 'BINDAAS TALKIES',
    stars: ['BUNTY MARATHE', 'SHALU PIMPLE', 'MONTY GHATGE'],
    director: 'DIRECTED BY PAPPU REGE',
    music: 'SONGS: BABLI SOUND CO.',
    tagline: 'EK SEETI. EK CHHALAANG. BHAAGO!',
    release: 'AB SAB SHOW HOUSEFUL',
    cert: 'U/A · 2026',
    reel: 'NIGHT LOCAL · NO BRAKES',
  },
];

// ---------------------------------------------------------------------------
// Canvas helpers (local to the poster; the poster owns its own look)
// ---------------------------------------------------------------------------

const _c = new THREE.Color();

function shade(hex: string, f: number): string {
  _c.set(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  _c.getHSL(hsl);
  _c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l * f)));
  return `#${_c.getHexString()}`;
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

/** Draws `text` centred on (cx, cy), squeezed to fit `maxW`. Returns the drawn width. */
function fitted(ctx: Ctx, text: string, cx: number, cy: number, maxW: number, draw: (t: string) => void): number {
  const w = ctx.measureText(text).width || maxW;
  const k = Math.min(1, maxW / w);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, 1);
  draw(text);
  ctx.restore();
  return w * k;
}

interface BlockOptions {
  font: string;
  size: number;
  fill: string | ((ctx: Ctx, size: number) => string | CanvasGradient);
  rim?: string;
  depth?: number;
  depthColor?: string;
  maxW: number;
  /** Outline weight as a fraction of the size (Devanagari needs a lighter one). */
  ink?: number;
}

/** Fat display lettering: cast shadow, ink outline, bright rim, gradient fill. */
function blockText(ctx: Ctx, text: string, cx: number, cy: number, o: BlockOptions): void {
  const { size } = o;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.font = `900 ${size}px ${o.font}`;
  const depth = o.depth ?? Math.round(size * 0.12);
  const depthColor = o.depthColor ?? '#2A0E16';
  const ink = o.ink ?? 0.28;
  fitted(ctx, text, cx, cy, o.maxW, (t) => {
    // cast block depth
    ctx.fillStyle = depthColor;
    ctx.strokeStyle = depthColor;
    ctx.lineWidth = size * ink * 0.8;
    for (let k = depth; k > 0; k -= 2) {
      ctx.strokeText(t, k * 0.7, k);
      ctx.fillText(t, k * 0.7, k);
    }
    // ink outline, then a bright rim inside it
    ctx.strokeStyle = INK;
    ctx.lineWidth = size * ink;
    ctx.strokeText(t, 0, 0);
    if (o.rim) {
      ctx.strokeStyle = o.rim;
      ctx.lineWidth = size * ink * 0.57;
      ctx.strokeText(t, 0, 0);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = size * 0.05;
    ctx.strokeText(t, 0, 0);
    ctx.fillStyle = typeof o.fill === 'string' ? o.fill : o.fill(ctx, size);
    ctx.fillText(t, 0, 0);
  });
  ctx.restore();
}

/** Small condensed caps with an ink shadow, for credits strips. */
function caps(ctx: Ctx, text: string, cx: number, cy: number, size: number, color: string, maxW: number, font = CONDENSED): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${size}px ${font}`;
  fitted(ctx, text, cx, cy, maxW, (t) => {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(t, 2, 3);
    ctx.fillStyle = color;
    ctx.fillText(t, 0, 0);
  });
  ctx.restore();
}

function sunburst(ctx: Ctx, cx: number, cy: number, r: number, rays: number, spin: number, a: string, b: string): void {
  for (let i = 0; i < rays; i++) {
    const t0 = spin + (i / rays) * Math.PI * 2;
    const t1 = t0 + Math.PI / rays;
    ctx.fillStyle = i % 2 === 0 ? a : b;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(t0) * r, cy + Math.sin(t0) * r);
    ctx.lineTo(cx + Math.cos(t1) * r, cy + Math.sin(t1) * r);
    ctx.closePath();
    ctx.fill();
  }
}

function inkPath(ctx: Ctx, fill: string, width: number, path: () => void): void {
  ctx.beginPath();
  path();
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A chunky three-quarter local train, drawn at a diagonal. */
function paintedTrain(ctx: Ctx, cx: number, cy: number, len: number, tilt: number, body: string, band: string): void {
  const h = len * 0.32;
  const ink = Math.max(6, len * 0.014);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  // roof shadow slab, so the body reads against a bright sky
  inkPath(ctx, shade(body, 0.55), ink, () => {
    ctx.moveTo(-len / 2, -h * 0.5);
    ctx.lineTo(len / 2 - h * 0.45, -h * 0.5);
    ctx.quadraticCurveTo(len / 2, -h * 0.5, len / 2, -h * 0.02);
    ctx.lineTo(len / 2, h * 0.5);
    ctx.lineTo(-len / 2, h * 0.5);
  });
  // body
  inkPath(ctx, body, ink, () => {
    ctx.moveTo(-len / 2, -h * 0.38);
    ctx.lineTo(len / 2 - h * 0.45, -h * 0.38);
    ctx.quadraticCurveTo(len / 2, -h * 0.38, len / 2, -h * 0.02);
    ctx.lineTo(len / 2, h * 0.5);
    ctx.lineTo(-len / 2, h * 0.5);
  });
  // waist band
  ctx.fillStyle = band;
  ctx.fillRect(-len / 2, h * 0.14, len - h * 0.06, h * 0.16);
  ctx.fillStyle = shade(band, 0.6);
  ctx.fillRect(-len / 2, h * 0.30, len - h * 0.06, h * 0.05);
  // yellow cab nose
  inkPath(ctx, '#FFD400', ink, () => {
    ctx.moveTo(len / 2 - h * 0.52, -h * 0.38);
    ctx.quadraticCurveTo(len / 2, -h * 0.38, len / 2, -h * 0.02);
    ctx.lineTo(len / 2, h * 0.5);
    ctx.lineTo(len / 2 - h * 0.52, h * 0.5);
  });
  // windscreen + barred side windows
  inkPath(ctx, '#15283A', ink * 0.8, () => {
    ctx.moveTo(len / 2 - h * 0.44, -h * 0.20);
    ctx.lineTo(len / 2 - h * 0.06, -h * 0.14);
    ctx.lineTo(len / 2 - h * 0.06, h * 0.10);
    ctx.lineTo(len / 2 - h * 0.44, h * 0.10);
  });
  const wins = 5;
  const span = len - h * 1.1;
  const ww = (span / wins) * 0.68;
  for (let i = 0; i < wins; i++) {
    const x = -len / 2 + h * 0.28 + (i * span) / wins;
    inkPath(ctx, '#15283A', ink * 0.7, () => ctx.rect(x, -h * 0.20, ww, h * 0.30));
    ctx.fillStyle = 'rgba(200,225,245,0.35)';
    for (let k = 1; k <= 3; k++) ctx.fillRect(x, -h * 0.20 + (h * 0.30 * k) / 4, ww, h * 0.014);
  }
  // headlamp flare
  ctx.fillStyle = '#FFF3B0';
  ctx.beginPath();
  ctx.arc(len / 2 - h * 0.14, h * 0.38, h * 0.10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

interface KidPalette {
  skin: string;
  shirt: string;
  pant: string;
  hair: string;
  shoe: string;
}

/** Strokes a chain of joints twice: a fat ink pass, then the colour on top. */
function bone(ctx: Ctx, pts: readonly (readonly [number, number])[], s: number, width: number, color: string): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? INK : color;
    ctx.lineWidth = s * (pass === 0 ? width + 0.036 : width);
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
    ctx.stroke();
  }
}

/**
 * The film's hero, mid-leap, facing right. An invented cartoon figure — not anybody's
 * likeness. `s` is the figure's nominal height in px.
 */
function leapingKid(ctx: Ctx, cx: number, cy: number, s: number, p: KidPalette, tilt = -0.22): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  // trailing leg first (behind the body)
  bone(ctx, [[-0.02, 0.08], [-0.17, 0.24], [-0.36, 0.26]], s, 0.085, shade(p.pant, 0.8));
  bone(ctx, [[-0.36, 0.26], [-0.44, 0.245]], s, 0.10, shade(p.shoe, 0.8));
  // back arm, swept behind
  bone(ctx, [[-0.01, -0.20], [-0.19, -0.09], [-0.33, -0.17]], s, 0.068, shade(p.skin, 0.82));
  // torso
  inkPath(ctx, p.shirt, s * 0.036, () => {
    ctx.moveTo(-0.11 * s, -0.27 * s);
    ctx.quadraticCurveTo(0.02 * s, -0.31 * s, 0.14 * s, -0.24 * s);
    ctx.lineTo(0.12 * s, 0.05 * s);
    ctx.quadraticCurveTo(0.0 * s, 0.13 * s, -0.11 * s, 0.05 * s);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.ellipse(-0.05 * s, -0.12 * s, 0.035 * s, 0.11 * s, -0.2, 0, Math.PI * 2);
  ctx.fill();
  // leading leg, knee tucked high
  bone(ctx, [[0.04, 0.07], [0.22, 0.10], [0.25, -0.05]], s, 0.088, p.pant);
  bone(ctx, [[0.25, -0.05], [0.32, -0.08]], s, 0.10, p.shoe);
  // front arm, flung forward
  bone(ctx, [[0.08, -0.22], [0.28, -0.30], [0.40, -0.44]], s, 0.070, p.skin);
  // head
  inkPath(ctx, p.skin, s * 0.036, () => ctx.arc(0.07 * s, -0.37 * s, 0.115 * s, 0, Math.PI * 2));
  // hair flying back
  inkPath(ctx, p.hair, s * 0.03, () => {
    ctx.moveTo(-0.045 * s, -0.40 * s);
    ctx.quadraticCurveTo(0.05 * s, -0.55 * s, 0.17 * s, -0.42 * s);
    ctx.quadraticCurveTo(0.07 * s, -0.45 * s, -0.02 * s, -0.43 * s);
    ctx.lineTo(-0.10 * s, -0.47 * s);
    ctx.lineTo(-0.08 * s, -0.40 * s);
  });
  // grin + eye
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(0.115 * s, -0.40 * s, 0.016 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = s * 0.014;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0.10 * s, -0.335 * s, 0.045 * s, -0.5, 0.75);
  ctx.stroke();
  ctx.restore();
}

/** Motion arc behind a figure: a few tapering speed streaks. */
function whoosh(ctx: Ctx, cx: number, cy: number, s: number, rand: () => number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const y = (rand() - 0.5) * s * 0.9;
    const len = s * (0.35 + rand() * 0.5);
    ctx.lineWidth = s * (0.012 + rand() * 0.022);
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, y);
    ctx.quadraticCurveTo(-s * 0.2 - len * 0.5, y - s * 0.05, -s * 0.2 - len, y - s * 0.02);
    ctx.stroke();
  }
  ctx.restore();
}

function torchCone(ctx: Ctx, x: number, y: number, len: number, spread: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const g = ctx.createLinearGradient(0, 0, len, 0);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(255,240,180,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len, -spread);
  ctx.lineTo(len, spread);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Torn edges, paste wrinkles and a printing mis-registration ghost. */
function weather(ctx: Ctx, w: number, h: number, rand: () => number): void {
  // mis-registered magenta plate: a cheap offset-print tell
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#FF2E88';
  ctx.fillRect(-4, 3, w, h);
  ctx.restore();
  // paste wrinkles
  ctx.save();
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 9; i++) {
    const y = rand() * h;
    const g = ctx.createLinearGradient(0, y - 12, 0, y + 12);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.9)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(0, 0);
    ctx.transform(1, (rand() - 0.5) * 0.12, 0, 1, 0, 0);
    ctx.fillRect(0, y - 12, w, 24);
    ctx.restore();
  }
  ctx.restore();
  // sun-bleached top corner
  const bleach = ctx.createLinearGradient(w, 0, w * 0.45, h * 0.4);
  bleach.addColorStop(0, 'rgba(255,250,235,0.3)');
  bleach.addColorStop(1, 'rgba(255,250,235,0)');
  ctx.fillStyle = bleach;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, w, h, rand, 2200, ['rgba(60,40,20,0.20)', 'rgba(255,255,255,0.16)', 'rgba(120,80,40,0.14)'], 2);
  // torn deckle edge: knock out ragged bites along the border
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (const [ex, ey, dx, dy, n] of [
    [0, 0, 1, 0, 26],
    [0, h, 1, 0, 26],
    [0, 0, 0, 1, 18],
    [w, 0, 0, 1, 18],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const t = (i + rand()) / n;
      const x = ex + dx * t * w;
      const y = ey + dy * t * h;
      const r = 3 + rand() * 9;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------
// The two poster variants
// ---------------------------------------------------------------------------

/**
 * The title block: a dark slab from `top` to `bottom` so the lettering always has
 * contrast, Devanagari over Latin. Both are stroked heavily so they read at poster weight
 * even where the system Devanagari font has no black cut.
 */
function drawTitle(ctx: Ctx, w: number, top: number, bottom: number, scale: number, latinFill: string, rim: string, slab: string): void {
  const mid = (top + bottom) / 2;
  ctx.save();
  ctx.fillStyle = slab;
  ctx.beginPath();
  ctx.moveTo(-w * 0.02, top);
  ctx.lineTo(w * 1.02, top + 10 * scale);
  ctx.lineTo(w * 1.02, bottom);
  ctx.lineTo(-w * 0.02, bottom - 8 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const span = bottom - top;
  blockText(ctx, 'भागो!', w / 2, mid - span * 0.255, {
    font: DEVA,
    size: span * 0.34,
    fill: '#FFE04A',
    rim: '#FFF7C8',
    ink: 0.19,
    depth: Math.round(12 * scale),
    depthColor: '#26060F',
    maxW: w * 0.66,
  });
  blockText(ctx, 'BHAAGO!', w / 2, mid + span * 0.09, {
    font: HEAVY,
    size: span * 0.46,
    fill: (c, size) => {
      const g = c.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
      g.addColorStop(0, '#FFF3B0');
      g.addColorStop(0.52, latinFill);
      g.addColorStop(0.54, shade(latinFill, 0.78));
      g.addColorStop(1, shade(latinFill, 0.6));
      return g;
    },
    rim,
    depth: Math.round(18 * scale),
    depthColor: '#26060F',
    maxW: w * 0.9,
  });
}

/** A credits ribbon: dark bar plus centred condensed caps. */
function ribbon(ctx: Ctx, w: number, top: number, height: number, text: string, size: number, color: string, bg: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, top, w, height);
  caps(ctx, text, w / 2, top + height / 2, size, color, w * 0.94);
}

/** The TT: a stocky uniformed silhouette, cap and torch, lunging in. Invented figure. */
function inspectorFigure(ctx: Ctx, cx: number, cy: number, s: number, coat: string, skin: string, beam: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1); // faces left, toward the hero
  ctx.rotate(0.1);
  // trailing leg
  bone(ctx, [[0.0, 0.1], [0.14, 0.27], [0.3, 0.33]], s, 0.095, shade('#1B2233', 1));
  // coat body
  inkPath(ctx, coat, s * 0.04, () => {
    ctx.moveTo(-0.16 * s, -0.26 * s);
    ctx.quadraticCurveTo(0.0 * s, -0.33 * s, 0.16 * s, -0.25 * s);
    ctx.lineTo(0.2 * s, 0.14 * s);
    ctx.quadraticCurveTo(0.0 * s, 0.22 * s, -0.2 * s, 0.13 * s);
  });
  // leading leg
  bone(ctx, [[-0.04, 0.12], [-0.2, 0.26], [-0.34, 0.3]], s, 0.095, '#1B2233');
  // torch arm, thrust forward, and the beam
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  torchCone(ctx, -0.42 * s, -0.40 * s, s * 1.8, s * 0.34, 0.12, beam);
  ctx.restore();
  bone(ctx, [[-0.12, -0.22], [-0.28, -0.32], [-0.36, -0.38]], s, 0.072, skin);
  inkPath(ctx, '#2A2F38', s * 0.028, () => ctx.rect(-0.44 * s, -0.42 * s, 0.11 * s, 0.075 * s));
  // head + peaked cap
  inkPath(ctx, skin, s * 0.036, () => ctx.arc(-0.04 * s, -0.38 * s, 0.115 * s, 0, Math.PI * 2));
  inkPath(ctx, coat, s * 0.03, () => {
    ctx.moveTo(-0.17 * s, -0.44 * s);
    ctx.lineTo(0.08 * s, -0.44 * s);
    ctx.quadraticCurveTo(0.09 * s, -0.56 * s, -0.04 * s, -0.56 * s);
    ctx.quadraticCurveTo(-0.17 * s, -0.56 * s, -0.17 * s, -0.44 * s);
  });
  inkPath(ctx, '#11151F', s * 0.024, () => ctx.rect(-0.22 * s, -0.45 * s, 0.2 * s, 0.035 * s));
  ctx.restore();
}

function certificate(ctx: Ctx, x: number, y: number, s: number, text: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.06);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, -s * 1.5 + 4, -s * 0.5 + 5, s * 3, s, 6);
  ctx.fill();
  ctx.fillStyle = '#F4EFE0';
  roundRect(ctx, -s * 1.5, -s * 0.5, s * 3, s, 6);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(s * 0.5)}px ${CONDENSED}`;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Top banner strip and bottom release strip, shared by both variants. */
function strips(ctx: Ctx, w: number, h: number, scale: number, copy: PosterCopy, bannerInk: string, releaseInk: string): void {
  ctx.fillStyle = 'rgba(16,8,18,0.72)';
  ctx.fillRect(0, 0, w, h * 0.052);
  caps(ctx, `${copy.banner}   PRESENTS`, w / 2, h * 0.026, 30 * scale, bannerInk, w * 0.9);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, h * 0.932, w, h * 0.068);
  caps(ctx, copy.release, w * 0.42, h * 0.958, 34 * scale, releaseInk, w * 0.58);
  caps(ctx, copy.reel, w * 0.42, h * 0.985, 21 * scale, 'rgba(255,255,255,0.68)', w * 0.5);
  certificate(ctx, w * 0.858, h * 0.966, 44 * scale, copy.cert);
}

function drawSunsetPoster(ctx: Ctx, w: number, h: number, copy: PosterCopy, rand: () => number): void {
  const scale = w / 896;
  const art = { top: h * 0.05, bottom: h * 0.585 };
  const aH = art.bottom - art.top;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, art.top, w, aH);
  ctx.clip();
  const sky = ctx.createLinearGradient(0, art.top, 0, art.bottom);
  sky.addColorStop(0, '#4A1360');
  sky.addColorStop(0.24, '#B01F6B');
  sky.addColorStop(0.5, '#EF5A24');
  sky.addColorStop(0.76, '#FFA716');
  sky.addColorStop(1, '#FFDD6E');
  ctx.fillStyle = sky;
  ctx.fillRect(0, art.top, w, aH);
  const sunY = art.top + aH * 0.52;
  sunburst(ctx, w * 0.5, sunY, w * 1.7, 28, 0.11, 'rgba(255,214,90,0.32)', 'rgba(255,255,255,0)');
  ctx.fillStyle = 'rgba(255,130,40,0.32)';
  ctx.beginPath();
  ctx.arc(w * 0.5, sunY, aH * 0.44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFE98A';
  ctx.beginPath();
  ctx.arc(w * 0.5, sunY, aH * 0.35, 0, Math.PI * 2);
  ctx.fill();
  // skyline: chawls and water tanks along the bottom of the art panel
  ctx.fillStyle = '#5E1B3E';
  ctx.beginPath();
  ctx.moveTo(0, art.bottom);
  for (let x = 0; x < w; ) {
    const bw = (26 + rand() * 62) * scale;
    const by = art.bottom - aH * (0.10 + rand() * 0.16);
    ctx.lineTo(x, by);
    ctx.lineTo(x + bw, by);
    if (rand() < 0.3) {
      ctx.lineTo(x + bw * 0.3, by - 16 * scale);
      ctx.lineTo(x + bw * 0.7, by - 16 * scale);
      ctx.lineTo(x + bw, by);
    }
    x += bw;
  }
  ctx.lineTo(w, art.bottom);
  ctx.closePath();
  ctx.fill();
  // the local, airborne across the sun
  whoosh(ctx, w * 0.18, art.top + aH * 0.24, w * 0.7, rand, 'rgba(255,248,210,0.45)');
  paintedTrain(ctx, w * 0.62, art.top + aH * 0.24, w * 0.86, -0.19, '#F0E6C8', '#7A2E3A');
  // the hero, mid-leap off the roof and out of the poster
  whoosh(ctx, w * 0.33, art.top + aH * 0.60, w * 0.26, rand, 'rgba(255,255,255,0.4)');
  leapingKid(ctx, w * 0.32, art.top + aH * 0.60, aH * 0.56, { skin: '#C0824B', shirt: '#E5399B', pant: '#27506E', hair: '#18120E', shoe: '#F4F1E6' });
  ctx.restore();

  ribbon(ctx, w, h * 0.585, h * 0.045, copy.stars.join('   ·   '), 34 * scale, '#FFF2CE', '#2A0716');
  drawTitle(ctx, w, h * 0.63, h * 0.838, scale, '#FF3B2F', '#FFD400', '#3B0A20');
  ribbon(ctx, w, h * 0.838, h * 0.048, copy.tagline, 33 * scale, '#FFE9A8', '#23060F');
  ribbon(ctx, w, h * 0.886, h * 0.046, `${copy.director}   ·   ${copy.music}`, 24 * scale, '#FFD8B0', '#23060F');
  strips(ctx, w, h, scale, copy, '#FFD400', '#FFD400');
  weather(ctx, w, h, rand);
}

function drawNightPoster(ctx: Ctx, w: number, h: number, copy: PosterCopy, rand: () => number): void {
  const scale = w / 896;
  ctx.fillStyle = '#0B0620';
  ctx.fillRect(0, 0, w, h);
  drawTitle(ctx, w, h * 0.05, h * 0.318, scale, '#2FD3EC', '#FFF2CE', '#100A34');
  ribbon(ctx, w, h * 0.318, h * 0.044, copy.stars.join('   ·   '), 32 * scale, '#FFF2CE', '#0A0726');

  const art = { top: h * 0.362, bottom: h * 0.838 };
  const aH = art.bottom - art.top;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, art.top, w, aH);
  ctx.clip();
  const sky = ctx.createLinearGradient(0, art.top, 0, art.bottom);
  sky.addColorStop(0, '#121045');
  sky.addColorStop(0.42, '#4A1266');
  sky.addColorStop(0.72, '#B12A58');
  sky.addColorStop(1, '#2A0B1E');
  ctx.fillStyle = sky;
  ctx.fillRect(0, art.top, w, aH);
  // rain
  ctx.strokeStyle = 'rgba(180,210,255,0.22)';
  ctx.lineWidth = 2 * scale;
  for (let i = 0; i < 150; i++) {
    const x = rand() * w * 1.2 - w * 0.1;
    const y = art.top + rand() * aH;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 8 * scale, y + 28 * scale);
    ctx.stroke();
  }
  // the local, low and rushing in under everyone
  paintedTrain(ctx, w * 0.44, art.top + aH * 0.86, w * 0.92, 0.045, '#93A3AE', '#20365C');
  // the TT lunging in from the right, torch out
  inspectorFigure(ctx, w * 0.78, art.top + aH * 0.44, aH * 0.52, '#1A2440', '#A8703C', 'rgba(255,238,170,0.55)');
  // the hero, running out of the poster
  whoosh(ctx, w * 0.33, art.top + aH * 0.48, w * 0.24, rand, 'rgba(180,240,255,0.45)');
  leapingKid(ctx, w * 0.31, art.top + aH * 0.48, aH * 0.58, { skin: '#C0824B', shirt: '#FFD400', pant: '#1E2B4A', hair: '#18120E', shoe: '#F4F1E6' });
  ctx.restore();

  ribbon(ctx, w, h * 0.838, h * 0.048, copy.tagline, 33 * scale, '#FFD400', '#0A0726');
  ribbon(ctx, w, h * 0.886, h * 0.046, `${copy.director}   ·   ${copy.music}`, 24 * scale, '#C9C2FF', '#0A0726');
  strips(ctx, w, h, scale, copy, '#2FD3EC', '#2FD3EC');
  weather(ctx, w, h, rand);
}

// ---------------------------------------------------------------------------
// Textures and materials
// ---------------------------------------------------------------------------

/** The film bill's artwork. Cached, like every other procedural texture in the kit. */
export function posterTexture(variant = 0): THREE.Texture {
  const v = ((variant % POSTER_VARIANTS) + POSTER_VARIANTS) % POSTER_VARIANTS;
  return canvasTexture(`poster-bhaago-${v}`, TEX_W, TEX_H, (ctx, w, h) => {
    const rand = seededRandom(5150 + v * 911);
    if (v === 0) drawSunsetPoster(ctx, w, h, COPY[0], rand);
    else drawNightPoster(ctx, w, h, COPY[1], rand);
  });
}

/** The washed-out old bill the poster gets slapped over. Deliberately fictional too. */
export function fadedAdTexture(seed = 0): THREE.Texture {
  return canvasTexture(`poster-faded-ad-${seed % 2}`, 320, 400, (ctx, w, h) => {
    const rand = seededRandom(771 + seed * 37);
    const night = seed % 2 === 1;
    ctx.fillStyle = night ? '#9AA6A0' : '#C9BFA6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = night ? '#6C7B86' : '#B08A5E';
    ctx.fillRect(0, h * 0.06, w, h * 0.2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 54px ${HEAVY}`;
    ctx.fillStyle = night ? '#E3EDF2' : '#7A2E3A';
    fitted(ctx, night ? 'CHAAY NO.1' : "MAAMA'S MASALA", w / 2, h * 0.16, w * 0.88, (t) => ctx.fillText(t, 0, 0));
    ctx.font = `bold 30px ${CONDENSED}`;
    ctx.fillStyle = '#3A3128';
    fitted(ctx, night ? 'EK CUP MEIN DIN BAN JAYE' : 'EKDUM KADAK SWAAD', w / 2, h * 0.34, w * 0.9, (t) => ctx.fillText(t, 0, 0));
    ctx.fillStyle = night ? '#4E5A63' : '#8A6E44';
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.62, w * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2C2620';
    ctx.font = `bold 26px ${CONDENSED}`;
    fitted(ctx, 'SINCE 1974', w / 2, h * 0.88, w * 0.6, (t) => ctx.fillText(t, 0, 0));
    // heavy fade and peeling
    ctx.fillStyle = 'rgba(210,200,180,0.45)';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rand, 1400, ['rgba(60,45,25,0.3)', 'rgba(255,255,255,0.25)'], 3);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(rand() * w, rand() * h, 4 + rand() * 16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });
}

const matCache = new Map<string, THREE.MeshToonMaterial>();
function cachedMat(key: string, make: () => THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  let m = matCache.get(key);
  if (!m) matCache.set(key, (m = make()));
  return m;
}

/**
 * Shared material for a poster variant. Double sided (the curled tail shows its back) and
 * alpha-tested, so the ragged torn edge is a real cut-out rather than a soft fringe.
 */
export function posterMaterial(variant = 0): THREE.MeshToonMaterial {
  const v = ((variant % POSTER_VARIANTS) + POSTER_VARIANTS) % POSTER_VARIANTS;
  return cachedMat(`poster-${v}`, () => {
    const m = toonMaterial({ map: posterTexture(v), side: THREE.DoubleSide });
    m.alphaTest = 0.5;
    return m;
  });
}

function fadedAdMaterial(seed: number): THREE.MeshToonMaterial {
  return cachedMat(`faded-ad-${seed % 2}`, () => toonMaterial({ map: fadedAdTexture(seed), transparent: true }));
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface PosterShape {
  /** 0 = rolled shut at the top, 1 = fully pasted down. */
  unfurl: number;
  /** 0..1, how far the bottom-right corner has peeled off in the draught. */
  flap: number;
  /** Wobble phase for the flap, in seconds. */
  time: number;
}

export interface Poster {
  readonly root: THREE.Group;
  readonly mesh: THREE.Mesh;
  /** Rewrites the sheet's vertices in place. Allocation free. */
  shape(s: PosterShape): void;
  /** Disposes only what this poster owns (the sheet geometry); shared art stays cached. */
  dispose(): void;
}

/**
 * A pasted film bill. The group's origin is the poster's TOP edge centre, on the wall;
 * the sheet hangs down (-y) and curls out along +z.
 */
export function buildPoster(variant = 0): Poster {
  const root = new THREE.Group();
  root.name = 'poster';
  const geo = new THREE.PlaneGeometry(POSTER_W, POSTER_H, SEG_X, SEG_Y);
  geo.translate(0, -POSTER_H / 2, 0);
  const rest = new Float32Array(geo.attributes.position.array as Float32Array);
  const mesh = new THREE.Mesh(geo, posterMaterial(variant));
  mesh.name = 'poster-sheet';
  mesh.userData.noOutline = true;
  mesh.frustumCulled = false;
  root.add(mesh);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const shape = (s: PosterShape): void => {
    const u = s.unfurl < 0 ? 0 : s.unfurl > 1 ? 1 : s.unfurl;
    const pasted = POSTER_H * u;
    const n = pos.count;
    for (let i = 0; i < n; i++) {
      const x = rest[i * 3];
      const v = -rest[i * 3 + 1]; // 0 at the top edge, POSTER_H at the bottom
      let y = -v;
      let z = 0;
      if (v > pasted) {
        // the un-pasted tail is still rolled: wrap it around a cylinder at the paste line
        const a = Math.min(Math.PI * 1.6, (v - pasted) / ROLL_R);
        y = -(pasted + ROLL_R * Math.sin(a));
        z = ROLL_R * (1 - Math.cos(a));
      } else {
        // pasted: a little paste ripple, strongest just under the paste line
        const near = 1 - Math.min(1, (pasted - v) / 0.22);
        z = 0.004 * Math.sin(x * 26 + v * 9) + 0.01 * near * (1 - u);
      }
      if (s.flap > 0) {
        // bottom-right corner lifts and flutters
        const kx = Math.max(0, (x + POSTER_W * 0.1) / (POSTER_W * 0.6));
        const ky = Math.max(0, (v - POSTER_H * 0.52) / (POSTER_H * 0.48));
        const k = Math.min(1, kx * ky);
        if (k > 0) {
          const wobble = 0.65 + 0.35 * Math.sin(s.time * 9.5);
          z += k * k * s.flap * 0.17 * wobble;
          y += k * k * s.flap * 0.045 * wobble;
        }
      }
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };
  shape({ unfurl: 1, flap: 0, time: 0 });

  return {
    root,
    mesh,
    shape,
    dispose(): void {
      root.remove(mesh);
      geo.dispose();
    },
  };
}

/** The tired old bill the poster covers. Flat card, faces +z like the poster. */
export function buildFadedAd(seed = 0): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(POSTER_W * 1.35, POSTER_H * 0.82);
  const mesh = new THREE.Mesh(geo, fadedAdMaterial(seed));
  mesh.name = 'faded-ad';
  mesh.userData.noOutline = true;
  return mesh;
}

/**
 * A rolled-up poster, as carried under an arm before it goes on the wall.
 * Origin at the middle of the roll, axis along x.
 */
export function buildRolledPoster(variant = 0): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.045, 0.045, POSTER_W * 0.98, 10, 1, true);
  geo.rotateZ(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, posterMaterial(variant));
  mesh.name = 'poster-roll';
  addOutline(mesh, 0.012);
  return mesh;
}
