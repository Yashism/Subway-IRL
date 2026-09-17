/** Metres of track per roadside building. */
export const BUILDING_SLOT = 12;

/** Chawl-and-shopfront colours. */
export const BUILDING_PALETTE = [0xf2c14e, 0xf78154, 0x5fad56, 0x4d9de0, 0xe15554, 0xc9ada7, 0xf4d6cc, 0x9c89b8] as const;

/**
 * Items repeat every `spacing` metres along the track. Returns how far ahead of the
 * runner (at s) each one is, for those between `behind` metres back and `ahead` metres forward.
 */
export function repeatingOffsets(s: number, spacing: number, behind: number, ahead: number): number[] {
  const first = Math.ceil((s - behind) / spacing);
  const last = Math.floor((s + ahead) / spacing);
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(k * spacing - s);
  return out;
}

function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 13;
  x = Math.imul(x, 0x27d4eb2f);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export interface BuildingLook {
  height: number;
  width: number;
  depth: number;
  color: number;
}

/** The building in slot k on one side of the track; always the same for the same slot. */
export function buildingAt(k: number, side: -1 | 1): BuildingLook {
  const n = k * 2 + (side > 0 ? 1 : 0);
  return {
    height: 6 + hash01(n, 0) * 16,
    width: 7 + hash01(n, 1) * 4,
    depth: 6 + hash01(n, 2) * 6,
    color: BUILDING_PALETTE[Math.floor(hash01(n, 3) * BUILDING_PALETTE.length)],
  };
}
