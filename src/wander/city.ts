/**
 * The Wander city: a deterministic, endless neighbourhood, planned in square chunks. Pure — no
 * three.js, no DOM — so the same seed always lays out the same streets and the plan can be tested.
 *
 * World axes: x east, z south, y up (the player faces -z at heading 0). The map is a grid of
 * blocks, one per chunk. Streets run along the chunk boundaries and are 10 m wide, with a 2.5 m
 * footpath inside each edge; the rest of the chunk is a lot for chawls, trees and parked autos.
 *
 *   chunk (cx, cz) covers x in [cx*64, cx*64 + 64), z in [cz*64, cz*64 + 64)
 *
 * Chunk column 0 is the railway: a walled yard with three tracks running north-south. Every sixth
 * row of it is a station (a walkable plaza on the west, a raised platform beside the tracks, and
 * two ramps up to it) and every sixth row, three rows on, an east-west street crosses the line at
 * a level crossing. Everywhere else the walls and the track bed are solid, so nobody wanders onto
 * the line.
 */
import { CHAWL_VARIANTS, chawlFootprint } from '../world/models/scenery';

export const CHUNK = 64;
/** Half the width of a street: streets are 10 m wide, centred on the chunk boundary. */
export const STREET_HALF = 5;
export const FOOTPATH = 2.5;
/** Where a lot starts and ends, in chunk-local metres. */
export const LOT_MIN = STREET_HALF + FOOTPATH;
export const LOT_MAX = CHUNK - LOT_MIN;

// ---------------------------------------------------------------- the railway column

export const RAIL_CX = 0;
/** World x of the middle track (the track-bed kit is centred on it). */
export const TRACK_X = 40;
export const TRACK_LANES = [TRACK_X - 2.5, TRACK_X, TRACK_X + 2.5] as const;
/** The ballast bed is 8.4 m wide. */
export const BED_X0 = TRACK_X - 4.2;
export const BED_X1 = TRACK_X + 4.2;
/** The platform's track-side edge touches the bed; its body reaches PLATFORM_DEPTH to the west. */
export const PLATFORM_X1 = BED_X0;
export const PLATFORM_DEPTH = 6.2;
export const PLATFORM_X0 = PLATFORM_X1 - PLATFORM_DEPTH;
export const PLATFORM_Y = 1;
export const PLATFORM_LENGTH = CHUNK;
/** Station rows and crossing lines repeat on this many chunks. */
export const RAIL_PERIOD = 6;
const CROSSING_PHASE = 3;
/** The wall of the rail yard: x of the face on the west and east side. */
export const WALL_X_WEST = 8;
export const WALL_X_EAST = 56;
export const WALL_LONG = 27;
export const WALL_SHORT = 10;
/** Ramps up to the platform: x run, z width, and where they sit along a station row. */
export const RAMP_X0 = PLATFORM_X0 - 5;
export const RAMP_WIDTH = 3;
export const RAMP_Z = [15, 47] as const;

// ---------------------------------------------------------------- plan types

export type TileKind = 'block' | 'park' | 'yard' | 'yardCrossN' | 'yardCrossS' | 'station';

export type PropKind = 'chawl' | 'tree' | 'auto' | 'billboard' | 'wallLong' | 'wallShort' | 'platform' | 'ramp';

export interface Prop {
  kind: PropKind;
  variant: number;
  x: number;
  z: number;
  rotY: number;
}

/** An axis-aligned solid, in world metres. */
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** A round solid (a trunk, a post). */
export interface Disc {
  x: number;
  z: number;
  r: number;
}

export interface ChunkPlan {
  cx: number;
  cz: number;
  tile: TileKind;
  props: Prop[];
  boxes: Box[];
  discs: Disc[];
  /** Platform number when this row of the railway is a station, else null. */
  station: number | null;
  /** Which edge of the row an east-west street crosses the line on, else null. */
  crossing: 'N' | 'S' | null;
}

// ---------------------------------------------------------------- hashing

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hash of any number of integers, uniform in [0, 2^32). */
export function hashInts(...n: number[]): number {
  let h = 0x1234567;
  for (const v of n) h = mix(h, v | 0);
  return h;
}

