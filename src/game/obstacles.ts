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
  cow: { length: 2.5, yMin: 0, yMax: 1.6, walkTop: null, action: 'lane', moving: false },
  ramp: { length: 8, yMin: 0, yMax: 0, walkTop: H, action: 'none', moving: false },
};

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
}

export const lengthOf = (spec: ObstacleSpec): number => spec.length ?? OBSTACLES[spec.kind].length;

/** Front of an oncoming train, with the runner at runnerS, that will meet the runner at meetS. */
export function movingFrontAt(meetS: number, runnerS: number, runnerSpeed: number): number {
  const k = TUNING.oncomingTrainSpeed / runnerSpeed;
  return meetS + (meetS - runnerS) * k;
}

/** Inverse of movingFrontAt. */
export function meetPointOf(front: number, runnerS: number, runnerSpeed: number): number {
  const k = TUNING.oncomingTrainSpeed / runnerSpeed;
  return (front + k * runnerS) / (1 + k);
}
