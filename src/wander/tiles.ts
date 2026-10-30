/**
 * The ground of the Wander city: one 64 m texture per kind of chunk (a block with its streets, a
 * park, the railway yard, the station forecourt, a level crossing) and the little wedge of a ramp.
 *
 * Streets lie on the chunk boundaries, so every tile paints the half street on each of its edges
 * and the two neighbours' halves meet exactly; centre dashes and zebra crossings are laid out on
 * the same period so they join without a seam.
 */
import * as THREE from 'three';
import { canvasTexture, seededRandom } from '../world/render/canvasTexture';
import { flatMaterial } from '../world/render/materials';
import { CHUNK, FOOTPATH, LOT_MAX, LOT_MIN, PLATFORM_X0, PLATFORM_Y, RAMP_WIDTH, RAMP_X0, STREET_HALF, WALL_X_EAST, WALL_X_WEST, type TileKind } from './city';

/** The ground sits a hair below y = 0 so nothing standing on it can z-fight with it. */
export const GROUND_Y = -0.04;
const SIZE = 1024;
const PX = SIZE / CHUNK;

const ASPHALT = '#4a494b';
const FOOTPATH_COLOR = '#b9ae9c';
const LOT = '#c4b698';
const GRAVEL = '#8c8472';
const PLAZA = '#bab4a6';
const GRASS = '#6ea64f';

interface Edges {
  n: boolean;
  s: boolean;
}

const EDGES: Record<TileKind, Edges> = {
  block: { n: true, s: true },
  park: { n: true, s: true },
  yard: { n: false, s: false },
  yardCrossN: { n: true, s: false },
  yardCrossS: { n: false, s: true },
  station: { n: false, s: false },
};

const rect = (ctx: CanvasRenderingContext2D, x: number, z: number, w: number, d: number): void => ctx.fillRect(x * PX, z * PX, w * PX, d * PX);

function speckleM(ctx: CanvasRenderingContext2D, rand: () => number, count: number, colors: string[], size = 2): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = size * (0.5 + rand());
    ctx.fillRect(rand() * SIZE, rand() * SIZE, s, s);
  }
}

/** Paving: faint joints every 0.6 m. */
function pave(ctx: CanvasRenderingContext2D, x: number, z: number, w: number, d: number, color: string, joint = 'rgba(60,50,40,0.13)'): void {
  ctx.fillStyle = color;
  rect(ctx, x, z, w, d);
  ctx.fillStyle = joint;
  for (let a = x; a < x + w; a += 0.6) rect(ctx, a, z, 0.03, d);
  for (let b = z; b < z + d; b += 0.6) rect(ctx, x, b, w, 0.03);
}

/** A street half along one edge of the tile, with its footpath. `vertical` streets run along z. */
function drawStreet(ctx: CanvasRenderingContext2D, edge: 'w' | 'e' | 'n' | 's', rand: () => number, footpath: boolean): void {
  // Work in a frame where the street runs along "t" and the kerb is at distance STREET_HALF from the tile edge.
  const flip = edge === 'e' || edge === 's';
  const vertical = edge === 'w' || edge === 'e';
  const at = (u: number, t: number, w: number, d: number) => {
    // u: distance from the tile edge across the street; t: along; w: across extent; d: along extent.
    const uu = flip ? CHUNK - u - w : u;
    if (vertical) rect(ctx, uu, t, w, d);
    else rect(ctx, t, uu, d, w);
  };
  ctx.fillStyle = ASPHALT;
  at(0, 0, STREET_HALF, CHUNK);
  if (footpath) {
    // The footpath runs the whole edge; the lot's frontage sits on it.
    const fp = (u: number, t: number, w: number, d: number, color: string, joint: string) => {
      const uu = flip ? CHUNK - u - w : u;
      if (vertical) pave(ctx, uu, t, w, d, color, joint);
      else pave(ctx, t, uu, d, w, color, joint);
    };
    fp(STREET_HALF, 0, FOOTPATH, CHUNK, FOOTPATH_COLOR, 'rgba(60,50,40,0.13)');
    ctx.fillStyle = '#d8d2c6';
    at(STREET_HALF - 0.12, 0, 0.14, CHUNK);
  }
  // Tarmac wear: lighter tyre tracks either side of the middle.
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  at(1.2, 0, 0.9, CHUNK);
  at(3.4, 0, 0.9, CHUNK);
  // Centre line, on the tile edge itself: 4 m dashes on an 8 m period, clear of the junctions.
  ctx.fillStyle = '#efe6c4';
  for (let t = 2; t < CHUNK; t += 8) {
    if (t < STREET_HALF + 1 || t + 4 > CHUNK - STREET_HALF - 1) continue;
    at(0, t, 0.09, 4);
  }
  // Zebra crossings just short of each junction.
  ctx.fillStyle = 'rgba(244,240,230,0.92)';
  for (const t0 of [STREET_HALF + 0.6, CHUNK - STREET_HALF - 2.6]) {
    for (let u = 0.4; u < STREET_HALF - 0.3; u += 0.9) at(u, t0, 0.5, 2);
  }
  // A drain or two.
  ctx.fillStyle = 'rgba(20,20,22,0.55)';
  for (let i = 0; i < 2; i++) at(STREET_HALF - 0.55, 14 + rand() * 36, 0.5, 0.9);
}