/** A small deterministic generator (mulberry32) seeded from integers. */
export function chunkRandom(...n: number[]): () => number {
  let s = hashInts(...n) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;
export const chunkOf = (v: number): number => Math.floor(v / CHUNK);

// ---------------------------------------------------------------- the railway grid

/** True when the east-west street on grid line `j` (z = j * 64) crosses the railway. */
export const isCrossingLine = (j: number): boolean => mod(j, RAIL_PERIOD) === CROSSING_PHASE;
/** The platform number of railway row `cz`, or null when it is not a station row. */
export const stationOfRow = (cz: number): number | null => (mod(cz, RAIL_PERIOD) === 0 ? cz / RAIL_PERIOD : null);

/** The platform whose district a row of the railway belongs to (the nearest station along the line). */
export const nearestStation = (cz: number): number => Math.round(cz / RAIL_PERIOD);

/** What the ground of chunk (cx, cz) looks like. A pure function of the position and the seed. */
export function tileKind(seed: number, cx: number, cz: number): TileKind {
  if (cx === RAIL_CX) {
    if (stationOfRow(cz) !== null) return 'station';
    if (isCrossingLine(cz)) return 'yardCrossN';
    if (isCrossingLine(cz + 1)) return 'yardCrossS';
    return 'yard';
  }
  return chunkRandom(seed, cx, cz, 1)() < 0.12 ? 'park' : 'block';
}

// ---------------------------------------------------------------- planning

/** How many looks of each model the city uses (fewer looks, fewer draw calls). */
export const CHAWL_VARIANTS_IN_USE = Math.min(5, CHAWL_VARIANTS);
export const WALL_VARIANTS_IN_USE = 2;
export const TREE_VARIANTS_IN_USE = 4;
export const AUTO_VARIANTS_IN_USE = 2;
export const BILLBOARD_VARIANTS_IN_USE = 3;
const CHAWL_LOOKS = CHAWL_VARIANTS_IN_USE;
const AUTO_VARIANTS = AUTO_VARIANTS_IN_USE;

/** How far a parked auto's box reaches along its length and across it (variant 1 is two in a row). */
const autoSize = (variant: number): { length: number; width: number } => ({ length: variant % AUTO_VARIANTS === 1 ? 5.6 : 2.5, width: 1.5 });

const box = (x0: number, z0: number, x1: number, z1: number): Box => ({ x0, z0, x1, z1 });

type Edge = 'W' | 'E' | 'N' | 'S';

interface Lot {
  x0: number;
  z0: number;
}

/**
 * A chawl on `edge` of the block, its front on the lot line and `along` metres from the start of the
 * edge. Chawls face out at the street; the model's front is local +x and it runs back to local -z.
 */
function chawlOnEdge(lot: Lot, edge: Edge, variant: number, along: number): { prop: Prop; box: Box; depth: number } {
  const f = chawlFootprint(variant);
  const { x0, z0 } = lot;
  switch (edge) {
    case 'W':
      return {
        prop: { kind: 'chawl', variant, x: x0 + LOT_MIN, z: z0 + along, rotY: Math.PI },
        box: box(x0 + LOT_MIN, z0 + along, x0 + LOT_MIN + f.depth, z0 + along + f.length),
        depth: f.depth,
      };
    case 'E':
      return {
        prop: { kind: 'chawl', variant, x: x0 + LOT_MAX, z: z0 + along + f.length, rotY: 0 },
        box: box(x0 + LOT_MAX - f.depth, z0 + along, x0 + LOT_MAX, z0 + along + f.length),
        depth: f.depth,
      };
    case 'N':
      return {
        prop: { kind: 'chawl', variant, x: x0 + along + f.length, z: z0 + LOT_MIN, rotY: Math.PI / 2 },
        box: box(x0 + along, z0 + LOT_MIN, x0 + along + f.length, z0 + LOT_MIN + f.depth),
        depth: f.depth,
      };
    case 'S':
      return {
        prop: { kind: 'chawl', variant, x: x0 + along, z: z0 + LOT_MAX, rotY: -Math.PI / 2 },
        box: box(x0 + along, z0 + LOT_MAX - f.depth, x0 + along + f.length, z0 + LOT_MAX),
        depth: f.depth,
      };
  }
}

const footprints = Array.from({ length: CHAWL_LOOKS }, (_, v) => chawlFootprint(v));

/**
 * Lines one edge of the block with chawls between `from` and `to` (chunk-local metres along it),
 * left to right with small gaps. Returns the deepest chawl placed (0 if none) and the free spans.
 */
function fillEdge(rand: () => number, lot: Lot, edge: Edge, from: number, to: number, out: ChunkPlan): { depth: number; gaps: [number, number][] } {
  let pos = from + rand() * 1.5;
  let depth = 0;
  const gaps: [number, number][] = [];
  for (;;) {
    const fits: number[] = [];
    for (let v = 0; v < CHAWL_LOOKS; v++) if (pos + footprints[v].length <= to) fits.push(v);
    if (fits.length === 0) break;
    const variant = fits[Math.floor(rand() * fits.length)];
    const c = chawlOnEdge(lot, edge, variant, pos);
    out.props.push(c.prop);
    out.boxes.push(c.box);
    depth = Math.max(depth, c.depth);
    pos += footprints[variant].length;
    const gap = 0.5 + rand() * 2.2;
    // A wide gap between two buildings is a lane or a yard: remember it for a tree or a parked auto.
    if (gap > 1.8) gaps.push([pos, pos + gap]);
    pos += gap;
  }
  if (to - pos > 4) gaps.push([pos, to]);
  return { depth, gaps };
}

const treeDisc = (x: number, z: number): Disc => ({ x, z, r: 0.5 });

function addTree(out: ChunkPlan, rand: () => number, x: number, z: number): void {
  out.props.push({ kind: 'tree', variant: Math.floor(rand() * TREE_VARIANTS_IN_USE), x, z, rotY: rand() * Math.PI * 2 });
  out.discs.push(treeDisc(x, z));
}

/** A parked auto on an east-west (`alongZ` false) or north-south street. The box is the auto's footprint. */
function addAuto(out: ChunkPlan, rand: () => number, x: number, z: number, alongZ: boolean): void {
  const variant = Math.floor(rand() * AUTO_VARIANTS);
  const { length, width } = autoSize(variant);
  // The model faces +z; turn it to run along the street, nose either way.
  const nose = rand() < 0.5 ? 0 : Math.PI;
  const rotY = alongZ ? nose : nose + Math.PI / 2;
  out.props.push({ kind: 'auto', variant, x, z, rotY });
  const hx = (alongZ ? width : length) / 2;
  const hz = (alongZ ? length : width) / 2;
  out.boxes.push(box(x - hx, z - hz, x + hx, z + hz));
}

/** Footpath trees and kerbside autos along the four streets of a block. */
function dressStreets(rand: () => number, lot: Lot, out: ChunkPlan): void {
  const { x0, z0 } = lot;
  const mid = (CHUNK - 2 * 14) / 3;
  for (let i = 0; i < 4; i++) {
    const t = 14 + (i + 0.2 + rand() * 0.6) * mid;
    // Footpath trees (in the 2.5 m strip between the kerb and the lots).
    if (rand() < 0.3) addTree(out, rand, x0 + FOOTPATH + STREET_HALF - 1.1, z0 + t);
    if (rand() < 0.3) addTree(out, rand, x0 + CHUNK - (FOOTPATH + STREET_HALF - 1.1), z0 + t + 3);
    if (rand() < 0.3) addTree(out, rand, x0 + t + 3, z0 + FOOTPATH + STREET_HALF - 1.1);
    if (rand() < 0.3) addTree(out, rand, x0 + t, z0 + CHUNK - (FOOTPATH + STREET_HALF - 1.1));
  }
  // Kerbside autos, leaving the middle of every street and the junctions clear.
  for (let i = 0; i < 3; i++) {
    const t = 16 + i * 16 + rand() * 4;
    if (rand() < 0.3) addAuto(out, rand, x0 + 3.5, z0 + t, true);
    if (rand() < 0.3) addAuto(out, rand, x0 + CHUNK - 3.5, z0 + t + 4, true);
    if (rand() < 0.3) addAuto(out, rand, x0 + t + 4, z0 + 3.5, false);
    if (rand() < 0.3) addAuto(out, rand, x0 + t, z0 + CHUNK - 3.5, false);
  }
}

/** True if a disc at (x, z) of radius r clears every box (with `pad` to spare). */
function clear(out: ChunkPlan, x: number, z: number, r: number, pad = 0.6): boolean {
  for (const b of out.boxes) if (x > b.x0 - r - pad && x < b.x1 + r + pad && z > b.z0 - r - pad && z < b.z1 + r + pad) return false;
  for (const d of out.discs) if (Math.hypot(x - d.x, z - d.z) < d.r + r + pad) return false;
  return true;
}

function planBlock(seed: number, cx: number, cz: number, park: boolean): ChunkPlan {
  const out: ChunkPlan = { cx, cz, tile: park ? 'park' : 'block', props: [], boxes: [], discs: [], station: null, crossing: null };
  const rand = chunkRandom(seed, cx, cz, 2);
  const lot: Lot = { x0: cx * CHUNK, z0: cz * CHUNK };
  const { x0, z0 } = lot;

  if (park) {
    dressStreets(rand, lot, out);
    const n = 7 + Math.floor(rand() * 5);
    for (let i = 0, tries = 0; i < n && tries < 80; tries++) {
      const x = x0 + LOT_MIN + 3 + rand() * (LOT_MAX - LOT_MIN - 6);
      const z = z0 + LOT_MIN + 3 + rand() * (LOT_MAX - LOT_MIN - 6);
      if (!clear(out, x, z, 0.5, 2.2)) continue;
      addTree(out, rand, x, z);
      i++;
    }
    return out;
  }

  // Some blocks leave a street frontage open for a billboard.
  const billboardEdge: Edge | null = rand() < 0.2 ? (['N', 'S'] as const)[Math.floor(rand() * 2)] : null;

  const west = fillEdge(rand, lot, 'W', LOT_MIN, LOT_MAX, out);
  const east = fillEdge(rand, lot, 'E', LOT_MIN, LOT_MAX, out);
  const xFrom = LOT_MIN + west.depth + 1;
  const xTo = LOT_MAX - east.depth - 1;
  const gaps: Record<Edge, [number, number][]> = { W: west.gaps, E: east.gaps, N: [], S: [] };
  let northDepth = 0;
  let southDepth = 0;
  if (billboardEdge !== 'N') {
    const n = fillEdge(rand, lot, 'N', xFrom, xTo, out);
    northDepth = n.depth;
    gaps.N = n.gaps;
  }
  if (billboardEdge !== 'S') {
    const s = fillEdge(rand, lot, 'S', xFrom, xTo, out);
    southDepth = s.depth;
    gaps.S = s.gaps;
  }

  if (billboardEdge) {
    const variant = Math.floor(rand() * BILLBOARD_VARIANTS_IN_USE);
    const bx = x0 + xFrom + 5 + rand() * Math.max(0, xTo - xFrom - 10);
    const bz = billboardEdge === 'N' ? z0 + LOT_MIN + 1.5 : z0 + LOT_MAX - 1.5;
    // The board faces the street it stands on: north edge faces -z, south edge +z.
    const rotY = billboardEdge === 'N' ? Math.PI / 2 : -Math.PI / 2;
    out.props.push({ kind: 'billboard', variant, x: bx, z: bz, rotY });
    // Two steel legs at local (-0.9, ±2.4): the board itself is overhead, so you can walk under it.
    const s = billboardEdge === 'N' ? 1 : -1;
    for (const k of [-2.4, 2.4]) out.discs.push({ x: bx + k * s, z: bz + 0.9 * s, r: 0.5 });
  }

  // The courtyard: trees, a pair of autos in a lane.
  const cy0 = LOT_MIN + northDepth + 1.5;
  const cy1 = LOT_MAX - southDepth - 1.5;
  if (xTo - xFrom > 6 && cy1 - cy0 > 6) {
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
      const x = x0 + xFrom + 1.5 + rand() * (xTo - xFrom - 3);
      const z = z0 + cy0 + 1.5 + rand() * (cy1 - cy0 - 3);
      if (!clear(out, x, z, 0.5, 1.5)) continue;
      addTree(out, rand, x, z);
      i++;
    }
    if (rand() < 0.5) {
      const x = x0 + (xFrom + xTo) / 2 + (rand() - 0.5) * 6;
      const z = z0 + (cy0 + cy1) / 2 + (rand() - 0.5) * 6;
      if (clear(out, x, z, 1.5, 1)) addAuto(out, rand, x, z, rand() < 0.5);
    }
  }
  // A tree in the wider gaps between chawls on the street edges.
  const edgePos: Record<Edge, (t: number) => [number, number]> = {
    W: (t) => [x0 + LOT_MIN + 1.5, z0 + t],
    E: (t) => [x0 + LOT_MAX - 1.5, z0 + t],
    N: (t) => [x0 + t, z0 + LOT_MIN + 1.5],
    S: (t) => [x0 + t, z0 + LOT_MAX - 1.5],
  };
  for (const edge of ['W', 'E', 'N', 'S'] as const) {
    for (const [a, b] of gaps[edge]) {
      if (b - a < 3 || rand() < 0.65) continue;
      const [x, z] = edgePos[edge]((a + b) / 2);
      if (clear(out, x, z, 0.5, 0.4)) addTree(out, rand, x, z);
    }
  }
  dressStreets(rand, lot, out);
  return out;
}

