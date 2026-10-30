/**
 * What to call the place the walker is standing in: a street, a junction, a level crossing, a
 * station forecourt or platform. Pure: it reads the city's grid, never the scene.
 *
 * Stations and their neighbourhoods use the real station names of the chosen suburban line
 * (src/world/stations.ts), so walking along the railway goes Dadar, Matunga Road, Mahim Junction…
 * Streets get plausible Mumbai road names, a different one for every grid line.
 */
import { LINES, stationForPlatform, type LineId } from '../world/stations';
import {
  CHUNK,
  PLATFORM_X0,
  PLATFORM_X1,
  RAIL_CX,
  STREET_HALF,
  FOOTPATH,
  chunkOf,
  isCrossingLine,
  nearestStation,
  stationOfRow,
  tileKind,
} from './city';

export interface Place {
  kind: 'street' | 'junction' | 'crossing' | 'station' | 'platform' | 'park' | 'block';
  /** The big line: the street, the station, the park. */
  primary: string;
  /** The small line: the neighbourhood, or what kind of place this is. */
  secondary: string;
  /** Station code (CCG, DDR…) on a station or platform. */
  code?: string;
  /** Marathi name on a station or platform. */
  marathi?: string;
  /** Changes whenever the readout would: for cheap change detection. */
  key: string;
}

/** Forty roads. 7 is coprime to 40, so stepping a grid line at a time never repeats a name nearby. */
export const STREET_NAMES = [
  'Linking Road',
  'Hill Road',
  'Waterfield Road',
  'Turner Road',
  'Carter Road',
  'Pali Hill Road',
  'Station Road',
  'Gokhale Road',
  'Tilak Road',
  'Ranade Road',
  'Cadell Road',
  'Keshavrao Marg',
  'Senapati Bapat Marg',
  'Lamington Road',
  'Peddar Road',
  'Nepean Sea Road',
  'Bhulabhai Desai Road',
  'Kemps Corner Road',
  'Dr. Ambedkar Road',
  'Lokmanya Tilak Marg',
  'Mahatma Gandhi Road',
  'Swami Vivekanand Road',
  'Sardar Patel Road',
  'Veer Savarkar Marg',
  'Ghodbunder Road',
  'Juhu Tara Road',
  'Bazaar Road',
  'Chapel Road',
  'Perry Cross Road',
  'Union Park Road',
  'Church Road',
  'Mogra Lane',
  'Nehru Road',
  'Dadabhai Naoroji Road',
  'Kalbadevi Road',
  'Mohammed Ali Road',
  'Sion Circle Road',
  'Tardeo Road',
  'Ganesh Galli',
  'Khotachiwadi Lane',
] as const;

export const PARK_NAMES = ['Shivaji Park', 'Priyadarshini Park', 'Joggers Park', 'Oval Maidan', 'Five Gardens', 'Mahim Nature Park'] as const;

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** The name of the street on grid line `i` of the given axis ('ns' runs north-south at x = i * 64). */
export function streetName(axis: 'ns' | 'ew', i: number, seed = 0): string {
  const n = STREET_NAMES.length;
  return STREET_NAMES[mod(i * 7 + (axis === 'ns' ? 0 : 17) + Math.abs(seed | 0), n)];
}

/** Which grid line a position along an axis is nearest, and how far from it (metres). */
function nearestLine(v: number): { line: number; dist: number } {
  const line = Math.round(v / CHUNK);
  return { line, dist: Math.abs(v - line * CHUNK) };
}

const KERB = STREET_HALF + FOOTPATH;

/** The place at (x, z) on the given suburban line. */
export function placeAt(seed: number, line: LineId, x: number, z: number): Place {
  const cx = chunkOf(x);
  const cz = chunkOf(z);
  const lx = x - cx * CHUNK;
  const lz = z - cz * CHUNK;
  const lineName = LINES[line].name;
  const district = stationForPlatform(line, nearestStation(cz));
  const near = district.en;

  const ns = nearestLine(x);
  const ew = nearestLine(z);
  const onNs = ns.dist < KERB;
  const onEw = ew.dist < KERB;

  if (cx === RAIL_CX) {
    const platformNo = stationOfRow(cz);
    if (platformNo !== null) {
      const st = stationForPlatform(line, platformNo);
      if (lx >= PLATFORM_X0 && lx <= PLATFORM_X1) {
        return { kind: 'platform', primary: st.en, secondary: `Platform 1 · ${lineName} line`, code: st.code, marathi: st.mr, key: `platform:${st.en}` };
      }
      if (lx > KERB && lx < PLATFORM_X0) {
        return { kind: 'station', primary: `${st.en} Station`, secondary: `${lineName} line`, code: st.code, marathi: st.mr, key: `station:${st.en}` };
      }
    }
    // A level crossing: on the street where it meets the line.
    if (lx > KERB && lx < CHUNK - KERB && onEw && isCrossingLine(ew.line)) {
      const street = streetName('ew', ew.line, seed);
      return { kind: 'crossing', primary: street, secondary: `Level crossing · near ${near}`, key: `crossing:${street}:${near}` };
    }
  }

  if (onNs && onEw) {
    const a = streetName('ns', ns.line, seed);
    const b = streetName('ew', ew.line, seed);
    return { kind: 'junction', primary: a, secondary: `Junction with ${b} · near ${near}`, key: `junction:${a}:${b}:${near}` };
  }
  if (onNs || onEw) {
    const street = onNs ? streetName('ns', ns.line, seed) : streetName('ew', ew.line, seed);
    return { kind: 'street', primary: street, secondary: near, key: `street:${street}:${near}` };
  }

  // Inside a block: a park has a name, any other block is addressed by its nearest street.
  if (cx !== RAIL_CX && tileKind(seed, cx, cz) === 'park') {
    const park = PARK_NAMES[mod(cx * 5 + cz * 3 + Math.abs(seed | 0), PARK_NAMES.length)];
    return { kind: 'park', primary: park, secondary: near, key: `park:${park}:${near}` };
  }
  const dW = lx;
  const dE = CHUNK - lx;
  const dN = lz;
  const dS = CHUNK - lz;
  const m = Math.min(dW, dE, dN, dS);
  const street =
    m === dW ? streetName('ns', cx, seed) : m === dE ? streetName('ns', cx + 1, seed) : m === dN ? streetName('ew', cz, seed) : streetName('ew', cz + 1, seed);
  return { kind: 'block', primary: street, secondary: near, key: `block:${street}:${near}` };
}
