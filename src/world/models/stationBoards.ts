import * as THREE from 'three';
import { flatMaterial } from '../render/materials';
import type { Station } from '../stations';

/**
 * Indian Railways station name boards: yellow with a black border and black lettering,
 * Marathi on top, English below. One canvas texture per station, created only when a
 * platform showing it comes into view, and kept in a small LRU so texture count stays bounded.
 */

export const BOARD_W = 1024;
export const BOARD_H = 256;
/** Board aspect (width / height); board quads are built with this ratio. */
export const BOARD_ASPECT = BOARD_W / BOARD_H;
export const BOARD_CACHE_SIZE = 8;

const FONT_DEVA = '"Noto Sans Devanagari", "Nirmala UI", Mangal, "Kohinoor Devanagari", FreeSans, sans-serif';
const FONT_LATIN = '"Liberation Sans", Arial, "Helvetica Neue", "DejaVu Sans", sans-serif';
const INK = '#141414';
const YELLOW = '#FFD400';

/** A Map-backed least-recently-used cache. `get` refreshes recency; evicted values go to `onEvict`. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    readonly capacity: number,
    private readonly onEvict: (value: V, key: K) => void = () => {},
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  getOrCreate(key: K, make: () => V): V {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const v = make();
    this.map.set(key, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const old = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict(old, oldest);
    }
    return v;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, family: string, size: number, maxW: number, maxH: number): void {
  let s = size;
  ctx.font = `bold ${s}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) s = Math.max(10, Math.floor((s * maxW) / w));
  s = Math.min(s, maxH);
  ctx.font = `bold ${s}px ${family}`;
}

/** Draws one board (Marathi above English) filling w x h. */
export function drawStationBoard(ctx: CanvasRenderingContext2D, w: number, h: number, station: Station): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(10, 10, w - 20, h - 20);
  ctx.fillStyle = INK;
  ctx.fillRect(24, 24, w - 48, 3);
  ctx.fillRect(24, h - 27, w - 48, 3);
  const maxW = w - 90;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  const en = station.en.toUpperCase();
  ctx.font = `bold 80px ${FONT_LATIN}`;
  const lines = ctx.measureText(en).width > maxW * 1.45 ? splitBalanced(en) : null;
  if (!lines) {
    fitText(ctx, station.mr, FONT_DEVA, 96, maxW, 104);
    ctx.fillText(station.mr, w / 2, h * 0.34);
    fitText(ctx, en, FONT_LATIN, 80, maxW, 84);
    ctx.fillText(en, w / 2, h * 0.73);
    return;
  }
  // Long names (CSMT): English on two lines under a slightly smaller Marathi line.
  fitText(ctx, station.mr, FONT_DEVA, 76, maxW, 76);
  ctx.fillText(station.mr, w / 2, h * 0.29);
  const size = Math.min(fontSizeFor(ctx, lines[0], maxW), fontSizeFor(ctx, lines[1], maxW), 54);
  ctx.font = `bold ${size}px ${FONT_LATIN}`;
  ctx.fillText(lines[0], w / 2, h * 0.575);
  ctx.fillText(lines[1], w / 2, h * 0.785);
}

function fontSizeFor(ctx: CanvasRenderingContext2D, text: string, maxW: number): number {
  ctx.font = `bold 100px ${FONT_LATIN}`;
  return Math.floor((100 * maxW) / Math.max(1, ctx.measureText(text).width));
}

/** Splits a name at the space closest to its middle. */
export function splitBalanced(text: string): [string, string] {
  let best = -1;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    if (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2)) best = i;
  }
  return best < 0 ? [text, ''] : [text.slice(0, best), text.slice(best + 1)];
}

interface Board {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  station: Station;
}

function makeBoard(station: Station): Board {
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_W;
  canvas.height = BOARD_H;
  drawStationBoard(canvas.getContext('2d')!, BOARD_W, BOARD_H, station);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const material = flatMaterial({ map: texture, roughness: 0.7, side: THREE.DoubleSide });
  material.name = 'stationBoard';
  return { canvas, texture, material, station };
}

function disposeBoard(b: Board): void {
  b.texture.dispose();
  b.material.dispose();
}

/** Cache keyed by the station object itself (lookups allocate nothing). */
const boards = new LruCache<Station, Board>(BOARD_CACHE_SIZE, disposeBoard);
let created = 0;

/** Redraws every cached board (a web font with Devanagari glyphs arrived). */
function redrawAll(): void {
  for (const b of boards.values()) {
    drawStationBoard(b.canvas.getContext('2d')!, BOARD_W, BOARD_H, b.station);
    b.texture.needsUpdate = true;
  }
}

let fontWatch = false;
function watchFonts(): void {
  if (fontWatch) return;
  fontWatch = true;
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return;
  // Boards are drawn with whatever font is ready; once the Devanagari face loads, redraw them.
  fonts
    .load('bold 96px "Noto Sans Devanagari"', 'स्थानक')
    .then((faces) => {
      if (faces.length) redrawAll();
    })
    .catch(() => {});
  fonts.addEventListener?.('loadingdone', redrawAll);
}

/** The shared board material for a station (created on first use, LRU-bounded). */
export function stationBoardMaterial(station: Station): THREE.MeshStandardMaterial {
  // Called per visible station per frame: the hit path allocates nothing.
  const hit = boards.get(station);
  if (hit) return hit.material;
  watchFonts();
  created++;
  return boards.getOrCreate(station, () => makeBoard(station)).material;
}

/** Diagnostics: boards alive now and created so far. */
export function stationBoardStats(): { cached: number; created: number } {
  return { cached: boards.size, created };
}