/** The railway row: walled yard, tracks, and (every sixth row) a station. */
function planRail(seed: number, cx: number, cz: number): ChunkPlan {
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const station = stationOfRow(cz);
  const tile = tileKind(seed, cx, cz);
  const crossing = tile === 'yardCrossN' ? 'N' : tile === 'yardCrossS' ? 'S' : null;
  const out: ChunkPlan = { cx, cz, tile, props: [], boxes: [], discs: [], station, crossing };
  const rand = chunkRandom(seed, cx, cz, 3);
  const X0 = x0 + LOT_MIN;
  const X1 = x0 + LOT_MAX;

  // Walls on the west (not where the station's gate is) and east side, in two long pieces per row
  // with a short piece across each street end; a level crossing leaves its street open.
  const wall = (x: number, west: boolean, zStart: number, length: number, kind: 'wallLong' | 'wallShort') => {
    out.props.push({
      kind,
      variant: kind === 'wallLong' ? Math.floor(rand() * WALL_VARIANTS_IN_USE) : 0,
      x,
      z: west ? z0 + zStart : z0 + zStart + length,
      rotY: west ? Math.PI : 0,
    });
  };
  for (const west of [true, false]) {
    const x = x0 + (west ? WALL_X_WEST : WALL_X_EAST);
    // The station's gate is the whole west side of its row, bar the short pieces at its two ends.
    if (!(west && station !== null)) {
      wall(x, west, 5, WALL_LONG, 'wallLong');
      wall(x, west, 5 + WALL_LONG, WALL_LONG, 'wallLong');
    }
    if (!isCrossingLine(cz + 1)) wall(x, west, CHUNK - 5, WALL_SHORT, 'wallShort');
  }

  // Solid ground: the yard behind the walls, less the level crossing's street and the station's plaza.
  if (station === null) {
    const zA = z0 + (crossing === 'N' ? 5 : 0);
    const zB = z0 + (crossing === 'S' ? CHUNK - 5 : CHUNK);
    out.boxes.push(box(X0, zA, X1, zB));
  } else {
    out.boxes.push(box(PLATFORM_X1 + x0, z0, X1, z0 + CHUNK));
    // The two wall pieces that spill 5 m into the row from the streets either side of it.
    out.boxes.push(box(X0, z0, x0 + WALL_X_WEST + 0.5, z0 + 5), box(X0, z0 + CHUNK - 5, x0 + WALL_X_WEST + 0.5, z0 + CHUNK));
    // The platform's west face is solid except where the ramps meet it; the ramps have low kerbs.
    const face = x0 + PLATFORM_X0;
    let z = 0;
    for (const rz of RAMP_Z) {
      out.boxes.push(box(face - 0.2, z0 + z, face, z0 + rz - RAMP_WIDTH / 2));
      out.boxes.push(box(x0 + RAMP_X0, z0 + rz - RAMP_WIDTH / 2 - 0.3, face, z0 + rz - RAMP_WIDTH / 2));
      out.boxes.push(box(x0 + RAMP_X0, z0 + rz + RAMP_WIDTH / 2, face, z0 + rz + RAMP_WIDTH / 2 + 0.3));
      z = rz + RAMP_WIDTH / 2;
    }
    out.boxes.push(box(face - 0.2, z0 + z, face, z0 + CHUNK));
    out.props.push({ kind: 'platform', variant: 0, x: x0 + PLATFORM_X1, z: z0 + CHUNK, rotY: 0 });
    for (const rz of RAMP_Z) out.props.push({ kind: 'ramp', variant: 0, x: x0 + RAMP_X0, z: z0 + rz, rotY: 0 });
    // The forecourt: a few trees and an auto rank.
    for (let i = 0, tries = 0; i < 5 && tries < 40; tries++) {
      const x = x0 + 11 + rand() * 11;
      const z = z0 + 8 + rand() * (CHUNK - 16);
      if (RAMP_Z.some((rz) => Math.abs(z - z0 - rz) < 6 && x > x0 + RAMP_X0 - 4)) continue;
      if (!clear(out, x, z, 0.5, 2)) continue;
      addTree(out, rand, x, z);
      i++;
    }
    for (const z of [26, 36]) {
      const x = x0 + 12 + rand() * 2;
      if (clear(out, x, z0 + z, 1.5, 1)) addAuto(out, rand, x, z0 + z, true);
    }
  }
  // Footpath trees and kerbside autos on the two streets beside the yard.
  for (let i = 0; i < 4; i++) {
    const t = 14 + i * 12 + rand() * 6;
    if (rand() < 0.3) addTree(out, rand, x0 + FOOTPATH + STREET_HALF - 1.1, z0 + t);
    if (rand() < 0.3) addTree(out, rand, x0 + CHUNK - (FOOTPATH + STREET_HALF - 1.1), z0 + t + 3);
  }
  return out;
}