function drawTile(ctx: CanvasRenderingContext2D, kind: TileKind): void {
  const rand = seededRandom(0x7117 + kind.length * 31 + kind.charCodeAt(kind.length - 1));
  const edges = EDGES[kind];
  const rail = kind === 'yard' || kind === 'yardCrossN' || kind === 'yardCrossS' || kind === 'station';

  // Ground between the streets.
  ctx.fillStyle = kind === 'park' ? GRASS : rail ? GRAVEL : LOT;
  ctx.fillRect(0, 0, SIZE, SIZE);
  speckleM(ctx, rand, 9000, kind === 'park' ? ['#5f9644', '#7cb55c', '#69a04b'] : rail ? ['#7b7363', '#9a9180', '#6d6556'] : ['#b5a687', '#d0c3a6', '#bfb092'], 2);

  if (kind === 'park') {
    // Sandy paths across the lawn and a jogging track round it.
    ctx.fillStyle = '#cdb98a';
    rect(ctx, LOT_MIN + 1, CHUNK / 2 - 0.9, LOT_MAX - LOT_MIN - 2, 1.8);
    rect(ctx, CHUNK / 2 - 0.9, LOT_MIN + 1, 1.8, LOT_MAX - LOT_MIN - 2);
    ctx.strokeStyle = '#cdb98a';
    ctx.lineWidth = 1.4 * PX;
    ctx.strokeRect((LOT_MIN + 2.5) * PX, (LOT_MIN + 2.5) * PX, (LOT_MAX - LOT_MIN - 5) * PX, (LOT_MAX - LOT_MIN - 5) * PX);
  }

  if (rail) {
    // The forecourt of a station: paved from the gate to the ramps, with bay lines.
    if (kind === 'station') {
      pave(ctx, WALL_X_WEST - 0.5, 0, PLATFORM_X0 - WALL_X_WEST + 0.5, CHUNK, PLAZA);
      ctx.fillStyle = 'rgba(240,236,226,0.8)';
      for (let z = 20; z < 44; z += 2.4) rect(ctx, 11.5, z, 3.2, 0.1);
      // Safety strip along the ramps' feet.
      ctx.fillStyle = '#e1c14a';
      rect(ctx, RAMP_X0 - 0.2, 0, 0.12, CHUNK);
    }
    // Dirt either side of the wall line, so the walls do not stand on bare lot.
    ctx.fillStyle = 'rgba(70,60,45,0.25)';
    rect(ctx, WALL_X_WEST - 0.9, 0, 1.2, CHUNK);
    rect(ctx, WALL_X_EAST - 0.3, 0, 1.2, CHUNK);
  }

  // The streets: W and E always; N and S unless this is closed railway yard.
  drawStreet(ctx, 'w', rand, true);
  drawStreet(ctx, 'e', rand, true);
  if (edges.n) drawStreet(ctx, 'n', rand, !rail);
  if (edges.s) drawStreet(ctx, 's', rand, !rail);
  // A level crossing paints the street straight across the yard.
  if (rail && (edges.n || edges.s)) {
    ctx.fillStyle = ASPHALT;
    const z = edges.n ? 0 : CHUNK - STREET_HALF;
    rect(ctx, STREET_HALF, z, CHUNK - 2 * STREET_HALF, STREET_HALF);
    ctx.fillStyle = 'rgba(244,240,230,0.9)';
    // Stop lines at the crossing's edges.
    rect(ctx, WALL_X_WEST + 0.4, edges.n ? STREET_HALF - 0.4 : CHUNK - STREET_HALF, 0.2, 0.4);
  }
  // A few cracks and stains.
  ctx.fillStyle = 'rgba(30,25,20,0.12)';
  for (let i = 0; i < 90; i++) ctx.fillRect(rand() * SIZE, rand() * SIZE, 4 + rand() * 18, 1.2);
}

const materials = new Map<TileKind, THREE.MeshStandardMaterial>();

export function tileMaterial(kind: TileKind): THREE.MeshStandardMaterial {
  let m = materials.get(kind);
  if (!m) {
    const map = canvasTexture(`wander-tile-${kind}`, SIZE, SIZE, (ctx) => drawTile(ctx, kind), { anisotropy: 8 });
    m = flatMaterial({ map, roughness: 1 });
    m.name = `wander-tile-${kind}`;
    materials.set(kind, m);
  }
  return m;
}

/** One chunk's ground, from the chunk's own origin (its north-west corner) to +64 on x and z. */
export function tileGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(CHUNK, CHUNK);
  g.rotateX(-Math.PI / 2);
  g.translate(CHUNK / 2, GROUND_Y, CHUNK / 2);
  return g;
}

/**
 * A ramp up to the platform: its foot at local x = 0 (west), its top edge `run` metres east at the
 * platform's height, centred on z = 0. Flat-shaded concrete.
 */
export function rampGeometry(run = PLATFORM_X0 - RAMP_X0, rise = PLATFORM_Y, width = RAMP_WIDTH): THREE.BufferGeometry {
  const h = width / 2;
  const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const tris: [number, number, number][][] = [
    // The slope.
    [v(0, 0, -h), v(0, 0, h), v(run, rise, h)],
    [v(0, 0, -h), v(run, rise, h), v(run, rise, -h)],
    // The two sides.
    [v(0, 0, -h), v(run, rise, -h), v(run, 0, -h)],
    [v(0, 0, h), v(run, 0, h), v(run, rise, h)],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  for (const t of tris) {
    for (const p of t) {
      pos.push(p[0], p[1], p[2]);
      uv.push(p[0] / run, p[2] / width + 0.5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

let rampMat: THREE.MeshStandardMaterial | null = null;
export function rampMaterial(): THREE.MeshStandardMaterial {
  rampMat ??= flatMaterial({ color: '#b9b2a3', roughness: 1 });
  rampMat.name = 'wander-ramp';
  return rampMat;
}
