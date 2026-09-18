/**
 * Lane spots: the player's own left, centre and right positions for full-body mode, and the lane
 * zones they turn into. Spec: docs/superpowers/specs/2026-09-18-lane-spots.md
 *
 * A spot is the hip's sideways offset from the calibration baseline in torso lengths — the very
 * quantity `FullBodyMoves` compares (`MoveMagnitudes.lane`), signed like the lane (negative is the
 * player's left). Relative to the calibrated centre, so a spot survives the laptop being moved and
 * scales with the player's distance from the camera. Full-body mode never drifts the baseline's x,
 * so spots stay put for a whole run.
 */

export interface LaneSpots {
  left: number;
  centre: number;
  right: number;
}

/**
 * Where a side lane is entered and left, as signed offsets. The automatic path is the symmetric
 * special case (`symmetricZones`); spots give asymmetric ones (`spotZones`). Read by `nextLane`.
 */
export interface LaneZones {
  /** Offset at or below which the left lane is entered. */
  enterL: number;
  /** Offset the hips must come back above to leave the left lane. */
  exitL: number;
  /** Offset at or above which the right lane is entered. */
  enterR: number;
  /** Offset the hips must come back below to leave the right lane. */
  exitR: number;
}

export const LANE_SPOTS_KEY = 'subway-irl.laneSpots.v1';

/** A side spot must be at least this far from the centre spot, in torso lengths. */
export const MIN_SPOT_GAP = 0.25;
/**
 * No spot is further from the calibrated centre than this. Nobody's hips leave the camera frame
 * and come back four torso lengths away; a stored value beyond it is corrupt or hostile, not a room.
 */
export const MAX_SPOT = 4;
/**
 * The exit point sits this far back from the boundary towards the centre spot: today's
 * enter 0.5 / exit 0.35 is exactly 30 % of the way back, so spots keep the same feel.
 */
export const LANE_HYSTERESIS = 0.3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSpot = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SPOT;

/**
 * Validates spots from anywhere (storage, a recording, a caller). Null unless all three are finite,
 * in bounds, in left < centre < right order and each side at least `MIN_SPOT_GAP` from the centre —
 * the same rule the setup enforces, so a survivor is always one the setup could have recorded.
 */
export function cleanLaneSpots(v: unknown): LaneSpots | null {
  if (!isObj(v)) return null;
  const left = Object.hasOwn(v, 'left') ? v.left : undefined;
  const centre = Object.hasOwn(v, 'centre') ? v.centre : undefined;
  const right = Object.hasOwn(v, 'right') ? v.right : undefined;
  if (!isSpot(left) || !isSpot(centre) || !isSpot(right)) return null;
  if (centre - left < MIN_SPOT_GAP || right - centre < MIN_SPOT_GAP) return null;
  return { left, centre, right };
}

/** Today's zones: enter at ±enter, leave inside ±exit. `out` is filled in place and returned. */
export function symmetricZones(enter: number, exit: number, out: LaneZones = { enterL: 0, exitL: 0, enterR: 0, exitR: 0 }): LaneZones {
  out.enterL = -enter;
  out.exitL = -exit;
  out.enterR = enter;
  out.exitR = exit;
  return out;
}

/**
 * The zones for a player's spots. The boundaries sit halfway between the centre spot and each side
 * spot; sensitivity divides each boundary's distance from the centre spot, exactly as it divides the
 * automatic thresholds; and a side lane is left only once the hips are `LANE_HYSTERESIS` of the way
 * back from its boundary to the centre spot. `out` is filled in place and returned.
 */
export function spotZones(s: LaneSpots, sens: number, out: LaneZones = { enterL: 0, exitL: 0, enterR: 0, exitR: 0 }): LaneZones {
  const c = s.centre;
  const dl = (c - (s.left + c) / 2) / sens;
  const dr = ((s.right + c) / 2 - c) / sens;
  out.enterL = c - dl;
  out.exitL = c - dl * (1 - LANE_HYSTERESIS);
  out.enterR = c + dr;
  out.exitR = c + dr * (1 - LANE_HYSTERESIS);
  return out;
}

// ---------------------------------------------------------------- storage

export interface StoredLaneSpots extends LaneSpots {
  /** Epoch ms of the setup that recorded them. */
  at: number;
}

export type LaneSpotsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Reads the stored record. Corrupt, partial, out-of-order or hostile data yields null, never a throw. */
export function parseLaneSpots(raw: string | null): StoredLaneSpots | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const spots = cleanLaneSpots(data);
  if (!spots || !isObj(data)) return null;
  const at = typeof data.at === 'number' && Number.isFinite(data.at) && data.at >= 0 ? data.at : 0;
  return { ...spots, at };
}

function defaultStorage(): LaneSpotsStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

/**
 * The saved lane spots. Storage is optional at every step: a blocked or full localStorage leaves
 * the spots working for this session, held in memory. Nothing in here throws.
 */
export class LaneSpotsStore {
  private readonly storage: LaneSpotsStorage | null;
  private record: StoredLaneSpots | null;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: LaneSpotsStorage | null, private readonly key = LANE_SPOTS_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(key) : null;
    } catch {
      raw = null;
    }
    this.record = parseLaneSpots(raw);
  }

  /** The saved spots, or null when there are none (or none worth trusting). */
  get(): StoredLaneSpots | null {
    return this.record ? { ...this.record } : null;
  }

  get empty(): boolean {
    return this.record === null;
  }

  /** Records a finished setup. Spots that fail validation are refused; returns whether it saved. */
  save(spots: LaneSpots, at: number): boolean {
    const clean = cleanLaneSpots(spots);
    if (!clean) return false;
    this.record = { ...clean, at: Number.isFinite(at) && at >= 0 ? at : 0 };
    this.write();
    return true;
  }

  clear(): void {
    this.record = null;
    this.write();
  }

  private write(): void {
    if (!this.storage) return;
    try {
      if (this.record) this.storage.setItem(this.key, JSON.stringify(this.record));
      else this.storage.removeItem(this.key);
    } catch {
      // Quota or privacy mode: keep playing with the in-memory spots.
    }
  }
}