/** The plan of one chunk. Deterministic: the same seed, cx and cz always give the same plan. */
export function planChunk(seed: number, cx: number, cz: number): ChunkPlan {
  if (cx === RAIL_CX) return planRail(seed, cx, cz);
  return planBlock(seed, cx, cz, tileKind(seed, cx, cz) === 'park');
}

// ---------------------------------------------------------------- the city index

/** What the player may walk into near a point: static solids from the plan, plus any moving ones. */
export interface Solids {
  boxes: Box[];
  discs: Disc[];
}

/** Platform and ramp heights over a station row; 0 everywhere else. Pure geometry, no plan needed. */
export function groundHeight(x: number, z: number): number {
  const cx = chunkOf(x);
  if (cx !== RAIL_CX) return 0;
  const cz = chunkOf(z);
  if (stationOfRow(cz) === null) return 0;
  const lx = x - cx * CHUNK;
  const lz = z - cz * CHUNK;
  if (lx >= PLATFORM_X0 && lx <= PLATFORM_X1) return PLATFORM_Y;
  if (lx >= RAMP_X0 && lx < PLATFORM_X0) {
    for (const rz of RAMP_Z) if (Math.abs(lz - rz) <= RAMP_WIDTH / 2) return ((lx - RAMP_X0) / (PLATFORM_X0 - RAMP_X0)) * PLATFORM_Y;
  }
  return 0;
}

