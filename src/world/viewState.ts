import type { ChunkDef } from '../game/chunks';
import { LANE_WIDTH, laneX } from '../game/config';
import type { GameState } from '../game/game';
import { lengthOf, type ObstacleKind } from '../game/obstacles';
import type { CharacterAction } from './models/characters';

/**
 * Pure mapping from game state to what the world view shows. No three.js objects here,
 * so it is cheap to unit-test.
 */

export interface RunnerLook {
  state: GameState;
  flying: boolean;
  airborne: boolean;
  rolling: boolean;
  hoverboard: boolean;
  /** A stumble event happened recently and its stagger is still playing. */
  stumbling: boolean;
}

export function runnerAction(v: RunnerLook): CharacterAction {
  switch (v.state) {
    case 'menu':
    case 'countdown':
      return 'idle';
    case 'caught':
    case 'summary':
      return 'caught';
    default:
      break;
  }
  if (v.flying) return 'fly';
  if (v.airborne) return 'jump';
  if (v.rolling) return 'roll';
  if (v.stumbling) return 'stumble';
  if (v.hoverboard) return 'hover';
  return 'run';
}

/**
 * Progress through a jump, 0 at take-off, 0.5 at the apex, 1 on landing, from the vertical
 * speed (a ballistic arc's speed falls linearly from +launch to -launch). A fall off a roof
 * starts at the apex; a slam clamps to the landing pose.
 */
export function airborneProgress(vy: number, launchSpeed: number): number {
  if (!(launchSpeed > 0)) return 0.5;
  const t = (1 - vy / launchSpeed) / 2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** -1..1: which way (and how hard) the runner is moving between lanes. */
export function laneLean(x: number, lane: number): number {
  const d = (laneX(lane) - x) / (LANE_WIDTH * 0.5);
  return d < -1 ? -1 : d > 1 ? 1 : d;
}

/** Look variants per obstacle kind (seed = id mod n). */
export const OBSTACLE_VARIANTS: Record<ObstacleKind, number> = {
  trainParked: 8,
  trainMoving: 8,
  barrierLow: 2,
  handcart: 3,
  bannerHigh: 3,
  auto: 2,
  cow: 6,
  ramp: 2,
};

export const isTrain = (kind: ObstacleKind): boolean => kind === 'trainParked' || kind === 'trainMoving';

export function obstacleVariant(kind: ObstacleKind, id: number): number {
  const n = OBSTACLE_VARIANTS[kind];
  return ((Math.floor(id) % n) + n) % n;
}

/** Pool key: trains differ by length as well as look. */
export function obstacleKey(kind: ObstacleKind, variant: number, length: number): string {
  return isTrain(kind) ? `${kind}|${variant}|${Math.round(length * 100) / 100}` : `${kind}|${variant}`;
}

/** Train variant -> livery and seed (the seed picks the graffiti set). */
export function trainLook(variant: number): { livery: 'western' | 'central'; seed: number } {
  return { livery: variant >= OBSTACLE_VARIANTS.trainParked / 2 ? 'central' : 'western', seed: variant };
}

/** Every train length the chunk set can produce, per train kind. */
export function trainLengths(chunks: readonly ChunkDef[]): Record<'trainParked' | 'trainMoving', number[]> {
  const out = { trainParked: new Set<number>(), trainMoving: new Set<number>() };
  for (const c of chunks) {
    for (const spec of c.obstacles) {
      if (spec.kind === 'trainParked' || spec.kind === 'trainMoving') out[spec.kind].add(lengthOf(spec));
    }
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { trainParked: sorted(out.trainParked), trainMoving: sorted(out.trainMoving) };
}

/** Exponential smoothing factor for a rate in Hz over dt seconds. */
export function damp(rateHz: number, dt: number): number {
  return dt > 0 ? 1 - Math.exp(-rateHz * dt) : 0;
}
