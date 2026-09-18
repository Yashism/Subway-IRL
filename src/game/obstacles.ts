import type { Lane } from '../pose/types';
import { TUNING } from './config';

export type ObstacleKind =
  | 'trainParked'
  | 'trainMoving'
  | 'barrierLow'
  | 'handcart'
  | 'bannerHigh'
  | 'auto'
  | 'cow'
  | 'cowSitting'
  | 'ramp';

/** What the player must do: leave the lane, jump, roll, or nothing (ramps). */
export type ObstacleAction = 'lane' | 'jump' | 'roll' | 'none';

export interface ObstacleInfo {
  length: number;
  yMin: number;
  yMax: number;
  /** Height you can stand on (train roof / top of a ramp), or null. */
  walkTop: number | null;
  action: ObstacleAction;
  moving: boolean;
}

const H = TUNING.trainHeight;

export const OBSTACLES: Record<ObstacleKind, ObstacleInfo> = {
  trainParked: { length: 30, yMin: 0, yMax: H, walkTop: H, action: 'lane', moving: false },
  trainMoving: { length: 30, yMin: 0, yMax: H, walkTop: null, action: 'lane', moving: true },
  barrierLow: { length: 0.5, yMin: 0, yMax: 1.0, walkTop: null, action: 'jump', moving: false },
  handcart: { length: 1.5, yMin: 0, yMax: 1.1, walkTop: null, action: 'jump', moving: false },
  bannerHigh: { length: 0.5, yMin: 1.0, yMax: 3.0, walkTop: null, action: 'roll', moving: false },
  auto: { length: 3, yMin: 0, yMax: 2.0, walkTop: null, action: 'lane', moving: false },
  /** A standing cow: head and horns up at 1.6 m, too tall to jump — go round. */
  cow: { length: 2.5, yMin: 0, yMax: 1.6, walkTop: null, action: 'lane', moving: false },
  /**
   * A cow lying down, head low: jump it. It used to be drawn at random for `cow` while still
   * colliding at a standing cow's 1.6 m, so a cow that looked jumpable was not — its own kind now,
   * with a model that stays under this height.
   */
  cowSitting: { length: 2.5, yMin: 0, yMax: 0.95, walkTop: null, action: 'jump', moving: false },
  ramp: { length: 8, yMin: 0, yMax: 0, walkTop: H, action: 'none', moving: false },
};

/**
 * The height a jump must clear to pass over an obstacle. For a jump obstacle that is a little under
 * its real top — a shoe brushing the upper edge is not a crash (`TUNING.jumpForgiveness`) — and for
 * everything else its full height. The game's collision and the passability solver both use this,
 * so they can never disagree about what a jump clears.
 */
export function clearTop(info: ObstacleInfo): number {
  return info.action === 'jump' ? info.yMax - TUNING.jumpForgiveness : info.yMax;
}

export interface ObstacleSpec {
  kind: ObstacleKind;
  lane: Lane;
  /** Near end along the track. For trainMoving: where its front meets the runner. */
  s: number;
  length?: number;
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  lane: Lane;
  length: number;
  /** Current near end along the track. */
  front: number;
  /**
   * An oncoming train's closing rate: metres it comes towards the runner per metre the runner runs,
   * fixed when it is placed (`TUNING.oncomingTrainSpeed` / the runner's speed then). Moving the train
   * by the runner's own distance, rather than by time, keeps the meeting point exactly where the
   * passability solver checked it, whatever the runner's speed does in between — so slowing the
   * runner (after a hoverboard burst) can never walk a train into a spot that was meant to be clear.
   * Absent on anything that does not move.
   */
  closing?: number;
}

export const lengthOf = (spec: ObstacleSpec): number => spec.length ?? OBSTACLES[spec.kind].length;

/** An oncoming train's closing rate for a runner at `runnerSpeed` (see Obstacle.closing). */
export const closingRate = (runnerSpeed: number): number => TUNING.oncomingTrainSpeed / runnerSpeed;

/** Front of an oncoming train, with the runner at runnerS, that will meet the runner at meetS. */
export function movingFrontAt(meetS: number, runnerS: number, runnerSpeed: number): number {
  return meetS + (meetS - runnerS) * closingRate(runnerSpeed);
}

/** Inverse of movingFrontAt. */
export function meetPointOf(front: number, runnerS: number, runnerSpeed: number): number {
  const k = closingRate(runnerSpeed);
  return (front + k * runnerS) / (1 + k);
}

/**
 * A train's closing rate. Every train a Track places has one, and a train added by hand gets one on
 * the Track's next update; until then `speed` (the runner's current speed) stands in, which is the
 * rate that update would give it.
 */
const closingOf = (o: Obstacle, speed?: number): number => o.closing ?? (speed ? closingRate(speed) : 0);

/**
 * Where a placed oncoming train will meet a runner now at runnerS, from the closing rate it was
 * given — not the runner's current speed, which may have changed since.
 */
export function meetOf(o: Obstacle, runnerS: number, speed?: number): number {
  const k = closingOf(o, speed);
  return (o.front + k * runnerS) / (1 + k);
}

/** How far along the track an oncoming train blocks a runner, once they meet. */
export function blockLengthOf(o: Obstacle, speed?: number): number {
  return o.length / (1 + closingOf(o, speed));
}