/** Chunk plans, made on demand and remembered; the one place that turns a position into solids. */
export class CityIndex {
  private readonly plans = new Map<string, ChunkPlan>();

  constructor(readonly seed: number) {}

  plan(cx: number, cz: number): ChunkPlan {
    const key = `${cx},${cz}`;
    let p = this.plans.get(key);
    if (!p) {
      p = planChunk(this.seed, cx, cz);
      this.plans.set(key, p);
      // Forget the oldest plans once there are plenty: a plan is cheap to make again.
      if (this.plans.size > 400) {
        const oldest = this.plans.keys().next().value;
        if (oldest !== undefined) this.plans.delete(oldest);
      }
    }
    return p;
  }

  /** Fills `out` with the solids of the 3x3 chunks around (x, z). */
  solidsNear(x: number, z: number, out: Solids): Solids {
    out.boxes.length = 0;
    out.discs.length = 0;
    const cx = chunkOf(x);
    const cz = chunkOf(z);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        const p = this.plan(i, j);
        for (const b of p.boxes) out.boxes.push(b);
        for (const d of p.discs) out.discs.push(d);
      }
    }
    return out;
  }

  /** The chunks within `radius` of the one holding (x, z), nearest first. */
  chunksAround(x: number, z: number, radius: number): ChunkPlan[] {
    const cx = chunkOf(x);
    const cz = chunkOf(z);
    const list: ChunkPlan[] = [];
    for (let i = cx - radius; i <= cx + radius; i++) for (let j = cz - radius; j <= cz + radius; j++) list.push(this.plan(i, j));
    list.sort((a, b) => Math.hypot(a.cx - cx, a.cz - cz) - Math.hypot(b.cx - cx, b.cz - cz));
    return list;
  }
}

/** A good place to start: the middle of the street beside the first station's forecourt. */
export function spawnPoint(): { x: number; z: number; heading: number } {
  // The north-south street west of the railway, a little south of the station row's start,
  // facing south (+z) along it so the station gate is on the left.
  return { x: 0, z: 18, heading: Math.PI };
}
