import type { Lane } from '../pose/types';
import { laneX, TUNING } from './config';
import { OBSTACLES, type Obstacle } from './obstacles';

/** Half-width of every obstacle across the track. */
const OBSTACLE_HALF_WIDTH = 0.8;
/** How far above the feet a surface may be and still be stepped onto. */
const STEP_UP = 0.5;
/** Ramps reach full height this far before their end, so the runner is level when the train begins. */
const RAMP_LEVEL_EARLY = 1;

export interface RunnerBox {
  s: number;
  x: number;
  y: number;
  height: number;
}

const nearLane = (x: number, lane: Lane, halfWidth: number) => Math.abs(x - laneX(lane)) < halfWidth;

export function overlaps(r: RunnerBox, o: Obstacle): boolean {
  const info = OBSTACLES[o.kind];
  if (info.yMax <= info.yMin) return false;
  const hd = TUNING.runnerHalfDepth;
  if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) return false;
  if (!nearLane(r.x, o.lane, OBSTACLE_HALF_WIDTH + TUNING.runnerHalfWidth)) return false;
  return r.y < info.yMax && r.y + r.height > info.yMin;
}

/** Height of the highest walkable surface under the runner that it can reach. */
export function surfaceAt(r: RunnerBox, obstacles: readonly Obstacle[]): number {
  const hd = TUNING.runnerHalfDepth;
  let top = 0;
  for (const o of obstacles) {
    const info = OBSTACLES[o.kind];
    if (info.walkTop === null || !nearLane(r.x, o.lane, OBSTACLE_HALF_WIDTH)) continue;
    let h: number;
    if (o.kind === 'ramp') {
      if (r.s < o.front || r.s > o.front + o.length) continue;
      h = info.walkTop * Math.min(1, (r.s - o.front) / (o.length - RAMP_LEVEL_EARLY));
    } else {
      if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) continue;
      h = info.walkTop;
    }
    if (h <= r.y + STEP_UP && h > top) top = h;
  }
  return top;
}

export type HitKind = 'front' | 'side';

export interface Hit {
  kind: HitKind;
  obstacle: Obstacle;
}

/**
 * Only obstacles in the lane the runner is heading for count. Hitting one while
 * still sliding across is a side clip (stumble); otherwise it is head-on.
 */
export function findHit(r: RunnerBox, lane: Lane, changingLane: boolean, obstacles: readonly Obstacle[]): Hit | null {
  for (const o of obstacles) {
    if (o.lane !== lane || !overlaps(r, o)) continue;
    return { kind: changingLane ? 'side' : 'front', obstacle: o };
  }
  return null;
}
