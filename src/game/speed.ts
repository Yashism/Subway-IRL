import { DIFFICULTY, TUNING, type Difficulty } from './config';

export type Tier = 0 | 1 | 2 | 3 | 4;

/** Speed-fraction ranges for tiers 1–4 (tier 0 is the warm-up). */
export const TIER_FRACTIONS: Record<1 | 2 | 3 | 4, [number, number]> = {
  1: [0, 0.25],
  2: [0.25, 0.5],
  3: [0.5, 0.75],
  4: [0.75, 1],
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const topSpeed = (d: Difficulty): number => TUNING.topSpeed * DIFFICULTY[d].speed;

/** Eases from the start speed up to the difficulty's top speed over the ramp. */
export function speedAt(tSec: number, d: Difficulty): number {
  const u = clamp01((tSec * DIFFICULTY[d].ramp) / TUNING.rampSeconds);
  const eased = 1 - (1 - u) ** 2;
  return TUNING.startSpeed + (topSpeed(d) - TUNING.startSpeed) * eased;
}

export const speedFraction = (speed: number, d: Difficulty): number =>
  clamp01((speed - TUNING.startSpeed) / (topSpeed(d) - TUNING.startSpeed));

/** Minimum time between moves the track may demand at this speed. */
export const minGapAt = (speed: number, d: Difficulty): number =>
  TUNING.minGapStart + (TUNING.minGapFloor - TUNING.minGapStart) * speedFraction(speed, d);

export function tierFor(tSec: number, d: Difficulty): Tier {
  if (tSec < TUNING.warmupSeconds) return 0;
  const f = speedFraction(speedAt(tSec, d), d);
  return f < 0.25 ? 1 : f < 0.5 ? 2 : f < 0.75 ? 3 : 4;
}
