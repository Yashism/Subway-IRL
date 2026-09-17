import * as THREE from 'three';

/** Small deterministic PRNG for procedural textures and models (never used by game logic). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, THREE.CanvasTexture>();

export interface CanvasTextureOptions {
  /** Wrap mode for both axes (default: clamp). */
  repeat?: boolean;
  /** Colour data (sRGB). Set false for masks / data textures. */
  color?: boolean;
  anisotropy?: number;
}

/**
 * Draws a texture once with the 2D canvas API and caches it by key.
 * All procedural art (liveries, graffiti, facades, signs) goes through here.
 */
export function canvasTexture(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  o: CanvasTextureOptions = {},
): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  if (o.color !== false) tex.colorSpace = THREE.SRGBColorSpace;
  if (o.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = o.anisotropy ?? 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(key, tex);
  return tex;
}

/** Adds speckle noise over the whole canvas (grime, gravel, concrete). */
export function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, count: number, colors: string[], size = 2): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = size * (0.5 + rand());
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
}

/** Vertical dirt streaks, like monsoon stains under windows. */
export function streaks(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, count: number, color = 'rgba(40,30,20,0.18)'): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h * 0.6;
    ctx.fillRect(x, y, 1 + rand() * 3, h * (0.1 + rand() * 0.4));
  }
}
